/**
 * Tests for the decision-facts data layer
 * (dist/conformity/decisions/decision-store.js).
 *
 * PURE logic only -- NO live Postgres. A fake PgRunner records every SQL string
 * + params and returns canned rows, so we assert on the SQL the store emits and
 * on hot-cache hit/miss/invalidation behavior without a database.
 *
 * Run after `npm run build`:
 *   node --test test/conformity-decision-store.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DecisionStore, createDecisionStore } from '../dist/conformity/index.js';

/** A PgRunner fake: records calls, returns rows from a responder. */
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

test('createDecisionStore returns a DecisionStore', () => {
  const store = createDecisionStore(makeFakeRunner());
  assert.ok(store instanceof DecisionStore);
});

test('upsertDecisions issues an ON CONFLICT (node_id, axis) upsert with 3 params/row', async () => {
  const runner = makeFakeRunner();
  const store = new DecisionStore(runner);

  await store.upsertDecisions([
    { nodeId: 'a.ts::f', axis: 'var_decl', value: 'const' },
    { nodeId: 'a.ts::f', axis: 'array_syntax', value: 'bracket' },
  ]);

  assert.equal(runner.calls.length, 1);
  const { text, params } = runner.calls[0];
  assert.match(text, /INSERT INTO cfm_decisions/);
  assert.match(text, /ON CONFLICT \(node_id, axis\) DO UPDATE/);
  assert.match(text, /value = EXCLUDED\.value/);
  // 2 rows * 3 params each.
  assert.equal(params.length, 6);
  assert.deepEqual(params.slice(0, 3), ['a.ts::f', 'var_decl', 'const']);
  assert.deepEqual(params.slice(3, 6), ['a.ts::f', 'array_syntax', 'bracket']);
});

test('upsertDecisions on an empty array is a no-op (no SQL)', async () => {
  const runner = makeFakeRunner();
  await new DecisionStore(runner).upsertDecisions([]);
  assert.equal(runner.calls.length, 0);
});

test('loadDistribution parses GROUP BY rows into a value->count Map', async () => {
  const runner = makeFakeRunner((text) => {
    if (/SELECT value, count\(\*\)/.test(text)) {
      return [
        { value: 'const', count: '42' }, // count may arrive as a string from pg
        { value: 'let', count: 7 },
      ];
    }
    return [];
  });
  const store = new DecisionStore(runner);

  const dist = await store.loadDistribution('var_decl');
  assert.ok(dist instanceof Map);
  assert.equal(dist.get('const'), 42);
  assert.equal(dist.get('let'), 7);
  // GROUP BY shape + axis param.
  const { text, params } = runner.calls[0];
  assert.match(text, /GROUP BY value/);
  assert.deepEqual(params, ['var_decl']);
});

test('loadDistribution: second call for same axis is served from cache', async () => {
  let queries = 0;
  const runner = makeFakeRunner((text) => {
    if (/SELECT value, count\(\*\)/.test(text)) {
      queries += 1;
      return [{ value: 'const', count: 1 }];
    }
    return [];
  });
  const store = new DecisionStore(runner);

  await store.loadDistribution('var_decl');
  await store.loadDistribution('var_decl');
  assert.equal(queries, 1); // one SELECT despite two loads
});

test('upsertDecisions invalidates the distribution cache', async () => {
  let queries = 0;
  const runner = makeFakeRunner((text) => {
    if (/SELECT value, count\(\*\)/.test(text)) {
      queries += 1;
      return [{ value: 'const', count: 1 }];
    }
    return [];
  });
  const store = new DecisionStore(runner);

  await store.loadDistribution('var_decl'); // SELECT #1
  await store.loadDistribution('var_decl'); // cached
  await store.upsertDecisions([{ nodeId: 'x', axis: 'var_decl', value: 'let' }]); // clears cache
  await store.loadDistribution('var_decl'); // SELECT #2

  assert.equal(queries, 2);
});

test('clearCache forces the next loadDistribution to re-query', async () => {
  let queries = 0;
  const runner = makeFakeRunner(() => {
    queries += 1;
    return [{ value: 'const', count: 1 }];
  });
  const store = new DecisionStore(runner);
  await store.loadDistribution('var_decl');
  store.clearCache();
  await store.loadDistribution('var_decl');
  assert.equal(queries, 2);
});

test('loadAllDistributions returns one Map per requested axis (dedup)', async () => {
  const runner = makeFakeRunner((_text, params) => {
    const axis = params[0];
    if (axis === 'var_decl') return [{ value: 'const', count: 3 }];
    if (axis === 'array_syntax') return [{ value: 'bracket', count: 5 }];
    return [];
  });
  const store = new DecisionStore(runner);

  const all = await store.loadAllDistributions(['var_decl', 'array_syntax', 'var_decl']);
  assert.deepEqual(Object.keys(all).sort(), ['array_syntax', 'var_decl']);
  assert.equal(all.var_decl.get('const'), 3);
  assert.equal(all.array_syntax.get('bracket'), 5);
});

test('loadOffTarget queries the migration backlog (value <> target) and returns node ids', async () => {
  const runner = makeFakeRunner((text) => {
    if (/value <> \$2/.test(text)) {
      return [{ node_id: 'a.ts::f' }, { node_id: 'b.ts::g' }];
    }
    return [];
  });
  const store = new DecisionStore(runner);

  const off = await store.loadOffTarget('array_syntax', 'generic');
  assert.deepEqual(off, ['a.ts::f', 'b.ts::g']);
  const { text, params } = runner.calls[0];
  assert.match(text, /WHERE axis = \$1 AND value <> \$2/);
  assert.deepEqual(params, ['array_syntax', 'generic']);
});
