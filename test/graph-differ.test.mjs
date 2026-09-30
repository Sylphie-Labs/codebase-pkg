/**
 * Tests for dist/sync/graph-differ.js -- diffConstantsForFile as a pure
 * function over hand-built graph-state maps.
 *
 * computeChangeset() itself hits Neo4j (via runQuery) so it isn't unit-tested
 * here without a live database; diffConstantsForFile is the pure diffing RULE
 * it delegates to for module-level constants, exported specifically so the
 * create/update/delete decision can be verified without a database -- mirrors
 * the inline create/update/delete rule already used for Function and Type
 * nodes.
 *
 * Run after `npm run build`:
 *   node --test test/graph-differ.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffConstantsForFile } from '../dist/sync/graph-differ.js';

const FILE = '/repo/src/config.ts';

function graphNode(name, contentHash, filePath = FILE) {
  return { name, filePath, contentHash };
}

function parsedConstant(overrides = {}) {
  return {
    name: 'CONFIG',
    filePath: FILE,
    lineNumber: 3,
    endLine: 9,
    bodyText: 'export const CONFIG = { a: 1 };',
    isExported: true,
    kind: 'const',
    contentHash: 'hash-v1',
    ...overrides,
  };
}

test('new constant name (no existing graph node) -> create', () => {
  const { creates, updates, deletes } = diffConstantsForFile(
    FILE,
    [parsedConstant()],
    new Map(),
  );

  assert.equal(creates.length, 1);
  assert.equal(updates.length, 0);
  assert.equal(deletes.length, 0);
  assert.equal(creates[0].kind, 'const');
  assert.equal(creates[0].data.name, 'CONFIG');
});

test('existing constant with matching contentHash -> no create/update/delete', () => {
  const graph = new Map([[`${FILE}::CONFIG`, graphNode('CONFIG', 'hash-v1')]]);

  const { creates, updates, deletes } = diffConstantsForFile(FILE, [parsedConstant()], graph);

  assert.equal(creates.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(deletes.length, 0);
});

test('existing constant with a DIFFERENT contentHash -> update', () => {
  const graph = new Map([[`${FILE}::CONFIG`, graphNode('CONFIG', 'hash-OLD')]]);

  const { creates, updates, deletes } = diffConstantsForFile(
    FILE,
    [parsedConstant({ contentHash: 'hash-NEW' })],
    graph,
  );

  assert.equal(creates.length, 0);
  assert.equal(updates.length, 1);
  assert.equal(deletes.length, 0);
  assert.equal(updates[0].kind, 'const');
  assert.equal(updates[0].data.contentHash, 'hash-NEW');
  assert.deepEqual(updates[0].changedFields, ['full']);
});

test('graph constant no longer present in the parse -> delete', () => {
  const graph = new Map([
    [`${FILE}::CONFIG`, graphNode('CONFIG', 'hash-v1')],
    [`${FILE}::REMOVED_ONE`, graphNode('REMOVED_ONE', 'hash-old')],
  ]);

  // Only CONFIG survives the re-parse; REMOVED_ONE is gone from source.
  const { creates, updates, deletes } = diffConstantsForFile(FILE, [parsedConstant()], graph);

  assert.equal(creates.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].kind, 'const');
  assert.equal(deletes[0].name, 'REMOVED_ONE');
  assert.equal(deletes[0].filePath, FILE);
});

test('graph constant belonging to a DIFFERENT file is left alone (no cross-file delete)', () => {
  const otherFile = '/repo/src/other.ts';
  const graph = new Map([
    [`${otherFile}::UNRELATED`, graphNode('UNRELATED', 'hash-x', otherFile)],
  ]);

  const { creates, updates, deletes } = diffConstantsForFile(FILE, [], graph);

  assert.equal(creates.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(deletes.length, 0, 'a constant in another file must not be flagged as deleted');
});

test('mixed batch: one create, one update, one delete, one unchanged, in a single call', () => {
  const graph = new Map([
    [`${FILE}::UNCHANGED`, graphNode('UNCHANGED', 'same-hash')],
    [`${FILE}::STALE`, graphNode('STALE', 'old-hash')],
    [`${FILE}::GONE`, graphNode('GONE', 'gone-hash')],
  ]);

  const parsed = [
    parsedConstant({ name: 'UNCHANGED', contentHash: 'same-hash' }),
    parsedConstant({ name: 'STALE', contentHash: 'new-hash' }),
    parsedConstant({ name: 'BRAND_NEW', contentHash: 'brand-new-hash' }),
  ];

  const { creates, updates, deletes } = diffConstantsForFile(FILE, parsed, graph);

  assert.equal(creates.length, 1);
  assert.equal(creates[0].data.name, 'BRAND_NEW');

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.name, 'STALE');

  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].name, 'GONE');
});
