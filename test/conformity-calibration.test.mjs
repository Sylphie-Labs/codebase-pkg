/**
 * Tests for the Conformity Judge in-distribution threshold CALIBRATION (step R2,
 * dist/conformity/calibration.js) plus the store's calibration round-trip and
 * the judge's use of the calibrated threshold.
 *
 * PURE logic only -- NO live Postgres, NO embedding model. A fake PgRunner
 * records SQL + returns canned rows; deterministic vectors make the leave-one-out
 * kNN distance distribution exact.
 *
 * Run after `npm run build`:
 *   node --test test/conformity-calibration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  percentile,
  computeCalibration,
  ConformityStore,
  EMBEDDING_DIM,
  knnPoolDistance,
  DEFAULT_K,
} from '../dist/conformity/index.js';
import {
  judgeFunctions,
  isUnavailable,
} from '../dist/conformity/judge-worktree.js';
import { judgeChunk } from '../dist/conformity/judge.js';
import { FUNCTION_BODY, representationText } from '../dist/conformity/category.js';

// --------------------------------------------------------------------------
// percentile helper
// --------------------------------------------------------------------------

test('percentile: 0 and 1 are min/max', () => {
  const v = [3, 1, 2, 5, 4];
  assert.equal(percentile(v, 0), 1);
  assert.equal(percentile(v, 1), 5);
});

test('percentile: median (0.5) interpolates correctly', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5); // between idx1 (2) and idx2 (3)
  assert.equal(percentile([1, 2, 3], 0.5), 2); // exact middle
});

test('percentile: linear interpolation between ranks', () => {
  // n=5 -> rank = p*(n-1). p=0.95 -> rank=3.8 -> between idx3 (4) and idx4 (5).
  const v = [1, 2, 3, 4, 5];
  assert.ok(Math.abs(percentile(v, 0.95) - (4 + 0.8 * 1)) < 1e-12);
});

test('percentile: unsorted input is sorted internally', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0), 1);
  assert.equal(percentile([5, 1, 3, 2, 4], 1), 5);
});

test('percentile: single value is its own quantile for any p', () => {
  assert.equal(percentile([7], 0), 7);
  assert.equal(percentile([7], 0.5), 7);
  assert.equal(percentile([7], 1), 7);
});

test('percentile: clamps p out of [0,1]', () => {
  assert.equal(percentile([1, 2, 3], -1), 1);
  assert.equal(percentile([1, 2, 3], 2), 3);
});

test('percentile: empty input throws', () => {
  assert.throws(() => percentile([], 0.5), /empty/);
});

// --------------------------------------------------------------------------
// computeCalibration
// --------------------------------------------------------------------------

const CAT = FUNCTION_BODY;

/** Build a PoolEntry. */
function entry(identifier, vector, category = CAT) {
  return { identifier, vector, category };
}

test('computeCalibration: threshold = 95th pct of leave-one-out kNN distances', () => {
  // 6 entries, simple 2D vectors. We compute the expected distribution by hand
  // using the same knnPoolDistance the implementation uses, then assert the
  // threshold equals percentile(distances, 0.95).
  const pool = [
    entry('a', [1, 0]),
    entry('b', [0.99, 0.01]),
    entry('c', [0.98, 0.02]),
    entry('d', [0.9, 0.1]),
    entry('e', [0.5, 0.5]),
    entry('f', [0, 1]),
  ];

  const k = DEFAULT_K;
  const expectedDistances = pool.map((e) => {
    const peers = pool.filter((o) => o.identifier !== e.identifier);
    return knnPoolDistance(
      e.vector,
      peers.map((o) => o.vector),
      Math.max(1, Math.min(k, pool.length - 1)),
    );
  });
  const expectedThreshold = percentile(expectedDistances, 0.95);

  const rows = computeCalibration(pool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, CAT);
  assert.equal(rows[0].percentile, 0.95);
  assert.equal(rows[0].sampleSize, 6);
  assert.equal(rows[0].k, Math.min(k, 5)); // clamped to peers (5)
  assert.ok(
    Math.abs(rows[0].threshold - expectedThreshold) < 1e-12,
    `threshold ${rows[0].threshold} != expected ${expectedThreshold}`,
  );
});

