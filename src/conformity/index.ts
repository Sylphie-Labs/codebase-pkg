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

// Signature normalization / canonicalization
export {
  collapseWhitespace,
  rawSignature,
  normalizedSignature,
  signatureText,
} from './normalize.js';
export type { SignatureLike, SignatureMode } from './normalize.js';

// Category derivation
export {
  categoryOf,
  signatureSkeleton,
  CATEGORIES,
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
  DEFAULT_K,
} from './distance.js';

// Orchestrator
export { judgeChunk, DRAFT_OUTLIER_THRESHOLD } from './judge.js';
export type {
  PoolEntry,
  Judgment,
  Verdict,
  JudgeOptions,
} from './judge.js';
