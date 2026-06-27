/**
 * 0.5.1-to-0.5.2.ts -- No-op version bump from 0.5.1 to 0.5.2.
 *
 * 0.5.2 migrates the conformity embedding backend from the legacy
 * `@xenova/transformers` (v2) to the maintained successor
 * `@huggingface/transformers` (v4) to cut supply-chain "unmaintained/legacy"
 * dependency flags. The model id (`jinaai/jina-embeddings-v2-base-code`) and the
 * 768-dim output are unchanged. This lives in the package's own dependency tree
 * and CLI — it changes no init-copied managed files.
 *
 * This migration exists so the runner can bridge 0.5.1 -> 0.5.2 without a
 * blocker.
 *
 * Recommended (not required) after upgrading: re-run `codebase-pkg
 * conformity-backfill` so the conformity pool is rebuilt uniformly with the new
 * backend's vectors.
 */

import { getManagedFiles } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration: Migration = {
  from: '0.5.1',
  to: '0.5.2',
  severity: 'patch',
  description:
    'Embedding backend migrated to @huggingface/transformers (supply-chain hygiene); ' +
    'no managed-file changes',
  notes:
    'No files in your repo are touched by this migration. The embedding backend ' +
    'change takes effect once the upgraded package is installed. The model and ' +
    '768-dim output are unchanged; to rebuild the conformity pool uniformly with ' +
    'the new backend, optionally re-run `codebase-pkg conformity-backfill`.',
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
