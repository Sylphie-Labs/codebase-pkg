/**
 * Tests for the Conformity Judge vector data layer (dist/conformity/store.js).
 *
 * PURE logic only -- NO live Postgres, NO embedding model. A fake PgRunner
 * records every SQL string + params and returns canned rows, so we can assert
 * on the SQL the store emits and on hot-cache hit/miss behavior without a
 * database. Mirrors how the rest of the package keeps the DB out of tests.
 *
 * An OPTIONAL integration test runs ONLY if CODEBASE_PKG_PG_URI is set and the
 * server is reachable; otherwise it is skipped and never fails the suite.
 *
 * Run after `npm run build`:
 *   node --test test/conformity-store.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  ConformityStore,
  createConformityStore,
  nodeIdOf,
  EMBEDDING_DIM,
} from '../dist/conformity/index.js';

/** A PgRunner fake: records calls, returns rows from a queue or a responder. */
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

/** A valid-length vector filled with `val`. */
function vec(val) {
  return new Array(EMBEDDING_DIM).fill(val);
}

test('nodeIdOf formats as <canonicalPath>::name (absolute, forward slashes)', () => {
  const fn = { filePath: 'src/foo.ts', name: 'doThing' };
  const expected = `${path.resolve('src/foo.ts').replace(/\\/g, '/')}::doThing`;
  assert.equal(nodeIdOf(fn), expected);
  // The id is absolute and uses forward slashes regardless of platform.
  assert.ok(path.isAbsolute(nodeIdOf(fn).split('::')[0]));
  assert.ok(!nodeIdOf(fn).includes('\\'));
});

test('nodeIdOf: a relative path and the equivalent absolute path yield the SAME id', () => {
  // The core bug: backfill parses absolute paths, the judge parses relative
  // ones. Both must canonicalize to one id so self-exclusion lines up.
  const rel = nodeIdOf({ filePath: 'src/conformity/distance.ts', name: 'dot' });
  const abs = nodeIdOf({
    filePath: path.resolve('src/conformity/distance.ts'),
    name: 'dot',
  });
  assert.equal(rel, abs);
});

