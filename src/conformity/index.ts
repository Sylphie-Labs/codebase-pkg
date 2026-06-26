/**
 * conformity -- the Conformity Judge engine (step 1: engine + tests only).
 *
 * Public surface for scoring how well a parsed code chunk conforms to a pool of
 * structurally similar peers, using per-category embedding distance. This entry
 * deliberately exposes ONLY the engine: it does not touch the sync pipeline,
 * Neo4j, or the MCP server -- that wiring comes in later steps.
 */

// Embedding backend + injection point
export { embed, CHOSEN_MODEL, MODEL_CANDIDATES } from './embed.js';
export type { Embedder } from './embed.js';

// Text normalization / canonicalization. `normalizedBody` is the current
// embedding path; the signature helpers are legacy (back-compat/diagnostics).
export {
  collapseWhitespace,
  normalizedBody,
  rawSignature,
  normalizedSignature,
  signatureText,
} from './normalize.js';
export type { BodyLike, SignatureLike, SignatureMode } from './normalize.js';

// Category derivation. `representationText`/`FUNCTION_BODY` are current;
// `signatureSkeleton`/`FUNCTION_SIGNATURE_SKELETON` are legacy.
export {
  categoryOf,
  representationText,
  signatureSkeleton,
  CATEGORIES,
  FUNCTION_BODY,
  FUNCTION_SIGNATURE_SKELETON,
} from './category.js';
export type { Category, SkeletonOptions } from './category.js';

// Distance math
export {
  dot,
  norm,
  cosineSimilarity,
  cosineDistance,
  knnPoolDistance,
  knnNearest,
  DEFAULT_K,
} from './distance.js';
export type { VectorEntry, NearestNeighbor } from './distance.js';

// Orchestrator
export {
  judgeChunk,
  FALLBACK_OUTLIER_THRESHOLD,
  DRAFT_OUTLIER_THRESHOLD,
} from './judge.js';
export type {
  PoolEntry,
  Judgment,
  Verdict,
  JudgeOptions,
} from './judge.js';

// Calibration (step R2): in-distribution outlier-threshold computation.
export {
  computeCalibration,
  percentile,
  DEFAULT_PERCENTILE,
} from './calibration.js';
export type { CalibrationRow, CalibrationOptions } from './calibration.js';

// Vector data layer (step 2a): pgvector cold store + in-memory hot cache.
// Postgres connection surface.
export {
  getPgPool,
  closePgPool,
  pgQuery,
  resolvePgConfig,
  realPgRunner,
} from './pg-client.js';
export type { PgRunner } from './pg-client.js';

// Schema bootstrap.
export { ensureSchema, EMBEDDING_DIM, VECTORS_TABLE, CALIBRATION_TABLE } from './schema.js';

// Store: upsert/delete/loadPool/coldNearest + calibration + nodeIdOf helper.
export { ConformityStore, createConformityStore, nodeIdOf } from './store.js';
export type { VectorRecord, NearestHit, StoredCalibration } from './store.js';

// Calibration command surface (backfill computes it; calibrate recomputes it).
export {
  runConformityBackfill,
  runConformityCalibrate,
} from './conformity-backfill.js';

// Judgment surface (step 4): judge working-tree code against the committed pool.
export {
  judgeFunctions,
  judgeWorkingTree,
  judgeFile,
  isUnavailable,
} from './judge-worktree.js';
export type {
  FunctionJudgment,
  Neighbor,
  UnavailableResult,
  JudgeResult,
  JudgeWorktreeOptions,
} from './judge-worktree.js';
export { runConformityJudge } from './judge-cli.js';
