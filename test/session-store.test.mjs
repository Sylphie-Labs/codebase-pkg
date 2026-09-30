/**
 * Tests for the session-capture data layer (dist/session/store.js).
 *
 * PURE logic only -- NO live Postgres, NO embedding model. A fake PgRunner
 * records every SQL string + params and returns canned rows; a fake Embedder
 * returns deterministic fixed-length vectors. Mirrors test/conformity-store
 * .test.mjs and test/conformity-decisions-judge.test.mjs.
 *
 * Run after `npm run build`:
 *   node --test test/session-store.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SessionStore,
  createSessionStore,
  RECALL_KINDS,
  NEAR_DUPLICATE_THRESHOLD,
  EVENT_SEGMENT_SEPARATOR,
  HYBRID_COSINE_WEIGHT,
  HYBRID_LEXICAL_WEIGHT,
} from '../dist/session/store.js';
import { EMBEDDING_DIM } from '../dist/session/schema.js';

/** A PgRunner fake: records calls, returns rows from a responder keyed off the SQL text. */
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

/** A deterministic fake embedder: one fixed-length vector per input string. */
function makeFakeEmbedder() {
  const calls = [];
  const embedder = async (texts) => {
    calls.push(texts);
    return texts.map(() => new Array(EMBEDDING_DIM).fill(0.5));
  };
  embedder.calls = calls;
  return embedder;
}

// ---------------------------------------------------------------------------
// recordEvent
// ---------------------------------------------------------------------------

test('recordEvent embeds `query\\nsummary`, inserts into agent_events, returns the new id', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/INSERT INTO agent_events/.test(text)) return [{ id: 7 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordEvent({ query: 'how do X', summary: 'did X via Y' });

  assert.deepEqual(result, { id: 7 });
  assert.deepEqual(embedder.calls[0], ['how do X\ndid X via Y']);

  const insert = runner.calls.find((c) => /INSERT INTO agent_events/.test(c.text));
  assert.match(insert.text, /RETURNING id/);
  assert.equal(insert.params.length, 9);
  assert.equal(insert.params[2], 'how do X'); // query
  assert.equal(insert.params[3], 'did X via Y'); // summary
});

test('recordEvent rejects missing query/summary without touching the DB', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner();
  const store = new SessionStore(runner, embedder);

  await assert.rejects(() => store.recordEvent({ query: '', summary: 'x' }), /"query" is required/);
  await assert.rejects(() => store.recordEvent({ query: 'x', summary: '' }), /"summary" is required/);
  assert.equal(runner.calls.length, 0);
});

test('recordEvent defaults caveats/meta/graphRefs to empty and serializes them as jsonb params', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner(() => [{ id: 1 }]);
  const store = new SessionStore(runner, embedder);

  await store.recordEvent({ query: 'q', summary: 's' });
  const insert = runner.calls.find((c) => /INSERT INTO agent_events/.test(c.text));
  assert.equal(insert.params[4], '[]'); // caveats
  assert.equal(insert.params[5], '{}'); // meta
  assert.equal(insert.params[6], '[]'); // graph_refs
});

// ---------------------------------------------------------------------------
// recordDecision
// ---------------------------------------------------------------------------

