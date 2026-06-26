/**
 * Tests for the Conformity Judge engine (dist/conformity/*).
 *
 * These tests cover PURE logic only and MUST NOT trigger a model download:
 * they never import the real embed backend's network path. Anything needing
 * embeddings injects a deterministic, offline, hash-based fake Embedder.
 *
 * Covered:
 *   - normalizer canonicalization (cosmetic-equivalent sigs normalize identical;
 *     a default param adds a DEFAULT marker)
 *   - cosine similarity/distance math
 *   - kNN pool selection (k nearest, clamping, empty-pool error)
 *   - category derivation + skeleton helper
 *   - judgeChunk orchestration with an injected fake embedder
 *
 * Parser-fed cases use a temp-dir fixture parsed by the package's built parser,
 * mirroring test/ast-parser.test.mjs (temp dir outside the repo so tsconfig
 * discovery does not interfere).
 *
 * Run after `npm run build`:
 *   node --test test/conformity.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { parseFiles } from '../dist/sync/ast-parser.js';
import {
  collapseWhitespace,
  normalizedBody,
  rawSignature,
  normalizedSignature,
  signatureText,
} from '../dist/conformity/normalize.js';
import {
  cosineSimilarity,
  cosineDistance,
  knnPoolDistance,
} from '../dist/conformity/distance.js';
import {
  categoryOf,
  representationText,
  signatureSkeleton,
  isParsedConstant,
  isParsedType,
  FUNCTION_BODY,
  TYPE_BODY,
  MODULE_CONST,
  FUNCTION_SIGNATURE_SKELETON,
  CATEGORIES,
} from '../dist/conformity/category.js';
import { judgeChunk, DRAFT_OUTLIER_THRESHOLD } from '../dist/conformity/judge.js';

const FIXTURE_SOURCE = `export function add(first: number, second: number): number {
  return first + second;
}

export function greet(name: string, loud = false): string {
  return loud ? name.toUpperCase() : name;
}

export function noop(): void {}

export interface UserDto {
  id: string;
  name: string;
}

export const CONFIG = {
  retries: 3,
  baseUrl: 'https://example.com',
};
`;

let tmpDir;
let functions;
let types;
let constants;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-conformity-'));
  const fixturePath = path.join(tmpDir, 'fixture.ts');
  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, 'utf8');
  const parsed = parseFiles([fixturePath]);
  assert.equal(parsed.length, 1, 'fixture parsed');
  functions = parsed[0].functions;
  types = parsed[0].types;
  constants = parsed[0].constants;
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Deterministic, offline fake Embedder: hashes each text into a fixed-length
 * vector so identical text -> identical vector, and different text -> a
 * different (but stable) vector. No model, no network.
 */
function fakeEmbedder(dim = 16) {
  return async (texts) =>
    texts.map((t) => {
      const vec = new Array(dim).fill(0);
      const digest = crypto.createHash('sha256').update(t).digest();
      for (let i = 0; i < dim; i++) {
        // map each byte into [-1, 1]
        vec[i] = (digest[i % digest.length] / 255) * 2 - 1;
      }
      return vec;
    });
}

// --------------------------------------------------------------------------
// normalizer
// --------------------------------------------------------------------------

test('collapseWhitespace squashes runs and trims', () => {
  assert.equal(collapseWhitespace('  a\n\t b   c '), 'a b c');
});

// --------------------------------------------------------------------------
// normalizedBody / representationText -- the CURRENT embedding path
// --------------------------------------------------------------------------

test('normalizedBody strips line comments and collapses whitespace', () => {
  const body = `{
    // add the two operands
    return first + second; // result
  }`;
  // Identifiers and literals are KEPT; only comments + whitespace are normalized.
  assert.equal(normalizedBody({ bodyText: body }), '{ return first + second; }');
});

test('normalizedBody strips block comments (including multi-line)', () => {
  const body = `{
    /* a
       multi-line
       block comment */
    return x /* inline */ * 2;
  }`;
  assert.equal(normalizedBody({ bodyText: body }), '{ return x * 2; }');
});

test('normalizedBody keeps identifiers and literals (does NOT skeletonize)', () => {
  const out = normalizedBody({ bodyText: '{ const greeting = "hello world"; return greeting; }' });
  assert.ok(out.includes('greeting'), 'identifier kept');
  assert.ok(out.includes('"hello world"'), 'string literal kept');
  // Sanity: it is NOT collapsed to a NAME/ARG skeleton.
  assert.ok(!out.includes('ARG'));
  assert.ok(!out.includes('TYPE'));
});

