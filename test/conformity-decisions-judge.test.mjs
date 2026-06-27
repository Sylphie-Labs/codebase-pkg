/**
 * Tests for the decision-conformity JUDGE surface
 * (dist/conformity/decisions/judge-decisions.js) -- PASS 2a.
 *
 * PURE logic only: NO live Postgres, NO model. An injected fake DecisionStore
 * returns canned axis distributions, and the function facts come from a real
 * ts-morph fixture written to a temp dir (so the extractor + pure target logic
 * are exercised end-to-end). We assert:
 *   - a function using a MINORITY value is flagged off-target with the
 *     explainable "uses X; target is Y" message,
 *   - a CONFORMING function is clean (no flags),
 *   - the base-rate guard skips an axis with too few examples,
 *   - absence values (no decision made) are never faulted,
 *   - the unavailable gate returns a STRUCTURED result (no throw).
 *
 * Run after `npm run build`:
 *   node --test test/conformity-decisions-judge.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  judgeFileDecisions,
  judgeWorkingTreeDecisions,
  isDecisionUnavailable,
} from '../dist/conformity/index.js';

// --------------------------------------------------------------------------
// Fakes
// --------------------------------------------------------------------------

/**
 * A fake DecisionStore: returns the canned `axisDistributions` (axis -> {value:
 * count}) as Maps from loadAllDistributions, exactly like the real store.
 */
function makeFakeStore(axisDistributions) {
  return {
    async loadAllDistributions(axes) {
      const out = {};
      for (const axis of new Set(axes)) {
        const counts = axisDistributions[axis] ?? {};
        out[axis] = new Map(Object.entries(counts));
      }
      return out;
    },
  };
}

/** A runner whose SELECT 1 succeeds (gate "available"). */
const okRunner = { async query() { return { rows: [{ '?column?': 1 }] }; } };
/** A runner whose probe throws (gate "Postgres unreachable"). */
const downRunner = { async query() { throw new Error('ECONNREFUSED'); } };

// --------------------------------------------------------------------------
// Fixture: one strongly off-target fn, one conforming fn, plus absence cases.
// --------------------------------------------------------------------------

const FIXTURE = `
// Off-target on var_decl (let vs target const) and array_syntax (generic vs bracket).
export function offTarget(xs: Array<number>): number {
  let total = 0;
  return total;
}

// Conforms: const + bracket array.
export function conformer(xs: number[]): number {
  const total = 0;
  return total;
}

// Makes NO var_decl / array_syntax decision (absence) -> never faulted on them.
export function absentDecisions(): void {
  return;
}
`;

let tmpDir;
let file;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-judge-dec-'));
  file = path.join(tmpDir, 'fixture.ts');
  fs.writeFileSync(file, FIXTURE, 'utf8');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fnByName(result, name) {
  const f = result.functions.find((x) => x.name === name);
  assert.ok(f, `expected a function result for ${name}`);
  return f;
}

function flagFor(fn, axis) {
  return fn.flags.find((f) => f.axis === axis);
}

// Distributions where const + bracket are the clear majority (>= MIN_SUBSTANTIVE
// = 10 deciders each), so both var_decl and array_syntax are ENFORCED and the
// seed target is const / bracket.
const ENFORCED_DIST = {
  var_decl: { const: 30, let: 5, none: 3 },
  array_syntax: { bracket: 25, generic: 4, none: 50 },
  string_style: { none: 40 }, // no substantive examples -> guard skips it
  async_style: { sync: 40 }, // sync is the absence value -> guard skips it
  export_style: { named: 40 },
};

// --------------------------------------------------------------------------
// Off-target / conforming / absence
// --------------------------------------------------------------------------

test('minority-value function is flagged off-target with explainable message', async () => {
  const result = await judgeFileDecisions(file, {
    store: makeFakeStore(ENFORCED_DIST),
    runner: okRunner,
    cwd: tmpDir, // no conformity-target.json here -> seed-only target
  });
  assert.ok(!isDecisionUnavailable(result));

  const off = fnByName(result, 'offTarget');
  const varFlag = flagFor(off, 'var_decl');
  assert.ok(varFlag, 'expected a var_decl off-target flag');
  assert.equal(varFlag.value, 'let');
  assert.equal(varFlag.target, 'const');

  const arrFlag = flagFor(off, 'array_syntax');
  assert.ok(arrFlag, 'expected an array_syntax off-target flag');
  assert.equal(arrFlag.value, 'generic');
  assert.equal(arrFlag.target, 'bracket');
});

test('conforming function has zero flags', async () => {
  const result = await judgeFileDecisions(file, {
    store: makeFakeStore(ENFORCED_DIST),
    runner: okRunner,
    cwd: tmpDir,
  });
  assert.ok(!isDecisionUnavailable(result));
  const conformer = fnByName(result, 'conformer');
  assert.deepEqual(conformer.flags, []);
});

