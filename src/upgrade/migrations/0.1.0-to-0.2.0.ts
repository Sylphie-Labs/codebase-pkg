/**
 * 0.1.0-to-0.2.0.ts -- No-op version bump from 0.1.0 to 0.2.0.
 *
 * 0.2.0 adds Python ingestion support and sync-graph fixes, but changes no
 * managed files: the skills templates are unchanged, and constraints.example.json
 * is only copied on first install — existing installs keep their constraints.json.
 * This migration exists so the runner can bridge 0.1.0 -> 0.2.0 without a blocker.
 */

import { getManagedFiles } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration: Migration = {
  from: '0.1.0',
  to: '0.2.0',
  severity: 'minor',
  description: 'Python ingestion support + sync-graph fixes; no managed-file changes',
  notes:
    'No files in your repo are touched by this migration. Python indexing is ' +
    'opt-in by file presence and requires a python3/python (3.9+) runtime on ' +
    'PATH; without one, .py files are skipped with a warning.',
  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    // Nothing to write, dry-run or not — the version bump itself is handled by
    // the runner advancing the state cursor.
    return {
      managedFiles: getManagedFiles(ctx.state).files,
      changedFiles: [],
      warnings: [],
    };
  },
};

export default migration;
