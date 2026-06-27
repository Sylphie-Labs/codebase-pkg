/**
 * Tests for the `reset` command surface (dist/cli/reset.js).
 *
 * PURE logic only: NO live Neo4j, NO live Postgres. Fake cypher/sql runners
 * return canned counts, and the wipe/reseed steps are injected so we can assert
 * what WOULD run without touching a database. We cover:
 *   - flag parsing + scope resolution (incl. the mutually-exclusive error),
 *   - the plan shows live counts and masks credentials in the printed URIs,
 *   - dry-run and no-confirm are no-ops (no wipe, no reseed),
 *   - --confirm wipes the in-scope stores and respects scope flags,
 *   - --reseed runs the right rebuilds only after a successful wipe,
 *   - absent cfm_* tables (fresh install) are skipped, not failed.
 *
 * Run after `npm run build`:
 *   node --test test/reset.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseFlags,
  resolveScope,
  maskUri,
  renderPlan,
  runReset,
} from '../dist/cli/reset.js';

// --------------------------------------------------------------------------
// Fakes
// --------------------------------------------------------------------------

/** A cypher runner returning `count(n)` then `count(r)` records. */
function makeCypher(nodes, rels) {
  return async (q) => {
    const c = /count\(n\)/.test(q) ? nodes : rels;
    return [{ get: (k) => (k === 'c' ? c : undefined) }];
  };
}

/**
 * A sql runner returning canned counts per table. `counts` maps table -> number,
 * and `absent` is a set of table names that should throw undefined_table.
 */
function makeSql(counts, absent = new Set()) {
  const truncated = [];
  const runner = async (text) => {
    const m = /FROM (\w+)/.exec(text);
    if (m) {
      const table = m[1];
      if (absent.has(table)) {
        const err = new Error(`relation "${table}" does not exist`);
        err.code = '42P01';
        throw err;
      }
      return { rows: [{ c: counts[table] ?? 0 }] };
    }
    const tm = /TRUNCATE TABLE (.+)/.exec(text);
    if (tm) truncated.push(tm[1]);
    return { rows: [] };
  };
  runner.truncated = truncated;
  return runner;
}

async function captureOut(fn) {
  const out = [];
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  let code;
  try {
    code = await fn();
  } finally {
    process.stdout.write = oo;
    process.stderr.write = oe;
  }
  return { code, text: out.join('') };
}

const NEO4J_URI = 'bolt://localhost:7687';
const PG_URI = 'postgres://codebase-pkg:secret-pass@localhost:5432/codebase_pkg';

function baseDeps(extra = {}) {
  return {
    cypher: makeCypher(1234, 5678),
    sql: makeSql({ cfm_vectors: 900, cfm_calibration: 4, cfm_decisions: 300 }),
    neo4jUri: NEO4J_URI,
    pgUri: PG_URI,
    ...extra,
  };
}

// --------------------------------------------------------------------------
// parseFlags / resolveScope
// --------------------------------------------------------------------------

test('parseFlags reads confirm/yes, dry-run, scope, reseed', () => {
  assert.equal(parseFlags(['--yes']).confirm, true);
  assert.equal(parseFlags(['--confirm']).confirm, true);
  assert.equal(parseFlags(['--dry-run']).dryRun, true);
  assert.equal(parseFlags(['--graph-only']).graphOnly, true);
  assert.equal(parseFlags(['--conformity-only']).conformityOnly, true);
  assert.equal(parseFlags(['--reseed']).reseed, true);
});

test('parseFlags reads --neo4j-uri / --pg-uri (space and = forms)', () => {
  assert.equal(parseFlags(['--neo4j-uri', 'bolt://h:1']).neo4jUri, 'bolt://h:1');
  assert.equal(parseFlags(['--neo4j-uri=bolt://h:2']).neo4jUri, 'bolt://h:2');
  assert.equal(parseFlags(['--pg-uri', 'postgres://h:3']).pgUri, 'postgres://h:3');
  assert.equal(parseFlags(['--pg-uri=postgres://h:4']).pgUri, 'postgres://h:4');
  assert.equal(parseFlags([]).neo4jUri, undefined);
  assert.equal(parseFlags([]).pgUri, undefined);
});

