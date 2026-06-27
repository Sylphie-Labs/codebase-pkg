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
import { closePgPool } from '../conformity/pg-client.js';

function printUsage(): void {
  process.stdout.write(
    `Usage:\n` +
      `\n` +
      `Setup & lifecycle:\n` +
      `  codebase-pkg init [--local] [--docker] [--no-model]   One-time setup in this repo\n` +
      `  codebase-pkg upgrade [--plan] [--confirm] [--force]  Bring repo's config to current version\n` +
      `  codebase-pkg status                       Show install state and drift\n` +
      `  codebase-pkg doctor [--no-network]        Run structural checks\n` +
      `  codebase-pkg uninstall --confirm          Remove managed files and state\n` +
      `\n` +
      `Graph operations:\n` +
      `  codebase-pkg seed               Initial full graph build\n` +
      `  codebase-pkg sync               Incremental sync since last commit\n` +
      `  codebase-pkg validate           Run integrity checks\n` +
      `  codebase-pkg backfill-changes   Populate Change nodes from git history\n` +
      `  codebase-pkg conformity-backfill  Build the conformity descriptive pool\n` +
      `  codebase-pkg conformity-calibrate Recompute outlier thresholds (no re-embed)\n` +
      `  codebase-pkg conformity-judge [file]  Judge working-tree code against the pool\n` +
      `  codebase-pkg conformity-target [--init] [--force]  Show the effective decision target + migration (or seed conformity-target.json)\n` +
      `  codebase-pkg add-constraint     Add an architectural constraint\n` +
      `\n` +
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
      case 'init': {
        const { runInit } = await import('./init.js');
        return await runInit(rest);
      }

      case 'setup': {
        // Deprecated alias for init. Kept for back-compat through the 0.x cycle.
        process.stderr.write(
          `[codebase-pkg] 'setup' is a deprecated alias; use 'init' instead.\n`,
        );
        const { runInit } = await import('./init.js');
        return await runInit(rest);
      }

      case 'status': {
        const { runStatus } = await import('./status.js');
        return await runStatus(rest);
      }

      case 'uninstall': {
        const { runUninstall } = await import('./uninstall.js');
        return await runUninstall(rest);
      }

      case 'upgrade': {
        const { runUpgrade } = await import('./upgrade.js');
        return await runUpgrade(rest);
      }

      case 'doctor': {
        const { runDoctor } = await import('./doctor.js');
        return await runDoctor(rest);
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

      case 'mcp-server': {
        // Back-compat: the canonical entry point is the `codebase-pkg-mcp` bin
        // (dist/mcp-server/index.js). Older .mcp.json stanzas invoked
        // `codebase-pkg mcp-server`; keep that working by booting the server here.
        await import('../mcp-server/index.js');
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

      case 'conformity-backfill': {
        const { runConformityBackfill } = await import('../conformity/conformity-backfill.js');
        await runConformityBackfill();
        return 0;
      }

      case 'conformity-calibrate': {
        const { runConformityCalibrate } = await import('../conformity/conformity-backfill.js');
        await runConformityCalibrate();
        return 0;
      }

      case 'conformity-judge': {
        const { runConformityJudge } = await import('../conformity/judge-cli.js');
        // First non-flag positional arg is an optional file path.
        const filePath = rest.find((a) => !a.startsWith('-'));
        return await runConformityJudge(filePath);
      }

      case 'conformity-target': {
        const { runConformityTarget } = await import('../conformity/decisions/target-cli.js');
        // The CLI `finally` closes the pg pool, so let the command rely on that.
        await runConformityTarget({
          init: rest.includes('--init'),
          force: rest.includes('--force'),
          closePool: false,
        });
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
    await closePgPool().catch(() => {
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
