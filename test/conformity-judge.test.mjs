/**
 * Tests for the Conformity Judge JUDGMENT surface (dist/conformity/judge-worktree.js)
 * and the knnNearest helper (dist/conformity/distance.js).
 *
 * PURE logic only -- no Postgres, no model download. A fake ConformityStore
 * returns a canned pool; a deterministic offline embedder maps known skeletons
 * to known vectors so "near" vs "far" is exact and reproducible.
 *
 * Covered:
 *   - knnNearest: ordering, k clamp, empty pool
 *   - a function near the pool -> conforms; a far one -> outlier
 *   - nearest neighbors are correctly ranked and returned (nodeId + distance)
 *   - the judged function's OWN nodeId is excluded from its pool
 *   - empty / unavailable pool -> structured unavailable result (no throw)
 *
 * Run after `npm run build`:
 *   node --test test/conformity-judge.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { knnNearest, cosineDistance } from '../dist/conformity/distance.js';
import {
  judgeFunctions,
  isUnavailable,
} from '../dist/conformity/judge-worktree.js';
import { FUNCTION_SIGNATURE_SKELETON } from '../dist/conformity/category.js';

// --------------------------------------------------------------------------
// knnNearest
// --------------------------------------------------------------------------

test('knnNearest returns the k nearest entries ascending by distance', () => {
  const pool = [
    { identifier: 'far', vector: [0, 1] },
    { identifier: 'near', vector: [1, 0] },
    { identifier: 'mid', vector: [1, 1] },
  ];
  const out = knnNearest([1, 0], pool, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].entry.identifier, 'near');
  assert.equal(out[1].entry.identifier, 'mid');
  // distances are real cosine distances, ascending
  assert.ok(out[0].distance <= out[1].distance);
  assert.ok(Math.abs(out[0].distance - cosineDistance([1, 0], [1, 0])) < 1e-9);
});

test('knnNearest clamps k to the pool size', () => {
  const pool = [
    { identifier: 'a', vector: [1, 0] },
    { identifier: 'b', vector: [0, 1] },
  ];
  const out = knnNearest([1, 0], pool, 10);
  assert.equal(out.length, 2);
});

test('knnNearest on an empty pool returns [] (does not throw)', () => {
  assert.deepEqual(knnNearest([1, 0], [], 5), []);
});

// --------------------------------------------------------------------------
// Fakes for the judgment surface
// --------------------------------------------------------------------------

const CAT = FUNCTION_SIGNATURE_SKELETON;

/**
 * Deterministic embedder driven by an explicit text->vector map. Any skeleton
 * not in the map embeds to a fixed "far" vector so we control near/far exactly.
 */
function mapEmbedder(map, fallback = [0, 0, 1]) {
  return async (texts) => texts.map((t) => map[t] ?? fallback);
}

/** A fake store exposing only loadPool, returning a fixed pool per category. */
function fakeStore(poolByCategory) {
  return {
    async loadPool(category) {
      return poolByCategory[category] ?? [];
    },
  };
}

/** Always-on gate runner: SELECT 1 succeeds so isConformityEnabled() is true. */
const runnerUp = { async query() { return { rows: [] }; } };
/** Gate runner that fails the readiness probe -> conformity unavailable. */
const runnerDown = { async query() { throw new Error('no pg'); } };

/** Build a minimal ParsedFunction whose normalized skeleton we can predict. */
function fn(name, filePath, args, returnType) {
  return {
    name,
    filePath,
    lineNumber: 1,
    endLine: 1,
    args: args.map((a) => ({ name: a.name, type: a.type, hasDefault: false })),
    returnType,
    jsDoc: '',
    bodyText: '',
    isExported: true,
    isAsync: false,
    decorators: [],
    callees: [],
    typeRefs: [],
    contentHash: name,
  };
}

// A single-arg function -> skeleton "NAME(ARG: TYPE): RET".
const SKEL_1 = 'NAME(ARG: TYPE): RET';

// --------------------------------------------------------------------------
// Judgment surface
// --------------------------------------------------------------------------

test('a function near the pool conforms; a far one is an outlier', async () => {
  const pool = [
    { category: CAT, identifier: 'a.ts::a', vector: [1, 0, 0] },
    { category: CAT, identifier: 'b.ts::b', vector: [1, 0, 0] },
  ];
  // "near" embeds onto the pool direction; "far" embeds orthogonal.
  const embedder = mapEmbedder({ [SKEL_1]: [1, 0, 0] });

  const near = fn('near', 'work.ts', [{ name: 'x', type: 'number' }], 'number');
  const resNear = await judgeFunctions([near], {
    store: fakeStore({ [CAT]: pool }),
    embedder,
    runner: runnerUp,
  });
  assert.ok(!isUnavailable(resNear));
  assert.equal(resNear[0].verdict, 'conforms');
  assert.ok(resNear[0].distance < 1e-9);

  const far = fn('far', 'work.ts', [{ name: 'x', type: 'number' }], 'number');
  const resFar = await judgeFunctions([far], {
    store: fakeStore({ [CAT]: pool }),
    embedder: mapEmbedder({ [SKEL_1]: [0, 0, 1] }), // orthogonal -> distance ~1
    runner: runnerUp,
  });
  assert.equal(resFar[0].verdict, 'outlier');
  assert.ok(resFar[0].distance > 0.9);
});

