/**
 * judge-decisions.ts -- the per-decision STYLE-conformity judge surface.
 *
 * This is the PRIMARY conformity signal. Where judge-worktree.ts measures
 * semantic NOVELTY (embedding distance: "is this function shaped like other
 * functions?"), this measures STYLE conformity against the codebase's own
 * effective target: for each curated decision axis (var_decl / string_style /
 * async_style / array_syntax / export_style), does the function use the value
 * the codebase prefers, or does it diverge? Each finding is deterministic and
 * explainable ("uses let; target is const").
 *
 * It mirrors the embedding judge's shape so the two compose cleanly in the MCP
 * tool + CLI:
 *   - `judgeFileDecisions(filePath, opts?)` judges one file.
 *   - `judgeWorkingTreeDecisions(opts?)` judges the working-tree-changed files
 *     (reusing the same `getWorkingTreeFiles` enumeration the embedding judge
 *     uses).
 * Both are GATED: if conformity is disabled or Postgres is unreachable, they
 * return a structured `{ unavailable: true, reason }` rather than throwing.
 *
 * The effective target = the descriptive seed (mode per axis, persisted in
 * `cfm_decisions`) merged with optional human overrides from
 * conformity-target.json -- exactly the composition the decision backfill logs.
 * The base-rate guard (enforcedAxes) skips axes the codebase has too few
 * examples of to have a real preference yet (unless an override forces one).
 *
 * Injectability: the DecisionStore is injectable so unit tests drive the whole
 * surface with a fake store (canned distributions) + a temp-dir ts-morph fixture
 * -- no Postgres, no model.
 */

import {
  extractDecisionsFromFile,
  CURATED_AXES,
  type Axis,
  type DecisionFacts,
} from './extract.js';
import {
  effectiveTarget,
  enforcedAxes,
  judgeAgainstTarget,
  loadTargetOverrides,
  type AxisFacts,
  type AxisFlag,
  type Distributions,
  type Target,
  type TargetOverrides,
} from './target.js';
import {
  createDecisionStore,
  type DecisionStore,
  type Distribution,
} from './decision-store.js';
import { isConformityEnabled } from '../sync-hook.js';
import { realPgRunner, type PgRunner } from '../pg-client.js';
import { getWorkingTreeFiles } from '../../sync/git-diff.js';

/** One function's per-decision verdict against the effective target. */
export interface DecisionFunctionResult {
  /** Display name (e.g. `doThing` or `MyClass.method`). */
  name: string;
  /** Source file path (forward-slashed). */
  filePath: string;
  /** 1-based start line of the function-like node. */
  lineNumber: number;
  /**
   * The axes on which this function diverges from the target. Empty means the
   * function conforms on every enforced axis it made a decision on.
   */
  flags: AxisFlag[];
}

/** The decision-conformity result for a file (or a set of working-tree files). */
export interface DecisionFileResult {
  /** Per-function results, sorted with the most off-target functions first. */
  functions: DecisionFunctionResult[];
  /** Total functions analyzed. */
  totalFunctions: number;
  /** Functions that conform on every enforced axis (zero flags). */
  conformingFunctions: number;
  /** Functions with at least one off-target decision. */
  offTargetFunctions: number;
  /** Total off-target decisions across all functions. */
  totalFlags: number;
  /** The effective target the functions were judged against. */
  target: Target;
  /** The axes actually enforced (after the base-rate guard). */
  enforcedAxes: Axis[];
  /**
   * Whether a `conformity-target.json` contributed any overrides. False means
   * the target is seed-only (purely descriptive: the codebase's current mode).
   */
  hasOverrides: boolean;
}

/** Returned when decision-conformity can't run (disabled / Postgres unreachable). */
export interface DecisionUnavailableResult {
  unavailable: true;
  reason: string;
}

/** Either a file result or a structured "can't run" result. Never throws the gate. */
export type DecisionJudgeResult = DecisionFileResult | DecisionUnavailableResult;

/** Type guard: narrows a {@link DecisionJudgeResult} to the unavailable case. */
export function isDecisionUnavailable(
  r: DecisionJudgeResult,
): r is DecisionUnavailableResult {
  return (r as DecisionUnavailableResult).unavailable === true;
}

/** Options shared by the decision-judge entry points. */
export interface JudgeDecisionsOptions {
  /** Decision store to load axis distributions from. Defaults to the real store. */
  store?: DecisionStore;
  /** Pg runner used only by the availability gate. Defaults to the real runner. */
  runner?: PgRunner;
  /** Directory to read conformity-target.json overrides from. Defaults to cwd. */
  cwd?: string;
}

