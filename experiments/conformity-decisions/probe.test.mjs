/**
 * probe.test.mjs -- node:test assertions for the per-decision style extractor.
 *
 * Because we wrote the 10 controlled fixtures, we know their exact decision
 * facts. This file asserts the extracted facts against that hand-derived ground
 * truth, plus the per-dimension distribution counts and the specific
 * per-decision outlier calls (Half A). If the extractor drifts, these break.
 *
 * Run: node --test experiments/conformity-decisions/probe.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  extractFile,
  distributions,
  flagOutliers,
  DIMENSIONS,
} from './extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '..', 'conformity-controlled', 'fixtures');

const FILES = [
  'c1_mean', 'c2_mean', 'c3_mean', 'c4_mean', 'c5_exact',
  'r1_debounce', 'r2_treewalk', 'r3_retry', 'r4_tokenize', 'r5_quicksort',
];

// Ground truth: hand-derived from reading every fixture.
const TRUTH = {
  c1_mean:      { name: 'mean',           array_syntax: 'bracket', fn_style: 'function', return_type: 'explicit', loop_style: 'index-for', recurses: false, param_count: 1, var_decl: 'let' },
  c2_mean:      { name: 'average',        array_syntax: 'bracket', fn_style: 'function', return_type: 'explicit', loop_style: 'index-for', recurses: false, param_count: 1, var_decl: 'let' },
  c3_mean:      { name: 'computeMean',    array_syntax: 'bracket', fn_style: 'function', return_type: 'explicit', loop_style: 'for-of',    recurses: false, param_count: 1, var_decl: 'let' },
  c4_mean:      { name: 'arithmeticMean', array_syntax: 'bracket', fn_style: 'function', return_type: 'explicit', loop_style: 'index-for', recurses: false, param_count: 1, var_decl: 'mixed' },
  c5_exact:     { name: 'mean',           array_syntax: 'bracket', fn_style: 'function', return_type: 'explicit', loop_style: 'index-for', recurses: false, param_count: 1, var_decl: 'let' },
  r1_debounce:  { name: 'debounce',       array_syntax: 'bracket', fn_style: 'function', return_type: 'explicit', loop_style: 'none',      recurses: false, param_count: 2, var_decl: 'let' },
  r2_treewalk:  { name: 'inOrder',        array_syntax: 'bracket', fn_style: 'function', return_type: 'explicit', loop_style: 'recursion', recurses: true,  param_count: 1, var_decl: 'const' },
  r3_retry:     { name: 'retry',          array_syntax: 'none',    fn_style: 'function', return_type: 'explicit', loop_style: 'index-for', recurses: false, param_count: 2, var_decl: 'mixed' },
  r4_tokenize:  { name: 'tokenize',       array_syntax: 'bracket', fn_style: 'function', return_type: 'explicit', loop_style: 'while',     recurses: false, param_count: 1, var_decl: 'mixed' },
  r5_quicksort: { name: 'quicksort',      array_syntax: 'bracket', fn_style: 'function', return_type: 'explicit', loop_style: 'index-for', recurses: true,  param_count: 1, var_decl: 'const' },
};

function recordsForAll() {
  return FILES.map((f) => ({ file: f, facts: extractFile(path.join(FIX, `${f}.ts`))[0] }));
}

// ---- one exported function per fixture --------------------------------------
test('each fixture has exactly one exported function', () => {
  for (const f of FILES) {
    const facts = extractFile(path.join(FIX, `${f}.ts`));
    assert.equal(facts.length, 1, `${f} should expose one exported fn`);
  }
});

// ---- per-file exact fact assertions -----------------------------------------
for (const f of FILES) {
  test(`facts: ${f}`, () => {
    const facts = extractFile(path.join(FIX, `${f}.ts`))[0];
    const want = TRUTH[f];
    for (const key of ['name', 'array_syntax', 'fn_style', 'return_type', 'loop_style', 'recurses', 'param_count', 'var_decl']) {
      assert.deepEqual(facts[key], want[key], `${f}.${key}: got ${facts[key]}, want ${want[key]}`);
    }
  });
}

// ---- per-dimension distribution counts --------------------------------------
test('per-dimension distributions', () => {
  const dist = distributions(recordsForAll());
  assert.deepEqual(dist.array_syntax, { bracket: 9, none: 1 });
  assert.deepEqual(dist.fn_style,     { function: 10 });
  assert.deepEqual(dist.return_type,  { explicit: 10 });
  assert.deepEqual(dist.loop_style,   { 'index-for': 6, 'for-of': 1, none: 1, recursion: 1, while: 1 });
  assert.deepEqual(dist.param_count,  { 1: 8, 2: 2 });
  assert.deepEqual(dist.var_decl,     { let: 5, mixed: 3, const: 2 });
});

// ---- specific per-decision outlier calls ------------------------------------
test('flagged per-decision outliers match expectation', () => {
  const records = recordsForAll();
  const dist = distributions(records);
  const flags = flagOutliers(records, dist);

  // Canonicalize to "file:dim=value" strings for set comparison.
  const got = new Set(flags.map((fl) => `${fl.file}:${fl.dim}=${fl.value}`));

  const expected = new Set([
    'r3_retry:array_syntax=none',
    'c3_mean:loop_style=for-of',
    'r1_debounce:loop_style=none',
    'r2_treewalk:loop_style=recursion',
    'r4_tokenize:loop_style=while',
    'r1_debounce:param_count=2',
    'r3_retry:param_count=2',
    'c4_mean:var_decl=mixed',
    'r3_retry:var_decl=mixed',
    'r4_tokenize:var_decl=mixed',
    'r2_treewalk:var_decl=const',
    'r5_quicksort:var_decl=const',
  ]);

  assert.deepEqual(got, expected);
});

// ---- conformity sanity: c1 and c5 are byte-identical bodies -----------------
test('c1 and c5 make identical decisions (exact copy)', () => {
  const a = extractFile(path.join(FIX, 'c1_mean.ts'))[0];
  const b = extractFile(path.join(FIX, 'c5_exact.ts'))[0];
  for (const dim of DIMENSIONS) {
    assert.deepEqual(a[dim], b[dim], `dim ${dim} should match between c1 and c5`);
  }
});

// ---- the all-conformist files have zero flags -------------------------------
test('c1/c2/c5 (house-style mean) have no per-decision outliers', () => {
  const records = recordsForAll();
  const dist = distributions(records);
  const flags = flagOutliers(records, dist);
  const flagged = new Set(flags.map((fl) => fl.file));
  for (const f of ['c1_mean', 'c2_mean', 'c5_exact']) {
    assert.equal(flagged.has(f), false, `${f} should have no outlier decisions`);
  }
});
