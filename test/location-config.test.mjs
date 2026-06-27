/**
 * Tests for the location-configuration feature:
 *   - resolveNeo4jConfig / resolvePgConfig precedence: override > env > state > default
 *   - init persists `root` + explicit --neo4j-uri/--pg-uri into state.json
 *   - uninstall resolves the same root via --path and operates on that state
 *   - uninstall prints the root-mismatch warning when state.root differs
 *
 * No live DB, no model download. init runs with --skills-only --no-model to
 * avoid touching Postgres/Neo4j and to skip the embedding prefetch.
 *
 * Run after `npm run build`:
 *   node --test test/location-config.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveNeo4jConfig } from '../dist/cli/neo4j-config.js';
import { resolvePgConfig } from '../dist/conformity/pg-client.js';
import { runInit } from '../dist/cli/init.js';
import { runUninstall } from '../dist/cli/uninstall.js';
import { readState } from '../dist/upgrade/state.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-loc-'));
}

function writeRawState(root, obj) {
  const dir = path.join(root, '.codebase-pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const NEO_DEFAULT = 'bolt://localhost:7687';
const PG_DEFAULT = 'postgres://codebase-pkg:codebase-pkg-local@localhost:5432/codebase_pkg';

/** Run fn with neo4j/pg env URI overrides set to the given values (or cleared). */
async function withEnv(env, fn) {
  const saved = {
    neo: process.env.CODEBASE_PKG_NEO4J_URI,
    pg: process.env.CODEBASE_PKG_PG_URI,
  };
  if (env.neo === undefined) delete process.env.CODEBASE_PKG_NEO4J_URI;
  else process.env.CODEBASE_PKG_NEO4J_URI = env.neo;
  if (env.pg === undefined) delete process.env.CODEBASE_PKG_PG_URI;
  else process.env.CODEBASE_PKG_PG_URI = env.pg;
  try {
    return await fn();
  } finally {
    if (saved.neo === undefined) delete process.env.CODEBASE_PKG_NEO4J_URI;
    else process.env.CODEBASE_PKG_NEO4J_URI = saved.neo;
    if (saved.pg === undefined) delete process.env.CODEBASE_PKG_PG_URI;
    else process.env.CODEBASE_PKG_PG_URI = saved.pg;
  }
}

async function captureOut(fn) {
  const out = [];
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  let result;
  try {
    result = await fn();
  } finally {
    process.stdout.write = oo;
    process.stderr.write = oe;
  }
  return { result, text: out.join('') };
}

// --------------------------------------------------------------------------
// resolveNeo4jConfig precedence
// --------------------------------------------------------------------------

const STATE_WITH_DBS = {
  version: '0.4.0',
  installedAt: '2024-01-01T00:00:00Z',
  lastUpgradedAt: '2024-01-01T00:00:00Z',
  installMode: 'local',
  cliPathAtInstall: '/x',
  managedFiles: [],
  neo4j: { uri: 'bolt://state:7000', containerName: 'c', httpPort: 1, boltPort: 7000, slug: 's' },
  postgres: { uri: 'postgres://state:5000/db', containerName: 'c', port: 5000, slug: 's' },
};

test('neo4j: default when no override, env, or state', async () => {
  const root = mkRepo();
  await withEnv({}, () => {
    assert.equal(resolveNeo4jConfig(root).uri, NEO_DEFAULT);
  });
});

test('neo4j: state.uri beats default', async () => {
  const root = mkRepo();
  writeRawState(root, STATE_WITH_DBS);
  await withEnv({}, () => {
    assert.equal(resolveNeo4jConfig(root).uri, 'bolt://state:7000');
  });
});

test('neo4j: env beats state', async () => {
  const root = mkRepo();
  writeRawState(root, STATE_WITH_DBS);
  await withEnv({ neo: 'bolt://env:7100' }, () => {
    assert.equal(resolveNeo4jConfig(root).uri, 'bolt://env:7100');
  });
});

test('neo4j: override flag beats env and state', async () => {
  const root = mkRepo();
  writeRawState(root, STATE_WITH_DBS);
  await withEnv({ neo: 'bolt://env:7100' }, () => {
    assert.equal(resolveNeo4jConfig(root, 'bolt://flag:7200').uri, 'bolt://flag:7200');
  });
});

