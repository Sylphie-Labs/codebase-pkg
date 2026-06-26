/**
 * walk.mjs -- recursive .ts collector for the corpus harness.
 *
 * Given a root dir, return all *.ts paths (absolute) EXCLUDING:
 *   - node_modules / dist directories
 *   - *.d.ts declaration files
 *   - test files (*.test.ts, *.spec.ts, and anything under a __tests__ /
 *     tests / test directory)
 *
 * Pure fs walk -- no parsing, no model. Returns [] if the root is missing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '__tests__', 'tests', 'test']);

/** True for a path we never want in the corpus. */
function isTestFile(name) {
  return /\.(test|spec)\.tsx?$/.test(name);
}

/**
 * Recursively collect source .ts/.tsx files under `dir`.
 * Excludes node_modules, dist, .d.ts, and test files/dirs.
 */
export function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // missing/unreadable root -> nothing
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(full));
    } else if (entry.isFile()) {
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      if (isTestFile(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}
