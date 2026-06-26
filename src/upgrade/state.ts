/**
 * state.ts -- Read/write the per-repo install state file at
 * `.codebase-pkg/state.json`.
 *
 * The state file is the source of truth for which files this package owns
 * in the consumer's repo, which version installed them, and what their
 * SHA-256 hashes were at install time. `upgrade`, `status`, and `uninstall`
 * all read from it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const STATE_DIR = '.codebase-pkg';
export const STATE_FILE = 'state.json';

export type InstallMode = 'global' | 'local';

export interface ManagedFile {
  /** Path relative to the consumer's repo root, forward slashes. */
  path: string;
  /** SHA-256 (hex) of the file as we wrote it. Empty string if the file was deleted intentionally. */
  installedHash: string;
}

export interface InstallState {
  /** Package version that produced these artifacts. */
  version: string;
  /** ISO timestamp of the original `init`. */
  installedAt: string;
  /** ISO timestamp of the most recent successful upgrade or re-init. */
  lastUpgradedAt: string;
  /** Whether the user installed the package globally or locally. */
  installMode: InstallMode;
  /** Absolute path to the dist/cli/codebase-pkg.js the init was run from. */
  cliPathAtInstall: string;
  /** Files this package manages in the consumer's repo. */
  managedFiles: ManagedFile[];
  /**
   * Per-instance Neo4j settings chosen at `init --docker` time. Optional so
   * state files written before this field existed remain valid.
   */
  neo4j?: {
    uri: string;
    containerName: string;
    httpPort: number;
    boltPort: number;
    slug: string;
  };
  /**
   * Per-instance Postgres (pgvector) settings chosen at `init --docker` time.
   * Optional and additive: state files written before this field existed remain
   * valid, and resolvePgConfig falls back to the default DSN when it is absent.
   * `uri` is a full DSN of the form
   * `postgres://codebase-pkg:codebase-pkg-local@localhost:<port>/codebase_pkg`.
   */
  postgres?: {
    uri: string;
    containerName: string;
    port: number;
    slug: string;
  };
}

export function statePath(cwd: string): string {
  return path.join(cwd, STATE_DIR, STATE_FILE);
}

export function readState(cwd: string): InstallState | null {
  const p = statePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as InstallState;
  } catch {
    return null;
  }
}

export function writeState(cwd: string, state: InstallState): void {
  const p = statePath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function removeState(cwd: string): void {
  const p = statePath(cwd);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  // Best-effort: remove the dir if empty.
  const dir = path.dirname(p);
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // ignore
  }
}

export function hashFile(absPath: string): string {
  if (!fs.existsSync(absPath)) return '';
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export type DriftStatus = 'unchanged' | 'modified' | 'missing' | 'unknown';

export function detectDrift(cwd: string, file: ManagedFile): DriftStatus {
  const abs = path.join(cwd, file.path);
  if (!fs.existsSync(abs)) return file.installedHash ? 'missing' : 'unknown';
  const current = hashFile(abs);
  if (current === file.installedHash) return 'unchanged';
  return 'modified';
}
