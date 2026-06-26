/**
 * corpus.mjs -- Docker-free corpus evaluation harness for the Conformity Judge.
 *
 * Validates the real conforms/outlier signal at corpus scale using the REAL
 * local embedding model (jina-embeddings-v2-small-en), an in-memory vector
 * store, and the shipped engine modules from dist/. No Neo4j, no Postgres, no
 * Docker.
 *
 * Five stages (see the package CLAUDE / task brief):
 *   1. Build pool        -- parse codebase-pkg's own src/, derive category +
 *                           normalized skeleton, embed ALL skeletons once.
 *   2. Leave-one-out     -- per pool entry, knnPoolDistance vs same-category
 *                           peers EXCLUDING self. "How far does code that
 *                           genuinely belongs sit?"
 *   3. Edit ladder       -- sample up to 40 pool fns, generate cosmetic /
 *                           small-structural / divergent variants, embed each,
 *                           measure delta vs the fn's own LOO distance.
 *   4. Cross-codebase    -- foreign repos (memory-pkg, drift-detector): embed
 *                           each foreign fn, measure distance to the codebase-pkg
 *                           pool, report outlier rate vs self-LOO p95.
 *   5. Threshold reco    -- propose DRAFT_OUTLIER_THRESHOLD from the data and
 *                           show the self-vs-foreign flag trade-off.
 *
 * Output: a readable report to stdout AND report.json with the raw numbers.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { walk } from './walk.mjs';
import { EDIT_TIERS } from '../conformity-probe/edit-generator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = (rel) => pathToFileURL(path.join(REPO_ROOT, 'dist', rel)).href;

// --- shipped engine modules (compiled) -------------------------------------
const { parseFiles } = await import(DIST('sync/parser.js'));
const { categoryOf, signatureSkeleton } = await import(DIST('conformity/category.js'));
const { knnPoolDistance, DEFAULT_K } = await import(DIST('conformity/distance.js'));
// `embed.js` is imported as a namespace so CHOSEN_MODEL is read LIVE after the
// first embed call sets it (it is null at import time -- a plain destructure
// would capture that null forever).
const embedMod = await import(DIST('conformity/embed.js'));
const { embed } = embedMod;
const chosenModel = () => embedMod.CHOSEN_MODEL;
const { nodeIdOf } = await import(DIST('conformity/store.js'));
const { DRAFT_OUTLIER_THRESHOLD } = await import(DIST('conformity/judge.js'));

const K = DEFAULT_K;
const SAMPLE_CAP = 40; // edit-ladder samples
const FOREIGN_ROOTS = ['../memory-pkg', '../drift-detector'];

// ---------------------------------------------------------------------------
// small numeric helpers (guard against empty input throughout)
// ---------------------------------------------------------------------------

/** Sorted-copy percentile (p in [0,1]) via nearest-rank; null if empty. */
function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}
const median = (xs) => percentile(xs, 0.5);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const min = (xs) => (xs.length ? Math.min(...xs) : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);

/** Distribution summary used in several reports. */
function distSummary(xs) {
  return {
    count: xs.length,
    min: min(xs),
    median: median(xs),
    p90: percentile(xs, 0.9),
    p95: percentile(xs, 0.95),
    max: max(xs),
    mean: mean(xs),
  };
}

function fmt(x) {
  return x === null || x === undefined ? '  n/a ' : x.toFixed(4);
}
function pct(x) {
  return x === null || x === undefined ? ' n/a ' : (x * 100).toFixed(1) + '%';
}

// ---------------------------------------------------------------------------
// pool building -- shared by self + foreign corpora
// ---------------------------------------------------------------------------

/**
 * Parse a list of .ts files and return a flat list of
 * { fn, nodeId, category, skeleton } records, skipping any function whose
 * skeleton is empty. parseFiles returns ParsedFile[] each with .functions.
 */
function recordsFromFiles(files) {
  const parsed = parseFiles(files);
  const records = [];
  for (const file of parsed) {
    for (const fn of file.functions ?? []) {
      const category = categoryOf(fn);
      const skeleton = signatureSkeleton(fn, { normalized: true });
      if (!skeleton) continue;
      records.push({ fn, nodeId: nodeIdOf(fn), category, skeleton });
    }
  }
  return records;
}

