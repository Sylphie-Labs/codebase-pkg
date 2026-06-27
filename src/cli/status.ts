/**
 * status.ts -- `codebase-pkg status` command.
 *
 * Reads `.codebase-pkg/state.json`, hashes each managed file currently on
 * disk, and reports drift between installed-time and now. Exits 0 even when
 * drift is detected (drift is informational, not an error).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectDrift, getManagedFiles, readState, type DriftStatus } from '../upgrade/state.js';
import { resolveRoot } from './resolve-root.js';

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function formatDuration(fromIso: string): string {
  const then = new Date(fromIso).getTime();
  const ms = Date.now() - then;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function statusGlyph(d: DriftStatus): string {
  switch (d) {
    case 'unchanged': return '✓';
    case 'modified':  return '⚠';
    case 'missing':   return '✗';
    case 'unknown':   return '?';
  }
}

function statusLabel(d: DriftStatus): string {
  switch (d) {
    case 'unchanged': return 'unchanged';
    case 'modified':  return 'modified since install';
    case 'missing':   return 'missing on disk';
    case 'unknown':   return 'unknown';
  }
}

export async function runStatus(args: string[]): Promise<number> {
  const cwd = resolveRoot(args);
  const state = readState(cwd);

  if (!state) {
    process.stdout.write(`codebase-pkg: not initialized in this repo.\n`);
    process.stdout.write(`Run 'codebase-pkg init' to set up.\n`);
    return 0;
  }

  const currentVersion = readPackageVersion();
  const versionMatch = state.version === currentVersion;

  process.stdout.write(
    `codebase-pkg ${state.version} (${state.installMode}${versionMatch ? '' : `, CLI is ${currentVersion}`})\n`,
  );
  process.stdout.write(`Installed:    ${state.installedAt}  (${formatDuration(state.installedAt)})\n`);
  process.stdout.write(`Last upgrade: ${state.lastUpgradedAt}  (${formatDuration(state.lastUpgradedAt)})\n`);
  process.stdout.write(`Install root: ${state.root ?? cwd}\n`);

  if (!versionMatch) {
    process.stdout.write(
      `\nVersion mismatch: ${state.version} installed -> ${currentVersion} available.\n` +
        `Run 'codebase-pkg upgrade --plan' to see what would change.\n`,
    );
  }

  const managedFiles = getManagedFiles(state).files;
  process.stdout.write(`\nManaged files (${managedFiles.length}):\n`);
  const driftCounts: Record<DriftStatus, number> = {
    unchanged: 0, modified: 0, missing: 0, unknown: 0,
  };
  for (const f of managedFiles) {
    const d = detectDrift(cwd, f);
    driftCounts[d]++;
    process.stdout.write(`  ${statusGlyph(d)} ${f.path.padEnd(60)} ${statusLabel(d)}\n`);
  }

  if (driftCounts.modified > 0 || driftCounts.missing > 0) {
    process.stdout.write(
      `\nDrift summary: ${driftCounts.modified} modified, ${driftCounts.missing} missing, ${driftCounts.unchanged} unchanged.\n` +
        `'upgrade' skips drifted files by default; pass --force to overwrite (creates .bak).\n`,
    );
  }

  return 0;
}
