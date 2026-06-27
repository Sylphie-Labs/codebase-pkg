/**
 * resolve-root.ts -- Shared resolver for the filesystem ROOT a location-aware
 * command operates on.
 *
 * Every location-aware command (init, uninstall, reset, status, doctor, upgrade)
 * historically hardcoded `process.cwd()`. This helper centralizes WHERE install
 * and teardown happen so a user can point a command at a directory other than
 * the current one.
 *
 * Precedence (highest first):
 *   1. `--path <dir>` / `--path=<dir>` flag (alias: `--root <dir>` / `--root=<dir>`)
 *   2. `env.CODEBASE_PKG_ROOT`
 *   3. `process.cwd()` (the historical default; preserves all existing behavior
 *      when no flag/env is supplied)
 *
 * The returned path is always ABSOLUTE and normalized via `path.resolve`.
 */

import * as path from 'path';

/** Flag names (and their `=` forms) that select the root directory. */
const ROOT_FLAGS = ['--path', '--root'] as const;

/**
 * Extract a `--path`/`--root` value from `args`, supporting both the
 * space-separated (`--path <dir>`) and `=` (`--path=<dir>`) forms. Returns the
 * last-specified value (so a later flag wins), or `undefined` when absent.
 */
function flagValue(args: string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const flag of ROOT_FLAGS) {
      if (a === flag) {
        // Space form: the next arg is the value (if present).
        const next = args[i + 1];
        if (next !== undefined) found = next;
      } else if (a.startsWith(flag + '=')) {
        // `=` form: everything after the first `=`.
        found = a.slice(flag.length + 1);
      }
    }
  }
  return found;
}

/**
 * Resolve the effective ROOT directory for a location-aware command.
 *
 * @param args - The command's argv tail (flags + positionals).
 * @param env  - Environment to read `CODEBASE_PKG_ROOT` from (injectable for tests).
 * @returns An absolute, normalized directory path.
 */
export function resolveRoot(args: string[], env = process.env): string {
  const fromFlag = flagValue(args);
  const chosen = fromFlag ?? env.CODEBASE_PKG_ROOT ?? process.cwd();
  return path.resolve(chosen);
}
