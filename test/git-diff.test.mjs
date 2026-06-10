/**
 * Tests for dist/sync/git-diff.js -- path-shape contract.
 *
 * getChangedFiles() and getDeletedFiles() both shell out to git in
 * process.cwd() (the repo root when `node --test` runs). We don't depend on
 * specific git history; instead we assert the *shape* of returned paths:
 * every path must be ABSOLUTE and forward-slashed, because graph nodes store
 * absolute filePaths and graph-differ's computeChangeset compares against them
 * with `f.filePath IN $filePaths`. A relative path here would silently fail to
 * match (the BUG 1 regression we're guarding).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as process from 'node:process';

import {
  getChangedFiles,
  getDeletedFiles,
  readLastSyncCommit,
} from '../dist/sync/git-diff.js';

const REPO_ROOT = process.cwd().replace(/\\/g, '/');

function assertAbsoluteForwardSlashed(p, label) {
  assert.equal(typeof p, 'string', `${label}: path is a string`);
  assert.ok(path.isAbsolute(p), `${label}: path is absolute (${p})`);
  assert.ok(!p.includes('\\'), `${label}: path uses forward slashes only (${p})`);
  assert.ok(
    p.startsWith(REPO_ROOT + '/') || p === REPO_ROOT,
    `${label}: path is rooted at the repo root (${p})`,
  );
}

test('getChangedFiles returns absolute, forward-slashed paths rooted at the repo', () => {
  const result = getChangedFiles();
  assert.ok(Array.isArray(result.changedFiles), 'changedFiles is an array');
  assert.equal(typeof result.currentCommit, 'string');
  assert.ok(result.currentCommit.length > 0, 'currentCommit is non-empty');
  for (const p of result.changedFiles) {
    assertAbsoluteForwardSlashed(p, 'changedFiles');
  }
});

test('getDeletedFiles returns an array of absolute, forward-slashed paths (BUG 1 shape contract)', () => {
  // Use HEAD..HEAD so the call is deterministic regardless of history: the
  // identical-commit short-circuit returns []. The point is to assert the
  // contract holds and never yields a relative path, which is what broke
  // deletion matching against absolute graph filePaths.
  const head = getChangedFiles().currentCommit;
  const sameRange = getDeletedFiles(head, head);
  assert.ok(Array.isArray(sameRange), 'identical commit range returns an array');
  assert.equal(sameRange.length, 0, 'identical commit range yields no deletions');

  // Also exercise a real range when prior sync history exists, without
  // depending on it: if there's a last-sync cursor, diff it against HEAD.
  const last = readLastSyncCommit();
  if (last && last !== head) {
    const deleted = getDeletedFiles(last, head);
    assert.ok(Array.isArray(deleted), 'real range returns an array');
    for (const p of deleted) {
      assertAbsoluteForwardSlashed(p, 'getDeletedFiles');
    }
  }
});
