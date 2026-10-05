/**
 * 0.5.4-to-0.6.0.ts -- No-op version bump from 0.5.4 to 0.6.0.
 *
 * 0.6.0 adds Rust (.rs) parsing: a tree-sitter (WASM) parser in
 * src/sync/rust-parser.ts / rust-parser-worker.ts, a bundled grammar under
 * grammars/, Rust-aware file filters, and crate::/self::/super:: import
 * resolution. This touches only internal package logic compiled to dist/ plus
 * the bundled grammar; no template/ files and no init-copied managed files
 * change.
 *
 * This migration exists so the runner can bridge 0.5.4 -> 0.6.0 without a
 * blocker.
 */

import { getManagedFiles } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration: Migration = {
  from: '0.5.4',
  to: '0.6.0',
  severity: 'minor',
  description:
    'Adds Rust (.rs) parsing support; no managed-file changes',
  notes:
    'No files in your repo are touched by this migration. 0.6.0 teaches the ' +
    'parser to read Rust source. To index existing Rust code, RE-SEED the ' +
    'graph: .rs files are picked up at seed time, not by this upgrade.',
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
