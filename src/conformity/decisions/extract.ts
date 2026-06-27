/**
 * extract.ts -- per-decision STYLE-conformity fact extractor.
 *
 * Instead of embedding whole function bodies (which measures what a function
 * DOES), this reads the discrete, equivalent-choice coding DECISIONS a
 * developer made on a curated set of CATEGORICAL axes -- the places where
 * TypeScript offers several interchangeable ways to write the same thing. Each
 * decision can then be judged against the codebase's own distribution (see
 * target.ts) deterministically and explainably.
 *
 * Ported faithfully from the validated experiment
 * `experiments/conformity-decisions/{extract,corpus-run,target-run}.mjs`. Uses
 * ts-morph the same way `src/sync/ast-parser.ts` does (offline Project, no
 * tsconfig needed for fact extraction). Operates per function/method/arrow.
 *
 * The curated axes (each with an "absence" value -- see AXIS_NONE_VALUE in
 * target.ts -- that means "no decision was made here"):
 *   - var_decl     : 'const' | 'let' | 'mixed' | 'none'
 *   - string_style : 'template-literal' | 'concat' | 'mixed' | 'none'
 *   - async_style  : 'async-await' | 'promise-then' | 'sync'
 *   - array_syntax : 'bracket' | 'generic' | 'mixed' | 'none'
 *   - export_style : 'named' | 'default' | 'none'
 */

import { Project, Node } from 'ts-morph';

/** The curated, substitutable decision axes the engine judges over. */
export const CURATED_AXES = [
  'var_decl',
  'string_style',
  'async_style',
  'array_syntax',
  'export_style',
] as const;

/** One curated decision axis. */
export type Axis = (typeof CURATED_AXES)[number];

/**
 * Per axis, the value that means "this decision was not made here" (absence of
 * the construct). A style guide targets a real choice, never the absence, so
 * the seed skips this value when picking the mode, and migration progress /
 * per-function faulting exclude functions sitting on it.
 *
 * Kept in sync with the same constant in target.ts (re-exported there for
 * consumers of the pure target logic); defined here because the extractor is
 * the source of the raw values.
 */
export const AXIS_NONE_VALUE: Record<Axis, string> = {
  var_decl: 'none', // function declares no local variables
  string_style: 'none', // function builds no strings
  async_style: 'sync', // function does no async work
  array_syntax: 'none', // function has no array-typed annotations
  export_style: 'none', // symbol is not exported
};

/** The decision facts extracted for a single function-like node. */
export interface DecisionFacts {
  /** Display name (e.g. `doThing` or `MyClass.method`). */
  name: string;
  /** Source file path (forward-slashed). */
  filePath: string;
  /** 1-based start line of the function-like node. */
  lineNumber: number;
  var_decl: string;
  string_style: string;
  async_style: string;
  array_syntax: string;
  export_style: string;
}

/**
 * Minimal structural shape of the ts-morph function-like nodes we read. Named
 * function declarations, arrow/function expressions, methods, and constructors
 * all satisfy it. Kept loose (optional members) so a single extractor handles
 * every kind.
 */
interface FunctionLike {
  getParameters(): Array<{ getTypeNode(): { getText(): string } | undefined }>;
  getReturnTypeNode?(): { getText(): string } | undefined;
  getBody?(): Node | undefined;
  isAsync?(): boolean;
}

// ---------------------------------------------------------------------------
// array_syntax: T[] vs Array<T> across param + return type annotations
// ---------------------------------------------------------------------------

function arraySyntax(typeTexts: string[]): string {
  let bracket = false;
  let generic = false;
  for (const t of typeTexts) {
    if (!t) continue;
    if (/\[\s*\]/.test(t)) bracket = true;
    if (/\bArray\s*</.test(t) || /\bReadonlyArray\s*</.test(t)) generic = true;
  }
  if (bracket && generic) return 'mixed';
  if (bracket) return 'bracket';
  if (generic) return 'generic';
  return 'none';
}

// ---------------------------------------------------------------------------
// var_decl: dominant const/let/var in the body
// ---------------------------------------------------------------------------

function varDecl(body: Node | undefined): string {
  let constN = 0;
  let letN = 0;
  let varN = 0;
  if (body) {
    body.forEachDescendant((node) => {
      if (Node.isVariableStatement(node)) {
        const kind = node.getDeclarationKind();
        const count = node.getDeclarations().length;
        if (kind === 'const') constN += count;
        else if (kind === 'let') letN += count;
        else varN += count;
      }
    });
  }
  const total = constN + letN + varN;
  if (total === 0) return 'none';
  if (constN > 0 && letN === 0 && varN === 0) return 'const';
  if (letN > 0 && constN === 0 && varN === 0) return 'let';
  return 'mixed';
}

// ---------------------------------------------------------------------------
// async_style: async/await vs promise-.then() vs plain sync
// ---------------------------------------------------------------------------

function asyncStyle(fn: FunctionLike, body: Node | undefined): string {
  const isAsync = typeof fn.isAsync === 'function' ? fn.isAsync() : false;
  let hasThen = false;
  let hasAwait = false;
  if (body) {
    body.forEachDescendant((node) => {
      if (Node.isAwaitExpression(node)) hasAwait = true;
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (
          Node.isPropertyAccessExpression(expr) &&
          (expr.getName() === 'then' || expr.getName() === 'catch')
        ) {
          hasThen = true;
        }
      }
    });
  }
  if (isAsync || hasAwait) return 'async-await';
  if (hasThen) return 'promise-then';
  return 'sync';
}

