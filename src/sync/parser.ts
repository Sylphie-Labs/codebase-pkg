/**
 * parser.ts -- Language dispatcher: the single parse entry point.
 *
 * Routes .ts/.tsx files to the ts-morph based ast-parser and .py files to
 * the python-parser (which shells out to the user's Python runtime). Both
 * produce the same ParsedFile shape, so callers stay language-agnostic.
 */

import { parseFiles as parseTypeScriptFiles, clearProjectCache } from './ast-parser.js';
import { parsePythonFiles, pythonAvailable } from './python-parser.js';
import type { ParsedFile } from './ast-parser.js';

/**
 * Parse a mixed list of source files. Results are the TypeScript results
 * followed by the Python results (no ordering guarantee beyond that).
 *
 * If .py files are present but no Python runtime is found on PATH, they are
 * skipped with a single stderr warning.
 */
export function parseFiles(filePaths: string[]): ParsedFile[] {
  const tsFiles: string[] = [];
  const pyFiles: string[] = [];

  for (const rawPath of filePaths) {
    const filePath = rawPath.replace(/\\/g, '/');
    if (filePath.endsWith('.py')) {
      pyFiles.push(filePath);
    } else {
      // .ts/.tsx (and anything else, preserving the previous single-parser
      // behavior for unexpected extensions).
      tsFiles.push(filePath);
    }
  }

  const results: ParsedFile[] = [];

  if (tsFiles.length > 0) {
    results.push(...parseTypeScriptFiles(tsFiles));
  }

  if (pyFiles.length > 0) {
    if (!pythonAvailable()) {
      process.stderr.write(
        `[python-parser] WARNING: ${pyFiles.length} .py file(s) skipped — no python3/python runtime found on PATH\n`
      );
    } else {
      results.push(...parsePythonFiles(pyFiles));
    }
  }

  return results;
}

export { clearProjectCache };
