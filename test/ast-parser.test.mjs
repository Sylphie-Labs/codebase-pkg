/**
 * Tests for dist/sync/ast-parser.js (TypeScript extraction via ts-morph).
 *
 * Fixtures are written to a temp directory outside the repo so the parser's
 * repo-root/tsconfig discovery does not interfere.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseFiles } from '../dist/sync/ast-parser.js';

const HASH_RE = /^[0-9a-f]{16}$/;

/** Normalize to forward slashes, matching the parser's output convention. */
function fwd(p) {
  return p.replace(/\\/g, '/');
}

const FIXTURE_SOURCE = `import defaultThing from './local-module.js';
import * as path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Adds two numbers together.
 */
export function add(first: number, second: number): number {
  return first + second;
}

export function withDefaults(base: number, step = 1, label: string = 'x'): number {
  return base + step;
}

function internalHelper(): void {
  console.log('noise');
  JSON.stringify({ a: 1 });
  loadConfig();
}

export const fetchUser = async (id: string): Promise<UserDto> => {
  const raw = await loadRaw(id);
  console.log('loaded', raw);
  return JSON.parse(raw) as UserDto;
};

export interface UserDto {
  id: string;
  name: string;
}

export type UserId = string;

export enum Color {
  Red = 'red',
  Blue = 'blue',
}

@Controller('users')
export class UsersController {
  @Get(':id')
  async findOne(id: string): Promise<UserDto> {
    const user = this.lookup(id);
    console.log(user);
    return user;
  }

  private lookup(id: string): UserDto {
    return { id, name: 'someone' };
  }
}
`;

let tmpDir;
let fixturePath;
let parsed;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-ast-'));
  fixturePath = path.join(tmpDir, 'fixture.ts');
  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, 'utf8');
  const results = parseFiles([fixturePath]);
  assert.equal(results.length, 1, 'fixture file should parse without being skipped');
  parsed = results[0];
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('file-level metadata is extracted and path is forward-slash normalized', () => {
  assert.equal(parsed.filePath, fwd(fixturePath));
  assert.equal(parsed.fileName, 'fixture.ts');
  assert.equal(parsed.extension, '.ts');
  assert.ok(parsed.lineCount > 30, `lineCount sane (got ${parsed.lineCount})`);
});

test('named function declaration: JSDoc, typed args, return type, flags', () => {
  const add = parsed.functions.find(f => f.name === 'add');
  assert.ok(add, 'add() extracted');
  assert.equal(add.jsDoc, 'Adds two numbers together.');
  assert.deepEqual(add.args, [
    { name: 'first', type: 'number', hasDefault: false },
    { name: 'second', type: 'number', hasDefault: false },
  ]);
  assert.equal(add.returnType, 'number');
  assert.equal(add.isExported, true);
  assert.equal(add.isAsync, false);
  assert.match(add.contentHash, HASH_RE);
  assert.ok(add.lineNumber >= 1, 'lineNumber >= 1');
  assert.ok(add.endLine >= add.lineNumber, 'endLine >= lineNumber');
});

test('default parameters captured: hasDefault flag and defaultText (additive fields)', () => {
  const fn = parsed.functions.find(f => f.name === 'withDefaults');
  assert.ok(fn, 'withDefaults() extracted');
  assert.deepEqual(fn.args, [
    { name: 'base', type: 'number', hasDefault: false },
    { name: 'step', type: 'unknown', hasDefault: true, defaultText: '1' },
    { name: 'label', type: 'string', hasDefault: true, defaultText: "'x'" },
  ]);
});

test('non-exported function has isExported false and builtin callees filtered', () => {
  const helper = parsed.functions.find(f => f.name === 'internalHelper');
  assert.ok(helper, 'internalHelper() extracted');
  assert.equal(helper.isExported, false);
  assert.ok(!helper.callees.includes('console.log'), 'console.log excluded from callees');
  assert.ok(!helper.callees.includes('JSON.stringify'), 'JSON.stringify excluded from callees');
  assert.ok(helper.callees.includes('loadConfig'), 'real callee kept');
});

test('exported arrow function: isExported, isAsync, typeRefs exclude builtin wrappers', () => {
  const fn = parsed.functions.find(f => f.name === 'fetchUser');
  assert.ok(fn, 'fetchUser arrow function extracted');
  assert.equal(fn.isExported, true);
  assert.equal(fn.isAsync, true);
  assert.equal(fn.returnType, 'Promise<UserDto>');
  assert.ok(fn.typeRefs.includes('UserDto'), 'UserDto kept in typeRefs');
  assert.ok(!fn.typeRefs.includes('Promise'), 'Promise builtin wrapper excluded from typeRefs');
  assert.ok(fn.callees.includes('loadRaw'), 'loadRaw kept in callees');
  assert.ok(!fn.callees.includes('console.log'), 'console.log excluded');
  assert.ok(!fn.callees.includes('JSON.parse'), 'JSON.parse excluded');
  assert.match(fn.contentHash, HASH_RE);
});

