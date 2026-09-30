/**
 * graph-ref-validator.ts -- best-effort validation of `graphRefs` against
 * Neo4j at record time (MCP-SERVER-IMPROVEMENTS.md #4).
 *
 * `graphRefs` are free strings in `<absoluteFilePath>::<name>` form; nothing
 * previously checked they resolved to a real node, so a typo'd ref failed
 * silently and the anchoring value was lost with no signal. This module
 * looks each ref up on write and reports per-ref resolution.
 *
 * WARN, NEVER REFUSE: a ref can legitimately point at code committed later
 * the same session (see the doc), and Neo4j being unreachable must never
 * fail the underlying record* write -- the store write already committed to
 * Postgres by the time this runs (see record{Session,Decision,Learning}.ts),
 * so a Neo4j error here is caught and reported as "skipped", not thrown.
 */

import { runQuery as defaultRunQuery } from '../neo4j-client.js';
import { splitNodeId } from './searchSemantic.js';

/** The shape of neo4j-client's runQuery -- injectable so tests never touch a live Neo4j. */
export type RunQueryFn = typeof defaultRunQuery;

export interface GraphRefValidation {
  resolved: string[];
  unresolved: string[];
  /** True when validation could not run at all (e.g. Neo4j unreachable) -- distinct from "0 resolved". */
  skipped: boolean;
  skipReason?: string;
}

/**
 * Look up each ref in `refs` against Neo4j (any label, matched on
 * `filePath`+`name` -- the same identity convention as {@link splitNodeId} /
 * `nodeIdOf` in ../../conformity/store.ts). Returns null when `refs` is
 * empty/undefined (nothing to report). Never throws: a Neo4j failure is
 * caught and folded into `skipped`/`skipReason`.
 */
export async function validateGraphRefs(
  refs: string[] | undefined,
  runQuery: RunQueryFn = defaultRunQuery,
): Promise<GraphRefValidation | null> {
  if (!refs || refs.length === 0) return null;

  try {
    const items = refs.map((ref) => {
      const { filePath, name } = splitNodeId(ref);
      return { ref, filePath, name };
    });

    const records = await runQuery(
      `UNWIND $items AS item
       OPTIONAL MATCH (n) WHERE n.filePath = item.filePath AND n.name = item.name
       RETURN item.ref AS ref, n IS NOT NULL AS found`,
      { items },
    );

    const foundByRef = new Map<string, boolean>();
    for (const rec of records) {
      foundByRef.set(rec.get('ref') as string, Boolean(rec.get('found')));
    }

    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const ref of refs) {
      if (foundByRef.get(ref)) resolved.push(ref);
      else unresolved.push(ref);
    }
    return { resolved, unresolved, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { resolved: [], unresolved: refs, skipped: true, skipReason: message };
  }
}

/**
 * Result of expanding a `nearRefs` list (recallSimilar, #6) to include the
 * immediate Neo4j neighborhood of each ref, for the graphRef-scoped
 * boost/filter term in SessionStore.recallSimilar's hybrid score.
 */
export interface NearRefsExpansion {
  /** `refs` plus every directly-connected neighbor's `<filePath>::<name>` id, deduped. Always includes the original refs even on failure. */
  expanded: string[];
  /** True when the neighborhood lookup could not run (e.g. Neo4j unreachable) -- `expanded` then falls back to the given refs verbatim (exact-ref matching still works, just no neighborhood widening). */
  skipped: boolean;
  skipReason?: string;
}

/**
 * Expand `refs` to include the immediate (one-hop, any relationship type/
 * direction) Neo4j neighborhood of each resolved node -- the "or their
 * immediate Neo4j neighborhood" half of MCP-SERVER-IMPROVEMENTS.md #6's
 * `nearRefs` param. Reuses the same node-identity convention as
 * {@link validateGraphRefs} (match on `filePath`+`name`, any label). Returns
 * null when `refs` is empty/undefined. NEVER throws: a Neo4j failure falls
 * back to the unexpanded refs (see {@link NearRefsExpansion.skipped}) rather
 * than failing the whole recallSimilar call over an optional boost.
 */
export async function expandNearRefs(
  refs: string[] | undefined,
  runQuery: RunQueryFn = defaultRunQuery,
): Promise<NearRefsExpansion | null> {
  if (!refs || refs.length === 0) return null;

  try {
    const items = refs.map((ref) => {
      const { filePath, name } = splitNodeId(ref);
      return { ref, filePath, name };
    });

    const records = await runQuery(
      `UNWIND $items AS item
       OPTIONAL MATCH (n) WHERE n.filePath = item.filePath AND n.name = item.name
       OPTIONAL MATCH (n)--(neighbor)
       WITH item, collect(DISTINCT {filePath: neighbor.filePath, name: neighbor.name}) AS neighbors
       RETURN item.ref AS ref, neighbors`,
      { items },
    );

    const expanded = new Set<string>(refs);
    for (const rec of records) {
      const neighbors = rec.get('neighbors') as Array<{ filePath: string | null; name: string | null }>;
      for (const neighbor of neighbors ?? []) {
        if (neighbor?.filePath && neighbor?.name) {
          expanded.add(`${neighbor.filePath}::${neighbor.name}`);
        }
      }
    }
    return { expanded: [...expanded], skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { expanded: [...refs], skipped: true, skipReason: message };
  }
}

/** Render a {@link GraphRefValidation} as one line for a tool result, or `''` when there is nothing to say. */
export function formatGraphRefReport(validation: GraphRefValidation | null): string {
  if (!validation) return '';
  if (validation.skipped) {
    return `graphRefs validation skipped (Neo4j unreachable: ${validation.skipReason ?? 'unknown error'}).`;
  }
  const total = validation.resolved.length + validation.unresolved.length;
  if (validation.unresolved.length === 0) {
    return `${validation.resolved.length}/${total} graph ref(s) resolved.`;
  }
  return (
    `${validation.resolved.length}/${total} graph ref(s) resolved; ` +
    `unresolved: ${validation.unresolved.join(', ')}.`
  );
}
