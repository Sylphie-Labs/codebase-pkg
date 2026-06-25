/**
 * normalize.ts -- signature derivation + structural canonicalization.
 *
 * Category under test: `function:signature-skeleton`.
 *
 * We derive a function's signature from its parsed `args` (name + type +
 * hasDefault) and `returnType` ONLY -- never the body. We then expose TWO
 * renderings:
 *
 *   - raw        : a readable signature string keeping identifiers, types,
 *                  and default values verbatim.
 *   - normalized : a structural skeleton where identifiers collapse to NAME,
 *                  argument names to ARG, types to TYPE, any default value to
 *                  DEFAULT, and the return to RET/VOID, with whitespace
 *                  collapsed.
 *
 * Two functions that are structurally identical (same arity, same default
 * positions, same "has a return type or not") produce the SAME normalized
 * skeleton regardless of identifier or concrete type spelling. Cosmetic edits
 * (rename a param, reformat) therefore map to an identical skeleton -- the crux
 * property the Conformity Judge relies on.
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
