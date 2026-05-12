/**
 * ast-parser.ts -- TypeScript AST extraction using ts-morph.
 *
 * Parses TypeScript source files and extracts structured metadata about
 * functions, methods, types, interfaces, enums, classes, imports,
 * decorators, class hierarchy, constructor injection, call sites, and
 * type references.
 *
 * Used by the sync pipeline to detect what changed and what to write
 * to the codebase PKG.
 */

import {
  Project,
  SourceFile,
  Node,
  type ArrowFunction,
  type FunctionExpression,
} from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ParsedArgument {
  name: string;
  type: string;
}

export interface ParsedDecorator {
  name: string;
  args: string[];
}

export interface ParsedFunction {
  name: string;
  filePath: string;
  lineNumber: number;
  endLine: number;
  args: ParsedArgument[];
  returnType: string;
  jsDoc: string;
  bodyText: string;
  isExported: boolean;
  isAsync: boolean;
  decorators: ParsedDecorator[];
  httpMethod?: string;
  routePath?: string;
  callees: string[];
  typeRefs: string[];
  contentHash: string;
}

export interface ParsedProperty {
  name: string;
  type: string;
}

export interface ParsedConstructorParam {
  name: string;
  type: string;
  injectToken?: string;
}

export interface ParsedType {
  name: string;
  filePath: string;
  lineNumber: number;
  kind: 'interface' | 'type' | 'enum' | 'class';
  properties: ParsedProperty[];
  bodyText: string;
  comment: string;
  decorators: ParsedDecorator[];
  extends?: string;
  implements: string[];
  constructorParams: ParsedConstructorParam[];
  contentHash: string;
}

export interface ParsedImport {
  fromFile: string;
  importedNames: string[];
  moduleSpecifier: string;
}