test('computeCalibration: tiny pool clamps k and still produces a threshold', () => {
  // Only 2 entries: each has exactly 1 peer, so k clamps to 1.
  const pool = [entry('a', [1, 0]), entry('b', [0, 1])];
  const rows = computeCalibration(pool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sampleSize, 2);
  assert.equal(rows[0].k, 1, 'k clamped to peer count (1)');
  // Both leave-one-out distances are cosineDistance([1,0],[0,1]) == 1.
  assert.ok(Math.abs(rows[0].threshold - 1) < 1e-9);
});

test('computeCalibration: single-entry pool yields threshold 0 and sampleSize 1', () => {
  const rows = computeCalibration([entry('only', [1, 0])]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sampleSize, 1);
  assert.equal(rows[0].threshold, 0, 'no peers -> degenerate zero distance');
});

test('computeCalibration: multiple categories handled independently', () => {
  const pool = [
    entry('a', [1, 0], 'cat-x'),
    entry('b', [1, 0], 'cat-x'),
    entry('c', [1, 0], 'cat-y'),
    entry('d', [0, 1], 'cat-y'),
  ];
  const rows = computeCalibration(pool);
  assert.equal(rows.length, 2);
  const byCat = Object.fromEntries(rows.map((r) => [r.category, r]));
  // cat-x: identical vectors -> distance 0.
  assert.ok(Math.abs(byCat['cat-x'].threshold - 0) < 1e-9);
  assert.equal(byCat['cat-x'].sampleSize, 2);
  // cat-y: orthogonal vectors -> distance 1.
  assert.ok(Math.abs(byCat['cat-y'].threshold - 1) < 1e-9);
  assert.equal(byCat['cat-y'].sampleSize, 2);
});

test('computeCalibration: custom percentile is honored', () => {
  const pool = [
    entry('a', [1, 0]),
    entry('b', [1, 0]),
    entry('c', [1, 0]),
  ];
  const rows = computeCalibration(pool, { percentile: 0.5 });
  assert.equal(rows[0].percentile, 0.5);
});

test('computeCalibration: empty input yields no rows', () => {
  assert.deepEqual(computeCalibration([]), []);
});

// --------------------------------------------------------------------------
// store setCalibration / getCalibration round-trip + cache + invalidation
// --------------------------------------------------------------------------

function vec(val) {
  return new Array(EMBEDDING_DIM).fill(val);
}

/** A PgRunner fake recording calls and returning rows from a responder. */
function makeFakeRunner(responder) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const rows = responder ? responder(text, params) : [];
      return { rows: rows ?? [] };
    },
  };
}

test('setCalibration emits an ON CONFLICT upsert with correct params', async () => {
  const runner = makeFakeRunner();
  const store = new ConformityStore(runner);

  await store.setCalibration([
    { category: 'cat-x', threshold: 0.12, percentile: 0.95, k: 5, sampleSize: 40, model: 'jina' },
    { category: 'cat-y', threshold: 0.03, percentile: 0.95, k: 3, sampleSize: 4, model: 'jina' },
  ]);

  assert.equal(runner.calls.length, 1);
  const { text, params } = runner.calls[0];
  assert.match(text, /INSERT INTO cfm_calibration/);
  assert.match(text, /ON CONFLICT \(category\) DO UPDATE/);
  // 2 rows * 6 params each.
  assert.equal(params.length, 12);
  assert.equal(params[0], 'cat-x');
  assert.equal(params[1], 0.12);
  assert.equal(params[2], 0.95);
  assert.equal(params[3], 5);
  assert.equal(params[4], 40);
  assert.equal(params[5], 'jina');
});

test('setCalibration with no rows is a no-op (no SQL)', async () => {
  const runner = makeFakeRunner();
  const store = new ConformityStore(runner);
  await store.setCalibration([]);
  assert.equal(runner.calls.length, 0);
});

