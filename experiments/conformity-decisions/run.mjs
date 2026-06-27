/**
 * run.mjs -- prints the per-decision conformity report (Half A) and the
 * embedded-slice spread sanity check (Half B).
 *
 * Half A: deterministic categorical decision extraction.
 *   - per-file facts table
 *   - per-dimension distribution
 *   - flagged per-decision outliers (explainable, one decision at a time)
 *
 * Half B: embed JUST the parameter-list slice of each function with the
 *   existing dist/conformity/embed (jina code model) and measure whether the
 *   slice-level cosine separates or collapses -- the test of whether
 *   embedding-per-slice is viable for fuzzy axes, vs. deterministic extraction.
 *
 * Run: node experiments/conformity-decisions/run.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { Project, Node } from 'ts-morph';
import { extractFile, distributions, flagOutliers, DIMENSIONS } from './extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '..', 'conformity-controlled', 'fixtures');
const FILES = [
  'c1_mean', 'c2_mean', 'c3_mean', 'c4_mean', 'c5_exact',
  'r1_debounce', 'r2_treewalk', 'r3_retry', 'r4_tokenize', 'r5_quicksort',
];

function hr(c = '-') { return c.repeat(78); }

// ===========================================================================
// HALF A
// ===========================================================================
const records = FILES.map((f) => ({ file: f, facts: extractFile(path.join(FIX, `${f}.ts`))[0] }));

console.log(hr('='));
console.log('HALF A -- per-decision style conformity (deterministic, ts-morph)');
console.log(hr('='));

// --- facts table ---
const cols = ['array_syntax', 'fn_style', 'return_type', 'loop_style', 'param_count', 'var_decl'];
const w = { file: 13, fn: 16 };
const header = 'file'.padEnd(w.file) + 'fn'.padEnd(w.fn) +
  cols.map((c) => c.padEnd(13)).join('');
console.log('\n[facts table]');
console.log(header);
console.log(hr());
for (const r of records) {
  const row = r.file.padEnd(w.file) + String(r.facts.name).padEnd(w.fn) +
    cols.map((c) => String(r.facts[c]).padEnd(13)).join('');
  console.log(row);
}

// --- distributions ---
const dist = distributions(records);
console.log('\n[per-dimension distribution across 10 files]');
for (const dim of DIMENSIONS) {
  const entries = Object.entries(dist[dim]).sort((a, b) => b[1] - a[1]);
  const parts = entries.map(([v, c]) => `${v}=${c}`).join(', ');
  console.log(`  ${dim.padEnd(13)} ${parts}`);
}

// --- outliers ---
const flags = flagOutliers(records, dist);
console.log('\n[flagged per-decision outliers]  (minority choice, share <= 0.30, not the mode)');
const byFile = new Map();
for (const fl of flags) {
  if (!byFile.has(fl.file)) byFile.set(fl.file, []);
  byFile.get(fl.file).push(fl);
}
for (const f of FILES) {
  const fls = byFile.get(f) ?? [];
  if (fls.length === 0) {
    console.log(`  ${f.padEnd(13)} conforms on all dimensions`);
  } else {
    for (const fl of fls) {
      const mode = Object.entries(dist[fl.dim]).sort((a, b) => b[1] - a[1])[0];
      console.log(`  ${f.padEnd(13)} OUTLIER on ${fl.dim}: uses '${fl.value}' (${fl.count}/${fl.total}); norm is '${mode[0]}' (${mode[1]}/${fl.total})`);
    }
  }
}

// ===========================================================================
// HALF B -- embedded parameter-list slice
// ===========================================================================
console.log('\n' + hr('='));
console.log('HALF B -- embedded SLICE (parameter-list text) cosine spread');
console.log(hr('='));

// Pull the raw parameter-list text (the source between the parens) per function.
function paramSlice(filePath) {
  const project = new Project({
    compilerOptions: { target: 99, module: 99, strict: true },
    skipFileDependencyResolution: true,
  });
  const sf = project.addSourceFileAtPath(filePath);
  for (const fn of sf.getFunctions()) {
    if (fn.getName() && fn.isExported()) {
      const ps = fn.getParameters().map((p) => p.getText());
      return '(' + ps.join(', ') + ')';
    }
  }
  return '()';
}

function cosine(a, b) {
  // embed() returns L2-normalized vectors, so cosine == dot product.
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

const slices = FILES.map((f) => paramSlice(path.join(FIX, `${f}.ts`)));
console.log('\n[parameter-list slices]');
for (let i = 0; i < FILES.length; i++) {
  console.log(`  ${FILES[i].padEnd(13)} ${slices[i]}`);
}

const { embed } = await import('../../dist/conformity/embed.js');

let vectors;
try {
  vectors = await embed(slices);
} catch (err) {
  console.error('\n[Half B] embedding failed:', err?.message ?? err);
  console.error('[Half B] (model download / @xenova/transformers may be unavailable offline)');
  process.exit(0);
}

// pairwise cosine matrix stats
const n = vectors.length;
const sims = [];
for (let i = 0; i < n; i++) {
  for (let j = i + 1; j < n; j++) {
    sims.push({ a: FILES[i], b: FILES[j], sim: cosine(vectors[i], vectors[j]) });
  }
}
sims.sort((x, y) => y.sim - x.sim);
const vals = sims.map((s) => s.sim);
const min = Math.min(...vals);
const max = Math.max(...vals);
const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
const spread = max - min;

console.log('\n[pairwise cosine over %d pairs]', sims.length);
console.log(`  min=${min.toFixed(4)}  mean=${mean.toFixed(4)}  max=${max.toFixed(4)}  spread(max-min)=${spread.toFixed(4)}`);

console.log('\n  most similar pairs:');
for (const s of sims.slice(0, 5)) console.log(`    ${s.a.padEnd(13)} ~ ${s.b.padEnd(13)} cos=${s.sim.toFixed(4)}`);
console.log('  least similar pairs:');
for (const s of sims.slice(-5)) console.log(`    ${s.a.padEnd(13)} ~ ${s.b.padEnd(13)} cos=${s.sim.toFixed(4)}`);

console.log('\n[Half B verdict]');
if (spread < 0.10) {
  console.log(`  COLLAPSE: slice cosine spread is only ${spread.toFixed(4)} (< 0.10).`);
  console.log('  The narrow parameter-list slice does NOT separate functions -- the');
  console.log('  embedding squashes these short canonical strings together, like the');
  console.log("  abandoned signature skeletons did. Embedding-per-slice is NOT viable;");
  console.log('  deterministic categorical extraction (Half A) is the reliable path.');
} else {
  console.log(`  SEPARATES: slice cosine spread is ${spread.toFixed(4)} (>= 0.10).`);
  console.log('  The slice retains some structure, but compare to Half A: the');
  console.log('  deterministic facts give a crisp, explainable per-decision verdict');
  console.log('  while the embedding only gives a fuzzy continuous similarity.');
}
