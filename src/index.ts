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
export {
  runConformityBackfill,
  runConformityCalibrate,
} from './conformity/conformity-backfill.js';
export { embedAndStoreFunctions } from './conformity/embed-functions.js';
export type {
  EmbedAndStoreOptions,
  EmbedAndStoreResult,
} from './conformity/embed-functions.js';
export {
  runConformityStep,
  functionsToEmbed,
  deletedFunctionIds,
  isConformityEnabled,
} from './conformity/sync-hook.js';
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

// Conformity Judge engine (whole-body conformity via embedding distance).
// Engine only -- not yet wired into sync/Neo4j/MCP.
export {
  judgeChunk,
  categoryOf,
  representationText,
  normalizedBody,
  signatureSkeleton,
  normalizedSignature,
  rawSignature,
  signatureText,
  cosineDistance,
  knnPoolDistance,
  knnNearest,
  embed as embedSkeletons,
  CHOSEN_MODEL,
  MODEL_CANDIDATES,
  CATEGORIES,
  FUNCTION_BODY,
  FUNCTION_SIGNATURE_SKELETON,
  DEFAULT_K,
  DRAFT_OUTLIER_THRESHOLD,
  FALLBACK_OUTLIER_THRESHOLD,
  judgeFunctions,
  judgeWorkingTree,
  judgeFile,
  isUnavailable,
  runConformityJudge,
} from './conformity/index.js';
export type {
  Embedder,
  Category,
  BodyLike,
  SignatureLike,
  SignatureMode,
  SkeletonOptions,
  PoolEntry,
  Judgment,
  Verdict,
  JudgeOptions,
  VectorEntry,
  NearestNeighbor,
  FunctionJudgment,
  Neighbor,
  UnavailableResult,
  JudgeResult,
  JudgeWorktreeOptions,
} from './conformity/index.js';
