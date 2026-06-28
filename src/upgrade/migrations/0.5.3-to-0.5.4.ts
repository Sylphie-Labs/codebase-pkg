/**
 * 0.5.3-to-0.5.4.ts -- No-op version bump from 0.5.3 to 0.5.4.
 *
 * 0.5.4 is an internal bug-fix release: the `getWatchedPackages` auto-detect
 * coverage is broadened in the package's own sync logic
 * (src/sync/import-resolver.ts and src/sync/git-diff.ts) so that package roots
 * that were previously missed -- root-level `src` dirs (e.g. a top-level
 * `frontend/src`) and src-less/Python packages -- are now picked up. This
 * touches only internal package logic compiled to dist/; no code behavior in a
 * consumer's repo, no template/ files, and no init-copied managed files change.
 *
 * This migration exists so the runner can bridge 0.5.3 -> 0.5.4 without a
 * blocker.
 */

import { getManagedFiles } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration: Migration = {
  from: '0.5.3',
  to: '0.5.4',
  severity: 'patch',
  description:
    'Internal auto-detect coverage fix (root-level src dirs + src-less/Python packages); no managed-file changes',
  notes:
    'No files in your repo are touched by this migration. 0.5.4 only broadens ' +
    'the package\'s internal auto-detect so more package roots are recognized. ' +
    'To benefit from the wider coverage, RE-SEED the graph: the newly detected ' +
    'roots (e.g. a root-level frontend/src and src-less Python services) are ' +
    'picked up at seed time, not by this upgrade.',
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
