/**
 * Tests for getModuleContext (dist/mcp-server/tools/getModuleContext.js),
 * MCP-SERVER-IMPROVEMENTS.md #10 (`format: "json"`).
 *
 * PURE logic only -- NO live Neo4j: `runQuery` is injected via `deps.runQuery`
 * (mirrors graph-ref-validator.js's pattern) so the gather step is testable
 * without a live driver. No unit test previously existed for this tool (it
 * was Neo4j-only with no DI); this file also covers the pre-existing text
 * render to guard the #10 refactor (gather -> render text/json) against
 * silently changing the original output shape.
 *
 * Run after `npm run build`:
 *   node --test test/get-module-context.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleGetModuleContext,
  gatherModuleContext,
  renderModuleContextText,
} from '../dist/mcp-server/tools/getModuleContext.js';

/** A fake neo4j-driver Record: only `.get(field)` is used by this module. */
function fakeRecord(obj) {
  return { get: (field) => obj[field] ?? null };
}

function makeRunQuery(responses) {
  let call = 0;
  const calls = [];
  const runQuery = async (cypher, params) => {
    calls.push({ cypher, params });
    const response = responses[call] ?? [];
    call += 1;
    return response;
  };
  runQuery.calls = calls;
  return runQuery;
}

const moduleRow = fakeRecord({ moduleName: 'auth', filePath: 'C:/repo/src/auth.ts', packageName: 'auth-pkg', serviceName: 'auth-service' });
const functionRow = fakeRecord({ name: 'login', filePath: 'C:/repo/src/auth.ts', lineNumber: 10, arguments: 'user, pass', returnType: 'Promise<void>', comment: 'Logs a user in.', isAsync: true, isExported: true, moduleName: 'auth' });
const typeRow = fakeRecord({ name: 'Credentials', filePath: 'C:/repo/src/auth.ts', kind: 'interface', moduleName: 'auth' });
const constraintRow = fakeRecord({ description: 'never log passwords', severity: 'high', moduleName: 'auth' });

// ---------------------------------------------------------------------------
// gatherModuleContext
// ---------------------------------------------------------------------------

test('gatherModuleContext returns null when no modules/services/functions matched', async () => {
  const runQuery = makeRunQuery([[]]);
  const result = await gatherModuleContext('nonexistent', runQuery);
  assert.equal(result, null);
  assert.equal(runQuery.calls.length, 1, 'stops after the module query -- no function/type/constraint follow-up queries');
});

test('gatherModuleContext structures modules/functions/types/constraints from the four Neo4j queries', async () => {
  const runQuery = makeRunQuery([[moduleRow], [functionRow], [typeRow], [constraintRow]]);
  const result = await gatherModuleContext('auth', runQuery);

  assert.equal(result.query, 'auth');
  assert.deepEqual(result.modules, [
    { name: 'auth', filePath: 'C:/repo/src/auth.ts', packageName: 'auth-pkg', service: 'auth-service' },
  ]);
  assert.deepEqual(result.functions, [
    { name: 'login', module: 'auth', filePath: 'C:/repo/src/auth.ts', lineNumber: 10, args: 'user, pass', returnType: 'Promise<void>', comment: 'Logs a user in.', isAsync: true, isExported: true },
  ]);
  assert.deepEqual(result.types, [
    { name: 'Credentials', module: 'auth', filePath: 'C:/repo/src/auth.ts', kind: 'interface' },
  ]);
  assert.deepEqual(result.constraints, [
    { module: 'auth', description: 'never log passwords', severity: 'high' },
  ]);
});

test('gatherModuleContext escapes regex-special characters in the query before building the Cypher pattern', async () => {
  const runQuery = makeRunQuery([[]]);
  await gatherModuleContext('a.b+c', runQuery);
  assert.match(runQuery.calls[0].params.pattern, /a\\\.b\\\+c/);
});

// ---------------------------------------------------------------------------
// renderModuleContextText -- guards the #10 refactor against changing the
// pre-existing text output shape.
// ---------------------------------------------------------------------------

test('renderModuleContextText renders modules/functions/types/constraints sections with signatures + file paths', () => {
  const text = renderModuleContextText({
    query: 'auth',
    modules: [{ name: 'auth', filePath: 'C:/repo/src/auth.ts', packageName: 'auth-pkg', service: 'auth-service' }],
    functions: [{ name: 'login', module: 'auth', filePath: 'C:/repo/src/auth.ts', lineNumber: 10, args: 'user, pass', returnType: 'Promise<void>', comment: 'Logs a user in.', isAsync: true, isExported: true }],
    types: [{ name: 'Credentials', module: 'auth', filePath: 'C:/repo/src/auth.ts', kind: 'interface' }],
    constraints: [{ module: 'auth', description: 'never log passwords', severity: 'high' }],
  });

  assert.match(text, /MODULE CONTEXT: "auth"/);
  assert.match(text, /MATCHED MODULES \(1\)/);
  assert.match(text, /Service: auth-service/);
  assert.match(text, /Package: auth-pkg/);
  assert.match(text, /export async function login\(user, pass\): Promise<void>/);
  assert.match(text, /File: C:\/repo\/src\/auth\.ts:10/);
  assert.match(text, /\/\/ Logs a user in\./);
  assert.match(text, /TYPES \(1\)/);
  assert.match(text, /Credentials \(interface\)/);
  assert.match(text, /CONSTRAINTS \(1\)/);
  assert.match(text, /\[high\] \(auth\) never log passwords/);
  assert.match(text, /Use getFunctionDetail/);
});

// ---------------------------------------------------------------------------
// handleGetModuleContext
// ---------------------------------------------------------------------------

test('handleGetModuleContext: no-match text message when nothing matched', async () => {
  const runQuery = makeRunQuery([[]]);
  const text = await handleGetModuleContext({ query: 'nonexistent' }, { runQuery });
  assert.match(text, /No modules, services, or functions found matching "nonexistent"/);
});

test('handleGetModuleContext: format "json" on a no-match query returns an empty-but-valid envelope (not the text message)', async () => {
  const runQuery = makeRunQuery([[]]);
  const text = await handleGetModuleContext({ query: 'nonexistent', format: 'json' }, { runQuery });
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tool, 'getModuleContext');
  assert.deepEqual(parsed.modules, []);
});

test('handleGetModuleContext: format "json" returns a parseable, versioned envelope with the full structured data', async () => {
  const runQuery = makeRunQuery([[moduleRow], [functionRow], [typeRow], [constraintRow]]);
  const text = await handleGetModuleContext({ query: 'auth', format: 'json' }, { runQuery });
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tool, 'getModuleContext');
  assert.equal(parsed.query, 'auth');
  assert.equal(parsed.modules.length, 1);
  assert.equal(parsed.functions[0].name, 'login');
  assert.equal(parsed.types[0].name, 'Credentials');
  assert.equal(parsed.constraints[0].description, 'never log passwords');
});

test('handleGetModuleContext: default format is text and matches renderModuleContextText', async () => {
  const runQuery = makeRunQuery([[moduleRow], [], [], []]);
  const text = await handleGetModuleContext({ query: 'auth' }, { runQuery });
  assert.match(text, /MODULE CONTEXT: "auth"/);
  assert.doesNotMatch(text, /^\{/);
});
