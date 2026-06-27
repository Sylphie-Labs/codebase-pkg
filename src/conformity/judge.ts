/**
 * judge.ts -- thin conformity orchestrator (no Neo4j, no sync, no MCP).
 *
 * Composes the pure pieces -- category derivation, representation-text
 * canonicalization (the lightly-normalized whole body), embedding, and kNN pool
 * distance -- into a single call that scores how well a parsed chunk "conforms"
 * to a pool of same-category peers.
 *
 * This is the engine only. Wiring it to the sync pipeline, Neo4j, or the MCP
 * server happens in later steps.
 */

import type { ParsedFunction } from '../sync/ast-parser.js';
import { embed as defaultEmbed, type Embedder } from './embed.js';
import {
  categoryOf,
  representationText,
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
  /** The category this entry belongs to (e.g. `function:body`). */
  category: Category;
  /** The embedding vector for this entry's canonical representation text. */
  vector: number[];
  /** A stable identifier for the source chunk (e.g. `file.ts:funcName`). */
  identifier: string;
}

/**
 * Verdict label. The conforms/outlier boundary is the calibrated per-category
 * threshold (step R2) when one exists; otherwise it falls back to
 * {@link FALLBACK_OUTLIER_THRESHOLD} and the judgment is flagged uncalibrated.
 */
export type Verdict = 'conforms' | 'outlier';

/** The result of judging a single chunk against a pool. */
export interface Judgment {
  /** The category the chunk was classified into. */
  category: Category;
  /** The canonical representation text that was embedded (lightly-normalized body). */
  skeleton: string;
  /** Mean cosine distance to the k nearest same-category pool entries. */
  distance: number;
  /** How many same-category pool entries were available to compare against. */
  poolSize: number;
  /** Number of nearest neighbors averaged into `distance`. */
  k: number;
  /** Verdict: `outlier` if `distance > threshold`, else `conforms`. */
  verdict: Verdict;
  /** The threshold the verdict was decided against (calibrated or fallback). */
  threshold: number;
  /**
   * Whether `threshold` came from a real calibrated value. False means the
   * fallback was used and the verdict should be treated as a weak hint.
   */
  calibrated: boolean;
}

/** Options for {@link judgeChunk}. */
export interface JudgeOptions extends SkeletonOptions {
  /** Embedding backend to use. Defaults to the in-process @huggingface/transformers model. */
  embed?: Embedder;
  /** Nearest-neighbor count for the pool distance. Defaults to {@link DEFAULT_K}. */
  k?: number;
  /**
   * Explicit outlier threshold. {@link judgeChunk} is store-free, so it cannot
   * look up the calibrated value itself -- a caller that has one passes it here.
   * When omitted, {@link FALLBACK_OUTLIER_THRESHOLD} is used and the result is
   * NOT marked calibrated.
   */
  threshold?: number;
}

/**
 * Fallback outlier threshold used ONLY when no calibrated per-category value is
 * available (step R2 calibration not yet run, or a category never seen at
 * calibration time). Research and corpus data showed real in-repo distances are
 * tiny, so this fallback is intentionally conservative; any judgment decided by
 * it is flagged `calibrated: false`. Prefer running `conformity-backfill` /
 * `conformity-calibrate` so the calibrated threshold is used instead.
 */
export const FALLBACK_OUTLIER_THRESHOLD = 0.1;

/**
 * @deprecated Use {@link FALLBACK_OUTLIER_THRESHOLD}. Retained as an alias so
 * existing imports keep working; the value is the uncalibrated fallback.
 */
export const DRAFT_OUTLIER_THRESHOLD = FALLBACK_OUTLIER_THRESHOLD;

/**
 * Judge a single parsed chunk against a pool of precomputed peers.
 *
 * Derives the chunk's category and canonical representation text (lightly-
 * normalized whole body), embeds it, and measures the mean cosine distance to
 * the k nearest pool entries OF THE SAME CATEGORY. Returns a typed
 * {@link Judgment}. Throws if no same-category peers exist (there is nothing to
 * conform to).
 *
 * The conforms/outlier cut is `opts.threshold` when supplied (a caller that has
 * a calibrated value passes it), else {@link FALLBACK_OUTLIER_THRESHOLD}, in
 * which case the result is flagged `calibrated: false`.
 */
export async function judgeChunk(
  fn: ParsedFunction,
  pool: readonly PoolEntry[],
  opts: JudgeOptions = {},
): Promise<Judgment> {
  const embed = opts.embed ?? defaultEmbed;
  const k = opts.k ?? DEFAULT_K;

  const category = categoryOf(fn);
  const skeleton = representationText(fn);

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

  // judgeChunk is store-free: it cannot load the calibrated threshold. Use the
  // caller-supplied threshold if any; otherwise the fallback (flagged below).
  const calibrated = opts.threshold !== undefined;
  const threshold = opts.threshold ?? FALLBACK_OUTLIER_THRESHOLD;
  const verdict: Verdict = distance > threshold ? 'outlier' : 'conforms';

  return {
    category,
    skeleton,
    distance,
    poolSize: peers.length,
    k: Math.min(k, peers.length),
    verdict,
    threshold,
    calibrated,
  };
}
