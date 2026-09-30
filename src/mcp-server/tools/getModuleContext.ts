/**
 * getModuleContext.ts -- Return related functions, types, files, and constraints
 * for a given concept, feature area, or module name.
 *
 * Target response size: 1,000-3,000 tokens.
 * Function bodies are NOT included — use getFunctionDetail for deep dives.
 *
 * Search strategy (in order):
 *   1. Match Module nodes by name/packageName
 *   2. Match Service nodes by name (so "auth" finds the auth-service)
 *   3. Fallback: match Function names (so a function keyword finds its module)
 *
 * Structured as gather (Neo4j -> plain data) + render (data -> text/json) so
 * `format: "json"` (#10, MCP-SERVER-IMPROVEMENTS.md) is a pure serialization
 * of the same data the text render uses, not a second query path. `runQuery`
 * is injectable (mirrors graph-ref-validator.js) so the gather step is unit-
 * testable without a live Neo4j.
 */

import { runQuery as defaultRunQuery } from '../neo4j-client.js';
import type { RunQueryFn } from './graph-ref-validator.js';

export interface GetModuleContextInput {
  query: string;
  /** 'text' (default) for direct model consumption, or 'json' for a stable machine-parseable envelope (#10). */
  format?: 'text' | 'json';
}

/** Injectable dependencies for testing; production uses the real Neo4j singleton. */
export interface GetModuleContextDeps {
  runQuery?: RunQueryFn;
}

export interface ModuleContextModule {
  name: string;
  filePath: string | null;
  packageName: string | null;
  service: string | null;
}

export interface ModuleContextFunction {
  name: string;
  module: string;
  filePath: string | null;
  lineNumber: number | null;
  args: string | null;
  returnType: string | null;
  comment: string | null;
  isAsync: boolean | null;
  isExported: boolean | null;
}

export interface ModuleContextType {
  name: string;
  module: string;
  filePath: string | null;
  kind: string | null;
}

export interface ModuleContextConstraint {
  module: string;
  description: string;
  severity: string | null;
}

export interface ModuleContextResult {
  query: string;
  modules: ModuleContextModule[];
  functions: ModuleContextFunction[];
  types: ModuleContextType[];
  constraints: ModuleContextConstraint[];
}

/**
 * Gather the structured module-context data from Neo4j. Returns null when no
 * modules/services/functions matched `query` at all (the "no matches" case).
 */
export async function gatherModuleContext(
  query: string,
  runQuery: RunQueryFn = defaultRunQuery,
): Promise<ModuleContextResult | null> {
  // Match the whole query string as a single phrase (multi-word queries must
  // match in full, so "executor engine" does NOT match a module named just
  // "engine"). Single-word queries behave the same way.
  const searchTerm = `(?i).*${escapeRegex(query.trim())}.*`;

  // Combined search: Module name/packageName + Service name + Function name.
  // Module nodes are directory-keyed and only store name/packageName — there is
  // no domain/description property, so we don't match or return those.
  const moduleRecords = await runQuery(
    `
    MATCH (m:Module)
    WHERE m.name =~ $pattern
       OR m.packageName =~ $pattern
    OPTIONAL MATCH (m)-[:BELONGS_TO]->(s:Service)
    RETURN m.name AS moduleName,
           m.filePath AS filePath,
           m.packageName AS packageName,
           s.name AS serviceName
    UNION
    MATCH (m:Module)-[:BELONGS_TO]->(s:Service)
    WHERE s.name =~ $pattern
    RETURN m.name AS moduleName,
           m.filePath AS filePath,
           m.packageName AS packageName,
           s.name AS serviceName
    UNION
    MATCH (m:Module)-[:CONTAINS]->(f:Function)
    WHERE f.name =~ $pattern
    OPTIONAL MATCH (m)-[:BELONGS_TO]->(s:Service)
    RETURN DISTINCT m.name AS moduleName,
           m.filePath AS filePath,
           m.packageName AS packageName,
           s.name AS serviceName
    LIMIT 15
    `,
    { pattern: searchTerm },
  );

  if (moduleRecords.length === 0) return null;

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
    { modulePaths },
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
    { modulePaths },
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
    { modulePaths },
  );

  return {
    query,
    modules: moduleRecords.map((r) => ({
      name: r.get('moduleName') as string,
      filePath: (r.get('filePath') as string | null) ?? null,
      packageName: (r.get('packageName') as string | null) ?? null,
      service: (r.get('serviceName') as string | null) ?? null,
    })),
    functions: functionRecords.map((r) => ({
      name: r.get('name') as string,
      module: r.get('moduleName') as string,
      filePath: (r.get('filePath') as string | null) ?? null,
      lineNumber: (r.get('lineNumber') as number | null) ?? null,
      args: (r.get('arguments') as string | null) ?? null,
      returnType: (r.get('returnType') as string | null) ?? null,
      comment: (r.get('comment') as string | null) ?? null,
      isAsync: (r.get('isAsync') as boolean | null) ?? null,
      isExported: (r.get('isExported') as boolean | null) ?? null,
    })),
    types: typeRecords.map((r) => ({
      name: r.get('name') as string,
      module: r.get('moduleName') as string,
      filePath: (r.get('filePath') as string | null) ?? null,
      kind: (r.get('kind') as string | null) ?? null,
    })),
    constraints: constraintRecords.map((r) => ({
      module: r.get('moduleName') as string,
      description: r.get('description') as string,
      severity: (r.get('severity') as string | null) ?? null,
    })),
  };
}

