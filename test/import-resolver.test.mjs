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
  resolveRustImportTarget,
  getWatchedPackages,
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

// ---------------------------------------------------------------------------
// getWatchedPackages auto-detect (temp fixture trees)
// ---------------------------------------------------------------------------

let detectRoots = [];          // tmp dirs to clean up
let savedPackagesEnv;          // saved CODEBASE_PKG_PACKAGES

function makeRoot() {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-detect-')));
  detectRoots.push(root);
  return root;
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', 'utf8');
}

function byDir(pkgs) {
  // map dir -> name for order-independent assertions
  return Object.fromEntries(pkgs.map(p => [p.dir, p.name]));
}

before(() => {
  // getWatchedPackages reads CODEBASE_PKG_PACKAGES; remove it for the fixture
  // cases so auto-detect actually runs, restore afterward.
  savedPackagesEnv = process.env.CODEBASE_PKG_PACKAGES;
  delete process.env.CODEBASE_PKG_PACKAGES;
});

after(() => {
  if (savedPackagesEnv === undefined) delete process.env.CODEBASE_PKG_PACKAGES;
  else process.env.CODEBASE_PKG_PACKAGES = savedPackagesEnv;
  for (const r of detectRoots) fs.rmSync(r, { recursive: true, force: true });
});

test('monorepo: apps/web/src + packages/api/src both detected', () => {
  const root = makeRoot();
  touch(`${root}/apps/web/src/index.ts`);
  touch(`${root}/packages/api/src/index.ts`);
  const pkgs = getWatchedPackages(root);
  const m = byDir(pkgs);
  assert.equal(m['apps/web/src'], 'web');
  assert.equal(m['packages/api/src'], 'api');
});

test('root-level dir with its own src/ → {name:frontend, dir:frontend/src}', () => {
  const root = makeRoot();
  touch(`${root}/frontend/src/App.tsx`);
  const pkgs = getWatchedPackages(root);
  assert.deepEqual(pkgs, [{ name: 'frontend', dir: 'frontend/src' }]);
});

test('src-less Python package under packages/ → package dir itself', () => {
  const root = makeRoot();
  touch(`${root}/packages/cognition-service/app/main.py`);
  const pkgs = getWatchedPackages(root);
  assert.deepEqual(pkgs, [{ name: 'cognition-service', dir: 'packages/cognition-service' }]);
});

test('negative: packages/docs with only README.md is NOT detected', () => {
  const root = makeRoot();
  touch(`${root}/packages/docs/README.md`);
  const pkgs = getWatchedPackages(root);
  assert.deepEqual(pkgs, [{ name: 'root', dir: '.' }]);
});

test('negative: src-less pkg with only test/decl files is NOT detected (no empty Service)', () => {
  const root = makeRoot();
  // .test.ts + .d.ts are matched by the seed EXCLUDE_PATTERNS, so collectSourceFiles
  // would yield 0 files; detecting this dir would MERGE an empty Service node.
  touch(`${root}/packages/foo/foo.test.ts`);
  touch(`${root}/packages/foo/types.d.ts`);
  const pkgs = getWatchedPackages(root);
  assert.deepEqual(pkgs, [{ name: 'root', dir: '.' }]);
});

test('negative: src-less Python pkg with only test_*.py / conftest.py is NOT detected', () => {
  const root = makeRoot();
  touch(`${root}/packages/svc/test_main.py`);
  touch(`${root}/packages/svc/conftest.py`);
  const pkgs = getWatchedPackages(root);
  assert.deepEqual(pkgs, [{ name: 'root', dir: '.' }]);
});

test('src-less pkg with a real .py alongside a test file IS detected', () => {
  const root = makeRoot();
  touch(`${root}/packages/svc/test_main.py`);
  touch(`${root}/packages/svc/app/main.py`); // real source one level down
  const pkgs = getWatchedPackages(root);
  assert.deepEqual(pkgs, [{ name: 'svc', dir: 'packages/svc' }]);
});

