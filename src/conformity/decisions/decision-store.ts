/**
 * decision-store.ts -- Postgres data layer for the per-entity STYLE decision
 * facts (the `cfm_decisions` table). Mirrors the injectable-runner + per-
 * instance hot-cache pattern of {@link ConformityStore} in ../store.ts.
 *
 * Why persist per-entity facts: with one row per (node_id, axis), the axis
 * DISTRIBUTIONS (SELECT value, count(*) GROUP BY value) and the MIGRATION
 * BACKLOG (rows whose value != the target) are plain SQL queries. A later judge
 * is then a lookup against stored data, not a full re-scan of the source tree.
 *
 * Injectability: takes a {@link PgRunner}. Production passes the real
 * pool-backed runner; tests pass a fake that records SQL and returns canned
 * rows -- so unit tests need no live Postgres. The hot cache (axis ->
 * distribution) is held on the instance (NOT module-global) for test isolation,
 * and is invalidated on every upsert (writes can change any axis's counts).
 *
 * Single-process assumption (same as ConformityStore): the cache is only
 * invalidated by writes made THROUGH this instance; a concurrent external
 * writer would not invalidate it.
 */

import { type PgRunner, realPgRunner } from '../pg-client.js';
import { DECISIONS_TABLE } from '../schema.js';

/** One decision fact destined for the store. */
export interface DecisionRow {
  /** Stable node id (see nodeIdOf in ../store.ts). */
  nodeId: string;
  /** The curated axis, e.g. `var_decl`. */
  axis: string;
  /** The categorical value chosen on that axis, e.g. `const`. */
  value: string;
}

/** value -> count for a single axis. */
export type Distribution = Map<string, number>;

/**
 * The decision-facts data layer. One instance owns one hot cache (axis ->
 * Distribution). Construct with a {@link PgRunner}; the default is the real
 * pool-backed runner.
 */
export class DecisionStore {
  private readonly runner: PgRunner;
  /** axis -> materialized distribution. Instance-scoped for test isolation. */
  private readonly distCache = new Map<string, Distribution>();

  constructor(runner: PgRunner = realPgRunner) {
    this.runner = runner;
  }

  /** Drop the entire hot cache. For tests/teardown and bulk invalidation. */
  clearCache(): void {
    this.distCache.clear();
  }

  /**
   * Batched upsert of decision facts. One row per (node_id, axis); re-running
   * overwrites in place (ON CONFLICT (node_id, axis) DO UPDATE). Because any
   * upsert can shift any axis's counts, the WHOLE distribution cache is cleared
   * (cheap, always correct) rather than tracking touched axes.
   */
  async upsertDecisions(rows: DecisionRow[]): Promise<void> {
    if (rows.length === 0) return;

    // Single multi-row VALUES list; each row contributes 3 params.
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const r of rows) {
      const base = params.length;
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      params.push(r.nodeId, r.axis, r.value);
    }

    const sql =
      `INSERT INTO ${DECISIONS_TABLE} (node_id, axis, value) ` +
      `VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT (node_id, axis) DO UPDATE SET ` +
      `value = EXCLUDED.value, ` +
      `updated_at = now();`;

    await this.runner.query(sql, params);

    this.clearCache();
  }

  /**
   * Load the value -> count distribution for one axis -- the HOT path. Returns
   * the cached distribution if present; otherwise runs a GROUP BY in Postgres,
   * builds the Map, caches it, and returns it.
   */
  async loadDistribution(axis: string): Promise<Distribution> {
    const cached = this.distCache.get(axis);
    if (cached) return cached;

    const { rows } = await this.runner.query(
      `SELECT value, count(*) AS count FROM ${DECISIONS_TABLE} ` +
        `WHERE axis = $1 GROUP BY value;`,
      [axis],
    );

    const dist: Distribution = new Map();
    for (const r of rows as Array<{ value: string; count: number | string }>) {
      dist.set(r.value, Number(r.count));
    }

    this.distCache.set(axis, dist);
    return dist;
  }

  /**
   * Load distributions for a set of axes at once. Returns a plain object keyed
   * by axis (each value an axis distribution as a Map). Reuses
   * {@link loadDistribution} so each axis is independently cacheable.
   */
  async loadAllDistributions(axes: Iterable<string>): Promise<Record<string, Distribution>> {
    const out: Record<string, Distribution> = {};
    for (const axis of new Set(axes)) {
      out[axis] = await this.loadDistribution(axis);
    }
    return out;
  }

  /**
   * The MIGRATION BACKLOG for an axis: the node ids whose stored value on that
   * axis is NOT the target value. This is the off-target set a later judge /
   * migration report walks. Not cached (it is parameterized by target and is a
   * cheap indexed query). Bypasses the distribution cache entirely.
   */
  async loadOffTarget(axis: string, targetValue: string): Promise<string[]> {
    const { rows } = await this.runner.query(
      `SELECT node_id FROM ${DECISIONS_TABLE} ` +
        `WHERE axis = $1 AND value <> $2;`,
      [axis, targetValue],
    );
    return (rows as Array<{ node_id: string }>).map((r) => r.node_id);
  }
}

/** Convenience factory mirroring the class constructor's default runner. */
export function createDecisionStore(runner: PgRunner = realPgRunner): DecisionStore {
  return new DecisionStore(runner);
}
