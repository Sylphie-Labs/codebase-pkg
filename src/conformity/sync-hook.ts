/**
 * sync-hook.ts -- the incremental conformity step the sync pipeline runs after
 * mutations are applied.
 *
 * Conformity is AUXILIARY: it must never block the sync cursor or fail the sync.
 * The pipeline calls {@link runConformityStep} inside a try/catch and treats any
 * throw as a warning. This module additionally GATES itself so a repo without
 * Postgres (or with conformity explicitly disabled) silently does nothing
 * rather than erroring on every sync.
 *
 * Pure selection logic (which functions to embed, which node ids to delete) is
 * split into small helpers -- {@link functionsToEmbed} / {@link deletedFunctionIds}
 * -- so it can be unit-tested directly against a Changeset without running the
 * whole pipeline, a DB, or a model.
 */

import type { Changeset, NodeCreate, NodeUpdate } from '../sync/graph-differ.js';
import type { ParsedFunction } from '../sync/ast-parser.js';
import { createConformityStore, nodeIdOf, type ConformityStore } from './store.js';
import { embedAndStoreFunctions } from './embed-functions.js';
import { realPgRunner, type PgRunner } from './pg-client.js';

/**
 * The created + updated functions in a changeset, in creation order, as
 * ParsedFunction[]. These are the chunks whose descriptive vectors must be
 * (re)written. Type nodes are ignored -- conformity currently only covers
 * function signature skeletons.
 */
export function functionsToEmbed(changeset: Changeset): ParsedFunction[] {
  const out: ParsedFunction[] = [];
  const collect = (entries: Array<NodeCreate | NodeUpdate>): void => {
    for (const entry of entries) {
      if (entry.kind === 'function') {
        out.push(entry.data as ParsedFunction);
      }
    }
  };
  collect(changeset.nodesToCreate);
  collect(changeset.nodesToUpdate);
  return out;
}

/**
 * Stable node ids for the deleted function nodes in a changeset -- the vectors
 * to remove from the cold store. Built from the `<filePath>::<name>` convention
 * (see {@link nodeIdOf}) so they line up with the keys written on upsert. Type
 * deletions are ignored.
 */
export function deletedFunctionIds(changeset: Changeset): string[] {
  return changeset.nodesToDelete
    .filter((n) => n.kind === 'function')
    .map((n) => nodeIdOf({ filePath: n.filePath, name: n.name } as ParsedFunction));
}

/**
 * Decide whether the conformity step should run, probing Postgres reachability.
 *
 * Returns `false` (skip quietly) when:
 *   - env `CODEBASE_PKG_CONFORMITY=off` (case-insensitive), OR
 *   - Postgres is not reachable (the readiness probe `SELECT 1` throws). This
 *     folds "not configured" and "configured but down" into one check: either
 *     way conformity can't run, and the sync must not hard-depend on it.
 *
 * The runner is injectable so this is testable without a live database.
 */
export async function isConformityEnabled(
  runner: PgRunner = realPgRunner,
): Promise<boolean> {
  if ((process.env.CODEBASE_PKG_CONFORMITY ?? '').toLowerCase() === 'off') {
    return false;
  }
  try {
    await runner.query('SELECT 1', []);
    return true;
  } catch {
    return false;
  }
}

/** Options for {@link runConformityStep} (all injectable for tests). */
export interface ConformityStepOptions {
  store?: ConformityStore;
  runner?: PgRunner;
  /** Embedder override forwarded to embedAndStoreFunctions. */
  embedder?: import('./embed.js').Embedder;
  /** Model override forwarded to embedAndStoreFunctions. */
  model?: string;
}

/** What the conformity step did, for logging by the caller. */
export interface ConformityStepResult {
  skipped: boolean;
  reason?: string;
  embedded: number;
  embedSkipped: number;
  deleted: number;
}

/**
 * Run the incremental conformity step for a changeset: gate on Postgres, then
 * (re)embed created+updated functions and delete vectors for removed functions.
 *
 * This function does NOT swallow embed/store errors itself beyond the gate --
 * the sync pipeline wraps the call in try/catch and downgrades any throw to a
 * warning. The gate, however, returns a `skipped` result rather than throwing
 * when conformity is disabled or Postgres is unreachable.
 */
export async function runConformityStep(
  changeset: Changeset,
  opts: ConformityStepOptions = {},
): Promise<ConformityStepResult> {
  const runner = opts.runner ?? realPgRunner;

  if (!(await isConformityEnabled(runner))) {
    return {
      skipped: true,
      reason:
        (process.env.CODEBASE_PKG_CONFORMITY ?? '').toLowerCase() === 'off'
          ? 'disabled (CODEBASE_PKG_CONFORMITY=off)'
          : 'Postgres not configured/reachable',
      embedded: 0,
      embedSkipped: 0,
      deleted: 0,
    };
  }

  const store = opts.store ?? createConformityStore(runner);

  const toEmbed = functionsToEmbed(changeset);
  const toDelete = deletedFunctionIds(changeset);

  const { embedded, skipped: embedSkipped } = await embedAndStoreFunctions(toEmbed, {
    store,
    embedder: opts.embedder,
    model: opts.model,
  });

  if (toDelete.length > 0) {
    await store.deleteVectors(toDelete);
  }

  return {
    skipped: false,
    embedded,
    embedSkipped,
    deleted: toDelete.length,
  };
}
