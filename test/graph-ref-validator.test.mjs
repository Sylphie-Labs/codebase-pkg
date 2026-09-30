/**
 * Tests for the graphRefs-at-record-time validator (dist/mcp-server/tools/
 * graph-ref-validator.js), MCP-SERVER-IMPROVEMENTS.md #4.
 *
 * PURE logic only -- runQuery is injected, so no live Neo4j. Covers: null on
 * empty/undefined refs, resolved/unresolved split via a fake Cypher runner,
 * and the WARN-NEVER-THROW contract when the injected runQuery rejects
 * (simulating an unreachable Neo4j).
 *
 * Run after `npm run build`:
 *   node --test test/graph-ref-validator.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateGraphRefs,
  formatGraphRefReport,
  expandNearRefs,
} from '../dist/mcp-server/tools/graph-ref-validator.js';

/** A fake neo4j-driver Record: only `.get(field)` is used by this module. */
function fakeRecord(obj) {
  return { get: (field) => obj[field] };
}

test('validateGraphRefs returns null for undefined/empty refs without calling runQuery', async () => {
  let called = false;
  const runQuery = async () => { called = true; return []; };

  assert.equal(await validateGraphRefs(undefined, runQuery), null);
  assert.equal(await validateGraphRefs([], runQuery), null);
  assert.equal(called, false);
});

test('validateGraphRefs splits refs into resolved/unresolved from the runQuery result', async () => {
  const refs = ['C:/repo/src/foo.ts::doThing', 'C:/repo/src/bar.ts::missingFn'];
  let seenItems;
  const runQuery = async (_cypher, params) => {
    seenItems = params.items;
    return [
      fakeRecord({ ref: 'C:/repo/src/foo.ts::doThing', found: true }),
      fakeRecord({ ref: 'C:/repo/src/bar.ts::missingFn', found: false }),
    ];
  };

  const result = await validateGraphRefs(refs, runQuery);
  assert.deepEqual(result, {
    resolved: ['C:/repo/src/foo.ts::doThing'],
    unresolved: ['C:/repo/src/bar.ts::missingFn'],
    skipped: false,
  });

  // splitNodeId splits on the LAST '::' -- verify the query was parameterized correctly.
  assert.deepEqual(seenItems, [
    { ref: 'C:/repo/src/foo.ts::doThing', filePath: 'C:/repo/src/foo.ts', name: 'doThing' },
    { ref: 'C:/repo/src/bar.ts::missingFn', filePath: 'C:/repo/src/bar.ts', name: 'missingFn' },
  ]);
});

test('validateGraphRefs treats a ref missing from the result set as unresolved', async () => {
  const runQuery = async () => []; // Neo4j returned zero rows for the UNWIND
  const result = await validateGraphRefs(['a.ts::f'], runQuery);
  assert.deepEqual(result, { resolved: [], unresolved: ['a.ts::f'], skipped: false });
});

test('validateGraphRefs NEVER throws -- an unreachable Neo4j is reported as skipped', async () => {
  const runQuery = async () => { throw new Error('Neo4j query failed: ECONNREFUSED'); };
  const result = await validateGraphRefs(['a.ts::f', 'b.ts::g'], runQuery);
  assert.equal(result.skipped, true);
  assert.match(result.skipReason, /ECONNREFUSED/);
  assert.deepEqual(result.unresolved, ['a.ts::f', 'b.ts::g']);
  assert.deepEqual(result.resolved, []);
});

// ---------------------------------------------------------------------------
// formatGraphRefReport
// ---------------------------------------------------------------------------

test('formatGraphRefReport: empty string when there is nothing to report', () => {
  assert.equal(formatGraphRefReport(null), '');
});

test('formatGraphRefReport: all resolved', () => {
  const text = formatGraphRefReport({ resolved: ['a', 'b'], unresolved: [], skipped: false });
  assert.equal(text, '2/2 graph ref(s) resolved.');
});

test('formatGraphRefReport: partial resolution names the unresolved refs', () => {
  const text = formatGraphRefReport({ resolved: ['a'], unresolved: ['b.ts::RemoteASRSourc'], skipped: false });
  assert.equal(text, '1/2 graph ref(s) resolved; unresolved: b.ts::RemoteASRSourc.');
});

test('formatGraphRefReport: skipped (Neo4j unreachable) names the reason', () => {
  const text = formatGraphRefReport({
    resolved: [],
    unresolved: ['a'],
    skipped: true,
    skipReason: 'Neo4j query failed: ECONNREFUSED',
  });
  assert.match(text, /graphRefs validation skipped/);
  assert.match(text, /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// expandNearRefs (#6, recallSimilar's nearRefs neighborhood expansion)
// ---------------------------------------------------------------------------

test('expandNearRefs returns null for undefined/empty refs without calling runQuery', async () => {
  let called = false;
  const runQuery = async () => { called = true; return []; };

  assert.equal(await expandNearRefs(undefined, runQuery), null);
  assert.equal(await expandNearRefs([], runQuery), null);
  assert.equal(called, false);
});

test('expandNearRefs always includes the given refs plus each neighbor id, deduped', async () => {
  const refs = ['C:/repo/src/foo.ts::doThing'];
  let seenItems;
  const runQuery = async (_cypher, params) => {
    seenItems = params.items;
    return [
      {
        get: (field) =>
          field === 'ref'
            ? 'C:/repo/src/foo.ts::doThing'
            : [
                { filePath: 'C:/repo/src/bar.ts', name: 'helperFn' },
                { filePath: 'C:/repo/src/foo.ts', name: 'doThing' }, // self-neighbor edge case, still deduped via the Set
              ],
      },
    ];
  };

  const result = await expandNearRefs(refs, runQuery);
  assert.equal(result.skipped, false);
  assert.deepEqual(
    new Set(result.expanded),
    new Set(['C:/repo/src/foo.ts::doThing', 'C:/repo/src/bar.ts::helperFn']),
  );
  assert.deepEqual(seenItems, [
    { ref: 'C:/repo/src/foo.ts::doThing', filePath: 'C:/repo/src/foo.ts', name: 'doThing' },
  ]);
});

test('expandNearRefs skips a neighbor with a null filePath/name (unresolved node)', async () => {
  const runQuery = async () => [
    { get: (field) => (field === 'ref' ? 'a.ts::f' : [{ filePath: null, name: null }]) },
  ];
  const result = await expandNearRefs(['a.ts::f'], runQuery);
  assert.deepEqual(result.expanded, ['a.ts::f']);
});

test('expandNearRefs NEVER throws -- an unreachable Neo4j falls back to the unexpanded refs', async () => {
  const runQuery = async () => { throw new Error('Neo4j query failed: ECONNREFUSED'); };
  const result = await expandNearRefs(['a.ts::f', 'b.ts::g'], runQuery);
  assert.equal(result.skipped, true);
  assert.match(result.skipReason, /ECONNREFUSED/);
  assert.deepEqual(result.expanded, ['a.ts::f', 'b.ts::g']);
});
