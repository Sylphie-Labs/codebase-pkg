/**
 * Tests for init's hook installation + `.claude/settings.json` registration
 * (dist/cli/init.js): the codebase-pkg Stop (session-capture) and
 * PreToolUse(Read) (mcp-first) hooks are copied into `.claude/hooks/` and
 * registered in `.claude/settings.json`, MERGING non-destructively with
 * whatever is already there (e.g. a consumer repo, like cog-worx, that already
 * has its own Stop hooks from another system).
 *
 * No live DB, no model download: init runs with --skills-only --no-model to
 * avoid touching Postgres/Neo4j and to skip the embedding prefetch.
 *
 * Run after `npm run build`:
 *   node --test test/init-hooks-settings.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runInit } from '../dist/cli/init.js';
import { readState } from '../dist/upgrade/state.js';

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-init-hooks-'));
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

function readSettings(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// Fresh install: hook files copied, settings.json written from scratch
// ---------------------------------------------------------------------------

test('init copies both hook scripts into .claude/hooks/', async () => {
  const root = mkRepo();
  await captureOut(() => runInit(['--skills-only', '--no-model', '--local', `--path=${root}`]));

  assert.ok(fs.existsSync(path.join(root, '.claude', 'hooks', 'codebase-pkg-session-capture.cjs')));
  assert.ok(fs.existsSync(path.join(root, '.claude', 'hooks', 'codebase-pkg-mcp-first.cjs')));
});

test('init writes a fresh .claude/settings.json with Stop + PreToolUse(Read) entries', async () => {
  const root = mkRepo();
  await captureOut(() => runInit(['--skills-only', '--no-model', '--local', `--path=${root}`]));

  const settings = readSettings(root);
  assert.ok(Array.isArray(settings.hooks.Stop));
  const stopEntry = settings.hooks.Stop.find((m) =>
    m.hooks.some((h) => h.command.includes('codebase-pkg-session-capture.cjs')),
  );
  assert.ok(stopEntry, 'a Stop matcher entry runs the session-capture hook');

  const preEntry = settings.hooks.PreToolUse.find((m) =>
    m.hooks.some((h) => h.command.includes('codebase-pkg-mcp-first.cjs')),
  );
  assert.ok(preEntry, 'a PreToolUse matcher entry runs the mcp-first hook');
  assert.equal(preEntry.matcher, 'Read', 'mcp-first hook is scoped to the Read matcher');
});

test('init tracks the hook files and settings.json in state.json managedFiles with real hashes', async () => {
  const root = mkRepo();
  await captureOut(() => runInit(['--skills-only', '--no-model', '--local', `--path=${root}`]));

  const state = readState(root);
  const paths = state.managedFiles.map((f) => f.path);
  assert.ok(paths.includes('.claude/hooks/codebase-pkg-session-capture.cjs'));
  assert.ok(paths.includes('.claude/hooks/codebase-pkg-mcp-first.cjs'));
  assert.ok(paths.includes('.claude/settings.json'));

  for (const f of state.managedFiles) {
    if (f.path.startsWith('.claude/hooks/') || f.path === '.claude/settings.json') {
      assert.match(f.installedHash, /^[0-9a-f]{64}$/, `${f.path} has a real sha256 hash`);
    }
  }
});

// ---------------------------------------------------------------------------
// Non-destructive merge: pre-existing settings.json content survives
// ---------------------------------------------------------------------------

test('init merges into an existing .claude/settings.json without disturbing unrelated content', async () => {
  const root = mkRepo();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const preExisting = {
    permissions: { allow: ['Read', 'Edit'], deny: [] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'node .claude/hooks/some-other-guard.cjs', timeout: 5 }],
        },
      ],
      Stop: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: 'node .claude/hooks/doc-check.cjs', timeout: 10 },
            { type: 'command', command: 'node .claude/hooks/canon-check.cjs', timeout: 120 },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(
    path.join(root, '.claude', 'settings.json'),
    JSON.stringify(preExisting, null, 2) + '\n',
    'utf8',
  );

  await captureOut(() => runInit(['--skills-only', '--no-model', '--local', `--path=${root}`]));

  const settings = readSettings(root);

  // Unrelated permissions preserved verbatim.
  assert.deepEqual(settings.permissions, { allow: ['Read', 'Edit'], deny: [] });

  // The pre-existing Bash PreToolUse guard is untouched.
  const bashEntry = settings.hooks.PreToolUse.find((m) => m.matcher === 'Bash');
  assert.ok(bashEntry, 'pre-existing Bash PreToolUse matcher survives the merge');
  assert.equal(bashEntry.hooks[0].command, 'node .claude/hooks/some-other-guard.cjs');

  // The pre-existing Stop hooks (doc-check, canon-check) are untouched.
  const originalStopEntry = settings.hooks.Stop.find((m) =>
    m.hooks.some((h) => h.command.includes('doc-check.cjs')),
  );
  assert.ok(originalStopEntry, 'pre-existing doc-check Stop hook survives the merge');
  assert.ok(
    originalStopEntry.hooks.some((h) => h.command.includes('canon-check.cjs')),
    'pre-existing canon-check Stop hook survives the merge',
  );

  // AND our new hooks are present alongside them.
  assert.ok(
    settings.hooks.Stop.some((m) => m.hooks.some((h) => h.command.includes('codebase-pkg-session-capture.cjs'))),
  );
  assert.ok(
    settings.hooks.PreToolUse.some(
      (m) => m.matcher === 'Read' && m.hooks.some((h) => h.command.includes('codebase-pkg-mcp-first.cjs')),
    ),
  );
});

// ---------------------------------------------------------------------------
// Idempotency: re-running init does not duplicate hook registrations
// ---------------------------------------------------------------------------

test('re-running init (without --force) does not duplicate the hook registrations', async () => {
  const root = mkRepo();
  await captureOut(() => runInit(['--skills-only', '--no-model', '--local', `--path=${root}`]));
  // Second init needs --force at the top level (state.json already exists),
  // which also forces file re-writes -- but installSettingsHooks' own
  // idempotency guard should still prevent a duplicate hook entry.
  await captureOut(() =>
    runInit(['--skills-only', '--no-model', '--local', '--force', `--path=${root}`]),
  );

  const settings = readSettings(root);
  const stopMatches = settings.hooks.Stop.flatMap((m) => m.hooks).filter((h) =>
    h.command.includes('codebase-pkg-session-capture.cjs'),
  );
  const preMatches = settings.hooks.PreToolUse.flatMap((m) => m.hooks).filter((h) =>
    h.command.includes('codebase-pkg-mcp-first.cjs'),
  );
  assert.equal(stopMatches.length, 1, 'exactly one session-capture Stop registration after re-init');
  assert.equal(preMatches.length, 1, 'exactly one mcp-first PreToolUse registration after re-init');
});
