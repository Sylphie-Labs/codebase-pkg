/**
 * @anthrorg-infra/codebase-pkg — public library entry.
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

export { parseFiles, parseFile, clearProjectCache } from './sync/ast-parser.js';
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
