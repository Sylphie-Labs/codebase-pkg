/**
 * embed-functions.ts -- step 3 of the Conformity Judge: build the descriptive
 * pool by embedding committed function chunks into the cold store.
 *
 * This module is the shared core used by BOTH the incremental sync hook
 * (sync-pipeline.ts) and the cold-start backfill (runConformityBackfill). It
 * takes parsed functions, derives the per-category canonical representation
 * text (the lightly-normalized whole body), batch-embeds it, and upserts the
 * resulting vectors into the ConformityStore keyed by stable node id.
 *
 * Injectability: both the store and the embedder are injectable, so unit tests
 * exercise the selection/derivation logic with a deterministic fake embedder
 * and a fake store -- no live Postgres and no model download required. The real
 * defaults (the in-process @xenova embedder + the real pool-backed store) are
 * only constructed when no override is supplied.
 *
 * This module deliberately does NOT build any judgment/query surface (that is
 * step 4: the MCP tool / CLI judge). It only writes the descriptive pool.
 */

import type { ParsedFunction } from '../sync/ast-parser.js';
import { categoryOf, representationText, type ParsedChunk } from './category.js';
import { embed as realEmbed, CHOSEN_MODEL, MODEL_CANDIDATES, type Embedder } from './embed.js';
import {
  createConformityStore,
  nodeIdOf,
  type ConformityStore,
  type VectorRecord,
} from './store.js';

/**
 * Maximum number of texts handed to the embedder in a single call. The real
 * @xenova backend embeds sequentially internally, but capping the batch keeps
 * memory bounded and gives predictable progress on large repos.
 */
export const EMBED_BATCH_SIZE = 64;

/** Options for {@link embedAndStoreFunctions}. */
export interface EmbedAndStoreOptions {
  /** Vector store to upsert into. Defaults to the real pool-backed store. */
  store?: ConformityStore;
  /** Embedding backend. Defaults to the real in-process @xenova embedder. */
  embedder?: Embedder;
  /**
   * Explicit model id to record on each row. Normally omitted: the model is
   * captured from {@link CHOSEN_MODEL} after the real embedder loads, falling
   * back to MODEL_CANDIDATES[0]. Tests pass this so the recorded model is
   * deterministic without loading a model.
   */
  model?: string;
}

/** Result of an embed-and-store pass. */
export interface EmbedAndStoreResult {
  /** Chunks whose representation text was embedded and upserted. */
  embedded: number;
  /** Chunks skipped (e.g. empty derived representation text). */
  skipped: number;
}

/**
 * CORE: derive category + representation text (lightly-normalized whole body)
 * for each parsed chunk -- a function OR a type/class -- batch-embed it, and
 * upsert one vector per chunk into the store. The category is derived PER CHUNK
 * via {@link categoryOf}, so functions land in `function:body` and types in
 * `type:body` from the SAME pipeline; the store keys/judges each pool
 * independently. This is the engine-agnostic path; {@link embedAndStoreFunctions}
 * is a thin function-typed wrapper kept for existing callers/tests.
 *
 * The model id stamped on each row is captured AFTER embedding from
 * {@link CHOSEN_MODEL} (the model the real backend actually loaded), falling
 * back to MODEL_CANDIDATES[0] when it is still null (e.g. an injected fake
 * embedder never set it). An explicit `opts.model` overrides both.
 */
export async function embedAndStoreChunks(
  chunks: ParsedChunk[],
  opts: EmbedAndStoreOptions = {},
): Promise<EmbedAndStoreResult> {
  const store = opts.store ?? createConformityStore();
  const embedder = opts.embedder ?? realEmbed;

  // Derive (nodeId, category, text) for every chunk up front. Chunks whose
  // representation text comes back empty (e.g. an empty body) are skipped
  // (nothing meaningful to embed).
  type Pending = { nodeId: string; category: string; text: string };
  const pending: Pending[] = [];
  let skipped = 0;

  for (const chunk of chunks) {
    const text = representationText(chunk);
    if (!text || text.trim() === '') {
      skipped++;
      continue;
    }
    pending.push({
      nodeId: nodeIdOf(chunk),
      category: categoryOf(chunk),
      text,
    });
  }

  if (pending.length === 0) {
    return { embedded: 0, skipped };
  }

  let embedded = 0;

  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedder(batch.map((p) => p.text));

    if (vectors.length !== batch.length) {
      throw new Error(
        `embedAndStoreChunks: embedder returned ${vectors.length} vectors ` +
          `for ${batch.length} inputs`,
      );
    }

    // Capture the model id only after embedding, when CHOSEN_MODEL is populated
    // by the real backend. opts.model wins; otherwise CHOSEN_MODEL; otherwise
    // the primary candidate.
    const model = opts.model ?? CHOSEN_MODEL ?? MODEL_CANDIDATES[0];

    const records: VectorRecord[] = batch.map((p, j) => ({
      nodeId: p.nodeId,
      category: p.category,
      vector: vectors[j],
      model,
    }));

    await store.upsertVectors(records);
    embedded += records.length;
  }

  return { embedded, skipped };
}

/**
 * Embed and store a list of parsed FUNCTIONS. Thin wrapper over
 * {@link embedAndStoreChunks} kept for existing callers/tests; functions route
 * through the same core and derive `function:body` via {@link categoryOf}.
 */
export async function embedAndStoreFunctions(
  functions: ParsedFunction[],
  opts: EmbedAndStoreOptions = {},
): Promise<EmbedAndStoreResult> {
  return embedAndStoreChunks(functions, opts);
}
