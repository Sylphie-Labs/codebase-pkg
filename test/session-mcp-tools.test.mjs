/**
 * Tests for the session-capture MCP tool handlers
 * (dist/mcp-server/tools/{recordSession,recordDecision,recordLearning,
 * recallSimilar,resolveCaveat,getRecallItem,getSession,searchSemantic}.js).
 *
 * PURE logic only -- NO live Postgres, NO model, NO live Neo4j (runQuery is
 * injected via `deps.runQuery` for the graphRefs-validation / nearRefs-
 * expansion paths, #4/#6), and the handlers are never exercised through the
 * actual MCP server (dist/mcp-server/index.js calls `main()` -- connecting a
 * stdio transport -- as an import-time side effect, so it is never imported
 * by tests; see test/conformity-store.test.mjs and friends for the same
 * reasoning re: not touching live infra).
 *
 * Each handler accepts an optional `deps` argument (`{ store, runQuery }`)
 * purely for this kind of injection -- production (mcp-server/index.js)
 * always calls handlers with just the input, so the real store/runQuery is
 * constructed via createSessionStore()/the real neo4j-client singleton.
 *
 * Covers: arg validation (each handler's own pre-store checks), the error
 * path (a throwing store/embedder/runner propagates a truthful message
 * rather than being swallowed -- this is exactly what the dispatcher's
 * catch-all in mcp-server/index.js relies on to report isError), the
 * advisory lines each record* tool appends (secret-redaction #2, near-
 * duplicate #3, graphRefs resolution #4), and the read-side improvements:
 * hybrid ranking + nearRefs (#6), compact mode (#7), the `session=<id>`
 * header + getSession (#9), and `format: "json"` (#10).
 *
 * Run after `npm run build`:
 *   node --test test/session-mcp-tools.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRecordSession } from '../dist/mcp-server/tools/recordSession.js';
import { handleRecordDecision } from '../dist/mcp-server/tools/recordDecision.js';
import { handleRecordLearning } from '../dist/mcp-server/tools/recordLearning.js';
import { handleRecallSimilar } from '../dist/mcp-server/tools/recallSimilar.js';
import { handleResolveCaveat } from '../dist/mcp-server/tools/resolveCaveat.js';
import { handleGetRecallItem } from '../dist/mcp-server/tools/getRecallItem.js';
import { handleGetSession } from '../dist/mcp-server/tools/getSession.js';
import {
  handleSearchSemantic,
  searchSemanticCode,
  splitNodeId,
} from '../dist/mcp-server/tools/searchSemantic.js';
import { EMBEDDING_DIM } from '../dist/session/schema.js';

/** A fake neo4j-driver Record: only `.get(field)` is used by graph-ref-validator.js. */
function fakeNeo4jRecord(obj) {
  return { get: (field) => obj[field] };
}

// ---------------------------------------------------------------------------
// recordSession
// ---------------------------------------------------------------------------

test('handleRecordSession: rejects missing query/summary WITHOUT calling the store', async () => {
  let called = false;
  const store = { async recordEvent() { called = true; return { id: 1 }; } };

  await assert.rejects(() => handleRecordSession({ summary: 'x' }, { store }), /"query" is required/);
  await assert.rejects(() => handleRecordSession({ query: 'x' }, { store }), /"summary" is required/);
  assert.equal(called, false);
});

test('handleRecordSession: happy path returns the new id', async () => {
  const store = { async recordEvent(input) {
    assert.equal(input.query, 'q');
    assert.equal(input.summary, 's');
    return { id: 42 };
  } };
  const text = await handleRecordSession({ query: 'q', summary: 's' }, { store });
  assert.equal(text, 'Recorded session event #42.');
});

test('handleRecordSession: error path propagates a truthful message', async () => {
  const store = { async recordEvent() { throw new Error('Postgres query failed: ECONNREFUSED'); } };
  await assert.rejects(
    () => handleRecordSession({ query: 'q', summary: 's' }, { store }),
    /ECONNREFUSED/,
  );
});

test('handleRecordSession: reports an update (not a fresh record) when the store upserted by sessionId (#8)', async () => {
  const store = { async recordEvent() { return { id: 7, updated: true }; } };
  const text = await handleRecordSession({ query: 'q', summary: 's', sessionId: 'sess-1' }, { store });
  assert.equal(text, 'Updated session event #7 (appended a new segment to the existing sessionId).');
});

