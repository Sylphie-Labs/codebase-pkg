/**
 * distance.mjs -- cosine distance + kNN pool distance.
 *
 * Vectors from the embedder are already mean-pooled and L2-normalized, but we
 * do NOT assume that here (these helpers are also unit-tested with hand-rolled
 * vectors), so cosineSimilarity normalizes defensively.
 */

export const K = 5; // number of nearest neighbors used for pool distance

/** Dot product of two equal-length vectors. */
export function dot(a, b) {
  if (a.length !== b.length) {
    throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** L2 norm. */
export function norm(a) {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity in [-1, 1]; 0 if either vector is zero-length. */
export function cosineSimilarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/** Cosine distance in [0, 2]; 0 == identical direction. */
export function cosineDistance(a, b) {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Mean cosine distance from `vec` to its k nearest neighbors within `pool`.
 *
 * kNN (not centroid) because signature pools are multi-cluster: the natural
 * "conformity" reference for a chunk is the local cluster it sits near, not
 * the global mean of unrelated shapes.
 *
 * @param {number[]} vec
 * @param {number[][]} pool   candidate neighbor vectors
 * @param {number} k
 * @returns {number} mean cosine distance to the k closest pool entries
 */
export function knnPoolDistance(vec, pool, k = K) {
  if (pool.length === 0) {
    throw new Error('knnPoolDistance: empty pool');
  }
  const dists = pool.map((p) => cosineDistance(vec, p));
  dists.sort((x, y) => x - y);
  const take = Math.min(k, dists.length);
  let s = 0;
  for (let i = 0; i < take; i++) s += dists[i];
  return s / take;
}