/** Render a {@link ModuleContextResult} as the original text format. */
export function renderModuleContextText(result: ModuleContextResult): string {
  const lines: string[] = [];
  lines.push(`MODULE CONTEXT: "${result.query}"`);
  lines.push('='.repeat(60));

  // Modules
  lines.push(`\nMATCHED MODULES (${result.modules.length})`);
  lines.push('-'.repeat(40));
  for (const m of result.modules) {
    lines.push(m.name);
    if (m.service) lines.push(`  Service: ${m.service}`);
    if (m.packageName && m.packageName !== m.service) lines.push(`  Package: ${m.packageName}`);
    lines.push(`  Path: ${m.filePath ?? 'unknown'}`);
  }

  // Functions grouped by module
  if (result.functions.length > 0) {
    lines.push(`\nFUNCTIONS (${result.functions.length})`);
    lines.push('-'.repeat(40));
    let currentModule = '';
    for (const f of result.functions) {
      if (f.module !== currentModule) {
        lines.push(`\n[${f.module}]`);
        currentModule = f.module;
      }
      const prefix = [f.isExported ? 'export' : '', f.isAsync ? 'async' : ''].filter(Boolean).join(' ');
      const sig = `${prefix ? prefix + ' ' : ''}function ${f.name}(${f.args ?? ''})${f.returnType ? ': ' + f.returnType : ''}`;
      lines.push(`  ${sig}`);
      if (f.filePath) lines.push(`    File: ${f.filePath}${f.lineNumber != null ? `:${f.lineNumber}` : ''}`);
      if (f.comment) lines.push(`    // ${f.comment.split('\n')[0]}`);
    }
  }

  // Types grouped by module
  if (result.types.length > 0) {
    lines.push(`\nTYPES (${result.types.length})`);
    lines.push('-'.repeat(40));
    let currentModule = '';
    for (const t of result.types) {
      if (t.module !== currentModule) {
        lines.push(`\n[${t.module}]`);
        currentModule = t.module;
      }
      lines.push(`  ${t.name}${t.kind ? ` (${t.kind})` : ''}`);
      if (t.filePath) lines.push(`    File: ${t.filePath}`);
    }
  }

  // Constraints
  if (result.constraints.length > 0) {
    lines.push(`\nCONSTRAINTS (${result.constraints.length})`);
    lines.push('-'.repeat(40));
    for (const c of result.constraints) {
      lines.push(`  [${c.severity ?? 'unknown'}] (${c.module}) ${c.description}`);
    }
  }

  lines.push('\n' + '='.repeat(60));
  lines.push(`Use getFunctionDetail to get the body of any specific function.`);

  return lines.join('\n');
}

/**
 * Handle the getModuleContext tool call.
 */
export async function handleGetModuleContext(
  input: GetModuleContextInput,
  deps: GetModuleContextDeps = {},
): Promise<string> {
  const { query } = input;
  const runQuery = deps.runQuery ?? defaultRunQuery;

  const result = await gatherModuleContext(query, runQuery);

  if (result === null) {
    if (input.format === 'json') {
      return JSON.stringify(
        {
          schemaVersion: 1,
          tool: 'getModuleContext',
          query,
          modules: [],
          functions: [],
          types: [],
          constraints: [],
        },
        null,
        2,
      );
    }
    return `No modules, services, or functions found matching "${query}". Try a single broad keyword (e.g., "authentication" instead of "authentication and sessions").`;
  }

  if (input.format === 'json') {
    return JSON.stringify({ schemaVersion: 1, tool: 'getModuleContext', ...result }, null, 2);
  }

  return renderModuleContextText(result);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