test('getCalibration parses a row and caches it (one SELECT for repeats)', async () => {
  const runner = makeFakeRunner((text) => {
    if (/FROM cfm_calibration/.test(text)) {
      return [{ threshold: '0.12', percentile: '0.95', k: '5', sample_size: '40', model: 'jina' }];
    }
    return [];
  });
  const store = new ConformityStore(runner);

  const first = await store.getCalibration('cat-x');
  const second = await store.getCalibration('cat-x');

  assert.deepEqual(first, {
    threshold: 0.12,
    percentile: 0.95,
    k: 5,
    sampleSize: 40,
    model: 'jina',
  });
  assert.deepEqual(second, first);
  const selects = runner.calls.filter((c) => /FROM cfm_calibration/.test(c.text));
  assert.equal(selects.length, 1, 'second call served from cache');
});

test('getCalibration: missing row returns null and caches the null', async () => {
  const runner = makeFakeRunner(() => []); // no rows
  const store = new ConformityStore(runner);

  const a = await store.getCalibration('nope');
  const b = await store.getCalibration('nope');
  assert.equal(a, null);
  assert.equal(b, null);
  const selects = runner.calls.filter((c) => /FROM cfm_calibration/.test(c.text));
  assert.equal(selects.length, 1, 'cached "no row" -> no second SELECT');
});

test('setCalibration invalidates the per-category calibration cache', async () => {
  let threshold = 0.1;
  const runner = makeFakeRunner((text) => {
    if (/FROM cfm_calibration/.test(text)) {
      return [{ threshold, percentile: 0.95, k: 5, sample_size: 10, model: 'm' }];
    }
    return [];
  });
  const store = new ConformityStore(runner);

  const before = await store.getCalibration('cat-x'); // SELECT #1, caches 0.1
  assert.equal(before.threshold, 0.1);

  threshold = 0.2; // pretend the row changed
  await store.setCalibration([
    { category: 'cat-x', threshold: 0.2, percentile: 0.95, k: 5, sampleSize: 10, model: 'm' },
  ]); // invalidates cat-x

  const after = await store.getCalibration('cat-x'); // SELECT #2, fresh value
  assert.equal(after.threshold, 0.2);

  const selects = runner.calls.filter((c) => /FROM cfm_calibration/.test(c.text));
  assert.equal(selects.length, 2);
});

test('clearHotCache also clears the calibration cache', async () => {
  const runner = makeFakeRunner((text) => {
    if (/FROM cfm_calibration/.test(text)) {
      return [{ threshold: 0.1, percentile: 0.95, k: 5, sample_size: 10, model: 'm' }];
    }
    return [];
  });
  const store = new ConformityStore(runner);

  await store.getCalibration('cat-x'); // SELECT #1
  store.clearHotCache();
  await store.getCalibration('cat-x'); // SELECT #2
  const selects = runner.calls.filter((c) => /FROM cfm_calibration/.test(c.text));
  assert.equal(selects.length, 2);
});

// --------------------------------------------------------------------------
// judge uses the calibrated threshold (and flags uncalibrated fallback)
// --------------------------------------------------------------------------

const BODY_SRC = '{ return a + b; }';
const BODY = representationText({ bodyText: BODY_SRC });

function mapEmbedder(map, fallback = [0, 0, 1]) {
  return async (texts) => texts.map((t) => map[t] ?? fallback);
}

/** A fake store: fixed pool + a fixed calibration row per category. */
function fakeStore(poolByCategory, calibrationByCategory = {}) {
  return {
    async loadPool(category) {
      return poolByCategory[category] ?? [];
    },
    async getCalibration(category) {
      return calibrationByCategory[category] ?? null;
    },
  };
}

const runnerUp = { async query() { return { rows: [] }; } };

function fn(name, filePath, bodyText = BODY_SRC) {
  return {
    name,
    filePath,
    lineNumber: 1,
    endLine: 1,
    args: [{ name: 'a', type: 'number', hasDefault: false }],
    returnType: 'number',
    jsDoc: '',
    bodyText,
    isExported: true,
    isAsync: false,
    decorators: [],
    callees: [],
    typeRefs: [],
    contentHash: name,
  };
}