export interface ParsedFile {
  filePath: string;
  fileName: string;
  extension: string;
  lineCount: number;
  functions: ParsedFunction[];
  types: ParsedType[];
  imports: ParsedImport[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const REPO_ROOT = process.cwd();

function findTsConfig(filePath: string): string | undefined {
  const normalised = filePath.replace(/\\/g, '/');
  let dir = path.dirname(normalised);
  const root = REPO_ROOT.replace(/\\/g, '/');

  while (dir.startsWith(root) && dir !== root) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function extractJsDoc(node: Node): string {
  if (Node.isJSDocable(node)) {
    const docs = node.getJsDocs();
    if (docs.length > 0) {
      return docs.map(d => d.getDescription().trim()).filter(Boolean).join('\n');
    }
  }
  return '';
}

function extractArgsFromNode(
  node: { getParameters(): Array<{ getName(): string; getTypeNode(): { getText(): string } | undefined }> }
): ParsedArgument[] {
  return node.getParameters().map(p => ({
    name: p.getName(),
    type: p.getTypeNode()?.getText() ?? 'unknown',
  }));
}

function extractBodyText(
  node: { getBody?(): { getText(): string } | undefined }
): string {
  try {
    const body = node.getBody?.();
    return body ? body.getText().slice(0, 8000) : '';
  } catch {
    return '';
  }
}

function extractDecorators(
  node: { getDecorators(): Array<{ getName(): string; getArguments(): Array<{ getText(): string }> }> }
): ParsedDecorator[] {
  try {
    return node.getDecorators().map(d => ({
      name: d.getName(),
      args: d.getArguments().map(a => a.getText().replace(/^['"]|['"]$/g, '')),
    }));
  } catch {
    return [];
  }
}

const HTTP_DECORATORS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ALL',
};

function extractEndpointInfo(
  decorators: ParsedDecorator[],
  controllerPrefix: string | undefined,
): { httpMethod?: string; routePath?: string } {
  for (const dec of decorators) {
    const verb = HTTP_DECORATORS[dec.name];
    if (verb) {
      const subPath = dec.args[0] ?? '';
      const prefix = controllerPrefix ?? '';
      const parts = [prefix, subPath].filter(Boolean);
      const routePath = '/' + parts.join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
      return { httpMethod: verb, routePath };
    }
  }
  return {};
}

function extractCallees(
  node: { getBody?(): Node | undefined }
): string[] {
  const callees = new Set<string>();
  try {
    const body = node.getBody?.();
    if (!body) return [];

    body.forEachDescendant((child) => {
      if (!Node.isCallExpression(child)) return;
      const expr = child.getExpression();
      const text = expr.getText();

      if (text.length > 80) return;

      let callee = text;
      if (callee.startsWith('this.')) {
        callee = callee.slice(5);
      }
      if (callee.includes('(') || callee.includes('[')) return;
      if (['console.log', 'console.warn', 'console.error', 'console.debug',
           'Math.max', 'Math.min', 'Math.abs', 'Math.round', 'Math.floor',
           'Math.ceil', 'Math.random', 'Math.log', 'Math.sqrt', 'Math.pow',
           'JSON.stringify', 'JSON.parse',
           'Object.keys', 'Object.values', 'Object.entries', 'Object.assign',
           'Array.isArray', 'Array.from',
           'String', 'Number', 'Boolean', 'parseInt', 'parseFloat',
           'Date.now', 'Promise.all', 'Promise.resolve', 'Promise.reject',
           'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
          ].includes(callee)) return;

      callees.add(callee);
    });
  } catch {
    // Body traversal failure — return empty
  }
  return Array.from(callees);
}

function extractTypeRefs(args: ParsedArgument[], returnType: string): string[] {
  const refs = new Set<string>();
  const typePattern = /\b([A-Z][A-Za-z0-9]+)\b/g;

  for (const arg of args) {
    let match;
    while ((match = typePattern.exec(arg.type)) !== null) {
      const name = match[1]!;
      if (!BUILTIN_TYPES.has(name)) refs.add(name);
    }
  }

  let match;
  const rtPattern = /\b([A-Z][A-Za-z0-9]+)\b/g;
  while ((match = rtPattern.exec(returnType)) !== null) {
    const name = match[1]!;
    if (!BUILTIN_TYPES.has(name)) refs.add(name);
  }

  return Array.from(refs);
}

const BUILTIN_TYPES = new Set([
  'Array', 'Map', 'Set', 'Record', 'Promise', 'Partial', 'Required', 'Readonly',
  'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'InstanceType',
  'Parameters', 'ConstructorParameters', 'Awaited', 'ReadonlyArray', 'ReadonlyMap',
  'ReadonlySet', 'WeakMap', 'WeakSet', 'Buffer', 'Date', 'RegExp', 'Error',
  'String', 'Number', 'Boolean', 'Object', 'Symbol', 'Function', 'Uint8Array',
  'Int8Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'SharedArrayBuffer',
  'JSX', 'React', 'Element',
]);

// ---------------------------------------------------------------------------
// Extraction: functions
// ---------------------------------------------------------------------------

function extractFunctions(sourceFile: SourceFile, filePath: string): ParsedFunction[] {
  const results: ParsedFunction[] = [];

  // Named function declarations
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const decorators = extractDecorators(fn as any);
    const args = extractArgsFromNode(fn);
    const returnType = fn.getReturnTypeNode()?.getText() ?? fn.getReturnType().getText().slice(0, 120);
    results.push({
      name,
      filePath,
      lineNumber: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      args,
      returnType,
      jsDoc: extractJsDoc(fn),
      bodyText: extractBodyText(fn),
      isExported: fn.isExported(),
      isAsync: fn.isAsync(),
      decorators,
      callees: extractCallees(fn),
      typeRefs: extractTypeRefs(args, returnType),
      contentHash: sha256(fn.getText()),
    });
  }

  // Arrow functions and function expressions assigned to variables
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;

    const isArrow = Node.isArrowFunction(initializer);
    const isFuncExpr = Node.isFunctionExpression(initializer);
    if (!isArrow && !isFuncExpr) continue;

    const fnNode = initializer as ArrowFunction | FunctionExpression;
    const name = varDecl.getName();
    const parentStatement = varDecl.getParent()?.getParent();
    const isExported =
      parentStatement && Node.isVariableStatement(parentStatement)
        ? parentStatement.isExported()
        : false;

    const args = extractArgsFromNode(fnNode);
    const returnType = fnNode.getReturnTypeNode()?.getText() ?? fnNode.getReturnType().getText().slice(0, 120);
    results.push({
      name,
      filePath,
      lineNumber: fnNode.getStartLineNumber(),
      endLine: fnNode.getEndLineNumber(),
      args,
      returnType,
      jsDoc: extractJsDoc(varDecl.getParent()?.getParent() ?? varDecl),
      bodyText: extractBodyText(fnNode),
      isExported,
      isAsync: fnNode.isAsync(),
      decorators: [],
      callees: extractCallees(fnNode),
      typeRefs: extractTypeRefs(args, returnType),
      contentHash: sha256(fnNode.getText()),
    });
  }

  // Methods inside classes
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() ?? 'AnonymousClass';

    const classDecorators = extractDecorators(cls as any);
    const controllerDec = classDecorators.find(d => d.name === 'Controller');
    const controllerPrefix = controllerDec?.args[0];

    for (const method of cls.getMethods()) {
      const name = method.getName();
      const decorators = extractDecorators(method as any);
      const args = extractArgsFromNode(method);
      const returnType = method.getReturnTypeNode()?.getText() ?? method.getReturnType().getText().slice(0, 120);

      const { httpMethod, routePath } = extractEndpointInfo(decorators, controllerPrefix);

      results.push({
        name: `${className}.${name}`,
        filePath,
        lineNumber: method.getStartLineNumber(),
        endLine: method.getEndLineNumber(),
        args,
        returnType,
        jsDoc: extractJsDoc(method),
        bodyText: extractBodyText(method),
        isExported: cls.isExported(),
        isAsync: method.isAsync(),
        decorators,
        httpMethod,
        routePath,
        callees: extractCallees(method),
        typeRefs: extractTypeRefs(args, returnType),
        contentHash: sha256(method.getText()),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Extraction: types
// ---------------------------------------------------------------------------

function extractTypes(sourceFile: SourceFile, filePath: string): ParsedType[] {
  const results: ParsedType[] = [];

  // Interfaces
  for (const iface of sourceFile.getInterfaces()) {
    const properties = iface.getProperties().map(p => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText() ?? 'unknown',
    }));
    results.push({
      name: iface.getName(),
      filePath,
      lineNumber: iface.getStartLineNumber(),
      kind: 'interface',
      properties,
      bodyText: iface.getText().slice(0, 8000),
      comment: extractJsDoc(iface),
      decorators: [],
      implements: [],
      constructorParams: [],
      contentHash: sha256(iface.getText()),
    });
  }

  // Type aliases
  for (const typeAlias of sourceFile.getTypeAliases()) {
    results.push({
      name: typeAlias.getName(),
      filePath,
      lineNumber: typeAlias.getStartLineNumber(),
      kind: 'type',
      properties: [],
      bodyText: typeAlias.getText().slice(0, 8000),
      comment: extractJsDoc(typeAlias),
      decorators: [],
      implements: [],
      constructorParams: [],
      contentHash: sha256(typeAlias.getText()),
    });
  }

  // Enums
  for (const enumDecl of sourceFile.getEnums()) {
    const properties = enumDecl.getMembers().map(m => ({
      name: m.getName(),
      type: String(m.getValue() ?? ''),
    }));
    results.push({
      name: enumDecl.getName(),
      filePath,
      lineNumber: enumDecl.getStartLineNumber(),
      kind: 'enum',
      properties,
      bodyText: enumDecl.getText().slice(0, 8000),
      comment: extractJsDoc(enumDecl),
      decorators: [],
      implements: [],
      constructorParams: [],
      contentHash: sha256(enumDecl.getText()),
    });
  }

  // Classes
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    const properties = cls.getProperties().map(p => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText() ?? 'unknown',
    }));

    const extendsClause = cls.getExtends();
    const extendsName = extendsClause?.getText()?.split('<')[0]?.trim();

    const implementsNames: string[] = [];
    for (const impl of cls.getImplements()) {
      const implName = impl.getText().split('<')[0]?.trim();
      if (implName) implementsNames.push(implName);
    }

    const constructorParams: ParsedConstructorParam[] = [];
    const ctors = cls.getConstructors();
    if (ctors.length > 0) {
      const ctor = ctors[0]!;
      for (const param of ctor.getParameters()) {
        const paramName = param.getName();
        const paramType = param.getTypeNode()?.getText() ?? 'unknown';

        let injectToken: string | undefined;
        try {
          const paramDecorators = param.getDecorators();
          const injectDec = paramDecorators.find(d => d.getName() === 'Inject');
          if (injectDec) {
            const tokenArg = injectDec.getArguments()[0];
            injectToken = tokenArg?.getText();
          }
        } catch {
          // Decorator extraction failed — skip
        }

        constructorParams.push({ name: paramName, type: paramType, injectToken });
      }
    }

    const decorators = extractDecorators(cls as any);

    results.push({
      name,
      filePath,
      lineNumber: cls.getStartLineNumber(),
      kind: 'class',
      properties,
      bodyText: cls.getText().slice(0, 8000),
      comment: extractJsDoc(cls),
      decorators,
      extends: extendsName,
      implements: implementsNames,
      constructorParams,
      contentHash: sha256(cls.getText()),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Extraction: imports
// ---------------------------------------------------------------------------

function extractImports(sourceFile: SourceFile, filePath: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    const named = importDecl.getNamedImports().map(n => n.getName());
    const defaultImport = importDecl.getDefaultImport()?.getText();
    const namespaceImport = importDecl.getNamespaceImport()?.getText();

    const importedNames: string[] = [];
    if (defaultImport) importedNames.push(defaultImport);
    if (namespaceImport) importedNames.push(`* as ${namespaceImport}`);
    importedNames.push(...named);

    results.push({ fromFile: filePath, importedNames, moduleSpecifier });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Project cache
// ---------------------------------------------------------------------------

const _projectCache = new Map<string, Project>();

function getProject(tsConfigPath: string | undefined): Project {
  const key = tsConfigPath ?? '__no_tsconfig__';
  if (!_projectCache.has(key)) {
    const project = tsConfigPath
      ? new Project({
          tsConfigFilePath: tsConfigPath,
          skipAddingFilesFromTsConfig: true,
          skipFileDependencyResolution: true,
        })
      : new Project({
          compilerOptions: { target: 99, module: 1, strict: true, esModuleInterop: true },
          skipFileDependencyResolution: true,
        });
    _projectCache.set(key, project);
  }
  return _projectCache.get(key)!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseFiles(filePaths: string[]): ParsedFile[] {
  const results: ParsedFile[] = [];

  for (const rawPath of filePaths) {
    const filePath = rawPath.replace(/\\/g, '/');
    try {
      const tsConfigPath = findTsConfig(filePath);
      const project = getProject(tsConfigPath);

      let sourceFile: SourceFile | undefined = project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = project.addSourceFileAtPath(filePath);
      }

      const fileName = path.basename(filePath);
      const extension = path.extname(filePath);
      const lineCount = sourceFile.getEndLineNumber();

      results.push({
        filePath,
        fileName,
        extension,
        lineCount,
        functions: extractFunctions(sourceFile, filePath),
        types: extractTypes(sourceFile, filePath),
        imports: extractImports(sourceFile, filePath),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ast-parser] WARNING: skipping ${filePath} — ${msg}\n`);
    }
  }

  return results;
}

export function parseFile(filePath: string): ParsedFile | null {
  const results = parseFiles([filePath]);
  return results.length > 0 ? results[0] : null;
}

export function clearProjectCache(): void {
  _projectCache.clear();
}
