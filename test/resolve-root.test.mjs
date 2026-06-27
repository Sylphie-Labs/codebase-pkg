/**
 * Tests for resolveRoot (dist/cli/resolve-root.js).
 *
 * Pure logic: precedence (flag > env > cwd) and both arg forms (`--path X`,
 * `--path=X`, `--root X`, `--root=X`). No filesystem, no DB.
 *
 * Run after `npm run build`:
 *   node --test test/resolve-root.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { resolveRoot } from '../dist/cli/resolve-root.js';

test('default: no flag, no env -> absolute cwd', () => {
  assert.equal(resolveRoot([], {}), path.resolve(process.cwd()));
});

test('--path <dir> (space form) wins, returned absolute', () => {
  assert.equal(resolveRoot(['--path', '/tmp/foo'], {}), path.resolve('/tmp/foo'));
});

test('--path=<dir> (equals form) wins', () => {
  assert.equal(resolveRoot(['--path=/tmp/bar'], {}), path.resolve('/tmp/bar'));
});

test('--root <dir> alias (space form) wins', () => {
  assert.equal(resolveRoot(['--root', '/tmp/baz'], {}), path.resolve('/tmp/baz'));
});

test('--root=<dir> alias (equals form) wins', () => {
  assert.equal(resolveRoot(['--root=/tmp/qux'], {}), path.resolve('/tmp/qux'));
});

test('env CODEBASE_PKG_ROOT used when no flag', () => {
  assert.equal(
    resolveRoot([], { CODEBASE_PKG_ROOT: '/tmp/fromenv' }),
    path.resolve('/tmp/fromenv'),
  );
});

test('flag beats env', () => {
  assert.equal(
    resolveRoot(['--path', '/tmp/flag'], { CODEBASE_PKG_ROOT: '/tmp/env' }),
    path.resolve('/tmp/flag'),
  );
});

test('relative flag value is resolved to absolute', () => {
  assert.equal(resolveRoot(['--path', 'sub/dir'], {}), path.resolve('sub/dir'));
});

test('later flag occurrence wins', () => {
  assert.equal(resolveRoot(['--path', '/a', '--root', '/b'], {}), path.resolve('/b'));
});
