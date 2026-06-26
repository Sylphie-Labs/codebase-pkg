/**
 * calibration.ts -- step R2: in-distribution outlier-threshold calibration.
 *
 * The verdict no longer leans on a hard-coded distance cut. Instead the
 * "conforms / outlier" boundary is CALIBRATED on the codebase's own distance
 * distribution, per category:
 *
 *   For each pool function, compute its LEAVE-ONE-OUT kNN distance to the rest
 *   of its category pool (i.e. how far it sits from its in-repo peers, judged
 *   the same way a new function would be). Collect those distances and take the
 *   `percentile` (default 0.95) quantile as the threshold. By construction ~95%
 *   of the repo's own code reads as "conforms"; code that exceeds the threshold
 *   is an outlier RELATIVE TO THIS REPO.
 *
 * This module is PURE: it takes already-materialized PoolEntry[] (vectors) and
 * returns calibration rows. It does no DB I/O and no embedding -- persistence
 * lives in the store, and the backfill/calibrate commands wire the two together.
 */

import type { PoolEntry } from './judge.js';
import { knnPoolDistance, DEFAULT_K } from './distance.js';

/** One category's calibrated threshold and the inputs that produced it. */
export interface CalibrationRow {
  /** The category this threshold applies to. */
  category: string;
  /** Outlier cut: distance > threshold => outlier. The `percentile` quantile. */
  threshold: number;
  /** The target true-positive rate the threshold targets (e.g. 0.95). */
  percentile: number;
  /** Nearest-neighbor count used for the leave-one-out distances (clamped). */
  k: number;
  /** How many pool entries fed the distribution (this category's pool size). */
  sampleSize: number;
}

/** Options for {@link computeCalibration}. */
export interface CalibrationOptions {
  /** Nearest-neighbor count for leave-one-out distances. Default {@link DEFAULT_K}. */
  k?: number;
  /** Quantile of the distance distribution to cut at. Default 0.95. */
  percentile?: number;
}

/** Default true-positive rate the threshold targets (~95% of in-repo code conforms). */
export const DEFAULT_PERCENTILE = 0.95;

/**
 * The `p`-quantile of `values` (0 <= p <= 1) using linear interpolation between
 * the two closest ranks (the same method as NumPy's default `linear`).
 *
 * `values` may be unsorted -- it is copied and sorted internally. Throws on an
 * empty input (there is no quantile of nothing). A single value is its own
 * quantile for every p. Clamps p into [0, 1].
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new Error('percentile: empty input');
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;

  const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
  // Rank in [0, n-1]; interpolate between floor and ceil.
  const rank = clamped * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

/**
 * Compute per-category calibration rows from a pool of embedded entries.
 *
 * Groups `entries` by category. For each category, for every entry, measures its
 * leave-one-out kNN distance to the OTHER same-category entries (excluding the
 * entry itself by identifier), then sets `threshold` to the `percentile` quantile
 * of those distances.
 *
 * Tiny pools are handled gracefully: `k` is clamped so it never exceeds the
 * number of remaining peers (poolSize - 1). A category with a single entry has
 * no peers to compare against, so its only leave-one-out distance is 0 and the
 * threshold is 0 -- the real `sampleSize` (1) is still reported so callers can
 * see the pool is degenerate. Categories with zero entries are not emitted.
 */
export function computeCalibration(
  entries: readonly PoolEntry[],
  opts: CalibrationOptions = {},
): CalibrationRow[] {
  const targetK = opts.k ?? DEFAULT_K;
  const p = opts.percentile ?? DEFAULT_PERCENTILE;

  // Group entries by category, preserving first-seen order for stable output.
  const byCategory = new Map<string, PoolEntry[]>();
  for (const e of entries) {
    const bucket = byCategory.get(e.category);
    if (bucket) bucket.push(e);
    else byCategory.set(e.category, [e]);
  }

  const rows: CalibrationRow[] = [];
  for (const [category, pool] of byCategory) {
    const sampleSize = pool.length;
    // Clamp k to the number of leave-one-out peers (at least 1 so knnPoolDistance
    // gets a valid k). With a single-entry pool there are no peers; distance is 0.
    const effectiveK = Math.max(1, Math.min(targetK, sampleSize - 1));

    const distances: number[] = [];
    for (const entry of pool) {
      const peers = pool.filter((o) => o.identifier !== entry.identifier);
      if (peers.length === 0) {
        // No peer to conform to -> trivially zero distance (degenerate pool).
        distances.push(0);
        continue;
      }
      distances.push(
        knnPoolDistance(
          entry.vector,
          peers.map((o) => o.vector),
          effectiveK,
        ),
      );
    }

    rows.push({
      category,
      threshold: percentile(distances, p),
      percentile: p,
      k: effectiveK,
      sampleSize,
    });
  }

  return rows;
}
