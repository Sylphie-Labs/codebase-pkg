/**
 * Tests for `status` and `doctor` BACKWARDS COMPATIBILITY with old/partial
 * state.json files that have no `managedFiles` key.
 *
 * Both commands previously did `state.managedFiles.length` / iterated
 * `state.managedFiles` directly and would crash on a state.json written before
 * the field existed (or a truncated one). They now route through the centralized
 * `getManagedFiles` accessor.
 *
 * These paths are unit-testable without a live DB:
 *   - `status` reads state.json and hashes files on disk; no Neo4j/Postgres.
 *   - `doctor`'s managed-files check reads state + disk; we run doctor with
 *     --no-network so the Neo4j reachability check is skipped.
 *
 * Run after `npm run build`:
 *   node --test test/status-doctor-managedfiles.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runStatus } from '../dist/cli/status.js';
import { runDoctor } from '../dist/cli/doctor.js';

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-statusdoc-'));
}

function writeRawState(repo, obj) {
  const dir = path.join(repo, '.codebase-pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
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

const OLD_STATE_NO_MANAGED = {
  version: '0.1.0',
  installedAt: '2024-01-01T00:00:00Z',
  lastUpgradedAt: '2024-01-01T00:00:00Z',
  installMode: 'local',
  cliPathAtInstall: '/x',
  // no managedFiles
};

test('status: state.json with NO managedFiles key does not throw, reports 0 managed files', async () => {
  const repo = mkRepo();
  writeRawState(repo, OLD_STATE_NO_MANAGED);
  const { result, text } = await inRepo(repo, () => runStatus([]));
  assert.equal(result, 0);
  assert.match(text, /Managed files \(0\):/);
});

test('doctor: state.json with NO managedFiles key does not throw (managed-files check)', async () => {
  const repo = mkRepo();
  // .mcp.json + constraints so unrelated checks behave, though only the
  // managed-files crash-safety is under test here.
  writeRawState(repo, OLD_STATE_NO_MANAGED);
  const { result, text } = await inRepo(repo, () => runDoctor(['--no-network']));
  // doctor exits 1 when any check fails (e.g. missing .mcp.json) -- that's fine.
  assert.ok(result === 0 || result === 1, 'doctor returns an exit code, not a throw');
  // The managed-files check ran and reported the normalized count without crashing.
  assert.match(text, /managed-files\s+0\/0 files unchanged/);
});
