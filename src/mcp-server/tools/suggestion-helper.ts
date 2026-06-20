/**
 * suggestion-helper.ts -- "Did you mean?" near-miss suggestions for MCP tools.
 *
 * Computes Levenshtein edit distance in TS (no APOC needed) and returns
 * the top-3 closest function/type names from the PKG graph.
 *
 * Used by getFunctionDetail and getDataFlow when zero nodes match.
 */

import { runQuery } from '../neo4j-client.js';

export interface NearMiss {
  name: string;
  filePath: string | null;
  distance: number;
}

/**
 * Compute the Levenshtein edit distance between two strings (case-insensitive).
 * Standard DP implementation — O(m*n) time, O(n) space.
 */
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();

  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  // Only two rows needed — current and previous.
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  let curr = new Array<number>(t.length + 1);

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,      // insertion
        prev[j] + 1,           // deletion
        prev[j - 1] + cost     // substitution
      );
    }
    // Swap rows without allocating.
    [prev, curr] = [curr, prev];
  }

  return prev[t.length];
}

/**
 * Query the PKG graph for all Function (and Type) names and return the
 * top-3 nearest misses by Levenshtein distance.
 *
 * Candidates are pruned to names whose distance is at most half the query
 * length (rounded up) — beyond that the suggestion is meaningless.
 *
 * @param query   The name the caller tried to look up.
 * @param limit   Maximum suggestions to return (default 3).
 */
export async function findNearMisses(query: string, limit = 3): Promise<NearMiss[]> {
  // Fetch all names — the graph is small (thousands, not millions), so a
  // full scan is acceptable and avoids any APOC/fuzzy-index dependency.
  const records = await runQuery(`
    MATCH (n)
    WHERE n:Function OR n:Type
    RETURN n.name AS name, n.filePath AS filePath
  `);

  const maxDist = Math.ceil(query.length / 2);

  const candidates: NearMiss[] = [];
  for (const r of records) {
    const name = r.get('name') as string;
    const filePath = r.get('filePath') as string | null;

    // Compare against the unqualified suffix for method-name lookups
    // (e.g. "evalute" should match "SomeClass.evaluate").
    const comparable = name.includes('.') ? name.split('.').pop()! : name;
    const dist = levenshtein(query, comparable);

    if (dist > 0 && dist <= maxDist) {
      candidates.push({ name, filePath, distance: dist });
    }
  }

  // Sort by distance asc, then name for determinism.
  candidates.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));

  return candidates.slice(0, limit);
}

/**
 * Format a did_you_mean section for inclusion in a "not found" response.
 */
export function formatDidYouMean(misses: NearMiss[]): string {
  if (misses.length === 0) return '';
  const items = misses
    .map((m) => `  • ${m.name}${m.filePath ? `  (${m.filePath})` : ''}`)
    .join('\n');
  return `\nDID YOU MEAN?\n${items}`;
}
