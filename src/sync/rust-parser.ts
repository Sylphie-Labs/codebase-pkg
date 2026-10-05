/**
 * rust-parser.ts -- Rust AST extraction via web-tree-sitter in a child process.
 *
 * Spawns rust-parser-worker.js (a separate Node process) which parses .rs
 * files with the vendored tree-sitter-rust grammar and emits the exact same
 * ParsedFile shape as ast-parser.ts, so the rest of the pipeline
 * (graph-differ, mutation-builder, initial-seed) is language-agnostic.
 *
 * Why a child process: web-tree-sitter initialises and loads grammars
 * asynchronously, while parseFiles() is synchronous. Running the worker via
 * spawnSync keeps the public API synchronous, mirroring python-parser.ts.
 * File lists are passed via STDIN to avoid Windows command-line length
 * limits; results come back as one JSON document on stdout. Per-file parse
 * errors are reported on stderr and the file is skipped -- they never crash
 * the batch.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { ParsedFile } from './ast-parser.js';

export function parseRustFiles(filePaths: string[]): ParsedFile[] {
  if (filePaths.length === 0) return [];

  const normalised = filePaths.map(p => p.replace(/\\/g, '/'));
  const workerPath = fileURLToPath(new URL('./rust-parser-worker.js', import.meta.url));

  const result = spawnSync(process.execPath, [workerPath], {
    input: JSON.stringify(normalised),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });

  // Forward per-file warnings emitted by the worker.
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error || result.status !== 0) {
    const msg = result.error ? result.error.message : `exit code ${result.status}`;
    process.stderr.write(`[rust-parser] WARNING: rust parse batch failed — ${msg}\n`);
    return [];
  }

  try {
    const files = JSON.parse(result.stdout) as ParsedFile[];
    for (const f of files) {
      if (!Array.isArray(f.constants)) f.constants = [];
    }
    return files;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[rust-parser] WARNING: invalid JSON from rust parser — ${msg}\n`);
    return [];
  }
}
