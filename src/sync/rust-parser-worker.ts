/**
 * rust-parser-worker.ts -- Standalone Node entry script for Rust extraction.
 *
 * Runs as its own process (spawned by rust-parser.ts). Reads a JSON array of
 * file paths from STDIN, parses each .rs file with web-tree-sitter (vendored
 * tree-sitter-rust grammar), and writes a JSON array of ParsedFile to STDOUT.
 * Per-file problems are reported on STDERR and never crash the batch.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { Parser, Language } from 'web-tree-sitter';
import type { Node, Tree } from 'web-tree-sitter';
import type {
  ParsedFile,
  ParsedFunction,
  ParsedType,
  ParsedImport,
  ParsedConstant,
  ParsedDecorator,
  ParsedArgument,
  ParsedProperty,
} from './ast-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BODY_CAP = 8000;
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const TYPE_REF_EXCLUDE = new Set([
  'Self', 'Option', 'Result', 'Vec', 'String', 'Box', 'Rc', 'Arc', 'RefCell', 'Cell',
  'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'Cow', 'str',
]);

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function nonNull(nodes: (Node | null)[]): Node[] {
  return nodes.filter((n): n is Node => n !== null);
}

function body(text: string): string {
  return text.slice(0, BODY_CAP);
}

/** Split on top-level commas (respecting brackets and string literals). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === '\\' && i + 1 < text.length) {
        cur += text[++i];
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
      cur += c;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

// ---------------------------------------------------------------------------
// Attributes and doc comments
// ---------------------------------------------------------------------------

interface RawAttr {
  name: string;
  rawArgs: string[];
  fullText: string;
}

interface Preamble {
  attrs: RawAttr[];
  decorators: ParsedDecorator[];
  doc: string;
  isTest: boolean; // cfg(test) item or #[test]-style function
  isCfgTest: boolean;
  isTestFn: boolean;
}

function parseAttribute(item: Node): RawAttr | null {
  const attr = item.namedChildren.find(c => c !== null && c.type === 'attribute') ?? null;
  if (!attr) return null;
  const argsNode = attr.childForFieldName('arguments');
  const nameNode = attr.namedChildren.find(c => c !== null && c.id !== argsNode?.id) ?? null;
  const name = nameNode ? nameNode.text : '';
  let rawArgs: string[] = [];
  if (argsNode && argsNode.type === 'token_tree') {
    const t = argsNode.text;
    rawArgs = splitTopLevel(t.slice(1, -1));
  }
  return { name, rawArgs, fullText: attr.text.replace(/\s+/g, '') };
}

function cleanDocLine(text: string): string {
  if (text.startsWith('///')) {
    const rest = text.slice(3).replace(/\r?\n$/, '');
    return rest.startsWith(' ') ? rest.slice(1) : rest;
  }
  return text;
}

function cleanBlockDoc(text: string): string {
  let t = text.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
  t = t
    .split('\n')
    .map(l => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
  return t;
}

function isDocComment(n: Node): boolean {
  if (n.type === 'line_comment') return n.text.startsWith('///') && !n.text.startsWith('////');
  if (n.type === 'block_comment') return n.text.startsWith('/**') && !n.text.startsWith('/***') && n.text !== '/**/';
  return false;
}

function getPreamble(siblings: Node[], index: number): Preamble {
  const attrs: RawAttr[] = [];
  const docs: string[] = [];
  const run: Node[] = [];
  for (let j = index - 1; j >= 0; j--) {
    const s = siblings[j];
    if (s.type === 'attribute_item' || s.type === 'line_comment' || s.type === 'block_comment') {
      run.unshift(s);
    } else {
      break;
    }
  }
  for (const n of run) {
    if (n.type === 'attribute_item') {
      const a = parseAttribute(n);
      if (a) attrs.push(a);
    } else if (isDocComment(n)) {
      docs.push(n.type === 'line_comment' ? cleanDocLine(n.text) : cleanBlockDoc(n.text));
    }
  }
  const decorators: ParsedDecorator[] = attrs.map(a => ({
    name: a.name,
    args: a.rawArgs.map(stripQuotes).filter(x => x.length > 0),
  }));
  const isCfgTest = attrs.some(a => a.fullText === 'cfg(test)');
  const isTestFn = attrs.some(a => a.name === 'test' || a.name.endsWith('::test'));
  return { attrs, decorators, doc: docs.join('\n'), isTest: isCfgTest || isTestFn, isCfgTest, isTestFn };
}

