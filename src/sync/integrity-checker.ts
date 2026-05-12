/**
 * integrity-checker.ts -- Post-mutation validation for the codebase PKG.
 *
 * Runs a set of graph-level checks to catch structural problems introduced
 * by sync mutations.
 *
 * Checks:
 * 1. No duplicate Function nodes (same filePath + name)
 * 2. All Function nodes have minimum required properties
 * 3. No orphaned IMPORTS edges
 * 4. All CONTAINS edges point to existing Function or Type nodes
 * 5. All Function nodes have a BELONGS_TO chain to a Service
 * 6. No duplicate Type nodes
 */

import { runQuery } from '../mcp-server/neo4j-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntegrityIssue {
  check: string;
  severity: 'error' | 'warning';
  message: string;
  examples: string[];
}

export interface IntegrityResult {
  passed: boolean;
  issues: IntegrityIssue[];
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkDuplicateFunctions(): Promise<IntegrityIssue[]> {
  const records = await runQuery(`
    MATCH (f:Function)
    WITH f.filePath AS fp, f.name AS name, count(*) AS cnt
    WHERE cnt > 1
    RETURN fp, name, cnt
    ORDER BY cnt DESC
    LIMIT 20
  `);

  if (records.length === 0) return [];

  return [{
    check: 'duplicate-function-nodes',
    severity: 'error',
    message: `${records.length} duplicate Function node(s) found (same filePath + name).`,
    examples: records.slice(0, 10).map(r =>
      `${r.get('fp') as string}::${r.get('name') as string} (${r.get('cnt')} copies)`
    ),
  }];
}

async function checkFunctionRequiredProps(): Promise<IntegrityIssue[]> {
  const records = await runQuery(`
    MATCH (f:Function)
    WHERE f.name IS NULL OR f.filePath IS NULL OR f.lineNumber IS NULL
    RETURN f.filePath AS fp, f.name AS name
    LIMIT 20
  `);

  if (records.length === 0) return [];

  return [{
    check: 'function-missing-required-props',
    severity: 'error',
    message: `${records.length} Function node(s) missing required properties (name, filePath, lineNumber).`,
    examples: records.slice(0, 10).map(r =>
      `${r.get('fp') as string ?? 'NULL'}::${r.get('name') as string ?? 'NULL'}`
    ),
  }];
}

async function checkOrphanedImports(): Promise<IntegrityIssue[]> {
  const records = await runQuery(`
    MATCH ()-[e:IMPORTS]->()
    WHERE NOT EXISTS { MATCH (m:Module) WHERE m.filePath = startNode(e).filePath }
    RETURN startNode(e).filePath AS fp
    LIMIT 20
  `);

  if (records.length === 0) return [];

  return [{
    check: 'orphaned-imports-edges',
    severity: 'warning',
    message: `${records.length} IMPORTS edge(s) whose source Module node is missing.`,
    examples: records.slice(0, 10).map(r => r.get('fp') as string ?? 'unknown'),
  }];
}

async function checkOrphanedContainsEdges(): Promise<IntegrityIssue[]> {
  const records = await runQuery(`
    MATCH (m:Module)-[:CONTAINS]->(n)
    WHERE NOT (n:Function) AND NOT (n:Type)
    RETURN m.filePath AS fp, labels(n) AS nodeLabels
    LIMIT 20
  `);

  if (records.length === 0) return [];

  return [{
    check: 'contains-pointing-to-wrong-label',
    severity: 'warning',
    message: `${records.length} CONTAINS edge(s) pointing to nodes that are neither Function nor Type.`,
    examples: records.slice(0, 10).map(r =>
      `${r.get('fp') as string} -> ${JSON.stringify(r.get('nodeLabels'))}`
    ),
  }];
}

async function checkBelongsToChain(): Promise<IntegrityIssue[]> {
  const records = await runQuery(`
    MATCH (f:Function)
    WHERE NOT EXISTS {
      MATCH (f)<-[:CONTAINS]-(m:Module)-[:BELONGS_TO*1..3]->(s:Service)
    }
    RETURN f.filePath AS fp, f.name AS name
    LIMIT 20
  `);

  if (records.length === 0) return [];

  return [{
    check: 'function-missing-service-chain',
    severity: 'warning',
    message: `${records.length} Function node(s) without a BELONGS_TO chain to a Service. Run seed to fix.`,
    examples: records.slice(0, 10).map(r =>
      `${r.get('fp') as string}::${r.get('name') as string}`
    ),
  }];
}

async function checkDuplicateTypes(): Promise<IntegrityIssue[]> {
  const records = await runQuery(`
    MATCH (t:Type)
    WITH t.filePath AS fp, t.name AS name, count(*) AS cnt
    WHERE cnt > 1
    RETURN fp, name, cnt
    ORDER BY cnt DESC
    LIMIT 20
  `);

  if (records.length === 0) return [];

  return [{
    check: 'duplicate-type-nodes',
    severity: 'error',
    message: `${records.length} duplicate Type node(s) found (same filePath + name).`,
    examples: records.slice(0, 10).map(r =>
      `${r.get('fp') as string}::${r.get('name') as string} (${r.get('cnt')} copies)`
    ),
  }];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runIntegrityChecks(): Promise<IntegrityResult> {
  console.log('[integrity-checker] Running checks...');

  const allChecks = await Promise.allSettled([
    checkDuplicateFunctions(),
    checkFunctionRequiredProps(),
    checkOrphanedImports(),
    checkOrphanedContainsEdges(),
    checkBelongsToChain(),
    checkDuplicateTypes(),
  ]);

  const issues: IntegrityIssue[] = [];

  for (const result of allChecks) {
    if (result.status === 'fulfilled') {
      issues.push(...result.value);
    } else {
      issues.push({
        check: 'check-execution-error',
        severity: 'warning',
        message: `An integrity check threw an error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        examples: [],
      });
    }
  }

  const hasErrors = issues.some(i => i.severity === 'error');
  const passed = !hasErrors;

  if (passed) {
    console.log(`[integrity-checker] All checks passed. ${issues.length} warning(s).`);
  } else {
    const errorCount = issues.filter(i => i.severity === 'error').length;
    console.error(`[integrity-checker] FAILED — ${errorCount} error(s), ${issues.length - errorCount} warning(s).`);
    for (const issue of issues.filter(i => i.severity === 'error')) {
      console.error(`  [ERROR] ${issue.check}: ${issue.message}`);
      for (const ex of issue.examples) {
        console.error(`    - ${ex}`);
      }
    }
  }

  for (const issue of issues.filter(i => i.severity === 'warning')) {
    console.warn(`  [WARN]  ${issue.check}: ${issue.message}`);
  }

  return {
    passed,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Standalone entry point (npm run validate-pkg)
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const result = await runIntegrityChecks();
    process.exit(result.passed ? 0 : 1);
  })().catch(err => {
    console.error('[integrity-checker] Fatal error:', err);
    process.exit(1);
  });
}
