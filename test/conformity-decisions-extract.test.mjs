/**
 * Tests for the decision-conformity EXTRACTOR
 * (dist/conformity/decisions/extract.js).
 *
 * Fixtures are written to a temp directory (like test/ast-parser.test.mjs) so
 * the extractor reads real ts-morph ASTs of hand-written functions and we
 * assert the categorical decision facts it produces. Deterministic, no DB/model.
 *
 * Run after `npm run build`:
 *   node --test test/conformity-decisions-extract.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { extractDecisionsFromFile } from '../dist/conformity/index.js';

const FIXTURE = `
export function bracketConstAwait(items: number[]): Promise<number> {
  const total = await sum(items);
  return total;
}

export const arrowGenericConcat = (xs: Array<string>): string => {
  let out = 'x';
  return out + '!';
};

function notExportedTemplate(): string {
  const name = 'a';
  return \`hi \${name}\`;
}

export class Widget {
  render(label: string): string {
    return \`<\${label}>\`;
  }
}
`;

let tmpDir;
let file;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-decisions-'));
  file = path.join(tmpDir, 'fixture.ts');
  fs.writeFileSync(file, FIXTURE, 'utf8');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function byName(facts, name) {
  const f = facts.find((x) => x.name === name);
  assert.ok(f, `expected a fact for ${name}`);
  return f;
}

test('extracts a fact per function-like (named fn, arrow const, non-exported fn, method)', () => {
  const facts = extractDecisionsFromFile(file);
  const names = facts.map((f) => f.name).sort();
  assert.deepEqual(names, [
    'Widget.render',
    'arrowGenericConcat',
    'bracketConstAwait',
    'notExportedTemplate',
  ]);
});

test('bracketConstAwait: bracket array, const, async-await, named export', () => {
  const f = byName(extractDecisionsFromFile(file), 'bracketConstAwait');
  assert.equal(f.array_syntax, 'bracket'); // number[]
  assert.equal(f.var_decl, 'const');
  assert.equal(f.async_style, 'async-await'); // await in body
  assert.equal(f.export_style, 'named');
  // string_style: builds no strings -> absence value
  assert.equal(f.string_style, 'none');
});

test('arrowGenericConcat: generic array, let, concat strings, named export', () => {
  const f = byName(extractDecisionsFromFile(file), 'arrowGenericConcat');
  assert.equal(f.array_syntax, 'generic'); // Array<string>
  assert.equal(f.var_decl, 'let');
  assert.equal(f.string_style, 'concat'); // out + '!'
  assert.equal(f.async_style, 'sync');
  assert.equal(f.export_style, 'named');
});

test('notExportedTemplate: template literal, const, not exported (absence)', () => {
  const f = byName(extractDecisionsFromFile(file), 'notExportedTemplate');
  assert.equal(f.string_style, 'template-literal');
  assert.equal(f.var_decl, 'const');
  assert.equal(f.export_style, 'none'); // not exported
  assert.equal(f.array_syntax, 'none'); // no array types
});

test('Widget.render: method inherits the class export style; template string', () => {
  const f = byName(extractDecisionsFromFile(file), 'Widget.render');
  assert.equal(f.export_style, 'named'); // class is exported
  assert.equal(f.string_style, 'template-literal');
  assert.equal(f.var_decl, 'none'); // no local var decls
});

test('facts carry filePath (forward-slashed) and a line number', () => {
  const f = byName(extractDecisionsFromFile(file), 'bracketConstAwait');
  assert.ok(!f.filePath.includes('\\'));
  assert.equal(typeof f.lineNumber, 'number');
  assert.ok(f.lineNumber > 0);
});
