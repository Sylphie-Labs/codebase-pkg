/**
 * schema.ts -- idempotent pgvector schema bootstrap for the session-capture
 * layer (agent memory: events / decisions / learnings).
 *
 * Lives in the SAME per-instance Postgres the Conformity Judge uses (see
 * ../conformity/pg-client.ts), as three additional tables:
 *   - agent_events     -- what a session was asked + what it concluded.
 *   - agent_decisions  -- durable repo decisions ("do X instead of Y"),
 *                         with a supersede chain (status + superseded_by).
 *   - agent_learnings  -- freestanding facts/patterns/gotchas worth recalling.
 *
 * Mirrors ../conformity/schema.ts exactly: CREATE TABLE/INDEX IF NOT EXISTS,
 * called unconditionally before any write (see ../conformity/conformity-
 * backfill.ts's `await ensureSchema(realPgRunner)` at the top of a run) rather
 * than cached -- Postgres makes the idempotent DDL cheap, and this keeps the
 * store dead simple with no schema-readiness state to get out of sync.
 *
 * IMPORTANT: like the conformity cold store, the embedding dimension is baked
 * into the column type (`vector(EMBEDDING_DIM)`). We reuse conformity's
 * EMBEDDING_DIM (768, jinaai/jina-embeddings-v2-base-code) rather than
 * redeclaring it, so the two stores can never drift out of sync on dimension.
 * Changing it is a schema migration, not a config flip.
 */

import type { PgRunner } from '../conformity/pg-client.js';
import { EMBEDDING_DIM } from '../conformity/schema.js';

export { EMBEDDING_DIM };

/** Name of the session-event table. */
export const AGENT_EVENTS_TABLE = 'agent_events';

/** Name of the durable-decision table. */
export const AGENT_DECISIONS_TABLE = 'agent_decisions';

/** Name of the freestanding-learning table. */
export const AGENT_LEARNINGS_TABLE = 'agent_learnings';

/**
 * Create the pgvector extension and the three session-capture tables (+
 * their HNSW cosine indexes) if they do not already exist, THEN apply any
 * additive column upgrades via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
 * Safe to call repeatedly (idempotent). Statements are issued separately,
 * matching ../conformity/schema.ts's reasoning (some Postgres setups
 * disallow multiple commands in a single simple-query, and CREATE EXTENSION
 * wants its own statement boundary).
 *
 * MIGRATION SAFETY: every column added after the initial CREATE TABLE goes
 * through `ADD COLUMN IF NOT EXISTS` here rather than a versioned migration
 * file -- there are multiple live consumer instances (separate repos, each
 * with their own Postgres) already running the pre-upgrade schema, and this
 * function runs unconditionally on every process start (see ensureReady in
 * ./store.ts). An additive, idempotent ALTER is the only shape that upgrades
 * all of them transparently on next connection with no coordinated migration
 * step and no destructive DDL.
 */