test('nodeIdOf normalizes backslashes to forward slashes', () => {
  // A Windows-style absolute path with backslashes must produce the same id as
  // its forward-slash form (the stored ids use forward slashes).
  const abs = path.resolve('src/conformity/distance.ts');
  const back = abs.replace(/\//g, '\\'); // force backslashes
  const id = nodeIdOf({ filePath: back, name: 'dot' });
  assert.ok(!id.includes('\\'), 'no backslashes survive in the canonical id');
  assert.equal(id, nodeIdOf({ filePath: abs, name: 'dot' }));
});

test('nodeIdOf is idempotent on an already-canonical path', () => {
  // Re-canonicalizing a canonical id (absolute + forward slashes) is a no-op.
  const canonical = path.resolve('src/conformity/distance.ts').replace(/\\/g, '/');
  const once = nodeIdOf({ filePath: canonical, name: 'dot' });
  const twice = nodeIdOf({ filePath: once.split('::')[0], name: 'dot' });
  assert.equal(once, `${canonical}::dot`);
  assert.equal(once, twice);
});

test('upsertVectors issues an ON CONFLICT upsert with correct params', async () => {
  const runner = makeFakeRunner();
  const store = new ConformityStore(runner);

  await store.upsertVectors([
    { nodeId: 'a.ts::f', category: 'function:signature-skeleton', vector: vec(0.1), model: 'm1' },
    { nodeId: 'b.ts::g', category: 'function:signature-skeleton', vector: vec(0.2), model: 'm1' },
  ]);

  assert.equal(runner.calls.length, 1);
  const { text, params } = runner.calls[0];
  assert.match(text, /INSERT INTO cfm_vectors/);
  assert.match(text, /ON CONFLICT \(node_id\) DO UPDATE/);
  // 2 rows * 4 params each.
  assert.equal(params.length, 8);
  assert.equal(params[0], 'a.ts::f');
  assert.equal(params[1], 'function:signature-skeleton');
  // pgvector text literal form.
  assert.match(params[2], /^\[0\.1(,0\.1)*\]$/);
  assert.equal(params[3], 'm1');
});

test('upsertVectors rejects wrong-dimension vectors', async () => {
  const runner = makeFakeRunner();
  const store = new ConformityStore(runner);

  await assert.rejects(
    () =>
      store.upsertVectors([
        { nodeId: 'bad', category: 'c', vector: [1, 2, 3], model: 'm' },
      ]),
    /length 3, expected 768/,
  );
  // Nothing should have been sent to the DB.
  assert.equal(runner.calls.length, 0);

  // A correct EMBEDDING_DIM-length (768) vector is accepted and reaches the DB.
  assert.equal(EMBEDDING_DIM, 768);
  await store.upsertVectors([
    { nodeId: 'ok', category: 'c', vector: vec(0.3), model: 'm' },
  ]);
  assert.equal(runner.calls.length, 1);
});

test('loadPool: first call hits runner, second is served from cache', async () => {
  const runner = makeFakeRunner((text) => {
    if (/SELECT node_id, embedding/.test(text)) {
      return [{ node_id: 'a.ts::f', embedding: '[0.1,0.2,0.3]' }];
    }
    return [];
  });
  const store = new ConformityStore(runner);

  const first = await store.loadPool('cat-x');
  const second = await store.loadPool('cat-x');

  // Only ONE SELECT despite two loadPool calls.
  const selects = runner.calls.filter((c) => /SELECT node_id, embedding/.test(c.text));
  assert.equal(selects.length, 1);
  assert.deepEqual(second, first);
});

test('loadPool parses pgvector text into PoolEntry with number[] and identifier', async () => {
  const runner = makeFakeRunner(() => [
    { node_id: 'a.ts::f', embedding: '[0.1,0.2,0.3]' },
    { node_id: 'b.ts::g', embedding: '[ -1, 0, 2.5 ]' },
  ]);
  const store = new ConformityStore(runner);

  const pool = await store.loadPool('function:signature-skeleton');

  assert.equal(pool.length, 2);
  assert.equal(pool[0].identifier, 'a.ts::f');
  assert.equal(pool[0].category, 'function:signature-skeleton');
  assert.deepEqual(pool[0].vector, [0.1, 0.2, 0.3]);
  assert.ok(pool[0].vector.every((n) => typeof n === 'number'));
  assert.deepEqual(pool[1].vector, [-1, 0, 2.5]);
});

test('upsertVectors invalidates the cache for the touched category', async () => {
  const runner = makeFakeRunner((text) => {
    if (/SELECT node_id, embedding/.test(text)) {
      return [{ node_id: 'a.ts::f', embedding: '[0.1,0.2,0.3]' }];
    }
    return [];
  });
  const store = new ConformityStore(runner);

  await store.loadPool('cat-x'); // SELECT #1, caches cat-x
  await store.loadPool('cat-x'); // cached, no SELECT
  await store.upsertVectors([
    { nodeId: 'new', category: 'cat-x', vector: vec(0.5), model: 'm' },
  ]); // invalidates cat-x
  await store.loadPool('cat-x'); // SELECT #2

  const selects = runner.calls.filter((c) => /SELECT node_id, embedding/.test(c.text));
  assert.equal(selects.length, 2);
});

test('upsert invalidating one category leaves another category cached', async () => {
  const runner = makeFakeRunner(() => [{ node_id: 'x', embedding: '[0.1,0.2,0.3]' }]);
  const store = new ConformityStore(runner);

  await store.loadPool('cat-a'); // SELECT
  await store.loadPool('cat-b'); // SELECT
  await store.upsertVectors([
    { nodeId: 'n', category: 'cat-a', vector: vec(0.5), model: 'm' },
  ]); // invalidates cat-a only
  await store.loadPool('cat-a'); // SELECT again
  await store.loadPool('cat-b'); // still cached, no SELECT

  const selects = runner.calls.filter((c) => /SELECT node_id, embedding/.test(c.text));
  assert.equal(selects.length, 3); // a, b, a-again
});

test('deleteVectors issues a DELETE and clears the whole hot cache', async () => {
  const runner = makeFakeRunner((text) => {
    if (/SELECT node_id, embedding/.test(text)) {
      return [{ node_id: 'a', embedding: '[0.1,0.2,0.3]' }];
    }
    return [];
  });
  const store = new ConformityStore(runner);

  await store.loadPool('cat-a'); // SELECT #1
  await store.deleteVectors(['a', 'b']); // clears cache
  await store.loadPool('cat-a'); // SELECT #2

  const del = runner.calls.find((c) => /DELETE FROM cfm_vectors/.test(c.text));
  assert.ok(del);
  assert.deepEqual(del.params, [['a', 'b']]);

  const selects = runner.calls.filter((c) => /SELECT node_id, embedding/.test(c.text));
  assert.equal(selects.length, 2);
});

test('coldNearest emits the cosine <=> query and parses distances', async () => {
  const runner = makeFakeRunner((text) => {
    if (/<=>/.test(text)) {
      return [
        { node_id: 'a', distance: 0.05 },
        { node_id: 'b', distance: '0.42' }, // pg may return numeric as string
      ];
    }
    return [];
  });
  const store = new ConformityStore(runner);

  const hits = await store.coldNearest('cat-x', vec(0.1), 2);

  const q = runner.calls[0];
  assert.match(q.text, /embedding <=> \$1 AS distance/);
  assert.match(q.text, /ORDER BY embedding <=> \$1 LIMIT \$3/);
  assert.match(q.params[0], /^\[/); // pgvector literal
  assert.equal(q.params[1], 'cat-x');
  assert.equal(q.params[2], 2);

  assert.deepEqual(hits, [
    { nodeId: 'a', distance: 0.05 },
    { nodeId: 'b', distance: 0.42 },
  ]);
});

test('coldNearest rejects wrong-dimension query vector', async () => {
  const runner = makeFakeRunner();
  const store = new ConformityStore(runner);
  await assert.rejects(() => store.coldNearest('c', [1, 2], 5), /expected 768/);
});

test('clearHotCache forces the next loadPool to re-read', async () => {
  const runner = makeFakeRunner(() => [{ node_id: 'a', embedding: '[0.1,0.2,0.3]' }]);
  const store = createConformityStore(runner);

  await store.loadPool('cat-x'); // SELECT #1
  store.clearHotCache();
  await store.loadPool('cat-x'); // SELECT #2

  const selects = runner.calls.filter((c) => /SELECT node_id, embedding/.test(c.text));
  assert.equal(selects.length, 2);
});

test('hot caches are isolated per store instance', async () => {
  const runner = makeFakeRunner(() => [{ node_id: 'a', embedding: '[0.1,0.2,0.3]' }]);
  const s1 = new ConformityStore(runner);
  const s2 = new ConformityStore(runner);

  await s1.loadPool('cat-x'); // SELECT #1 (s1 caches)
  await s2.loadPool('cat-x'); // SELECT #2 (s2 has its own cache)

  const selects = runner.calls.filter((c) => /SELECT node_id, embedding/.test(c.text));
  assert.equal(selects.length, 2);
});

// --- OPTIONAL integration test: only runs with a reachable Postgres ---------
test('integration: round-trip against a live Postgres', async (t) => {
  const uri = process.env.CODEBASE_PKG_PG_URI;
  if (!uri) {
    t.skip('CODEBASE_PKG_PG_URI not set');
    return;
  }

  let pg;
  let ensureSchema;
  let pool;
  try {
    pg = await import('pg');
    ({ ensureSchema } = await import('../dist/conformity/index.js'));
    pool = new pg.Pool({ connectionString: uri, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
  } catch (err) {
    if (pool) await pool.end().catch(() => {});
    t.skip(`Postgres unreachable: ${err.message}`);
    return;
  }

  try {
    const runner = { query: (text, params = []) => pool.query(text, params) };
    await ensureSchema(runner);

    const store = new ConformityStore(runner);
    const cat = 'function:signature-skeleton';
    const v1 = vec(0.1);
    const v2 = vec(0.2);

    await store.upsertVectors([
      { nodeId: 'itest::a', category: cat, vector: v1, model: 'itest' },
      { nodeId: 'itest::b', category: cat, vector: v2, model: 'itest' },
    ]);

    const pool1 = await store.loadPool(cat);
    assert.ok(pool1.find((p) => p.identifier === 'itest::a'));
    assert.equal(pool1.find((p) => p.identifier === 'itest::a').vector.length, EMBEDDING_DIM);

    const near = await store.coldNearest(cat, v1, 1);
    assert.equal(near[0].nodeId, 'itest::a');
    assert.ok(near[0].distance < 0.01);

    await store.deleteVectors(['itest::a', 'itest::b']);
  } finally {
    await pool.query(`DELETE FROM cfm_vectors WHERE model = 'itest'`).catch(() => {});
    await pool.end().catch(() => {});
  }
});