/**
 * The reason string for the availability gate, mirroring the embedding judge's
 * wording so the two surfaces read consistently.
 */
function gateReason(): string {
  return (process.env.CODEBASE_PKG_CONFORMITY ?? '').toLowerCase() === 'off'
    ? 'disabled (CODEBASE_PKG_CONFORMITY=off)'
    : 'Postgres not configured/reachable';
}

/**
 * Convert the store's `Record<axis, Distribution(Map)>` into the plain-object
 * {@link Distributions} the pure target logic consumes. The store keys are the
 * curated axes; any extra keys are ignored.
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

/**
 * Judge a list of already-extracted decision facts against the effective target
 * built from `dist` + `overrides`. Pure: no DB, no gate, no I/O. Shared by both
 * entry points so file vs working-tree differ only in how facts are gathered.
 */
function judgeFactsAgainstTarget(
  facts: DecisionFacts[],
  dist: Distributions,
  overrides: TargetOverrides,
): DecisionFileResult {
  const target = effectiveTarget(dist, overrides);
  const enforce = enforcedAxes(dist, overrides);

  // DecisionFacts carries the curated axes as named string fields; AxisFacts
  // reads them through its index signature. The cast bridges the two (same
  // pattern the decision backfill uses).
  const verdicts = judgeAgainstTarget(
    facts as unknown as AxisFacts[],
    target,
    { enforce },
  );

  const functions: DecisionFunctionResult[] = verdicts.map((v) => ({
    name: v.name ?? '<anon>',
    filePath: v.filePath ?? '',
    lineNumber: v.lineNumber ?? 0,
    flags: v.flags,
  }));

  // Lead with the functions that have the most off-target decisions; clean
  // functions sink to the bottom. Stable-ish secondary sort by name keeps the
  // output deterministic for equal flag counts.
  functions.sort((a, b) => {
    if (b.flags.length !== a.flags.length) return b.flags.length - a.flags.length;
    return a.name.localeCompare(b.name);
  });

  const offTargetFunctions = functions.filter((f) => f.flags.length > 0).length;
  const totalFlags = functions.reduce((n, f) => n + f.flags.length, 0);

  return {
    functions,
    totalFunctions: functions.length,
    conformingFunctions: functions.length - offTargetFunctions,
    offTargetFunctions,
    totalFlags,
    target,
    enforcedAxes: enforce,
    hasOverrides: Object.keys(overrides).length > 0,
  };
}

/**
 * Shared tail: gate first (don't extract when conformity can't run), load the
 * distributions + overrides, extract decisions from the given files, and judge.
 */
async function judgeDecisionFiles(
  files: string[],
  opts: JudgeDecisionsOptions,
): Promise<DecisionJudgeResult> {
  const runner = opts.runner ?? realPgRunner;
  if (!(await isConformityEnabled(runner))) {
    return { unavailable: true, reason: gateReason() };
  }

  const store = opts.store ?? createDecisionStore(runner);
  const cwd = opts.cwd ?? process.cwd();

  const maps = await store.loadAllDistributions(CURATED_AXES);
  const dist = toDistributions(maps);
  const overrides = loadTargetOverrides(cwd);

  const facts: DecisionFacts[] = [];
  for (const fp of files) {
    try {
      facts.push(...extractDecisionsFromFile(fp));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[conformity] decisions: skipping ${fp} — ${msg}\n`);
    }
  }

  return judgeFactsAgainstTarget(facts, dist, overrides);
}

/**
 * Judge a single file's functions for per-decision STYLE conformity against the
 * effective target. The file is read fresh from disk (current working-tree
 * contents). Gated: returns {@link DecisionUnavailableResult} when conformity
 * can't run.
 */
export async function judgeFileDecisions(
  filePath: string,
  opts: JudgeDecisionsOptions = {},
): Promise<DecisionJudgeResult> {
  const normalized = filePath.replace(/\\/g, '/');
  return judgeDecisionFiles([normalized], opts);
}

/**
 * Judge the working-tree-changed source files (staged + unstaged + untracked, in
 * watched dirs) for per-decision STYLE conformity. Reuses the same
 * `getWorkingTreeFiles` enumeration the embedding judge uses, so both judges see
 * the same scope. Gated like {@link judgeFileDecisions}.
 */
export async function judgeWorkingTreeDecisions(
  opts: JudgeDecisionsOptions = {},
): Promise<DecisionJudgeResult> {
  const files = getWorkingTreeFiles();
  return judgeDecisionFiles(files, opts);
}
