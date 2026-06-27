/**
 * Tests for the `conformity-target` command surface
 * (dist/conformity/decisions/target-cli.js) -- PASS 2b.
 *
 * PURE logic only: NO live Postgres, NO model, NO re-parse. A fake DecisionStore
 * returns canned axis distributions (value -> count) as Maps, and a temp cwd
 * stands in for the repo root. We assert:
 *   - SHOW mode computes the right migration numbers FROM THE STORE
 *     (migrationFromStore: atTarget = target count, considered = substantive
 *     sum), with no re-parse/re-embed,
 *   - `--init` writes a conformity-target.json seeded from the descriptive modes
 *     for the enforced axes,
 *   - `--init` does NOT overwrite an existing file without `--force`, and DOES
 *     with `--force`,
 *   - the unavailable gate (Postgres down / disabled) returns + prints without
 *     throwing and writes no file.
 *
 * Run after `npm run build`:
 *   node --test test/conformity-decisions-target-cli.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  runConformityTarget,
  migrationFromStore,
  seedTarget,
  effectiveTarget,
  enforcedAxes,
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

/** Capture console.log output during fn(). */
async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-target-cli-'));
}

// const is the clear majority (>= 10 deciders) -> enforced, seed = const.
// array_syntax bracket majority -> enforced, seed = bracket.
// string_style has no substantive examples (only its absence value) -> guarded.
const ENFORCED_DIST = {
  var_decl: { const: 30, let: 10, none: 3 },     // substantive = 40, atTarget(const)=30
  array_syntax: { bracket: 25, generic: 5, none: 50 }, // substantive = 30, atTarget(bracket)=25
  string_style: { none: 40 },                    // no substantive -> guard skips
  async_style: { sync: 40 },                     // sync is the absence value -> guard skips
  export_style: { named: 20 },                   // substantive = 20, atTarget(named)=20
};

// --------------------------------------------------------------------------
// migrationFromStore: the store-based migration computation
// --------------------------------------------------------------------------

test('migrationFromStore computes atTarget/considered/offTarget/pct from distributions', () => {
  const dist = {
    var_decl: { const: 30, let: 10, none: 3 },
    array_syntax: { bracket: 25, generic: 5, none: 50 },
  };
  const target = effectiveTarget(dist, undefined);
  const enforce = enforcedAxes(dist, undefined);
  const progress = migrationFromStore(dist, target, { enforce });

  // var_decl: substantive = 40 (const 30 + let 10, none excluded), atTarget = 30.
  assert.equal(progress.var_decl.target, 'const');
  assert.equal(progress.var_decl.atTarget, 30);
  assert.equal(progress.var_decl.considered, 40);
  assert.equal(progress.var_decl.offTarget, 10);
  assert.equal(progress.var_decl.pct.toFixed(1), '75.0');

  // array_syntax: substantive = 30 (bracket 25 + generic 5, none excluded), atTarget = 25.
  assert.equal(progress.array_syntax.target, 'bracket');
  assert.equal(progress.array_syntax.atTarget, 25);
  assert.equal(progress.array_syntax.considered, 30);
  assert.equal(progress.array_syntax.offTarget, 5);
  assert.equal(progress.array_syntax.pct.toFixed(2), '83.33');
});

test('migrationFromStore skips non-enforced axes', () => {
  const dist = { string_style: { none: 40 } };
  const target = effectiveTarget(dist, undefined);
  const enforce = enforcedAxes(dist, undefined); // string_style not enforced
  const progress = migrationFromStore(dist, target, { enforce });
  assert.equal(progress.string_style, undefined);
});

// --------------------------------------------------------------------------
// SHOW mode
// --------------------------------------------------------------------------