test('recordDecision (no supersede) issues a plain INSERT and embeds decision only', async () => {
  const embedder = makeFakeEmbedder();
  // Keyed by SQL text (not "return X unconditionally") so the near-duplicate
  // pre-check SELECT (#3) sees an empty table, not a phantom self-match.
  const runner = makeFakeRunner((text) => {
    if (/INSERT INTO agent_decisions/.test(text)) return [{ id: 3 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordDecision({ decision: 'use pgvector' });

  assert.deepEqual(result, { id: 3 });
  assert.deepEqual(embedder.calls[0], ['use pgvector']);
  // Exactly ONE write call (schema-readiness DDL happened separately, before it).
  const writes = runner.calls.filter((c) => /INSERT|UPDATE|WITH/.test(c.text));
  assert.equal(writes.length, 1);
  assert.match(writes[0].text, /^INSERT INTO agent_decisions/);
  assert.doesNotMatch(writes[0].text, /WITH ins AS/);
});

test('recordDecision embeds "decision instead of insteadOf" when insteadOf is given', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner(() => [{ id: 4 }]);
  const store = new SessionStore(runner, embedder);

  await store.recordDecision({ decision: 'use pgvector', insteadOf: 'a bespoke ANN index' });

  assert.deepEqual(embedder.calls[0], ['use pgvector instead of a bespoke ANN index']);
});

test('recordDecision with supersedesId issues ONE atomic multi-CTE statement (insert + supersede update)', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/WITH ins AS/.test(text)) return [{ id: 42 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordDecision({
    decision: 'use pgvector',
    supersedesId: 12,
  });

  assert.deepEqual(result, { id: 42 });
  // Exactly ONE write call -- the transactional semantics come from a single
  // statement, not from separate BEGIN/UPDATE/COMMIT round-trips (schema-
  // readiness DDL happened separately, before it).
  const writes = runner.calls.filter((c) => /INSERT|UPDATE|WITH/.test(c.text));
  assert.equal(writes.length, 1);

  const { text, params } = writes[0];
  assert.match(text, /WITH ins AS \(/);
  assert.match(text, /INSERT INTO agent_decisions/);
  assert.match(text, /UPDATE agent_decisions/);
  assert.match(text, /SET status = 'superseded', superseded_by = \(SELECT id FROM ins\)/);
  assert.match(text, /WHERE id = \$9/);
  assert.match(text, /SELECT id FROM ins;$/);
  // Last param is the id being superseded.
  assert.equal(params[params.length - 1], 12);
});

test('recordDecision rejects missing decision / non-integer supersedesId is a store-level contract (id validity is the caller\'s job at the SQL layer)', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner();
  const store = new SessionStore(runner, embedder);

  await assert.rejects(() => store.recordDecision({ decision: '   ' }), /"decision" is required/);
  assert.equal(runner.calls.length, 0);
});

// ---------------------------------------------------------------------------
// recordLearning
// ---------------------------------------------------------------------------

test('recordLearning embeds content only and defaults kind to "fact"', async () => {
  const embedder = makeFakeEmbedder();
  // Keyed by SQL text so the near-duplicate pre-check SELECT (#3) sees an
  // empty table, not a phantom self-match.
  const runner = makeFakeRunner((text) => {
    if (/INSERT INTO agent_learnings/.test(text)) return [{ id: 9 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordLearning({ content: 'the API truncates at 1000 rows' });

  assert.deepEqual(result, { id: 9 });
  assert.deepEqual(embedder.calls[0], ['the API truncates at 1000 rows']);
  const insert = runner.calls.find((c) => /INSERT INTO agent_learnings/.test(c.text));
  assert.ok(insert);
  assert.equal(insert.params[1], 'fact');
});

test('recordLearning passes through an explicit kind', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner(() => [{ id: 10 }]);
  const store = new SessionStore(runner, embedder);

  await store.recordLearning({ content: 'x', kind: 'gotcha' });
  const insert = runner.calls.find((c) => /INSERT INTO agent_learnings/.test(c.text));
  assert.equal(insert.params[1], 'gotcha');
});

test('recordLearning rejects empty content without touching the DB', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner();
  const store = new SessionStore(runner, embedder);
  await assert.rejects(() => store.recordLearning({ content: '' }), /"content" is required/);
  assert.equal(runner.calls.length, 0);
});

// ---------------------------------------------------------------------------
// recallSimilar
// ---------------------------------------------------------------------------

function fakeRecallRunner() {
  return makeFakeRunner((text) => {
    if (/FROM agent_events/.test(text)) {
      return [
        { id: 1, created_at: 't1', session_id: 's', repo: 'r', query: 'q1', summary: 'sum1', caveats: [], resolutions: [], meta: {}, graph_refs: [], model: 'm', distance: 0.1 },
      ];
    }
    if (/FROM agent_decisions/.test(text)) {
      return [
        { id: 2, created_at: 't2', session_id: 's', decision: 'd1', instead_of: null, context: null, scope: null, status: 'active', superseded_by: null, meta: {}, graph_refs: [], distance: 0.3 },
      ];
    }
    if (/FROM agent_learnings/.test(text)) {
      return [
        { id: 3, created_at: 't3', session_id: 's', kind: 'fact', content: 'c1', status: 'active', superseded_by: null, meta: {}, graph_refs: [], distance: 0.05 },
      ];
    }
    return [];
  });
}

test('recallSimilar with default kinds queries all three tables and merges + sorts by similarity desc', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  const results = await store.recallSimilar({ query: 'anything' });

  assert.equal(results.length, 3);
  // similarity = 1 - distance; learnings(0.05->0.95) > events(0.1->0.9) > decisions(0.3->0.7)
  assert.deepEqual(results.map((r) => r.kind), ['learning', 'event', 'decision']);
  assert.ok(results[0].similarity > results[1].similarity);
  assert.ok(results[1].similarity > results[2].similarity);

  assert.equal(runner.calls.filter((c) => /SELECT/.test(c.text)).length, 3);
});

test('recallSimilar honors a kinds filter -- only the requested tables are queried', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  const results = await store.recallSimilar({ query: 'q', kinds: ['learning'] });

  assert.equal(results.length, 1);
  assert.equal(results[0].kind, 'learning');
  const selects = runner.calls.filter((c) => /SELECT/.test(c.text) && /FROM agent_/.test(c.text));
  assert.equal(selects.length, 1);
  assert.match(selects[0].text, /FROM agent_learnings/);
});

test('recallSimilar dedupes a repeated kind into a single query', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  await store.recallSimilar({ query: 'q', kinds: ['event', 'event'] });
  assert.equal(runner.calls.filter((c) => /SELECT/.test(c.text)).length, 1);
});

test('recallSimilar rejects an all-invalid kinds list', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  await assert.rejects(
    () => store.recallSimilar({ query: 'q', kinds: ['bogus'] }),
    /non-empty subset/,
  );
});

test('recallSimilar filters decisions to status=active by default', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  await store.recallSimilar({ query: 'q', kinds: ['decision'] });
  const call = runner.calls.find((c) => /FROM agent_decisions/.test(c.text));
  assert.match(call.text, /WHERE status = 'active'/);
});

