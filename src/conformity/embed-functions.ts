/**
 * embed-functions.ts -- step 3 of the Conformity Judge: build the descriptive
 * pool by embedding committed function chunks into the cold store.
 *
 * This module is the shared core used by BOTH the incremental sync hook
 * (sync-pipeline.ts) and the cold-start backfill (runConformityBackfill). It
 * takes parsed functions, derives the per-category canonical skeleton, batch-
 * embeds the skeletons, and upserts the resulting vectors into the
 * ConformityStore keyed by stable node id.
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
import { categoryOf, signatureSkeleton } from './category.js';
import { embed as realEmbed, CHOSEN_MODEL, MODEL_CANDIDATES, type Embedder } from './embed.js';
import {
  createConformityStore,
  nodeIdOf,
  type ConformityStore,
  type VectorRecord,
} from './store.js';

/**
 * Maximum number of skeletons handed to the embedder in a single call. The real
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
  /** Functions whose skeletons were embedded and upserted. */
  embedded: number;
  /** Functions skipped (e.g. empty derived skeleton). */
  skipped: number;
}

/**
 * Derive category + signature skeleton for each function, batch-embed the
 * skeletons, and upsert one vector per function into the store.
 *
 * The model id stamped on each row is captured AFTER embedding from
 * {@link CHOSEN_MODEL} (the model the real backend actually loaded), falling
 * back to MODEL_CANDIDATES[0] when it is still null (e.g. an injected fake
 * embedder never set it). An explicit `opts.model` overrides both.
 */
export async function embedAndStoreFunctions(
  functions: ParsedFunction[],
  opts: EmbedAndStoreOptions = {},
): Promise<EmbedAndStoreResult> {
  const store = opts.store ?? createConformityStore();
  const embedder = opts.embedder ?? realEmbed;

  // Derive (nodeId, category, skeleton) for every function up front. Functions
  // whose skeleton comes back empty are skipped (nothing meaningful to embed).
  type Pending = { nodeId: string; category: string; skeleton: string };
  const pending: Pending[] = [];
  let skipped = 0;

  for (const fn of functions) {
    const skeleton = signatureSkeleton(fn, { normalized: true });
    if (!skeleton || skeleton.trim() === '') {
      skipped++;
      continue;
    }
    pending.push({
      nodeId: nodeIdOf(fn),
      category: categoryOf(fn),
      skeleton,
    });
  }

  if (pending.length === 0) {
    return { embedded: 0, skipped };
  }

  let embedded = 0;

  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedder(batch.map((p) => p.skeleton));

    if (vectors.length !== batch.length) {
      throw new Error(
        `embedAndStoreFunctions: embedder returned ${vectors.length} vectors ` +
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