test('normalizedBody: empty / missing body -> empty string', () => {
  assert.equal(normalizedBody({ bodyText: '' }), '');
  assert.equal(normalizedBody({}), '');
});

test('two byte-identical bodies normalize identically', () => {
  const body = '{\n  return a + b;\n}';
  assert.equal(normalizedBody({ bodyText: body }), normalizedBody({ bodyText: body }));
});

test('cosmetically-equivalent bodies (comments/whitespace only) normalize identically', () => {
  const a = '{ return a + b; }';
  const b = `{
      // sum them
      return a + b;
  }`;
  assert.equal(normalizedBody({ bodyText: a }), normalizedBody({ bodyText: b }));
});

test('two DIFFERENT bodies normalize differently', () => {
  const a = normalizedBody({ bodyText: '{ return a + b; }' });
  const b = normalizedBody({ bodyText: '{ return a * b; }' });
  assert.notEqual(a, b);
});

test('representationText is normalizedBody of the parsed function', () => {
  const add = functions.find((f) => f.name === 'add');
  assert.equal(representationText(add), normalizedBody(add));
  // The parsed body keeps the real `return first + second` expression.
  assert.ok(representationText(add).includes('first + second'));
});

test('rawSignature keeps real names and types', () => {
  const add = functions.find((f) => f.name === 'add');
  assert.equal(rawSignature(add), 'add(first: number, second: number): number');
});

test('normalizedSignature collapses identifiers/types to a structural skeleton', () => {
  const add = functions.find((f) => f.name === 'add');
  assert.equal(normalizedSignature(add), 'NAME(ARG: TYPE, ARG: TYPE): RET');
});

test('cosmetic-equivalent signatures normalize identically', () => {
  // Two functions with different names, param names, and concrete types but the
  // same arity/typed-ness/return must collapse to one skeleton.
  const a = { name: 'add', returnType: 'number', args: [
    { name: 'first', type: 'number', hasDefault: false },
    { name: 'second', type: 'number', hasDefault: false },
  ] };
  const b = { name: 'combine', returnType: 'string', args: [
    { name: 'alpha', type: 'Foo', hasDefault: false },
    { name: 'beta', type: 'Bar', hasDefault: false },
  ] };
  assert.equal(normalizedSignature(a), normalizedSignature(b));
  // ...but the raw text differs (identifiers/types preserved)
  assert.notEqual(rawSignature(a), rawSignature(b));
});

test('a real default param adds a DEFAULT marker to the skeleton', () => {
  // ts-morph captures `loud = false` as { hasDefault: true } (typeless) ->
  // a typeless ARG slot that carries the DEFAULT marker.
  const greet = functions.find((f) => f.name === 'greet');
  assert.equal(normalizedSignature(greet), 'NAME(ARG: TYPE, ARG=DEFAULT): RET');

  // Same shape WITHOUT the default must NOT carry DEFAULT -> different skeleton.
  const noDefault = { name: 'greet', returnType: 'string', args: [
    { name: 'name', type: 'string', hasDefault: false },
    { name: 'loud', type: 'unknown', hasDefault: false },
  ] };
  assert.notEqual(normalizedSignature(greet), normalizedSignature(noDefault));
  assert.ok(normalizedSignature(greet).includes('ARG=DEFAULT'));
  assert.ok(!normalizedSignature(noDefault).includes('DEFAULT'));
});

test('absent return type -> VOID sentinel; present -> RET', () => {
  const noop = functions.find((f) => f.name === 'noop');
  // `noop(): void` has an explicit annotation -> truthy returnType -> RET.
  assert.equal(normalizedSignature(noop), 'NAME(): RET');
  assert.equal(
    normalizedSignature({ name: 'x', returnType: '', args: [] }),
    'NAME(): VOID',
  );
});

test('normalizedSignature marks DEFAULT for synthetic args carrying "=" in name', () => {
  const synthetic = { name: 'fn', returnType: 'void', args: [
    { name: 'opts = {}', type: 'Record<string, unknown>' },
  ] };
  assert.equal(normalizedSignature(synthetic), 'NAME(ARG=DEFAULT: TYPE): RET');
});