test('recallSimilar includeSuperseded=true drops the status filter', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  await store.recallSimilar({ query: 'q', kinds: ['decision'], includeSuperseded: true });
  const call = runner.calls.find((c) => /FROM agent_decisions/.test(c.text));
  assert.doesNotMatch(call.text, /WHERE status = 'active'/);
});

test('recallSimilar passes k through as the per-kind LIMIT', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  await store.recallSimilar({ query: 'q', kinds: ['event'], k: 3 });
  const call = runner.calls.find((c) => /FROM agent_events/.test(c.text));
  assert.equal(call.params[1], 3);
});

test('recallSimilar rejects an empty query without touching the DB', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);
  await assert.rejects(() => store.recallSimilar({ query: '  ' }), /"query" is required/);
  assert.equal(runner.calls.length, 0);
});

test('createSessionStore factory constructs a usable SessionStore with defaults overridable', async () => {
  const embedder = makeFakeEmbedder();
  // Keyed by SQL text so the near-duplicate pre-check SELECT (#3) sees an
  // empty table, not a phantom self-match.
  const runner = makeFakeRunner((text) => {
    if (/INSERT INTO agent_learnings/.test(text)) return [{ id: 1 }];
    return [];
  });
  const store = createSessionStore(runner, embedder);
  const result = await store.recordLearning({ content: 'x' });
  assert.deepEqual(result, { id: 1 });
});

// ---------------------------------------------------------------------------
// Embedder contract: a wrong-length vector must fail loudly, not silently
// corrupt the fixed-width pgvector column.
// ---------------------------------------------------------------------------

test('a wrong-dimension embedding is rejected with a truthful error, no DB write', async () => {
  const badEmbedder = async (texts) => texts.map(() => [1, 2, 3]);
  const runner = makeFakeRunner();
  const store = new SessionStore(runner, badEmbedder);

  await assert.rejects(
    () => store.recordEvent({ query: 'q', summary: 's' }),
    /expected 768/,
  );
  const inserts = runner.calls.filter((c) => /INSERT/.test(c.text));
  assert.equal(inserts.length, 0);
});

// ---------------------------------------------------------------------------
// Secret redaction on record* free text (#2)
// ---------------------------------------------------------------------------

test('recordEvent redacts secrets in query/summary/caveats before embedding + inserting, and reports findings', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/INSERT INTO agent_events/.test(text)) return [{ id: 20 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordEvent({
    query: 'connect via postgresql://user:hunter2@localhost/db',
    summary: 'used key sk-ABCDEFGHIJKLMN to auth',
    caveats: ['clean caveat', 'token ghp_1234567890abcdefghijklmnopqrstuvwx leaked'],
  });

  assert.deepEqual(result.redaction.findings.sort(), ['github-token', 'openai-style-key', 'url-password']);

  const insert = runner.calls.find((c) => /INSERT INTO agent_events/.test(c.text));
  assert.match(insert.params[2], /postgresql:\/\/user:\*\*\*\*@localhost\/db/); // query
  assert.match(insert.params[3], /sk-\*\*\*\*/); // summary
  const caveats = JSON.parse(insert.params[4]);
  assert.equal(caveats[0], 'clean caveat');
  assert.match(caveats[1], /ghp_\*\*\*\*/);

  // The embedder must see the REDACTED text, not the raw secret.
  assert.doesNotMatch(embedder.calls[0][0], /hunter2/);
});

test('recordDecision redacts decision/insteadOf/context', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/INSERT INTO agent_decisions/.test(text)) return [{ id: 21 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordDecision({
    decision: 'rotate the AKIAIOSFODNN7EXAMPLE key',
    insteadOf: 'leaving GOCSPX-abc123XYZ789def456 in place',
    context: 'clean context',
  });

  assert.deepEqual(result.redaction.findings.sort(), ['aws-access-key', 'google-oauth-secret']);
  const insert = runner.calls.find((c) => /INSERT INTO agent_decisions/.test(c.text));
  assert.match(insert.params[1], /AKIA\*\*\*\*/);
  assert.match(insert.params[2], /GOCSPX-\*\*\*\*/);
  assert.equal(insert.params[3], 'clean context');
});

