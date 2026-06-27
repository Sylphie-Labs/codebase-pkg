/**
 * target-cli.ts -- `codebase-pkg conformity-target [--init] [--force]`.
 *
 * The on-demand, READ-ONLY view of the effective decision-conformity target +
 * migration progress, plus an `--init` mode that writes a git-trackable
 * `conformity-target.json` seeded from the codebase's current descriptive modes.
 *
 * It is the inspect/edit counterpart of what `conformity-backfill` logs at the
 * end of a backfill (see runDecisionBackfill in decision-backfill.ts) -- but
 * unlike the backfill it NEVER re-parses or re-embeds the tree. The default
 * (show) mode is purely a lookup against the already-persisted axis
 * distributions in `cfm_decisions`: it loads distributions from the
 * DecisionStore, loads conformity-target.json overrides, computes the effective
 * target + enforced axes, and reports per-axis migration progress derived from
 * the stored counts (migrationFromStore).
 *
 * Gated like every other conformity command: if conformity is disabled or
 * Postgres is unreachable it prints a clear message + how to fix it and returns
 * (no throw). `--init` is the one mode that works even before a backfill (it
 * just seeds an empty/whatever target the store can give), but it still needs
 * the gate to read the descriptive modes from the store.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isConformityEnabled } from '../sync-hook.js';
import { realPgRunner, closePgPool, type PgRunner } from '../pg-client.js';
import {
  createDecisionStore,
  type DecisionStore,
  type Distribution,
} from './decision-store.js';
import {
  CURATED_AXES,
  TARGET_FILE,
  effectiveTarget,
  enforcedAxes,
  seedTarget,
  substantiveCounts,
  loadTargetOverrides,
  migrationFromStore,
  type Axis,
  type Distributions,
} from './target.js';

/** Options for {@link runConformityTarget} (all injectable for tests). */
export interface ConformityTargetOptions {
  /** Repo root: where conformity-target.json is read/written. Defaults to cwd. */
  cwd?: string;
  /** Write a starter conformity-target.json instead of just showing. */
  init?: boolean;
  /** With `--init`, overwrite an existing conformity-target.json. */
  force?: boolean;
  /** Decision store to load axis distributions from. Defaults to the real store. */
  store?: DecisionStore;
  /** Pg runner used by the availability gate. Defaults to the real runner. */
  runner?: PgRunner;
  /** Close the pg pool when done. Defaults to true; tests pass false. */
  closePool?: boolean;
}

/**
 * Convert the store's `Record<axis, Distribution(Map)>` into the plain-object
 * {@link Distributions} the pure target logic consumes. Mirrors the same
 * conversion in judge-decisions.ts so show-mode and the judge agree exactly.
 */
function toDistributions(maps: Record<string, Distribution>): Distributions {
  const dist: Distributions = {};
  for (const axis of CURATED_AXES) {
    const m = maps[axis];
    if (!m) continue;
    const counts: Record<string, number> = {};
    for (const [value, count] of m) counts[value] = count;
    dist[axis] = counts;
  }
  return dist;
}

/** The message printed when conformity can't run (disabled / Postgres down). */
function printUnavailable(): void {
  const off = (process.env.CODEBASE_PKG_CONFORMITY ?? '').toLowerCase() === 'off';
  if (off) {
    console.log('[conformity] Skipped — CODEBASE_PKG_CONFORMITY=off.');
    console.log('  Unset CODEBASE_PKG_CONFORMITY (or set it to anything but "off") to re-enable.');
    return;
  }
  console.log('[conformity] Skipped — Postgres not configured/reachable.');
  console.log('  The decision-conformity target lives in the cfm_decisions table.');
  console.log('  Provision Postgres and seed it first:');
  console.log('    codebase-pkg init        # provision local Postgres + write state');
  console.log('    codebase-pkg conformity-backfill   # populate cfm_decisions');
  console.log('  then re-run `codebase-pkg conformity-target`.');
}

/**
 * SHOW mode: print, per axis, the effective target value, whether it's the
 * descriptive seed or a conformity-target.json override, whether it's enforced
 * or guarded out by the base-rate guard, and the substantive count -- then the
 * per-axis migration progress computed entirely from the stored distributions.
 */
