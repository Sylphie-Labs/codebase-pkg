/**
 * import-resolver.ts -- Resolve import specifiers to source directories.
 *
 * Shared by the initial seed and the incremental sync so both create
 * IMPORTS edges the same way: (sourceModuleDir)-[:IMPORTS]->(targetModuleDir).
 *
 * Handles:
 *   - workspace-scoped imports (CODEBASE_PKG_WORKSPACE_SCOPE, e.g. "@your-org")
 *   - relative imports ("./x", "../y")
 *   - Python dotted/relative imports via resolvePythonImportTarget
 * External package specifiers resolve to null and get no edge.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = process.cwd();

const IGNORE_DIR_NAMES = new Set([
  'node_modules','dist','build','out','coverage','.git','.cache','.next','.turbo',
  '.codebase-pkg','venv','.venv','.tox','__pycache__','site-packages','.idea','.vscode',
]);
const SOURCE_EXTENSIONS = ['.ts','.tsx','.py'];
const MAX_DETECT_DEPTH = 5;

// Files that match a source extension but the seed (initial-seed.ts EXCLUDE_PATTERNS)
// never ingests: type declarations, test/spec files, pytest fixtures. A directory full
// of only these is NOT real source, so detecting it as a watched package would MERGE an
// empty Service node (and, via Service.name being UNIQUE, steal a name). Keep this aligned
// with initial-seed.ts so detection matches what the seed will actually index.
function isIndexableSourceName(name: string): boolean {
  if (!SOURCE_EXTENSIONS.some(ext => name.endsWith(ext))) return false;
  if (name.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(name)) return false;
  if (/^test_.*\.py$/.test(name)) return false;
  if (/_test\.py$/.test(name)) return false;
  if (name === 'conftest.py') return false;
  return true;
}

// Does this directory directly (or within a few levels) contain first-party source?
// Used to decide whether a src-less package dir (e.g. a Python service) is worth watching.
// Only counts files the seed would actually ingest (see isIndexableSourceName).
function dirContainsSource(dir: string, maxDepth: number): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && isIndexableSourceName(e.name)) return true;
  }
  if (maxDepth <= 0) return false;
  for (const e of entries) {
    if (e.isDirectory() && !IGNORE_DIR_NAMES.has(e.name)) {
      if (dirContainsSource(path.join(dir, e.name), maxDepth - 1)) return true;
    }
  }
  return false;
}

export interface WatchedPackage {
  name: string;
  dir: string;
}

/**
 * Packages to index. Defaults auto-detect three common layouts:
 *   1. Single-package: `<repo>/src/` exists → {name:'app', dir:'src'}.
 *   2. Monorepo: direct children of `apps/` and `packages/`. Each child prefers
 *      its own `<pkg>/src/`; if there is no `src/` it falls back to the package
 *      dir itself when that dir (within a few levels) contains first-party
 *      source — this covers src-less/Python service layouts laid out directly
 *      under the package dir.
 *   3. Root-level packages: any other top-level directory (not apps/packages/src,
 *      not noise) that has its own `src/` subdir — e.g. `frontend/src`.
 *
 * Service.name is a UNIQUE key in the graph, so colliding names are disambiguated.
 * Override via the CODEBASE_PKG_PACKAGES env var (JSON array of {name, dir}
 * objects) to specify exactly which package roots to scan.
 *
 * Accepts an optional repoRoot (default = module-level REPO_ROOT) for testability.
 */
export function getWatchedPackages(repoRoot: string = REPO_ROOT): WatchedPackage[] {
  const envJson = process.env.CODEBASE_PKG_PACKAGES;
  if (envJson) {
    try { return JSON.parse(envJson); }
    catch { console.warn('[codebase-pkg] CODEBASE_PKG_PACKAGES JSON invalid; falling back to auto-detect.'); }
  }

  const detected: WatchedPackage[] = [];
  const seenDirs = new Set<string>();
  const usedNames = new Set<string>();
  const add = (name: string, dir: string): void => {
    if (seenDirs.has(dir)) return;
    seenDirs.add(dir);
    // Service.name is a UNIQUE key in the graph — disambiguate collisions.
    let unique = name; let n = 2;
    while (usedNames.has(unique)) unique = name + '-' + (n++);
    usedNames.add(unique);
    detected.push({ name: unique, dir });
  };

  // 1. Single-package layout: <repo>/src
  if (fs.existsSync(path.join(repoRoot, 'src'))) add('app', 'src');

  // 2. Monorepo: direct children of apps/ and packages/. Prefer <pkg>/src; fall back to the
  //    package dir itself for src-less layouts (e.g. Python) that still contain source.
  for (const parent of ['apps', 'packages']) {
    const parentPath = path.join(repoRoot, parent);
    if (!fs.existsSync(parentPath)) continue;
    try {
      for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgPath = path.join(parentPath, entry.name);
        if (fs.existsSync(path.join(pkgPath, 'src'))) {
          // Long-standing behavior: any child with a src/ is a package — even if its name
          // collides with a noise dir (e.g. a package literally named 'build').
          add(entry.name, parent + '/' + entry.name + '/src');
        } else if (!IGNORE_DIR_NAMES.has(entry.name) && dirContainsSource(pkgPath, MAX_DETECT_DEPTH)) {
          // New src-less fallback: skip noise dirs (.venv, dist, node_modules, ...).
          add(entry.name, parent + '/' + entry.name);
        }
      }
    } catch { /* ignore unreadable parent */ }
  }

  // 3. Root-level package dirs: a top-level directory (not apps/packages, not noise) that has its
  //    own src/ subdir — e.g. frontend/src. Conservative: requires a src/ subdir to avoid pulling
  //    in docs/scripts/infra dirs at the repo root.
  try {
    for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name === 'apps' || name === 'packages' || name === 'src') continue;
      if (IGNORE_DIR_NAMES.has(name) || name.startsWith('.')) continue;
      if (fs.existsSync(path.join(repoRoot, name, 'src'))) add(name, name + '/src');
    }
  } catch { /* ignore */ }

  if (detected.length === 0) detected.push({ name: 'root', dir: '.' });
  return detected;
}