test('recordLearning redacts content', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/INSERT INTO agent_learnings/.test(text)) return [{ id: 22 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordLearning({ content: 'the pairing token is sk-ABCDEFGHIJKLMN' });

  assert.deepEqual(result.redaction.findings, ['openai-style-key']);
  const insert = runner.calls.find((c) => /INSERT INTO agent_learnings/.test(c.text));
  assert.match(insert.params[2], /sk-\*\*\*\*/);
});

test('no redaction field is present at all when nothing fires (clean text)', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/INSERT INTO agent_learnings/.test(text)) return [{ id: 23 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordLearning({ content: 'perfectly ordinary learning' });
  assert.equal('redaction' in result, false);
});

// ---------------------------------------------------------------------------
// Near-duplicate detection at record time (#3)
// ---------------------------------------------------------------------------

test('recordLearning flags a near-duplicate when the nearest ACTIVE learning clears the threshold', async () => {
  // similarity = 1 - distance; asserted the same way the implementation computes it, to
  // avoid a hardcoded float literal drifting from the actual floating-point result.
  const distance = 0.1; // similarity 0.9, clears NEAR_DUPLICATE_THRESHOLD (0.85)
  assert.ok(1 - distance >= NEAR_DUPLICATE_THRESHOLD);
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/SELECT id, embedding <=> \$1 AS distance FROM agent_learnings WHERE status = 'active'/.test(text)) {
      return [{ id: 5, distance }];
    }
    if (/INSERT INTO agent_learnings/.test(text)) return [{ id: 6 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordLearning({ content: 'new learning text' });
  assert.deepEqual(result.nearDuplicate, { id: 5, similarity: 1 - distance });
  assert.equal(result.id, 6);
});

test('recordLearning does NOT flag a near-duplicate below the threshold', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/SELECT id, embedding <=> \$1 AS distance FROM agent_learnings/.test(text)) {
      return [{ id: 5, distance: 0.5 }]; // similarity 0.5, well under threshold
    }
    if (/INSERT INTO agent_learnings/.test(text)) return [{ id: 6 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordLearning({ content: 'new learning text' });
  assert.equal('nearDuplicate' in result, false);
});

test('recordLearning skips the near-duplicate check entirely when supersedesId is given', async () => {
  const embedder = makeFakeEmbedder();
  const calls = [];
  const runner = makeFakeRunner((text) => {
    calls.push(text);
    if (/WITH ins AS/.test(text)) return [{ id: 6 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  await store.recordLearning({ content: 'new learning text', supersedesId: 5 });
  const nearDupSelects = calls.filter((t) => /SELECT id, embedding <=> \$1 AS distance/.test(t));
  assert.equal(nearDupSelects.length, 0);
});

test('recordDecision flags a near-duplicate against other ACTIVE decisions', async () => {
  const distance = 0.05;
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/SELECT id, embedding <=> \$1 AS distance FROM agent_decisions WHERE status = 'active'/.test(text)) {
      return [{ id: 8, distance }];
    }
    if (/^INSERT INTO agent_decisions/.test(text)) return [{ id: 9 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordDecision({ decision: 'use pgvector for recall' });
  assert.deepEqual(result.nearDuplicate, { id: 8, similarity: 1 - distance });
});

test('recordEvent flags a near-duplicate against other events (no status filter -- events have no status column)', async () => {
  const distance = 0.02;
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/SELECT id, embedding <=> \$1 AS distance FROM agent_events/.test(text) && !/session_id/.test(text)) {
      return [{ id: 11, distance }];
    }
    if (/INSERT INTO agent_events/.test(text)) return [{ id: 12 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordEvent({ query: 'q', summary: 's' });
  assert.deepEqual(result.nearDuplicate, { id: 11, similarity: 1 - distance });
});

// ---------------------------------------------------------------------------
// Learning amend/supersede (#1, mirrors recordDecision)
// ---------------------------------------------------------------------------

test('recordLearning with supersedesId issues ONE atomic multi-CTE statement (insert + supersede update)', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/WITH ins AS/.test(text)) return [{ id: 42 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordLearning({ content: 'corrected learning', supersedesId: 9 });

  assert.equal(result.id, 42);
  const writes = runner.calls.filter((c) => /INSERT|UPDATE|WITH/.test(c.text));
  assert.equal(writes.length, 1);

  const { text, params } = writes[0];
  assert.match(text, /WITH ins AS \(/);
  assert.match(text, /INSERT INTO agent_learnings/);
  assert.match(text, /UPDATE agent_learnings/);
  assert.match(text, /SET status = 'superseded', superseded_by = \(SELECT id FROM ins\)/);
  assert.match(text, /WHERE id = \$7/);
  assert.match(text, /SELECT id FROM ins;$/);
  assert.equal(params[params.length - 1], 9);
});

test('recallSimilar filters learnings to status=active by default, and includeSuperseded=true drops it', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  await store.recallSimilar({ query: 'q', kinds: ['learning'] });
  let call = runner.calls.find((c) => /FROM agent_learnings/.test(c.text));
  assert.match(call.text, /WHERE status = 'active'/);

  await store.recallSimilar({ query: 'q', kinds: ['learning'], includeSuperseded: true });
  call = runner.calls[runner.calls.length - 1];
  assert.doesNotMatch(call.text, /WHERE status = 'active'/);
});

test('recallSimilar surfaces learning status/supersededBy on the recalled item', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/FROM agent_learnings/.test(text)) {
      return [
        { id: 3, created_at: 't3', session_id: 's', kind: 'fact', content: 'c1', status: 'superseded', superseded_by: 99, meta: {}, graph_refs: [], distance: 0.05 },
      ];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const results = await store.recallSimilar({ query: 'q', kinds: ['learning'], includeSuperseded: true });
  assert.equal(results[0].status, 'superseded');
  assert.equal(results[0].supersededBy, 99);
});

// ---------------------------------------------------------------------------
// recordEvent upsert-by-sessionId (#8)
// ---------------------------------------------------------------------------

test('recordEvent with a NEW sessionId (no existing row) inserts normally', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/SELECT id, query, summary, caveats, graph_refs/.test(text)) return []; // no existing row
    if (/INSERT INTO agent_events/.test(text)) return [{ id: 30 }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordEvent({ query: 'q', summary: 's', sessionId: 'sess-1' });
  assert.equal(result.id, 30);
  assert.equal('updated' in result, false);
  const insert = runner.calls.find((c) => /INSERT INTO agent_events/.test(c.text));
  assert.ok(insert);
});

test('recordEvent with an EXISTING sessionId updates in place: appends summary, merges caveats + graphRefs (deduped), bumps updated_at, re-embeds', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/SELECT id, query, summary, caveats, graph_refs/.test(text)) {
      return [
        {
          id: 40,
          query: 'original ask',
          summary: 'first segment',
          caveats: ['old caveat'],
          graph_refs: ['a.ts::f', 'b.ts::g'],
        },
      ];
    }
    if (/UPDATE agent_events/.test(text)) return [];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordEvent({
    query: 'ignored on update -- first segment wins',
    summary: 'second segment',
    caveats: ['new caveat'],
    graphRefs: ['b.ts::g', 'c.ts::h'], // b.ts::g is a duplicate of an existing ref
    sessionId: 'sess-2',
  });

  assert.deepEqual(result, { id: 40, updated: true });

  // No INSERT at all -- this is a pure update.
  const inserts = runner.calls.filter((c) => /^INSERT/.test(c.text));
  assert.equal(inserts.length, 0);

  const update = runner.calls.find((c) => /UPDATE agent_events/.test(c.text));
  assert.ok(update);
  assert.equal(update.params[0], `first segment${EVENT_SEGMENT_SEPARATOR}second segment`);
  assert.deepEqual(JSON.parse(update.params[1]), ['old caveat', 'new caveat']);
  assert.deepEqual(JSON.parse(update.params[2]), ['a.ts::f', 'b.ts::g', 'c.ts::h']); // deduped
  assert.match(update.text, /updated_at = now\(\)/);
  assert.equal(update.params[4], 40);

  // Re-embedded over the EXISTING query + the MERGED summary (the original
  // query is preserved -- only summary/caveats/graphRefs change on upsert).
  assert.deepEqual(embedder.calls[embedder.calls.length - 1], [
    `original ask\nfirst segment${EVENT_SEGMENT_SEPARATOR}second segment`,
  ]);
});

test('recordEvent upsert also redacts secrets in the new segment before merging', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/SELECT id, query, summary, caveats, graph_refs/.test(text)) {
      return [{ id: 41, query: 'q', summary: 'first', caveats: [], graph_refs: [] }];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.recordEvent({
    query: 'q',
    summary: 'leaked sk-ABCDEFGHIJKLMN in this segment',
    sessionId: 'sess-3',
  });

  assert.deepEqual(result.redaction.findings, ['openai-style-key']);
  const update = runner.calls.find((c) => /UPDATE agent_events/.test(c.text));
  assert.match(update.params[0], /sk-\*\*\*\*/);
});

// ---------------------------------------------------------------------------
// resolveCaveat (#5)
// ---------------------------------------------------------------------------

test('resolveCaveat rejects non-integer eventId/caveatIndex without touching the DB', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner();
  const store = new SessionStore(runner, embedder);

  await assert.rejects(() => store.resolveCaveat({ eventId: 'x', caveatIndex: 0 }), /"eventId" must be an integer/);
  await assert.rejects(() => store.resolveCaveat({ eventId: 1, caveatIndex: -1 }), /"caveatIndex" must be a non-negative integer/);
  assert.equal(runner.calls.length, 0);
});

test('resolveCaveat throws when the event does not exist', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner(() => []);
  const store = new SessionStore(runner, embedder);

  await assert.rejects(() => store.resolveCaveat({ eventId: 999, caveatIndex: 0 }), /no event #999 found/);
});

test('resolveCaveat throws when caveatIndex is out of range', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner(() => [{ caveats: ['only one'], resolutions: [] }]);
  const store = new SessionStore(runner, embedder);

  await assert.rejects(
    () => store.resolveCaveat({ eventId: 1, caveatIndex: 3 }),
    /has 1 caveat\(s\); caveatIndex 3 is out of range/,
  );
});

