/**
 * Tests for the `uninstall` command surface (dist/cli/uninstall.js).
 *
 * Focus: BACKWARDS COMPATIBILITY with old/partial/hand-edited state.json files.
 * No DB, no network: we build a temp repo with a `.codebase-pkg/state.json` and
 * some managed files on disk, run uninstall in that cwd, and assert behavior.
 *
 * Covered:
 *   - state.json with NO `managedFiles` key -> does not throw, removes state
 *     file, reports 0 deleted.
 *   - state.json with `managedFiles: []` -> unchanged behavior (no files, state
 *     removed).
 *   - state.json with a malformed managedFiles entry (missing `path`) -> skipped,
 *     does not throw, well-formed siblings still handled.
 *   - well-formed state (regression guard) -> deletes the listed files AND the
 *     state file.
 *   - getManagedFiles accessor unit behavior.
 *
 * Run after `npm run build`:
 *   node --test test/uninstall.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runUninstall } from '../dist/cli/uninstall.js';
import { getManagedFiles } from '../dist/upgrade/state.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Make a temp repo dir; returns its absolute path. */
function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-uninstall-'));
}

/** Write `.codebase-pkg/state.json` with the given raw object. */
function writeRawState(repo, obj) {
  const dir = path.join(repo, '.codebase-pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** Create a file (with parent dirs) under the repo. */
function touch(repo, rel, contents = 'x') {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf8');
  return abs;
}

function exists(repo, rel) {
  return fs.existsSync(path.join(repo, rel));
}

/** Run a function with cwd temporarily set to `repo`, capturing stdout/stderr. */
async function inRepo(repo, fn) {
  const prev = process.cwd();
  const out = [];
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  process.chdir(repo);
  let result;
  try {
    result = await fn();
  } finally {
    process.chdir(prev);
    process.stdout.write = oo;
    process.stderr.write = oe;
  }
  return { result, text: out.join('') };
}

// --------------------------------------------------------------------------
// getManagedFiles accessor
// --------------------------------------------------------------------------

test('getManagedFiles: missing managedFiles -> empty, 0 malformed', () => {
  assert.deepEqual(getManagedFiles({}), { files: [], malformed: 0 });
});

test('getManagedFiles: non-array managedFiles -> empty, 0 malformed', () => {
  assert.deepEqual(getManagedFiles({ managedFiles: 'nope' }), { files: [], malformed: 0 });
});

test('getManagedFiles: drops malformed entries, keeps well-formed', () => {
  const { files, malformed } = getManagedFiles({
    managedFiles: [
      { path: 'a.txt', installedHash: 'h' },
      { installedHash: 'no-path' }, // malformed: no path
      null, // malformed
      'string', // malformed
      { path: 'b.txt' },
    ],
  });
  assert.deepEqual(files.map((f) => f.path), ['a.txt', 'b.txt']);
  assert.equal(malformed, 3);
});

// --------------------------------------------------------------------------
// uninstall against old/partial state files
// --------------------------------------------------------------------------

test('uninstall: state.json with NO managedFiles key does not throw, removes state, 0 deleted', async () => {
  const repo = mkRepo();
  writeRawState(repo, {
    version: '0.1.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    // no managedFiles
  });

  const { result, text } = await inRepo(repo, () => runUninstall(['--confirm']));
  assert.equal(result, 0);
  assert.match(text, /0 deleted/);
  assert.equal(exists(repo, '.codebase-pkg/state.json'), false, 'state file should be removed');
});

test('uninstall: managedFiles: [] -> unchanged behavior, state removed', async () => {
  const repo = mkRepo();
  writeRawState(repo, {
    version: '0.2.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [],
  });

  const { result, text } = await inRepo(repo, () => runUninstall(['--confirm']));
  assert.equal(result, 0);
  assert.match(text, /0 deleted/);
  assert.equal(exists(repo, '.codebase-pkg/state.json'), false);
});

test('uninstall: malformed managedFiles entry is skipped, does not throw, siblings handled', async () => {
  const repo = mkRepo();
  // Well-formed file present on disk with matching hash so it deletes cleanly.
  const goodRel = 'docs/good.md';
  touch(repo, goodRel, 'hello');
  const crypto = await import('node:crypto');
  const goodHash = crypto.createHash('sha256').update('hello').digest('hex');

  writeRawState(repo, {
    version: '0.3.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles: [
      { installedHash: 'orphan' }, // malformed: no path
      { path: goodRel, installedHash: goodHash },
    ],
  });

  const { result, text } = await inRepo(repo, () => runUninstall(['--confirm']));
  assert.equal(result, 0);
  assert.match(text, /skipped 1 malformed managedFiles entry/);
  assert.match(text, /1 deleted/);
  assert.equal(exists(repo, goodRel), false, 'well-formed managed file should be deleted');
  assert.equal(exists(repo, '.codebase-pkg/state.json'), false);
});

test('uninstall: well-formed state (regression) deletes listed files + state file', async () => {
  const repo = mkRepo();
  const crypto = await import('node:crypto');
  const files = ['a.txt', 'sub/b.txt'];
  const managedFiles = files.map((rel) => {
    const contents = `content-${rel}`;
    touch(repo, rel, contents);
    return {
      path: rel,
      installedHash: crypto.createHash('sha256').update(contents).digest('hex'),
    };
  });

  writeRawState(repo, {
    version: '0.4.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    managedFiles,
  });

  const { result, text } = await inRepo(repo, () => runUninstall(['--confirm']));
  assert.equal(result, 0);
  assert.match(text, /2 deleted/);
  for (const rel of files) assert.equal(exists(repo, rel), false, `${rel} should be deleted`);
  assert.equal(exists(repo, '.codebase-pkg/state.json'), false);
});

test('uninstall: not initialized (no state.json) is a clean no-op', async () => {
  const repo = mkRepo();
  const { result, text } = await inRepo(repo, () => runUninstall(['--confirm']));
  assert.equal(result, 0);
  assert.match(text, /not initialized/);
});
