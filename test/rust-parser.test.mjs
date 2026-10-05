/**
 * Tests for dist/sync/rust-parser.js (Rust extraction via web-tree-sitter in
 * a child process).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseRustFiles } from '../dist/sync/rust-parser.js';

const HASH_RE = /^[0-9a-f]{16}$/;

function fwd(p) {
  return p.replace(/\\/g, '/');
}

const SOURCE = `use std::collections::HashMap;
use std::collections::hash_map::Entry as E;
use std::fmt::{self, Display};
use crate::util::*;
extern crate foo;
mod ext;

/// Adds things.
/// Second line.
pub async fn add(a: i32, b: &str) -> Result<Foo, Bar> {
    let x = helper(a);
    let y = Foo::new();
    self.go();
    obj.run(1);
    println!("hi");
    x
}

fn private_fn() {}

pub struct Point { pub x: i32, y: Vec<String> }
pub struct Pair(i32, String);
#[derive(Debug, Clone)]
pub enum Color { Red, Green(i32), Blue { r: u8 } }
pub trait Draw: Display {
    fn draw(&self);
    fn name(&self) -> String { String::new() }
}
impl Point {
    pub fn new() -> Self { Point { x: 1, y: vec![] } }
    fn hidden(&self) {}
    pub const ORIGIN: i32 = 0;
}
impl Draw for Point {
    fn draw(&self) {}
}
pub struct Wrapper<T> { v: T }
impl<T> Wrapper<T> { fn get(&self) {} }
pub const MAX: usize = 10;
static NAME: &str = "n";
mod inner {
    pub struct S;
    pub fn f() {}
}
#[cfg(test)]
mod tests {
    fn t() {}
}
#[test]
fn a_test() {}
#[get("/x")]
async fn handler() {}
`;

test('rust extraction', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-rs-'));
  const goodPath = path.join(tmpDir, 'good.rs');

  try {
    fs.writeFileSync(goodPath, SOURCE, 'utf8');
    const results = parseRustFiles([goodPath]);
    assert.equal(results.length, 1);
    const parsed = results[0];
    assert.equal(parsed.filePath, fwd(goodPath));
    assert.equal(parsed.fileName, 'good.rs');
    assert.equal(parsed.extension, '.rs');
    assert.ok(parsed.lineCount > 40, `lineCount sane (got ${parsed.lineCount})`);

    const fn = new Map(parsed.functions.map(f => [f.name, f]));
    const ty = new Map(parsed.types.map(x => [x.name, x]));
    const cn = new Map(parsed.constants.map(x => [x.name, x]));

    await t.test('free fn: args, return, async, pub, doc comment, hash', () => {
      const f = fn.get('add');
      assert.ok(f, 'add extracted');
      assert.deepEqual(
        f.args.map(a => ({ name: a.name, type: a.type })),
        [{ name: 'a', type: 'i32' }, { name: 'b', type: '&str' }],
      );
      assert.equal(f.returnType, 'Result<Foo, Bar>');
      assert.equal(f.isAsync, true);
      assert.equal(f.isExported, true);
      assert.equal(f.jsDoc, 'Adds things.\nSecond line.');
      assert.match(f.contentHash, HASH_RE);
      assert.ok(f.lineNumber >= 1 && f.endLine >= f.lineNumber);
      assert.ok(f.bodyText.includes('helper(a)'));
      assert.equal(fn.get('private_fn').isExported, false);
      assert.equal(fn.get('private_fn').isAsync, false);
    });

    await t.test('callees: plain, scoped, method call; macros excluded', () => {
      const c = fn.get('add').callees;
      assert.ok(c.includes('helper'), 'plain call');
      assert.ok(c.includes('Foo::new'), 'scoped call');
      assert.ok(c.includes('go'), 'self.go() -> go');
      assert.ok(c.includes('run'), 'obj.run() -> run');
      assert.ok(!c.some(x => x.includes('println')), 'macro not a callee');
    });

    await t.test('typeRefs keep user types and filter primitives', () => {
      const r = fn.get('add').typeRefs;
      assert.ok(r.includes('Foo'));
      assert.ok(r.includes('Bar'));
      assert.ok(!r.includes('i32'));
      assert.ok(!r.includes('str'));
      assert.ok(!r.includes('Result'));
    });

    await t.test('struct named + tuple fields become class properties', () => {
      const p = ty.get('Point');
      assert.equal(p.kind, 'class');
      assert.deepEqual(p.properties, [
        { name: 'x', type: 'i32' },
        { name: 'y', type: 'Vec<String>' },
      ]);
      assert.deepEqual(ty.get('Pair').properties, [
        { name: '0', type: 'i32' },
        { name: '1', type: 'String' },
      ]);
    });

    await t.test('enum variants become properties; derive becomes decorator', () => {
      const e = ty.get('Color');
      assert.equal(e.kind, 'enum');
      assert.deepEqual(e.properties.map(p => p.name), ['Red', 'Green', 'Blue']);
      assert.deepEqual(e.decorators, [{ name: 'derive', args: ['Debug', 'Clone'] }]);
    });

    await t.test('trait -> interface with Trait.method incl. bodyless signature', () => {
      const d = ty.get('Draw');
      assert.equal(d.kind, 'interface');
      assert.equal(d.extends, 'Display');
      const sig = fn.get('Draw.draw');
      assert.ok(sig, 'bodyless signature extracted');
      assert.equal(sig.isExported, true);
      assert.ok(fn.get('Draw.name'), 'default method extracted');
      assert.ok(fn.get('Draw.name').callees.includes('String::new'));
    });

    await t.test('inherent impl methods: Type.method with own visibility', () => {
      assert.equal(fn.get('Point.new').isExported, true);
      assert.equal(fn.get('Point.hidden').isExported, false);
    });

    await t.test('trait impl adds to implements; its methods are exported', () => {
      assert.deepEqual(ty.get('Point').implements, ['Draw']);
      assert.equal(fn.get('Point.draw').isExported, true);
    });

    await t.test("generic impl 'impl<T> Wrapper<T>' resolves base Wrapper", () => {
      assert.ok(fn.get('Wrapper.get'), 'Wrapper.get extracted');
      assert.ok(ty.get('Wrapper'));
    });

    await t.test('const/static -> constants', () => {
      assert.equal(cn.get('MAX').kind, 'const');
      assert.equal(cn.get('MAX').isExported, true);
      assert.equal(cn.get('NAME').isExported, false);
      assert.ok(cn.get('Point.ORIGIN'), 'associated const');
      assert.match(cn.get('MAX').contentHash, HASH_RE);
    });

    await t.test('use flattening grouped by specifier; extern crate; mod foo;', () => {
      const imp = new Map(parsed.imports.map(i => [i.moduleSpecifier, i]));
      assert.deepEqual(imp.get('std::collections').importedNames, ['HashMap']);
      assert.deepEqual(imp.get('std::collections::hash_map').importedNames, ['Entry']);
      assert.deepEqual(imp.get('std').importedNames, ['fmt']);
      assert.deepEqual(imp.get('std::fmt').importedNames, ['Display']);
      assert.deepEqual(imp.get('crate::util').importedNames, ['*']);
      assert.deepEqual(imp.get('foo').importedNames, ['foo']);
      assert.deepEqual(imp.get('self::ext').importedNames, ['ext']);
      for (const i of parsed.imports) assert.equal(i.fromFile, fwd(goodPath));
    });

    await t.test('inline module items carry module prefix', () => {
      assert.ok(fn.get('inner::f'));
      assert.ok(ty.get('inner::S'));
    });

    await t.test('#[cfg(test)] module and #[test] fn are excluded', () => {
      assert.ok(!fn.has('a_test'));
      assert.ok(!fn.has('t'));
      assert.ok(!fn.has('tests::t'));
    });

    await t.test('actix-style #[get("/x")] yields httpMethod/routePath', () => {
      const h = fn.get('handler');
      assert.equal(h.httpMethod, 'GET');
      assert.equal(h.routePath, '/x');
      assert.equal(h.isAsync, true);
      assert.deepEqual(h.decorators, [{ name: 'get', args: ['/x'] }]);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('syntax error file still returns partial results', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-rs-'));
  const p = path.join(tmpDir, 'broken.rs');
  try {
    fs.writeFileSync(p, 'pub fn ok() -> i32 { 1 }\n\nfn broken( { let = ;\n', 'utf8');
    const results = parseRustFiles([p]);
    assert.equal(results.length, 1);
    assert.ok(results[0].functions.some(f => f.name === 'ok'), 'ok survives');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('contentHash stable across runs and changes with body', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-rs-'));
  const p = path.join(tmpDir, 'h.rs');
  try {
    fs.writeFileSync(p, 'pub fn f() -> i32 { 1 }\n', 'utf8');
    const a = parseRustFiles([p])[0].functions[0].contentHash;
    const b = parseRustFiles([p])[0].functions[0].contentHash;
    assert.match(a, HASH_RE);
    assert.equal(a, b);
    fs.writeFileSync(p, 'pub fn f() -> i32 { 2 }\n', 'utf8');
    const c = parseRustFiles([p])[0].functions[0].contentHash;
    assert.notEqual(a, c);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Windows backslash path is normalised', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-rs-'));
  const p = path.join(tmpDir, 'w.rs');
  try {
    fs.writeFileSync(p, 'fn w() {}\n', 'utf8');
    const results = parseRustFiles([p.replace(/\//g, '\\')]);
    assert.equal(results.length, 1);
    assert.ok(!results[0].filePath.includes('\\'));
    assert.equal(results[0].filePath, fwd(p));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('empty input returns empty array', () => {
  assert.deepEqual(parseRustFiles([]), []);
});

test('trait impl on scoped self type attaches to the module type; trait-impl const respects visibility', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbpkg-rs-'));
  const p = path.join(tmpDir, 'scoped.rs');
  try {
    fs.writeFileSync(
      p,
      `mod a { pub struct Foo; }
impl Display for a::Foo {
    const PRIV: u32 = 1;
    pub const PUB: u32 = 2;
    fn fmt(&self) {}
}
`,
      'utf8'
    );
    const r = parseRustFiles([p])[0];
    const foo = r.types.find(t => t.name === 'a::Foo');
    assert.ok(foo);
    assert.deepEqual(foo.implements, ['Display']);
    const priv = r.constants.find(c => c.name.endsWith('.PRIV'));
    const pub = r.constants.find(c => c.name.endsWith('.PUB'));
    assert.equal(priv.isExported, false);
    assert.equal(pub.isExported, true);
    assert.equal(r.functions.find(f => f.name.endsWith('.fmt')).isExported, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