test('resolveCaveat appends a resolution without touching the caveats column, redacts the note, and returns the original text', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/^SELECT caveats, resolutions/.test(text)) {
      return [{ caveats: ['Jim owes a runtime restart', 'firewall rule pending'], resolutions: [] }];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const result = await store.resolveCaveat({
    eventId: 7,
    caveatIndex: 0,
    note: 'done, key was sk-ABCDEFGHIJKLMN rotated after',
  });

  assert.equal(result.id, 7);
  assert.equal(result.caveatIndex, 0);
  assert.equal(result.caveatText, 'Jim owes a runtime restart');
  assert.ok(result.resolvedAt);

  const update = runner.calls.find((c) => /^UPDATE agent_events SET resolutions/.test(c.text));
  const resolutions = JSON.parse(update.params[0]);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].caveatIndex, 0);
  assert.match(resolutions[0].note, /sk-\*\*\*\*/);
  assert.equal(update.params[1], 7);
});

test('resolveCaveat re-resolving the SAME caveatIndex replaces the prior entry rather than accumulating', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/^SELECT caveats, resolutions/.test(text)) {
      return [
        {
          caveats: ['a caveat'],
          resolutions: [{ caveatIndex: 0, resolvedAt: '2020-01-01T00:00:00.000Z', note: 'stale note' }],
        },
      ];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  await store.resolveCaveat({ eventId: 7, caveatIndex: 0, note: 'fresh note' });

  const update = runner.calls.find((c) => /^UPDATE agent_events SET resolutions/.test(c.text));
  const resolutions = JSON.parse(update.params[0]);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].note, 'fresh note');
});

