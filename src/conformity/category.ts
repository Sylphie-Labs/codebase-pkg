/**
 * category.ts -- conformity category derivation.
 *
 * A "category" is the structural class a chunk belongs to. Conformity is always
 * measured WITHIN a category: a function is only compared to other functions of
 * the same category, never to unrelated shapes. This module owns the mapping
 * from a parsed chunk to its category key, plus the canonical text used to
 * embed it.
 *
 * CURRENT representation: `function:body`. Each parsed function maps to this
 * single category, and the text we embed is its WHOLE BODY, lightly normalized
 * (see {@link representationText} -> normalizedBody). Controlled experiments
 * showed the previous `function:signature-skeleton` representation collapsed all
 * distinct functions to the same string and was abandoned; the legacy signature
 * helpers below are kept only for back-compat/diagnostics.
 *
 * Adding categories later should be a matter of adding a case to categoryOf and
 * a representation renderer -- not rewiring callers.
 */

import type { ParsedFunction, ParsedType } from '../sync/ast-parser.js';
import {
  normalizedBody,
  signatureText,
  type SignatureLike,
  type SignatureMode,
} from './normalize.js';

/** The current (whole-body) conformity category for functions. */
export const FUNCTION_BODY = 'function:body';

/**
 * The whole-declaration conformity category for TYPES/CLASSES (interfaces, type
 * aliases, enums, classes). Like {@link FUNCTION_BODY} for functions, the text
 * embedded is the declaration's whole source, lightly normalized. Types are only
 * ever compared to other types, never to functions.
 */
export const TYPE_BODY = 'type:body';

/**
 * LEGACY category key. The signature-skeleton representation was abandoned (it
 * collapsed distinct functions to an identical string); kept exported only for
 * back-compat with older callers/tests. Not produced by {@link categoryOf}.
 */
export const FUNCTION_SIGNATURE_SKELETON = 'function:signature-skeleton';

/** All known category keys, in a stable order. */
export const CATEGORIES = [FUNCTION_BODY, TYPE_BODY] as const;

/** A conformity category key. */
export type Category = (typeof CATEGORIES)[number];

/**
 * A parsed chunk the conformity engine can judge: a function OR a type/class.
 * Both carry `bodyText` (the source text to embed); a {@link ParsedType} is
 * discriminated by its `kind` field, which {@link ParsedFunction} never has.
 */
export type ParsedChunk = ParsedFunction | ParsedType;

/**
 * Type guard: a {@link ParsedType} is discriminated from a {@link ParsedFunction}
 * by the presence of a `kind` field ('interface' | 'type' | 'enum' | 'class').
 */
export function isParsedType(chunk: ParsedChunk): chunk is ParsedType {
  return typeof (chunk as ParsedType).kind === 'string';
}

/**
 * Derive the conformity category for a parsed chunk.
 *
 * Functions map to {@link FUNCTION_BODY}; types/classes (which carry a `kind`
 * discriminator) map to {@link TYPE_BODY}. Conformity is always measured WITHIN
 * a category, so functions are only ever compared to functions and types only to
 * types. Add a case here (and to {@link CATEGORIES}) to introduce a new category.
 */
export function categoryOf(chunk: ParsedChunk): Category {
  return isParsedType(chunk) ? TYPE_BODY : FUNCTION_BODY;
}

/**
 * The canonical text that represents `chunk` within its category -- i.e. the
 * string handed to the embedder. For both `function:body` and `type:body` this
 * is the chunk's whole body/declaration source, lightly normalized (comments
 * stripped, whitespace collapsed, identifiers/literals kept). This is the
 * validated embedding path.
 */
export function representationText(chunk: ParsedChunk): string {
  return normalizedBody(chunk);
}

/** Options for {@link signatureSkeleton} (legacy). */
export interface SkeletonOptions {
  /** Use the normalized structural skeleton (default) vs the raw signature. */
  normalized?: boolean;
}

/**
 * LEGACY: produce the signature-skeleton text for `fn`. This was the old
 * embedding representation; it is NO LONGER used to embed (see
 * {@link representationText}). Kept exported for back-compat and diagnostics.
 * Default is the normalized skeleton; pass `{ normalized: false }` for the raw
 * signature.
 */
export function signatureSkeleton(
  fn: SignatureLike,
  opts: SkeletonOptions = {},
): string {
  const mode: SignatureMode = opts.normalized === false ? 'raw' : 'normalized';
  return signatureText(fn, mode);
}
