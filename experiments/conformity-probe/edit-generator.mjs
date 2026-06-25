/**
 * edit-generator.mjs -- synthesize a monotonicity ladder of graded edits.
 *
 * Each edit operates on the PARSED signature shape (args + returnType), since
 * the category under test is `function:signature-skeleton`. We produce three
 * tiers of increasing structural divergence:
 *
 *   cosmetic         -- rename param identifiers / reformat. NO structural
 *                       change: same arity, same types, same return. After
 *                       normalization this MUST be a no-op (delta ~= 0).
 *   small-structural -- add one default parameter. A real, minimal structural
 *                       change.
 *   divergent        -- introduce a construct nothing else in the pool uses:
 *                       a rest/spread variadic param + a union/exotic return.
 *
 * The ladder is the whole experiment: distance should grow monotonically
 * cosmetic < small-structural < divergent.
 */

/** Deep-ish clone of the fields we manipulate. */
function cloneFn(fn) {
  return {
    ...fn,
    args: (fn.args ?? []).map((a) => ({ ...a })),
  };
}

const COSMETIC_NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];

/**
 * cosmetic: rename every parameter to a neutral identifier and reformat.
 * Types, arity, defaults, and return type are untouched -> identical skeleton.
 */
export function cosmeticEdit(fn) {
  const c = cloneFn(fn);
  c.args = c.args.map((a, i) => {
    const hasDefault = String(a.name).includes('=');
    const base = COSMETIC_NAMES[i % COSMETIC_NAMES.length] + (i >= COSMETIC_NAMES.length ? String(i) : '');
    return { ...a, name: hasDefault ? `${base} = 0` : base };
  });
  c.name = `${fn.name}_renamed`;
  return c;
}

/**
 * small-structural: add exactly one optional/default parameter.
 * Arity changes by one and a DEFAULT marker appears -- a minimal real edit.
 */
export function smallStructuralEdit(fn) {
  const c = cloneFn(fn);
  c.args = [...c.args, { name: 'opts = {}', type: 'Record<string, unknown>' }];
  return c;
}

/**
 * divergent: introduce a structural shape unlike anything in a typical pool.
 *
 * NOTE (design): the category `function:signature-skeleton` encodes ARITY and
 * the presence/absence of types/defaults/return -- it deliberately ERASES
 * concrete type spelling. So to diverge along the axis the category actually
 * measures, divergence must be ARITY-driven, not type-driven. A large mixed
 * parameter list (many slots, several defaults) is a skeleton nothing in the
 * pool matches, whereas an exotic return TYPE would normalize away to nothing.
 */
export function divergentEdit(fn) {
  const c = cloneFn(fn);
  c.args = [
    { name: 'a', type: 'string' },
    { name: 'b', type: 'number' },
    { name: 'c', type: 'boolean' },
    { name: 'd', type: 'unknown' },
    { name: 'e', type: 'symbol' },
    { name: 'f = 0', type: 'number' },
    { name: 'g = {}', type: 'Record<string, unknown>' },
    { name: '...rest', type: 'Array<Map<string, unknown>>' },
  ];
  c.returnType = 'AsyncGenerator<Uint8Array, void, unknown> | never';
  return c;
}

/** The ordered ladder, lowest-divergence first. */
export const EDIT_TIERS = [
  { tier: 'cosmetic', apply: cosmeticEdit },
  { tier: 'small-structural', apply: smallStructuralEdit },
  { tier: 'divergent', apply: divergentEdit },
];
