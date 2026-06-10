/**
 * Tests for dist/sync/mutation-builder.js -- buildMutations as a pure
 * function over hand-built Changeset objects.
 *
 * NOTE: import-resolver.js captures process.cwd() at module load and the
 * IMPORTS edge builder resolves specifiers against the real filesystem, so
 * these tests rely on `node --test` running from the repo root (where
 * src/mcp-server/tools is a real subdirectory).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';

import { buildMutations } from '../dist/sync/mutation-builder.js';

const REPO_ROOT = process.cwd().replace(/\\/g, '/');

function emptyChangeset(overrides = {}) {
  return {
    nodesToCreate: [],
    nodesToUpdate: [],
    nodesToDelete: [],
    edgesToAdd: [],
    edgesToRemove: [],
    deletedFiles: [],
    parsedFiles: [],
    ...overrides,
  };
}

function makeParsedFunction(overrides = {}) {
  return {
    name: 'doWork',
    filePath: `${REPO_ROOT}/src/sync/example.ts`,
    lineNumber: 3,
    endLine: 9,
    args: [{ name: 'input', type: 'string' }],
    returnType: 'void',
    jsDoc: 'Does the work.',
    bodyText: '{ return; }',
    isExported: true,
    isAsync: false,
    decorators: [],
    callees: [],
    typeRefs: [],
    contentHash: 'abcdef0123456789',
    ...overrides,
  };
}

test('external-package IMPORTS edge produces no statement and no RETURN 1 no-ops', () => {
  const changeset = emptyChangeset({
    edgesToAdd: [
      {
        kind: 'IMPORTS',
        fromFile: `${REPO_ROOT}/src/sync/sync-pipeline.ts`,
        moduleSpecifier: 'neo4j-driver',
        importedNames: ['Driver'],
      },
      {
        kind: 'IMPORTS',
        fromFile: `${REPO_ROOT}/src/mcp-server/index.ts`,
        moduleSpecifier: '@modelcontextprotocol/sdk/server/mcp.js',
        importedNames: ['McpServer'],
      },
    ],
  });

  const statements = buildMutations(changeset);
  assert.equal(statements.length, 0, 'external imports yield zero statements');
});

test('relative IMPORTS edge merges two distinct Module nodes (no self-loop)', () => {
  // src/mcp-server/tools is a real subdirectory of this repo, making the
  // './tools' specifier deterministic against the resolver's fs checks.
  const sourceDir = `${REPO_ROOT}/src/mcp-server`;
  const targetDir = `${REPO_ROOT}/src/mcp-server/tools`;
  assert.ok(fs.existsSync(targetDir), 'precondition: src/mcp-server/tools exists');

  const fromFile = `${sourceDir}/index.ts`;
  const changeset = emptyChangeset({
    edgesToAdd: [
      {
        kind: 'IMPORTS',
        fromFile,
        moduleSpecifier: './tools',
        importedNames: ['registerTools'],
      },
    ],
  });

  const statements = buildMutations(changeset);
  assert.equal(statements.length, 1, 'one IMPORTS statement generated');

  const stmt = statements[0];
  assert.ok(stmt.cypher.includes('MERGE (source:Module'), 'merges source Module node');
  assert.ok(stmt.cypher.includes('MERGE (target:Module'), 'merges target Module node');
  assert.ok(stmt.cypher.includes('->(target)'), 'edge points at the target node');
  assert.ok(!stmt.cypher.includes('->(m)'), 'no single-node self-loop pattern');

  assert.equal(stmt.params.fromFile, fromFile);
  assert.equal(stmt.params.dirPath, sourceDir);
  assert.notEqual(stmt.params.targetPath, undefined, 'targetPath resolved');
  assert.equal(stmt.params.targetPath.replace(/\\/g, '/'), targetDir);
  assert.notEqual(stmt.params.targetPath, stmt.params.dirPath, 'source and target Modules differ');
});

test('relative import resolving to its own directory is dropped (self-loop guard)', () => {
  const changeset = emptyChangeset({
    edgesToAdd: [
      {
        kind: 'IMPORTS',
        fromFile: `${REPO_ROOT}/src/sync/mutation-builder.ts`,
        moduleSpecifier: './graph-differ.js',
        importedNames: ['Changeset'],
      },
    ],
  });

  const statements = buildMutations(changeset);
  assert.equal(statements.length, 0, 'same-directory import yields no statement');
});

test('nodesToDelete also deletes the attached CodeBlock', () => {
  const changeset = emptyChangeset({
    nodesToDelete: [
      { kind: 'function', name: 'oldFn', filePath: 'src/sync/example.ts' },
      { kind: 'type', name: 'OldType', filePath: 'src/sync/example.ts' },
    ],
  });

  const statements = buildMutations(changeset);
  assert.equal(statements.length, 2);
  for (const stmt of statements) {
    assert.match(stmt.cypher, /CodeBlock/, 'delete statement covers the CodeBlock');
    assert.match(stmt.cypher, /DETACH DELETE/, 'uses DETACH DELETE');
  }
  assert.ok(statements[0].cypher.includes('(n:Function'), 'function delete targets Function label');
  assert.ok(statements[1].cypher.includes('(n:Type'), 'type delete targets Type label');
});

test('nodesToCreate function uses MERGE (not MATCH) for the Module CONTAINS attachment', () => {
  const fn = makeParsedFunction();
  const changeset = emptyChangeset({
    nodesToCreate: [{ kind: 'function', data: fn }],
  });

  const statements = buildMutations(changeset);
  assert.ok(statements.length >= 1);

  const nodeStmt = statements[0];
  assert.ok(nodeStmt.cypher.includes('MERGE (f:Function'), 'function node merged');
  assert.ok(nodeStmt.cypher.includes('MERGE (m:Module'), 'Module attachment uses MERGE');
  assert.ok(!nodeStmt.cypher.includes('MATCH (m:Module'), 'Module attachment must not use MATCH');
  assert.ok(nodeStmt.cypher.includes('MERGE (m)-[:CONTAINS]->(f)'), 'CONTAINS edge merged');
});

test('deletedFiles generate the 5 per-label DETACH DELETE statements', () => {
  const changeset = emptyChangeset({ deletedFiles: ['src/sync/removed.ts'] });

  const statements = buildMutations(changeset);
  assert.equal(statements.length, 5, 'exactly five statements per deleted file');

  const labels = ['CodeBlock', 'Function', 'Type', 'File', 'Module'];
  for (const label of labels) {
    const stmt = statements.find(s => s.cypher.includes(`:${label} {filePath: $filePath}`));
    assert.ok(stmt, `per-label delete for ${label} present`);
    assert.match(stmt.cypher, /DETACH DELETE/);
    assert.equal(stmt.params.filePath, 'src/sync/removed.ts');
  }
});

test('no statement anywhere in a mixed changeset is a RETURN 1 no-op', () => {
  const changeset = emptyChangeset({
    deletedFiles: ['src/sync/removed.ts'],
    nodesToDelete: [{ kind: 'function', name: 'gone', filePath: 'src/sync/a.ts' }],
    nodesToCreate: [{ kind: 'function', data: makeParsedFunction() }],
    edgesToAdd: [
      {
        kind: 'IMPORTS',
        fromFile: `${REPO_ROOT}/src/sync/sync-pipeline.ts`,
        moduleSpecifier: 'ts-morph',
        importedNames: ['Project'],
      },
      {
        kind: 'IMPORTS',
        fromFile: `${REPO_ROOT}/src/mcp-server/index.ts`,
        moduleSpecifier: './tools',
        importedNames: ['registerTools'],
      },
    ],
    edgesToRemove: [
      { kind: 'IMPORTS', fromFile: 'src/sync/a.ts', moduleSpecifier: './b.js' },
    ],
  });

  const statements = buildMutations(changeset);
  assert.ok(statements.length > 0);
  for (const stmt of statements) {
    assert.ok(!/RETURN\s+1/.test(stmt.cypher), `no RETURN 1 no-op: ${stmt.cypher.slice(0, 60)}`);
  }
});
