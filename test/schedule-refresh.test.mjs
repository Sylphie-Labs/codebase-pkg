/**
 * Tests for `schedule-refresh` (dist/cli/schedule-refresh.js).
 *
 * Actually invoking schtasks.exe is a real, machine-wide side effect (it
 * registers a Windows Task Scheduler job) that must never happen as a side
 * effect of running the test suite. So:
 *   - the pure builders (parseScheduleFlags / buildTaskName /
 *     buildRegisterCommand / buildUnregisterCommand / renderCommand) are
 *     tested directly with plain assertions, and
 *   - runScheduleRefresh is tested with an INJECTED `exec` stub (never the
 *     real schtasks.exe) plus an injected `platform`, so the orchestration
 *     (which command it builds and runs, exit code on failure, platform gate)
 *     is verified without touching the real OS scheduler.
 *
 * Run after `npm run build`:
 *   node --test test/schedule-refresh.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseScheduleFlags,
  buildTaskName,
  buildRegisterCommand,
  buildUnregisterCommand,
  renderCommand,
  runScheduleRefresh,
} from '../dist/cli/schedule-refresh.js';

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-schedule-'));
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

// ---------------------------------------------------------------------------
// parseScheduleFlags
// ---------------------------------------------------------------------------

test('parseScheduleFlags: no flags -> default time 03:00, unregister false', () => {
  const flags = parseScheduleFlags([]);
  assert.equal(flags.time, '03:00');
  assert.equal(flags.unregister, false);
});

test('parseScheduleFlags: --time <HH:MM> (space form)', () => {
  assert.equal(parseScheduleFlags(['--time', '22:30']).time, '22:30');
});

test('parseScheduleFlags: --time=<HH:MM> (equals form)', () => {
  assert.equal(parseScheduleFlags(['--time=07:05']).time, '07:05');
});

test('parseScheduleFlags: --unregister sets the flag', () => {
  assert.equal(parseScheduleFlags(['--unregister']).unregister, true);
});

test('parseScheduleFlags: rejects an invalid time (bad format)', () => {
  assert.throws(() => parseScheduleFlags(['--time', '9:5']), /invalid --time/);
});

test('parseScheduleFlags: rejects an out-of-range hour', () => {
  assert.throws(() => parseScheduleFlags(['--time', '25:00']), /invalid --time/);
});

test('parseScheduleFlags: rejects an out-of-range minute', () => {
  assert.throws(() => parseScheduleFlags(['--time', '10:75']), /invalid --time/);
});

test('parseScheduleFlags: accepts midnight and end-of-day edges', () => {
  assert.equal(parseScheduleFlags(['--time', '00:00']).time, '00:00');
  assert.equal(parseScheduleFlags(['--time', '23:59']).time, '23:59');
});

// ---------------------------------------------------------------------------
// buildTaskName
// ---------------------------------------------------------------------------

test('buildTaskName: stable and prefixed for the same cwd', () => {
  const repo = mkRepo();
  const a = buildTaskName(repo);
  const b = buildTaskName(repo);
  assert.equal(a, b, 'deterministic for the same path');
  assert.match(a, /^codebase-pkg-refresh-/);
});

test('buildTaskName: differs across distinct repo directories', () => {
  const a = buildTaskName(mkRepo());
  const b = buildTaskName(mkRepo());
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// buildRegisterCommand / buildUnregisterCommand / renderCommand
// ---------------------------------------------------------------------------

test('buildRegisterCommand: schtasks /Create with /TN, /TR (cd + claude), /SC DAILY, /ST, /F', () => {
  const spec = buildRegisterCommand({
    taskName: 'codebase-pkg-refresh-myrepo-ab12',
    time: '03:00',
    repoDir: 'C:/Users/x/repo',
  });
  assert.equal(spec.file, 'schtasks');
  assert.deepEqual(spec.args.slice(0, 3), ['/Create', '/TN', 'codebase-pkg-refresh-myrepo-ab12']);
  assert.equal(spec.args[3], '/TR');
  assert.match(spec.args[4], /cd \/d "C:\/Users\/x\/repo"/);
  assert.match(spec.args[4], /claude -p "\/refresh-pkg-graph" --model sonnet/);
  assert.ok(spec.args.includes('/SC'));
  assert.ok(spec.args.includes('DAILY'));
  assert.ok(spec.args.includes('/ST'));
  assert.ok(spec.args.includes('03:00'));
  assert.ok(spec.args.includes('/F'), '/F forces overwrite of an existing same-named task');
});

test('buildUnregisterCommand: schtasks /Delete /TN <name> /F', () => {
  const spec = buildUnregisterCommand('codebase-pkg-refresh-myrepo-ab12');
  assert.equal(spec.file, 'schtasks');
  assert.deepEqual(spec.args, ['/Delete', '/TN', 'codebase-pkg-refresh-myrepo-ab12', '/F']);
});

test('renderCommand: quotes args containing spaces', () => {
  const rendered = renderCommand({ file: 'schtasks', args: ['/TN', 'no-spaces', '/TR', 'has a space'] });
  assert.equal(rendered, 'schtasks /TN no-spaces /TR "has a space"');
});

// ---------------------------------------------------------------------------
// runScheduleRefresh orchestration (injected exec + platform -- NEVER the real schtasks.exe)
// ---------------------------------------------------------------------------

test('runScheduleRefresh: non-Windows platform -> exit 1, explains the manual alternative, never calls exec', async () => {
  let execCalled = false;
  const { result, text } = await captureOut(() =>
    runScheduleRefresh([], {
      platform: 'linux',
      exec: () => { execCalled = true; return { status: 0, stdout: '', stderr: '' }; },
    }),
  );
  assert.equal(result, 1);
  assert.equal(execCalled, false, 'exec must never be invoked on a non-Windows platform');
  assert.match(text, /Windows-only/);
  assert.match(text, /SCHEDULING\.md/);
});

test('runScheduleRefresh: register path calls exec with the built /Create command, exit 0 on success', async () => {
  const repo = mkRepo();
  let captured = null;
  const { result, text } = await captureOut(() =>
    runScheduleRefresh(['--time', '04:15', `--path=${repo}`], {
      platform: 'win32',
      exec: (file, args) => {
        captured = { file, args };
        return { status: 0, stdout: 'SUCCESS', stderr: '' };
      },
    }),
  );
  assert.equal(result, 0);
  assert.ok(captured, 'exec was invoked');
  assert.equal(captured.file, 'schtasks');
  assert.ok(captured.args.includes('/Create'));
  assert.ok(captured.args.includes('04:15'));
  assert.match(text, /registered task/);
});

test('runScheduleRefresh: --unregister calls exec with the built /Delete command, exit 0 on success', async () => {
  const repo = mkRepo();
  let captured = null;
  const { result, text } = await captureOut(() =>
    runScheduleRefresh(['--unregister', `--path=${repo}`], {
      platform: 'win32',
      exec: (file, args) => {
        captured = { file, args };
        return { status: 0, stdout: 'SUCCESS', stderr: '' };
      },
    }),
  );
  assert.equal(result, 0);
  assert.ok(captured.args.includes('/Delete'));
  assert.match(text, /unregistered task/);
});

test('runScheduleRefresh: exec failure (non-zero status) -> exit 1, surfaces stderr', async () => {
  const repo = mkRepo();
  const { result, text } = await captureOut(() =>
    runScheduleRefresh([`--path=${repo}`], {
      platform: 'win32',
      exec: () => ({ status: 1, stdout: '', stderr: 'ERROR: access denied' }),
    }),
  );
  assert.equal(result, 1);
  assert.match(text, /access denied/);
});

test('runScheduleRefresh: invalid --time is rejected before exec is ever called', async () => {
  const repo = mkRepo();
  let execCalled = false;
  const { result, text } = await captureOut(() =>
    runScheduleRefresh(['--time', 'nonsense', `--path=${repo}`], {
      platform: 'win32',
      exec: () => { execCalled = true; return { status: 0, stdout: '', stderr: '' }; },
    }),
  );
  assert.equal(result, 1);
  assert.equal(execCalled, false);
  assert.match(text, /invalid --time/);
});