test('resolveScope: default = both', () => {
  assert.deepEqual(resolveScope(parseFlags([])), { graph: true, conformity: true });
});

test('resolveScope: --graph-only and --conformity-only narrow scope', () => {
  assert.deepEqual(resolveScope(parseFlags(['--graph-only'])), { graph: true, conformity: false });
  assert.deepEqual(resolveScope(parseFlags(['--conformity-only'])), { graph: false, conformity: true });
});

test('resolveScope: both scope flags is a hard error', () => {
  assert.throws(
    () => resolveScope(parseFlags(['--graph-only', '--conformity-only'])),
    /mutually exclusive/,
  );
});

test('runReset returns 1 and prints when both scope flags are passed', async () => {
  const { code, text } = await captureOut(() =>
    runReset(['--graph-only', '--conformity-only', '--confirm'], baseDeps()),
  );
  assert.equal(code, 1);
  assert.match(text, /mutually exclusive/);
});

// --------------------------------------------------------------------------
// maskUri
// --------------------------------------------------------------------------

test('maskUri strips the password from a postgres DSN', () => {
  const masked = maskUri('postgres://user:secret@localhost:5432/db');
  assert.doesNotMatch(masked, /secret/);
  assert.match(masked, /localhost:5432/);
});

test('maskUri leaves a bolt URI (no creds) intact', () => {
  assert.equal(maskUri('bolt://localhost:7687'), 'bolt://localhost:7687');
});

// --------------------------------------------------------------------------
// renderPlan
// --------------------------------------------------------------------------

test('renderPlan shows live counts, masks creds, and reflects reseed scope', () => {
  const plan = renderPlan({
    scope: { graph: true, conformity: true },
    neo4jUri: NEO4J_URI,
    pgUri: PG_URI,
    graphCounts: { nodes: 1234, relationships: 5678 },
    tableCounts: [
      { table: 'cfm_vectors', rows: 900 },
      { table: 'cfm_calibration', rows: 4 },
      { table: 'cfm_decisions', rows: 300 },
    ],
    reseed: true,
  });
  assert.match(plan, /1234 nodes, 5678 relationships -> DELETE/);
  assert.match(plan, /cfm_vectors:?\s+900 rows -> TRUNCATE/);
  assert.doesNotMatch(plan, /secret-pass/);
  assert.match(plan, /Reseed after wipe: yes \(seed \+ conformity-backfill\)/);
});

test('renderPlan marks absent tables as skipped', () => {
  const plan = renderPlan({
    scope: { graph: false, conformity: true },
    neo4jUri: NEO4J_URI,
    pgUri: PG_URI,
    graphCounts: null,
    tableCounts: [{ table: 'cfm_vectors', rows: null }],
    reseed: false,
  });
  assert.match(plan, /cfm_vectors:?\s+absent -> skip \(absent\)/);
  assert.match(plan, /Reseed after wipe: no/);
});

// --------------------------------------------------------------------------
// dry-run / no-confirm are no-ops
// --------------------------------------------------------------------------

test('dry-run prints the plan and mutates nothing', async () => {
  let wiped = false;
  const { code, text } = await captureOut(() =>
    runReset(['--dry-run', '--confirm'], baseDeps({
      doWipeGraph: async () => { wiped = true; },
      doWipeConformity: async () => { wiped = true; },
    })),
  );
  assert.equal(code, 0);
  assert.match(text, /dry-run/);
  assert.equal(wiped, false);
});

test('without --confirm: prints plan + re-run hint, mutates nothing', async () => {
  let wiped = false;
  const { code, text } = await captureOut(() =>
    runReset([], baseDeps({
      doWipeGraph: async () => { wiped = true; },
      doWipeConformity: async () => { wiped = true; },
    })),
  );
  assert.equal(code, 0);
  assert.match(text, /Re-run with --confirm/);
  assert.equal(wiped, false);
});

// --------------------------------------------------------------------------
// --confirm wipes; scope is respected
// --------------------------------------------------------------------------