test('node_modules is never detected as a package', () => {
  const root = makeRoot();
  // top-level node_modules with source inside, plus a real package
  touch(`${root}/node_modules/some-dep/index.ts`);
  touch(`${root}/node_modules/some-dep/src/index.ts`);
  touch(`${root}/packages/foo/node_modules/dep/index.ts`);
  touch(`${root}/packages/foo/src/index.ts`);
  const pkgs = getWatchedPackages(root);
  const m = byDir(pkgs);
  assert.equal(m['packages/foo/src'], 'foo');
  for (const p of pkgs) {
    assert.ok(!p.dir.includes('node_modules'), `node_modules not watched (${p.dir})`);
    assert.notEqual(p.name, 'node_modules');
  }
});

test('single-package: only <root>/src → {name:app, dir:src}', () => {
  const root = makeRoot();
  touch(`${root}/src/index.ts`);
  const pkgs = getWatchedPackages(root);
  assert.deepEqual(pkgs, [{ name: 'app', dir: 'src' }]);
});

test('empty repo → [{name:root, dir:.}]', () => {
  const root = makeRoot();
  const pkgs = getWatchedPackages(root);
  assert.deepEqual(pkgs, [{ name: 'root', dir: '.' }]);
});

test('name collision: apps/foo/src AND packages/foo/src → unique names, both dirs', () => {
  const root = makeRoot();
  touch(`${root}/apps/foo/src/index.ts`);
  touch(`${root}/packages/foo/src/index.ts`);
  const pkgs = getWatchedPackages(root);
  const m = byDir(pkgs);
  assert.ok('apps/foo/src' in m, 'apps/foo/src present');
  assert.ok('packages/foo/src' in m, 'packages/foo/src present');
  const names = pkgs.map(p => p.name);
  assert.equal(new Set(names).size, names.length, 'names are unique');
  assert.ok(names.includes('foo'));
  assert.ok(names.includes('foo-2'));
});

test('parity: src-ful pkg named like a noise dir (build) is still detected', () => {
  const root = makeRoot();
  // A package literally named 'build' WITH its own src/ must survive — the
  // <pkg>/src branch has no name filter (long-standing behavior).
  touch(`${root}/packages/build/src/index.ts`);
  fs.writeFileSync(`${root}/packages/build/src/index.ts`, 'export const x = 1;\n', 'utf8');
  const pkgs = getWatchedPackages(root);
  const m = byDir(pkgs);
  assert.equal(m['packages/build/src'], 'build');
  assert.ok(
    pkgs.some(p => p.name === 'build' && p.dir === 'packages/build/src'),
    "entry { name:'build', dir:'packages/build/src' } present",
  );
});

test('recursion guard: src-less pkg with source only inside an ignored dir is NOT detected', () => {
  const root = makeRoot();
  // Only "source" under packages/vendored lives inside node_modules/ — must be ignored.
  touch(`${root}/packages/vendored/node_modules/dep/index.py`);
  // Sibling real package proves the guard is selective, not blanket-off.
  touch(`${root}/packages/realsvc/main.py`);
  const pkgs = getWatchedPackages(root);
  const m = byDir(pkgs);
  assert.equal(m['packages/realsvc'], 'realsvc');
  for (const p of pkgs) {
    assert.ok(
      p.dir !== 'packages/vendored' && !p.dir.startsWith('packages/vendored'),
      `vendored (source only in node_modules) not watched (${p.dir})`,
    );
  }
});

test('layer-3: top-level dotdir with its own src/ is NOT detected', () => {
  const root = makeRoot();
  touch(`${root}/.tooling/src/x.ts`);
  const pkgs = getWatchedPackages(root);
  for (const p of pkgs) {
    assert.notEqual(p.name, '.tooling');
    assert.notEqual(p.dir, '.tooling/src');
  }
  // Nothing else indexable at root → falls back to the root sentinel.
  assert.deepEqual(pkgs, [{ name: 'root', dir: '.' }]);
});

