/**
 * Tests for the decision-conformity TARGET-pool (prescriptive) layer
 * (dist/conformity/decisions/target.js).
 *
 * Hermetic + deterministic: NO ts-morph, NO live src/, NO model. Every test
 * drives the pure target logic with a small in-memory set of fake decision
 * facts so the logic is pinned independently of the real corpus. Ported from
 * experiments/conformity-decisions/target.test.mjs.
 *
 * Run after `npm run build`:
 *   node --test test/conformity-decisions-target.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CURATED_AXES,
  AXIS_NONE_VALUE,
  seedTarget,
  applyOverrides,
  judgeAgainstTarget,
  migrationProgress,
  enforcedAxes,
} from '../dist/conformity/index.js';

// ---------------------------------------------------------------------------
// Fake fact factory: only the curated axes matter; fill name/file/line too.
// ---------------------------------------------------------------------------
let _id = 0;
function fact(over = {}) {
  _id += 1;
  return {
    filePath: `fake/${_id}.ts`,
    lineNumber: _id,
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
  for (const axis of CURATED_AXES) {
    dist[axis] = {};
    for (const f of facts) {
      const v = String(f[axis]);
      dist[axis][v] = (dist[axis][v] ?? 0) + 1;
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
  assert.equal(seed.var_decl, 'const');
});

test('seedTarget ignores the axis absence value when picking the mode', () => {
  // 5 fns declare no variables (none), 2 use let, 1 uses const. Raw mode would
  // be `none`; the style-guide seed must skip it and pick `let`.
  const facts = [
    fact({ var_decl: 'none' }), fact({ var_decl: 'none' }), fact({ var_decl: 'none' }),
    fact({ var_decl: 'none' }), fact({ var_decl: 'none' }),
    fact({ var_decl: 'let' }), fact({ var_decl: 'let' }),
    fact({ var_decl: 'const' }),
  ];
  assert.equal(seedTarget(distFrom(facts)).var_decl, 'let');
});

test('seedTarget yields null for an axis with only absence values', () => {
  const facts = [fact({ async_style: 'sync' }), fact({ async_style: 'sync' })];
  assert.equal(seedTarget(distFrom(facts)).async_style, null);
});

// ---- overrides change the target AND flip who conforms -----------------------
test('applyOverrides replaces only the named axes and does not mutate the seed', () => {
  const seed = {
    var_decl: 'const', array_syntax: 'bracket', async_style: null,
    string_style: 'template-literal', export_style: 'named',
  };
  const t = applyOverrides(seed, { array_syntax: 'generic' });
  assert.equal(t.array_syntax, 'generic');
  assert.equal(t.var_decl, 'const');
  assert.notEqual(t, seed);
  assert.equal(seed.array_syntax, 'bracket');
});

test('an override flips which functions conform (bad-consensus), explainably', () => {
  const facts = [
    fact({ array_syntax: 'bracket', name: 'b1' }),
    fact({ array_syntax: 'bracket', name: 'b2' }),
    fact({ array_syntax: 'bracket', name: 'b3' }),
    fact({ array_syntax: 'bracket', name: 'b4' }),
    fact({ array_syntax: 'generic', name: 'g1' }),
  ];
  const seed = seedTarget(distFrom(facts));
  assert.equal(seed.array_syntax, 'bracket');

  const onlyArray = { enforce: ['array_syntax'] };

  const before = judgeAgainstTarget(facts, seed, onlyArray);
  assert.deepEqual(
    before.filter((v) => v.flags.length > 0).map((v) => v.name),
    ['g1'],
  );

  const flipped = applyOverrides(seed, { array_syntax: 'generic' });
  const after = judgeAgainstTarget(facts, flipped, onlyArray);
  assert.deepEqual(
    after.filter((v) => v.flags.length > 0).map((v) => v.name).sort(),
    ['b1', 'b2', 'b3', 'b4'],
  );

  const b1 = after.find((v) => v.name === 'b1');
  assert.deepEqual(b1.flags, [{ axis: 'array_syntax', value: 'bracket', target: 'generic' }]);
});

test('cold-start: a target value with zero corpus occurrences is expressible', () => {
  const facts = [
    fact({ export_style: 'named' }),
    fact({ export_style: 'named' }),
    fact({ export_style: 'named' }),
  ];
  const t = applyOverrides(seedTarget(distFrom(facts)), { export_style: 'default' });
  const prog = migrationProgress(facts, t, { enforce: ['export_style'] });
  assert.equal(prog.export_style.atTarget, 0);
  assert.equal(prog.export_style.offTarget, 3);
  assert.equal(prog.export_style.pct, 0);
});

// ---- migration % computes correctly -----------------------------------------
test('migration% computes correctly: 7/10 at target -> 70%', () => {
  const facts = [];
  for (let i = 0; i < 7; i++) facts.push(fact({ var_decl: 'const' }));
  for (let i = 0; i < 3; i++) facts.push(fact({ var_decl: 'let' }));
  const prog = migrationProgress(facts, { var_decl: 'const' }, { enforce: ['var_decl'] });
  assert.equal(prog.var_decl.atTarget, 7);
  assert.equal(prog.var_decl.offTarget, 3);
  assert.equal(prog.var_decl.considered, 10);
  assert.equal(prog.var_decl.pct, 70);
});

test('migration% excludes functions that made no decision on the axis (absence)', () => {
  const facts = [];
  for (let i = 0; i < 7; i++) facts.push(fact({ var_decl: 'const' }));
  for (let i = 0; i < 3; i++) facts.push(fact({ var_decl: 'let' }));
  for (let i = 0; i < 5; i++) facts.push(fact({ var_decl: 'none' }));
  const prog = migrationProgress(facts, { var_decl: 'const' }, { enforce: ['var_decl'] });
  assert.equal(prog.var_decl.considered, 10); // 5 absence fns excluded
  assert.equal(prog.var_decl.pct, 70);
});

// ---- judge skips absence -----------------------------------------------------
test('judgeAgainstTarget does not fault a function that made no decision on an axis', () => {
  const facts = [fact({ string_style: 'none' })];
  const verdicts = judgeAgainstTarget(facts, { string_style: 'template-literal' }, {
    enforce: ['string_style'],
  });
  assert.equal(verdicts[0].flags.length, 0);
});

// ---- base-rate guard ---------------------------------------------------------
test('base-rate guard suppresses flags on a tiny-population axis', () => {
  // async_style: only 2 fns do async work (rest sync = absence). enforcedAxes
  // must refuse to enforce it (substantive 2 < MIN 10, no override).
  const facts = [];
  for (let i = 0; i < 30; i++) facts.push(fact({ async_style: 'sync' }));
  facts.push(fact({ async_style: 'async-await', name: 'aw' }));
  facts.push(fact({ async_style: 'promise-then', name: 'pt' }));

  const dist = distFrom(facts);
  const seed = seedTarget(dist);
  const substantive =
    (dist.async_style['async-await'] ?? 0) + (dist.async_style['promise-then'] ?? 0);
  assert.equal(substantive, 2);
  assert.equal(AXIS_NONE_VALUE.async_style, 'sync');

  const enforce = enforcedAxes(dist, {});
  assert.equal(enforce.includes('async_style'), false);

  const verdicts = judgeAgainstTarget(facts, seed, { enforce });
  const pt = verdicts.find((v) => v.name === 'pt');
  assert.equal(pt.flags.length, 0);
});

test('base-rate guard does NOT suppress an axis with enough substantive examples', () => {
  const facts = [];
  for (let i = 0; i < 12; i++) facts.push(fact({ array_syntax: 'bracket' }));
  for (let i = 0; i < 4; i++) facts.push(fact({ array_syntax: 'generic' }));
  const enforce = enforcedAxes(distFrom(facts), {});
  assert.equal(enforce.includes('array_syntax'), true); // 16 substantive
});

test('an explicit override forces enforcement past the base-rate guard', () => {
  // async_style has only 2 substantive fns, but a human override on it should
  // make it enforced anyway (deliberate preference beats the guard).
  const facts = [];
  for (let i = 0; i < 30; i++) facts.push(fact({ async_style: 'sync' }));
  facts.push(fact({ async_style: 'async-await' }));
  facts.push(fact({ async_style: 'promise-then' }));
  const enforce = enforcedAxes(distFrom(facts), { async_style: 'async-await' });
  assert.equal(enforce.includes('async_style'), true);
});
