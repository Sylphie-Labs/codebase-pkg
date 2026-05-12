#!/usr/bin/env node
/**
 * codebase-pkg CLI dispatcher.
 *
 * Subcommands:
 *   setup            Install skill templates, patch .mcp.json, write constraints.json.
 *   seed             Run a full initial seed of the graph from the current repo state.
 *   sync             Incremental sync since the last .last-sync-commit.
 *   validate         Run integrity checks against the current graph.
 *   backfill-changes Populate Change nodes from git history.
 *   add-constraint   Interactive CLI to add an architectural constraint.
 *
 * Usage:
 *   npx codebase-pkg <subcommand> [args]
 */

import { closeDriver } from '../mcp-server/neo4j-client.js';

function printUsage(): void {
  process.stdout.write(
    `Usage:\n` +
      `  codebase-pkg setup              Install skill templates and patch .mcp.json\n` +
      `  codebase-pkg seed               Initial full graph build\n` +
      `  codebase-pkg sync               Incremental sync since last commit\n` +
      `  codebase-pkg validate           Run integrity checks\n` +
      `  codebase-pkg backfill-changes   Populate Change nodes from git history\n` +
      `  codebase-pkg add-constraint     Add an architectural constraint\n` +
      `  codebase-pkg --version          Print package version\n` +
      `  codebase-pkg --help             Print this message\n`,
  );
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    return 0;
  }

  if (cmd === '--version' || cmd === '-v') {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  try {
    switch (cmd) {
      case 'setup': {
        const { runSetup } = await import('./setup.js');
        return await runSetup(rest);
      }

      case 'seed': {
        const { runSeed } = await import('../ingestion/initial-seed.js');
        await runSeed();
        return 0;
      }

      case 'sync': {
        const { runSync } = await import('../sync/sync-pipeline.js');
        await runSync();
        return 0;
      }

      case 'validate': {
        const { runIntegrityChecks } = await import('../sync/integrity-checker.js');
        const result = await runIntegrityChecks();
        return result.passed ? 0 : 1;
      }

      case 'backfill-changes': {
        const { runBackfillChanges } = await import('../ingestion/backfill-changes.js');
        await runBackfillChanges();
        return 0;
      }

      case 'add-constraint': {
        const { runAddConstraints } = await import('../ingestion/manual-constraints.js');
        // Parse trivial flag pair from the remaining args: --file PATH [--validate]
        const fileIdx = rest.indexOf('--file');
        const filePath =
          fileIdx >= 0 && rest[fileIdx + 1]
            ? rest[fileIdx + 1]
            : 'constraints.json';
        const validateOnly = rest.includes('--validate');
        await runAddConstraints({ filePath, validateOnly });
        return 0;
      }

      default:
        process.stderr.write(`codebase-pkg: unknown subcommand '${cmd}'\n\n`);
        printUsage();
        return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`codebase-pkg: ${cmd} failed — ${msg}\n`);
    return 1;
  } finally {
    await closeDriver().catch(() => {
      // best-effort close
    });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`codebase-pkg: fatal — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
