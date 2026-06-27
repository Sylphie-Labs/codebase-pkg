/**
 * 0.4.0-to-0.5.0.ts -- No-op version bump from 0.4.0 to 0.5.0.
 *
 * 0.5.0 shipped the conformity suite (decision/style conformity + embedding
 * novelty, the pgvector Postgres cold store, and the conformity-* CLI commands).
 * All of that lives in the CLI, the MCP server, and `init --docker`'s generated
 * compose/bootstrap — it changes no init-copied managed files: the skills
 * templates, constraints.example.json, and every other artifact are unchanged.
 *
 * This migration was omitted from the 0.5.0 release, which left existing 0.4.0
 * installs unable to `upgrade` past 0.4.0 (the runner reports "no migration from
 * 0.4.0"). It is backfilled here so the runner can bridge 0.4.0 -> 0.5.0 without
 * a blocker. To adopt the conformity Postgres service, re-run
 * `codebase-pkg init --docker --force` after upgrading.
 */

import { getManagedFiles } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration: Migration = {
  from: '0.4.0',
  to: '0.5.0',
  severity: 'minor',
  description:
    'Conformity suite (decision/style + embedding novelty, pgvector cold store, conformity-* commands); ' +
    'no managed-file changes',
  notes:
    'No files in your repo are touched by this migration. The conformity features ' +
    'take effect once the upgraded package is installed. To provision the ' +
    'pgvector Postgres service used by conformity, re-run ' +
    '`codebase-pkg init --docker --force` (volumes are additive; your Neo4j data ' +
    'is unaffected).',
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