test('resolveCaveat omits the note key when no note is given', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/^SELECT caveats, resolutions/.test(text)) return [{ caveats: ['x'], resolutions: [] }];
    return [];
  });
  const store = new SessionStore(runner, embedder);

  await store.resolveCaveat({ eventId: 7, caveatIndex: 0 });
  const update = runner.calls.find((c) => /^UPDATE agent_events SET resolutions/.test(c.text));
  const resolutions = JSON.parse(update.params[0]);
  assert.equal('note' in resolutions[0], false);
});

// ---------------------------------------------------------------------------
// recallSimilar hybrid ranking (#6): cosine + lexical + nearRefs boost + recency
// ---------------------------------------------------------------------------

test('recallSimilar issues the lex_score similarity() expression + raw query text as $3, k stays $2 (unchanged position)', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  await store.recallSimilar({ query: 'find the bug', kinds: ['event'], k: 3 });
  const call = runner.calls.find((c) => /FROM agent_events/.test(c.text));
  assert.match(call.text, /similarity\(query \|\| ' ' \|\| summary, \$3\) AS lex_score/);
  assert.equal(call.params[1], 3); // k is STILL $2 -- unchanged position from before #6
  assert.equal(call.params[2], 'find the bug'); // raw query text at $3
});

test('recallSimilar hybrid score promotes a strong lexical/weak cosine hit above a weak lexical/strong cosine one (the #6 motivating case)', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/FROM agent_learnings/.test(text)) {
      return [
        // Weak-topic but high embedding similarity (like the TTS red herring).
        { id: 1, created_at: new Date(0).toISOString(), session_id: null, kind: 'gotcha', content: 'red herring', status: 'active', superseded_by: null, meta: {}, graph_refs: [], distance: 0.1, lex_score: 0 },
        // Strong exact-identifier lexical match but weaker embedding similarity.
        { id: 2, created_at: new Date(0).toISOString(), session_id: null, kind: 'gotcha', content: 'the /v1/voice diagnostic', status: 'active', superseded_by: null, meta: {}, graph_refs: [], distance: 0.3, lex_score: 1.0 },
      ];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const results = await store.recallSimilar({ query: 'POST /v1/voice returns nothing', kinds: ['learning'] });

  assert.equal(results.length, 2);
  assert.equal(results[0].id, 2, 'the exact-identifier lexical match should outrank the vocabulary-overlap red herring');
  assert.ok(results[0].score > results[1].score);
  // similarity stays the RAW cosine value regardless of the score-based reordering.
  assert.equal(results[0].similarity, 0.7);
  assert.equal(results[1].similarity, 0.9);
});

