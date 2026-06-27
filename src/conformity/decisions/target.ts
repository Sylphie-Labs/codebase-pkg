/**
 * target.ts -- pure target-pool logic for the prescriptive STYLE-conformity
 * layer. No ts-morph, no DB, no model: operates only on plain facts records
 * (the {@link DecisionFacts} produced by extract.ts) and on per-axis
 * distributions (value -> count). Dependency-free so the unit tests drive it
 * with small in-memory fakes and stay hermetic.
 *
 * Ported faithfully from `experiments/conformity-decisions/target.mjs`.
 *
 * "Target pool" = a preferred value per decision axis ({ axis: value }) that
 * conformity is judged against -- as opposed to "any minority is an outlier"
 * (purely descriptive). The target may match the current majority, flip to a
 * minority (accepted preference / bad-consensus fix), or name a value with zero
 * examples (cold start). The EFFECTIVE target = a descriptive seed (mode per
 * axis) merged with optional human overrides (conformity-target.json).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CURATED_AXES, AXIS_NONE_VALUE, type Axis } from './extract.js';

export { CURATED_AXES, AXIS_NONE_VALUE };
export type { Axis };

/** value -> count, one map per axis. */
export type AxisDistribution = Record<string, number>;
/** Per-axis distributions keyed by axis. */
export type Distributions = Partial<Record<Axis, AxisDistribution>>;

/** A target pool: preferred value per axis (null = nothing to prefer yet). */
export type Target = Record<Axis, string | null>;

/** Human overrides loaded from conformity-target.json: { axis: value }. */
export type TargetOverrides = Partial<Record<Axis, string>>;

/** Subset of {@link DecisionFacts} the pure target logic actually reads. */
export interface AxisFacts {
  name?: string;
  filePath?: string;
  lineNumber?: number;
  // Each curated axis is a string value on the facts object.
  [axis: string]: unknown;
}

/** One explainable off-target finding for a single axis. */
export interface AxisFlag {
  axis: Axis;
  /** The value the function actually uses. */
  value: string;
  /** The target value it diverges from. */
  target: string;
}

/** Per-function verdict against the target pool. */
export interface Verdict {
  name?: string;
  filePath?: string;
  lineNumber?: number;
  flags: AxisFlag[];
}

/** Per-axis migration progress. */
export interface AxisProgress {
  target: string;
  /** Decided fns whose value == target. */
  atTarget: number;
  /** Decided fns whose value != target (the migration backlog). */
  offTarget: number;
  /** atTarget + offTarget (fns that made a decision on the axis). */
  considered: number;
  /** 100 * atTarget / considered (0 if considered == 0). */
  pct: number;
}

/** Options shared by judge/progress: which axes are enforced. */
export interface EnforceOptions {
  /** Axes to enforce (defaults to all curated axes). */
  enforce?: readonly Axis[];
}

/** Default base-rate guard: enforce an axis only if it has this many deciders. */
export const MIN_SUBSTANTIVE = 10;

/** Filename of the optional git-trackable human overrides at repo root. */
export const TARGET_FILE = 'conformity-target.json';

/**
 * Seed a target = the descriptive MODE per axis, computed over SUBSTANTIVE
 * values only (the axis's {@link AXIS_NONE_VALUE} is excluded). Ties broken by
 * the value that sorts first, so the seed is deterministic. If an axis has no
 * substantive values at all, its seed is null (nothing to prefer yet).
 */
export function seedTarget(dist: Distributions): Target {
  const target = {} as Target;
  for (const axis of CURATED_AXES) {
    const counts = dist[axis] ?? {};
    const none = AXIS_NONE_VALUE[axis];
    let best: string | null = null;
    let bestC = -1;
    for (const v of Object.keys(counts).sort()) {
      if (v === none) continue;
      const c = counts[v]!;
      if (c > bestC) {
        bestC = c;
        best = v;
      }
    }
    target[axis] = best;
  }
  return target;
}

/**
 * Return a NEW target with `overrides` replacing the seeded value on the named
 * axes. Overrides represent human-accepted preferences and may set any value,
 * including a current minority or a value absent from the corpus. Does not
 * mutate `seeded`.
 */
export function applyOverrides(seeded: Target, overrides: TargetOverrides | undefined): Target {
  const out: Target = { ...seeded };
  for (const [axis, value] of Object.entries(overrides ?? {})) {
    out[axis as Axis] = value as string;
  }
  return out;
}

