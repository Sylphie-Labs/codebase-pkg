/**
 * distance.ts -- cosine distance + kNN pool distance.
 *
 * Vectors from the embedder are already mean-pooled and L2-normalized, but we
 * do NOT assume that here (these helpers are also unit-tested with hand-rolled
 * vectors), so cosineSimilarity normalizes defensively.
 */

/** Default number of nearest neighbors used for pool distance. */
export const DEFAULT_K = 5;

/** Dot product of two equal-length vectors. */
export function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** L2 norm. */
export function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity in [-1, 1]; 0 if either vector is zero-length. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/** Cosine distance in [0, 2]; 0 == identical direction. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Mean cosine distance from `vec` to its k nearest neighbors within `pool`.
 *
 * kNN (not centroid) because signature pools are multi-cluster: the natural
 * "conformity" reference for a chunk is the local cluster it sits near, not the
 * global mean of unrelated shapes. `k` is clamped to the pool size.
 *
 * @param vec   the query vector
 * @param pool  candidate neighbor vectors
 * @param k     number of nearest neighbors to average (default {@link DEFAULT_K})
 * @returns mean cosine distance to the k closest pool entries
 */
export function knnPoolDistance(
  vec: readonly number[],
  pool: readonly (readonly number[])[],
  k: number = DEFAULT_K,
): number {
  if (pool.length === 0) {
    throw new Error('knnPoolDistance: empty pool');
  }
  const dists = pool.map((p) => cosineDistance(vec, p));
  dists.sort((x, y) => x - y);
  const take = Math.min(k, dists.length);
  let s = 0;
  for (let i = 0; i < take; i++) s += dists[i]!;
  return s / take;
}

/** A pool member with the vector the judge measures it by. */
export interface VectorEntry {
  /** Vector to measure distance against. */
  vector: readonly number[];
}

/** A nearest-neighbor result: the matched entry plus its cosine distance. */
export interface NearestNeighbor<E> {
  entry: E;
  /** Cosine distance from the query vector to this entry, in [0, 2]. */
  distance: number;
}

/**
 * The k nearest pool entries to `vec`, each WITH its cosine distance, ascending
 * by distance. Unlike {@link knnPoolDistance} (which averages distances into a
 * single score), this preserves identity so callers can report "what you're
 * closest to / diverging from."
 *
 * `k` is clamped to the pool size. Returns [] for an empty pool (rather than
 * throwing, since the natural answer to "the nearest neighbors" is "none").
 *
 * Ties (equal distance) preserve the pool's input order, since the sort below
 * is stable for equal keys in V8.
 */
export function knnNearest<E extends VectorEntry>(
  vec: readonly number[],
  pool: readonly E[],
  k: number = DEFAULT_K,
): NearestNeighbor<E>[] {
  if (pool.length === 0) return [];
  const scored = pool.map((entry) => ({
    entry,
    distance: cosineDistance(vec, entry.vector),
  }));
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, Math.max(0, Math.min(k, scored.length)));
}