test('class methods use ClassName.method naming and strip this. from callees', () => {
  const names = parsed.functions.map(f => f.name);
  assert.ok(names.includes('UsersController.findOne'), 'findOne uses ClassName.method naming');
  assert.ok(names.includes('UsersController.lookup'), 'lookup uses ClassName.method naming');

  const findOne = parsed.functions.find(f => f.name === 'UsersController.findOne');
  assert.equal(findOne.isAsync, true);
  assert.equal(findOne.isExported, true, 'method inherits class export status');
  assert.ok(findOne.callees.includes('lookup'), 'this.lookup recorded as lookup');
  assert.ok(findOne.endLine >= findOne.lineNumber);
});

test('NestJS @Get under @Controller yields httpMethod and joined routePath', () => {
  const findOne = parsed.functions.find(f => f.name === 'UsersController.findOne');
  assert.equal(findOne.httpMethod, 'GET');
  assert.equal(findOne.routePath, '/users/:id');
  const getDec = findOne.decorators.find(d => d.name === 'Get');
  assert.ok(getDec, '@Get decorator captured');
  assert.deepEqual(getDec.args, [':id']);
});

test('interface extraction: kind and properties', () => {
  const iface = parsed.types.find(t => t.name === 'UserDto');
  assert.ok(iface, 'UserDto extracted');
  assert.equal(iface.kind, 'interface');
  assert.deepEqual(iface.properties, [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
  ]);
  assert.match(iface.contentHash, HASH_RE);
});

test('type alias and enum extraction: kinds and enum member values', () => {
  const alias = parsed.types.find(t => t.name === 'UserId');
  assert.ok(alias, 'UserId extracted');
  assert.equal(alias.kind, 'type');

  const en = parsed.types.find(t => t.name === 'Color');
  assert.ok(en, 'Color enum extracted');
  assert.equal(en.kind, 'enum');
  assert.deepEqual(en.properties, [
    { name: 'Red', type: 'red' },
    { name: 'Blue', type: 'blue' },
  ]);
});

test('class type entry carries Controller decorator', () => {
  const cls = parsed.types.find(t => t.name === 'UsersController');
  assert.ok(cls, 'class extracted as a type entry');
  assert.equal(cls.kind, 'class');
  const dec = cls.decorators.find(d => d.name === 'Controller');
  assert.ok(dec, '@Controller decorator captured');
  assert.deepEqual(dec.args, ['users']);
});

test('type entries capture bodyText (declaration source, used to embed for conformity)', () => {
  // Every parsed type/class carries its declaration's source text as bodyText,
  // mirroring functions. The conformity judge embeds this (lightly normalized).
  const iface = parsed.types.find(t => t.name === 'UserDto');
  assert.ok(iface.bodyText && iface.bodyText.length > 0, 'interface bodyText captured');
  assert.match(iface.bodyText, /interface UserDto/);
  assert.match(iface.bodyText, /id: string/);

  const alias = parsed.types.find(t => t.name === 'UserId');
  assert.ok(alias.bodyText.includes('UserId'), 'type-alias bodyText captured');

  const en = parsed.types.find(t => t.name === 'Color');
  assert.ok(en.bodyText.includes('Red'), 'enum bodyText captured');

  const cls = parsed.types.find(t => t.name === 'UsersController');
  assert.ok(cls.bodyText.includes('class UsersController'), 'class bodyText captured');
});

test('imports: named, default, and namespace forms', () => {
  const bySpec = new Map(parsed.imports.map(i => [i.moduleSpecifier, i]));

  const def = bySpec.get('./local-module.js');
  assert.ok(def, 'default import captured');
  assert.deepEqual(def.importedNames, ['defaultThing']);

  const ns = bySpec.get('node:path');
  assert.ok(ns, 'namespace import captured');
  assert.deepEqual(ns.importedNames, ['* as path']);

  const named = bySpec.get('node:fs/promises');
  assert.ok(named, 'named imports captured');
  assert.deepEqual(named.importedNames, ['readFile', 'writeFile']);

  for (const imp of parsed.imports) {
    assert.equal(imp.fromFile, fwd(fixturePath), 'fromFile is the normalized fixture path');
  }
});
