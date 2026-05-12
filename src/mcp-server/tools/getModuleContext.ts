/**
 * getModuleContext.ts -- Return related functions, types, files, and constraints
 * for a given concept, feature area, or module name.
 *
 * Target response size: 1,000-3,000 tokens.
 * Function bodies are NOT included — use getFunctionDetail for deep dives.
 *
 * Search strategy (in order):
 *   1. Match Module nodes by name/domain/description
 *   2. Match Service nodes by name (so "conversation" finds conversation-engine)
 *   3. Fallback: match Function names (so "synaptogenesis" finds the service)
 */

import { runQuery } from '../neo4j-client.js';

export interface GetModuleContextInput {
  query: string;
}

/**
 * Handle the getModuleContext tool call.
 */
export async function handleGetModuleContext(input: GetModuleContextInput): Promise<string> {
  const { query } = input;

  // Split multi-word queries into individual terms for OR matching.
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const searchTerm =
    terms.length > 1
      ? `(?i).*(${terms.map(escapeRegex).join('|')}).*`
      : `(?i).*${escapeRegex(query)}.*`;

  // Combined search: Module name/packageName/domain + Service name + Function name
  const moduleRecords = await runQuery(
    `
    MATCH (m:Module)
    WHERE m.name =~ $pattern
       OR m.domain =~ $pattern
       OR m.description =~ $pattern
       OR m.packageName =~ $pattern
    OPTIONAL MATCH (m)-[:BELONGS_TO]->(s:Service)
    RETURN m.name AS moduleName,
           m.filePath AS filePath,
           m.description AS description,
           m.domain AS domain,
           m.packageName AS packageName,
           s.name AS serviceName
    UNION
    MATCH (m:Module)-[:BELONGS_TO]->(s:Service)
    WHERE s.name =~ $pattern
    RETURN m.name AS moduleName,
           m.filePath AS filePath,
           m.description AS description,
           m.domain AS domain,
           m.packageName AS packageName,
           s.name AS serviceName
    UNION
    MATCH (m:Module)-[:CONTAINS]->(f:Function)
    WHERE f.name =~ $pattern
    OPTIONAL MATCH (m)-[:BELONGS_TO]->(s:Service)
    RETURN DISTINCT m.name AS moduleName,
           m.filePath AS filePath,
           m.description AS description,
           m.domain AS domain,
           m.packageName AS packageName,
           s.name AS serviceName
    `,
    { pattern: searchTerm }
  );

  if (moduleRecords.length === 0) {
    return `No modules, services, or functions found matching "${query}". Try a single broad keyword (e.g., "executor" instead of "executor engine").`;
  }

  // Collect module file paths for querying
  const modulePaths = moduleRecords.map((r) => r.get('filePath') as string);

  // Get functions belonging to matching modules
  const functionRecords = await runQuery(
    `
    MATCH (m:Module)-[:CONTAINS]->(f:Function)
    WHERE m.filePath IN $modulePaths
    RETURN f.name AS name,
           f.filePath AS filePath,
           f.lineNumber AS lineNumber,
           f.args AS arguments,
           f.returnType AS returnType,
           f.jsDoc AS comment,
           f.isAsync AS isAsync,
           f.isExported AS isExported,
           m.name AS moduleName
    ORDER BY m.name, f.name
    LIMIT 60
    `,
    { modulePaths }
  );

  // Get types belonging to matching modules
  const typeRecords = await runQuery(
    `
    MATCH (m:Module)-[:CONTAINS]->(t:Type)
    WHERE m.filePath IN $modulePaths
    RETURN t.name AS name,
           t.filePath AS filePath,
           t.kind AS kind,
           m.name AS moduleName
    ORDER BY m.name, t.name
    LIMIT 40
    `,
    { modulePaths }
  );

  // Get constraints linked to matching modules
  const constraintRecords = await runQuery(
    `
    MATCH (m:Module)-[:CONSTRAINED_BY]->(c:Constraint)
    WHERE m.filePath IN $modulePaths
    RETURN c.description AS description,
           c.severity AS severity,
           m.name AS moduleName
    ORDER BY c.severity DESC, m.name
    LIMIT 20
    `,
    { modulePaths }
  );

  // Format output
  const lines: string[] = [];
  lines.push(`MODULE CONTEXT: "${query}"`);
  lines.push('='.repeat(60));

  // Modules
  lines.push(`\nMATCHED MODULES (${moduleRecords.length})`);
  lines.push('-'.repeat(40));
  for (const r of moduleRecords) {
    const service = r.get('serviceName') as string | null;
    const desc = r.get('description') as string | null;
    const domain = r.get('domain') as string | null;
    const pkgName = r.get('packageName') as string | null;
    lines.push(`${r.get('moduleName') as string}`);
    if (service) lines.push(`  Service: ${service}`);
    if (pkgName && pkgName !== service) lines.push(`  Package: ${pkgName}`);
    if (domain) lines.push(`  Domain: ${domain}`);
    if (desc) lines.push(`  Description: ${desc}`);
    lines.push(`  Path: ${r.get('filePath') as string ?? 'unknown'}`);
  }

  // Functions grouped by module
  if (functionRecords.length > 0) {
    lines.push(`\nFUNCTIONS (${functionRecords.length})`);
    lines.push('-'.repeat(40));
    let currentModule = '';
    for (const r of functionRecords) {
      const mod = r.get('moduleName') as string;
      if (mod !== currentModule) {
        lines.push(`\n[${mod}]`);
        currentModule = mod;
      }
      const isAsync = r.get('isAsync') as boolean | null;
      const isExported = r.get('isExported') as boolean | null;
      const args = r.get('arguments') as string | null;
      const ret = r.get('returnType') as string | null;
      const comment = r.get('comment') as string | null;
      const lineNo = r.get('lineNumber') as number | null;
      const filePath = r.get('filePath') as string | null;

      const prefix = [isExported ? 'export' : '', isAsync ? 'async' : ''].filter(Boolean).join(' ');
      const sig = `${prefix ? prefix + ' ' : ''}function ${r.get('name') as string}(${args ?? ''})${ret ? ': ' + ret : ''}`;
      lines.push(`  ${sig}`);
      if (filePath) lines.push(`    File: ${filePath}${lineNo != null ? `:${lineNo}` : ''}`);
      if (comment) lines.push(`    // ${comment.split('\n')[0]}`);
    }
  }

  // Types grouped by module
  if (typeRecords.length > 0) {
    lines.push(`\nTYPES (${typeRecords.length})`);
    lines.push('-'.repeat(40));
    let currentModule = '';
    for (const r of typeRecords) {
      const mod = r.get('moduleName') as string;
      if (mod !== currentModule) {
        lines.push(`\n[${mod}]`);
        currentModule = mod;
      }
      const kind = r.get('kind') as string | null;
      const filePath = r.get('filePath') as string | null;
      lines.push(`  ${r.get('name') as string}${kind ? ` (${kind})` : ''}`);
      if (filePath) lines.push(`    File: ${filePath}`);
    }
  }

  // Constraints
  if (constraintRecords.length > 0) {
    lines.push(`\nCONSTRAINTS (${constraintRecords.length})`);
    lines.push('-'.repeat(40));
    for (const r of constraintRecords) {
      const severity = r.get('severity') as string | null;
      const mod = r.get('moduleName') as string;
      lines.push(`  [${severity ?? 'unknown'}] (${mod}) ${r.get('description') as string}`);
    }
  }

  lines.push('\n' + '='.repeat(60));
  lines.push(`Use getFunctionDetail to get the body of any specific function.`);

  return lines.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