test('judge: verdict flips around the calibrated threshold', async () => {
  // Pool entries sit near [1,0,0]; the judged function lands at distance ~0.2
  // from them. We set a calibrated threshold of 0.1 -> outlier; then 0.5 ->
  // conforms. Distance is controlled by the embedded vector direction.
  const pool = [
    { category: CAT, identifier: 'a.ts::a', vector: [1, 0, 0] },
    { category: CAT, identifier: 'b.ts::b', vector: [1, 0, 0] },
  ];
  // vector at a known cosine distance from [1,0,0].
  const judged = [0.9, 0.4359, 0]; // cosine distance ~0.106
  const embedder = mapEmbedder({ [BODY]: judged });

  const f = fn('q', 'work.ts');

  const tight = await judgeFunctions([f], {
    store: fakeStore({ [CAT]: pool }, { [CAT]: { threshold: 0.05, percentile: 0.95, k: 5, sampleSize: 2, model: 'm' } }),
    embedder,
    runner: runnerUp,
  });
  assert.ok(!isUnavailable(tight));
  assert.equal(tight[0].verdict, 'outlier');
  assert.equal(tight[0].calibrated, true);
  assert.equal(tight[0].threshold, 0.05);

  const loose = await judgeFunctions([f], {
    store: fakeStore({ [CAT]: pool }, { [CAT]: { threshold: 0.5, percentile: 0.95, k: 5, sampleSize: 2, model: 'm' } }),
    embedder,
    runner: runnerUp,
  });
  assert.equal(loose[0].verdict, 'conforms');
  assert.equal(loose[0].calibrated, true);
  assert.equal(loose[0].threshold, 0.5);
});

test('judge: no calibration row -> fallback threshold + calibrated:false', async () => {
  const pool = [
    { category: CAT, identifier: 'a.ts::a', vector: [1, 0, 0] },
    { category: CAT, identifier: 'b.ts::b', vector: [1, 0, 0] },
  ];
  const f = fn('q', 'work.ts');
  const res = await judgeFunctions([f], {
    store: fakeStore({ [CAT]: pool }, {}), // no calibration
    embedder: mapEmbedder({ [BODY]: [1, 0, 0] }), // distance ~0 -> conforms under fallback
    runner: runnerUp,
  });
  assert.ok(!isUnavailable(res));
  assert.equal(res[0].calibrated, false);
  assert.equal(res[0].threshold, 0.1, 'fallback FALLBACK_OUTLIER_THRESHOLD');
  assert.equal(res[0].verdict, 'conforms');
});

test('judge: unjudged (no peers) has null threshold/calibrated', async () => {
  const f = fn('lonely', 'work.ts');
  const res = await judgeFunctions([f], {
    store: fakeStore({ [CAT]: [] }, {}),
    embedder: mapEmbedder({ [BODY]: [1, 0, 0] }),
    runner: runnerUp,
  });
  assert.equal(res[0].verdict, 'unjudged');
  assert.equal(res[0].threshold, null);
  assert.equal(res[0].calibrated, null);
});

test('judgeChunk: honors an explicit opts.threshold (and marks calibrated)', async () => {
  const pool = [
    { category: CAT, identifier: 'a', vector: [1, 0, 0] },
    { category: CAT, identifier: 'b', vector: [1, 0, 0] },
  ];
  const f = fn('q', 'work.ts');
  const embedder = mapEmbedder({ [BODY]: [0.9, 0.4359, 0] }); // distance ~0.106

  const outlier = await judgeChunk(f, pool, { embed: embedder, threshold: 0.05 });
  assert.equal(outlier.verdict, 'outlier');
  assert.equal(outlier.threshold, 0.05);
  assert.equal(outlier.calibrated, true);

  const conforms = await judgeChunk(f, pool, { embed: embedder, threshold: 0.5 });
  assert.equal(conforms.verdict, 'conforms');
});

test('judgeChunk: defaults to the fallback threshold when none given', async () => {
  const pool = [
    { category: CAT, identifier: 'a', vector: [1, 0, 0] },
    { category: CAT, identifier: 'b', vector: [1, 0, 0] },
  ];
  const f = fn('q', 'work.ts');
  const j = await judgeChunk(f, pool, { embed: mapEmbedder({ [BODY]: [1, 0, 0] }) });
  assert.equal(j.threshold, 0.1, 'fallback');
  assert.equal(j.calibrated, false);
  assert.equal(j.verdict, 'conforms');
});