// ---------------------------------------------------------------------------
// string_style: template-literals vs string concatenation vs none
// ---------------------------------------------------------------------------

function stringStyle(body: Node | undefined): string {
  let template = false;
  let concat = false;
  if (body) {
    body.forEachDescendant((node) => {
      if (Node.isTemplateExpression(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        template = true;
      }
      if (Node.isBinaryExpression(node) && node.getOperatorToken().getText() === '+') {
        const l = node.getLeft();
        const r = node.getRight();
        if (Node.isStringLiteral(l) || Node.isStringLiteral(r)) concat = true;
      }
    });
  }
  if (template && concat) return 'mixed';
  if (template) return 'template-literal';
  if (concat) return 'concat';
  return 'none';
}

// ---------------------------------------------------------------------------
// per-function fact extraction
// ---------------------------------------------------------------------------

/**
 * Extract the curated decision facts for a single function-like node. Pure:
 * reads only the node; the caller supplies name/file/line/export-style context
 * (which differ per declaration kind) so this stays node-shape agnostic.
 */
export function extractDecisions(
  fn: FunctionLike,
  ctx: { name: string; filePath: string; lineNumber: number; exportStyle: string },
): DecisionFacts {
  const params = fn.getParameters();
  const paramTypeTexts = params.map((p) => p.getTypeNode()?.getText() ?? '');
  const returnText = fn.getReturnTypeNode?.()?.getText() ?? '';
  const body = fn.getBody?.();

  return {
    name: ctx.name,
    filePath: ctx.filePath,
    lineNumber: ctx.lineNumber,
    var_decl: varDecl(body),
    string_style: stringStyle(body),
    async_style: asyncStyle(fn, body),
    array_syntax: arraySyntax([...paramTypeTexts, returnText]),
    export_style: ctx.exportStyle,
  };
}

// ---------------------------------------------------------------------------
// File walking: every function-like in a parsed source file
// ---------------------------------------------------------------------------

/** Offline ts-morph project, no tsconfig needed for fact extraction. */
function makeProject(): Project {
  return new Project({
    compilerOptions: { target: 99, module: 99, strict: true, esModuleInterop: true },
    skipFileDependencyResolution: true,
  });
}

/**
 * Extract decision facts for EVERY function-like in a file: named function
 * declarations, arrow/function-expression consts (exported OR not), and all
 * class methods + constructors. `filePath` is used both to load the file and
 * as the (forward-slashed) `filePath` stamped on each fact.
 */
export function extractDecisionsFromFile(filePath: string): DecisionFacts[] {
  const project = makeProject();
  const sf = project.addSourceFileAtPath(filePath);
  return extractDecisionsFromSourceFile(sf, filePath);
}

/**
 * Core walker over an already-loaded ts-morph SourceFile. Exposed separately so
 * callers that already hold a SourceFile (or a fixture project) can reuse it
 * without re-reading from disk.
 */
export function extractDecisionsFromSourceFile(
  sf: ReturnType<Project['addSourceFileAtPath']>,
  filePath: string,
): DecisionFacts[] {
  const rel = filePath.replace(/\\/g, '/');
  const out: DecisionFacts[] = [];

  // Named function declarations.
  for (const fn of sf.getFunctions()) {
    const nm = fn.getName();
    if (!nm) continue;
    let exportStyle = 'none';
    if (fn.isExported()) exportStyle = fn.isDefaultExport() ? 'default' : 'named';
    out.push(
      extractDecisions(fn as unknown as FunctionLike, {
        name: nm,
        filePath: rel,
        lineNumber: fn.getStartLineNumber(),
        exportStyle,
      }),
    );
  }

  // Arrow / function-expression consts (exported OR not).
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer();
    if (!init) continue;
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue;
    const stmt = v.getParent()?.getParent();
    let exportStyle = 'none';
    if (stmt && Node.isVariableStatement(stmt) && stmt.isExported()) {
      exportStyle = stmt.isDefaultExport() ? 'default' : 'named';
    }
    out.push(
      extractDecisions(init as unknown as FunctionLike, {
        name: v.getName(),
        filePath: rel,
        lineNumber: init.getStartLineNumber(),
        exportStyle,
      }),
    );
  }

  // Class methods (all: public/private/static) plus constructors.
  for (const cls of sf.getClasses()) {
    const cn = cls.getName() ?? 'Anon';
    const clsExported = cls.isExported();
    const es = clsExported ? (cls.isDefaultExport() ? 'default' : 'named') : 'none';
    for (const m of cls.getMethods()) {
      out.push(
        extractDecisions(m as unknown as FunctionLike, {
          name: `${cn}.${m.getName()}`,
          filePath: rel,
          lineNumber: m.getStartLineNumber(),
          exportStyle: es,
        }),
      );
    }
    for (const ctor of cls.getConstructors()) {
      out.push(
        extractDecisions(ctor as unknown as FunctionLike, {
          name: `${cn}.constructor`,
          filePath: rel,
          lineNumber: ctor.getStartLineNumber(),
          exportStyle: es,
        }),
      );
    }
  }

  return out;
}
