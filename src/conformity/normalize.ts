/**
 * normalize.ts -- function text canonicalization for embedding.
 *
 * CURRENT embedding path: `normalizedBody` (the whole function body, lightly
 * normalized). Controlled experiments (experiments/conformity-controlled,
 * experiments/conformity-corpus) showed the old `function:signature-skeleton`
 * representation collapsed every distinct function to the SAME string
 * (`"NAME(ARG: TYPE): RET"`), so everything embedded to ~0 distance and the
 * judge could not separate anything. Embedding the WHOLE BODY (lightly
 * normalized, identifiers/literals KEPT) with the code embedding model recovers
 * similarity cleanly. So `normalizedBody` is now the canonical text to embed.
 *
 * LEGACY signature path (kept for back-compat / diagnostics, NO LONGER the
 * embedding path). We derive a function's signature from its parsed `args`
 * (name + type + hasDefault) and `returnType` ONLY -- never the body -- and
 * expose two renderings:
 *
 *   - raw        : a readable signature string keeping identifiers, types,
 *                  and default values verbatim.
 *   - normalized : a structural skeleton where identifiers collapse to NAME,
 *                  argument names to ARG, types to TYPE, any default value to
 *                  DEFAULT, and the return to RET/VOID, with whitespace
 *                  collapsed.
 *
 * These signature renderings are the reason the old representation failed: they
 * abstract away exactly the identifiers/literals that distinguish functions.
 */

import type { ParsedArgument, ParsedFunction } from '../sync/ast-parser.js';

/**
 * The minimal signature shape the normalizer needs. Real parsed functions
 * (`ParsedFunction`) satisfy this, and so do the lightweight synthetic shapes
 * produced by edit/test tooling, so callers can pass either.
 */
export interface SignatureLike {
  name?: string;
  returnType?: string;
  args?: Array<Partial<ParsedArgument> | string>;
}

/** Collapse runs of whitespace to single spaces and trim. */
export function collapseWhitespace(s: string): string {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * The minimal shape {@link normalizedBody} needs: a function's source body
 * text. Real parsed functions (`ParsedFunction`) carry `bodyText`; synthetic
 * shapes can supply it directly.
 */
export interface BodyLike {
  bodyText?: string;
}

/**
 * Canonical "text to embed" for a function: its WHOLE BODY, LIGHTLY normalized.
 *
 * Light normalization (validated path):
 *   - strip line comments (`// ...`) and block comments (`/* ... *\/`)
 *   - collapse runs of whitespace / blank lines to a single space
 *   - trim
 *
 * Crucially we KEEP identifiers and literals -- we do NOT skeletonize or
 * abstract names. That is the whole point of the representation switch: the old
 * signature skeleton threw away exactly the tokens that distinguish functions,
 * collapsing everything to one string. Two byte-identical bodies normalize to
 * the same string; two different bodies normalize differently.
 *
 * Comment stripping is intentionally simple/textual (not a real lexer): it does
 * not try to honor `//` or `/* *\/` sequences that appear inside string or
 * regex literals. For the purpose of feeding a code embedding model this is an
 * acceptable approximation -- the cost is at worst a few extra/fewer tokens,
 * never a correctness issue downstream.
 */
export function normalizedBody(fn: BodyLike): string {
  const raw = fn.bodyText ?? '';
  // Strip block comments first (they can span lines), then line comments.
  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const noComments = noBlock.replace(/\/\/[^\n\r]*/g, ' ');
  return collapseWhitespace(noComments);
}

/**
 * A ParsedArgument carries { name, type, hasDefault, defaultText? }.
 *
 * The parser (ts-morph extractArgsFromNode) sets `hasDefault` directly from the
 * parameter's initializer, so REAL parsed functions surface default params.
 * Synthetic edits (and some legacy shapes) instead encode a default by putting
 * "=" in the arg name (e.g. "id = 5"); we honor that path too. A default is
 * present if the explicit field says so OR the name contains "=".
 */
function splitDefault(arg: Partial<ParsedArgument> | string): {
  name: string;
  hasDefault: boolean;
} {
  const argName = typeof arg === 'string' ? arg : arg?.name ?? '';
  const fieldDefault =
    typeof arg === 'object' && arg !== null ? arg.hasDefault === true : false;
  const eq = String(argName).indexOf('=');
  if (eq === -1) return { name: String(argName).trim(), hasDefault: fieldDefault };
  return { name: String(argName).slice(0, eq).trim(), hasDefault: true };
}

/** A typed arg has a meaningful type annotation (not absent / `unknown`). */
function argType(arg: Partial<ParsedArgument> | string): string | undefined {
  if (typeof arg === 'string') return undefined;
  return arg?.type;
}

/**
 * Render the RAW signature: keeps real names, types, and default markers.
 * Shape: `name(argName: type, argName=…: type): returnType`
 */
export function rawSignature(fn: SignatureLike): string {
  const args = (fn.args ?? []).map((a) => {
    const { name, hasDefault } = splitDefault(a);
    const t = argType(a);
    const type = t && t !== 'unknown' ? `: ${t}` : '';
    return hasDefault ? `${name}=…${type}` : `${name}${type}`;
  });
  const ret = fn.returnType ? `: ${fn.returnType}` : '';
  return collapseWhitespace(`${fn.name ?? 'NAME'}(${args.join(', ')})${ret}`);
}

/**
 * Render the NORMALIZED structural skeleton.
 *
 *   - function name      -> NAME
 *   - each argument name -> ARG
 *   - a default value    -> ARG=DEFAULT
 *   - each arg type      -> TYPE
 *   - return type        -> RET   (VOID if none; sentinel kept stable)
 *
 * Result example: `NAME(ARG: TYPE, ARG=DEFAULT: TYPE): RET`
 */
export function normalizedSignature(fn: SignatureLike): string {
  const args = (fn.args ?? []).map((a) => {
    const { hasDefault } = splitDefault(a);
    const t = argType(a);
    const typePart = t && t !== 'unknown' ? ': TYPE' : '';
    return hasDefault ? `ARG=DEFAULT${typePart}` : `ARG${typePart}`;
  });
  const ret = fn.returnType ? 'RET' : 'VOID';
  return collapseWhitespace(`NAME(${args.join(', ')}): ${ret}`);
}

/** The rendering mode for {@link signatureText}. */
export type SignatureMode = 'raw' | 'normalized';

/**
 * Produce the text we hand to the embedder for a given mode. `normalized` is
 * the default/validated path; `raw` is kept for diagnostics and experiments.
 */
export function signatureText(
  fn: SignatureLike,
  mode: SignatureMode = 'normalized',
): string {
  return mode === 'normalized' ? normalizedSignature(fn) : rawSignature(fn);
}

// `ParsedFunction` is re-exported so callers can spell the strong input type
// without reaching into the sync module directly.
export type { ParsedFunction };
