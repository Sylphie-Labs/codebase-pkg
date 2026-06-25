/**
 * judge.ts -- thin conformity orchestrator (no Neo4j, no sync, no MCP).
 *
 * Composes the pure pieces -- category derivation, skeleton canonicalization,
 * embedding, and kNN pool distance -- into a single call that scores how well a
 * parsed chunk "conforms" to a pool of same-category peers.
 *
 * This is the engine only. Wiring it to the sync pipeline, Neo4j, or the MCP
 * server happens in later steps.
 */

import type { ParsedFunction } from '../sync/ast-parser.js';
import { embed as defaultEmbed, type Embedder } from './embed.js';
import {
  categoryOf,
  signatureSkeleton,
  type Category,
  type SkeletonOptions,
} from './category.js';
import { knnPoolDistance, DEFAULT_K } from './distance.js';

/**
 * One precomputed pool member: a previously-embedded chunk we measure new
 * chunks against. Pool entries are filtered by `category` so a chunk is only
 * ever compared to structural peers.
 */
export interface PoolEntry {
  /** The category this entry belongs to (e.g. `function:signature-skeleton`). */
  category: Category;
  /** The embedding vector for this entry's canonical skeleton. */
  vector: number[];
  /** A stable identifier for the source chunk (e.g. `file.ts:funcName`). */
  identifier: string;
}

/**
 * PROVISIONAL verdict label. Thresholds are NOT calibrated yet -- see the TODO
 * on {@link DRAFT_OUTLIER_THRESHOLD}. Treat `verdict` as a hint, not a gate.
 */
export type Verdict = 'conforms' | 'outlier';

/** The result of judging a single chunk against a pool. */
export interface Judgment {
  /** The category the chunk was classified into. */
  category: Category;
  /** The canonical skeleton text that was embedded. */
  skeleton: string;
  /** Mean cosine distance to the k nearest same-category pool entries. */
  distance: number;
  /** How many same-category pool entries were available to compare against. */
  poolSize: number;
  /** Number of nearest neighbors averaged into `distance`. */
  k: number;
  /** PROVISIONAL verdict derived from a placeholder threshold. */
  verdict: Verdict;
}

/** Options for {@link judgeChunk}. */
export interface JudgeOptions extends SkeletonOptions {
  /** Embedding backend to use. Defaults to the in-process @xenova model. */
  embed?: Embedder;
  /** Nearest-neighbor count for the pool distance. Defaults to {@link DEFAULT_K}. */
  k?: number;
}

/**
 * TODO(calibration): this threshold is a placeholder. The probe established
 * that distance tracks edit magnitude monotonically, but the cut point between
 * "conforms" and "outlier" must be calibrated against real per-category pools
 * before any caller treats the verdict as authoritative.
 */
export const DRAFT_OUTLIER_THRESHOLD = 0.1;

/**
 * Judge a single parsed chunk against a pool of precomputed peers.
 *
 * Derives the chunk's category and canonical skeleton, embeds the skeleton, and
 * measures the mean cosine distance to the k nearest pool entries OF THE SAME
 * CATEGORY. Returns a typed {@link Judgment}. Throws if no same-category peers
 * exist (there is nothing to conform to).
 */
export async function judgeChunk(
  fn: ParsedFunction,
  pool: readonly PoolEntry[],
  opts: JudgeOptions = {},
): Promise<Judgment> {
  const embed = opts.embed ?? defaultEmbed;
  const k = opts.k ?? DEFAULT_K;

  const category = categoryOf(fn);
  const skeleton = signatureSkeleton(fn, opts);

  const peers = pool.filter((e) => e.category === category);
  if (peers.length === 0) {
    throw new Error(
      `judgeChunk: no pool entries for category "${category}" -- nothing to conform to`,
    );
  }

  const [vector] = await embed([skeleton]);
  if (!vector) {
    throw new Error('judgeChunk: embedder returned no vector for the chunk');
  }

  const distance = knnPoolDistance(
    vector,
    peers.map((e) => e.vector),
    k,
  );

  // PROVISIONAL -- see DRAFT_OUTLIER_THRESHOLD TODO.
  const verdict: Verdict =
    distance > DRAFT_OUTLIER_THRESHOLD ? 'outlier' : 'conforms';

  return {
    category,
    skeleton,
    distance,
    poolSize: peers.length,
    k: Math.min(k, peers.length),
    verdict,
  };
}