export async function ensureSessionSchema(runner: PgRunner): Promise<void> {
  await runner.query('CREATE EXTENSION IF NOT EXISTS vector;');
  // Additive upgrade (MCP-SERVER-IMPROVEMENTS.md #6): pg_trgm backs the
  // lexical half of recallSimilar's hybrid score (SessionStore.recallSimilar
  // -- similarity(text, query) via trigram overlap). Confirmed present in the
  // shipped `pgvector/pgvector:pg16` image's contrib set (same Postgres distro
  // vector ships from), so this needs no new image/extra install step -- just
  // the same idempotent CREATE EXTENSION pattern as vector above. No new
  // table/column, no GIN index: the lexical score is computed inline over the
  // small per-kind candidate set recallSimilar already fetches by cosine
  // distance, not a full-table trigram scan, so an index buys nothing here.
  await runner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

  // --- agent_events ---------------------------------------------------------
  await runner.query(
    `CREATE TABLE IF NOT EXISTS ${AGENT_EVENTS_TABLE} (
       id         bigserial PRIMARY KEY,
       created_at timestamptz NOT NULL DEFAULT now(),
       session_id text,
       repo       text,
       query      text NOT NULL,
       summary    text NOT NULL,
       caveats    jsonb NOT NULL DEFAULT '[]',
       meta       jsonb NOT NULL DEFAULT '{}',
       graph_refs jsonb NOT NULL DEFAULT '[]',
       model      text,
       embedding  vector(${EMBEDDING_DIM})
     );`,
  );
  await runner.query(
    `CREATE INDEX IF NOT EXISTS agent_events_embedding_hnsw ` +
      `ON ${AGENT_EVENTS_TABLE} USING hnsw (embedding vector_cosine_ops);`,
  );
  await runner.query(
    `CREATE INDEX IF NOT EXISTS agent_events_session_idx ` +
      `ON ${AGENT_EVENTS_TABLE} (session_id);`,
  );
  // Additive upgrade (post-0.5.4): per-caveat resolution ledger (#5) --
  // resolving a caveat appends here rather than mutating/deleting the
  // immutable `caveats` array, so recall can render `[resolved <date>: ...]`
  // while the original text (and the fact that a resolution happened) stays
  // auditable forever. One row per resolution: {caveatIndex, resolvedAt, note?}.
  await runner.query(
    `ALTER TABLE ${AGENT_EVENTS_TABLE} ` +
      `ADD COLUMN IF NOT EXISTS resolutions jsonb NOT NULL DEFAULT '[]';`,
  );
  // Additive upgrade (post-0.5.4): last-write timestamp for the recordSession
  // upsert-by-sessionId path (#8) -- `created_at` stays the TRUE creation time
  // of the row (first segment), `updated_at` moves forward on every appended
  // segment so a caller can tell a row was extended without diffing summary text.
  await runner.query(
    `ALTER TABLE ${AGENT_EVENTS_TABLE} ` +
      `ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();`,
  );

  // --- agent_decisions -------------------------------------------------------
  await runner.query(
    `CREATE TABLE IF NOT EXISTS ${AGENT_DECISIONS_TABLE} (
       id            bigserial PRIMARY KEY,
       created_at    timestamptz NOT NULL DEFAULT now(),
       session_id    text,
       decision      text NOT NULL,
       instead_of    text,
       context       text,
       scope         text,
       status        text NOT NULL DEFAULT 'active',
       superseded_by bigint,
       meta          jsonb NOT NULL DEFAULT '{}',
       graph_refs    jsonb NOT NULL DEFAULT '[]',
       embedding     vector(${EMBEDDING_DIM})
     );`,
  );
  await runner.query(
    `CREATE INDEX IF NOT EXISTS agent_decisions_embedding_hnsw ` +
      `ON ${AGENT_DECISIONS_TABLE} USING hnsw (embedding vector_cosine_ops);`,
  );
  // recallSimilar's default (status='active' unless includeSuperseded) filters
  // on this column on every call, so it earns a plain btree index -- the same
  // reasoning as cfm_decisions_axis_idx in ../conformity/schema.ts.
  await runner.query(
    `CREATE INDEX IF NOT EXISTS agent_decisions_status_idx ` +
      `ON ${AGENT_DECISIONS_TABLE} (status);`,
  );

  // --- agent_learnings -------------------------------------------------------
  await runner.query(
    `CREATE TABLE IF NOT EXISTS ${AGENT_LEARNINGS_TABLE} (
       id         bigserial PRIMARY KEY,
       created_at timestamptz NOT NULL DEFAULT now(),
       session_id text,
       kind       text NOT NULL DEFAULT 'fact',
       content    text NOT NULL,
       meta       jsonb NOT NULL DEFAULT '{}',
       graph_refs jsonb NOT NULL DEFAULT '[]',
       embedding  vector(${EMBEDDING_DIM})
     );`,
  );
  await runner.query(
    `CREATE INDEX IF NOT EXISTS agent_learnings_embedding_hnsw ` +
      `ON ${AGENT_LEARNINGS_TABLE} USING hnsw (embedding vector_cosine_ops);`,
  );
  // Additive upgrade (post-0.5.4): mirror agent_decisions' amend/supersede
  // model onto learnings (#1) -- a learning that turns out wrong/weak can now
  // be superseded instead of leaving a near-duplicate row polluting recall
  // forever. Same shape, same semantics: status defaults 'active',
  // superseded_by is set atomically with the superseding insert.
  await runner.query(
    `ALTER TABLE ${AGENT_LEARNINGS_TABLE} ` +
      `ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';`,
  );
  await runner.query(
    `ALTER TABLE ${AGENT_LEARNINGS_TABLE} ` +
      `ADD COLUMN IF NOT EXISTS superseded_by bigint;`,
  );
  // recallSimilar's default (status='active' unless includeSuperseded) filters
  // on this column on every call -- same reasoning as agent_decisions_status_idx.
  await runner.query(
    `CREATE INDEX IF NOT EXISTS agent_learnings_status_idx ` +
      `ON ${AGENT_LEARNINGS_TABLE} (status);`,
  );
}