test('--confirm (default scope) wipes both graph and conformity', async () => {
  const calls = { graph: 0, conformity: null };
  const { code } = await captureOut(() =>
    runReset(['--confirm'], baseDeps({
      doWipeGraph: async () => { calls.graph++; },
      doWipeConformity: async (present) => { calls.conformity = present; },
    })),
  );
  assert.equal(code, 0);
  assert.equal(calls.graph, 1);
  assert.deepEqual(calls.conformity, ['cfm_vectors', 'cfm_calibration', 'cfm_decisions']);
});

test('--graph-only --confirm wipes ONLY the graph', async () => {
  const calls = { graph: 0, conformity: 0 };
  await captureOut(() =>
    runReset(['--graph-only', '--confirm'], baseDeps({
      doWipeGraph: async () => { calls.graph++; },
      doWipeConformity: async () => { calls.conformity++; },
    })),
  );
  assert.equal(calls.graph, 1);
  assert.equal(calls.conformity, 0);
});

test('--conformity-only --confirm wipes ONLY the cfm_* tables', async () => {
  const calls = { graph: 0, conformity: 0 };
  await captureOut(() =>
    runReset(['--conformity-only', '--confirm'], baseDeps({
      doWipeGraph: async () => { calls.graph++; },
      doWipeConformity: async () => { calls.conformity++; },
    })),
  );
  assert.equal(calls.graph, 0);
  assert.equal(calls.conformity, 1);
});

test('absent cfm_* tables are excluded from the truncate set', async () => {
  let present;
  await captureOut(() =>
    runReset(['--conformity-only', '--confirm'], baseDeps({
      sql: makeSql({ cfm_calibration: 4 }, new Set(['cfm_vectors', 'cfm_decisions'])),
      doWipeConformity: async (p) => { present = p; },
    })),
  );
  assert.deepEqual(present, ['cfm_calibration']);
});

// --------------------------------------------------------------------------
// --reseed runs the right rebuilds, only after a successful wipe
// --------------------------------------------------------------------------

test('--reseed (default scope) runs seed AND conformity-backfill after wipe', async () => {
  const order = [];
  await captureOut(() =>
    runReset(['--confirm', '--reseed'], baseDeps({
      doWipeGraph: async () => order.push('wipe-graph'),
      doWipeConformity: async () => order.push('wipe-cfm'),
      doSeed: async () => order.push('seed'),
      doConformityBackfill: async () => order.push('backfill'),
    })),
  );
  assert.deepEqual(order, ['wipe-graph', 'wipe-cfm', 'seed', 'backfill']);
});

test('--graph-only --reseed seeds the graph only (no backfill)', async () => {
  const order = [];
  await captureOut(() =>
    runReset(['--graph-only', '--confirm', '--reseed'], baseDeps({
      doWipeGraph: async () => order.push('wipe-graph'),
      doSeed: async () => order.push('seed'),
      doConformityBackfill: async () => order.push('backfill'),
    })),
  );
  assert.deepEqual(order, ['wipe-graph', 'seed']);
});

test('reseed does NOT run if the wipe fails', async () => {
  let seeded = false;
  const { code } = await captureOut(() =>
    runReset(['--confirm', '--reseed'], baseDeps({
      doWipeGraph: async () => { throw new Error('boom'); },
      doSeed: async () => { seeded = true; },
      doConformityBackfill: async () => { seeded = true; },
    })),
  );
  assert.equal(code, 1);
  assert.equal(seeded, false);
});

// --------------------------------------------------------------------------
// count-read failure is a clean non-zero, no mutation
// --------------------------------------------------------------------------

test('unreachable DB during count read returns 1 without wiping', async () => {
  let wiped = false;
  const { code, text } = await captureOut(() =>
    runReset(['--confirm'], baseDeps({
      cypher: async () => { throw new Error('ECONNREFUSED'); },
      doWipeGraph: async () => { wiped = true; },
    })),
  );
  assert.equal(code, 1);
  assert.match(text, /failed to read live counts/);
  assert.equal(wiped, false);
});