export const WATCHED_PACKAGES: WatchedPackage[] = getWatchedPackages();

/**
 * Workspace package → source directory map. Built from WATCHED_PACKAGES.
 * Set CODEBASE_PKG_WORKSPACE_SCOPE (e.g. "@your-org") to resolve scoped
 * intra-monorepo imports; leave unset for non-workspace repos.
 */
const WORKSPACE_SCOPE: string | null = process.env.CODEBASE_PKG_WORKSPACE_SCOPE ?? null;
const PACKAGE_SOURCE_DIRS: Record<string, string> = WORKSPACE_SCOPE
  ? Object.fromEntries(WATCHED_PACKAGES.map(p => [`${WORKSPACE_SCOPE}/${p.name}`, p.dir]))
  : {};

/**
 * Which watched package a directory belongs to, or 'unknown'.
 * `absDir` must use forward slashes.
 */
export function packageNameForDir(absDir: string): string {
  const repoRoot = REPO_ROOT.replace(/\\/g, '/');
  const relativePath = absDir.replace(repoRoot + '/', '');
  const pkg = WATCHED_PACKAGES.find(
    p => relativePath.startsWith(p.dir + '/') || relativePath === p.dir
  );
  return pkg?.name ?? 'unknown';
}

/**
 * Resolve a TypeScript import specifier to the absolute directory of the
 * target module, or null for external packages.
 *
 * @param sourceDir - absolute directory of the importing file (forward slashes)
 * @param moduleSpecifier - the raw import specifier string
 */
export function resolveImportTarget(sourceDir: string, moduleSpecifier: string): string | null {
  const repoRoot = REPO_ROOT.replace(/\\/g, '/');

  // Handle workspace-scoped imports when a scope is configured.
  if (WORKSPACE_SCOPE && moduleSpecifier.startsWith(`${WORKSPACE_SCOPE}/`)) {
    const sortedKeys = Object.keys(PACKAGE_SOURCE_DIRS).sort((a, b) => b.length - a.length);
    for (const pkg of sortedKeys) {
      if (moduleSpecifier === pkg || moduleSpecifier.startsWith(pkg + '/')) {
        const basePath = `${repoRoot}/${PACKAGE_SOURCE_DIRS[pkg]}`;
        const subPath = moduleSpecifier.slice(pkg.length + 1);
        if (subPath) {
          const fullPath = `${basePath}/${subPath}`;
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
            return fullPath;
          }
          const parentDir = path.dirname(`${basePath}/${subPath}`).replace(/\\/g, '/');
          if (fs.existsSync(parentDir)) return parentDir;
        }
        return basePath;
      }
    }
    return null;
  }

  // Handle relative imports
  if (moduleSpecifier.startsWith('.')) {
    const resolved = path.resolve(sourceDir, moduleSpecifier).replace(/\\/g, '/');
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
    const targetDir = path.dirname(resolved).replace(/\\/g, '/');
    if (targetDir !== sourceDir && fs.existsSync(targetDir)) {
      return targetDir;
    }
    return null;
  }

  // External package — skip
  return null;
}

/**
 * Resolve a Python import specifier to the absolute directory of the target
 * module, or null for external packages / stdlib.
 *
 * The python parser emits specifiers in two shapes:
 *   - "pkg.sub.mod"  (absolute import)
 *   - ".mod" / "..pkg.mod"  (relative import; one leading dot per level)
 */
export function resolvePythonImportTarget(sourceDir: string, moduleSpecifier: string): string | null {
  const repoRoot = REPO_ROOT.replace(/\\/g, '/');

  // Relative import: each leading dot beyond the first walks one directory up.
  if (moduleSpecifier.startsWith('.')) {
    const dots = moduleSpecifier.match(/^\.+/)![0].length;
    const rest = moduleSpecifier.slice(dots);
    let base = sourceDir;
    for (let i = 1; i < dots; i++) base = path.dirname(base).replace(/\\/g, '/');
    if (!rest) return fs.existsSync(base) ? base : null;
    const candidate = `${base}/${rest.replace(/\./g, '/')}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parentDir = path.dirname(candidate).replace(/\\/g, '/');
    return fs.existsSync(parentDir) ? parentDir : null;
  }

  // Absolute import: try to resolve the dotted path under each watched
  // package root, then under the repo root itself.
  const asPath = moduleSpecifier.replace(/\./g, '/');
  const roots = [
    ...WATCHED_PACKAGES.map(p => (p.dir === '.' ? repoRoot : `${repoRoot}/${p.dir}`)),
    repoRoot,
  ];
  for (const root of roots) {
    const candidate = `${root}/${asPath}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parentDir = path.dirname(candidate).replace(/\\/g, '/');
    if (parentDir !== root && fs.existsSync(`${parentDir}`) && fs.existsSync(`${candidate}.py`)) {
      return parentDir;
    }
  }

  // External package or stdlib — skip
  return null;
}
