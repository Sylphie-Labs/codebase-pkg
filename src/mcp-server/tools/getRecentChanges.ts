/**
 * getRecentChanges.ts -- Cross-reference a concept area with git/change history.
 *
 * Finds Change nodes that match a query area and returns PR numbers,
 * descriptions, affected functions, and affected types.
 *
 * Target response size: 500-1,500 tokens.
 */

import { runQuery } from '../neo4j-client.js';

export interface GetRecentChangesInput {
  query: string;
  since?: string;
}

/**
 * Handle the getRecentChanges tool call.
 */
export async function handleGetRecentChanges(input: GetRecentChangesInput): Promise<string> {
  const { query } = input;
  const since = input.since ?? defaultSince();
  const searchTerm = `(?i).*${escapeRegex(query)}.*`;

  // Find Change nodes matching the query, filtered by date
  const changeRecords = await runQuery(
    `
    MATCH (c:Change)
    WHERE (c.message =~ $pattern OR c.shortHash =~ $pattern)
      AND (c.date >= $since OR $since IS NULL)
    RETURN c.hash AS hash,
           c.shortHash AS shortHash,
           c.message AS description,
           c.date AS date,
           c.author AS author,
           c.fileCount AS fileCount,
           id(c) AS nodeId
    ORDER BY c.date DESC
    LIMIT 15
    `,
    { pattern: searchTerm, since }
  );

  if (changeRecords.length === 0) {
    return (
      `No changes found matching "${query}" since ${since}.\n\n` +
      `Try a broader term, or omit the since parameter to search further back.`
    );
  }

  // For each change, find affected functions and types
  const changeNodeIds = changeRecords.map((r) => r.get('nodeId'));

  const affectedFunctions = await runQuery(
    `
    MATCH (f:Function)-[:CHANGED_IN]->(c:Change)
    WHERE id(c) IN $ids
    RETURN id(c) AS changeId,
           f.name AS name,
           f.filePath AS filePath
    ORDER BY f.name
    LIMIT 100
    `,
    { ids: changeNodeIds }
  );

  const affectedTypes = await runQuery(
    `
    MATCH (t:Type)-[:CHANGED_IN]->(c:Change)
    WHERE id(c) IN $ids
    RETURN id(c) AS changeId,
           t.name AS name,
           t.filePath AS filePath
    ORDER BY t.name
    LIMIT 50
    `,
    { ids: changeNodeIds }
  );

  // Build lookup maps
  const fnByChange = new Map<unknown, Array<{ name: string; filePath: string | null }>>();
  for (const r of affectedFunctions) {
    const cid = r.get('changeId');
    if (!fnByChange.has(cid)) fnByChange.set(cid, []);
    fnByChange.get(cid)!.push({
      name: r.get('name') as string,
      filePath: r.get('filePath') as string | null,
    });
  }

  const typeByChange = new Map<unknown, Array<{ name: string; filePath: string | null }>>();
  for (const r of affectedTypes) {
    const cid = r.get('changeId');
    if (!typeByChange.has(cid)) typeByChange.set(cid, []);
    typeByChange.get(cid)!.push({
      name: r.get('name') as string,
      filePath: r.get('filePath') as string | null,
    });
  }

  // Format output
  const lines: string[] = [];
  lines.push(`RECENT CHANGES: "${query}" (since ${since})`);
  lines.push('='.repeat(60));
  lines.push(`${changeRecords.length} change(s) found\n`);

  for (const r of changeRecords) {
    const nodeId = r.get('nodeId');
    const date = r.get('date') as string | null;
    const author = r.get('author') as string | null;
    const desc = r.get('description') as string | null;

    const header = [
      date ? date.slice(0, 10) : 'unknown date',
      author ? `by ${author}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    lines.push(`${header}`);
    lines.push('-'.repeat(50));
    if (desc) lines.push(`  ${desc}`);

    const fns = fnByChange.get(nodeId) ?? [];
    if (fns.length > 0) {
      lines.push(`  Affected functions (${fns.length}):`);
      for (const fn of fns.slice(0, 10)) {
        lines.push(`    ${fn.name}${fn.filePath ? ` — ${fn.filePath}` : ''}`);
      }
      if (fns.length > 10) lines.push(`    ... and ${fns.length - 10} more`);
    }

    const types = typeByChange.get(nodeId) ?? [];
    if (types.length > 0) {
      lines.push(`  Affected types (${types.length}):`);
      for (const t of types.slice(0, 5)) {
        lines.push(`    ${t.name}${t.filePath ? ` — ${t.filePath}` : ''}`);
      }
      if (types.length > 5) lines.push(`    ... and ${types.length - 5} more`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