test('recallSimilar score is the documented weighted blend of cosine + lexical (no nearRefs/recency contribution when refs/date are absent-equivalent)', async () => {
  const embedder = makeFakeEmbedder();
  const oldEnough = new Date(0).toISOString(); // recency term ~0 either way at this age
  const runner = makeFakeRunner((text) => {
    if (/FROM agent_learnings/.test(text)) {
      return [
        { id: 1, created_at: oldEnough, session_id: null, kind: 'fact', content: 'x', status: 'active', superseded_by: null, meta: {}, graph_refs: [], distance: 0.2, lex_score: 0.4 },
      ];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const [result] = await store.recallSimilar({ query: 'q', kinds: ['learning'] });
  const expectedBase = HYBRID_COSINE_WEIGHT * 0.8 + HYBRID_LEXICAL_WEIGHT * 0.4;
  // Recency term is a small POSITIVE addend (RECENCY_WEIGHT * recency in (0,1]), so the
  // actual score is >= the pure cosine+lexical base and converges to it as age -> infinity.
  assert.ok(result.score >= expectedBase);
  assert.ok(result.score < expectedBase + 0.06); // RECENCY_WEIGHT is 0.05 -- generous slack
});

test('recallSimilar nearRefs boosts an item whose graphRefs overlap the set, without excluding non-overlapping items (default boost mode)', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/FROM agent_learnings/.test(text)) {
      return [
        { id: 1, created_at: new Date(0).toISOString(), session_id: null, kind: 'fact', content: 'no ref overlap, better cosine', status: 'active', superseded_by: null, meta: {}, graph_refs: ['other.ts::g'], distance: 0.1, lex_score: 0 },
        { id: 2, created_at: new Date(0).toISOString(), session_id: null, kind: 'fact', content: 'ref overlap, worse cosine', status: 'active', superseded_by: null, meta: {}, graph_refs: ['a.ts::f'], distance: 0.25, lex_score: 0 },
      ];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const results = await store.recallSimilar({ query: 'q', kinds: ['learning'], nearRefs: ['a.ts::f'] });

  assert.equal(results.length, 2, 'boost mode never drops non-overlapping items');
  assert.equal(results[0].id, 2, 'the graphRefs-overlapping item should be boosted to the top');
});

test('recallSimilar nearRefsFilter drops items with no graphRefs overlap entirely', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/FROM agent_learnings/.test(text)) {
      return [
        { id: 1, created_at: new Date(0).toISOString(), session_id: null, kind: 'fact', content: 'no overlap', status: 'active', superseded_by: null, meta: {}, graph_refs: ['other.ts::g'], distance: 0.1, lex_score: 0 },
        { id: 2, created_at: new Date(0).toISOString(), session_id: null, kind: 'fact', content: 'overlap', status: 'active', superseded_by: null, meta: {}, graph_refs: ['a.ts::f'], distance: 0.25, lex_score: 0 },
      ];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const results = await store.recallSimilar({
    query: 'q',
    kinds: ['learning'],
    nearRefs: ['a.ts::f'],
    nearRefsFilter: true,
  });

  assert.deepEqual(results.map((r) => r.id), [2]);
});

test('recallSimilar recency term breaks a near-tie toward the newer row without a nearRefs/lexical difference', async () => {
  const embedder = makeFakeEmbedder();
  const now = new Date();
  const veryOld = new Date(now.getTime() - 5000 * 86_400_000).toISOString(); // ~13.7 years old -> recency ~0
  const brandNew = now.toISOString();
  const runner = makeFakeRunner((text) => {
    if (/FROM agent_learnings/.test(text)) {
      return [
        { id: 1, created_at: veryOld, session_id: null, kind: 'fact', content: 'old', status: 'active', superseded_by: null, meta: {}, graph_refs: [], distance: 0.2, lex_score: 0 },
        { id: 2, created_at: brandNew, session_id: null, kind: 'fact', content: 'new', status: 'active', superseded_by: null, meta: {}, graph_refs: [], distance: 0.2, lex_score: 0 },
      ];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const results = await store.recallSimilar({ query: 'q', kinds: ['learning'] });

  assert.equal(results[0].id, 2, 'identical cosine+lexical -> the newer row should win the tiebreak');
  assert.equal(results[0].similarity, results[1].similarity, 'the tie really was on cosine similarity');
});

test('recallSimilar sessionId filter adds a session_id condition (combined with status via AND for decisions/learnings) and passes it as $4', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  await store.recallSimilar({ query: 'q', kinds: ['event'], sessionId: 'sess-9' });
  const eventCall = runner.calls.find((c) => /FROM agent_events/.test(c.text));
  assert.match(eventCall.text, /WHERE session_id = \$4/);
  assert.equal(eventCall.params[3], 'sess-9');

  await store.recallSimilar({ query: 'q', kinds: ['decision'], sessionId: 'sess-9' });
  const decisionCall = runner.calls.find((c) => /FROM agent_decisions/.test(c.text));
  assert.match(decisionCall.text, /WHERE status = 'active' AND session_id = \$4/);
});

test('recallSimilar with no sessionId issues no session_id WHERE filter and no 4th param', async () => {
  const embedder = makeFakeEmbedder();
  const runner = fakeRecallRunner();
  const store = new SessionStore(runner, embedder);

  await store.recallSimilar({ query: 'q', kinds: ['event'] });
  const call = runner.calls.find((c) => /FROM agent_events/.test(c.text));
  assert.doesNotMatch(call.text, /WHERE session_id/);
  assert.equal(call.params.length, 3); // [literal, k, query] -- no sessionId appended
});

// ---------------------------------------------------------------------------
// getItem (#7 getRecallItem) / getBySession (#9 getSession)
// ---------------------------------------------------------------------------

test('getItem(event) fetches by id with no embedding call, no similarity/score field', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/FROM agent_events WHERE id = \$1/.test(text)) {
      return [{ id: 5, created_at: 't', session_id: 's1', repo: 'r', query: 'q', summary: 's', caveats: [], resolutions: [], meta: {}, graph_refs: [], model: 'm' }];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const item = await store.getItem('event', 5);
  assert.equal(item.kind, 'event');
  assert.equal(item.id, 5);
  assert.equal('similarity' in item, false);
  assert.equal('score' in item, false);
  assert.equal(embedder.calls.length, 0, 'a direct id lookup must not call the embedder');
});

test('getItem(decision) and getItem(learning) fetch from their own tables', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/FROM agent_decisions WHERE id = \$1/.test(text)) {
      return [{ id: 6, created_at: 't', session_id: null, decision: 'd', instead_of: null, context: null, scope: null, status: 'active', superseded_by: null, meta: {}, graph_refs: [] }];
    }
    if (/FROM agent_learnings WHERE id = \$1/.test(text)) {
      return [{ id: 7, created_at: 't', session_id: null, kind: 'gotcha', content: 'c', status: 'active', superseded_by: null, meta: {}, graph_refs: [] }];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const decision = await store.getItem('decision', 6);
  assert.equal(decision.kind, 'decision');
  assert.equal(decision.decision, 'd');

  const learning = await store.getItem('learning', 7);
  assert.equal(learning.kind, 'learning');
  assert.equal(learning.content, 'c');
});

test('getItem returns null when no row with that id exists', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner(() => []);
  const store = new SessionStore(runner, embedder);

  assert.equal(await store.getItem('event', 999), null);
});

