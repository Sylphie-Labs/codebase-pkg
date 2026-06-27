/**
 * upgrade.ts -- `codebase-pkg upgrade` command.
 *
 * Walks the migration graph from state.version to the currently-installed
 * package version. Two modes:
 *
 *   --plan       Show what would happen. No state changes.
 *   --confirm    Apply the migrations. Updates state.json.
 *
 * Without either flag, behaves as --plan (so it's safe by default).
 *
 * Drift handling: migrations operate on the consumer's repo. Any migration
 * that modifies a managed file checks drift via detectDrift; modified files
 * are skipped with a warning unless --force is passed (in which case the
 * existing file is backed up to .bak.<timestamp> before the migration
 * overwrites it).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readState, writeState } from '../upgrade/state.js';
import { applyAll, compareVersions, planMigrations } from '../upgrade/runner.js';
import { resolveRoot } from './resolve-root.js';

type Flags = {
  plan: boolean;
  confirm: boolean;
  force: boolean;
  verbose: boolean;
};

function parseFlags(args: string[]): Flags {
  return {
    plan: args.includes('--plan'),
    confirm: args.includes('--confirm') || args.includes('--yes'),
    force: args.includes('--force'),
    verbose: args.includes('--verbose'),
  };
}

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function getPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function severityBadge(s: 'patch' | 'minor' | 'major'): string {
  switch (s) {
    case 'patch': return '[PATCH]';
    case 'minor': return '[MINOR]';
    case 'major': return '[MAJOR]';
  }
}

export async function runUpgrade(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const cwd = resolveRoot(args);
  const state = readState(cwd);

  if (!state) {
    process.stderr.write(
      `codebase-pkg: not initialized in this repo. Run 'codebase-pkg init' first.\n`,
    );
    return 1;
  }

  const cliVersion = readPackageVersion();
  const plan = planMigrations(state.version, cliVersion);

  process.stdout.write(
    `codebase-pkg upgrade — ${state.version} -> ${cliVersion}\n`,
  );

  if (plan.blocker) {
    process.stderr.write(`\n[upgrade] cannot proceed: ${plan.blocker}\n`);
    return 1;
  }

  if (plan.migrations.length === 0) {
    process.stdout.write(`Already at ${cliVersion}. Nothing to do.\n`);
    return 0;
  }

  // Show plan first — always, per the design decision.
  process.stdout.write(`\nMigration plan (${plan.migrations.length}):\n`);
  for (const m of plan.migrations) {
    process.stdout.write(
      `  ${severityBadge(m.severity)} ${m.from} -> ${m.to}    ${m.description}\n`,
    );
    if (flags.verbose && m.notes) {
      for (const line of m.notes.split('\n')) {
        process.stdout.write(`         ${line}\n`);
      }
    }
  }

  if (compareVersions(state.version, '1.0.0') < 0 || plan.migrations.some((m) => m.severity === 'major')) {
    process.stdout.write(
      `\nNote: this upgrade includes ${plan.migrations.some((m) => m.severity === 'major') ? 'a MAJOR' : 'pre-1.0'} migration. ` +
        `Review the plan above carefully.\n`,
    );
  }

  if (flags.plan && !flags.confirm) {
    process.stdout.write(`\n[upgrade] plan-only run; pass --confirm to apply.\n`);
    return 0;
  }

  if (!flags.confirm) {
    process.stdout.write(
      `\nPass --confirm to apply these migrations.\n` +
        `Drifted files (modified since install) are skipped unless --force is also passed.\n`,
    );
    return 0;
  }

  // Apply
  process.stdout.write(`\n[upgrade] applying ${plan.migrations.length} migration(s)...\n\n`);

  const result = await applyAll({
    ctx: {
      cwd,
      dryRun: false,
      force: flags.force,
      packageRoot: getPackageRoot(),
      state,
    },
    plan,
  });

  for (const { migration, result: r } of result.results) {
    process.stdout.write(
      `  ${severityBadge(migration.severity)} ${migration.from} -> ${migration.to}: ` +
        `${r.changedFiles.length} file(s) changed, ${r.warnings.length} warning(s)\n`,
    );
    for (const w of r.warnings) {
      process.stdout.write(`         WARN: ${w}\n`);
    }
  }

  writeState(cwd, result.finalState);

  process.stdout.write(
    `\n[upgrade] Done. Applied ${result.appliedCount} migration(s). ` +
      `State now at ${result.finalState.version}.\n`,
  );

  return 0;
}
