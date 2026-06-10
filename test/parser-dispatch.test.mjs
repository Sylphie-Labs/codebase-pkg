/**
 * Tests for dist/sync/parser.js -- the language dispatcher.
 *
 * A mixed .ts + .py batch must be routed to the right parser and the
 * results concatenated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseFiles } from '../dist/sync/parser.js';
import { pythonAvailable } from '../dist/sync/python-parser.js';

function fwd(p) {
  return p.replace(/\\/g, '/');
}

test('mixed .ts + .py batch routes to both parsers and concatenates results', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-dispatch-'));
  const tsPath = path.join(tmpDir, 'thing.ts');
  const pyPath = path.join(tmpDir, 'thing.py');

  try {
    fs.writeFileSync(tsPath, 'export function tsThing(): number { return 1; }\n', 'utf8');
    fs.writeFileSync(pyPath, 'def py_thing():\n    return 1\n', 'utf8');

    const results = parseFiles([tsPath, pyPath]);

    const tsEntries = results.filter(r => r.filePath.endsWith('.ts'));
    const pyEntries = results.filter(r => r.filePath.endsWith('.py'));

    assert.equal(tsEntries.length, 1, 'exactly one .ts entry');
    assert.equal(tsEntries[0].filePath, fwd(tsPath));
    assert.equal(tsEntries[0].functions[0]?.name, 'tsThing');

    if (!pythonAvailable()) {
      t.diagnostic('python not available; .py routing assertions skipped');
      assert.equal(pyEntries.length, 0);
      return;
    }

    assert.equal(pyEntries.length, 1, 'exactly one .py entry');
    assert.equal(pyEntries[0].filePath, fwd(pyPath));
    assert.equal(pyEntries[0].functions[0]?.name, 'py_thing');
    assert.equal(results.length, 2, 'results are the concatenation of both parsers');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
