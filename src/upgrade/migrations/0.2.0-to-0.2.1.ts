/**
 * 0.2.0-to-0.2.1.ts -- No-op version bump from 0.2.0 to 0.2.1.
 *
 * 0.2.1 is a patch release of MCP tool correctness fixes (getDataFlow direction,
 * getConstraints/searchContent/getFunctionDetail), deleted-file graph cleanup, and
 * a global .mcp.json fix. It changes no managed files: the skills templates,
 * constraints.example.json, and every other init-copied artifact are unchanged.
 * This migration exists so the runner can bridge 0.2.0 -> 0.2.1 without a blocker.
 */

import { getManagedFiles } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration: Migration = {
  from: '0.2.0',
  to: '0.2.1',
  severity: 'patch',
  description:
    'MCP tool correctness fixes (getDataFlow direction, getConstraints/searchContent/getFunctionDetail), ' +
    'deleted-file cleanup, and global .mcp.json fix; no managed-file changes',
  notes:
    'No files in your repo are touched by this migration. These are runtime fixes ' +
    'in the MCP server and CLI; they take effect once the upgraded package is ' +
    'installed. Re-run init in global mode if your .mcp.json was written by 0.2.0 ' +
    'and the MCP server failed to start.',
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