test('absence (no decision made) is never faulted', async () => {
  const result = await judgeFileDecisions(file, {
    store: makeFakeStore(ENFORCED_DIST),
    runner: okRunner,
    cwd: tmpDir,
  });
  assert.ok(!isDecisionUnavailable(result));
  const absent = fnByName(result, 'absentDecisions');
  // No var_decl / array_syntax decision made -> not flagged on those axes.
  assert.equal(flagFor(absent, 'var_decl'), undefined);
  assert.equal(flagFor(absent, 'array_syntax'), undefined);
});

test('result summary counts conformers vs off-target and is sorted divergent-first', async () => {
  const result = await judgeFileDecisions(file, {
    store: makeFakeStore(ENFORCED_DIST),
    runner: okRunner,
    cwd: tmpDir,
  });
  assert.ok(!isDecisionUnavailable(result));
  assert.equal(result.totalFunctions, 3);
  assert.equal(result.offTargetFunctions, 1);
  assert.equal(result.conformingFunctions, 2);
  // offTarget has 2 flags; it must sort first.
  assert.equal(result.functions[0].name, 'offTarget');
  assert.equal(result.functions[0].flags.length, 2);
  assert.equal(result.totalFlags, 2);
  // No overrides file present -> seed-only target.
  assert.equal(result.hasOverrides, false);
});

// --------------------------------------------------------------------------
// Base-rate guard
// --------------------------------------------------------------------------

test('base-rate guard: an axis with too few examples is NOT enforced (no flags)', async () => {
  // var_decl now has only 3 substantive deciders (< MIN_SUBSTANTIVE = 10), so it
  // is dropped from the enforced set and offTarget's `let` is no longer faulted.
  const thinDist = {
    var_decl: { const: 2, let: 1, none: 3 },
    array_syntax: { bracket: 25, generic: 4, none: 50 }, // still enforced
  };
  const result = await judgeFileDecisions(file, {
    store: makeFakeStore(thinDist),
    runner: okRunner,
    cwd: tmpDir,
  });
  assert.ok(!isDecisionUnavailable(result));

  assert.ok(!result.enforcedAxes.includes('var_decl'));
  assert.ok(result.enforcedAxes.includes('array_syntax'));

  const off = fnByName(result, 'offTarget');
  assert.equal(flagFor(off, 'var_decl'), undefined, 'var_decl must not be enforced');
  // array_syntax is still enforced -> still flagged.
  assert.ok(flagFor(off, 'array_syntax'), 'array_syntax should still be flagged');
});

test('override forces enforcement of an otherwise-guarded axis', async () => {
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-judge-ov-'));
  fs.writeFileSync(
    path.join(overrideDir, 'conformity-target.json'),
    JSON.stringify({ var_decl: 'const' }),
    'utf8',
  );
  try {
    const thinDist = { var_decl: { const: 2, let: 1, none: 3 } };
    const result = await judgeFileDecisions(file, {
      store: makeFakeStore(thinDist),
      runner: okRunner,
      cwd: overrideDir,
    });
    assert.ok(!isDecisionUnavailable(result));
    assert.ok(result.enforcedAxes.includes('var_decl'), 'override forces enforcement');
    assert.equal(result.hasOverrides, true);
    const off = fnByName(result, 'offTarget');
    const f = flagFor(off, 'var_decl');
    assert.ok(f);
    assert.equal(f.target, 'const');
  } finally {
    fs.rmSync(overrideDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Unavailable gate (structured, no throw)
// --------------------------------------------------------------------------

test('judgeFileDecisions returns structured unavailable when Postgres is down', async () => {
  const result = await judgeFileDecisions(file, {
    store: makeFakeStore(ENFORCED_DIST),
    runner: downRunner,
    cwd: tmpDir,
  });
  assert.ok(isDecisionUnavailable(result));
  assert.match(result.reason, /Postgres/);
});

test('judgeWorkingTreeDecisions returns structured unavailable when Postgres is down', async () => {
  const result = await judgeWorkingTreeDecisions({ runner: downRunner });
  assert.ok(isDecisionUnavailable(result));
  assert.match(result.reason, /Postgres/);
});

test('CODEBASE_PKG_CONFORMITY=off disables the judge (structured, no throw)', async () => {
  const prev = process.env.CODEBASE_PKG_CONFORMITY;
  process.env.CODEBASE_PKG_CONFORMITY = 'off';
  try {
    const result = await judgeFileDecisions(file, {
      store: makeFakeStore(ENFORCED_DIST),
      runner: okRunner, // gate short-circuits on the env var before probing
      cwd: tmpDir,
    });
    assert.ok(isDecisionUnavailable(result));
    assert.match(result.reason, /disabled/);
  } finally {
    if (prev === undefined) delete process.env.CODEBASE_PKG_CONFORMITY;
    else process.env.CODEBASE_PKG_CONFORMITY = prev;
  }
});
