/**
 * store.ts -- the Conformity Judge vector data layer: a pgvector cold store with
 * an in-memory hot cache, producing PoolEntry[] for the judge engine.
 *
 * Two tiers:
 *   - COLD: the `cfm_vectors` Postgres/pgvector table. Durable, queryable,
 *     supports an approximate-nearest-neighbor escape hatch (coldNearest).
 *   - HOT:  an in-instance Map<category, PoolEntry[]>. The judge reads whole
 *     per-category pools repeatedly (knnPoolDistance walks the entire pool), so
 *     we cache the materialized PoolEntry[] per category and serve from memory.
 *
 * Injectability: the store takes a {@link PgRunner}. Production passes the real
 * pool-backed runner; tests pass a fake that records SQL and returns canned
 * rows. The hot cache is held on the instance (NOT module-global) so each test
 * gets an isolated cache.
 *
 * Single-process assumption: the hot cache is invalidated only by writes made
 * THROUGH this same store instance. A second process (or a second store) writing
 * to Postgres would NOT invalidate this cache.
 * TODO(multi-writer): if the judge ever runs alongside concurrent writers, add
 * an invalidation signal (LISTEN/NOTIFY on cfm_vectors, or a version/epoch
 * column polled before serving the cache) instead of trusting local writes.
 *
 * This module does NOT touch the sync pipeline, mutation builder, init/Docker
 * provisioning, or the MCP server -- that wiring comes in later steps.
 */

import type { ParsedFunction } from '../sync/ast-parser.js';
import type { PoolEntry } from './judge.js';
import type { Category } from './category.js';
import { type PgRunner, realPgRunner } from './pg-client.js';
import { EMBEDDING_DIM, VECTORS_TABLE, CALIBRATION_TABLE } from './schema.js';
import type { CalibrationRow } from './calibration.js';

/** A vector destined for the cold store. */
export interface VectorRecord {
  /** Stable node id, e.g. `file.ts::funcName` (see {@link nodeIdOf}). */
  nodeId: string;
  /** The conformity category this vector belongs to. */
  category: string;
  /** The embedding; must have length {@link EMBEDDING_DIM}. */
  vector: number[];
  /** The embedding model id that produced the vector. */
  model: string;
}

/** One cold-store nearest-neighbor hit. */
export interface NearestHit {
  nodeId: string;
  /** Cosine distance (pgvector `<=>` operator), in [0, 2]. */
  distance: number;
}

/** A loaded calibration row: the calibrated threshold + the inputs behind it. */
export interface StoredCalibration {
  /** Outlier cut for this category: distance > threshold => outlier. */
  threshold: number;
  /** The true-positive rate the threshold targets (e.g. 0.95). */
  percentile: number;
  /** Nearest-neighbor count used when calibrating. */
  k: number;
  /** Pool size the distribution was computed over. */
  sampleSize: number;
  /** The embedding model the calibration was computed against. */
  model: string;
}

/**
 * Stable id for a parsed function, matching the convention used elsewhere for
 * node identity (`<filePath>::<name>`). Vectors are keyed by this so the cold
 * store lines up with Neo4j node identity. Reuse this anywhere a node id is
 * needed rather than re-deriving the format.
 */
export function nodeIdOf(fn: ParsedFunction): string {
  return `${fn.filePath}::${fn.name}`;
}

/**
 * Render a JS number[] into pgvector's text input form, e.g. `[0.1,0.2,0.3]`.
 * pgvector accepts this literal for both inserts and the `<=>` query operand.
 */
function toPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Parse pgvector's text output form (`[0.1,0.2,...]`) back into a number[].
 * Tolerates surrounding whitespace; empty brackets yield an empty array.
 */
function parsePgVector(text: string): number[] {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (inner === '') return [];
  return inner.split(',').map((s) => Number(s));
}

/**
 * The vector data layer. One instance owns one hot cache. Construct with a
 * {@link PgRunner}; the default is the real pool-backed runner.
 *
 * pgvector cosine note: distances use the `<=>` operator, which is COSINE
 * distance, the metric the judge engine uses (cosineDistance = 1 - cosineSim).
 * A matching ANN index would use the `vector_cosine_ops` opclass; index creation
 * is deferred to the provisioning step, but `<=>` works without an index.
 */