/** Embed every record's skeleton once (batch) and attach a `vector`. */
async function embedRecords(records) {
  if (!records.length) return records;
  const vectors = await embed(records.map((r) => r.skeleton));
  records.forEach((r, i) => {
    r.vector = vectors[i];
  });
  return records;
}

/** Group vectors by category: category -> [{ nodeId, vector }]. */
function poolByCategory(records) {
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.category)) map.set(r.category, []);
    map.get(r.category).push({ nodeId: r.nodeId, vector: r.vector });
  }
  return map;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const report = { meta: {}, pool: {}, selfLoo: {}, editLadder: {}, foreign: {}, threshold: {} };

  // =========================================================================
  // 1. BUILD POOL
  // =========================================================================
  const srcDir = path.join(REPO_ROOT, 'src');
  const srcFiles = walk(srcDir);
  console.log(`\n=== STAGE 1: BUILD POOL ===`);
  console.log(`Walked ${srcFiles.length} source .ts files under ${srcDir}`);

  const poolRecords = await embedRecords(recordsFromFiles(srcFiles));
  const pool = poolByCategory(poolRecords);

  const categoryBreakdown = {};
  for (const [cat, entries] of pool) categoryBreakdown[cat] = entries.length;

  console.log(`Embedding model: ${chosenModel() ?? '(unknown)'}`);
  console.log(`Pool size: ${poolRecords.length} functions`);
  console.log(`Category breakdown:`);
  for (const [cat, n] of Object.entries(categoryBreakdown)) {
    console.log(`  ${cat}: ${n}`);
  }

  report.meta = { model: chosenModel(), k: K, draftThreshold: DRAFT_OUTLIER_THRESHOLD, sampleCap: SAMPLE_CAP };
  report.pool = { size: poolRecords.length, categories: categoryBreakdown };

  if (poolRecords.length === 0) {
    console.error('Empty pool -- nothing to evaluate. Aborting.');
    fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 2));
    return;
  }

  // =========================================================================
  // 2. LEAVE-ONE-OUT (no re-embed)
  // =========================================================================
  console.log(`\n=== STAGE 2: LEAVE-ONE-OUT (self) ===`);
  const looDistances = [];
  // nodeId -> LOO distance, used by the edit ladder for the per-sample baseline
  const looByNodeId = new Map();

  for (const r of poolRecords) {
    const peers = pool.get(r.category).filter((e) => e.nodeId !== r.nodeId);
    if (peers.length === 0) continue; // singleton category -> nothing to conform to
    const d = knnPoolDistance(r.vector, peers.map((e) => e.vector), K);
    looDistances.push(d);
    looByNodeId.set(r.nodeId, d);
  }

  const looSummary = distSummary(looDistances);
  const selfOutlierAtDraft = looDistances.length
    ? looDistances.filter((d) => d > DRAFT_OUTLIER_THRESHOLD).length / looDistances.length
    : null;

  console.log(`Judged ${looDistances.length} functions (singleton categories skipped).`);
  console.log(`  min=${fmt(looSummary.min)}  median=${fmt(looSummary.median)}  p90=${fmt(looSummary.p90)}  p95=${fmt(looSummary.p95)}  max=${fmt(looSummary.max)}  mean=${fmt(looSummary.mean)}`);
  console.log(`  verdict split @ DRAFT_OUTLIER_THRESHOLD=${DRAFT_OUTLIER_THRESHOLD}:`);
  console.log(`    conforms: ${pct(1 - selfOutlierAtDraft)}   outlier: ${pct(selfOutlierAtDraft)}`);

  report.selfLoo = { ...looSummary, outlierRateAtDraftThreshold: selfOutlierAtDraft };
  const selfP95 = looSummary.p95;
  const selfP90 = looSummary.p90;

  // =========================================================================
  // 3. EDIT LADDER AT SCALE
  // =========================================================================
  console.log(`\n=== STAGE 3: EDIT LADDER (up to ${SAMPLE_CAP} samples) ===`);

  // sample evenly-spaced pool fns that have >=1 arg (so edits are meaningful)
  // and a known LOO baseline.
  const eligible = poolRecords.filter(
    (r) => (r.fn.args?.length ?? 0) >= 1 && looByNodeId.has(r.nodeId),
  );
  const step = Math.max(1, Math.floor(eligible.length / SAMPLE_CAP));
  const samples = [];
  for (let i = 0; i < eligible.length && samples.length < SAMPLE_CAP; i += step) {
    samples.push(eligible[i]);
  }

  const tierDeltas = { cosmetic: [], 'small-structural': [], divergent: [] };
  const perSampleMonotone = [];
  const ladderRows = [];

  for (const sample of samples) {
    const reducedPool = pool
      .get(sample.category)
      .filter((e) => e.nodeId !== sample.nodeId)
      .map((e) => e.vector);
    if (reducedPool.length === 0) continue;
    const baseDist = looByNodeId.get(sample.nodeId);

    const sampleDeltas = {};
    for (const { tier, apply } of EDIT_TIERS) {
      const edited = apply(sample.fn);
      const skeleton = signatureSkeleton(edited, { normalized: true });
      const [editVec] = await embed([skeleton]);
      const editDist = knnPoolDistance(editVec, reducedPool, K);
      const delta = editDist - baseDist;
      tierDeltas[tier].push(delta);
      sampleDeltas[tier] = delta;
    }
    const mono =
      sampleDeltas.cosmetic < sampleDeltas['small-structural'] &&
      sampleDeltas['small-structural'] < sampleDeltas.divergent;
    perSampleMonotone.push(mono);
    ladderRows.push({ nodeId: sample.nodeId, baseDist, ...sampleDeltas, monotone: mono });
  }

  const tierMedianDelta = {
    cosmetic: median(tierDeltas.cosmetic),
    'small-structural': median(tierDeltas['small-structural']),
    divergent: median(tierDeltas.divergent),
  };
  const monoHits = perSampleMonotone.filter(Boolean).length;
  const monoRate = perSampleMonotone.length ? monoHits / perSampleMonotone.length : null;

  console.log(`Samples evaluated: ${perSampleMonotone.length}`);
  console.log(`  per-tier MEDIAN delta vs own LOO distance:`);
  console.log(`    cosmetic        : ${fmt(tierMedianDelta.cosmetic)}`);
  console.log(`    small-structural: ${fmt(tierMedianDelta['small-structural'])}`);
  console.log(`    divergent       : ${fmt(tierMedianDelta.divergent)}`);
  console.log(`  per-sample monotonic hit rate (cosmetic<small<divergent): ${monoHits}/${perSampleMonotone.length} = ${pct(monoRate)}`);

  report.editLadder = {
    samples: perSampleMonotone.length,
    tierMedianDelta,
    tierDeltaSummary: {
      cosmetic: distSummary(tierDeltas.cosmetic),
      'small-structural': distSummary(tierDeltas['small-structural']),
      divergent: distSummary(tierDeltas.divergent),
    },
    monotoneHits: monoHits,
    monotoneRate: monoRate,
    rows: ladderRows,
  };

  // =========================================================================
  // 4. CROSS-CODEBASE (FOREIGN)
  // =========================================================================
  console.log(`\n=== STAGE 4: CROSS-CODEBASE (FOREIGN) ===`);
  report.foreign = {};

  for (const rel of FOREIGN_ROOTS) {
    const absRoot = path.resolve(REPO_ROOT, rel);
    const name = path.basename(absRoot);
    if (!fs.existsSync(absRoot)) {
      console.log(`  [${name}] MISSING at ${absRoot} -- skipped.`);
      report.foreign[name] = { skipped: true, reason: 'path missing' };
      continue;
    }
    const files = walk(absRoot);
    const records = await embedRecords(recordsFromFiles(files));
    const distances = [];
    for (const r of records) {
      const peers = pool.get(r.category);
      if (!peers || peers.length === 0) continue; // no same-category pool to judge against
      // exclude any nodeId collision defensively (different repo -> shouldn't collide)
      const peerVecs = peers.filter((e) => e.nodeId !== r.nodeId).map((e) => e.vector);
      if (peerVecs.length === 0) continue;
      distances.push(knnPoolDistance(r.vector, peerVecs, K));
    }

    const summary = distSummary(distances);
    // outlier rate = fraction whose distance exceeds self-LOO p95
    const outlierRateVsSelfP95 =
      selfP95 != null && distances.length
        ? distances.filter((d) => d > selfP95).length / distances.length
        : null;

    console.log(`  [${name}] files=${files.length}  functions judged=${distances.length}`);
    console.log(`    median=${fmt(summary.median)}  p90=${fmt(summary.p90)}  mean=${fmt(summary.mean)}  max=${fmt(summary.max)}`);
    console.log(`    outlier rate (dist > self-LOO p95=${fmt(selfP95)}): ${pct(outlierRateVsSelfP95)}`);

    report.foreign[name] = {
      skipped: false,
      files: files.length,
      functionsJudged: distances.length,
      ...summary,
      outlierRateVsSelfP95,
      // keep raw distances out of report.json bulk; store summary only
    };
    // stash distances for the threshold trade-off below
    report.foreign[name]._distances = distances;
  }

  // =========================================================================
  // 5. THRESHOLD RECOMMENDATION
  // =========================================================================
  console.log(`\n=== STAGE 5: THRESHOLD RECOMMENDATION ===`);

  // Candidate thresholds grounded in the self-LOO distribution. We prefer p95
  // (keeps self-flag ~<=5% by construction) but also report p90 for contrast.
  const candidates = [];
  if (selfP90 != null) candidates.push({ label: 'self-LOO p90', value: selfP90 });
  if (selfP95 != null) candidates.push({ label: 'self-LOO p95', value: selfP95 });

  /** % of a distance list strictly above `t`. */
  const flagRate = (xs, t) => (xs.length ? xs.filter((d) => d > t).length / xs.length : null);

  const tradeoffs = [];
  for (const c of candidates) {
    const row = { label: c.label, threshold: c.value, selfFlag: flagRate(looDistances, c.value), foreign: {} };
    for (const [name, f] of Object.entries(report.foreign)) {
      if (f.skipped) continue;
      row.foreign[name] = flagRate(f._distances, c.value);
    }
    tradeoffs.push(row);
  }

  // Recommendation: self-LOO p95. Rationale: by construction it flags ~5% of
  // genuinely-belonging code (acceptable false-positive budget) while pushing
  // the cut well above the self median, so foreign / divergent code -- which
  // sits further out -- is flagged at a higher rate. p90 is the more aggressive
  // alternative (more foreign caught, more self flagged).
  const recommended = candidates.find((c) => c.label === 'self-LOO p95') ?? candidates[candidates.length - 1] ?? null;

  console.log(`Current provisional DRAFT_OUTLIER_THRESHOLD = ${DRAFT_OUTLIER_THRESHOLD}`);
  console.log(`\nTrade-off table (% flagged as outlier at each candidate threshold):`);
  const foreignNames = Object.entries(report.foreign).filter(([, f]) => !f.skipped).map(([n]) => n);
  console.log(`  ${'threshold'.padEnd(22)} ${'value'.padStart(8)} ${'self'.padStart(8)} ${foreignNames.map((n) => n.padStart(16)).join(' ')}`);
  for (const row of tradeoffs) {
    const fcols = foreignNames.map((n) => pct(row.foreign[n]).padStart(16)).join(' ');
    console.log(`  ${row.label.padEnd(22)} ${fmt(row.threshold).padStart(8)} ${pct(row.selfFlag).padStart(8)} ${fcols}`);
  }

  if (recommended) {
    console.log(`\nRECOMMENDED DRAFT_OUTLIER_THRESHOLD = ${fmt(recommended.value)} (${recommended.label})`);
    const recRow = tradeoffs.find((r) => r.label === recommended.label);
    console.log(`  self flagged: ${pct(recRow.selfFlag)}`);
    for (const n of foreignNames) console.log(`  ${n} flagged: ${pct(recRow.foreign[n])}`);
  } else {
    console.log(`\nNo recommendation possible (insufficient self distribution).`);
  }

  report.threshold = {
    currentDraft: DRAFT_OUTLIER_THRESHOLD,
    candidates,
    recommended: recommended ? { ...recommended } : null,
    tradeoffs,
  };

  // strip internal _distances before writing
  for (const f of Object.values(report.foreign)) delete f._distances;

  const outPath = path.join(__dirname, 'report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote raw numbers to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
