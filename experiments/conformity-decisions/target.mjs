/**
 * target.mjs -- pure target-pool logic for the prescriptive conformity layer.
 *
 * No ts-morph, no fs, no model. Operates on plain facts records (the objects
 * produced by the extractor) and on per-dimension distributions
 * (value -> count). Kept dependency-free so target.test.mjs can drive it with a
 * small in-memory set of fake facts and stay hermetic.
 *
 * "Target pool" = a preferred value per decision axis ({ dimension: value })
 * that conformity is judged against -- as opposed to "any minority is an
 * outlier" (descriptive). The target may match the current majority, flip to a
 * minority (accepted preference / bad-consensus fix), or name a value with zero
 * examples (cold start).
 */

// Curated, substitutable axes only. EXCLUDES needs-driven axes (loop_style,
// error_handling, param_count -- the choice is dictated by the task, not style)
// and uniform/no-signal axes (fn_style, return_type). See corpus-report.json.
export const CURATED_AXES = [
  'var_decl',
  'string_style',
  'async_style',
  'array_syntax',
  'export_style',
];

// Per axis, the value that means "this decision was not made here" (absence of
// the construct). A style guide targets a real choice, never the absence, so
// the seed skips this value when picking the mode, and migration progress
// excludes functions sitting on it (they made no decision to migrate).
export const AXIS_NONE_VALUE = {
  var_decl: 'none',       // function declares no local variables
  string_style: 'none',   // function builds no strings
  async_style: 'sync',    // function does no async work
  array_syntax: 'none',   // function has no array-typed annotations
  export_style: 'none',   // symbol is not exported
};

/**
 * Seed a target = the descriptive MODE per axis, computed over SUBSTANTIVE
 * values only (the axis's AXIS_NONE_VALUE is excluded). Ties broken by the
 * value that sorts first, so the seed is deterministic. If an axis has no
 * substantive values at all, its seed is null (nothing to prefer yet).
 *
 * @param {Record<string, Record<string, number>>} dist
 * @returns {Record<string, string|null>}
 */
export function seedTarget(dist) {
  const target = {};
  for (const dim of CURATED_AXES) {
    const counts = dist[dim] ?? {};
    const none = AXIS_NONE_VALUE[dim];
    let best = null;
    let bestC = -1;
    for (const v of Object.keys(counts).sort()) {
      if (v === none) continue;
      const c = counts[v];
      if (c > bestC) { bestC = c; best = v; }
    }
    target[dim] = best;
  }
  return target;
}

/**
 * Return a new target with `overrides` replacing the seeded value on the named
 * axes. Overrides represent human-accepted preferences and may set any value,
 * including a current minority or a value absent from the corpus.
 */
export function applyOverrides(seeded, overrides) {
  const out = { ...seeded };
  for (const [dim, value] of Object.entries(overrides ?? {})) {
    out[dim] = value;
  }
  return out;
}

/**
 * Judge each fact record against the target, per decision axis.
 *
 * An axis is judged only if (a) it's in `enforce` (defaults to all curated
 * axes), (b) the target has a non-null value for it, and (c) the function
 * actually made a decision on that axis (its value is not AXIS_NONE_VALUE) --
 * we don't fault a function that declares no variables for "not using const".
 *
 * @returns array of { file, line, name, flags: [{ dim, value, target }] }
 */
export function judgeAgainstTarget(facts, target, opts = {}) {
  const enforce = opts.enforce ?? CURATED_AXES;
  const enforceSet = new Set(enforce);
  const out = [];
  for (const f of facts) {
    const flags = [];
    for (const dim of CURATED_AXES) {
      if (!enforceSet.has(dim)) continue;
      const t = target[dim];
      if (t == null) continue;
      const v = String(f[dim]);
      if (v === AXIS_NONE_VALUE[dim]) continue; // no decision made on this axis
      if (v !== t) flags.push({ dim, value: v, target: t });
    }
    out.push({ file: f.file, line: f.line, name: f.name, flags });
  }
  return out;
}

/**
 * Per-axis migration progress = of the functions that MADE a decision on the
 * axis (excluding AXIS_NONE_VALUE), what fraction already equals the target.
 *
 *   atTarget   -- decided fns whose value == target
 *   offTarget  -- decided fns whose value != target (the migration backlog)
 *   considered -- atTarget + offTarget (fns that made a decision on the axis)
 *   pct        -- 100 * atTarget / considered (0 if considered == 0)
 *
 * @returns Record<dim, { atTarget, offTarget, considered, pct, target }>
 */
export function migrationProgress(facts, target, opts = {}) {
  const enforce = opts.enforce ?? CURATED_AXES;
  const enforceSet = new Set(enforce);
  const out = {};
  for (const dim of CURATED_AXES) {
    if (!enforceSet.has(dim)) continue;
    const t = target[dim];
    if (t == null) continue;
    const none = AXIS_NONE_VALUE[dim];
    let atTarget = 0;
    let offTarget = 0;
    for (const f of facts) {
      const v = String(f[dim]);
      if (v === none) continue;
      if (v === t) atTarget += 1;
      else offTarget += 1;
    }
    const considered = atTarget + offTarget;
    out[dim] = {
      target: t,
      atTarget,
      offTarget,
      considered,
      pct: considered === 0 ? 0 : (100 * atTarget) / considered,
    };
  }
  return out;
}