export class ConformityStore {
  private readonly runner: PgRunner;
  /** category -> materialized pool. Instance-scoped for test isolation. */
  private readonly hotCache = new Map<string, PoolEntry[]>();
  /**
   * category -> calibration row (or null = "looked up, no row exists").
   * Instance-scoped like the pool cache; invalidated per-category on
   * setCalibration. `undefined` (absent key) means "not yet looked up".
   */
  private readonly calibrationCache = new Map<string, StoredCalibration | null>();

  constructor(runner: PgRunner = realPgRunner) {
    this.runner = runner;
  }

  /** Drop the entire hot cache. For tests/teardown and bulk invalidation. */
  clearHotCache(): void {
    this.hotCache.clear();
    this.calibrationCache.clear();
  }

  /** Invalidate the cached pool for each given category. */
  private invalidateCategories(categories: Iterable<string>): void {
    for (const c of categories) this.hotCache.delete(c);
  }

  /**
   * Batched upsert of vectors into the cold store. Inserts new rows and updates
   * existing ones (ON CONFLICT (node_id) DO UPDATE). Invalidates the hot cache
   * for every category touched, so the next loadPool re-reads from Postgres.
   *
   * Throws if any vector's length !== {@link EMBEDDING_DIM} (a wrong-dimension
   * row would be rejected by the fixed-width pgvector column anyway; we fail
   * early with a clear message).
   */
  async upsertVectors(entries: VectorRecord[]): Promise<void> {
    if (entries.length === 0) return;

    for (const e of entries) {
      if (e.vector.length !== EMBEDDING_DIM) {
        throw new Error(
          `upsertVectors: vector for "${e.nodeId}" has length ${e.vector.length}, ` +
            `expected ${EMBEDDING_DIM}`,
        );
      }
    }

    // Build a single multi-row VALUES list. Each row contributes 4 params:
    // node_id, category, embedding (pgvector text literal), model.
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const e of entries) {
      const base = params.length;
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(e.nodeId, e.category, toPgVector(e.vector), e.model);
    }

    const sql =
      `INSERT INTO ${VECTORS_TABLE} (node_id, category, embedding, model) ` +
      `VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT (node_id) DO UPDATE SET ` +
      `category = EXCLUDED.category, ` +
      `embedding = EXCLUDED.embedding, ` +
      `model = EXCLUDED.model, ` +
      `updated_at = now();`;

    await this.runner.query(sql, params);