test('signatureText defaults to normalized and dispatches on mode', () => {
  const add = functions.find((f) => f.name === 'add');
  assert.equal(signatureText(add), normalizedSignature(add)); // default
  assert.equal(signatureText(add, 'raw'), rawSignature(add));
  assert.equal(signatureText(add, 'normalized'), normalizedSignature(add));
});

// --------------------------------------------------------------------------
// distance math
// --------------------------------------------------------------------------

test('cosineSimilarity: identical=1, orthogonal=0, opposite=-1', () => {
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
  const pool = [
    [1, 0],       // dist 0
    [0.99, 0.01], // ~0
    [0.98, 0.02], // ~small
    [0, 1],       // dist 1
    [-1, 0],      // dist 2
  ];
  const d2 = knnPoolDistance(vec, pool, 2);
  const d5 = knnPoolDistance(vec, pool, 5);
  assert.ok(d2 < 0.01, `k=2 picks the closest two (got ${d2})`);
  assert.ok(d5 > d2, 'k=5 pulls in far neighbors and raises the mean');
});

test('knnPoolDistance clamps k to pool size', () => {
  const d = knnPoolDistance([1, 0], [[1, 0], [0, 1]], 10);
  assert.ok(Math.abs(d - 0.5) < 1e-12, `got ${d}`); // mean of 0 and 1
});

test('knnPoolDistance defaults k to 5', () => {
  // 6 identical + 1 far: default k=5 averages only near ones -> ~0.
  const pool = [[1, 0], [1, 0], [1, 0], [1, 0], [1, 0], [1, 0], [-1, 0]];
  const d = knnPoolDistance([1, 0], pool);
  assert.ok(d < 1e-12, `default k should ignore the far neighbor (got ${d})`);
});

test('knnPoolDistance throws on empty pool', () => {
  assert.throws(() => knnPoolDistance([1, 0], []), /empty pool/);
});

// --------------------------------------------------------------------------
// category derivation
// --------------------------------------------------------------------------

test('categoryOf returns the whole-body category for functions', () => {
  const add = functions.find((f) => f.name === 'add');
  assert.equal(categoryOf(add), FUNCTION_BODY);
  assert.ok(CATEGORIES.includes(FUNCTION_BODY));
  // The abandoned skeleton category is no longer the active category.
  assert.ok(!CATEGORIES.includes(FUNCTION_SIGNATURE_SKELETON));
});

test('categoryOf returns type:body for a parsed type, function:body for a function', () => {
  const userDto = types.find((t) => t.name === 'UserDto');
  assert.ok(userDto, 'UserDto type parsed');
  assert.equal(categoryOf(userDto), TYPE_BODY);
  assert.ok(CATEGORIES.includes(TYPE_BODY));

  // A function in the same fixture still routes to function:body -- types and
  // functions are never mixed into one pool.
  const add = functions.find((f) => f.name === 'add');
  assert.equal(categoryOf(add), FUNCTION_BODY);
  assert.notEqual(categoryOf(userDto), categoryOf(add));
});

test('categoryOf returns module:const for a parsed constant; guards discriminate it', () => {
  const config = constants.find((c) => c.name === 'CONFIG');
  assert.ok(config, 'CONFIG constant parsed');
  assert.equal(categoryOf(config), MODULE_CONST);
  assert.ok(CATEGORIES.includes(MODULE_CONST));

  // The type guards must classify a constant as a constant, NOT a type, even
  // though both carry a `kind` field.
  assert.equal(isParsedConstant(config), true, 'constant recognized by isParsedConstant');
  assert.equal(isParsedType(config), false, 'constant NOT misclassified as a type');

  // A type in the same fixture must NOT be a constant, and routes to type:body.
  const userDto = types.find((t) => t.name === 'UserDto');
  assert.equal(isParsedConstant(userDto), false);
  assert.equal(categoryOf(userDto), TYPE_BODY);

  // Constants, types, and functions are three distinct pools.
  const add = functions.find((f) => f.name === 'add');
  assert.notEqual(categoryOf(config), categoryOf(userDto));
  assert.notEqual(categoryOf(config), categoryOf(add));
});

