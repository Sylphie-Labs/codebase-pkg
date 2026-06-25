/**
 * run.mjs -- legibility probe entrypoint.
 *
 * THE ONE QUESTION: does per-category embedding distance track real code edits
 * MONOTONICALLY, or does it just jitter?
 *
 *   GREEN -> embedding-distance conformity is real and worth building.
 *   RED   -> distances jitter / don't separate edit tiers; normalization is
 *            the real first problem.
 *
 * Category: function:signature-skeleton (derived from args + returnType only).
 * We run the WHOLE pipeline in two modes -- raw vs normalized -- because "how
 * much normalization is needed" is precisely what we are measuring.
 *
 * Pipeline:
 *   1. Parse codebase-pkg's own src/ into ParsedFunctions (reuse the package's
 *      built parser at dist/sync/ast-parser.js).
 *   2. Build a signature-text pool per mode and embed it.
 *   3. For N sample functions, synthesize cosmetic / small-structural /
 *      divergent edits, embed each, and measure kNN pool distance EXCLUDING
 *      the sample's own original vector.
 *   4. Report original vs edited distance + delta per tier, per mode, plus a
 *      jitter number, then a GREEN/RED verdict.
 *
 * This file does NOT touch the sync pipeline, Neo4j, or the MCP server.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { signatureText } from './normalizer.mjs';
import { knnPoolDistance, K } from './distance.mjs';
import { embed as defaultEmbed, CHOSEN_MODEL } from './embed.mjs';
import { EDIT_TIERS } from './edit-generator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const SAMPLE_COUNT = 8; // N real functions to perturb
const MODES = ['raw', 'normalized'];

/** Recursively collect .ts files under a directory (skip .d.ts). */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Pick N evenly-spaced samples that have at least one typed argument. */
function pickSamples(functions, n) {
  const eligible = functions.filter((f) => (f.args ?? []).length >= 1);
  if (eligible.length === 0) return functions.slice(0, n);
  const step = Math.max(1, Math.floor(eligible.length / n));
  const out = [];
  for (let i = 0; i < eligible.length && out.length < n; i += step) out.push(eligible[i]);
  return out;
}

function fmt(x) {
  return x.toFixed(4);
}

