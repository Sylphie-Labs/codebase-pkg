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

export interface WatchedPackage {
  name: string;
  dir: string;
}

/**
 * Packages to index. Defaults auto-detect common layouts: `src/` if it exists
 * at the repo root (single-package projects), and any direct subdirectories of
 * `apps/` and `packages/` (monorepos). Override via the CODEBASE_PKG_PACKAGES
 * env var (JSON array of {name, dir} objects) to specify exactly which package
 * roots to scan.
 */
export function getWatchedPackages(): WatchedPackage[] {
  const envJson = process.env.CODEBASE_PKG_PACKAGES;
  if (envJson) {
    try {
      return JSON.parse(envJson);
    } catch {
      console.warn('[codebase-pkg] CODEBASE_PKG_PACKAGES JSON invalid; falling back to auto-detect.');
    }
  }

  const detected: WatchedPackage[] = [];

  // Single-package layout: <repo>/src/
  if (fs.existsSync(path.join(REPO_ROOT, 'src'))) {
    detected.push({ name: 'app', dir: 'src' });
  }

  // Monorepo layout: <repo>/apps/* and <repo>/packages/*
  for (const parent of ['apps', 'packages']) {
    const parentPath = path.join(REPO_ROOT, parent);
    if (!fs.existsSync(parentPath)) continue;
    try {
      for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const subSrc = path.join(parentPath, entry.name, 'src');
        if (fs.existsSync(subSrc)) {
          detected.push({ name: entry.name, dir: `${parent}/${entry.name}/src` });
        }
      }
    } catch {
      // ignore unreadable parent
    }
  }

  if (detected.length === 0) {
    // Last-ditch fallback: scan the repo root itself.
    detected.push({ name: 'root', dir: '.' });
  }
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
