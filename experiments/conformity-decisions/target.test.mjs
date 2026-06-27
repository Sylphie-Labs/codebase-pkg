/**
 * target.test.mjs -- hermetic, deterministic assertions for the target-pool
 * (prescriptive) layer. No ts-morph, no live src/, no model: every test drives
 * target.mjs with a small in-memory set of fake extracted facts so the logic is
 * pinned independently of whatever the real corpus happens to look like.
 *
 * Run: node --test experiments/conformity-decisions/target.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURATED_AXES,
  seedTarget,
  applyOverrides,
  judgeAgainstTarget,
  migrationProgress,
} from './target.mjs';

// ---------------------------------------------------------------------------
// Fake fact factory: only the curated axes matter; fill file/line/name too.
// ---------------------------------------------------------------------------
let _id = 0;
function fact(over = {}) {
  _id += 1;
  return {
    file: `fake/${_id}.ts`,
    line: _id,
    name: `fn${_id}`,
    var_decl: 'const',
    string_style: 'template-literal',
    async_style: 'sync',
    array_syntax: 'bracket',
    export_style: 'named',
    ...over,
  };
}

function distFrom(facts) {
  const dist = {};
  for (const dim of CURATED_AXES) {
    dist[dim] = {};
    for (const f of facts) {
      const v = String(f[dim]);
      dist[dim][v] = (dist[dim][v] ?? 0) + 1;
    }
  }
  return dist;
}

// ---- seed picks the substantive mode ----------------------------------------
test('seedTarget picks the descriptive mode per axis', () => {
  const facts = [
    fact({ array_syntax: 'bracket' }),
    fact({ array_syntax: 'bracket' }),
    fact({ array_syntax: 'bracket' }),
    fact({ array_syntax: 'generic' }),
    fact({ var_decl: 'const' }),
    fact({ var_decl: 'let' }),
  ];
  const seed = seedTarget(distFrom(facts));
  assert.equal(seed.array_syntax, 'bracket'); // 3 bracket > 1 generic
  assert.equal(seed.var_decl, 'const');       // const dominates
});

test('seedTarget ignores the axis "none"/absence value when picking the mode', () => {
  // 5 functions declare no variables (var_decl: none), 2 use let, 1 uses const.
  // Raw mode would be `none`; the style-guide seed must skip it and pick `let`.
  const facts = [
    fact({ var_decl: 'none' }), fact({ var_decl: 'none' }), fact({ var_decl: 'none' }),
    fact({ var_decl: 'none' }), fact({ var_decl: 'none' }),
    fact({ var_decl: 'let' }), fact({ var_decl: 'let' }),
    fact({ var_decl: 'const' }),
  ];
  const seed = seedTarget(distFrom(facts));
  assert.equal(seed.var_decl, 'let');
});

test('seedTarget yields null for an axis with only absence values', () => {
  const facts = [fact({ async_style: 'sync' }), fact({ async_style: 'sync' })];
  const seed = seedTarget(distFrom(facts));
  assert.equal(seed.async_style, null); // sync is async_style's absence value
});

// ---- overrides change the target AND flip who conforms -----------------------
test('applyOverrides replaces only the named axes', () => {
  const seed = { var_decl: 'const', array_syntax: 'bracket', async_style: null, string_style: 'template-literal', export_style: 'named' };
  const t = applyOverrides(seed, { array_syntax: 'generic' });
  assert.equal(t.array_syntax, 'generic');
  assert.equal(t.var_decl, 'const'); // untouched
  assert.notEqual(t, seed);          // new object, not mutated
  assert.equal(seed.array_syntax, 'bracket');
});

test('an override flips which functions conform (bad-consensus)', () => {
  // 4 bracket, 1 generic. Seed target = bracket -> the 4 bracket fns conform.
  const facts = [
    fact({ array_syntax: 'bracket', name: 'b1' }),
    fact({ array_syntax: 'bracket', name: 'b2' }),
    fact({ array_syntax: 'bracket', name: 'b3' }),
    fact({ array_syntax: 'bracket', name: 'b4' }),
    fact({ array_syntax: 'generic', name: 'g1' }),
  ];
  const dist = distFrom(facts);
  const seed = seedTarget(dist);
  assert.equal(seed.array_syntax, 'bracket');

  const onlyArray = { enforce: ['array_syntax'] };

  // Under seed, the single generic fn is the off-target one.
  const before = judgeAgainstTarget(facts, seed, onlyArray);
  const offBefore = before.filter((v) => v.flags.length > 0).map((v) => v.name);
  assert.deepEqual(offBefore, ['g1']);

  // Flip target to generic. Now the 4 bracket fns are off-target; g1 conforms.
  const flipped = applyOverrides(seed, { array_syntax: 'generic' });
  const after = judgeAgainstTarget(facts, flipped, onlyArray);
  const offAfter = after.filter((v) => v.flags.length > 0).map((v) => v.name).sort();
  assert.deepEqual(offAfter, ['b1', 'b2', 'b3', 'b4']);

  // And the flag is explainable per-decision.
  const b1 = after.find((v) => v.name === 'b1');
  assert.deepEqual(b1.flags, [{ dim: 'array_syntax', value: 'bracket', target: 'generic' }]);
});

test('cold-start: a target value with zero corpus occurrences is expressible and everyone is off-target', () => {
  // No function uses export_style 'default'; target it anyway.
  const facts = [
    fact({ export_style: 'named' }),
    fact({ export_style: 'named' }),
    fact({ export_style: 'named' }),
  ];
  const seed = seedTarget(distFrom(facts));
  const t = applyOverrides(seed, { export_style: 'default' });
  const onlyExport = { enforce: ['export_style'] };
  const prog = migrationProgress(facts, t, onlyExport);
  assert.equal(prog.export_style.atTarget, 0);
  assert.equal(prog.export_style.offTarget, 3);
  assert.equal(prog.export_style.pct, 0);
});

// ---- migration % computes correctly -----------------------------------------
test('migration% computes correctly: 7/10 at target -> 70%', () => {
  const facts = [];
  for (let i = 0; i < 7; i++) facts.push(fact({ var_decl: 'const' }));
  for (let i = 0; i < 3; i++) facts.push(fact({ var_decl: 'let' }));
  const target = { var_decl: 'const' };
  const prog = migrationProgress(facts, target, { enforce: ['var_decl'] });
  assert.equal(prog.var_decl.atTarget, 7);
  assert.equal(prog.var_decl.offTarget, 3);
  assert.equal(prog.var_decl.considered, 10);
  assert.equal(prog.var_decl.pct, 70);
});

test('migration% excludes functions that made no decision on the axis (absence value)', () => {
  // 7 const, 3 let, 5 with no variables at all (none). The 5 should not count.
  const facts = [];
  for (let i = 0; i < 7; i++) facts.push(fact({ var_decl: 'const' }));
  for (let i = 0; i < 3; i++) facts.push(fact({ var_decl: 'let' }));
  for (let i = 0; i < 5; i++) facts.push(fact({ var_decl: 'none' }));
  const prog = migrationProgress(facts, { var_decl: 'const' }, { enforce: ['var_decl'] });
  assert.equal(prog.var_decl.considered, 10); // 5 absence fns excluded
  assert.equal(prog.var_decl.pct, 70);
});

// ---- judge skips absence: a fn with no strings is not faulted ----------------
test('judgeAgainstTarget does not fault a function that made no decision on an axis', () => {
  const facts = [fact({ string_style: 'none' })]; // builds no strings
  const verdicts = judgeAgainstTarget(facts, { string_style: 'template-literal' }, { enforce: ['string_style'] });
  assert.equal(verdicts[0].flags.length, 0);
});

// ---- base-rate guard suppresses tiny-population flags ------------------------
// The guard lives in the runner (which axes get enforced), so we model it here
// exactly as target-run.mjs does: an axis is enforced only when its substantive
// population >= MIN_SUBSTANTIVE (or it carries an explicit override).
test('base-rate guard suppresses flags on a tiny-population axis', () => {
  const MIN = 10;
  // async_style: only 2 functions actually do async work (rest are sync =
  // absence). 1 uses async-await, 1 uses promise-then. A naive seed would pick
  // a "majority" of 1, but the guard refuses to enforce it.
  const facts = [];
  for (let i = 0; i < 30; i++) facts.push(fact({ async_style: 'sync' }));
  facts.push(fact({ async_style: 'async-await', name: 'aw' }));
  facts.push(fact({ async_style: 'promise-then', name: 'pt' }));

  const dist = distFrom(facts);
  const seed = seedTarget(dist);
  // Substantive (non-sync) population = 2.
  const substantive = (dist.async_style['async-await'] ?? 0) + (dist.async_style['promise-then'] ?? 0);
  assert.equal(substantive, 2);

  const enforce = CURATED_AXES.filter((d) => {
    const none = { var_decl: 'none', string_style: 'none', async_style: 'sync', array_syntax: 'none', export_style: 'none' }[d];
    let n = 0;
    for (const [v, c] of Object.entries(dist[d])) if (v !== none) n += c;
    return n >= MIN;
  });
  assert.equal(enforce.includes('async_style'), false); // guarded out

  // With async_style guarded out, the promise-then fn is NOT flagged.
  const verdicts = judgeAgainstTarget(facts, seed, { enforce });
  const pt = verdicts.find((v) => v.name === 'pt');
  assert.equal(pt.flags.length, 0);
});

test('base-rate guard does NOT suppress an axis with enough substantive examples', () => {
  const MIN = 10;
  const facts = [];
  for (let i = 0; i < 12; i++) facts.push(fact({ array_syntax: 'bracket' }));
  for (let i = 0; i < 4; i++) facts.push(fact({ array_syntax: 'generic' }));
  const dist = distFrom(facts);
  let n = 0;
  for (const [v, c] of Object.entries(dist.array_syntax)) if (v !== 'none') n += c;
  assert.equal(n >= MIN, true); // 16 substantive -> enforced
});