test('nearest neighbors are ranked and returned with nodeId + distance', async () => {
  const pool = [
    { category: CAT, identifier: 'a.ts::a', vector: [1, 0, 0] },     // exact
    { category: CAT, identifier: 'b.ts::b', vector: [0.9, 0.1, 0] }, // close
    { category: CAT, identifier: 'c.ts::c', vector: [0, 1, 0] },     // far
  ];
  const f = fn('q', 'work.ts', [{ name: 'x', type: 'number' }], 'number');
  const res = await judgeFunctions([f], {
    store: fakeStore({ [CAT]: pool }),
    embedder: mapEmbedder({ [SKEL_1]: [1, 0, 0] }),
    runner: runnerUp,
    k: 2,
  });
  assert.ok(!isUnavailable(res));
  const nearest = res[0].nearest;
  assert.equal(nearest.length, 2, 'k=2 neighbors');
  assert.equal(nearest[0].nodeId, 'a.ts::a');
  assert.equal(nearest[1].nodeId, 'b.ts::b');
  assert.ok(nearest[0].distance <= nearest[1].distance);
  assert.equal(typeof nearest[0].distance, 'number');
});

test("the function's OWN nodeId is excluded from its judgment pool", async () => {
  // The judged function is already committed: its own vector sits in the pool,
  // identical to its skeleton embedding. If NOT excluded, the nearest neighbor
  // would be itself at distance ~0. Exclusion must drop it.
  const f = fn('self', 'work.ts', [{ name: 'x', type: 'number' }], 'number');
  const selfId = 'work.ts::self';
  const pool = [
    { category: CAT, identifier: selfId, vector: [1, 0, 0] },      // self
    { category: CAT, identifier: 'other.ts::o', vector: [0, 1, 0] }, // the only real peer
  ];
  const res = await judgeFunctions([f], {
    store: fakeStore({ [CAT]: pool }),
    embedder: mapEmbedder({ [SKEL_1]: [1, 0, 0] }),
    runner: runnerUp,
  });
  assert.ok(!isUnavailable(res));
  const j = res[0];
  assert.equal(j.poolSize, 1, 'self excluded -> only 1 peer remains');
  assert.ok(
    j.nearest.every((n) => n.nodeId !== selfId),
    'self nodeId must not appear in nearest neighbors',
  );
  assert.equal(j.nearest[0].nodeId, 'other.ts::o');
  // distance is to the OTHER function (orthogonal), not ~0 self-match.
  assert.ok(j.distance > 0.9);
});

test('empty same-category pool yields an unjudged result (no throw)', async () => {
  const f = fn('lonely', 'work.ts', [{ name: 'x', type: 'number' }], 'number');
  const res = await judgeFunctions([f], {
    store: fakeStore({ [CAT]: [] }),
    embedder: mapEmbedder({ [SKEL_1]: [1, 0, 0] }),
    runner: runnerUp,
  });
  assert.ok(!isUnavailable(res));
  assert.equal(res.length, 1);
  assert.equal(res[0].verdict, 'unjudged');
  assert.equal(res[0].distance, null);
  assert.deepEqual(res[0].nearest, []);
  assert.equal(res[0].poolSize, 0);
});

test('a pool of only the function itself excludes self -> unjudged', async () => {
  const f = fn('solo', 'work.ts', [{ name: 'x', type: 'number' }], 'number');
  const pool = [{ category: CAT, identifier: 'work.ts::solo', vector: [1, 0, 0] }];
  const res = await judgeFunctions([f], {
    store: fakeStore({ [CAT]: pool }),
    embedder: mapEmbedder({ [SKEL_1]: [1, 0, 0] }),
    runner: runnerUp,
  });
  assert.ok(!isUnavailable(res));
  assert.equal(res[0].verdict, 'unjudged');
  assert.equal(res[0].poolSize, 0);
});

test('unavailable Postgres yields a structured unavailable result (no throw)', async () => {
  const f = fn('x', 'work.ts', [{ name: 'x', type: 'number' }], 'number');
  const res = await judgeFunctions([f], {
    store: fakeStore({ [CAT]: [] }),
    embedder: mapEmbedder({}),
    runner: runnerDown,
  });
  assert.ok(isUnavailable(res), 'gate returns unavailable, not judgments');
  assert.equal(res.unavailable, true);
  assert.equal(typeof res.reason, 'string');
  assert.ok(res.reason.length > 0);
});

test('outliers sort ahead of conformers in the result order', async () => {
  const pool = [
    { category: CAT, identifier: 'p.ts::p', vector: [1, 0, 0] },
    { category: CAT, identifier: 'q.ts::q', vector: [1, 0, 0] },
  ];
  // Two functions with the SAME skeleton but we drive embeddings by skeleton,
  // so use distinct arity to get distinct skeletons -> distinct vectors.
  const conformer = fn('c', 'work.ts', [{ name: 'a', type: 'number' }], 'number');
  const outlier = fn('o', 'work.ts',
    [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], 'number');
  const skelConformer = 'NAME(ARG: TYPE): RET';
  const skelOutlier = 'NAME(ARG: TYPE, ARG: TYPE): RET';
  const embedder = mapEmbedder({
    [skelConformer]: [1, 0, 0], // matches pool -> conforms
    [skelOutlier]: [0, 0, 1],   // orthogonal -> outlier
  });
  const res = await judgeFunctions([conformer, outlier], {
    store: fakeStore({ [CAT]: pool }),
    embedder,
    runner: runnerUp,
  });
  assert.ok(!isUnavailable(res));
  assert.equal(res[0].verdict, 'outlier', 'outlier leads');
  assert.equal(res[1].verdict, 'conforms');
});
