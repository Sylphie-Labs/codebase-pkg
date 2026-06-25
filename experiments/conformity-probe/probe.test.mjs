/**
 * probe.test.mjs -- unit tests for the conformity-probe PURE helpers.
 *
 * These tests must NOT require the model download: they never import embed.mjs
 * and never call @xenova/transformers. They cover:
 *   - normalizer canonicalization (cosmetic edits collapse to one skeleton)
 *   - cosine distance / similarity math
 *   - kNN pool distance
 *
 * Parser-fed cases use a temp-dir fixture parsed by the package's built parser,
 * mirroring test/ast-parser.test.mjs (temp dir outside the repo so tsconfig
 * discovery does not interfere).
 *
 * Run after `npm run build`:
 *   node --test experiments/conformity-probe/probe.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  rawSignature,
  normalizedSignature,
  signatureText,
  collapseWhitespace,
} from './normalizer.mjs';
import {
  cosineSimilarity,
  cosineDistance,
  knnPoolDistance,
} from './distance.mjs';
import { cosmeticEdit, smallStructuralEdit, divergentEdit } from './edit-generator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const FIXTURE_SOURCE = `export function add(first: number, second: number): number {
  return first + second;
}

export function greet(name: string, loud = false): string {
  return loud ? name.toUpperCase() : name;
}

export function noop(): void {}
`;

let tmpDir;
let functions;

before(async () => {
  const { parseFiles } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'dist', 'sync', 'ast-parser.js')).href
  );
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-probe-'));
  const fixturePath = path.join(tmpDir, 'fixture.ts');
  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, 'utf8');
  const parsed = parseFiles([fixturePath]);
  assert.equal(parsed.length, 1, 'fixture parsed');
  functions = parsed[0].functions;
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// normalizer
// --------------------------------------------------------------------------

test('collapseWhitespace squashes runs and trims', () => {
  assert.equal(collapseWhitespace('  a\n\t b   c '), 'a b c');
});

test('rawSignature keeps real names and types', () => {
  const add = functions.find((f) => f.name === 'add');
  assert.equal(rawSignature(add), 'add(first: number, second: number): number');
});

test('normalizedSignature collapses identifiers/types to a structural skeleton', () => {
  const add = functions.find((f) => f.name === 'add');
  assert.equal(normalizedSignature(add), 'NAME(ARG: TYPE, ARG: TYPE): RET');
});

test('normalizedSignature: real default param surfaces a DEFAULT marker', () => {
  // PARSER REALITY (updated): ts-morph extractArgsFromNode now captures the
  // parameter initializer via `hasDefault`. So `loud = false` (no type
  // annotation) arrives as { name: 'loud', type: 'unknown', hasDefault: true }
  // -> a typeless ARG slot that DOES carry the DEFAULT marker. This is genuine
  // structural signal derived from real parsed functions, not just synthetic
  // edits whose name contains '='.
  const greet = functions.find((f) => f.name === 'greet');
  assert.equal(normalizedSignature(greet), 'NAME(ARG: TYPE, ARG=DEFAULT): RET');

  // `noop(): void` has an explicit annotation, so returnType is the truthy
  // string 'void' -> renders RET. The VOID sentinel is reserved for the case
  // where no return type is present at all (empty string).
  const noop = functions.find((f) => f.name === 'noop');
  assert.equal(normalizedSignature(noop), 'NAME(): RET');
  assert.equal(
    normalizedSignature({ name: 'x', returnType: '', args: [] }),
    'NAME(): VOID',
    'absent return type -> VOID sentinel'
  );
});

test('normalizedSignature marks DEFAULT for synthetic args carrying "=" in name', () => {
  // The edit generator encodes a default as `opts = {}` in the arg name.
  const synthetic = { name: 'fn', returnType: 'void', args: [{ name: 'opts = {}', type: 'Record<string, unknown>' }] };
  assert.equal(normalizedSignature(synthetic), 'NAME(ARG=DEFAULT: TYPE): RET');
});

test('cosmetic edit is a NO-OP under normalization but changes raw text', () => {
  const add = functions.find((f) => f.name === 'add');
  const edited = cosmeticEdit(add);
  // structural skeleton identical -> the crux property the probe relies on
  assert.equal(
    normalizedSignature(edited),
    normalizedSignature(add),
    'cosmetic rename must not change the normalized skeleton'
  );
  // raw text DOES change (different identifiers)
  assert.notEqual(rawSignature(edited), rawSignature(add));
});

test('small-structural edit changes arity -> different normalized skeleton', () => {
  const add = functions.find((f) => f.name === 'add');
  const edited = smallStructuralEdit(add);
  const before = normalizedSignature(add);
  const afterEdit = normalizedSignature(edited);
  assert.notEqual(afterEdit, before);
  // one extra ARG slot with a default marker
  assert.ok(afterEdit.includes('ARG=DEFAULT'), 'added default param present in skeleton');
  assert.ok(
    (afterEdit.match(/ARG/g) || []).length > (before.match(/ARG/g) || []).length,
    'arity increased'
  );
});

test('divergent edit produces a distinct skeleton from cosmetic and small', () => {
  const add = functions.find((f) => f.name === 'add');
  const skeletons = new Set([
    normalizedSignature(cosmeticEdit(add)),
    normalizedSignature(smallStructuralEdit(add)),
    normalizedSignature(divergentEdit(add)),
  ]);
  // small-structural and divergent must differ from cosmetic (== original)
  assert.ok(skeletons.size >= 2, 'edit tiers produce distinct skeletons');
});

test('signatureText dispatches on mode', () => {
  const add = functions.find((f) => f.name === 'add');
  assert.equal(signatureText(add, 'raw'), rawSignature(add));
  assert.equal(signatureText(add, 'normalized'), normalizedSignature(add));
});

// --------------------------------------------------------------------------
// distance math
// --------------------------------------------------------------------------

test('cosineSimilarity: identical direction = 1, orthogonal = 0, opposite = -1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [3, 0]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 5]) - 0) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-2, 0]) + 1) < 1e-12);
});

test('cosineSimilarity: zero vector yields 0 (no NaN)', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test('cosineDistance is 1 - similarity', () => {
  assert.ok(Math.abs(cosineDistance([1, 0], [3, 0]) - 0) < 1e-12);
  assert.ok(Math.abs(cosineDistance([1, 0], [0, 1]) - 1) < 1e-12);
});

test('cosineSimilarity throws on dimension mismatch', () => {
  assert.throws(() => cosineSimilarity([1, 2, 3], [1, 2]), /dimension mismatch/);
});

// --------------------------------------------------------------------------
// kNN pool distance
// --------------------------------------------------------------------------

test('knnPoolDistance averages the k nearest (not all) neighbors', () => {
  const vec = [1, 0];
  // three near-identical, two orthogonal-ish
  const pool = [
    [1, 0],      // dist 0
    [0.99, 0.01],// ~0
    [0.98, 0.02],// ~small
    [0, 1],      // dist 1
    [-1, 0],     // dist 2
  ];
  const d2 = knnPoolDistance(vec, pool, 2);
  const d5 = knnPoolDistance(vec, pool, 5);
  assert.ok(d2 < 0.01, `k=2 picks the closest two (got ${d2})`);
  assert.ok(d5 > d2, 'k=5 pulls in far neighbors and raises the mean');
});

test('knnPoolDistance clamps k to pool size', () => {
  const d = knnPoolDistance([1, 0], [[1, 0], [0, 1]], 10);
  // mean of dist 0 and dist 1 = 0.5
  assert.ok(Math.abs(d - 0.5) < 1e-12, `got ${d}`);
});

test('knnPoolDistance throws on empty pool', () => {
  assert.throws(() => knnPoolDistance([1, 0], []), /empty pool/);
});