test('representationText/normalizedBody work on a constant body (declaration source kept)', () => {
  const config = constants.find((c) => c.name === 'CONFIG');
  assert.ok(config.bodyText && config.bodyText.length > 0, 'constant carries bodyText');
  assert.equal(representationText(config), normalizedBody(config));
  // Identifiers/literals from the declaration are preserved (not skeletonized).
  assert.ok(representationText(config).includes('CONFIG'));
  assert.ok(representationText(config).includes('retries'));
});

test('representationText/normalizedBody work on a type body (declaration source kept)', () => {
  const userDto = types.find((t) => t.name === 'UserDto');
  // The parser captured the interface declaration's source as bodyText.
  assert.ok(userDto.bodyText && userDto.bodyText.length > 0, 'type carries bodyText');
  assert.equal(representationText(userDto), normalizedBody(userDto));
  // Identifiers from the declaration are preserved (not skeletonized).
  assert.ok(representationText(userDto).includes('UserDto'));
  assert.ok(representationText(userDto).includes('id'));
});

test('signatureSkeleton (legacy) still defaults to normalized, honors { normalized: false }', () => {
  // Kept for back-compat/diagnostics; no longer the embedding path.
  const add = functions.find((f) => f.name === 'add');
  assert.equal(signatureSkeleton(add), normalizedSignature(add));
  assert.equal(signatureSkeleton(add, { normalized: false }), rawSignature(add));
});

// --------------------------------------------------------------------------
// judgeChunk orchestration (injected fake embedder -- NO model)
// --------------------------------------------------------------------------

test('judgeChunk derives category + representation text and measures pool distance', async () => {
  const add = functions.find((f) => f.name === 'add');
  const embed = fakeEmbedder();
  // Build a same-category pool. One entry uses the EXACT representation text of
  // `add` so a nearest neighbor is at distance ~0.
  const text = representationText(add);
  const [matchVec] = await embed([text]);
  const [otherVec] = await embed(['{ return x; }']);
  const pool = [
    { category: FUNCTION_BODY, vector: matchVec, identifier: 'twin' },
    { category: FUNCTION_BODY, vector: otherVec, identifier: 'other' },
  ];

  // k=1 -> distance is to the single nearest neighbor (the exact twin -> ~0).
  const j = await judgeChunk(add, pool, { embed, k: 1 });
  assert.equal(j.category, FUNCTION_BODY);
  assert.equal(j.skeleton, text);
  assert.equal(j.poolSize, 2);
  assert.equal(j.k, 1);
  assert.ok(j.distance < 1e-9, `exact twin is the nearest neighbor -> ~0 (got ${j.distance})`);
  assert.equal(j.verdict, 'conforms');
});

test('judgeChunk filters the pool to the chunk category', async () => {
  const add = functions.find((f) => f.name === 'add');
  const embed = fakeEmbedder();
  const text = representationText(add);
  const [matchVec] = await embed([text]);
  const pool = [
    // a wrong-category entry that should be ignored entirely
    { category: 'some:other-category', vector: [9, 9, 9], identifier: 'wrong' },
    { category: FUNCTION_BODY, vector: matchVec, identifier: 'twin' },
  ];
  const j = await judgeChunk(add, pool, { embed });
  assert.equal(j.poolSize, 1, 'only the same-category entry counts');
  assert.ok(j.distance < 1e-9);
});

test('judgeChunk throws when no same-category pool entries exist', async () => {
  const add = functions.find((f) => f.name === 'add');
  const embed = fakeEmbedder();
  const pool = [
    { category: 'some:other-category', vector: [1, 2, 3], identifier: 'wrong' },
  ];
  await assert.rejects(
    () => judgeChunk(add, pool, { embed }),
    /nothing to conform to/,
  );
});

test('judgeChunk flags an outlier when distance exceeds the draft threshold', async () => {
  const add = functions.find((f) => f.name === 'add');
  // Embedder that returns a fixed query vector but distant pool vectors.
  const embed = async (texts) => texts.map(() => [1, 0, 0]);
  const pool = [
    { category: FUNCTION_BODY, vector: [0, 1, 0], identifier: 'far1' },
    { category: FUNCTION_BODY, vector: [0, 0, 1], identifier: 'far2' },
  ];
  const j = await judgeChunk(add, pool, { embed });
  assert.ok(j.distance > DRAFT_OUTLIER_THRESHOLD, `distance ${j.distance} should exceed threshold`);
  assert.equal(j.verdict, 'outlier');
});
