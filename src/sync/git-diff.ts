/**
 * git-diff.ts -- Detect changed source files (.ts/.tsx/.py) since the last sync.
 *
 * Reads a .last-sync-commit file to find the last synced git commit, runs
 * git diff to identify changed files, and filters to only the source
 * files we care about in this monorepo.
 *
 * On the first run (no .last-sync-commit), returns ALL matching files so
 * the initial seed can use this same interface.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();

/**
 * Cursor file recording the last commit we synced. Lives in the consumer's
 * repo root under .codebase-pkg/ so it's stable across npm install cycles
 * (would be wiped if it lived inside node_modules/).
 *
 * Override the location via CODEBASE_PKG_CURSOR_FILE (absolute or relative path).
 */
const LAST_SYNC_FILE = process.env.CODEBASE_PKG_CURSOR_FILE
  ? path.isAbsolute(process.env.CODEBASE_PKG_CURSOR_FILE)
    ? process.env.CODEBASE_PKG_CURSOR_FILE
    : path.join(REPO_ROOT, process.env.CODEBASE_PKG_CURSOR_FILE)
  : path.join(REPO_ROOT, '.codebase-pkg', '.last-sync-commit');

/**
 * Directories within the repo that contain TypeScript we want to index.
 * Default targets common monorepo layouts: apps/, packages/, src/.
 *
 * Override via CODEBASE_PKG_WATCHED_DIRS env var (comma-separated relative paths).
 */
const DEFAULT_WATCHED_DIRECTORIES = [
  'apps',
  'packages',
  'src',
];

const WATCHED_DIRECTORIES = (
  process.env.CODEBASE_PKG_WATCHED_DIRS
    ? process.env.CODEBASE_PKG_WATCHED_DIRS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_WATCHED_DIRECTORIES
);

/**
 * Directory-prefix patterns to skip within the watched directories.
 * Provide as a comma-separated list of regex-style prefixes via
 * CODEBASE_PKG_EXCLUDE_DIRS — e.g. "packages/codebase-pkg/,packages/legacy/".
 * Each entry is anchored at the start of the relative path.
 */
const EXCLUDE_DIR_PATTERNS = (
  process.env.CODEBASE_PKG_EXCLUDE_DIRS
    ? process.env.CODEBASE_PKG_EXCLUDE_DIRS
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(prefix => new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    : []
);

const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\/dist\//,
  /\.d\.ts$/,
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.spec\.tsx$/,
  /\.test\.tsx$/,
  /__pycache__/,
  /\/(venv|\.venv|\.tox)\//,
  /(^|\/)test_[^\/]+\.py$/,
  /_test\.py$/,
  /(^|\/)conftest\.py$/,
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function isWatchedFile(relativePath: string): boolean {
  const normalised = relativePath.replace(/\\/g, '/');

  const inWatchedDir = WATCHED_DIRECTORIES.some(dir =>
    normalised === dir || normalised.startsWith(dir + '/')
  );
  if (!inWatchedDir) return false;

  const isSourceFile =
    normalised.endsWith('.ts') ||
    normalised.endsWith('.tsx') ||
    normalised.endsWith('.py');
  if (!isSourceFile) return false;

  if (EXCLUDE_PATTERNS.some(rx => rx.test(normalised))) return false;
  if (EXCLUDE_DIR_PATTERNS.some(rx => rx.test(normalised))) return false;

  return true;
}

export function getAllWatchedFiles(): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name).replace(/\\/g, '/');
      const relativePath = fullPath.replace(REPO_ROOT.replace(/\\/g, '/') + '/', '');

      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.git' ||
          entry.name === 'archives' ||
          entry.name === '__pycache__' ||
          entry.name === 'venv' ||
          entry.name === '.venv' ||
          entry.name === '.tox' ||
          entry.name === 'site-packages'
        ) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile() && isWatchedFile(relativePath)) {
        results.push(fullPath);
      }
    }
  }

  walk(REPO_ROOT);
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiffResult {
  changedFiles: string[];
  currentCommit: string;
  isInitialRun: boolean;
}

