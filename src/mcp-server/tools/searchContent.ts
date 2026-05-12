/**
 * searchContent.ts -- Search function/type source code via CodeBlock nodes.
 *
 * Searches bodyText stored on CodeBlock nodes (connected to Function/Type via
 * HAS_CODE edges). Returns the parent function/type metadata with matching
 * code snippets — a scalpel grep that tells you "this string appears in
 * ClassName.methodName at file.ts:100-250" instead of raw line numbers.
 *
 * Target response size: 500-3,000 tokens.
 */

import { runQuery } from '../neo4j-client.js';

export interface SearchContentInput {
  pattern: string;
  fileFilter?: string;
  maxResults?: number;
}

/**
 * Handle the searchContent tool call.
 */
export async function handleSearchContent(input: SearchContentInput): Promise<string> {
  const { pattern, fileFilter } = input;
  const maxResults = Math.min(input.maxResults ?? 20, 50);

  const searchPattern = `(?i).*${escapeRegex(pattern)}.*`;

  // Search CodeBlock nodes, traverse back to parent Function/Type
  const records = await runQuery(
    `
    MATCH (parent)-[:HAS_CODE]->(cb:CodeBlock)
    WHERE cb.bodyText =~ $pattern
      ${fileFilter ? 'AND cb.filePath CONTAINS $fileFilter' : ''}
    RETURN parent.name AS name,
           labels(parent) AS labels,
           parent.filePath AS filePath,
           parent.lineNumber AS lineNumber,
           parent.endLine AS endLine,
           parent.returnType AS returnType,
           parent.args AS args,
           parent.isExported AS isExported,
           parent.isAsync AS isAsync,
           cb.bodyText AS bodyText
    ORDER BY parent.filePath, parent.lineNumber
    LIMIT $maxResults
    `,
    fileFilter
      ? { pattern: searchPattern, fileFilter, maxResults }
      : { pattern: searchPattern, maxResults }
  );

  // Fallback: also search old-style bodyText on Function nodes
  let fallbackRecords: typeof records = [];
  if (records.length === 0) {
    fallbackRecords = await runQuery(
      `
      MATCH (f:Function)
      WHERE f.bodyText =~ $pattern
        ${fileFilter ? 'AND f.filePath CONTAINS $fileFilter' : ''}
      RETURN f.name AS name,
             ['Function'] AS labels,
             f.filePath AS filePath,
             f.lineNumber AS lineNumber,
             f.endLine AS endLine,
             f.returnType AS returnType,
             f.args AS args,
             f.isExported AS isExported,
             f.isAsync AS isAsync,
             f.bodyText AS bodyText
      ORDER BY f.filePath, f.lineNumber
      LIMIT $maxResults
      `,
      fileFilter
        ? { pattern: searchPattern, fileFilter, maxResults }
        : { pattern: searchPattern, maxResults }
    );
  }

  const allRecords = records.length > 0 ? records : fallbackRecords;

  if (allRecords.length === 0) {
    return `No code containing "${pattern}" found in the codebase PKG.${
      fileFilter ? ` (filtered to paths containing: ${fileFilter})` : ''
    }`;
  }

  const lines: string[] = [];
  lines.push(`CONTENT SEARCH: "${pattern}"`);
  if (fileFilter) lines.push(`File filter: ${fileFilter}`);
  lines.push('='.repeat(60));
  lines.push(`\nMATCHES (${allRecords.length})`);
  lines.push('-'.repeat(40));

  for (const r of allRecords) {
    const name = r.get('name') as string;
    const labels = r.get('labels') as string[];
    const filePath = r.get('filePath') as string | null;
    const lineNo = r.get('lineNumber') as number | null;
    const endLine = r.get('endLine') as number | null;
    const returnType = r.get('returnType') as string | null;
    const isAsync = r.get('isAsync') as boolean | null;
    const isExported = r.get('isExported') as boolean | null;
    const bodyText = r.get('bodyText') as string | null;

    const prefix = [isExported ? 'export' : '', isAsync ? 'async' : '']
      .filter(Boolean)
      .join(' ');
    const typeTag = labels.includes('Type') ? ` [${r.get('kind') ?? 'type'}]` : '';
    const retTag = returnType ? `: ${returnType}` : '';

    lines.push(`\n  ${prefix ? prefix + ' ' : ''}${name}${retTag}${typeTag}`);
    lines.push(`    File: ${filePath ?? 'unknown'}${lineNo != null ? `:${lineNo}` : ''}${endLine != null ? `-${endLine}` : ''}`);

    // Extract matching lines from body for context
    if (bodyText) {
      const bodyLines = bodyText.split('\n');
      const patternLower = pattern.toLowerCase();
      const matchingLines: string[] = [];
      for (let i = 0; i < bodyLines.length; i++) {
        if (bodyLines[i]!.toLowerCase().includes(patternLower)) {
          matchingLines.push(`      ${i + 1}: ${bodyLines[i]!.trim()}`);
          if (matchingLines.length >= 5) break;
        }
      }
      if (matchingLines.length > 0) {
        lines.push('    Matching lines:');
        lines.push(...matchingLines);
      }
    }
  }

  lines.push('\n' + '='.repeat(60));
  lines.push('Use getFunctionDetail for the full body of any matched function.');

  return lines.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
