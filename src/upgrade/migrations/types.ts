/**
 * types.ts -- Migration interface contract.
 *
 * Every migration is a self-contained module that knows how to take a repo
 * from one specific version to one specific next version. The runner walks
 * the registered migrations in order from state.version to pkg.version.
 */

import type { InstallState, ManagedFile } from '../state.js';

export type MigrationSeverity = 'patch' | 'minor' | 'major';

export interface MigrationContext {
  /** Absolute path to the consumer's repo root. */
  cwd: string;
  /** Install state read from .codebase-pkg/state.json before any migration runs. */
  state: InstallState;
  /** True for `upgrade --plan` runs; migrations should compute changes but not write them. */
  dryRun: boolean;
  /** True when the user passed `--force`; migrations should overwrite drifted files (with .bak). */
  force: boolean;
  /** Absolute path to the package root (where dist/ lives). Useful for resolving bundled templates. */
  packageRoot: string;
}

export interface MigrationResult {
  /** Updated managedFiles list reflecting any added/removed/rehashed files. */
  managedFiles: ManagedFile[];
  /** Files this migration touched (relative paths). For reporting. */
  changedFiles: string[];
  /** Soft warnings — drift skips, missing optional artifacts, etc. */
  warnings: string[];
}

export interface Migration {
  /** Exact version we're starting from, e.g. "0.1.0". */
  from: string;
  /** Exact version we're going to, e.g. "0.2.0". */
  to: string;
  /** Used by the CLI to color the plan output. */
  severity: MigrationSeverity;
  /** One-line description shown in the upgrade plan. */
  description: string;
  /** Optional longer notes shown when the user passes --verbose. */
  notes?: string;
  /** Apply the migration. Should be idempotent on re-run. */
  apply(ctx: MigrationContext): Promise<MigrationResult>;
}
