/**
 * sync-pipeline.ts -- Main orchestrator for the codebase PKG sync.
 *
 * Runs all sync steps in order:
 *   1. git-diff  -> identify changed files since last sync
 *   2. ast-parser -> parse changed files to extract functions/types/imports
 *   3. graph-differ -> compute what to create/update/delete in the PKG
 *   4. mutation-builder -> convert changeset to Cypher statements
 *   5. Apply mutations to Neo4j
 *   6. change-logger -> record a Change node for this commit
 *   7. integrity-checker -> validate the graph is coherent
 *   8. Advance .last-sync-commit cursor
 *
 * Entry point: `npm run sync-pkg`
 */

import { getChangedFiles, writeLastSyncCommit, readLastSyncCommit, getDeletedFiles } from './git-diff.js';
import { parseFiles, clearProjectCache } from './ast-parser.js';
import { computeChangeset } from './graph-differ.js';
import { buildMutations, applyMutations } from './mutation-builder.js';
import { logChange } from './change-logger.js';
import { runIntegrityChecks } from './integrity-checker.js';
import { getDriver, closeDriver } from '../mcp-server/neo4j-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printStep(step: number, total: number, label: string): void {
  console.log(`\n[sync] Step ${step}/${total}: ${label}`);
}

function printSummary(label: string, value: number | string): void {
  console.log(`       ${label.padEnd(30)} ${value}`);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function runSync(): Promise<void> {
  const startTime = Date.now();
  const TOTAL_STEPS = 8;
  let currentStep = 0;
  const driver = getDriver();

  console.log('='.repeat(60));
  console.log('[sync] Codebase PKG sync starting');
  console.log('='.repeat(60));

  // Step 1: Identify changed files
  printStep(++currentStep, TOTAL_STEPS, 'Identifying changed files (git diff)');
  const diffResult = getChangedFiles();

  const lastCommit = readLastSyncCommit();
  const deletedFiles =
    lastCommit && !diffResult.isInitialRun
      ? getDeletedFiles(lastCommit, diffResult.currentCommit)
      : [];

  printSummary('Changed files:', diffResult.changedFiles.length);
  printSummary('Deleted files:', deletedFiles.length);
  printSummary('Initial run:', diffResult.isInitialRun ? 'yes' : 'no');

  if (diffResult.changedFiles.length === 0 && deletedFiles.length === 0) {
    console.log('[sync] Nothing to sync — no TypeScript changes detected.');
    await closeDriver();
    return;
  }

  // Step 2: Parse changed files
  printStep(++currentStep, TOTAL_STEPS, 'Parsing TypeScript files (ts-morph)');
  const parseStart = Date.now();
  const parsedFiles = parseFiles(diffResult.changedFiles);
  clearProjectCache();

  const totalFunctions = parsedFiles.reduce((n, f) => n + f.functions.length, 0);
  const totalTypes = parsedFiles.reduce((n, f) => n + f.types.length, 0);

  printSummary('Files parsed:', parsedFiles.length);
  printSummary('Functions extracted:', totalFunctions);
  printSummary('Types extracted:', totalTypes);
  printSummary('Parse time:', formatDuration(Date.now() - parseStart));

  // Step 3: Compute changeset
  printStep(++currentStep, TOTAL_STEPS, 'Computing graph diff');
  const changesetStart = Date.now();
  const changeset = await computeChangeset(parsedFiles, deletedFiles);

  printSummary('Nodes to create:', changeset.nodesToCreate.length);
  printSummary('Nodes to update:', changeset.nodesToUpdate.length);
  printSummary('Nodes to delete:', changeset.nodesToDelete.length);
  printSummary('Edges to add:', changeset.edgesToAdd.length);
  printSummary('Edges to remove:', changeset.edgesToRemove.length);
  printSummary('Diff time:', formatDuration(Date.now() - changesetStart));

  // Step 4: Build Cypher mutations
  printStep(++currentStep, TOTAL_STEPS, 'Building Cypher mutations');
  const mutations = buildMutations(changeset);
  printSummary('Cypher statements:', mutations.length);

  // Step 5: Apply mutations to Neo4j
  printStep(++currentStep, TOTAL_STEPS, 'Applying mutations to Neo4j');
  const mutateStart = Date.now();

  let mutationsApplied = 0;
  if (mutations.length > 0) {
    try {
      mutationsApplied = await applyMutations(mutations, driver);
      printSummary('Statements executed:', mutationsApplied);
      printSummary('Mutation time:', formatDuration(Date.now() - mutateStart));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync] ERROR: mutations failed — ${msg}`);
      await closeDriver();
      process.exit(1);
    }
  }

  // Step 6: Record Change node
  printStep(++currentStep, TOTAL_STEPS, 'Recording Change node');
  try {
    await logChange(diffResult.changedFiles, diffResult.currentCommit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sync] WARNING: change logging failed — ${msg} (non-fatal)`);
  }

  // Step 7: Integrity check
  printStep(++currentStep, TOTAL_STEPS, 'Running integrity checks');
  const integrityResult = await runIntegrityChecks();

  if (!integrityResult.passed) {
    console.error('[sync] Integrity checks FAILED. Cursor will NOT be advanced.');
    await closeDriver();
    process.exit(1);
  }

  // Step 8: Advance sync cursor
  printStep(++currentStep, TOTAL_STEPS, 'Advancing .last-sync-commit');
  writeLastSyncCommit(diffResult.currentCommit);

  // Summary
  const totalTime = Date.now() - startTime;
  console.log('\n' + '='.repeat(60));
  console.log('[sync] Sync complete');
  console.log('='.repeat(60));
  printSummary('Total time:', formatDuration(totalTime));
  printSummary('Commit synced to:', diffResult.currentCommit.slice(0, 8));
  printSummary('Mutations applied:', mutationsApplied);
  printSummary('Integrity warnings:', integrityResult.issues.filter(i => i.severity === 'warning').length);

  await closeDriver();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSync().catch(err => {
    console.error('[sync] Fatal error:', err instanceof Error ? err.message : String(err));
    closeDriver().finally(() => process.exit(1));
  });
}

export { runSync };
