/**
 * runner.ts -- Migration graph walker and applier.
 *
 * Given a starting version (read from state.json) and a target version (the
 * currently-installed package version), find the linear path of migrations
 * to apply and run them in order.
 *
 * Migrations form a directed graph: each Migration declares `from` and `to`.
 * The runner walks from start to target by repeatedly finding the migration
 * whose `from` matches the current cursor. Branching graphs (multiple
 * migrations from the same `from` to different `to`s) are not supported;
 * the first match wins. Keep the registry linear.
 */

import type { Migration, MigrationContext, MigrationResult } from './migrations/types.js';
import { MIGRATIONS } from './migrations/index.js';
import type { InstallState } from './state.js';

export interface UpgradePlan {
  from: string;
  to: string;
  migrations: Migration[];
  /** Reason returned when no path exists. */
  blocker?: string;
}

/** Naive semver-ish comparison. Returns -1 / 0 / 1 for `a` vs `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10));
  const pb = b.split('.').map((s) => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Find the migration path from `from` to `to`. Returns the ordered list of
 * migrations to apply, or sets `blocker` when no path exists. An empty
 * migrations array with no blocker means "already at the target version."
 */
export function planMigrations(from: string, to: string): UpgradePlan {
  if (from === to) {
    return { from, to, migrations: [] };
  }
  if (compareVersions(from, to) > 0) {
    return {
      from,
      to,
      migrations: [],
      blocker:
        `Installed version (${from}) is newer than the CLI version (${to}). ` +
        `Refusing to downgrade.`,
    };
  }

  const ordered: Migration[] = [];
  let cursor = from;
  const seen = new Set<string>();

  while (cursor !== to) {
    if (seen.has(cursor)) {
      return {
        from, to, migrations: [],
        blocker: `Cycle detected in migration graph at ${cursor}.`,
      };
    }
    seen.add(cursor);

    const next = MIGRATIONS.find((m) => m.from === cursor);
    if (!next) {
      return {
        from, to, migrations: [],
        blocker:
          `No migration from ${cursor} to ${to}. The CLI may be newer than ` +
          `the available migration set; run 'init --force' to re-apply ` +
          `templates against ${to} directly, or wait for a release that ` +
          `bridges ${cursor} -> ${to}.`,
      };
    }
    ordered.push(next);
    cursor = next.to;
  }
  return { from, to, migrations: ordered };
}

export interface ApplyAllOptions {
  ctx: Omit<MigrationContext, 'state'> & { state: InstallState };
  plan: UpgradePlan;
}

export interface ApplyAllResult {
  appliedCount: number;
  results: Array<{ migration: Migration; result: MigrationResult }>;
  finalState: InstallState;
}

/**
 * Apply the ordered list of migrations in sequence. After each, the state's
 * version cursor and managedFiles list are advanced. Returns the final state
 * which the caller should persist via writeState.
 *
 * If any migration throws, partial progress is preserved in `finalState` so
 * the caller can write it and the next upgrade resumes from the failure
 * point.
 */
export async function applyAll(opts: ApplyAllOptions): Promise<ApplyAllResult> {
  const { plan, ctx } = opts;
  let state = { ...ctx.state };
  const results: ApplyAllResult['results'] = [];

  for (const migration of plan.migrations) {
    const migCtx: MigrationContext = {
      ...ctx,
      state,
    };
    const result = await migration.apply(migCtx);
    results.push({ migration, result });
    state = {
      ...state,
      version: migration.to,
      lastUpgradedAt: new Date().toISOString(),
      managedFiles: result.managedFiles,
    };
  }

  return {
    appliedCount: results.length,
    results,
    finalState: state,
  };
}
