/**
 * Tests for the codebase-pkg Claude Code hook scripts (plain CommonJS, run
 * directly by `node` -- not part of the TypeScript build):
 *
 *   template/.claude/hooks/codebase-pkg-session-capture.cjs  (Stop hook)
 *   template/.claude/hooks/codebase-pkg-mcp-first.cjs        (PreToolUse Read hook)
 *
 * Each is spawned as a real child process with fixture JSON piped to stdin,
 * asserting on exit code + stdout JSON contract -- the same I/O shape Claude
 * Code itself uses to invoke a hook.
 *
 * Run after `npm run build` (build isn't required for these two files, but the
 * shared `npm test` script always builds first):
 *   node --test test/hooks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const HOOKS_DIR = path.join(process.cwd(), 'template', '.claude', 'hooks');
const SESSION_CAPTURE = path.join(HOOKS_DIR, 'codebase-pkg-session-capture.cjs');
const MCP_FIRST = path.join(HOOKS_DIR, 'codebase-pkg-mcp-first.cjs');

function runHook(scriptPath, stdinText) {
  const result = spawnSync(process.execPath, [scriptPath], {
    input: stdinText,
    encoding: 'utf8',
    timeout: 10000,
  });
  return result;
}

function markerPathFor(sessionId) {
  return path.join(os.tmpdir(), `codebase-pkg-mcpfirst-${sessionId}`);
}

// ---------------------------------------------------------------------------
// codebase-pkg-session-capture.cjs (Stop hook)
// ---------------------------------------------------------------------------

test('session-capture: stop_hook_active=true -> silent exit 0 (loop guard)', () => {
  const r = runHook(SESSION_CAPTURE, JSON.stringify({ stop_hook_active: true }));
  assert.equal(r.status, 0);
  assert.equal((r.stdout || '').trim(), '', 'no stdout when the loop guard fires');
});

test('session-capture: normal stop -> exit 0 with a block decision + instructive reason', () => {
  const r = runHook(
    SESSION_CAPTURE,
    JSON.stringify({ stop_hook_active: false, session_id: 'abc123' }),
  );
  assert.equal(r.status, 0);

  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.equal(typeof out.reason, 'string');
  assert.match(out.reason, /recordSession/);
  assert.match(out.reason, /recordDecision/);
  assert.match(out.reason, /recordLearning/);
  assert.match(out.reason, /caveats/);
  assert.match(out.reason, /graphRefs/);
  assert.equal(out.suppressOutput, true, 'suppressOutput keeps the raw JSON off the user transcript');
});

test('session-capture: stop_hook_active absent (missing field) behaves as a normal stop', () => {
  const r = runHook(SESSION_CAPTURE, JSON.stringify({ session_id: 'no-flag' }));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
});

test('session-capture: malformed JSON stdin -> degrades safely, exit 0, no throw', () => {
  const r = runHook(SESSION_CAPTURE, '{ not valid json ][');
  assert.equal(r.status, 0);
  assert.equal((r.stdout || '').trim(), '');
});

test('session-capture: empty stdin -> exit 0, no throw', () => {
  const r = runHook(SESSION_CAPTURE, '');
  assert.equal(r.status, 0);
});

test('session-capture: non-object JSON (e.g. a bare number) -> exit 0, no throw', () => {
  const r = runHook(SESSION_CAPTURE, '42');
  assert.equal(r.status, 0);
  assert.equal((r.stdout || '').trim(), '');
});

// ---------------------------------------------------------------------------
// codebase-pkg-mcp-first.cjs (PreToolUse Read hook)
// ---------------------------------------------------------------------------

test('mcp-first: first Read in a fresh session -> allow + additionalContext, marker file written', () => {
  const sessionId = `test-${crypto.randomUUID()}`;
  const marker = markerPathFor(sessionId);
  assert.ok(!fs.existsSync(marker), 'precondition: no stale marker for this fresh session id');

  try {
    const r = runHook(
      MCP_FIRST,
      JSON.stringify({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: '/x/y.ts' } }),
    );
    assert.equal(r.status, 0);

    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(out.hookSpecificOutput.additionalContext, /recallSimilar/);
    assert.match(out.hookSpecificOutput.additionalContext, /searchSemantic/);
    assert.equal(out.suppressOutput, true, 'suppressOutput keeps the raw JSON off the user transcript');

    assert.ok(fs.existsSync(marker), 'marker file created after first Read');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('mcp-first: second Read in the SAME session -> silent no-op (already reminded)', () => {
  const sessionId = `test-${crypto.randomUUID()}`;
  const marker = markerPathFor(sessionId);

  try {
    const first = runHook(
      MCP_FIRST,
      JSON.stringify({ session_id: sessionId, tool_name: 'Read', tool_input: {} }),
    );
    assert.equal(first.status, 0);
    assert.ok(JSON.parse(first.stdout).hookSpecificOutput, 'first call reminds');

    const second = runHook(
      MCP_FIRST,
      JSON.stringify({ session_id: sessionId, tool_name: 'Read', tool_input: {} }),
    );
    assert.equal(second.status, 0);
    assert.equal((second.stdout || '').trim(), '', 'second Read in the same session is silent');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('mcp-first: malformed JSON stdin -> degrades safely, exit 0, no throw', () => {
  const r = runHook(MCP_FIRST, 'not json at all {{{');
  assert.equal(r.status, 0);
  assert.equal((r.stdout || '').trim(), '');
});

test('mcp-first: empty stdin -> exit 0, no throw', () => {
  const r = runHook(MCP_FIRST, '');
  assert.equal(r.status, 0);
});

test('mcp-first: missing session_id falls back to a stable "unknown-session" marker key', () => {
  const marker = markerPathFor('unknown-session');
  fs.rmSync(marker, { force: true });
  try {
    const r = runHook(MCP_FIRST, JSON.stringify({ tool_name: 'Read', tool_input: {} }));
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(marker), 'falls back to a stable marker key when session_id is absent');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});
