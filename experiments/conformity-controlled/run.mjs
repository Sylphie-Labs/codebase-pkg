/**
 * run.mjs -- CONTROLLED ground-truth test of the conformity similarity function.
 *
 * THE ONE QUESTION: given a tiny corpus with KNOWN similarity structure (a
 * 5-file "same approach" cluster computing the arithmetic mean, plus 5 mutually
 * dissimilar random functions), does the embedding + cosine-distance primitive
 * recover that structure?
 *
 * We test TWO representations of each function, both fed to the SAME shipped
 * code model (jinaai/jina-embeddings-v2-base-code) and the SAME shipped cosine
 * distance:
 *
 *   Rep 1 (UNDER TEST): whole function body, lightly normalized -- comments
 *     stripped, whitespace collapsed, identifiers + literals KEPT.
 *   Rep 2 (CONTRAST):   the old signature skeleton (normalizedSignature), the
 *     args+returnType-only structural representation.
 *
 * Ground truth we know in advance:
 *   - c5_exact is a byte-for-byte copy of c1_mean  -> distance must be ~0.
 *   - c1..c5 are all the same approach              -> each NN is a cluster file.
 *   - r1..r5 are mutually distinct and unlike mean  -> separated from cluster.
 *
 * Reuses the SHIPPED engine from dist/ (parser parseFiles; conformity
 * normalize/category signatureSkeleton; conformity distance cosineDistance).
 * Does NOT modify src/. Local model only -- no Docker, no API.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIX_DIR = path.join(__dirname, 'fixtures');

// The CODE model the task pins for this experiment (whole-body category).
const MODEL_ID = 'jinaai/jina-embeddings-v2-base-code';

// Fixture order is also ground-truth order: c1..c5 cluster, r1..r5 random.
const FIXTURES = [
  'c1_mean.ts',
  'c2_mean.ts',
  'c3_mean.ts',
  'c4_mean.ts',
  'c5_exact.ts',
  'r1_debounce.ts',
  'r2_treewalk.ts',
  'r3_retry.ts',
  'r4_tokenize.ts',
  'r5_quicksort.ts',
];

const isCluster = (name) => name.startsWith('c');

// ---------------------------------------------------------------------------
// Local embedder pinned to the CODE model (mirrors src/conformity/embed.ts).
// We pin the single model id directly rather than walking the default
// candidate chain, because this experiment is specifically about the code
// model on whole-body text.
// ---------------------------------------------------------------------------
let _pipe = null;
let CHOSEN_MODEL = null;
async function getPipeline() {
  if (!_pipe) {
    _pipe = (async () => {
      // Clear stale HF auth exactly like src/conformity/embed.ts does -- a stale
      // HF_TOKEN sent as a bearer credential causes spurious 401s on the public
      // Apache-2.0 jina repo. Unauthenticated requests succeed for public repos.
      delete process.env.HF_TOKEN;
      delete process.env.HUGGING_FACE_HUB_TOKEN;
      delete process.env.HF_ACCESS_TOKEN;
      delete process.env.HUGGINGFACE_HUB_TOKEN;

      const { pipeline } = await import('@xenova/transformers');
      const extractor = await pipeline('feature-extraction', MODEL_ID);
      CHOSEN_MODEL = MODEL_ID;
      console.error(`[embed] using model: ${MODEL_ID}`);
      return extractor;
    })();
  }
  return _pipe;
}
async function embed(texts) {
  const extractor = await getPipeline();
  const out = [];
  for (const text of texts) {
    const tensor = await extractor(text, { pooling: 'mean', normalize: true });
    out.push(Array.from(tensor.data));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rep 1 normalization: strip comments, collapse whitespace, keep identifiers
// and literals. Light touch -- the body's actual code is what gets embedded.
// ---------------------------------------------------------------------------
function lightlyNormalizeBody(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\/\/[^\n]*/g, ' ') // line comments
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}

function fmt(x) {
  return x.toFixed(4);
}

