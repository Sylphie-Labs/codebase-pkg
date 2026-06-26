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
 * Pure selection logic (which chunks to embed, which node ids to delete) is
 * split into small helpers -- {@link chunksToEmbed} / {@link deletedChunkIds}
 * -- so it can be unit-tested directly against a Changeset without running the
 * whole pipeline, a DB, or a model. The legacy {@link functionsToEmbed} /
 * {@link deletedFunctionIds} names remain as thin wrappers for back-compat.
 */

import type { Changeset, NodeCreate, NodeUpdate } from '../sync/graph-differ.js';
import type { ParsedFunction } from '../sync/ast-parser.js';
import type { ParsedChunk } from './category.js';
import { createConformityStore, nodeIdOf, type ConformityStore } from './store.js';
import { embedAndStoreChunks } from './embed-functions.js';
import { realPgRunner, type PgRunner } from './pg-client.js';

/**
 * The created + updated code chunks in a changeset, in creation order, as
 * ParsedChunk[] (functions, types/classes, AND module-level constants). These
 * are the chunks whose descriptive vectors must be (re)written; each derives its
 * own category (function:body / type:body / module:const) downstream.
 *
 * NOTE on constants: the graph differ/changeset (graph-differ.ts) currently only
 * emits node kinds 'function' and 'type' -- it does NOT track module-level
 * constants (that plumbing was intentionally left untouched so the graph
 * pipeline and its tests are not disturbed). So in practice the incremental sync
 * path never carries a 'const' entry, and constants are embedded only by the
 * cold-start backfill / judged from the working tree. This filter recognizes
 * 'const' defensively so the conformity step is forward-compatible IF the graph
 * differ ever starts emitting constants -- no fabricated plumbing is added here.
 */
export function chunksToEmbed(changeset: Changeset): ParsedChunk[] {
  const out: ParsedChunk[] = [];
  const collect = (entries: Array<NodeCreate | NodeUpdate>): void => {
    for (const entry of entries) {
      const kind = entry.kind as string;
      if (kind === 'function' || kind === 'type' || kind === 'const') {
        out.push(entry.data as ParsedChunk);
      }
    }
  };
  collect(changeset.nodesToCreate);
  collect(changeset.nodesToUpdate);
  return out;
}

/**
 * Stable node ids for the deleted code nodes in a changeset (functions, types,
 * AND module-level constants if present) -- the vectors to remove from the cold
 * store. Built from the `<filePath>::<name>` convention (see {@link nodeIdOf}) so
 * they line up with the keys written on upsert.
 *
 * Same limitation as {@link chunksToEmbed}: the changeset doesn't currently carry
 * constant deletes, so 'const' is matched defensively/forward-compatibly only.
 */
export function deletedChunkIds(changeset: Changeset): string[] {
  return changeset.nodesToDelete
    .filter((n) => {
      const kind = n.kind as string;
      return kind === 'function' || kind === 'type' || kind === 'const';
    })
    .map((n) => nodeIdOf({ filePath: n.filePath, name: n.name }));
}

/**
 * LEGACY (function-only) selection, kept for back-compat with callers/tests that
 * specifically want functions. The live sync path now uses {@link chunksToEmbed}
 * so types are covered too; this wrapper keeps the narrow, function-only
 * contract its name implies.
 */
export function functionsToEmbed(changeset: Changeset): ParsedFunction[] {
  const out: ParsedFunction[] = [];
  const collect = (entries: Array<NodeCreate | NodeUpdate>): void => {
    for (const entry of entries) {
      if (entry.kind === 'function') out.push(entry.data as ParsedFunction);
    }
  };
  collect(changeset.nodesToCreate);
  collect(changeset.nodesToUpdate);
  return out;
}

/**
 * LEGACY (function-only) delete-id selection, kept for back-compat. The live
 * sync path uses {@link deletedChunkIds} (functions + types).
 */
export function deletedFunctionIds(changeset: Changeset): string[] {
  return changeset.nodesToDelete
    .filter((n) => n.kind === 'function')
    .map((n) => nodeIdOf({ filePath: n.filePath, name: n.name }));
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

  // Embed BOTH functions and types (chunksToEmbed), delete vectors for removed
  // functions AND types (deletedChunkIds). Each chunk routes to its own category.
  const toEmbed = chunksToEmbed(changeset);
  const toDelete = deletedChunkIds(changeset);

  const { embedded, skipped: embedSkipped } = await embedAndStoreChunks(toEmbed, {
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
