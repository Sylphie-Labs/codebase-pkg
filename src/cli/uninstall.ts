/**
 * uninstall.ts -- `codebase-pkg uninstall` command.
 *
 * Removes every file recorded in `.codebase-pkg/state.json` from the
 * consumer's repo, then removes the state file itself. Modified files
 * (drift detected) are renamed to `<path>.bak.<timestamp>` rather than
 * deleted so the user doesn't lose customizations.
 *
 * Requires `--confirm` (per the project's upgrade UX rule that any state
 * change involves an explicit user opt-in).
 */

import * as fs from 'fs';
import * as path from 'path';
import { detectDrift, getManagedFiles, readState, removeState } from '../upgrade/state.js';
import { resolveRoot } from './resolve-root.js';

type Flags = {
  dryRun: boolean;
  confirm: boolean;
  force: boolean;
};

function parseFlags(args: string[]): Flags {
  return {
    dryRun: args.includes('--dry-run'),
    confirm: args.includes('--confirm') || args.includes('--yes'),
    force: args.includes('--force'),
  };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export async function runUninstall(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const cwd = resolveRoot(args);
  const state = readState(cwd);

  if (!state) {
    process.stdout.write(`codebase-pkg: not initialized in this repo. Nothing to uninstall.\n`);
    return 0;
  }

  // If the state records the install root and it differs from the root we just
  // resolved, warn (but proceed) -- the user may be tearing down a copy whose
  // recorded root no longer matches where it now lives.
  if (state.root && path.resolve(state.root) !== cwd) {
    process.stdout.write(
      `[uninstall] note: resolved root ${cwd} differs from recorded install root ${state.root}\n`,
    );
  }

  process.stdout.write(`codebase-pkg uninstall — plan:\n\n`);
  const ts = timestamp();
  const plan: Array<{ rel: string; action: 'delete' | 'backup-and-delete' | 'skip-missing' }> = [];

  // Old/partial/hand-edited state files may lack `managedFiles` or contain
  // malformed entries; normalize so we never crash on iteration and never
  // silently lose a malformed entry.
  const { files: managedFiles, malformed } = getManagedFiles(state);
  if (malformed > 0) {
    process.stdout.write(
      `  (skipped ${malformed} malformed managedFiles ` +
        `${malformed === 1 ? 'entry' : 'entries'} in state.json)\n`,
    );
  }

  for (const f of managedFiles) {
    const drift = detectDrift(cwd, f);
    if (drift === 'missing' || drift === 'unknown') {
      plan.push({ rel: f.path, action: 'skip-missing' });
    } else if (drift === 'modified' && !flags.force) {
      plan.push({ rel: f.path, action: 'backup-and-delete' });
    } else {
      plan.push({ rel: f.path, action: 'delete' });
    }
  }

  for (const step of plan) {
    const label =
      step.action === 'delete'
        ? 'delete'
        : step.action === 'backup-and-delete'
          ? `back up to ${step.rel}.bak.${ts}, then delete`
          : 'skip (missing)';
    process.stdout.write(`  - ${step.rel.padEnd(60)} ${label}\n`);
  }
  process.stdout.write(`  - .codebase-pkg/state.json                                       delete\n`);

  if (flags.dryRun) {
    process.stdout.write(`\n[uninstall] dry-run — no changes made.\n`);
    return 0;
  }

  if (!flags.confirm) {
    process.stdout.write(
      `\nUninstall will remove the files above. Re-run with --confirm to proceed.\n` +
        `(Modified files are backed up to .bak.<timestamp> first unless --force is also passed.)\n`,
    );
    return 0;
  }

  let deleted = 0;
  let backedUp = 0;
  let skipped = 0;

  for (const step of plan) {
    const abs = path.join(cwd, step.rel);
    if (step.action === 'skip-missing') { skipped++; continue; }
    try {
      if (step.action === 'backup-and-delete') {
        const backup = `${abs}.bak.${ts}`;
        fs.renameSync(abs, backup);
        backedUp++;
        continue;
      }
      fs.unlinkSync(abs);
      deleted++;
    } catch (err) {
      process.stderr.write(
        `[uninstall] failed to remove ${step.rel}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  removeState(cwd);

  process.stdout.write(
    `\n[uninstall] Done. ${deleted} deleted, ${backedUp} backed up, ${skipped} skipped.\n` +
      `State file removed.\n`,
  );

  return 0;
}