test('show mode reports per-axis target, source, enforcement, and store-based migration', async () => {
  const cwd = mkTmp();
  try {
    const out = await captureLog(() =>
      runConformityTarget({
        store: makeFakeStore(ENFORCED_DIST),
        runner: okRunner,
        cwd,
        closePool: false,
      }),
    );
    // Effective target lines.
    assert.match(out, /var_decl\s+->\s+const/);
    assert.match(out, /array_syntax\s+->\s+bracket/);
    // Seed source (no overrides present).
    assert.match(out, /\[seed\]/);
    // Base-rate guard called out for the thin axes.
    assert.match(out, /string_style[\s\S]*NOT enforced/);
    // Migration numbers from the store (75% for var_decl, 30 off-target? no: 10).
    assert.match(out, /var_decl\s+75\.0% at target \(30\/40\)\s+to migrate: 10/);
    assert.match(out, /array_syntax\s+83\.3% at target \(25\/30\)\s+to migrate: 5/);
    // Read-only promise.
    assert.match(out, /read-only/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('show mode marks an override axis as [override] and reflects hasOverrides messaging', async () => {
  const cwd = mkTmp();
  try {
    // Override array_syntax to generic (a minority); var_decl left to seed.
    fs.writeFileSync(
      path.join(cwd, 'conformity-target.json'),
      JSON.stringify({ array_syntax: 'generic' }),
      'utf8',
    );
    const out = await captureLog(() =>
      runConformityTarget({
        store: makeFakeStore(ENFORCED_DIST),
        runner: okRunner,
        cwd,
        closePool: false,
      }),
    );
    assert.match(out, /merged with conformity-target\.json overrides/);
    assert.match(out, /array_syntax\s+->\s+generic\s+\[override\]/);
    // var_decl stays a seed.
    assert.match(out, /var_decl\s+->\s+const\s+\[seed\]/);
    // Migration now measured against the override target generic (atTarget=5/30).
    assert.match(out, /array_syntax\s+16\.7% at target \(5\/30\)\s+to migrate: 25/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// --init
// --------------------------------------------------------------------------

test('--init writes a conformity-target.json seeded from the enforced modes', async () => {
  const cwd = mkTmp();
  try {
    await captureLog(() =>
      runConformityTarget({
        store: makeFakeStore(ENFORCED_DIST),
        runner: okRunner,
        cwd,
        init: true,
        closePool: false,
      }),
    );
    const file = path.join(cwd, 'conformity-target.json');
    assert.ok(fs.existsSync(file), 'conformity-target.json should be written');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Seeded from the descriptive modes of the ENFORCED axes only.
    assert.equal(parsed.var_decl, 'const');
    assert.equal(parsed.array_syntax, 'bracket');
    assert.equal(parsed.export_style, 'named');
    // Guarded axes (too few / absence-only) are NOT seeded.
    assert.equal(parsed.string_style, undefined);
    assert.equal(parsed.async_style, undefined);
    // The seeded keys match seedTarget for the enforced axes.
    const seed = seedTarget({
      var_decl: ENFORCED_DIST.var_decl,
      array_syntax: ENFORCED_DIST.array_syntax,
      export_style: ENFORCED_DIST.export_style,
    });
    assert.equal(parsed.var_decl, seed.var_decl);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--init does NOT overwrite an existing file without --force', async () => {
  const cwd = mkTmp();
  try {
    const file = path.join(cwd, 'conformity-target.json');
    const original = JSON.stringify({ var_decl: 'let' }); // a deliberate human choice
    fs.writeFileSync(file, original, 'utf8');

    const out = await captureLog(() =>
      runConformityTarget({
        store: makeFakeStore(ENFORCED_DIST),
        runner: okRunner,
        cwd,
        init: true,
        closePool: false,
      }),
    );
    assert.match(out, /already exists/);
    assert.match(out, /--force/);
    // File is untouched.
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--init --force regenerates the file from the current modes', async () => {
  const cwd = mkTmp();
  try {
    const file = path.join(cwd, 'conformity-target.json');
    fs.writeFileSync(file, JSON.stringify({ var_decl: 'let' }), 'utf8');

    await captureLog(() =>
      runConformityTarget({
        store: makeFakeStore(ENFORCED_DIST),
        runner: okRunner,
        cwd,
        init: true,
        force: true,
        closePool: false,
      }),
    );
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Regenerated from the modes -> var_decl back to const.
    assert.equal(parsed.var_decl, 'const');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Unavailable gate (structured, no throw, no file written)
// --------------------------------------------------------------------------

test('unavailable gate (Postgres down) prints a fix-it message and returns without throwing', async () => {
  const cwd = mkTmp();
  try {
    const out = await captureLog(() =>
      runConformityTarget({
        store: makeFakeStore(ENFORCED_DIST),
        runner: downRunner,
        cwd,
        init: true, // even with --init, the gate short-circuits before writing
        closePool: false,
      }),
    );
    assert.match(out, /Postgres not configured\/reachable/);
    assert.match(out, /conformity-backfill/);
    // No file written when unavailable.
    assert.ok(!fs.existsSync(path.join(cwd, 'conformity-target.json')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('CODEBASE_PKG_CONFORMITY=off disables the command (no throw, no file)', async () => {
  const cwd = mkTmp();
  const prev = process.env.CODEBASE_PKG_CONFORMITY;
  process.env.CODEBASE_PKG_CONFORMITY = 'off';
  try {
    const out = await captureLog(() =>
      runConformityTarget({
        store: makeFakeStore(ENFORCED_DIST),
        runner: okRunner, // gate short-circuits on the env var before probing
        cwd,
        init: true,
        closePool: false,
      }),
    );
    assert.match(out, /CODEBASE_PKG_CONFORMITY=off/);
    assert.ok(!fs.existsSync(path.join(cwd, 'conformity-target.json')));
  } finally {
    if (prev === undefined) delete process.env.CODEBASE_PKG_CONFORMITY;
    else process.env.CODEBASE_PKG_CONFORMITY = prev;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
