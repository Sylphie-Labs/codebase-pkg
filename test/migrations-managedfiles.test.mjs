/**
 * Tests for migration BACKWARDS COMPATIBILITY with old/partial state.json files
 * that have no `managedFiles` key.
 *
 * Focus: the migrations that read `ctx.state.managedFiles` must not crash when
 * that field is absent (an old/truncated state.json), and must normalize it via
 * the centralized `getManagedFiles` accessor.
 *
 *   - the no-op pass-through migrations (0.1.0->0.2.0, 0.2.0->0.2.1, 0.2.1->0.3.0)
 *     forward the list; with no managedFiles they must return `managedFiles: []`
 *     (not undefined).
 *   - the 0.3.0->0.4.0 migration SPREADS `ctx.state.managedFiles`; with no
 *     managedFiles it must not throw and must return a managedFiles array.
 *
 * No DB, no network, no filesystem writes (dryRun): we hand a migration a
 * MigrationContext whose state lacks managedFiles and assert behavior.
 *
 * Run after `npm run build`:
 *   node --test test/migrations-managedfiles.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import m010 from '../dist/upgrade/migrations/0.1.0-to-0.2.0.js';
import m020 from '../dist/upgrade/migrations/0.2.0-to-0.2.1.js';
import m021 from '../dist/upgrade/migrations/0.2.1-to-0.3.0.js';
import m030 from '../dist/upgrade/migrations/0.3.0-to-0.4.0.js';

// Package root is two levels up from this test file (test/ -> repo root).
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** An old-style state object with NO managedFiles key. */
function stateWithoutManagedFiles() {
  return {
    version: '0.1.0',
    installedAt: '2024-01-01T00:00:00Z',
    lastUpgradedAt: '2024-01-01T00:00:00Z',
    installMode: 'local',
    cliPathAtInstall: '/x',
    // no managedFiles
  };
}

/** Build a MigrationContext for `state`, dry-run so nothing is written. */
function ctxFor(state, cwd) {
  return {
    cwd,
    state,
    dryRun: true,
    force: false,
    packageRoot: PKG_ROOT,
  };
}

// --------------------------------------------------------------------------
// Pass-through migrations: forward the list, must be [] (not undefined).
// --------------------------------------------------------------------------

for (const mig of [m010, m020, m021]) {
  test(`pass-through ${mig.from}->${mig.to}: no managedFiles -> returns managedFiles: []`, async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-mig-'));
    const res = await mig.apply(ctxFor(stateWithoutManagedFiles(), repo));
    assert.ok(Array.isArray(res.managedFiles), 'managedFiles should be an array');
    assert.deepEqual(res.managedFiles, []);
  });
}

// --------------------------------------------------------------------------
// 0.3.0->0.4.0: spreads ctx.state.managedFiles -- must not throw on old state.
// --------------------------------------------------------------------------

test('0.3.0->0.4.0: no managedFiles does not throw, returns a managedFiles array', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-mig-'));
  let res;
  await assert.doesNotReject(async () => {
    res = await m030.apply(ctxFor(stateWithoutManagedFiles(), repo));
  });
  assert.ok(Array.isArray(res.managedFiles), 'managedFiles should be an array');
});
