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
import { embedAndStoreChunks } from './embed-functions.js';
import { isConformityEnabled } from './sync-hook.js';
import { ensureSchema } from './schema.js';
import { realPgRunner, closePgPool } from './pg-client.js';
import { createConformityStore, type ConformityStore } from './store.js';
import { computeCalibration } from './calibration.js';
import { categoryOf, type ParsedChunk } from './category.js';
import { CHOSEN_MODEL, MODEL_CANDIDATES } from './embed.js';
import type { PoolEntry } from './judge.js';

/**
 * Compute per-category calibration over the committed pool and persist it (step
 * R2). Loads each category's vectors from the store (re-reads, so this works
 * both right after a backfill and as a standalone recompute), runs the pure
 * {@link computeCalibration}, and upserts the resulting thresholds stamped with
 * `model`. Logs the per-category threshold + sample size. Returns the number of
 * categories calibrated.
 */
async function calibrateFromStore(
  store: ConformityStore,
  categories: Iterable<string>,
  model: string,
): Promise<number> {
  const entries: PoolEntry[] = [];
  for (const category of new Set(categories)) {
    const pool = await store.loadPool(category);
    entries.push(...pool);
  }

  if (entries.length === 0) {
    console.log('[conformity] No vectors found — nothing to calibrate.');
    return 0;
  }

  const rows = computeCalibration(entries);
  await store.setCalibration(rows.map((r) => ({ ...r, model })));

  console.log('');
  console.log('Calibrated per-category outlier thresholds (95th pct of leave-one-out kNN distance):');
  for (const r of rows) {
    console.log(
      `  ${r.category}: threshold=${r.threshold.toFixed(6)} ` +
        `(samples=${r.sampleSize}, k=${r.k})`,
    );
  }
  return rows.length;
}

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

  // Embed BOTH functions AND types/classes. Each chunk derives its own category
  // (function:body / type:body) inside the shared core, so functions are judged
  // against functions and types against types.
  const chunks: ParsedChunk[] = [];
  let functionCount = 0;
  let typeCount = 0;
  for (const f of parsed) {
    chunks.push(...f.functions, ...f.types);
    functionCount += f.functions.length;
    typeCount += f.types.length;
  }

  console.log(
    `Parsed ${parsed.length} file(s), ${functionCount} function(s), ${typeCount} type(s).`,
  );
  console.log('Embedding function + type bodies (first run downloads the model)...');

  // Use an explicit store so we can reuse its hot cache for the calibration pass
  // that follows (no second round-trip per category beyond the loadPool reads).
  const store = createConformityStore(realPgRunner);
  const { embedded, skipped } = await embedAndStoreChunks(chunks, { store });

  console.log('');
  console.log('=== Conformity backfill complete ===');
  console.log(`  Chunks embedded : ${embedded} (functions + types)`);
  console.log(`  Chunks skipped  : ${skipped} (empty body)`);

  // Step R2: calibrate the outlier threshold on the codebase's own distance
  // distribution, per category, and persist it. Both function:body and type:body
  // flow in here (calibrateFromStore loads every distinct category's pool), so
  // each gets its OWN calibrated threshold.
  const model = CHOSEN_MODEL ?? MODEL_CANDIDATES[0];
  const categories = new Set(chunks.map((c) => categoryOf(c)));
  const calibrated = await calibrateFromStore(store, categories, model);
  console.log(`  Categories calibrated: ${calibrated}`);
}

/**
 * Recompute and persist the per-category calibration WITHOUT re-embedding.
 *
 * Cheap to re-run: it re-loads the already-stored vectors via the store (no
 * model load, no parsing of bodies for embedding), recomputes the leave-one-out
 * kNN distance distribution per category, and upserts fresh thresholds. Use it
 * after tuning `k`/`percentile`, or to refresh calibration on a pool that grew
 * via incremental sync. Gated the same way as the backfill.
 *
 * Entry point: `codebase-pkg conformity-calibrate`.
 */
export async function runConformityCalibrate(): Promise<void> {
  console.log('=== Codebase PKG — Conformity calibration ===');

  if (!(await isConformityEnabled(realPgRunner))) {
    const off = (process.env.CODEBASE_PKG_CONFORMITY ?? '').toLowerCase() === 'off';
    console.log(
      off
        ? '[conformity] Skipped — CODEBASE_PKG_CONFORMITY=off.'
        : '[conformity] Skipped — Postgres not configured/reachable.',
    );
    return;
  }

  await ensureSchema(realPgRunner);

  // Recompute calibration over the categories actually present in the repo's
  // watched source (so we don't depend on a separate category catalog). We parse
  // for categories only -- NOT to embed -- which is cheap and avoids loading the
  // model.
  console.log('Scanning watched files to determine categories...');
  const files = getAllWatchedFiles();
  const parsed = parseFiles(files);
  clearProjectCache();
  const categories = new Set<string>();
  for (const f of parsed) {
    for (const fn of f.functions) categories.add(categoryOf(fn));
    for (const t of f.types) categories.add(categoryOf(t));
  }

  const store = createConformityStore(realPgRunner);
  const model = CHOSEN_MODEL ?? MODEL_CANDIDATES[0];
  const calibrated = await calibrateFromStore(store, categories, model);

  console.log('');
  console.log('=== Conformity calibration complete ===');
  console.log(`  Categories calibrated: ${calibrated}`);
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
