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
