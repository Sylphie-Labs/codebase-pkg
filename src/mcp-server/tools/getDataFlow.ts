/**
 * getDataFlow.ts -- Trace upstream/downstream data connections from a function or type.
 *
 * Follows IMPORTS and DATA_FLOWS_TO edges to build an ordered chain showing
 * how data moves through the codebase from or to the named starting node.
 *
 * Target response size: 1,000-3,000 tokens.
 */

import { runQuery } from '../neo4j-client.js';

export interface GetDataFlowInput {
  startNode: string;
  direction: 'upstream' | 'downstream' | 'both';
  depth?: number;
}

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 6;

/**
 * Handle the getDataFlow tool call.
 */
export async function handleGetDataFlow(input: GetDataFlowInput): Promise<string> {
  const { startNode, direction } = input;
  const depth = Math.min(input.depth ?? DEFAULT_DEPTH, MAX_DEPTH);

  // Find the start node — could be a Function or Type.
  let startRecords = await runQuery(
    `
    MATCH (n)
    WHERE (n:Function OR n:Type) AND n.name = $name
    RETURN labels(n) AS labels,
           n.name AS name,
           n.filePath AS filePath,
           n.returnType AS returnType,
           n.kind AS kind
    LIMIT 5
    `,
    { name: startNode }
  );

  // Fallback: try ENDS WITH for unqualified method names
  if (startRecords.length === 0 && !startNode.includes('.')) {
    const suffix = `.${startNode}`;
    startRecords = await runQuery(
      `
      MATCH (n)
      WHERE (n:Function OR n:Type) AND n.name ENDS WITH $suffix
      RETURN labels(n) AS labels,
             n.name AS name,
             n.filePath AS filePath,
             n.returnType AS returnType,
             n.kind AS kind
      LIMIT 5
      `,
      { suffix }
    );
  }

  if (startRecords.length === 0) {
    return (
      `Node "${startNode}" not found in the codebase PKG.\n\n` +
      `Provide the exact function or type name (e.g., "ExecutorLoopService.tick").\n` +
      `Use getModuleContext to discover names in a feature area.`
    );
  }

  if (startRecords.length > 1) {
    const matches = startRecords
      .map((r) => {
        const labels = r.get('labels') as string[];
        const fp = r.get('filePath') as string | null;
        return `  ${labels.join('/')} — ${fp ?? 'unknown path'}`;
      })
      .join('\n');
    return (
      `Multiple nodes named "${startNode}" exist:\n\n${matches}\n\n` +
      `The data flow query uses the first match. Refine using getFunctionDetail with filePath if needed.`
    );
  }

  const lines: string[] = [];
  lines.push(`DATA FLOW: "${startNode}" (${direction}, depth ${depth})`);
  lines.push('='.repeat(60));

  const startLabels = startRecords[0].get('labels') as string[];
  const startFile = startRecords[0].get('filePath') as string | null;
  const resolvedName = startRecords[0].get('name') as string;
  lines.push(`\nSTART NODE`);
  lines.push(`  ${resolvedName} [${startLabels.join(', ')}]`);
  if (startFile) lines.push(`  File: ${startFile}`);

  if (direction === 'upstream' || direction === 'both') {
    const upstreamChain = await traceDirection(resolvedName, 'upstream', depth);
    lines.push(`\nUPSTREAM (what feeds into "${resolvedName}")`);
    lines.push('-'.repeat(40));
    if (upstreamChain.length === 0) {
      lines.push('  No upstream connections found.');
    } else {
      lines.push(...upstreamChain);
    }
  }

  if (direction === 'downstream' || direction === 'both') {
    const downstreamChain = await traceDirection(resolvedName, 'downstream', depth);
    lines.push(`\nDOWNSTREAM (what "${resolvedName}" feeds into)`);
    lines.push('-'.repeat(40));
    if (downstreamChain.length === 0) {
      lines.push('  No downstream connections found.');
    } else {
      lines.push(...downstreamChain);
    }
  }

  lines.push('\n' + '='.repeat(60));
  lines.push(`Use getFunctionDetail for full body of any function in this chain.`);

  return lines.join('\n');
}

/**
 * Trace one direction from the start node using variable-length path traversal.
 */
async function traceDirection(
  startName: string,
  direction: 'upstream' | 'downstream',
  depth: number
): Promise<string[]> {
  const edgeTypes = 'CALLS|USES_TYPE|IMPORTS|CONTAINS|INJECTS|EXTENDS|IMPLEMENTS';
  const pathPattern =
    direction === 'upstream'
      ? `(n)<-[:${edgeTypes}*1..${depth}]-(start {name: $name})`
      : `(start {name: $name})-[:${edgeTypes}*1..${depth}]->(n)`;

  const records = await runQuery(
    `
    MATCH path = ${pathPattern}
    WHERE (start:Function OR start:Type)
      AND (n:Function OR n:Type)
    RETURN n.name AS name,
           n.filePath AS filePath,
           labels(n) AS labels,
           n.returnType AS returnType,
           n.kind AS kind,
           length(path) AS hopDistance
    ORDER BY hopDistance, n.name
    LIMIT 50
    `,
    { name: startName }
  );

  if (records.length === 0) return [];

  const lines: string[] = [];
  let currentHop = -1;

  for (const r of records) {
    const hop = r.get('hopDistance') as number;
    const name = r.get('name') as string;
    const filePath = r.get('filePath') as string | null;
    const labels = r.get('labels') as string[];
    const returnType = r.get('returnType') as string | null;
    const kind = r.get('kind') as string | null;

    if (hop !== currentHop) {
      lines.push(`\n  Hop ${hop}:`);
      currentHop = hop;
    }

    const typeInfo = returnType ? `: ${returnType}` : kind ? ` [${kind}]` : '';
    lines.push(`    ${name}${typeInfo} [${labels.join(', ')}]`);
    if (filePath) lines.push(`      File: ${filePath}`);
  }

  return lines;
}
