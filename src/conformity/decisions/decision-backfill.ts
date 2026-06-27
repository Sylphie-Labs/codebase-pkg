/**
 * decision-backfill.ts -- persist the per-entity STYLE decision facts over the
 * committed codebase, then derive + log the seeded target and per-axis
 * migration progress.
 *
 * This is the decision-conformity counterpart to the embedding backfill. It is
 * ADDITIVE: `runConformityBackfill` calls {@link runDecisionBackfill} alongside
 * the existing embedding/calibration pass, so both run and both report. After
 * persistence, distributions and the migration backlog are SQL queries against
 * `cfm_decisions` -- a later judge never re-scans the tree.
 *
 * Reuses extract.ts (ts-morph fact extraction), target.ts (pure seed/judge/
 * progress + override loader), and DecisionStore (Postgres persistence). The
 * caller is responsible for the gate (Postgres reachable + conformity enabled)
 * and for `ensureSchema`; this function assumes the table exists.
 */

import { nodeIdOf } from '../store.js';
import { type PgRunner, realPgRunner } from '../pg-client.js';
import { extractDecisionsFromFile, CURATED_AXES, type DecisionFacts } from './extract.js';
import {
  loadTargetOverrides,
  effectiveTarget,
  seedTarget,
  enforcedAxes,
  substantiveCounts,
  migrationProgress,
  type Distributions,
  type AxisFacts,
} from './target.js';
import { createDecisionStore, type DecisionRow, type DecisionStore } from './decision-store.js';

/** Summary of a decision backfill pass (returned for logging/testing). */
export interface DecisionBackfillResult {
  /** Number of function-like entities whose decisions were persisted. */
  functions: number;
  /** Number of (node_id, axis) rows upserted. */
  rows: number;
}

/**
 * Build the in-memory distributions (value -> count per axis) directly from the
 * freshly extracted facts. Equivalent to what `loadAllDistributions` would
 * return after the upsert, but avoids a DB round-trip for the immediate
 * seed/progress log right after persisting.
 */
function distributionsFromFacts(facts: DecisionFacts[]): Distributions {
  const dist: Distributions = {};
  for (const axis of CURATED_AXES) {
    const counts: Record<string, number> = {};
    for (const f of facts) {
      const v = String(f[axis]);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    dist[axis] = counts;
  }
  return dist;
}

/** Flatten a list of facts into (node_id, axis, value) rows for the store. */
function rowsFromFacts(facts: DecisionFacts[]): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const f of facts) {
    const nodeId = nodeIdOf({ filePath: f.filePath, name: f.name });
    for (const axis of CURATED_AXES) {
      rows.push({ nodeId, axis, value: String(f[axis]) });
    }
  }
  return rows;
}

/**
 * Extract decisions for every function in `files`, persist them via the store,
 * then derive and LOG the effective target (descriptive seed merged with
 * conformity-target.json overrides) and the per-axis migration progress.
 *
 * @param files - watched source file paths (same list the embedding backfill uses).
 * @param opts  - injectable store/runner/cwd for tests; defaults wire production.
 */
export async function runDecisionBackfill(
  files: string[],
  opts: { store?: DecisionStore; runner?: PgRunner; cwd?: string } = {},
): Promise<DecisionBackfillResult> {
  const runner = opts.runner ?? realPgRunner;
  const store = opts.store ?? createDecisionStore(runner);
  const cwd = opts.cwd ?? process.cwd();

  // 1. Extract per-function decision facts across every watched file.
  const facts: DecisionFacts[] = [];
  for (const fp of files) {
    try {
      facts.push(...extractDecisionsFromFile(fp));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[conformity] decisions: skipping ${fp} — ${msg}\n`);
    }
  }

  // 2. Persist (one row per node_id x axis).
  const rows = rowsFromFacts(facts);
  await store.upsertDecisions(rows);

  // 3. Derive the effective target: descriptive seed (mode per axis) merged
  //    with optional human overrides from conformity-target.json.
  const dist = distributionsFromFacts(facts);
  const overrides = loadTargetOverrides(cwd);
  const seed = seedTarget(dist);
  const target = effectiveTarget(dist, overrides);
  const enforce = enforcedAxes(dist, overrides);
  const counts = substantiveCounts(dist);
  const progress = migrationProgress(facts as unknown as AxisFacts[], target, { enforce });

  // 4. Log the seeded target + migration summary per axis.
  console.log('');
  console.log('Decision-conformity: persisted per-entity style facts.');
  console.log(`  Entities analyzed : ${facts.length}   Rows upserted: ${rows.length}`);
  console.log('  Effective target (seed merged with conformity-target.json overrides):');
  for (const axis of CURATED_AXES) {
    const ov = overrides[axis] != null ? '  [override]' : '';
    const seedNote = seed[axis] !== target[axis] ? ` (seed was ${String(seed[axis])})` : '';
    const guard = !enforce.includes(axis) ? '  [base-rate guard: not enforced]' : '';
    console.log(
      `    ${axis.padEnd(13)} -> ${String(target[axis]).padEnd(16)}` +
        `(${counts[axis]} substantive)${seedNote}${ov}${guard}`,
    );
  }
  console.log('  Migration progress (of fns that decided the axis, how many match target):');
  for (const axis of CURATED_AXES) {
    const p = progress[axis];
    if (!p) {
      console.log(`    ${axis.padEnd(13)}  [not enforced]`);
      continue;
    }
    console.log(
      `    ${axis.padEnd(13)}  ${p.pct.toFixed(1)}% at target ` +
        `(${p.atTarget}/${p.considered})   to migrate: ${p.offTarget}`,
    );
  }

  return { functions: facts.length, rows: rows.length };
}
