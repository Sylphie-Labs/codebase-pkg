/**
 * @sylphie-labs/codebase-pkg — public library entry.
 *
 * Most consumers use this package via the CLI or the MCP server. This entry
 * exists so programmatic consumers can run the sync pipeline, integrity
 * checks, or seed flow as library calls inside their own tooling.
 */

export { runSync } from './sync/sync-pipeline.js';
export { runSeed } from './ingestion/initial-seed.js';
export { runIntegrityChecks } from './sync/integrity-checker.js';
export { runBackfillChanges } from './ingestion/backfill-changes.js';
export { runAddConstraints, loadConstraints } from './ingestion/manual-constraints.js';
export type {
  ConstraintDefinition,
  ConstraintSeverity,
  ConstraintScopeType,
} from './ingestion/manual-constraints.js';

export { getDriver, closeDriver, runQuery } from './mcp-server/neo4j-client.js';

// Language-dispatching parser (routes .ts/.tsx to ts-morph, .py to the
// Python runtime). This is the parseFiles consumers should use.
export { parseFiles, clearProjectCache } from './sync/parser.js';
export { parseFile, parseFiles as parseTypeScriptFiles } from './sync/ast-parser.js';
export { parsePythonFiles, pythonAvailable } from './sync/python-parser.js';
export {
  resolveImportTarget,
  resolvePythonImportTarget,
  getWatchedPackages,
} from './sync/import-resolver.js';
export type { WatchedPackage } from './sync/import-resolver.js';
export type {
  ParsedFile,
  ParsedFunction,
  ParsedType,
  ParsedImport,
  ParsedArgument,
  ParsedProperty,
  ParsedDecorator,
  ParsedConstructorParam,
} from './sync/ast-parser.js';

export {
  DOMAIN_LABELS,
  writeDomainLabels,
  isSignificantChange,
} from './sync/domain-classifier.js';
export type { DomainLabel, ClassificationResult } from './sync/domain-classifier.js';