/**
 * Judge each fact record against the target, per decision axis.
 *
 * An axis is judged only if (a) it's in `enforce` (defaults to all curated
 * axes), (b) the target has a non-null value for it, and (c) the function
 * actually made a decision on that axis (its value is not the axis's absence
 * value -- we don't fault a function that declares no variables for "not using
 * const").
 */
export function judgeAgainstTarget(
  facts: AxisFacts[],
  target: Target,
  opts: EnforceOptions = {},
): Verdict[] {
  const enforce = opts.enforce ?? CURATED_AXES;
  const enforceSet = new Set<Axis>(enforce);
  const out: Verdict[] = [];
  for (const f of facts) {
    const flags: AxisFlag[] = [];
    for (const axis of CURATED_AXES) {
      if (!enforceSet.has(axis)) continue;
      const t = target[axis];
      if (t == null) continue;
      const v = String(f[axis]);
      if (v === AXIS_NONE_VALUE[axis]) continue; // no decision made on this axis
      if (v !== t) flags.push({ axis, value: v, target: t });
    }
    out.push({ name: f.name, filePath: f.filePath, lineNumber: f.lineNumber, flags });
  }
  return out;
}

/**
 * Per-axis migration progress = of the functions that MADE a decision on the
 * axis (excluding the absence value), what fraction already equals the target.
 */
export function migrationProgress(
  facts: AxisFacts[],
  target: Target,
  opts: EnforceOptions = {},
): Partial<Record<Axis, AxisProgress>> {
  const enforce = opts.enforce ?? CURATED_AXES;
  const enforceSet = new Set<Axis>(enforce);
  const out: Partial<Record<Axis, AxisProgress>> = {};
  for (const axis of CURATED_AXES) {
    if (!enforceSet.has(axis)) continue;
    const t = target[axis];
    if (t == null) continue;
    const none = AXIS_NONE_VALUE[axis];
    let atTarget = 0;
    let offTarget = 0;
    for (const f of facts) {
      const v = String(f[axis]);
      if (v === none) continue;
      if (v === t) atTarget += 1;
      else offTarget += 1;
    }
    const considered = atTarget + offTarget;
    out[axis] = {
      target: t,
      atTarget,
      offTarget,
      considered,
      pct: considered === 0 ? 0 : (100 * atTarget) / considered,
    };
  }
  return out;
}

/**
 * Count the SUBSTANTIVE (non-absence) population per axis from distributions.
 * This is the input to the base-rate guard.
 */
export function substantiveCounts(dist: Distributions): Record<Axis, number> {
  const out = {} as Record<Axis, number>;
  for (const axis of CURATED_AXES) {
    const counts = dist[axis] ?? {};
    const none = AXIS_NONE_VALUE[axis];
    let n = 0;
    for (const [v, c] of Object.entries(counts)) {
      if (v !== none) n += c;
    }
    out[axis] = n;
  }
  return out;
}

/**
 * The set of axes that should be ENFORCED, applying the base-rate guard: an
 * axis is enforced when its substantive population >= `minSubstantive` OR it
 * carries an explicit human override (a deliberate choice overrides the guard).
 */
export function enforcedAxes(
  dist: Distributions,
  overrides: TargetOverrides | undefined,
  minSubstantive: number = MIN_SUBSTANTIVE,
): Axis[] {
  const counts = substantiveCounts(dist);
  const ov = overrides ?? {};
  return CURATED_AXES.filter((axis) => counts[axis] >= minSubstantive || ov[axis] != null);
}

/**
 * Load the optional git-trackable human overrides from
 * `<cwd>/conformity-target.json`. Returns an empty object if the file is
 * absent, unreadable, or malformed (the seed alone is then the target). Only
 * keys matching a curated axis are kept; everything else is ignored.
 */
export function loadTargetOverrides(cwd: string): TargetOverrides {
  const file = path.join(cwd, TARGET_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // absent or unreadable -> no overrides
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`[conformity] WARNING: ${TARGET_FILE} is not valid JSON; ignoring.\n`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: TargetOverrides = {};
  const curated = new Set<string>(CURATED_AXES);
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (curated.has(k) && typeof v === 'string') {
      out[k as Axis] = v;
    }
  }
  return out;
}

/**
 * Compose the EFFECTIVE target = seed (descriptive mode per axis) merged with
 * the human overrides loaded from conformity-target.json. This is the single
 * call sites should use to get "the style guide in force".
 */
export function effectiveTarget(dist: Distributions, overrides: TargetOverrides | undefined): Target {
  return applyOverrides(seedTarget(dist), overrides);
}