test('handleRecordSession: surfaces a redaction notice from the store (#2)', async () => {
  const store = { async recordEvent() { return { id: 8, redaction: { findings: ['url-password'] } }; } };
  const text = await handleRecordSession({ query: 'q', summary: 's' }, { store });
  assert.match(text, /Recorded session event #8\./);
  assert.match(text, /Redacted 1 potential secret pattern\(s\) before recording: url-password\./);
});

test('handleRecordSession: reports graphRefs resolution against Neo4j (#4), never throwing on a Neo4j failure', async () => {
  const store = { async recordEvent() { return { id: 9 }; } };
  const runQuery = async () => [
    fakeNeo4jRecord({ ref: 'a.ts::f', found: true }),
    fakeNeo4jRecord({ ref: 'b.ts::missing', found: false }),
  ];
  const text = await handleRecordSession(
    { query: 'q', summary: 's', graphRefs: ['a.ts::f', 'b.ts::missing'] },
    { store, runQuery },
  );
  assert.match(text, /1\/2 graph ref\(s\) resolved; unresolved: b\.ts::missing\./);
});

test('handleRecordSession: an unreachable Neo4j during graphRefs validation does NOT fail the tool call', async () => {
  const store = { async recordEvent() { return { id: 10 }; } };
  const runQuery = async () => { throw new Error('Neo4j query failed: ECONNREFUSED'); };
  const text = await handleRecordSession(
    { query: 'q', summary: 's', graphRefs: ['a.ts::f'] },
    { store, runQuery },
  );
  assert.match(text, /Recorded session event #10\./);
  assert.match(text, /graphRefs validation skipped \(Neo4j unreachable/);
});

// ---------------------------------------------------------------------------
// recordDecision
// ---------------------------------------------------------------------------

test('handleRecordDecision: rejects missing decision and non-integer supersedesId', async () => {
  const store = { async recordDecision() { return { id: 1 }; } };
  await assert.rejects(() => handleRecordDecision({ decision: '  ' }, { store }), /"decision" is required/);
  await assert.rejects(
    () => handleRecordDecision({ decision: 'x', supersedesId: 1.5 }, { store }),
    /"supersedesId" must be an integer/,
  );
});

test('handleRecordDecision: plain message when no supersedesId', async () => {
  const store = { async recordDecision() { return { id: 5 }; } };
  const text = await handleRecordDecision({ decision: 'use pgvector' }, { store });
  assert.equal(text, 'Recorded decision #5.');
});

test('handleRecordDecision: mentions the superseded id when supersedesId is given', async () => {
  const store = { async recordDecision(input) {
    assert.equal(input.supersedesId, 12);
    return { id: 42 };
  } };
  const text = await handleRecordDecision({ decision: 'use pgvector', supersedesId: 12 }, { store });
  assert.equal(text, 'Recorded decision #42 (supersedes #12, now marked superseded).');
});

test('handleRecordDecision: error path propagates a truthful message', async () => {
  const store = { async recordDecision() { throw new Error('embedder: model failed to load'); } };
  await assert.rejects(
    () => handleRecordDecision({ decision: 'x' }, { store }),
    /model failed to load/,
  );
});

test('handleRecordDecision: surfaces a near-duplicate advisory naming supersedesId as the fix (#3)', async () => {
  const store = {
    async recordDecision() {
      return { id: 5, nearDuplicate: { id: 2, similarity: 0.9123 } };
    },
  };
  const text = await handleRecordDecision({ decision: 'use pgvector' }, { store });
  assert.match(text, /Recorded decision #5\./);
  assert.match(text, /similar to existing decision #2 \(similarity 0\.91\)/);
  assert.match(text, /supersedesId: 2/);
});

test('handleRecordDecision: surfaces a redaction notice (#2)', async () => {
  const store = { async recordDecision() { return { id: 6, redaction: { findings: ['aws-access-key'] } }; } };
  const text = await handleRecordDecision({ decision: 'x' }, { store });
  assert.match(text, /Redacted 1 potential secret pattern\(s\) before recording: aws-access-key\./);
});

test('handleRecordDecision: reports graphRefs resolution (#4)', async () => {
  const store = { async recordDecision() { return { id: 7 }; } };
  const runQuery = async () => [fakeNeo4jRecord({ ref: 'a.ts::f', found: true })];
  const text = await handleRecordDecision({ decision: 'x', graphRefs: ['a.ts::f'] }, { store, runQuery });
  assert.match(text, /1\/1 graph ref\(s\) resolved\./);
});

// ---------------------------------------------------------------------------
// recordLearning
// ---------------------------------------------------------------------------

test('handleRecordLearning: rejects empty content and an invalid kind', async () => {
  const store = { async recordLearning() { return { id: 1 }; } };
  await assert.rejects(() => handleRecordLearning({ content: '' }, { store }), /"content" is required/);
  await assert.rejects(
    () => handleRecordLearning({ content: 'x', kind: 'bogus' }, { store }),
    /"kind" must be one of/,
  );
});

test('handleRecordLearning: accepts each valid kind and echoes it in the message', async () => {
  const store = { async recordLearning() { return { id: 3 }; } };
  for (const kind of ['gotcha', 'pattern', 'fact']) {
    const text = await handleRecordLearning({ content: 'x', kind }, { store });
    assert.equal(text, `Recorded learning #3 [${kind}].`);
  }
});

test('handleRecordLearning: error path propagates a truthful message', async () => {
  const store = { async recordLearning() { throw new Error('DB down'); } };
  await assert.rejects(() => handleRecordLearning({ content: 'x' }, { store }), /DB down/);
});

test('handleRecordLearning: rejects a non-integer supersedesId', async () => {
  const store = { async recordLearning() { return { id: 1 }; } };
  await assert.rejects(
    () => handleRecordLearning({ content: 'x', supersedesId: 1.5 }, { store }),
    /"supersedesId" must be an integer/,
  );
});

test('handleRecordLearning: mentions the superseded id when supersedesId is given (#1)', async () => {
  const store = {
    async recordLearning(input) {
      assert.equal(input.supersedesId, 9);
      return { id: 10 };
    },
  };
  const text = await handleRecordLearning({ content: 'corrected learning', supersedesId: 9 }, { store });
  assert.equal(text, 'Recorded learning #10 (supersedes #9, now marked superseded).');
});

test('handleRecordLearning: surfaces a near-duplicate advisory naming supersedesId as the fix (#3)', async () => {
  const store = {
    async recordLearning() {
      return { id: 4, nearDuplicate: { id: 9, similarity: 0.91 } };
    },
  };
  const text = await handleRecordLearning({ content: 'x' }, { store });
  assert.match(text, /looks like existing learning #9 \(similarity 0\.91\)/);
  assert.match(text, /supersedesId: 9/);
});

test('handleRecordLearning: surfaces a redaction notice (#2)', async () => {
  const store = { async recordLearning() { return { id: 4, redaction: { findings: ['jwt'] } }; } };
  const text = await handleRecordLearning({ content: 'x' }, { store });
  assert.match(text, /Redacted 1 potential secret pattern\(s\) before recording: jwt\./);
});

test('handleRecordLearning: reports graphRefs resolution (#4)', async () => {
  const store = { async recordLearning() { return { id: 4 }; } };
  const runQuery = async () => [fakeNeo4jRecord({ ref: 'a.ts::f', found: false })];
  const text = await handleRecordLearning({ content: 'x', graphRefs: ['a.ts::f'] }, { store, runQuery });
  assert.match(text, /0\/1 graph ref\(s\) resolved; unresolved: a\.ts::f\./);
});

// ---------------------------------------------------------------------------
// resolveCaveat
// ---------------------------------------------------------------------------

test('handleResolveCaveat: rejects missing/invalid eventId and caveatIndex WITHOUT calling the store', async () => {
  let called = false;
  const store = { async resolveCaveat() { called = true; return {}; } };

  await assert.rejects(
    () => handleResolveCaveat({ caveatIndex: 0 }, { store }),
    /"eventId" is required and must be an integer/,
  );
  await assert.rejects(
    () => handleResolveCaveat({ eventId: 1, caveatIndex: -1 }, { store }),
    /"caveatIndex" is required and must be a non-negative integer/,
  );
  assert.equal(called, false);
});

test('handleResolveCaveat: happy path renders the date and preserved original text', async () => {
  const store = {
    async resolveCaveat(input) {
      assert.equal(input.eventId, 7);
      assert.equal(input.caveatIndex, 0);
      assert.equal(input.note, 'restart happened');
      return { id: 7, caveatIndex: 0, caveatText: 'Jim owes a runtime restart', resolvedAt: '2026-08-07T12:00:00.000Z' };
    },
  };
  const text = await handleResolveCaveat({ eventId: 7, caveatIndex: 0, note: 'restart happened' }, { store });
  assert.match(text, /Resolved caveat #0 on event #7 \(2026-08-07\): restart happened\./);
  assert.match(text, /Original caveat text preserved \(not deleted\): "Jim owes a runtime restart"/);
});

test('handleResolveCaveat: renders without a trailing note when none was given', async () => {
  const store = {
    async resolveCaveat() {
      return { id: 7, caveatIndex: 1, caveatText: 'firewall rule pending', resolvedAt: '2026-08-07T00:00:00.000Z' };
    },
  };
  const text = await handleResolveCaveat({ eventId: 7, caveatIndex: 1 }, { store });
  assert.match(text, /Resolved caveat #1 on event #7 \(2026-08-07\)\.\n/);
});

test('handleResolveCaveat: error path propagates a truthful message (e.g. out-of-range index)', async () => {
  const store = {
    async resolveCaveat() {
      throw new Error('resolveCaveat: event #7 has 1 caveat(s); caveatIndex 3 is out of range');
    },
  };
  await assert.rejects(
    () => handleResolveCaveat({ eventId: 7, caveatIndex: 3 }, { store }),
    /caveatIndex 3 is out of range/,
  );
});

// ---------------------------------------------------------------------------
// recallSimilar
// ---------------------------------------------------------------------------

test('handleRecallSimilar: rejects empty query and an invalid kinds entry', async () => {
  const store = { async recallSimilar() { return []; } };
  await assert.rejects(() => handleRecallSimilar({ query: '  ' }, { store }), /"query" is required/);
  await assert.rejects(
    () => handleRecallSimilar({ query: 'q', kinds: ['bogus'] }, { store }),
    /invalid kind "bogus"/,
  );
  await assert.rejects(
    () => handleRecallSimilar({ query: 'q', kinds: [] }, { store }),
    /non-empty array/,
  );
});

test('handleRecallSimilar: no-match message when the store returns nothing', async () => {
  const store = { async recallSimilar() { return []; } };
  const text = await handleRecallSimilar({ query: 'nothing like this' }, { store });
  assert.match(text, /No matching events, decisions, or learnings found\./);
});

test('handleRecallSimilar: renders each kind with its distinguishing fields', async () => {
  const store = {
    async recallSimilar() {
      return [
        {
          kind: 'event', id: 1, createdAt: 't', sessionId: 's', repo: 'r',
          query: 'q', summary: 'sum', caveats: ['careful'], meta: {}, graphRefs: [], model: 'm',
          similarity: 0.9,
        },
        {
          kind: 'decision', id: 2, createdAt: 't', sessionId: 's', decision: 'use X',
          insteadOf: 'Y', context: 'ctx', scope: 'scope', status: 'superseded', supersededBy: 9,
          meta: {}, graphRefs: ['a.ts::f'], similarity: 0.8,
        },
        {
          kind: 'learning', id: 3, createdAt: 't', sessionId: 's', learningKind: 'gotcha',
          content: 'watch out', meta: {}, graphRefs: [], similarity: 0.7,
        },
      ];
    },
  };
  const text = await handleRecallSimilar({ query: 'x' }, { store });
  assert.match(text, /\[event\].*similarity=0\.9000/);
  assert.match(text, /Query:\s+q/);
  assert.match(text, /Summary:\s+sum/);
  assert.match(text, /Caveats: careful/);
  assert.match(text, /\[decision\].*similarity=0\.8000/);
  assert.match(text, /Decision: use X/);
  assert.match(text, /Instead of: Y/);
  assert.match(text, /superseded \(superseded by #9\)/);
  assert.match(text, /Graph refs: a\.ts::f/);
  assert.match(text, /\[learning\].*similarity=0\.7000/);
  assert.match(text, /\[gotcha\] watch out/);
});

test('handleRecallSimilar: renders a resolved caveat with its date/note annotation, unresolved ones plain (#5)', async () => {
  const store = {
    async recallSimilar() {
      return [
        {
          kind: 'event', id: 1, createdAt: 't', sessionId: 's', repo: null,
          query: 'q', summary: 'sum',
          caveats: ['Jim owes a runtime restart', 'firewall rule pending'],
          resolutions: [{ caveatIndex: 0, resolvedAt: '2026-08-07T00:00:00.000Z', note: 'restarted' }],
          meta: {}, graphRefs: [], model: null,
          similarity: 0.9,
        },
      ];
    },
  };
  const text = await handleRecallSimilar({ query: 'x' }, { store });
  assert.match(
    text,
    /Caveats: Jim owes a runtime restart \[resolved 2026-08-07: restarted\]; firewall rule pending/,
  );
});

test('handleRecallSimilar: renders a superseded learning\'s status/supersededBy (#1)', async () => {
  const store = {
    async recallSimilar() {
      return [
        {
          kind: 'learning', id: 3, createdAt: 't', sessionId: 's', learningKind: 'gotcha',
          content: 'watch out', status: 'superseded', supersededBy: 11, meta: {}, graphRefs: [],
          similarity: 0.7,
        },
      ];
    },
  };
  const text = await handleRecallSimilar({ query: 'x' }, { store });
  assert.match(text, /\[gotcha\] watch out/);
  assert.match(text, /Status: superseded \(superseded by #11\)/);
});

test('handleRecallSimilar: does NOT render a Status line for an active learning', async () => {
  const store = {
    async recallSimilar() {
      return [
        {
          kind: 'learning', id: 3, createdAt: 't', sessionId: 's', learningKind: 'fact',
          content: 'x', status: 'active', supersededBy: null, meta: {}, graphRefs: [],
          similarity: 0.7,
        },
      ];
    },
  };
  const text = await handleRecallSimilar({ query: 'x' }, { store });
  assert.doesNotMatch(text, /Status:/);
});

test('handleRecallSimilar: passes kinds/k/includeSuperseded through to the store', async () => {
  let seen;
  const store = { async recallSimilar(opts) { seen = opts; return []; } };
  await handleRecallSimilar(
    { query: 'q', kinds: ['decision'], k: 3, includeSuperseded: true },
    { store },
  );
  assert.deepEqual(seen.kinds, ['decision']);
  assert.equal(seen.k, 3);
  assert.equal(seen.includeSuperseded, true);
});

test('handleRecallSimilar: error path propagates a truthful message', async () => {
  const store = { async recallSimilar() { throw new Error('Postgres unreachable'); } };
  await assert.rejects(() => handleRecallSimilar({ query: 'q' }, { store }), /Postgres unreachable/);
});

// ---------------------------------------------------------------------------
// recallSimilar -- #6 nearRefs, #7 compact, #9 session header, #10 json
// ---------------------------------------------------------------------------

test('handleRecallSimilar: renders `session=<id>` on the header (#9), and `session=none` when absent', async () => {
  const store = {
    async recallSimilar() {
      return [
        { kind: 'learning', id: 1, createdAt: 't', sessionId: 'sess-42', learningKind: 'fact', content: 'x', status: 'active', supersededBy: null, meta: {}, graphRefs: [], similarity: 0.9, score: 0.9 },
        { kind: 'learning', id: 2, createdAt: 't', sessionId: null, learningKind: 'fact', content: 'y', status: 'active', supersededBy: null, meta: {}, graphRefs: [], similarity: 0.8, score: 0.8 },
      ];
    },
  };
  const text = await handleRecallSimilar({ query: 'x' }, { store });
  assert.match(text, /\[learning\].*session=sess-42/);
  assert.match(text, /\[learning\].*session=none/);
});

test('handleRecallSimilar: compact mode renders one line per hit with a truncated snippet, and hints at getRecallItem', async () => {
  const longSummary = 'x'.repeat(200);
  const store = {
    async recallSimilar() {
      return [
        { kind: 'event', id: 1, createdAt: 't', sessionId: 's', repo: null, query: 'why did it fail', summary: longSummary, caveats: [], resolutions: [], meta: {}, graphRefs: [], model: null, similarity: 0.9, score: 0.9 },
      ];
    },
  };
  const text = await handleRecallSimilar({ query: 'x', compact: true }, { store });
  const line = text.split('\n').find((l) => l.startsWith('[event]'));
  assert.ok(line, 'compact mode emits a [event]-prefixed line');
  assert.ok(line.length < longSummary.length, 'the snippet is truncated, not the full summary');
  assert.match(line, /similarity=0\.9000/);
  assert.match(line, /session=s/);
  assert.match(text, /getRecallItem/);
  // Full-render-only fields must NOT appear verbatim in compact mode.
  assert.doesNotMatch(text, /Summary:/);
});

test('handleRecallSimilar: format "json" returns a parseable, versioned envelope mirroring the store results', async () => {
  const item = { kind: 'learning', id: 1, createdAt: 't', sessionId: 's', learningKind: 'fact', content: 'x', status: 'active', supersededBy: null, meta: {}, graphRefs: [], similarity: 0.9, score: 0.9 };
  const store = { async recallSimilar() { return [item]; } };
  const text = await handleRecallSimilar({ query: 'q', format: 'json' }, { store });
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tool, 'recallSimilar');
  assert.equal(parsed.query, 'q');
  assert.equal(parsed.count, 1);
  assert.deepEqual(parsed.results, [item]);
});

test('handleRecallSimilar: nearRefs is expanded via the injected runQuery and the EXPANDED set is passed to the store', async () => {
  let seenOpts;
  const store = { async recallSimilar(opts) { seenOpts = opts; return []; } };
  const runQuery = async () => [
    { get: (field) => (field === 'ref' ? 'a.ts::f' : [{ filePath: 'b.ts', name: 'neighborFn' }]) },
  ];
  await handleRecallSimilar({ query: 'q', nearRefs: ['a.ts::f'], nearRefsFilter: true }, { store, runQuery });
  assert.deepEqual(new Set(seenOpts.nearRefs), new Set(['a.ts::f', 'b.ts::neighborFn']));
  assert.equal(seenOpts.nearRefsFilter, true);
});

test('handleRecallSimilar: nearRefs neighborhood expansion failure is noted in the text output but never throws', async () => {
  const store = { async recallSimilar() { return []; } };
  const runQuery = async () => { throw new Error('Neo4j query failed: ECONNREFUSED'); };
  const text = await handleRecallSimilar({ query: 'nothing', nearRefs: ['a.ts::f'] }, { store, runQuery });
  assert.match(text, /neighborhood expansion skipped/);
  assert.match(text, /ECONNREFUSED/);
});

test('handleRecallSimilar: sessionId is passed through to the store', async () => {
  let seenOpts;
  const store = { async recallSimilar(opts) { seenOpts = opts; return []; } };
  await handleRecallSimilar({ query: 'q', sessionId: 'sess-1' }, { store });
  assert.equal(seenOpts.sessionId, 'sess-1');
});

// ---------------------------------------------------------------------------
// getRecallItem (#7)
// ---------------------------------------------------------------------------

test('handleGetRecallItem: rejects an invalid kind and a non-integer id WITHOUT calling the store', async () => {
  let called = false;
  const store = { async getItem() { called = true; return null; } };
  await assert.rejects(() => handleGetRecallItem({ kind: 'bogus', id: 1 }, { store }), /"kind" must be one of/);
  await assert.rejects(() => handleGetRecallItem({ kind: 'event', id: 1.5 }, { store }), /"id" is required and must be an integer/);
  assert.equal(called, false);
});

test('handleGetRecallItem: throws a named error when the store returns null (not found)', async () => {
  const store = { async getItem() { return null; } };
  await assert.rejects(() => handleGetRecallItem({ kind: 'event', id: 999 }, { store }), /no event #999 found/);
});

test('handleGetRecallItem: renders the full item WITHOUT a similarity segment (there was no query to rank against)', async () => {
  const store = {
    async getItem(kind, id) {
      assert.equal(kind, 'learning');
      assert.equal(id, 3);
      return { kind: 'learning', id: 3, createdAt: 't', sessionId: 's9', learningKind: 'gotcha', content: 'watch out', status: 'active', supersededBy: null, meta: {}, graphRefs: [] };
    },
  };
  const text = await handleGetRecallItem({ kind: 'learning', id: 3 }, { store });
  assert.match(text, /\[learning\]\s+id=3\s+session=s9/);
  assert.doesNotMatch(text, /similarity=/);
  assert.match(text, /\[gotcha\] watch out/);
});

test('handleGetRecallItem: format "json" returns a parseable, versioned envelope', async () => {
  const item = { kind: 'event', id: 4, createdAt: 't', sessionId: null, repo: null, query: 'q', summary: 's', caveats: [], resolutions: [], meta: {}, graphRefs: [], model: null };
  const store = { async getItem() { return item; } };
  const text = await handleGetRecallItem({ kind: 'event', id: 4, format: 'json' }, { store });
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tool, 'getRecallItem');
  assert.deepEqual(parsed.item, item);
});

// ---------------------------------------------------------------------------
// getSession (#9)
// ---------------------------------------------------------------------------

test('handleGetSession: rejects a missing/empty sessionId WITHOUT calling the store', async () => {
  let called = false;
  const store = { async getBySession() { called = true; return []; } };
  await assert.rejects(() => handleGetSession({ sessionId: '  ' }, { store }), /"sessionId" is required/);
  assert.equal(called, false);
});

test('handleGetSession: no-items message when the store returns an empty array', async () => {
  const store = { async getBySession() { return []; } };
  const text = await handleGetSession({ sessionId: 'sess-x' }, { store });
  assert.match(text, /No events, decisions, or learnings recorded under this sessionId\./);
});

test('handleGetSession: renders every item, chronological as returned by the store', async () => {
  const store = {
    async getBySession(sessionId) {
      assert.equal(sessionId, 'sess-1');
      return [
        { kind: 'decision', id: 1, createdAt: 't1', sessionId: 'sess-1', decision: 'use X', insteadOf: null, context: null, scope: null, status: 'active', supersededBy: null, meta: {}, graphRefs: [] },
        { kind: 'event', id: 2, createdAt: 't2', sessionId: 'sess-1', repo: null, query: 'q', summary: 's', caveats: [], resolutions: [], meta: {}, graphRefs: [], model: null },
      ];
    },
  };
  const text = await handleGetSession({ sessionId: 'sess-1' }, { store });
  assert.match(text, /SESSION: "sess-1"/);
  assert.match(text, /2 item\(s\)/);
  const decisionIdx = text.indexOf('Decision: use X');
  const eventIdx = text.indexOf('Query:   q');
  assert.ok(decisionIdx > -1 && eventIdx > -1 && decisionIdx < eventIdx, 'items render in the store-returned order');
});

test('handleGetSession: format "json" returns a parseable, versioned envelope', async () => {
  const items = [{ kind: 'learning', id: 1, createdAt: 't', sessionId: 's', learningKind: 'fact', content: 'x', status: 'active', supersededBy: null, meta: {}, graphRefs: [] }];
  const store = { async getBySession() { return items; } };
  const text = await handleGetSession({ sessionId: 's', format: 'json' }, { store });
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tool, 'getSession');
  assert.equal(parsed.sessionId, 's');
  assert.equal(parsed.count, 1);
  assert.deepEqual(parsed.items, items);
});

// ---------------------------------------------------------------------------
// searchSemantic
// ---------------------------------------------------------------------------

test('splitNodeId: splits on the LAST "::" (Windows absolute path survives)', () => {
  assert.deepEqual(splitNodeId('C:/repo/src/foo.ts::doThing'), {
    filePath: 'C:/repo/src/foo.ts',
    name: 'doThing',
  });
});

test('splitNodeId: no separator falls back to the whole string as filePath', () => {
  assert.deepEqual(splitNodeId('no-separator-here'), { filePath: 'no-separator-here', name: '' });
});

function makeFakeEmbedder() {
  return async (texts) => texts.map(() => new Array(EMBEDDING_DIM).fill(0.3));
}

test('searchSemanticCode: rejects an empty query without touching the DB', async () => {
  const runner = { async query() { throw new Error('should not be called'); } };
  await assert.rejects(
    () => searchSemanticCode({ query: '  ' }, { runner, embedder: makeFakeEmbedder() }),
    /"query" is required/,
  );
});

test('searchSemanticCode: no category -> no WHERE clause; parses node_id into filePath+name', async () => {
  const calls = [];
  const runner = {
    async query(text, params) {
      calls.push({ text, params });
      return {
        rows: [{ node_id: 'C:/repo/src/foo.ts::doThing', category: 'function:body', distance: 0.2 }],
      };
    },
  };
  const matches = await searchSemanticCode({ query: 'validate a token' }, { runner, embedder: makeFakeEmbedder() });

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].text, /WHERE/);
  assert.equal(calls[0].params[calls[0].params.length - 1], 10); // default k

  assert.deepEqual(matches, [
    {
      nodeId: 'C:/repo/src/foo.ts::doThing',
      filePath: 'C:/repo/src/foo.ts',
      name: 'doThing',
      category: 'function:body',
      similarity: 0.8,
    },
  ]);
});

test('searchSemanticCode: category filter adds a WHERE clause with the category param', async () => {
  const calls = [];
  const runner = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  await searchSemanticCode(
    { query: 'q', category: 'type:body' },
    { runner, embedder: makeFakeEmbedder() },
  );
  assert.match(calls[0].text, /WHERE category = \$2/);
  assert.equal(calls[0].params[1], 'type:body');
});

test('searchSemanticCode: k is clamped to [1, 50]', async () => {
  const calls = [];
  const runner = { async query(text, params) { calls.push({ text, params }); return { rows: [] }; } };
  await searchSemanticCode({ query: 'q', k: 9999 }, { runner, embedder: makeFakeEmbedder() });
  assert.equal(calls[0].params[calls[0].params.length - 1], 50);
});

test('searchSemanticCode: a wrong-dimension embedding is rejected with a truthful error', async () => {
  const runner = { async query() { throw new Error('should not be called'); } };
  const badEmbedder = async (texts) => texts.map(() => [1, 2, 3]);
  await assert.rejects(
    () => searchSemanticCode({ query: 'q' }, { runner, embedder: badEmbedder }),
    /expected 768/,
  );
});

test('handleSearchSemantic: no-matches message names the category filter and the backfill fix', async () => {
  const runner = { async query() { return { rows: [] }; } };
  const text = await handleSearchSemantic(
    { query: 'q', category: 'module:const' },
    { runner, embedder: makeFakeEmbedder() },
  );
  assert.match(text, /No matches found\. \(category filter: module:const\)/);
  assert.match(text, /conformity-backfill/);
});

test('handleSearchSemantic: renders matches ranked by similarity with file + category', async () => {
  const runner = {
    async query() {
      return {
        rows: [
          { node_id: 'C:/repo/src/foo.ts::doThing', category: 'function:body', distance: 0.1 },
        ],
      };
    },
  };
  const text = await handleSearchSemantic({ query: 'validate a token' }, { runner, embedder: makeFakeEmbedder() });
  assert.match(text, /SEMANTIC CODE SEARCH: "validate a token"/);
  assert.match(text, /similarity=0\.9000\s+\[function:body\]/);
  assert.match(text, /doThing/);
  assert.match(text, /File: C:\/repo\/src\/foo\.ts/);
});

test('handleSearchSemantic: format "json" returns a parseable, versioned envelope (#10)', async () => {
  const runner = {
    async query() {
      return { rows: [{ node_id: 'C:/repo/src/foo.ts::doThing', category: 'function:body', distance: 0.1 }] };
    },
  };
  const text = await handleSearchSemantic(
    { query: 'validate a token', category: 'function:body', format: 'json' },
    { runner, embedder: makeFakeEmbedder() },
  );
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tool, 'searchSemantic');
  assert.equal(parsed.query, 'validate a token');
  assert.equal(parsed.category, 'function:body');
  assert.equal(parsed.count, 1);
  assert.deepEqual(parsed.matches, [
    { nodeId: 'C:/repo/src/foo.ts::doThing', filePath: 'C:/repo/src/foo.ts', name: 'doThing', category: 'function:body', similarity: 0.9 },
  ]);
});

test('handleSearchSemantic: error path (embedder throws) propagates a truthful message', async () => {
  const runner = { async query() { throw new Error('should not be called'); } };
  const throwingEmbedder = async () => {
    throw new Error('model failed to load');
  };
  await assert.rejects(
    () => handleSearchSemantic({ query: 'q' }, { runner, embedder: throwingEmbedder }),
    /model failed to load/,
  );
});