function printShow(dist: Distributions, cwd: string): void {
  const overrides = loadTargetOverrides(cwd);
  const seed = seedTarget(dist);
  const target = effectiveTarget(dist, overrides);
  const enforce = enforcedAxes(dist, overrides);
  const counts = substantiveCounts(dist);
  const progress = migrationFromStore(dist, target, { enforce });
  const hasOverrides = Object.keys(overrides).length > 0;

  console.log('=== Codebase PKG — Conformity target ===');
  console.log(
    hasOverrides
      ? `Effective target = descriptive seed merged with ${TARGET_FILE} overrides.`
      : `Effective target = descriptive seed only (no ${TARGET_FILE} overrides). ` +
          `Run \`conformity-target --init\` to start one.`,
  );
  console.log('');
  console.log('Per-axis target:');
  for (const axis of CURATED_AXES) {
    const t = target[axis];
    const value = t == null ? '(none yet)' : t;
    const source = overrides[axis] != null ? '[override]' : '[seed]';
    const seedNote =
      overrides[axis] != null && seed[axis] !== t
        ? ` (seed was ${String(seed[axis])})`
        : '';
    const guard = enforce.includes(axis)
      ? 'enforced'
      : 'NOT enforced (base-rate guard)';
    console.log(
      `  ${axis.padEnd(13)} -> ${String(value).padEnd(16)}` +
        `${source.padEnd(11)}${guard.padEnd(30)} (${counts[axis]} substantive)${seedNote}`,
    );
  }

  console.log('');
  console.log('Migration progress (of fns that decided the axis, how many match target):');
  for (const axis of CURATED_AXES) {
    const p = progress[axis];
    if (!p) {
      console.log(`  ${axis.padEnd(13)}  [not enforced]`);
      continue;
    }
    console.log(
      `  ${axis.padEnd(13)}  ${p.pct.toFixed(1)}% at target ` +
        `(${p.atTarget}/${p.considered})   to migrate: ${p.offTarget}`,
    );
  }
  console.log('');
  console.log('This is a read-only view of the stored distributions — no re-parse, no re-embed.');
}

/**
 * INIT mode: write a starter `conformity-target.json` at `cwd` seeded from the
 * current descriptive modes for the ENFORCED axes (axes with a real preference).
 * Refuses to clobber an existing file unless `force`.
 */
function runInit(dist: Distributions, cwd: string, force: boolean): void {
  const file = path.join(cwd, TARGET_FILE);
  const exists = fs.existsSync(file);
  if (exists && !force) {
    console.log(`[conformity] ${TARGET_FILE} already exists at ${file}.`);
    console.log('  Not overwriting. Re-run with --force to regenerate from the current modes,');
    console.log('  or just edit the file by hand — the judge and backfill already honor it.');
    return;
  }

  // Seed from the descriptive modes, but only emit the axes the base-rate guard
  // actually enforces (axes with a real preference). Axes with too few examples
  // or no substantive value are left out so the starter file mirrors what the
  // judge would enforce; the user can add others by hand.
  const seed = seedTarget(dist);
  const enforce = enforcedAxes(dist, undefined);
  const starter: Record<string, string> = {};
  for (const axis of enforce) {
    const v = seed[axis];
    if (v != null) starter[axis] = v;
  }

  // A small comment-like header explaining the file, then clean JSON. JSON has
  // no comments, so the header lives under a leading "_README" key the override
  // loader ignores (it only keeps keys that match a curated axis).
  const payload = {
    _README:
      'Decision-conformity target overrides. Each key is a curated axis ' +
      `(${CURATED_AXES.join(', ')}); each value is the preferred choice the ` +
      'judge enforces. Seeded from this codebase\'s current modes; edit freely. ' +
      'Setting an axis here also forces it past the base-rate guard.',
    ...starter,
  };

  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`[conformity] Wrote ${TARGET_FILE} at ${file}.`);
  console.log('  Seeded from the codebase\'s current descriptive modes:');
  for (const axis of Object.keys(starter) as Axis[]) {
    console.log(`    ${axis.padEnd(13)} -> ${starter[axis]}`);
  }
  if (Object.keys(starter).length === 0) {
    console.log('    (no axes had a strong-enough preference to seed; edit the file to add some.)');
  }
  console.log('  Edit it to set accepted preferences, commit it, and the judge + backfill will honor it.');
}

/**
 * Run the `conformity-target` command. Default (show) reports the effective
 * target + migration from the STORE (read-only, no re-parse). `--init` writes a
 * starter conformity-target.json. Gated: if conformity is disabled or Postgres
 * is unreachable, prints a clear fix-it message and returns without throwing.
 */
export async function runConformityTarget(
  opts: ConformityTargetOptions = {},
): Promise<void> {
  const runner = opts.runner ?? realPgRunner;
  const cwd = opts.cwd ?? process.cwd();
  const closePool = opts.closePool ?? true;

  try {
    if (!(await isConformityEnabled(runner))) {
      printUnavailable();
      return;
    }

    const store = opts.store ?? createDecisionStore(runner);
    const maps = await store.loadAllDistributions(CURATED_AXES);
    const dist = toDistributions(maps);

    if (opts.init) {
      runInit(dist, cwd, opts.force ?? false);
    } else {
      printShow(dist, cwd);
    }
  } finally {
    if (closePool) {
      await closePgPool().catch(() => {
        // best-effort close
      });
    }
  }
}