test('env override returns CODEBASE_PKG_PACKAGES verbatim', () => {
  const override = [{ name: 'custom', dir: 'weird/place' }];
  process.env.CODEBASE_PKG_PACKAGES = JSON.stringify(override);
  try {
    const root = makeRoot();
    touch(`${root}/src/index.ts`); // would otherwise detect 'app'
    const pkgs = getWatchedPackages(root);
    assert.deepEqual(pkgs, override);
  } finally {
    delete process.env.CODEBASE_PKG_PACKAGES;
  }
});

// ---------------------------------------------------------------------------
// Rust resolution (temp crate)
// ---------------------------------------------------------------------------

test('resolveRustImportTarget: crate/self/super/external', () => {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-rsres-')));
  try {
    fs.mkdirSync(`${root}/src/a`, { recursive: true });
    fs.writeFileSync(`${root}/Cargo.toml`, '[package]\nname = "x"\nversion = "0.1.0"\n');
    for (const f of ['src/lib.rs', 'src/a/mod.rs', 'src/a/b.rs', 'src/c.rs']) {
      fs.writeFileSync(`${root}/${f}`, '');
    }
    const src = `${root}/src`;
    const lib = `${src}/lib.rs`;
    const bRs = `${src}/a/b.rs`;

    // crate::a -> src/a (directory module)
    assert.equal(resolveRustImportTarget(`${root}/elsewhere`, lib, 'crate::a'), `${src}/a`);
    // crate::a::b::Item -> descends dirs only (b is b.rs), lands on src/a
    assert.equal(resolveRustImportTarget(src, bRs, 'crate::a::b::Item'), `${src}/a`);
    // crate::c -> c.rs is a file, resolves to the crate src dir
    assert.equal(resolveRustImportTarget(`${root}/elsewhere`, bRs, 'crate::c'), src);
    // self::x from lib.rs -> src (self-loop guard returns null when sourceDir is src)
    assert.equal(resolveRustImportTarget(`${root}/elsewhere`, lib, 'self::x'), src);
    assert.equal(resolveRustImportTarget(src, lib, 'self::x'), null);
    // self::a::foo from lib.rs descends into src/a
    assert.equal(resolveRustImportTarget(src, lib, 'self::a::foo'), `${src}/a`);
    // super:: from src/a/b.rs: module dir is src/a/b, parent src/a
    assert.equal(resolveRustImportTarget(src, bRs, 'super::Item'), `${src}/a`);
    assert.equal(resolveRustImportTarget(`${src}/a`, bRs, 'super::Item'), null);
    // super::super:: climbs to src
    assert.equal(resolveRustImportTarget(`${src}/a`, bRs, 'super::super::c'), src);
    // external crate -> null
    assert.equal(resolveRustImportTarget(src, lib, 'serde::Serialize'), null);
    assert.equal(resolveRustImportTarget(src, lib, 'std::collections'), null);
    // no Cargo.toml up the tree -> null
    const orphan = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-rsorph-')));
    try {
      fs.writeFileSync(`${orphan}/x.rs`, '');
      assert.equal(resolveRustImportTarget(`${root}/elsewhere`, `${orphan}/x.rs`, 'crate::a'), null);
    } finally {
      fs.rmSync(orphan, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRustImportTarget: relative sourceDir self-link returns null', () => {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-rsrel-')));
  try {
    fs.mkdirSync(`${root}/src`, { recursive: true });
    fs.writeFileSync(`${root}/Cargo.toml`, '[package]\nname = "x"\nversion = "0.1.0"\n');
    fs.writeFileSync(`${root}/src/lib.rs`, '');
    const relSrc = fwd(path.relative(process.cwd(), `${root}/src`));
    assert.equal(resolveRustImportTarget(relSrc, `${root}/src/lib.rs`, 'self::x'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
