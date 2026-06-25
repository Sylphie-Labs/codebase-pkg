/**
 * category.ts -- conformity category derivation.
 *
 * A "category" is the structural class a chunk belongs to. Conformity is always
 * measured WITHIN a category: a function's signature skeleton is only compared
 * to other signature skeletons, never to unrelated shapes. This module owns the
 * mapping from a parsed chunk to its category key, plus the canonical text
 * (skeleton) used to embed it.
 *
 * Currently there is exactly one category, `function:signature-skeleton`,
 * derived from a parsed function's `args` + `returnType` only (never the body).
 * Adding categories later should be a matter of adding a case here and a
 * skeleton renderer -- not rewiring callers.
 */

import type { ParsedFunction } from '../sync/ast-parser.js';
import {
  signatureText,
  type SignatureLike,
  type SignatureMode,
} from './normalize.js';

/** The set of conformity category keys this build understands. */
export const FUNCTION_SIGNATURE_SKELETON = 'function:signature-skeleton';

/** All known category keys, in a stable order. */
export const CATEGORIES = [FUNCTION_SIGNATURE_SKELETON] as const;

/** A conformity category key. */
export type Category = (typeof CATEGORIES)[number];

/**
 * Derive the conformity category for a parsed chunk.
 *
 * Today every parsed function maps to the single signature-skeleton category.
 * When more categories are added (e.g. whole-body shape, class shape), branch
 * here on the chunk's properties and return the appropriate key.
 */
export function categoryOf(_fn: ParsedFunction): Category {
  return FUNCTION_SIGNATURE_SKELETON;
}

/** Options for {@link signatureSkeleton}. */
export interface SkeletonOptions {
  /** Use the normalized structural skeleton (default) vs the raw signature. */
  normalized?: boolean;
}

/**
 * Produce the canonical text that represents `fn` within its category -- i.e.
 * the string handed to the embedder. For `function:signature-skeleton` this is
 * the normalized signature skeleton by default; pass `{ normalized: false }`
 * to get the raw signature instead (diagnostics only).
 */
export function signatureSkeleton(
  fn: SignatureLike,
  opts: SkeletonOptions = {},
): string {
  const mode: SignatureMode = opts.normalized === false ? 'raw' : 'normalized';
  return signatureText(fn, mode);
}