export function getChangedFiles(): DiffResult {
  const currentCommit = git('rev-parse HEAD');

  if (!fs.existsSync(LAST_SYNC_FILE)) {
    console.log('[git-diff] No .last-sync-commit found — returning all watched files (initial run).');
    const changedFiles = getAllWatchedFiles();
    return { changedFiles, currentCommit, isInitialRun: true };
  }

  const lastCommit = fs.readFileSync(LAST_SYNC_FILE, 'utf-8').trim();

  if (lastCommit === currentCommit) {
    console.log('[git-diff] Already up to date — no changes since last sync.');
    return { changedFiles: [], currentCommit, isInitialRun: false };
  }

  // Verify the last commit is reachable
  try {
    git(`cat-file -t ${lastCommit}`);
  } catch {
    console.warn(
      `[git-diff] Last sync commit ${lastCommit} is no longer reachable. Falling back to all watched files.`
    );
    const changedFiles = getAllWatchedFiles();
    return { changedFiles, currentCommit, isInitialRun: true };
  }

  const diffOutput = git(`diff --name-only ${lastCommit} HEAD`);
  if (!diffOutput) {
    return { changedFiles: [], currentCommit, isInitialRun: false };
  }

  const changedFiles = diffOutput
    .split('\n')
    .filter(line => line.trim().length > 0)
    .filter(relativePath => isWatchedFile(relativePath))
    .map(relativePath =>
      path.join(REPO_ROOT, relativePath).replace(/\\/g, '/')
    )
    .filter(absPath => fs.existsSync(absPath));

  console.log(`[git-diff] ${changedFiles.length} changed file(s) since ${lastCommit.slice(0, 8)}.`);
  return { changedFiles, currentCommit, isInitialRun: false };
}

/**
 * Watched source files with UNCOMMITTED changes in the working tree -- staged,
 * unstaged, and untracked -- as absolute forward-slashed paths.
 *
 * Unlike {@link getChangedFiles} (which diffs the sync cursor against HEAD, i.e.
 * committed-to-committed), this answers "what am I editing right now that isn't
 * committed yet" -- the input the Conformity Judge scores against the committed
 * pool. Uses `git status --porcelain` so it captures the same set git considers
 * dirty, then filters to watched source files and to paths that still exist on
 * disk (a pure deletion has nothing to parse).
 *
 * Returns [] on any git failure (e.g. not a repo) rather than throwing -- the
 * judge degrades to "nothing to judge" instead of crashing.
 */
export function getWorkingTreeFiles(): string[] {
  let output: string;
  try {
    // --porcelain: stable, script-friendly. -uall: list untracked files
    // individually (not just their directory). -z would be safer for exotic
    // paths, but the line form matches the rest of this module.
    output = git('status --porcelain -uall');
  } catch {
    return [];
  }
  if (!output) return [];

  const rels = new Set<string>();
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    // Porcelain v1 line: XY<space>path  (path starts at column 3). Renames show
    // "orig -> new"; take the post-rename path (the file that exists now).
    let pathPart = line.slice(3).trim();
    const arrow = pathPart.indexOf(' -> ');
    if (arrow >= 0) pathPart = pathPart.slice(arrow + 4);
    // git may quote paths containing special chars; strip surrounding quotes.
    if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
      pathPart = pathPart.slice(1, -1);
    }
    rels.add(pathPart);
  }

  return [...rels]
    .filter((relativePath) => isWatchedFile(relativePath))
    .map((relativePath) =>
      path.join(REPO_ROOT, relativePath).replace(/\\/g, '/'),
    )
    .filter((absPath) => fs.existsSync(absPath));
}

export function writeLastSyncCommit(commitHash: string): void {
  fs.mkdirSync(path.dirname(LAST_SYNC_FILE), { recursive: true });
  fs.writeFileSync(LAST_SYNC_FILE, commitHash, 'utf-8');
  console.log(`[git-diff] Cursor advanced to ${commitHash.slice(0, 8)}.`);
}

export function readLastSyncCommit(): string | null {
  if (!fs.existsSync(LAST_SYNC_FILE)) return null;
  return fs.readFileSync(LAST_SYNC_FILE, 'utf-8').trim() || null;
}

export function getDeletedFiles(lastCommit: string, currentCommit: string): string[] {
  if (lastCommit === currentCommit) return [];

  try {
    const output = git(`diff --name-only --diff-filter=D ${lastCommit} ${currentCommit}`);
    if (!output) return [];
    // Mirror getChangedFiles: filter by isWatchedFile on the repo-RELATIVE path
    // first, then absolutize and forward-slash so paths match the ABSOLUTE
    // filePaths stored on graph nodes (see computeChangeset's `f.filePath IN
    // $filePaths`). Do NOT filter by fs.existsSync — deleted files are gone.
    return output
      .split('\n')
      .filter(line => line.trim().length > 0)
      .filter(relativePath => isWatchedFile(relativePath))
      .map(relativePath =>
        path.join(REPO_ROOT, relativePath).replace(/\\/g, '/')
      );
  } catch {
    return [];
  }
}
