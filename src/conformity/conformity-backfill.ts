/**
 * conformity-backfill.ts -- cold-start build of the Conformity Judge descriptive
 * pool over the existing committed codebase.
 *
 * Unlike the incremental sync hook (which only touches changed functions), this
 * parses ALL watched files in one pass and embeds every function's signature
 * skeleton into the cold store. Run it once after `init`/`seed` to populate the
 * pool the judge will later compare against.
 *
 * It is gated the same way the sync hook is: if Postgres is unreachable (or
 * `CODEBASE_PKG_CONFORMITY=off`) it exits cleanly with a single info line rather
 * than erroring. On completion it tears the pg pool down via closePgPool, the
 * way the Neo4j commands close the driver.
 *
 * Entry point: `codebase-pkg conformity-backfill`.
 */

import { getAllWatchedFiles } from '../sync/git-diff.js';
import { parseFiles, clearProjectCache } from '../sync/parser.js';
import { embedAndStoreFunctions } from './embed-functions.js';
import { isConformityEnabled } from './sync-hook.js';
import { ensureSchema } from './schema.js';
import { realPgRunner, closePgPool } from './pg-client.js';
import type { ParsedFunction } from '../sync/ast-parser.js';

/**
 * Build (or refresh) the conformity descriptive pool from every committed,
 * watched source file. Idempotent: upserts overwrite existing vectors keyed by
 * node id, so re-running re-embeds in place.
 *
 * Best-effort gate: returns quietly (one info line) when conformity is disabled
 * or Postgres is unreachable -- the cold-start should not hard-fail an
 * otherwise-healthy repo that hasn't provisioned Postgres yet.
 */
export async function runConformityBackfill(): Promise<void> {
  console.log('=== Codebase PKG — Conformity pool backfill ===');

  if (!(await isConformityEnabled(realPgRunner))) {
    const off = (process.env.CODEBASE_PKG_CONFORMITY ?? '').toLowerCase() === 'off';
    console.log(
      off
        ? '[conformity] Skipped — CODEBASE_PKG_CONFORMITY=off.'
        : '[conformity] Skipped — Postgres not configured/reachable.',
    );
    return;
  }

  // Make sure the cold-store table exists before we try to upsert into it.
  await ensureSchema(realPgRunner);

  console.log('Scanning watched files...');
  const files = getAllWatchedFiles();
  console.log(`Found ${files.length} watched file(s).`);

  const parsed = parseFiles(files);
  clearProjectCache();

  const functions: ParsedFunction[] = [];
  for (const f of parsed) functions.push(...f.functions);

  console.log(`Parsed ${parsed.length} file(s), ${functions.length} function(s).`);
  console.log('Embedding function signature skeletons (first run downloads the model)...');

  const { embedded, skipped } = await embedAndStoreFunctions(functions);

  console.log('');
  console.log('=== Conformity backfill complete ===');
  console.log(`  Functions embedded : ${embedded}`);
  console.log(`  Functions skipped  : ${skipped} (empty skeleton)`);
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runConformityBackfill()
    .catch((err) => {
      console.error(
        'Conformity backfill failed:',
        err instanceof Error ? err.message : String(err),
      );
      process.exitCode = 1;
    })
    .finally(() => {
      void closePgPool().catch(() => {
        // best-effort close
      });
    });
}
