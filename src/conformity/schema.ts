/**
 * schema.ts -- idempotent pgvector schema bootstrap for the Conformity Judge
 * cold store.
 *
 * The cold store is a single table `cfm_vectors` holding one embedding per code
 * node, keyed by a stable node id (see nodeIdOf in store.ts). Embeddings live in
 * a fixed-width pgvector column, so the dimension is part of the schema.
 *
 * IMPORTANT: the embedding dimension and model are baked into the column type
 * (`vector(EMBEDDING_DIM)`). Changing the model to one with a different
 * dimension -- or changing EMBEDDING_DIM -- requires an explicit migration
 * (ALTER the column / re-embed every row); `CREATE TABLE IF NOT EXISTS` will NOT
 * migrate an existing table. Today's primary model is
 * jinaai/jina-embeddings-v2-base-code, which emits 768-dim vectors. (Nothing is
 * deployed yet, so no migration script is needed -- but keep this guarantee.)
 */

import type { PgRunner } from './pg-client.js';

/**
 * Embedding dimension for the cold store's pgvector column. Single source of
 * truth: the CREATE TABLE DDL below and the store's dimension guard both read
 * this constant. Matches the primary conformity model
 * (jinaai/jina-embeddings-v2-base-code, 768-dim). Changing this is a schema
 * migration, not a config flip -- see the file header.
 */
export const EMBEDDING_DIM = 768;

/** Name of the cold-store table. */
export const VECTORS_TABLE = 'cfm_vectors';

/**
 * Create the pgvector extension, the cfm_vectors table, and the category index
 * if they do not already exist. Safe to call repeatedly (idempotent).
 *
 * Statements are issued separately because some Postgres setups disallow
 * multiple commands in a single simple-query when params are involved, and
 * because `CREATE EXTENSION` may need its own statement boundary.
 */
export async function ensureSchema(runner: PgRunner): Promise<void> {
  await runner.query('CREATE EXTENSION IF NOT EXISTS vector;');

  await runner.query(
    `CREATE TABLE IF NOT EXISTS ${VECTORS_TABLE} (
       node_id    text PRIMARY KEY,
       category   text NOT NULL,
       embedding  vector(${EMBEDDING_DIM}) NOT NULL,
       model      text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     );`,
  );

  await runner.query(
    `CREATE INDEX IF NOT EXISTS cfm_vectors_category_idx
       ON ${VECTORS_TABLE} (category);`,
  );
}
