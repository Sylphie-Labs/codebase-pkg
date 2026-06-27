/**
 * 0.5.0-to-0.5.1.ts -- No-op version bump from 0.5.0 to 0.5.1.
 *
 * 0.5.1 adds the `reset` data-teardown command, a location configuration
 * (`--path`/`--root`/`CODEBASE_PKG_ROOT` plus `reset --neo4j-uri`/`--pg-uri`)
 * honored across the lifecycle commands, and backwards-compatibility hardening
 * for old/partial `state.json` files. All of this lives in the CLI — it changes
 * no init-copied managed files: the skills templates, constraints.example.json,
 * and every other artifact are unchanged.
 *
 * This migration exists so the runner can bridge 0.5.0 -> 0.5.1 without a
 * blocker.
 */

import { getManagedFiles } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration: Migration = {
  from: '0.5.0',
  to: '0.5.1',
  severity: 'patch',
  description:
    'reset data-teardown command, location config (--path/--root, reset --neo4j-uri/--pg-uri), ' +
    'and state.json back-compat hardening; no managed-file changes',
  notes:
    'No files in your repo are touched by this migration. These are CLI additions ' +
    'that take effect once the upgraded package is installed.',
  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    // Nothing to write — the version bump itself is handled by the runner
    // advancing the state cursor.
    return {
      managedFiles: getManagedFiles(ctx.state).files,
      changedFiles: [],
      warnings: [],
    };
  },
};

export default migration;
