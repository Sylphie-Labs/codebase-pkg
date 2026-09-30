/**
 * schedule-refresh.ts -- `codebase-pkg schedule-refresh` command.
 *
 * Registers (or removes) a Windows Task Scheduler job that runs the
 * `/refresh-pkg-graph` skill daily, unattended, in this repo's directory:
 *
 *   claude -p "/refresh-pkg-graph" --model sonnet
 *
 * Windows-only (uses `schtasks.exe`). On any other platform this prints the
 * manual alternative (see docs/SCHEDULING.md) and exits non-zero rather than
 * silently doing nothing.
 *
 * The command/argument construction is split into pure, dependency-free
 * builder functions (buildTaskName / buildRegisterCommand /
 * buildUnregisterCommand) so they can be unit-tested without ever invoking
 * `schtasks.exe` -- actually registering a scheduled task is a real,
 * machine-wide side effect that must never happen as a side effect of running
 * the test suite. `runScheduleRefresh` takes an injectable `exec` (defaults to
 * a real `spawnSync('schtasks', ...)` call) precisely so tests can stub it out.
 */

import * as path from 'path';
import { spawnSync } from 'child_process';
import { deriveInstanceSlug } from './neo4j-config.js';
import { resolveRoot } from './resolve-root.js';

const DEFAULT_TIME = '03:00';
const TASK_PREFIX = 'codebase-pkg-refresh-';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ScheduleFlags {
  time: string;
  unregister: boolean;
}

/**
 * Parse `schedule-refresh` flags: `--time HH:MM` (also accepts `--time=HH:MM`)
 * and `--unregister`. Defaults `time` to {@link DEFAULT_TIME} when absent.
 * Throws with a clear message if `--time` is present but not valid 24-hour
 * `HH:MM`.
 */
export function parseScheduleFlags(args: string[]): ScheduleFlags {
  let time: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--time') {
      if (args[i + 1] !== undefined) time = args[i + 1];
    } else if (a.startsWith('--time=')) {
      time = a.slice('--time='.length);
    }
  }
  const resolved = time ?? DEFAULT_TIME;
  if (!TIME_RE.test(resolved)) {
    throw new Error(`invalid --time '${resolved}' -- expected 24-hour HH:MM, e.g. 03:00 or 22:30`);
  }
  return {
    time: resolved,
    unregister: args.includes('--unregister'),
  };
}

/** Deterministic Task Scheduler job name for the repo at `cwd` (stable across re-registration). */
export function buildTaskName(cwd: string): string {
  return `${TASK_PREFIX}${deriveInstanceSlug(cwd)}`;
}

export interface CommandSpec {
  file: string;
  args: string[];
}

/**
 * Build the `schtasks /Create` invocation that registers a DAILY task named
 * `taskName`, running at `time` (24-hour HH:MM), in `repoDir`.
 *
 * schtasks has no dedicated "start in" directory flag, so the working
 * directory is folded into the /TR (task-to-run) command itself via
 * `cmd /c cd /d "<repoDir>" && claude -p "/refresh-pkg-graph" --model sonnet`.
 * `/F` forces overwrite so re-running schedule-refresh with a new `--time`
 * updates the existing task rather than failing with "already exists".
 */
export function buildRegisterCommand(opts: {
  taskName: string;
  time: string;
  repoDir: string;
}): CommandSpec {
  const { taskName, time, repoDir } = opts;
  const tr =
    `cmd /c cd /d "${repoDir}" && claude -p "/refresh-pkg-graph" --model sonnet`;
  return {
    file: 'schtasks',
    args: ['/Create', '/TN', taskName, '/TR', tr, '/SC', 'DAILY', '/ST', time, '/F'],
  };
}

/** Build the `schtasks /Delete` invocation that removes `taskName` (force, no confirmation prompt). */
export function buildUnregisterCommand(taskName: string): CommandSpec {
  return {
    file: 'schtasks',
    args: ['/Delete', '/TN', taskName, '/F'],
  };
}

/** Render a CommandSpec the way a shell would show it, for the "here's what I ran" print. */
export function renderCommand(spec: CommandSpec): string {
  const quoted = spec.args.map((a) => (a.includes(' ') ? `"${a}"` : a));
  return [spec.file, ...quoted].join(' ');
}

/** Injectable process runner -- the default shells out to the real schtasks.exe. */
export type Exec = (file: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const realExec: Exec = (file, args) => {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

export interface ScheduleRefreshDeps {
  /** Overridable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Overridable for tests; defaults to a real `schtasks.exe` invocation. */
  exec?: Exec;
}

export async function runScheduleRefresh(
  args: string[],
  deps: ScheduleRefreshDeps = {},
): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? realExec;

  if (platform !== 'win32') {
    process.stderr.write(
      `[schedule-refresh] Windows-only (uses schtasks.exe); this platform is '${platform}'.\n` +
        `See docs/SCHEDULING.md for the manual/cross-platform alternative (a cron entry or CI schedule ` +
        `running: claude -p "/refresh-pkg-graph" --model sonnet).\n`,
    );
    return 1;
  }

  let flags: ScheduleFlags;
  try {
    flags = parseScheduleFlags(args);
  } catch (err) {
    process.stderr.write(`[schedule-refresh] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const cwd = resolveRoot(args);
  const taskName = buildTaskName(cwd);

  if (flags.unregister) {
    const spec = buildUnregisterCommand(taskName);
    process.stdout.write(`[schedule-refresh] running: ${renderCommand(spec)}\n`);
    const result = exec(spec.file, spec.args);
    if (result.status !== 0) {
      process.stderr.write(
        `[schedule-refresh] schtasks /Delete failed (exit ${result.status}): ${result.stderr.trim()}\n`,
      );
      return 1;
    }
    process.stdout.write(`[schedule-refresh] unregistered task '${taskName}'.\n`);
    return 0;
  }

  const repoDir = path.resolve(cwd);
  const spec = buildRegisterCommand({ taskName, time: flags.time, repoDir });
  process.stdout.write(`[schedule-refresh] running: ${renderCommand(spec)}\n`);
  const result = exec(spec.file, spec.args);
  if (result.status !== 0) {
    process.stderr.write(
      `[schedule-refresh] schtasks /Create failed (exit ${result.status}): ${result.stderr.trim()}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `[schedule-refresh] registered task '${taskName}' -- daily at ${flags.time}, in ${repoDir}.\n` +
      `Runs: claude -p "/refresh-pkg-graph" --model sonnet\n` +
      `Unregister with: codebase-pkg schedule-refresh --unregister\n`,
  );
  return 0;
}