async function run({ embed = defaultEmbed } = {}) {
  // --- 1. parse the package's own src/ ------------------------------------
  const { parseFiles } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'dist', 'sync', 'ast-parser.js')).href
  );
  const files = collectTsFiles(SRC_DIR);
  const parsed = parseFiles(files);
  const pool = parsed.flatMap((f) => f.functions);
  console.log(`Parsed ${files.length} src files -> ${pool.length} functions in pool.`);
  console.log(`Category: function:signature-skeleton | k=${K} | samples=${SAMPLE_COUNT}\n`);

  const samples = pickSamples(pool, SAMPLE_COUNT);

  const results = {}; // mode -> { rows, jitter, monotone, cosmeticZero }

  for (const mode of MODES) {
    // --- 2. embed the pool for this mode ----------------------------------
    const poolTexts = pool.map((fn) => signatureText(fn, mode));
    const poolVecs = await embed(poolTexts);

    // index of each function in the pool so we can exclude the original
    const indexOf = new Map(pool.map((fn, i) => [fn, i]));

    const tierDeltas = { cosmetic: [], 'small-structural': [], divergent: [] };
    const rows = [];
    // per-sample: { name, cosmetic, 'small-structural', divergent, monotone }
    const perSample = [];

    for (const sample of samples) {
      const ownIdx = indexOf.get(sample);
      // pool excluding this sample's own original vector
      const reducedPool = poolVecs.filter((_, i) => i !== ownIdx);

      // distance of the ORIGINAL signature to the reduced pool
      const [origVec] = await embed([signatureText(sample, mode)]);
      const origDist = knnPoolDistance(origVec, reducedPool);

      const sampleDeltas = {};
      for (const { tier, apply } of EDIT_TIERS) {
        const edited = apply(sample);
        const [editVec] = await embed([signatureText(edited, mode)]);
        const editDist = knnPoolDistance(editVec, reducedPool);
        const delta = editDist - origDist;
        tierDeltas[tier].push(delta);
        sampleDeltas[tier] = delta;
        rows.push({ name: sample.name, tier, origDist, editDist, delta });
      }
      const sMonotone =
        sampleDeltas.cosmetic < sampleDeltas['small-structural'] &&
        sampleDeltas['small-structural'] < sampleDeltas.divergent;
      perSample.push({ name: sample.name, ...sampleDeltas, monotone: sMonotone });
    }

    const meanDelta = (tier) =>
      tierDeltas[tier].reduce((a, b) => a + b, 0) / tierDeltas[tier].length;
    const stats = (tier) => {
      const xs = tierDeltas[tier];
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const min = Math.min(...xs);
      const max = Math.max(...xs);
      const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
      const stdev = Math.sqrt(variance);
      return { mean, min, max, stdev };
    };

    const cosmetic = meanDelta('cosmetic');
    const small = meanDelta('small-structural');
    const divergent = meanDelta('divergent');
    const tierStats = {
      cosmetic: stats('cosmetic'),
      'small-structural': stats('small-structural'),
      divergent: stats('divergent'),
    };
    // jitter = how far cosmetic-edit delta sits from the ideal zero
    const jitter = Math.abs(cosmetic);
    const monotone = cosmetic < small && small < divergent;
    const monotoneHits = perSample.filter((s) => s.monotone).length;

    results[mode] = {
      rows,
      perSample,
      tierStats,
      cosmetic,
      small,
      divergent,
      jitter,
      monotone,
      monotoneHits,
      sampleCount: perSample.length,
    };
  }

  // --- 4. report ----------------------------------------------------------
  for (const mode of MODES) {
    const r = results[mode];
    console.log(`================ MODE: ${mode.toUpperCase()} ================`);
    console.log(
      `${'function'.padEnd(34)} ${'tier'.padEnd(17)} ${'orig'.padStart(8)} ${'edited'.padStart(8)} ${'delta'.padStart(9)}`
    );
    for (const row of r.rows) {
      const name = row.name.length > 33 ? row.name.slice(0, 30) + '...' : row.name;
      console.log(
        `${name.padEnd(34)} ${row.tier.padEnd(17)} ${fmt(row.origDist).padStart(8)} ${fmt(row.editDist).padStart(8)} ${(row.delta >= 0 ? '+' : '') + fmt(row.delta)}`.padEnd(0)
      );
    }
    // --- per-sample separation: one row per sample, deltas across tiers -----
    console.log('  ------------- per-sample deltas (cosmetic / small / divergent) -------------');
    const sgn = (x) => (x >= 0 ? '+' : '') + fmt(x);
    console.log(
      `  ${'function'.padEnd(34)} ${'cosmetic'.padStart(9)} ${'small'.padStart(9)} ${'divergent'.padStart(9)}  mono?`
    );
    for (const s of r.perSample) {
      const name = s.name.length > 33 ? s.name.slice(0, 30) + '...' : s.name;
      console.log(
        `  ${name.padEnd(34)} ${sgn(s.cosmetic).padStart(9)} ${sgn(s['small-structural']).padStart(9)} ${sgn(s.divergent).padStart(9)}  ${s.monotone ? 'YES' : 'no'}`
      );
    }
    console.log(
      `  per-sample monotonicity (cosmetic<small<divergent): ${r.monotoneHits}/${r.sampleCount} samples`
    );

    console.log('  ---------------- delta stats by tier (mean | min..max | stdev) ----------------');
    for (const tier of ['cosmetic', 'small-structural', 'divergent']) {
      const st = r.tierStats[tier];
      console.log(
        `  ${tier.padEnd(17)}: mean ${sgn(st.mean)}  |  min ${sgn(st.min)}  max ${sgn(st.max)}  |  stdev ${fmt(st.stdev)}`
      );
    }
    console.log(`  jitter (|cosmetic mean delta|)       : ${fmt(r.jitter)}`);
    console.log(`  monotone on MEANS (cosmetic<small<divergent) : ${r.monotone}`);
    // flag mean/per-sample disagreement plainly
    if (r.monotone && r.monotoneHits < r.sampleCount) {
      console.log(
        `  NOTE: means are monotonic but only ${r.monotoneHits}/${r.sampleCount} individual samples are -- ` +
          `${r.sampleCount - r.monotoneHits} sample(s) disagree with the average.`
      );
    } else if (!r.monotone && r.monotoneHits > 0) {
      console.log(
        `  NOTE: means are NOT monotonic, yet ${r.monotoneHits}/${r.sampleCount} individual samples are -- ` +
          `the average is dragged by outliers.`
      );
    }
    console.log('');
  }

  // --- VERDICT ------------------------------------------------------------
  // GREEN requires: distance monotone across tiers in normalized mode AND
  // cosmetic-edit delta ~= 0 (jitter below threshold) in normalized mode.
  const JITTER_THRESHOLD = 0.01;
  const norm = results['normalized'];
  const green = norm.monotone && norm.jitter < JITTER_THRESHOLD;

  console.log('==================================================');
  console.log(`EMBEDDING MODEL LOADED: ${CHOSEN_MODEL ?? '(unknown)'}`);
  console.log(`VERDICT: ${green ? 'GREEN' : 'RED'}`);
  if (green) {
    console.log(
      'Embedding distance is monotonic across edit tiers and cosmetic edits ' +
        'are ~zero after normalization. The conformity mechanism is real.'
    );
  } else {
    const why = [];
    if (!norm.monotone) why.push('distances do NOT separate edit tiers monotonically');
    if (norm.jitter >= JITTER_THRESHOLD)
      why.push(`cosmetic-edit jitter ${fmt(norm.jitter)} >= ${JITTER_THRESHOLD} after normalization`);
    console.log(`Reason: ${why.join('; ')}.`);
    console.log('Normalization is the real first problem before distance is trustworthy.');
  }
  console.log('==================================================');

  return { results, green };
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