    this.invalidateCategories(new Set(entries.map((e) => e.category)));
  }

  /**
   * Delete vectors by node id and invalidate the affected categories' caches.
   *
   * Cache-invalidation strategy: rather than a second round-trip to look up each
   * deleted row's category (the rows are about to be gone), we CLEAR THE WHOLE
   * hot cache. Deletes are comparatively rare (removed/renamed chunks) and
   * clearing is always correct; this trades a little cache warmth for
   * simplicity and guaranteed correctness.
   */
  async deleteVectors(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    await this.runner.query(
      `DELETE FROM ${VECTORS_TABLE} WHERE node_id = ANY($1);`,
      [nodeIds],
    );
    this.clearHotCache();
  }

  /**
   * Load the full PoolEntry[] for a category -- the HOT path.
   *
   * Returns the cached pool if present; otherwise reads every row for the
   * category from Postgres, parses each pgvector back into a number[], builds
   * PoolEntry[] (identifier = node_id), caches it, and returns it.
   */
  async loadPool(category: string): Promise<PoolEntry[]> {
    const cached = this.hotCache.get(category);
    if (cached) return cached;

    const { rows } = await this.runner.query(
      `SELECT node_id, embedding FROM ${VECTORS_TABLE} WHERE category = $1;`,
      [category],
    );

    const pool: PoolEntry[] = (rows as Array<{ node_id: string; embedding: string }>).map(
      (r) => ({
        category: category as Category,
        vector: parsePgVector(r.embedding),
        identifier: r.node_id,
      }),
    );

    this.hotCache.set(category, pool);
    return pool;
  }

  /**
   * Cold-store nearest-neighbor escape hatch: the k closest rows in `category`
   * to `vector` by cosine distance, computed in Postgres via pgvector's `<=>`
   * operator (cosine distance). Bypasses the hot cache entirely -- use this when
   * you want pushdown ranking rather than materializing the whole pool.
   *
   * `<=>` is the cosine-distance operator; the corresponding ANN index opclass
   * is `vector_cosine_ops` (index creation handled at provisioning time).
   */
  async coldNearest(category: string, vector: number[], k: number): Promise<NearestHit[]> {
    if (vector.length !== EMBEDDING_DIM) {
      throw new Error(
        `coldNearest: query vector has length ${vector.length}, expected ${EMBEDDING_DIM}`,
      );
    }
    const literal = toPgVector(vector);
    const { rows } = await this.runner.query(
      `SELECT node_id, embedding <=> $1 AS distance ` +
        `FROM ${VECTORS_TABLE} WHERE category = $2 ` +
        `ORDER BY embedding <=> $1 LIMIT $3;`,
      [literal, category, k],
    );
    return (rows as Array<{ node_id: string; distance: number | string }>).map((r) => ({
      nodeId: r.node_id,
      distance: Number(r.distance),
    }));
  }

  /**
   * Upsert per-category calibration rows (step R2). One row per category keyed by
   * `category` (ON CONFLICT DO UPDATE). The `model` records which embedding model
   * the thresholds were calibrated against, so a stale calibration is detectable.
   * Invalidates the per-category calibration cache for every row written, so the
   * next getCalibration re-reads the fresh value.
   */
  async setCalibration(rows: Array<CalibrationRow & { model: string }>): Promise<void> {
    if (rows.length === 0) return;

    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const r of rows) {
      const base = params.length;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
      );
      params.push(r.category, r.threshold, r.percentile, r.k, r.sampleSize, r.model);
    }

    const sql =
      `INSERT INTO ${CALIBRATION_TABLE} ` +
      `(category, threshold, percentile, k, sample_size, model) ` +
      `VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT (category) DO UPDATE SET ` +
      `threshold = EXCLUDED.threshold, ` +
      `percentile = EXCLUDED.percentile, ` +
      `k = EXCLUDED.k, ` +
      `sample_size = EXCLUDED.sample_size, ` +
      `model = EXCLUDED.model, ` +
      `updated_at = now();`;

    await this.runner.query(sql, params);

    for (const r of rows) this.calibrationCache.delete(r.category);
  }

  /**
   * Load the calibrated threshold for a category, or null if none exists yet.
   *
   * Cached per-instance like {@link loadPool}: a hit (including a cached "no row"
   * = null) serves from memory; a miss reads Postgres once and caches the result.
   * The cache is invalidated per-category on {@link setCalibration}.
   */
  async getCalibration(category: string): Promise<StoredCalibration | null> {
    const cached = this.calibrationCache.get(category);
    if (cached !== undefined) return cached;

    const { rows } = await this.runner.query(
      `SELECT threshold, percentile, k, sample_size, model ` +
        `FROM ${CALIBRATION_TABLE} WHERE category = $1;`,
      [category],
    );

    const row = (rows as Array<{
      threshold: number | string;
      percentile: number | string;
      k: number | string;
      sample_size: number | string;
      model: string;
    }>)[0];

    const result: StoredCalibration | null = row
      ? {
          threshold: Number(row.threshold),
          percentile: Number(row.percentile),
          k: Number(row.k),
          sampleSize: Number(row.sample_size),
          model: row.model,
        }
      : null;

    this.calibrationCache.set(category, result);
    return result;
  }
}

/** Convenience factory mirroring the class constructor's default runner. */
export function createConformityStore(runner: PgRunner = realPgRunner): ConformityStore {
  return new ConformityStore(runner);
}