async function run() {
  // --- import the shipped engine from dist/ -------------------------------
  const { parseFiles } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'dist', 'sync', 'ast-parser.js')).href
  );
  const { signatureSkeleton } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'dist', 'conformity', 'category.js')).href
  );
  const { cosineDistance } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'dist', 'conformity', 'distance.js')).href
  );

  // --- parse all 10 fixtures -> one ParsedFunction each -------------------
  const items = []; // { file, fn }
  for (const file of FIXTURES) {
    const full = path.join(FIX_DIR, file);
    const parsed = parseFiles([full]);
    const fns = parsed.flatMap((p) => p.functions);
    if (fns.length !== 1) {
      throw new Error(`${file}: expected exactly 1 function, got ${fns.length}`);
    }
    items.push({ file, fn: fns[0] });
  }
  const labels = items.map((it) => it.file.replace(/\.ts$/, ''));
  const n = items.length;

  // --- build the two representations --------------------------------------
  const bodyTexts = items.map((it) => lightlyNormalizeBody(it.fn.bodyText));
  const sigTexts = items.map((it) => signatureSkeleton(it.fn));

  console.log(`Corpus: ${n} fixtures (5 cluster c1..c5, 5 random r1..r5)`);
  console.log(`Model:  ${MODEL_ID}\n`);

  // --- embed both reps with the SAME model --------------------------------
  const bodyVecs = await embed(bodyTexts);
  const sigVecs = await embed(sigTexts);

  // --- per representation: 10x10 distance matrix + k=1 NN -----------------
  function analyze(vecs) {
    const matrix = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < n; j++) row.push(cosineDistance(vecs[i], vecs[j]));
      matrix.push(row);
    }
    // k=1 nearest neighbor for each file (exclude self)
    const nn = [];
    for (let i = 0; i < n; i++) {
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (matrix[i][j] < bestDist) {
          bestDist = matrix[i][j];
          best = j;
        }
      }
      nn.push({ from: labels[i], to: labels[best], distance: bestDist, fromIdx: i, toIdx: best });
    }
    return { matrix, nn };
  }

  const reps = {
    body: { title: 'REP 1 -- WHOLE BODY (under test)', ...analyze(bodyVecs), texts: bodyTexts },
    signature: { title: 'REP 2 -- SIGNATURE SKELETON (contrast)', ...analyze(sigVecs), texts: sigTexts },
  };

  // --- ground-truth checks per representation -----------------------------
  function checks(rep) {
    const { matrix, nn } = rep;
    const idx = (name) => labels.indexOf(name);

    // (a) c5_exact <-> c1_mean distance ~= 0
    const exactDist = matrix[idx('c5_exact')][idx('c1_mean')];
    const aPass = exactDist < 1e-3;

    // (b) every cluster file's NN is ANOTHER cluster file
    const bDetails = nn
      .filter((r) => isCluster(r.from))
      .map((r) => ({ from: r.from, to: r.to, ok: isCluster(r.to) }));
    const bPass = bDetails.every((d) => d.ok);

    // (c) min(random NN dist) > max(cluster NN dist); margin = difference
    const clusterNN = nn.filter((r) => isCluster(r.from)).map((r) => r.distance);
    const randomNN = nn.filter((r) => !isCluster(r.from)).map((r) => r.distance);
    const maxCluster = Math.max(...clusterNN);
    const minRandom = Math.min(...randomNN);
    const margin = minRandom - maxCluster;
    const cPass = margin > 0;

    // (d) rank all 10 by NN distance; do the 5 cluster files occupy 5 smallest?
    const ranked = [...nn].sort((a, b) => a.distance - b.distance);
    const bottom5 = ranked.slice(0, 5).map((r) => r.from);
    const dPass = bottom5.every((name) => isCluster(name));

    return {
      a: { pass: aPass, exactDist },
      b: { pass: bPass, details: bDetails },
      c: { pass: cPass, maxCluster, minRandom, margin },
      d: { pass: dPass, rankedNames: ranked.map((r) => r.from), bottom5 },
    };
  }

  reps.body.checks = checks(reps.body);
  reps.signature.checks = checks(reps.signature);

  // --- print ---------------------------------------------------------------
  function printRep(rep) {
    console.log(`================ ${rep.title} ================`);
    console.log('  nearest-neighbor table (k=1):');
    console.log(`  ${'file'.padEnd(14)} -> ${'nearest'.padEnd(14)} ${'distance'.padStart(10)}`);
    for (const r of rep.nn) {
      console.log(`  ${r.from.padEnd(14)} -> ${r.to.padEnd(14)} ${fmt(r.distance).padStart(10)}`);
    }
    const c = rep.checks;
    console.log('  ground-truth checks:');
    console.log(
      `    (a) c5_exact == c1_mean (~0): ${c.a.pass ? 'PASS' : 'FAIL'}  (dist ${fmt(c.a.exactDist)})`
    );
    console.log(`    (b) every cluster NN is another cluster file: ${c.b.pass ? 'PASS' : 'FAIL'}`);
    for (const d of c.b.details) {
      console.log(`          ${d.from} -> ${d.to}  ${d.ok ? 'ok' : 'NOT CLUSTER'}`);
    }
    console.log(
      `    (c) random NN all farther than cluster NN: ${c.c.pass ? 'PASS' : 'FAIL'}  ` +
        `(maxCluster ${fmt(c.c.maxCluster)}, minRandom ${fmt(c.c.minRandom)}, margin ${fmt(c.c.margin)})`
    );
    console.log(
      `    (d) 5 cluster files occupy 5 smallest NN dists: ${c.d.pass ? 'PASS' : 'FAIL'}`
    );
    console.log(`          rank (closest NN first): ${c.d.rankedNames.join(', ')}`);
    console.log('');
  }

  printRep(reps.body);
  printRep(reps.signature);

  // --- comparison summary --------------------------------------------------
  const allPass = (c) => c.a.pass && c.b.pass && c.c.pass && c.d.pass;
  const bodyAll = allPass(reps.body.checks);
  const sigAll = allPass(reps.signature.checks);

  console.log('================ SUMMARY: body vs signature ================');
  console.log(
    `  body      checks a/b/c/d: ${[reps.body.checks.a, reps.body.checks.b, reps.body.checks.c, reps.body.checks.d].map((x) => (x.pass ? 'P' : 'F')).join(' ')}   margin ${fmt(reps.body.checks.c.margin)}`
  );
  console.log(
    `  signature checks a/b/c/d: ${[reps.signature.checks.a, reps.signature.checks.b, reps.signature.checks.c, reps.signature.checks.d].map((x) => (x.pass ? 'P' : 'F')).join(' ')}   margin ${fmt(reps.signature.checks.c.margin)}`
  );
  console.log(
    `  whole-body recovers ground truth: ${bodyAll}; signature recovers ground truth: ${sigAll}`
  );
  console.log('');

  // --- write report.json ---------------------------------------------------
  const report = {
    model: MODEL_ID,
    chosenModel: CHOSEN_MODEL,
    fixtures: FIXTURES,
    labels,
    representations: {
      body: {
        texts: reps.body.texts,
        matrix: reps.body.matrix,
        nearestNeighbors: reps.body.nn,
        checks: reps.body.checks,
        allPass: bodyAll,
      },
      signature: {
        texts: reps.signature.texts,
        matrix: reps.signature.matrix,
        nearestNeighbors: reps.signature.nn,
        checks: reps.signature.checks,
        allPass: sigAll,
      },
    },
  };
  const reportPath = path.join(__dirname, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Wrote ${reportPath}`);

  // --- VERDICT -------------------------------------------------------------
  console.log('==================================================');
  console.log(`EMBEDDING MODEL LOADED: ${CHOSEN_MODEL ?? '(unknown)'}`);
  console.log(
    `VERDICT: whole-body embedding ${bodyAll ? 'CORRECTLY RECOVERS' : 'FAILS TO RECOVER'} the known ` +
      `similarity structure (exact-dup~0, cluster grouped, random separated); ` +
      `signature skeleton ${sigAll ? 'ALSO recovers it' : 'FAILS to recover it'} on the same controlled data.`
  );
  console.log('==================================================');

  return { bodyAll, sigAll };
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
