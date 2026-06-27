/**
 * 0.2.1-to-0.3.0.ts -- No-op version bump from 0.2.1 to 0.3.0.
 *
 * 0.3.0 adds dynamic per-instance Neo4j ports and slug-named container/volumes
 * for fresh `init --docker` runs. It changes no managed files: the skills
 * templates, constraints.example.json, and every other init-copied artifact are
 * unchanged for existing installs. This migration exists so the runner can
 * bridge 0.2.1 -> 0.3.0 without a blocker.
 */

import { getManagedFiles } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration: Migration = {
  from: '0.2.1',
  to: '0.3.0',
  severity: 'minor',
  description:
    'dynamic per-instance Neo4j ports + slug-named container/volumes; no managed-file changes',
  notes:
    'No files in your repo are touched by this migration. Existing repos keep ' +
    'working with their current fixed-port compose file and fixed container name. ' +
    'The new per-instance behavior (free host ports + a `codebase-pkg-neo4j-<slug>` ' +
    'container and slug-suffixed volumes) only applies to a fresh `init --docker`. ' +
    'To adopt it on this install, re-run `init --docker --force` and recreate the ' +
    'container; note the volume names change, so old graph data will not carry over ' +
    'automatically (re-seed after switching).',
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
