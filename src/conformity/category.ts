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

import type { ParsedFunction, ParsedType, ParsedConstant } from '../sync/ast-parser.js';
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
 * The whole-declaration conformity category for MODULE-LEVEL CONSTANTS (top-level
 * non-function `const`/`let`/`var` initialized to objects/arrays/literals/calls,
 * e.g. `export const CONFIG = {...}`, route tables, lookup maps). Like
 * {@link FUNCTION_BODY}/{@link TYPE_BODY}, the embedded text is the declaration's
 * whole source, lightly normalized. Constants are only ever compared to other
 * constants, never to functions or types.
 */
export const MODULE_CONST = 'module:const';

/**
 * LEGACY category key. The signature-skeleton representation was abandoned (it
 * collapsed distinct functions to an identical string); kept exported only for
 * back-compat with older callers/tests. Not produced by {@link categoryOf}.
 */
export const FUNCTION_SIGNATURE_SKELETON = 'function:signature-skeleton';

/** All known category keys, in a stable order. */
export const CATEGORIES = [FUNCTION_BODY, TYPE_BODY, MODULE_CONST] as const;

/** A conformity category key. */
export type Category = (typeof CATEGORIES)[number];

/**
 * A parsed chunk the conformity engine can judge: a function, a type/class, OR a
 * module-level constant. All carry `bodyText` (the source text to embed).
 * {@link ParsedType} and {@link ParsedConstant} both carry a `kind` field;
 * a {@link ParsedFunction} never does. {@link ParsedConstant} is further
 * distinguished by `kind === 'const'`.
 */
export type ParsedChunk = ParsedFunction | ParsedType | ParsedConstant;

/**
 * Type guard: a {@link ParsedConstant} is discriminated by `kind === 'const'`
 * (the literal value the parser stamps on module-level constants). A
 * {@link ParsedType}'s `kind` is one of 'interface' | 'type' | 'enum' | 'class',
 * so this is unambiguous.
 */
export function isParsedConstant(chunk: ParsedChunk): chunk is ParsedConstant {
  return (chunk as ParsedConstant).kind === 'const';
}

/**
 * Type guard: a {@link ParsedType} is discriminated from a {@link ParsedFunction}
 * by the presence of a `kind` field ('interface' | 'type' | 'enum' | 'class').
 * Excludes {@link ParsedConstant} (kind === 'const'), which also has a `kind`.
 */
export function isParsedType(chunk: ParsedChunk): chunk is ParsedType {
  return typeof (chunk as ParsedType).kind === 'string' && !isParsedConstant(chunk);
}

/**
 * Derive the conformity category for a parsed chunk.
 *
 * Module-level constants (kind === 'const') map to {@link MODULE_CONST};
 * types/classes map to {@link TYPE_BODY}; functions map to {@link FUNCTION_BODY}.
 * Conformity is always measured WITHIN a category, so constants are only ever
 * compared to constants, types to types, and functions to functions. Add a case
 * here (and to {@link CATEGORIES}) to introduce a new category.
 */
export function categoryOf(chunk: ParsedChunk): Category {
  if (isParsedConstant(chunk)) return MODULE_CONST;
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
