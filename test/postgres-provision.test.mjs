/**
 * Tests for Postgres (pgvector) provisioning in `codebase-pkg init --docker`.
 *
 * These cover PURE logic only and require NO Docker, no running Postgres, and
 * trigger NO model download:
 *   - derivePgBasePort: deterministic, in its own range, distinct from Neo4j ports
 *   - renderComposeFile: emits the pgvector service with correct image/env/ports/volume
 *   - state.json postgres.uri is well-formed and matches the mapped host port
 *   - resolvePgConfig falls back to the default DSN when state has no postgres block
 *
 * Run after `npm run build`:
 *   node --test test/postgres-provision.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  deriveInstanceSlug,
  deriveBasePorts,
  derivePgBasePort,
} from '../dist/cli/neo4j-config.js';
import { renderComposeFile } from '../dist/cli/init.js';
import { resolvePgConfig } from '../dist/conformity/pg-client.js';
import { writeState } from '../dist/upgrade/state.js';

// --------------------------------------------------------------------------
// derivePgBasePort
// --------------------------------------------------------------------------

test('derivePgBasePort is deterministic for a given slug', () => {
  const a = derivePgBasePort('myrepo-1a2b');
  const b = derivePgBasePort('myrepo-1a2b');
  assert.equal(a, b);
});

test('derivePgBasePort sits in its own [5500, 6199] range', () => {
  for (const slug of ['repo-0000', 'service-abcd', 'codebase-pkg-ffff', 'x-9999']) {
    const p = derivePgBasePort(slug);
    assert.ok(p >= 5500 && p <= 6199, `${slug} -> ${p} should be in [5500, 6199]`);
  }
});

test('derivePgBasePort never overlaps the Neo4j http/bolt ranges', () => {
  // Neo4j http base in [7600, 8299], bolt base in [7700, 8399].
  for (const slug of ['a-0001', 'b-1234', 'c-cdef', 'd-7777', 'e-ffff']) {
    const pg = derivePgBasePort(slug);
    const { http, bolt } = deriveBasePorts(slug);
    assert.notEqual(pg, http);
    assert.notEqual(pg, bolt);
    // pg range is strictly below the Neo4j ranges, so even after a +200 scan
    // window they cannot meet.
    assert.ok(pg + 200 < 7600, `pg base ${pg} + scan window must stay below 7600`);
  }
});

test('derivePgBasePort spreads distinct slugs across the range', () => {
  const ports = new Set();
  for (let i = 0; i < 50; i++) ports.add(derivePgBasePort(`repo-${i}`));
  // Not a strict guarantee, but a healthy hash should yield many distinct bases.
  assert.ok(ports.size > 20, `expected good spread, got ${ports.size} distinct bases`);
});

// --------------------------------------------------------------------------
// renderComposeFile
// --------------------------------------------------------------------------

const SAMPLE = { slug: 'demo-1a2b', httpPort: 7611, boltPort: 7733, pgPort: 5544 };

test('renderComposeFile includes the pgvector service with the pinned image', () => {
  const yml = renderComposeFile(SAMPLE);
  assert.match(yml, /image: pgvector\/pgvector:pg16/);
  assert.match(yml, /container_name: codebase-pkg-postgres-demo-1a2b/);
});

test('renderComposeFile sets the Postgres env to match the default DSN', () => {
  const yml = renderComposeFile(SAMPLE);
  assert.match(yml, /POSTGRES_USER: codebase-pkg/);
  assert.match(yml, /POSTGRES_PASSWORD: codebase-pkg-local/);
  assert.match(yml, /POSTGRES_DB: codebase_pkg/);
});

test('renderComposeFile maps the per-instance host port to container 5432', () => {
  const yml = renderComposeFile(SAMPLE);
  assert.match(yml, /- "5544:5432"/);
});

test('renderComposeFile declares the named pg data volume (dashes->underscores)', () => {
  const yml = renderComposeFile(SAMPLE);
  // volSlug: demo-1a2b -> demo_1a2b
  assert.match(yml, /codebase_pkg_pg_data_demo_1a2b:\/var\/lib\/postgresql\/data/);
  // volume must also be declared in the top-level volumes block
  assert.match(yml, /volumes:[\s\S]*codebase_pkg_pg_data_demo_1a2b:/);
});

test('renderComposeFile still emits the Neo4j service alongside Postgres', () => {
  const yml = renderComposeFile(SAMPLE);
  assert.match(yml, /image: neo4j:5-community/);
  assert.match(yml, /- "7611:7474"/);
  assert.match(yml, /- "7733:7687"/);
  assert.match(yml, /container_name: codebase-pkg-neo4j-demo-1a2b/);
});

test('renderComposeFile uses one compose project for both services', () => {
  const yml = renderComposeFile(SAMPLE);
  assert.match(yml, /name: codebase-pkg-demo-1a2b/);
});

// --------------------------------------------------------------------------
// state.json postgres.uri shape + resolution
// --------------------------------------------------------------------------

test('a state.json postgres.uri is well-formed and its port matches the mapping', () => {
  const slug = deriveInstanceSlug('/tmp/example-repo');
  const pgPort = 5544;
  const uri = `postgres://codebase-pkg:codebase-pkg-local@localhost:${pgPort}/codebase_pkg`;

  // matches the default DSN's user/password/db, only the port differs
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'postgres:');
  assert.equal(parsed.username, 'codebase-pkg');
  assert.equal(parsed.password, 'codebase-pkg-local');
  assert.equal(parsed.hostname, 'localhost');
  assert.equal(Number(parsed.port), pgPort);
  assert.equal(parsed.pathname, '/codebase_pkg');

  // wired through state.json, resolvePgConfig must pick it up verbatim
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-pg-state-'));
  try {
    delete process.env.CODEBASE_PKG_PG_URI; // ensure env does not shadow state
    writeState(cwd, {
      version: '0.0.0-test',
      installedAt: new Date().toISOString(),
      lastUpgradedAt: new Date().toISOString(),
      installMode: 'global',
      cliPathAtInstall: '/dev/null',
      managedFiles: [],
      postgres: { uri, containerName: `codebase-pkg-postgres-${slug}`, port: pgPort, slug },
    });
    assert.equal(resolvePgConfig(cwd).uri, uri);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('an InstallState without a postgres block falls back to the default DSN', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-pg-fallback-'));
  try {
    delete process.env.CODEBASE_PKG_PG_URI;
    // legacy-shaped state: only neo4j present, no postgres block at all
    writeState(cwd, {
      version: '0.0.0-test',
      installedAt: new Date().toISOString(),
      lastUpgradedAt: new Date().toISOString(),
      installMode: 'global',
      cliPathAtInstall: '/dev/null',
      managedFiles: [],
      neo4j: {
        uri: 'bolt://localhost:7733',
        containerName: 'codebase-pkg-neo4j-legacy',
        httpPort: 7611,
        boltPort: 7733,
        slug: 'legacy',
      },
    });
    assert.equal(
      resolvePgConfig(cwd).uri,
      'postgres://codebase-pkg:codebase-pkg-local@localhost:5432/codebase_pkg',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('no state file at all also resolves to the default DSN', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-pg-nostate-'));
  try {
    delete process.env.CODEBASE_PKG_PG_URI;
    assert.equal(
      resolvePgConfig(cwd).uri,
      'postgres://codebase-pkg:codebase-pkg-local@localhost:5432/codebase_pkg',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
