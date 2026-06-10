/**
 * Tests for dist/sync/python-parser.js (Python extraction via the user's
 * Python runtime). The whole suite is skipped if no python3/python binary
 * is on PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parsePythonFiles, pythonAvailable } from '../dist/sync/python-parser.js';

const HASH_RE = /^[0-9a-f]{16}$/;

function fwd(p) {
  return p.replace(/\\/g, '/');
}

const GOOD_SOURCE = `"""Fixture module."""
import os
from .helpers import x


def compute_total(items: list[int], factor: int = 2) -> int:
    """Compute the scaled total."""
    values = normalize(items)
    print(values)
    len(values)
    return scale(values, factor)


async def fetch_items(limit: int) -> list:
    return await query_items(limit)


def _hidden(value):
    return value


@router.get("/items/{id}")
def read_item(id: int) -> dict:
    return load_item(id)


@app.route("/items", methods=["POST"])
def create_item():
    return persist_item()


class ItemService:
    """Service docstring."""

    def __init__(self, repo: ItemRepo, limit: int = 10):
        self.repo = repo
        self.limit = limit

    def find(self, item_id: int) -> dict:
        data = self.repo.get(item_id)
        self.validate(data)
        print(data)
        return data

    def validate(self, data):
        pass
`;

const BROKEN_SOURCE = `def broken(:\n    return 1\n`;

test('python extraction', async (t) => {
  if (!pythonAvailable()) {
    t.skip('no python3/python runtime on PATH');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-py-'));
  const goodPath = path.join(tmpDir, 'good_module.py');
  const brokenPath = path.join(tmpDir, 'broken_module.py');

  try {
    fs.writeFileSync(goodPath, GOOD_SOURCE, 'utf8');
    fs.writeFileSync(brokenPath, BROKEN_SOURCE, 'utf8');

    // Parse both in one batch: the broken file must be skipped without
    // failing the good one.
    const results = parsePythonFiles([goodPath, brokenPath]);
    assert.equal(results.length, 1, 'broken file is skipped, good file survives');
    const parsed = results[0];
    assert.equal(parsed.filePath, fwd(goodPath));
    assert.equal(parsed.extension, '.py');
    assert.ok(parsed.lineCount > 30, `lineCount sane (got ${parsed.lineCount})`);

    const fnByName = new Map(parsed.functions.map(f => [f.name, f]));

    await t.test('module function: annotations, docstring, callees, hash', () => {
      const fn = fnByName.get('compute_total');
      assert.ok(fn, 'compute_total extracted');
      assert.deepEqual(fn.args, [
        { name: 'items', type: 'list[int]' },
        { name: 'factor', type: 'int' },
      ]);
      assert.equal(fn.returnType, 'int');
      assert.equal(fn.jsDoc, 'Compute the scaled total.');
      assert.equal(fn.isExported, true);
      assert.equal(fn.isAsync, false);
      assert.ok(fn.callees.includes('normalize'), 'normalize kept');
      assert.ok(fn.callees.includes('scale'), 'scale kept');
      assert.ok(!fn.callees.includes('print'), 'print dropped');
      assert.ok(!fn.callees.includes('len'), 'len dropped');
      assert.match(fn.contentHash, HASH_RE);
      assert.ok(fn.lineNumber >= 1 && fn.endLine >= fn.lineNumber, 'line range sane');
    });

    await t.test('async def is flagged isAsync', () => {
      const fn = fnByName.get('fetch_items');
      assert.ok(fn, 'fetch_items extracted');
      assert.equal(fn.isAsync, true);
    });

    await t.test('_private helper has isExported false', () => {
      const fn = fnByName.get('_hidden');
      assert.ok(fn, '_hidden extracted');
      assert.equal(fn.isExported, false);
    });

    await t.test('FastAPI @router.get yields httpMethod GET and routePath', () => {
      const fn = fnByName.get('read_item');
      assert.ok(fn, 'read_item extracted');
      assert.equal(fn.httpMethod, 'GET');
      assert.equal(fn.routePath, '/items/{id}');
    });

    await t.test('Flask @app.route with methods=["POST"] yields POST', () => {
      const fn = fnByName.get('create_item');
      assert.ok(fn, 'create_item extracted');
      assert.equal(fn.httpMethod, 'POST');
      assert.equal(fn.routePath, '/items');
    });

    await t.test('class: ClassName.method naming, ctor params skip self, self. stripped', () => {
      assert.ok(fnByName.has('ItemService.__init__'), '__init__ uses ClassName.method naming');
      assert.ok(fnByName.has('ItemService.find'), 'find uses ClassName.method naming');

      const cls = parsed.types.find(ty => ty.name === 'ItemService');
      assert.ok(cls, 'ItemService extracted as a type');
      assert.equal(cls.kind, 'class');
      assert.deepEqual(cls.constructorParams, [
        { name: 'repo', type: 'ItemRepo' },
        { name: 'limit', type: 'int' },
      ]);
      assert.match(cls.contentHash, HASH_RE);

      const find = fnByName.get('ItemService.find');
      assert.ok(find.callees.includes('repo.get'), 'self.repo.get recorded as repo.get');
      assert.ok(find.callees.includes('validate'), 'self.validate recorded as validate');
      assert.ok(!find.callees.includes('print'), 'print dropped in method callees');
      assert.ok(
        find.callees.every(c => !c.startsWith('self.')),
        'no callee retains the self. prefix'
      );
    });

    await t.test('imports: relative and absolute specifiers', () => {
      const bySpec = new Map(parsed.imports.map(i => [i.moduleSpecifier, i]));

      const rel = bySpec.get('.helpers');
      assert.ok(rel, 'from .helpers import x captured as ".helpers"');
      assert.deepEqual(rel.importedNames, ['x']);

      const abs = bySpec.get('os');
      assert.ok(abs, 'import os captured');
      assert.deepEqual(abs.importedNames, ['os']);

      for (const imp of parsed.imports) {
        assert.equal(imp.fromFile, fwd(goodPath));
      }
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