function httpInfo(attrs: RawAttr[]): { httpMethod?: string; routePath?: string } {
  for (const a of attrs) {
    const last = a.name.split('::').pop()?.toLowerCase() ?? '';
    if (HTTP_VERBS.has(last) && a.rawArgs.length > 0 && a.rawArgs[0].startsWith('"')) {
      return { httpMethod: last.toUpperCase(), routePath: stripQuotes(a.rawArgs[0]) };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Type / function helpers
// ---------------------------------------------------------------------------

function resolveType(n: Node | null): string {
  if (!n) return '';
  switch (n.type) {
    case 'type_identifier':
      return n.text;
    case 'generic_type':
      return resolveType(n.childForFieldName('type'));
    case 'scoped_type_identifier': {
      const nm = n.childForFieldName('name');
      return nm ? nm.text : n.text;
    }
    case 'reference_type':
    case 'pointer_type':
      return resolveType(n.childForFieldName('type'));
    default:
      return n.text;
  }
}

/** Module path segments of a scoped self type (`a::b::Foo` -> `a::b::`), minus a leading crate/self. */
function scopedTypePrefix(n: Node | null): string {
  if (!n) return '';
  switch (n.type) {
    case 'generic_type':
    case 'reference_type':
    case 'pointer_type':
      return scopedTypePrefix(n.childForFieldName('type'));
    case 'scoped_type_identifier': {
      const pathNode = n.childForFieldName('path');
      if (!pathNode) return '';
      const segs = pathNode.text.split('::').map(x => x.trim()).filter(x => x.length > 0);
      if (segs[0] === 'crate' || segs[0] === 'self') segs.shift();
      return segs.length ? segs.join('::') + '::' : '';
    }
    default:
      return '';
  }
}

function hasVisibility(node: Node): boolean {
  return node.namedChildren.some(c => c !== null && c.type === 'visibility_modifier');
}

function calleeName(fn: Node | null): string | null {
  if (!fn) return null;
  switch (fn.type) {
    case 'identifier':
    case 'scoped_identifier':
      return fn.text;
    case 'field_expression': {
      const f = fn.childForFieldName('field');
      return f ? f.text : null;
    }
    case 'generic_function':
      return calleeName(fn.childForFieldName('function'));
    default:
      return null;
  }
}

function collectCallees(bodyNode: Node | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!bodyNode) return out;
  for (const call of nonNull(bodyNode.descendantsOfType('call_expression'))) {
    const name = calleeName(call.childForFieldName('function'));
    if (!name || name.length > 80 || name.startsWith('self.')) continue;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function collectTypeRefs(nodes: (Node | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n) continue;
    const found: Node[] = [];
    if (n.type === 'type_identifier') found.push(n);
    found.push(...nonNull(n.descendantsOfType('type_identifier')));
    for (const t of found) {
      const name = t.text;
      if (TYPE_REF_EXCLUDE.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function extractArgs(params: Node | null): ParsedArgument[] {
  const args: ParsedArgument[] = [];
  if (!params) return args;
  for (const p of params.namedChildren) {
    if (!p) continue;
    if (p.type === 'parameter') {
      const pat = p.childForFieldName('pattern');
      const ty = p.childForFieldName('type');
      args.push({ name: pat ? pat.text : '', type: ty ? ty.text : '', hasDefault: false });
    } else if (p.type === 'self_parameter') {
      args.push({ name: 'self', type: p.text, hasDefault: false });
    }
  }
  return args;
}

function hasAsync(fn: Node): boolean {
  const mods = fn.namedChildren.find(c => c !== null && c.type === 'function_modifiers');
  if (!mods) return false;
  return mods.text.split(/\s+/).includes('async');
}

function buildFunction(
  fn: Node,
  preamble: Preamble,
  filePath: string,
  name: string,
  isExported: boolean
): ParsedFunction {
  const text = fn.text;
  const bodyNode = fn.childForFieldName('body');
  const params = fn.childForFieldName('parameters');
  const ret = fn.childForFieldName('return_type');
  const out: ParsedFunction = {
    name,
    filePath,
    lineNumber: fn.startPosition.row + 1,
    endLine: fn.endPosition.row + 1,
    args: extractArgs(params),
    returnType: ret ? ret.text : '()',
    jsDoc: preamble.doc,
    bodyText: body(text),
    isExported,
    isAsync: hasAsync(fn),
    decorators: preamble.decorators,
    callees: collectCallees(bodyNode),
    typeRefs: collectTypeRefs([params, ret, bodyNode]),
    contentHash: sha256(text),
  };
  const http = httpInfo(preamble.attrs);
  if (http.httpMethod) {
    out.httpMethod = http.httpMethod;
    out.routePath = http.routePath;
  }
  return out;
}

function buildConstant(
  node: Node,
  filePath: string,
  name: string,
  isExported: boolean
): ParsedConstant {
  const text = node.text;
  return {
    name,
    filePath,
    lineNumber: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    bodyText: body(text),
    isExported,
    kind: 'const',
    contentHash: sha256(text),
  };
}

function buildType(
  node: Node,
  preamble: Preamble,
  filePath: string,
  name: string,
  kind: ParsedType['kind'],
  properties: ParsedProperty[]
): ParsedType {
  const text = node.text;
  return {
    name,
    filePath,
    lineNumber: node.startPosition.row + 1,
    kind,
    properties,
    bodyText: body(text),
    comment: preamble.doc,
    decorators: preamble.decorators,
    implements: [],
    constructorParams: [],
    contentHash: sha256(text),
  };
}

function structProperties(node: Node): ParsedProperty[] {
  const props: ParsedProperty[] = [];
  const b = node.childForFieldName('body');
  if (!b) return props;
  if (b.type === 'field_declaration_list') {
    for (const f of b.namedChildren) {
      if (f && f.type === 'field_declaration') {
        const nm = f.childForFieldName('name');
        const ty = f.childForFieldName('type');
        props.push({ name: nm ? nm.text : '', type: ty ? ty.text : '' });
      }
    }
  } else if (b.type === 'ordered_field_declaration_list') {
    nonNull(b.childrenForFieldName('type')).forEach((t, i) => {
      props.push({ name: String(i), type: t.text });
    });
  }
  return props;
}

function enumProperties(node: Node): ParsedProperty[] {
  const props: ParsedProperty[] = [];
  const b = node.childForFieldName('body');
  if (!b) return props;
  for (const v of b.namedChildren) {
    if (v && v.type === 'enum_variant') {
      const nm = v.childForFieldName('name');
      const vb = v.childForFieldName('body');
      props.push({ name: nm ? nm.text : '', type: vb ? vb.text : '' });
    }
  }
  return props;
}

// ---------------------------------------------------------------------------
// use-tree flattening
// ---------------------------------------------------------------------------

function splitPath(text: string): string[] {
  return text
    .replace(/\s+/g, '')
    .split('::')
    .filter(s => s.length > 0);
}

function useLeaves(node: Node | null, prefix: string[]): string[][] {
  if (!node) return [];
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'self':
    case 'super':
    case 'metavariable':
      return [[...prefix, node.text]];
    case 'scoped_identifier':
      return [[...prefix, ...splitPath(node.text)]];
    case 'use_as_clause':
      return useLeaves(node.childForFieldName('path'), prefix);
    case 'use_wildcard': {
      const p = node.namedChildren.find(c => c !== null) ?? null;
      return [[...prefix, ...(p ? splitPath(p.text) : []), '*']];
    }
    case 'scoped_use_list': {
      const p = node.childForFieldName('path');
      const list = node.childForFieldName('list');
      const newPrefix = [...prefix, ...(p ? splitPath(p.text) : [])];
      return useLeaves(list, newPrefix);
    }
    case 'use_list': {
      const out: string[][] = [];
      for (const c of node.namedChildren) {
        if (c) out.push(...useLeaves(c, prefix));
      }
      return out;
    }
    default:
      return [];
  }
}

class ImportCollector {
  private map = new Map<string, string[]>();

  add(specifier: string, name: string): void {
    const names = this.map.get(specifier);
    if (!names) this.map.set(specifier, [name]);
    else if (!names.includes(name)) names.push(name);
  }

  addUse(decl: Node): void {
    const arg = decl.childForFieldName('argument');
    for (const segsIn of useLeaves(arg, [])) {
      let segs = segsIn;
      if (segs.length > 1 && segs[segs.length - 1] === 'self') segs = segs.slice(0, -1);
      if (segs.length === 0) continue;
      if (segs.length === 1) this.add(segs[0], segs[0]);
      else this.add(segs.slice(0, -1).join('::'), segs[segs.length - 1]);
    }
  }

  toImports(filePath: string): ParsedImport[] {
    return [...this.map.entries()].map(([moduleSpecifier, importedNames]) => ({
      fromFile: filePath,
      importedNames,
      moduleSpecifier,
    }));
  }
}

// ---------------------------------------------------------------------------
// File extraction
// ---------------------------------------------------------------------------

export function extractRustFile(filePath: string, source: string, tree: Tree): ParsedFile {
  const functions: ParsedFunction[] = [];
  const types: ParsedType[] = [];
  const constants: ParsedConstant[] = [];
  const imports = new ImportCollector();
  const pendingImpls: { prefix: string; base: string; trait: string }[] = [];

  function walkItems(container: Node, prefix: string): void {
    const siblings = container.namedChildren.filter((c): c is Node => c !== null);
    siblings.forEach((item, idx) => {
      switch (item.type) {
        case 'function_item': {
          const pre = getPreamble(siblings, idx);
          if (pre.isTest) return;
          const nm = item.childForFieldName('name');
          if (!nm) return;
          functions.push(buildFunction(item, pre, filePath, prefix + nm.text, hasVisibility(item)));
          return;
        }
        case 'impl_item': {
          const pre = getPreamble(siblings, idx);
          if (pre.isCfgTest) return;
          walkImpl(item, prefix);
          return;
        }
        case 'trait_item': {
          const pre = getPreamble(siblings, idx);
          if (pre.isCfgTest) return;
          walkTrait(item, pre, prefix);
          return;
        }
        case 'struct_item':
        case 'union_item': {
          const pre = getPreamble(siblings, idx);
          if (pre.isCfgTest) return;
          const nm = item.childForFieldName('name');
          if (!nm) return;
          types.push(buildType(item, pre, filePath, prefix + nm.text, 'class', structProperties(item)));
          return;
        }
        case 'enum_item': {
          const pre = getPreamble(siblings, idx);
          if (pre.isCfgTest) return;
          const nm = item.childForFieldName('name');
          if (!nm) return;
          types.push(buildType(item, pre, filePath, prefix + nm.text, 'enum', enumProperties(item)));
          return;
        }
        case 'type_item': {
          const pre = getPreamble(siblings, idx);
          if (pre.isCfgTest) return;
          const nm = item.childForFieldName('name');
          if (!nm) return;
          types.push(buildType(item, pre, filePath, prefix + nm.text, 'type', []));
          return;
        }
        case 'const_item':
        case 'static_item': {
          const pre = getPreamble(siblings, idx);
          if (pre.isCfgTest) return;
          const nm = item.childForFieldName('name');
          if (!nm) return;
          constants.push(buildConstant(item, filePath, prefix + nm.text, hasVisibility(item)));
          return;
        }
        case 'use_declaration': {
          const pre = getPreamble(siblings, idx);
          if (pre.isCfgTest) return;
          imports.addUse(item);
          return;
        }
        case 'extern_crate_declaration': {
          const pre = getPreamble(siblings, idx);
          if (pre.isCfgTest) return;
          const nm = item.childForFieldName('name');
          if (nm) imports.add(nm.text, nm.text);
          return;
        }
        case 'mod_item': {
          const pre = getPreamble(siblings, idx);
          if (pre.isCfgTest) return;
          const nm = item.childForFieldName('name');
          if (!nm) return;
          const b = item.childForFieldName('body');
          if (b) walkItems(b, `${prefix}${nm.text}::`);
          else imports.add('self::' + nm.text, nm.text);
          return;
        }
        default:
          return; // macro_rules!, foreign mods, comments, etc.
      }
    });
  }

  function walkImpl(impl: Node, prefix: string): void {
    const selfType = impl.childForFieldName('type');
    const base = resolveType(selfType);
    const lookupPrefix = prefix + scopedTypePrefix(selfType);
    const traitNode = impl.childForFieldName('trait');
    const isTraitImpl = traitNode !== null;
    if (traitNode) {
      pendingImpls.push({ prefix: lookupPrefix, base, trait: resolveType(traitNode) });
    }
    const b = impl.childForFieldName('body');
    if (!b) return;
    const siblings = b.namedChildren.filter((c): c is Node => c !== null);
    siblings.forEach((m, idx) => {
      if (m.type === 'function_item') {
        const pre = getPreamble(siblings, idx);
        if (pre.isTest) return;
        const nm = m.childForFieldName('name');
        if (!nm) return;
        functions.push(
          buildFunction(m, pre, filePath, `${prefix}${base}.${nm.text}`, isTraitImpl || hasVisibility(m))
        );
      } else if (m.type === 'const_item') {
        const pre = getPreamble(siblings, idx);
        if (pre.isCfgTest) return;
        const nm = m.childForFieldName('name');
        if (!nm) return;
        constants.push(
          buildConstant(m, filePath, `${prefix}${base}.${nm.text}`, hasVisibility(m))
        );
      }
    });
  }

  function walkTrait(trait: Node, pre: Preamble, prefix: string): void {
    const nm = trait.childForFieldName('name');
    if (!nm) return;
    const traitName = prefix + nm.text;
    const exported = hasVisibility(trait);
    const t = buildType(trait, pre, filePath, traitName, 'interface', []);
    const bounds = trait.childForFieldName('bounds');
    if (bounds) {
      const ext = bounds.text.replace(/^\s*:/, '').trim();
      if (ext) t.extends = ext;
    }
    types.push(t);
    const b = trait.childForFieldName('body');
    if (!b) return;
    const siblings = b.namedChildren.filter((c): c is Node => c !== null);
    siblings.forEach((m, idx) => {
      if (m.type === 'function_item') {
        const mpre = getPreamble(siblings, idx);
        if (mpre.isTest) return;
        const mn = m.childForFieldName('name');
        if (!mn) return;
        functions.push(buildFunction(m, mpre, filePath, `${traitName}.${mn.text}`, exported));
      } else if (m.type === 'function_signature_item') {
        const mpre = getPreamble(siblings, idx);
        if (mpre.isTest) return;
        const mn = m.childForFieldName('name');
        if (!mn) return;
        const f = buildFunction(m, mpre, filePath, `${traitName}.${mn.text}`, exported);
        f.callees = [];
        functions.push(f);
      }
    });
  }

  walkItems(tree.rootNode, '');

  for (const p of pendingImpls) {
    const target = types.find(t => t.name === p.prefix + p.base);
    if (target && p.trait && !target.implements.includes(p.trait)) {
      target.implements.push(p.trait);
    }
  }

  const lineCount = source ? source.split('\n').length - (source.endsWith('\n') ? 1 : 0) : 0;

  return {
    filePath,
    fileName: path.basename(filePath),
    extension: '.rs',
    lineCount,
    functions,
    types,
    imports: imports.toImports(filePath),
    constants,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  let paths: string[];
  try {
    const parsed: unknown = JSON.parse(readStdin());
    if (!Array.isArray(parsed)) throw new Error('input is not an array');
    paths = parsed.map(String);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[rust-parser] WARNING: invalid input JSON - ${msg}\n`);
    process.stdout.write('[]');
    return;
  }

  await Parser.init();
  const wasmPath = fileURLToPath(new URL('../../grammars/tree-sitter-rust.wasm', import.meta.url));
  const lang = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(lang);

  const results: ParsedFile[] = [];
  for (const p of paths) {
    try {
      const source = fs.readFileSync(p, 'utf8');
      const tree = parser.parse(source);
      if (!tree) throw new Error('parser returned no tree');
      if (tree.rootNode.hasError) {
        process.stderr.write(`[rust-parser] WARNING: ${p} has syntax errors; extracted partially\n`);
      }
      results.push(extractRustFile(p, source, tree));
      tree.delete();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rust-parser] WARNING: skipping ${p} - ${msg}\n`);
    }
  }
  process.stdout.write(JSON.stringify(results));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[rust-parser] WARNING: worker failed - ${msg}\n`);
    process.exitCode = 1;
  });
}