test('getBySession fetches from all three tables by session_id and sorts chronologically (oldest first), with no embedding call', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner((text) => {
    if (/FROM agent_events WHERE session_id = \$1/.test(text)) {
      return [{ id: 1, created_at: '2026-01-02T00:00:00.000Z', session_id: 's1', repo: null, query: 'q', summary: 's', caveats: [], resolutions: [], meta: {}, graph_refs: [], model: null }];
    }
    if (/FROM agent_decisions WHERE session_id = \$1/.test(text)) {
      return [{ id: 2, created_at: '2026-01-01T00:00:00.000Z', session_id: 's1', decision: 'd', instead_of: null, context: null, scope: null, status: 'active', superseded_by: null, meta: {}, graph_refs: [] }];
    }
    if (/FROM agent_learnings WHERE session_id = \$1/.test(text)) {
      return [{ id: 3, created_at: '2026-01-03T00:00:00.000Z', session_id: 's1', kind: 'fact', content: 'c', status: 'active', superseded_by: null, meta: {}, graph_refs: [] }];
    }
    return [];
  });
  const store = new SessionStore(runner, embedder);

  const items = await store.getBySession('s1');
  assert.deepEqual(items.map((i) => i.id), [2, 1, 3]); // chronological: decision(01), event(02), learning(03)
  assert.equal(embedder.calls.length, 0, 'a session dump must not call the embedder');
});

test('getBySession returns an empty array for a sessionId with no rows', async () => {
  const embedder = makeFakeEmbedder();
  const runner = makeFakeRunner(() => []);
  const store = new SessionStore(runner, embedder);

  assert.deepEqual(await store.getBySession('nope'), []);
});
