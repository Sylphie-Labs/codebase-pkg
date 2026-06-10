/**
 * Tests for dist/sync/import-resolver.js.
 *
 * resolveImportTarget / resolvePythonImportTarget check the real filesystem,
 * so TS cases use directories that exist in this repo (CWD = repo root when
 * `node --test` runs) and Python cases build a small temp tree.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import {
  resolveImportTarget,
  resolvePythonImportTarget,
} from '../dist/sync/import-resolver.js';

const REPO_ROOT = process.cwd().replace(/\\/g, '/');

function fwd(p) {
  return p.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// TypeScript resolution
// ---------------------------------------------------------------------------

test('bare external specifiers resolve to null', () => {
  const sourceDir = `${REPO_ROOT}/src/sync`;
  assert.equal(resolveImportTarget(sourceDir, 'neo4j-driver'), null);
  assert.equal(resolveImportTarget(sourceDir, 'ts-morph'), null);
  assert.equal(resolveImportTarget(sourceDir, '@modelcontextprotocol/sdk/server/mcp.js'), null);
  assert.equal(resolveImportTarget(sourceDir, 'node:path'), null);
});

test("'./<existing-subdir>' resolves to that subdirectory", () => {
  const sourceDir = `${REPO_ROOT}/src/mcp-server`;
  const expected = `${REPO_ROOT}/src/mcp-server/tools`;
  assert.ok(fs.existsSync(expected), 'precondition: tools subdir exists');

  const resolved = resolveImportTarget(sourceDir, './tools');
  assert.notEqual(resolved, null);
  assert.equal(fwd(resolved), expected);
});

test('relative file import in the SAME directory resolves to null (self-loop guard)', () => {
  const sourceDir = `${REPO_ROOT}/src/sync`;
  assert.equal(resolveImportTarget(sourceDir, './ast-parser.js'), null);
});

test('relative file import into a sibling directory resolves to that directory', () => {
  const sourceDir = `${REPO_ROOT}/src/sync`;
  const resolved = resolveImportTarget(sourceDir, '../mcp-server/neo4j-client.js');
  assert.notEqual(resolved, null);
  assert.equal(fwd(resolved), `${REPO_ROOT}/src/mcp-server`);
});

// ---------------------------------------------------------------------------
// Python resolution (temp fixture tree)
// ---------------------------------------------------------------------------

let pyRoot;     // <tmp>/cbpkg-pyres-XXX
let pkgDir;     // <pyRoot>/pkg
let appDir;     // <pyRoot>/app

before(() => {
  pyRoot = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-pyres-')));
  pkgDir = `${pyRoot}/pkg`;
  appDir = `${pyRoot}/app`;
  fs.mkdirSync(`${pkgDir}/sub`, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(`${pkgDir}/__init__.py`, '', 'utf8');
  fs.writeFileSync(`${pkgDir}/mod.py`, 'VALUE = 1\n', 'utf8');
  fs.writeFileSync(`${pkgDir}/sub/__init__.py`, '', 'utf8');
});

after(() => {
  if (pyRoot) fs.rmSync(pyRoot, { recursive: true, force: true });
});

test("python relative '.sub' resolves to the sibling subpackage directory", () => {
  const resolved = resolvePythonImportTarget(pkgDir, '.sub');
  assert.notEqual(resolved, null);
  assert.equal(fwd(resolved), `${pkgDir}/sub`);
});

test("python relative '..pkg.mod' walks up one level and resolves to the module's package dir", () => {
  const resolved = resolvePythonImportTarget(appDir, '..pkg.mod');
  assert.notEqual(resolved, null);
  assert.equal(fwd(resolved), pkgDir);
});

test('python stdlib / external absolute imports resolve to null', () => {
  assert.equal(resolvePythonImportTarget(pkgDir, 'os'), null);
  assert.equal(resolvePythonImportTarget(pkgDir, 'json'), null);
  assert.equal(resolvePythonImportTarget(pkgDir, 'fastapi'), null);
});
