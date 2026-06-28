/**
 * 0.5.2-to-0.5.3.ts -- No-op version bump from 0.5.2 to 0.5.3.
 *
 * 0.5.3 is a documentation-only release: the README is corrected (the
 * `getFunctionDetail` MCP tool parameter is `functionName`, not `name`), the
 * previously-undocumented `/classify-pkg-domains` and `/sync-pkg` skills and the
 * `CODEBASE_PKG_EXCLUDE_DIRS` / `CODEBASE_PKG_CURSOR_FILE` env vars are now
 * documented. No code behavior and no init-copied managed files change.
 *
 * This migration exists so the runner can bridge 0.5.2 -> 0.5.3 without a
 * blocker.
 */

import { getManagedFiles } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration: Migration = {
  from: '0.5.2',
  to: '0.5.3',
  severity: 'patch',
  description: 'Documentation-only release (README corrections); no managed-file changes',
  notes:
    'No files in your repo are touched by this migration. 0.5.3 only corrects ' +
    'and expands the package README; there is nothing to apply locally.',
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
