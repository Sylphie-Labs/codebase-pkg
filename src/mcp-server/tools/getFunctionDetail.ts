/**
 * getFunctionDetail.ts -- Deep dive on a specific function.
 *
 * Returns the full function body, complete type definitions for arguments
 * and return type, linked test file locations, and recent Change nodes.
 *
 * Target response size: 500-2,000 tokens.
 */

import { runQuery } from '../neo4j-client.js';

export interface GetFunctionDetailInput {
  functionName: string;
  filePath?: string;
}

/**
 * Handle the getFunctionDetail tool call.
 */
export async function handleGetFunctionDetail(input: GetFunctionDetailInput): Promise<string> {
  const { functionName, filePath } = input;

  // Find the function node(s) — try exact match first.
  let functionRecords = await runQuery(
    `
    MATCH (f:Function)
    WHERE f.name = $name
      ${filePath ? 'AND f.filePath CONTAINS $filePath' : ''}
    OPTIONAL MATCH (f)-[:HAS_CODE]->(cb:CodeBlock)
    RETURN f.name AS name,
           f.filePath AS filePath,
           f.lineNumber AS lineNumber,
           f.args AS arguments,
           f.returnType AS returnType,
           f.jsDoc AS comment,
           coalesce(cb.bodyText, f.bodyText) AS body,
           f.isAsync AS isAsync,
           f.isExported AS isExported
    ORDER BY f.filePath
    LIMIT 5
    `,
    filePath ? { name: functionName, filePath } : { name: functionName }
  );

  // Fallback: try as unqualified method name.
  if (functionRecords.length === 0 && !functionName.includes('.')) {
    const suffix = `.${functionName}`;
    functionRecords = await runQuery(
      `
      MATCH (f:Function)
      WHERE f.name ENDS WITH $suffix
        ${filePath ? 'AND f.filePath CONTAINS $filePath' : ''}
      OPTIONAL MATCH (f)-[:HAS_CODE]->(cb:CodeBlock)
      RETURN f.name AS name,
             f.filePath AS filePath,
             f.lineNumber AS lineNumber,
             f.args AS arguments,
             f.returnType AS returnType,
             f.jsDoc AS comment,
             coalesce(cb.bodyText, f.bodyText) AS body,
             f.isAsync AS isAsync,
             f.isExported AS isExported
      ORDER BY f.filePath
      LIMIT 5
      `,
      filePath ? { suffix, filePath } : { suffix }
    );
  }

  if (functionRecords.length === 0) {
    return `Function "${functionName}" not found in the codebase PKG.${
      filePath ? ` (searched within path: ${filePath})` : ''
    }\n\nTry getModuleContext to discover function names in a feature area.` +
    `\nNote: class methods are stored as "ClassName.methodName" (e.g., "ExecutorLoopService.tick").`;
  }

  if (functionRecords.length > 1) {
    const locations = functionRecords
      .map((r) => `  ${r.get('filePath') as string}:${r.get('lineNumber') as number ?? '?'}`)
      .join('\n');
    return (
      `Multiple functions named "${functionName}" found. Provide filePath to disambiguate:\n\n${locations}\n\n` +
      `Example: getFunctionDetail({ functionName: "${functionName}", filePath: "path/to/file" })`
    );
  }

  const fn = functionRecords[0];
  const fnFilePath = fn.get('filePath') as string | null;
  const fnName = fn.get('name') as string;

  // Get types used by this function
  const typeRecords = await runQuery(
    `
    MATCH (f:Function)-[:USES_TYPE]->(t:Type)
    WHERE f.name = $name
      AND (f.filePath = $fp OR $fp IS NULL)
    RETURN t.name AS name,
           t.filePath AS filePath,
           t.kind AS kind,
           t.bodyText AS body
    ORDER BY t.name
    LIMIT 20
    `,
    { name: fnName, fp: fnFilePath ?? null }
  );

  // Get test files linked to this function
  const testRecords = await runQuery(
    `
    MATCH (f:Function)-[:TESTED_BY]->(tf:TestFile)
    WHERE f.name = $name
      AND (f.filePath = $fp OR $fp IS NULL)
    RETURN tf.filePath AS filePath,
           tf.description AS description
    ORDER BY tf.filePath
    LIMIT 10
    `,
    { name: fnName, fp: fnFilePath ?? null }
  );

  // Get recent change nodes
  const changeRecords = await runQuery(
    `
    MATCH (f:Function)-[:CHANGED_IN]->(c:Change)
    WHERE f.name = $name
      AND (f.filePath = $fp OR $fp IS NULL)
    RETURN c.description AS description,
           c.prNumber AS prNumber,
           c.date AS date,
           c.author AS author
    ORDER BY c.date DESC
    LIMIT 5
    `,
    { name: fnName, fp: fnFilePath ?? null }
  );

  // Format output
  const lines: string[] = [];
  const isAsync = fn.get('isAsync') as boolean | null;
  const isExported = fn.get('isExported') as boolean | null;
  const args = fn.get('arguments') as string | null;
  const ret = fn.get('returnType') as string | null;
  const comment = fn.get('comment') as string | null;
  const body = fn.get('body') as string | null;
  const lineNo = fn.get('lineNumber') as number | null;

  lines.push(`FUNCTION DETAIL: ${fnName}`);
  lines.push('='.repeat(60));

  // Signature
  const prefix = [isExported ? 'export' : '', isAsync ? 'async' : ''].filter(Boolean).join(' ');
  lines.push(`\nSIGNATURE`);
  lines.push('-'.repeat(40));
  lines.push(`${prefix ? prefix + ' ' : ''}function ${fnName}(${args ?? ''})${ret ? ': ' + ret : ''}`);
  lines.push(`File: ${fnFilePath ?? 'unknown'}${lineNo != null ? `:${lineNo}` : ''}`);

  // Doc comment
  if (comment) {
    lines.push(`\nDOC COMMENT`);
    lines.push('-'.repeat(40));
    lines.push(comment);
  }

  // Body
  lines.push(`\nBODY`);
  lines.push('-'.repeat(40));
  if (body) {
    lines.push(body);
  } else {
    lines.push('(body not stored in PKG — read the source file directly)');
  }

  // Types
  if (typeRecords.length > 0) {
    lines.push(`\nRELATED TYPES (${typeRecords.length})`);
    lines.push('-'.repeat(40));
    for (const r of typeRecords) {
      const typeBody = r.get('body') as string | null;
      const kind = r.get('kind') as string | null;
      lines.push(`\n${r.get('name') as string}${kind ? ` [${kind}]` : ''}`);
      lines.push(`  File: ${r.get('filePath') as string ?? 'unknown'}`);
      if (typeBody) lines.push(typeBody);
    }
  }

  // Tests
  if (testRecords.length > 0) {
    lines.push(`\nTEST FILES (${testRecords.length})`);
    lines.push('-'.repeat(40));
    for (const r of testRecords) {
      const desc = r.get('description') as string | null;
      lines.push(`  ${r.get('filePath') as string}`);
      if (desc) lines.push(`    ${desc}`);
    }
  }

  // Changes
  if (changeRecords.length > 0) {
    lines.push(`\nRECENT CHANGES (${changeRecords.length})`);
    lines.push('-'.repeat(40));
    for (const r of changeRecords) {
      const pr = r.get('prNumber') as string | number | null;
      const date = r.get('date') as string | null;
      const author = r.get('author') as string | null;
      const desc = r.get('description') as string | null;
      const header = [
        date ? date.slice(0, 10) : null,
        pr ? `PR #${pr}` : null,
        author ? `by ${author}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      if (header) lines.push(`  ${header}`);
      if (desc) lines.push(`  ${desc}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