// --------------------------------------------------------------------------
// Backwards compatibility: old/missing state.json -> default URIs, no throw.
//
// These DON'T inject neo4jUri/pgUri, so reset must resolve them from the cwd
// via resolveNeo4jConfig / resolvePgConfig. We run in a temp repo and assert
// the plan falls back to the default bolt/PG URIs without throwing. Counts and
// wipe steps are still injected, so no live DB is touched.
// --------------------------------------------------------------------------

const DEFAULT_BOLT = 'bolt://localhost:7687';
const DEFAULT_PG_HOST = 'localhost:5432';

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-reset-'));
}

function writeRawState(repo, obj) {
  const dir = path.join(repo, '.codebase-pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** Run fn with cwd set to repo and env URI overrides cleared. */
async function inRepoNoEnv(repo, fn) {
  const prev = process.cwd();
  const savedNeo = process.env.CODEBASE_PKG_NEO4J_URI;
  const savedPg = process.env.CODEBASE_PKG_PG_URI;
  delete process.env.CODEBASE_PKG_NEO4J_URI;
  delete process.env.CODEBASE_PKG_PG_URI;
  process.chdir(repo);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
    if (savedNeo === undefined) delete process.env.CODEBASE_PKG_NEO4J_URI;
    else process.env.CODEBASE_PKG_NEO4J_URI = savedNeo;
    if (savedPg === undefined) delete process.env.CODEBASE_PKG_PG_URI;
    else process.env.CODEBASE_PKG_PG_URI = savedPg;
  }
}

/** Deps that resolve URIs from cwd (no neo4jUri/pgUri injected). */
function resolverDeps(extra = {}) {
  return {
    cypher: makeCypher(1, 1),
    sql: makeSql({ cfm_vectors: 0, cfm_calibration: 0, cfm_decisions: 0 }),
    doWipeGraph: async () => {},
    doWipeConformity: async () => {},
    ...extra,
  };
}

test('reset: state.json with NO neo4j/postgres blocks -> default URIs in plan', async () => {
  const repo = mkRepo();
  writeRawState(repo, {
    version: '0.4.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [],
    // no neo4j, no postgres
  });
  const { code, text } = await inRepoNoEnv(repo, () =>
    captureOut(() => runReset(['--dry-run'], resolverDeps())),
  );
  assert.equal(code, 0);
  assert.match(text, new RegExp(DEFAULT_BOLT.replace(/\//g, '\\/')));
  assert.match(text, new RegExp(DEFAULT_PG_HOST));
});

test('reset: no state.json at all -> default URIs in plan, returns 0', async () => {
  const repo = mkRepo();
  const { code, text } = await inRepoNoEnv(repo, () =>
    captureOut(() => runReset(['--dry-run'], resolverDeps())),
  );
  assert.equal(code, 0);
  assert.match(text, new RegExp(DEFAULT_BOLT.replace(/\//g, '\\/')));
  assert.match(text, new RegExp(DEFAULT_PG_HOST));
});

test('reset: state.json with neo4j but NO postgres -> custom bolt + default PG', async () => {
  const repo = mkRepo();
  writeRawState(repo, {
    version: '0.4.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [],
    neo4j: {
      uri: 'bolt://localhost:7799',
      containerName: 'c',
      httpPort: 7611,
      boltPort: 7799,
      slug: 'demo-1a2b',
    },
    // no postgres
  });
  const { code, text } = await inRepoNoEnv(repo, () =>
    captureOut(() => runReset(['--dry-run'], resolverDeps())),
  );
  assert.equal(code, 0);
  assert.match(text, /bolt:\/\/localhost:7799/);
  assert.match(text, new RegExp(DEFAULT_PG_HOST));
});

test('reset: state.json with postgres but NO neo4j -> default bolt + custom PG', async () => {
  const repo = mkRepo();
  writeRawState(repo, {
    version: '0.4.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [],
    // no neo4j
    postgres: {
      uri: 'postgres://codebase-pkg:codebase-pkg-local@localhost:5599/codebase_pkg',
      containerName: 'c',
      port: 5599,
      slug: 'demo-1a2b',
    },
  });
  const { code, text } = await inRepoNoEnv(repo, () =>
    captureOut(() => runReset(['--dry-run'], resolverDeps())),
  );
  assert.equal(code, 0);
  assert.match(text, new RegExp(DEFAULT_BOLT.replace(/\//g, '\\/')));
  assert.match(text, /localhost:5599/);
});

// --------------------------------------------------------------------------
// Explicit --neo4j-uri / --pg-uri flags take HIGHEST precedence in the plan.
//
// These DON'T inject neo4jUri/pgUri (so reset resolves them from flag > env >
// state > default). State.json sets distinct URIs, the flags set yet others;
// the plan must show the FLAG values. Counts/wipe are injected (no live DB).
// --------------------------------------------------------------------------

test('reset: --neo4j-uri / --pg-uri override state.json in the plan', async () => {
  const repo = mkRepo();
  writeRawState(repo, {
    version: '0.4.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [],
    neo4j: { uri: 'bolt://localhost:7799', containerName: 'c', httpPort: 1, boltPort: 7799, slug: 's' },
    postgres: { uri: 'postgres://codebase-pkg:codebase-pkg-local@localhost:5599/codebase_pkg', containerName: 'c', port: 5599, slug: 's' },
  });
  const { code, text } = await inRepoNoEnv(repo, () =>
    captureOut(() =>
      runReset(
        ['--dry-run', '--neo4j-uri', 'bolt://flaghost:9999', '--pg-uri', 'postgres://u:p@flaghost:8888/db'],
        resolverDeps(),
      ),
    ),
  );
  assert.equal(code, 0);
  // Flag values present; state values absent.
  assert.match(text, /bolt:\/\/flaghost:9999/);
  assert.match(text, /flaghost:8888/);
  assert.doesNotMatch(text, /7799/);
  assert.doesNotMatch(text, /5599/);
});

test('reset: --neo4j-uri beats env (env set, flag wins in plan)', async () => {
  const repo = mkRepo();
  writeRawState(repo, {
    version: '0.4.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [],
  });
  const prev = process.cwd();
  const savedNeo = process.env.CODEBASE_PKG_NEO4J_URI;
  process.env.CODEBASE_PKG_NEO4J_URI = 'bolt://envhost:1111';
  process.chdir(repo);
  try {
    const { code, text } = await captureOut(() =>
      runReset(['--dry-run', '--graph-only', '--neo4j-uri', 'bolt://flaghost:2222'], resolverDeps()),
    );
    assert.equal(code, 0);
    assert.match(text, /bolt:\/\/flaghost:2222/);
    assert.doesNotMatch(text, /envhost:1111/);
  } finally {
    process.chdir(prev);
    if (savedNeo === undefined) delete process.env.CODEBASE_PKG_NEO4J_URI;
    else process.env.CODEBASE_PKG_NEO4J_URI = savedNeo;
  }
});

// --------------------------------------------------------------------------
// Root-mismatch warning: state.root differs from resolved root.
// --------------------------------------------------------------------------

test('reset: warns when state.root differs from resolved root, still proceeds', async () => {
  const repo = mkRepo();
  writeRawState(repo, {
    version: '0.4.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [],
    root: '/some/other/recorded/root',
  });
  const { code, text } = await inRepoNoEnv(repo, () =>
    captureOut(() => runReset(['--dry-run', `--path=${repo}`], resolverDeps())),
  );
  assert.equal(code, 0);
  assert.match(text, /differs from recorded install root \/some\/other\/recorded\/root/);
});

test('reset: no warning when state.root matches resolved root', async () => {
  const repo = mkRepo();
  // recorded root == the resolved --path (path.resolve normalizes both)
  writeRawState(repo, {
    version: '0.4.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [],
    root: path.resolve(repo),
  });
  const { code, text } = await inRepoNoEnv(repo, () =>
    captureOut(() => runReset(['--dry-run', `--path=${repo}`], resolverDeps())),
  );
  assert.equal(code, 0);
  assert.doesNotMatch(text, /differs from recorded install root/);
});
