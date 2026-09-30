/**
 * Tests for the session-capture schema bootstrap (dist/session/schema.js).
 *
 * PURE logic only -- NO live Postgres. A fake PgRunner records every SQL
 * string issued and returns nothing meaningful (ensureSessionSchema does not
 * read `rows`). Mirrors test/conformity-store.test.mjs's approach to
 * ensureSchema.
 *
 * Run after `npm run build`:
 *   node --test test/session-schema.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureSessionSchema,
  EMBEDDING_DIM,
  AGENT_EVENTS_TABLE,
  AGENT_DECISIONS_TABLE,
  AGENT_LEARNINGS_TABLE,
} from '../dist/session/schema.js';

function makeFakeRunner() {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
}

test('table name constants match the spec', () => {
  assert.equal(AGENT_EVENTS_TABLE, 'agent_events');
  assert.equal(AGENT_DECISIONS_TABLE, 'agent_decisions');
  assert.equal(AGENT_LEARNINGS_TABLE, 'agent_learnings');
});

test('EMBEDDING_DIM is reused from the conformity schema (768, no drift)', async () => {
  const { EMBEDDING_DIM: conformityDim } = await import('../dist/conformity/schema.js');
  assert.equal(EMBEDDING_DIM, 768);
  assert.equal(EMBEDDING_DIM, conformityDim);
});

test('ensureSessionSchema creates the vector extension once', async () => {
  const runner = makeFakeRunner();
  await ensureSessionSchema(runner);
  const ext = runner.calls.filter((c) => /CREATE EXTENSION IF NOT EXISTS vector/.test(c.text));
  assert.equal(ext.length, 1);
});

test('ensureSessionSchema creates the pg_trgm extension once (#6 hybrid scoring lexical signal)', async () => {
  const runner = makeFakeRunner();
  await ensureSessionSchema(runner);
  const ext = runner.calls.filter((c) => /CREATE EXTENSION IF NOT EXISTS pg_trgm/.test(c.text));
  assert.equal(ext.length, 1);
});

test('ensureSessionSchema creates agent_events with the spec columns + HNSW index', async () => {
  const runner = makeFakeRunner();
  await ensureSessionSchema(runner);

  const createTable = runner.calls.find(
    (c) => /CREATE TABLE IF NOT EXISTS agent_events/.test(c.text),
  );
  assert.ok(createTable, 'agent_events CREATE TABLE issued');
  for (const col of [
    'id\\s+bigserial PRIMARY KEY',
    'created_at\\s+timestamptz NOT NULL DEFAULT now\\(\\)',
    'session_id\\s+text',
    'repo\\s+text',
    'query\\s+text NOT NULL',
    'summary\\s+text NOT NULL',
    "caveats\\s+jsonb NOT NULL DEFAULT '\\[\\]'",
    "meta\\s+jsonb NOT NULL DEFAULT '\\{\\}'",
    "graph_refs\\s+jsonb NOT NULL DEFAULT '\\[\\]'",
    'model\\s+text',
    `embedding\\s+vector\\(${EMBEDDING_DIM}\\)`,
  ]) {
    assert.match(createTable.text, new RegExp(col), `agent_events has column matching /${col}/`);
  }

  const hnsw = runner.calls.find((c) => /agent_events_embedding_hnsw/.test(c.text));
  assert.ok(hnsw, 'HNSW index on agent_events.embedding issued');
  assert.match(hnsw.text, /USING hnsw \(embedding vector_cosine_ops\)/);
});

test('ensureSessionSchema additively upgrades agent_events with resolutions (#5) + updated_at (#8)', async () => {
  const runner = makeFakeRunner();
  await ensureSessionSchema(runner);

  const resolutionsAlter = runner.calls.find(
    (c) => /ALTER TABLE agent_events/.test(c.text) && /resolutions/.test(c.text),
  );
  assert.ok(resolutionsAlter, 'agent_events.resolutions ADD COLUMN IF NOT EXISTS issued');
  assert.match(resolutionsAlter.text, /ADD COLUMN IF NOT EXISTS resolutions jsonb NOT NULL DEFAULT '\[\]'/);

  const updatedAtAlter = runner.calls.find(
    (c) => /ALTER TABLE agent_events/.test(c.text) && /updated_at/.test(c.text),
  );
  assert.ok(updatedAtAlter, 'agent_events.updated_at ADD COLUMN IF NOT EXISTS issued');
  assert.match(updatedAtAlter.text, /ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now\(\)/);
});

test('ensureSessionSchema creates agent_decisions with status/superseded_by + HNSW index', async () => {
  const runner = makeFakeRunner();
  await ensureSessionSchema(runner);

  const createTable = runner.calls.find(
    (c) => /CREATE TABLE IF NOT EXISTS agent_decisions/.test(c.text),
  );
  assert.ok(createTable);
  for (const col of [
    'id\\s+bigserial PRIMARY KEY',
    'session_id\\s+text',
    'decision\\s+text NOT NULL',
    'instead_of\\s+text',
    'context\\s+text',
    'scope\\s+text',
    "status\\s+text NOT NULL DEFAULT 'active'",
    'superseded_by\\s+bigint',
    `embedding\\s+vector\\(${EMBEDDING_DIM}\\)`,
  ]) {
    assert.match(createTable.text, new RegExp(col));
  }

  const hnsw = runner.calls.find((c) => /agent_decisions_embedding_hnsw/.test(c.text));
  assert.ok(hnsw, 'HNSW index on agent_decisions.embedding issued');

  const statusIdx = runner.calls.find((c) => /agent_decisions_status_idx/.test(c.text));
  assert.ok(statusIdx, 'btree index on agent_decisions.status issued');
});

test('ensureSessionSchema creates agent_learnings with kind default + HNSW index', async () => {
  const runner = makeFakeRunner();
  await ensureSessionSchema(runner);

  const createTable = runner.calls.find(
    (c) => /CREATE TABLE IF NOT EXISTS agent_learnings/.test(c.text),
  );
  assert.ok(createTable);
  for (const col of [
    'id\\s+bigserial PRIMARY KEY',
    "kind\\s+text NOT NULL DEFAULT 'fact'",
    'content\\s+text NOT NULL',
    `embedding\\s+vector\\(${EMBEDDING_DIM}\\)`,
  ]) {
    assert.match(createTable.text, new RegExp(col));
  }

  const hnsw = runner.calls.find((c) => /agent_learnings_embedding_hnsw/.test(c.text));
  assert.ok(hnsw, 'HNSW index on agent_learnings.embedding issued');
});

test('ensureSessionSchema additively upgrades agent_learnings with status/superseded_by (#1, mirrors agent_decisions)', async () => {
  const runner = makeFakeRunner();
  await ensureSessionSchema(runner);

  const statusAlter = runner.calls.find(
    (c) => /ALTER TABLE agent_learnings/.test(c.text) && /status/.test(c.text),
  );
  assert.ok(statusAlter, 'agent_learnings.status ADD COLUMN IF NOT EXISTS issued');
  assert.match(statusAlter.text, /ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'/);

  const supersededByAlter = runner.calls.find(
    (c) => /ALTER TABLE agent_learnings/.test(c.text) && /superseded_by/.test(c.text),
  );
  assert.ok(supersededByAlter, 'agent_learnings.superseded_by ADD COLUMN IF NOT EXISTS issued');
  assert.match(supersededByAlter.text, /ADD COLUMN IF NOT EXISTS superseded_by bigint/);

  const statusIdx = runner.calls.find((c) => /agent_learnings_status_idx/.test(c.text));
  assert.ok(statusIdx, 'btree index on agent_learnings.status issued');
});

test('ensureSessionSchema is safe to call repeatedly (idempotent DDL, no throw)', async () => {
  const runner = makeFakeRunner();
  await ensureSessionSchema(runner);
  await ensureSessionSchema(runner);
  // All statements are IF NOT EXISTS; calling twice just doubles the call count.
  const creates = runner.calls.filter((c) => /CREATE TABLE IF NOT EXISTS/.test(c.text));
  assert.equal(creates.length, 6); // 3 tables x 2 runs

  const alters = runner.calls.filter((c) => /ALTER TABLE/.test(c.text));
  assert.equal(alters.length, 8); // 4 additive columns x 2 runs
});