// --------------------------------------------------------------------------
// resolvePgConfig precedence
// --------------------------------------------------------------------------

test('pg: default when no override, env, or state', async () => {
  const root = mkRepo();
  await withEnv({}, () => {
    assert.equal(resolvePgConfig(root).uri, PG_DEFAULT);
  });
});

test('pg: state.uri beats default', async () => {
  const root = mkRepo();
  writeRawState(root, STATE_WITH_DBS);
  await withEnv({}, () => {
    assert.equal(resolvePgConfig(root).uri, 'postgres://state:5000/db');
  });
});

test('pg: env beats state', async () => {
  const root = mkRepo();
  writeRawState(root, STATE_WITH_DBS);
  await withEnv({ pg: 'postgres://env:5100/db' }, () => {
    assert.equal(resolvePgConfig(root).uri, 'postgres://env:5100/db');
  });
});

test('pg: override flag beats env and state', async () => {
  const root = mkRepo();
  writeRawState(root, STATE_WITH_DBS);
  await withEnv({ pg: 'postgres://env:5100/db' }, () => {
    assert.equal(resolvePgConfig(root, 'postgres://flag:5200/db').uri, 'postgres://flag:5200/db');
  });
});

// --------------------------------------------------------------------------
// init persists root + explicit DB URIs at the chosen --path
// --------------------------------------------------------------------------

test('init --path writes state.json at that root, recording root', async () => {
  const root = mkRepo();
  await withEnv({}, () =>
    captureOut(() =>
      runInit(['--skills-only', '--no-model', '--local', `--path=${root}`]),
    ),
  );
  const state = readState(root);
  assert.ok(state, 'state.json should exist at the --path root');
  assert.equal(state.root, path.resolve(root));
});

test('init --neo4j-uri / --pg-uri persist into state.neo4j.uri / state.postgres.uri', async () => {
  const root = mkRepo();
  await withEnv({}, () =>
    captureOut(() =>
      runInit([
        '--mcp-only', // single managed file, no constraints/skills needed
        '--no-model',
        '--local',
        `--path=${root}`,
        '--neo4j-uri',
        'bolt://persisted:7300',
        '--pg-uri',
        'postgres://persisted:5300/db',
      ]),
    ),
  );
  const state = readState(root);
  assert.equal(state.neo4j?.uri, 'bolt://persisted:7300');
  assert.equal(state.postgres?.uri, 'postgres://persisted:5300/db');
  // Later teardown reuses them without re-specifying (resolver reads state).
  await withEnv({}, () => {
    assert.equal(resolveNeo4jConfig(root).uri, 'bolt://persisted:7300');
    assert.equal(resolvePgConfig(root).uri, 'postgres://persisted:5300/db');
  });
});

test('init creates a non-existent --path directory', async () => {
  const parent = mkRepo();
  const root = path.join(parent, 'nested', 'new-install');
  assert.equal(fs.existsSync(root), false);
  await withEnv({}, () =>
    captureOut(() => runInit(['--mcp-only', '--no-model', '--local', `--path=${root}`])),
  );
  assert.equal(fs.existsSync(root), true);
  assert.ok(readState(root));
});

// --------------------------------------------------------------------------
// uninstall resolves the same --path root + root-mismatch warning
// --------------------------------------------------------------------------

test('uninstall --path operates on the state at that root', async () => {
  const root = mkRepo();
  await withEnv({}, () =>
    captureOut(() => runInit(['--mcp-only', '--no-model', '--local', `--path=${root}`])),
  );
  assert.ok(readState(root), 'precondition: state exists');

  const { result, text } = await captureOut(() =>
    runUninstall(['--confirm', `--path=${root}`]),
  );
  assert.equal(result, 0);
  assert.match(text, /Done/);
  assert.equal(readState(root), null, 'state should be removed at the --path root');
});

test('uninstall warns when recorded state.root differs from resolved root', async () => {
  const root = mkRepo();
  writeRawState(root, {
    version: '0.4.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [],
    root: '/recorded/elsewhere',
  });
  const { result, text } = await captureOut(() =>
    runUninstall(['--confirm', `--path=${root}`]),
  );
  assert.equal(result, 0);
  assert.match(text, /differs from recorded install root \/recorded\/elsewhere/);
});
