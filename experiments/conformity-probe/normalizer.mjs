/**
 * normalizer.mjs -- signature derivation + structural canonicalization.
 *
 * Category under test: `function:signature-skeleton`.
 *
 * We derive a function's signature from its parsed `args` (name + type) and
 * `returnType` ONLY -- never the body. We then expose TWO renderings:
 *
 *   - raw        : a readable signature string keeping identifiers, types,
 *                  and default values verbatim.
 *   - normalized : a structural skeleton where identifiers collapse to NAME,
 *                  argument names to ARG, types to RET/TYPE, and any default
 *                  values to DEFAULT, with whitespace collapsed.
 *
 * "How much normalization is needed before embedding distance behaves" is
 * exactly the variable this probe measures, so both renderings are first-class.
 */

/** Collapse runs of whitespace to single spaces and trim. */
export function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * A ParsedArgument now carries { name, type, hasDefault?, defaultText? }.
 *
 * The parser (ts-morph extractArgsFromNode) sets `hasDefault` directly from the
 * parameter's initializer, so REAL parsed functions surface default params.
 * Synthetic edits (and some legacy shapes) instead encode a default by putting
 * "=" in the arg name (e.g. "id = 5"); we honor that path too. A default is
 * present if the explicit field says so OR the name contains "=".
 */
function splitDefault(arg) {
  const argName = typeof arg === 'string' ? arg : (arg?.name ?? '');
  const fieldDefault = typeof arg === 'object' && arg !== null ? arg.hasDefault === true : false;
  const eq = String(argName).indexOf('=');
  if (eq === -1) return { name: String(argName).trim(), hasDefault: fieldDefault };
  return { name: String(argName).slice(0, eq).trim(), hasDefault: true };
}

/**
 * Render the RAW signature: keeps real names, types, and default markers.
 * Shape: `name(argName: type, argName=...: type): returnType`
 */
export function rawSignature(fn) {
  const args = (fn.args ?? []).map((a) => {
    const { name, hasDefault } = splitDefault(a);
    const type = a.type && a.type !== 'unknown' ? `: ${a.type}` : '';
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
 *   - each arg type       -> TYPE
 *   - return type        -> RET   (VOID if none, sentinel kept stable)
 *
 * Result example: `NAME(ARG: TYPE, ARG=DEFAULT: TYPE): RET`
 *
 * The point: two functions that are structurally identical (same arity,
 * same default positions, same "has a return type or not") produce the SAME
 * skeleton regardless of identifier or concrete type spelling. Cosmetic edits
 * (rename a param, reformat) must therefore map to an identical skeleton.
 */
export function normalizedSignature(fn) {
  const args = (fn.args ?? []).map((a) => {
    const { hasDefault } = splitDefault(a);
    const hasType = a.type && a.type !== 'unknown';
    const typePart = hasType ? ': TYPE' : '';
    return hasDefault ? `ARG=DEFAULT${typePart}` : `ARG${typePart}`;
  });
  const ret = fn.returnType ? 'RET' : 'VOID';
  return collapseWhitespace(`NAME(${args.join(', ')}): ${ret}`);
}

/**
 * Produce the text we hand to the embedder for a given mode.
 * mode is 'raw' or 'normalized'.
 */
export function signatureText(fn, mode) {
  return mode === 'normalized' ? normalizedSignature(fn) : rawSignature(fn);
}
