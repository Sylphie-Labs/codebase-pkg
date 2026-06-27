/**
 * extract.mjs -- per-decision style conformity extractor (Half A).
 *
 * Instead of embedding whole function bodies (which measures what a function
 * DOES), this reads the discrete, equivalent-choice coding DECISIONS a developer
 * made -- the axes where TypeScript offers several ways to write the same thing
 * -- so each decision can be judged against the codebase's own distribution.
 *
 * Pure-ish: takes a file path, returns a plain facts object per exported
 * function. Uses ts-morph the same way src/sync/ast-parser.ts does.
 *
 * Decision dimensions (the ones that actually vary across the 10 fixtures):
 *   - array_syntax : 'bracket' (T[]) | 'generic' (Array<T>) | 'none'
 *   - fn_style     : 'function' | 'arrow-const' | 'method'
 *   - return_type  : 'explicit' | 'inferred'
 *   - loop_style   : 'index-for' | 'for-of' | 'while' | 'recursion' |
 *                    'array-method' | 'none'  (recursion can combine, see below)
 *   - param_count  : integer
 *   - var_decl     : 'const' | 'let' | 'mixed' | 'none'  (dominant body decls)
 *
 * loop_style note: a function can both loop AND recurse (r5_quicksort). We pick
 * a single dominant label by precedence so the dimension stays categorical, but
 * also expose `recurses` as a boolean fact for transparency.
 */

import { Project, Node } from 'ts-morph';

// One offline project, no tsconfig needed for these standalone fixtures.
function makeProject() {
  return new Project({
    compilerOptions: { target: 99, module: 99, strict: true, esModuleInterop: true },
    skipFileDependencyResolution: true,
  });
}

// ---- array_syntax: scan all type-annotation text in params + return ----------
function arraySyntax(typeTexts) {
  let bracket = false;
  let generic = false;
  for (const t of typeTexts) {
    if (!t) continue;
    // `T[]`, `number[]`, `Foo[]` (bracket form). `(...)[]` also counts.
    if (/\]\s*\[\s*\]|[\w>)]\s*\[\s*\]/.test(t) || /\[\s*\]/.test(t)) bracket = true;
    // `Array<...>` or `ReadonlyArray<...>` (generic form).
    if (/\bArray\s*</.test(t) || /\bReadonlyArray\s*</.test(t)) generic = true;
  }
  if (bracket && generic) return 'mixed';
  if (bracket) return 'bracket';
  if (generic) return 'generic';
  return 'none';
}

// ---- loop_style + recursion --------------------------------------------------
const ARRAY_METHODS = new Set([
  'map', 'filter', 'reduce', 'reduceRight', 'forEach', 'flatMap', 'every', 'some', 'find',
]);

function analyzeLoops(fnNode, fnName, body) {
  let indexFor = false;
  let forOf = false;
  let forIn = false;
  let whileLoop = false;
  let arrayMethod = false;
  let recurses = false;

  if (body) {
    body.forEachDescendant((node) => {
      if (Node.isForStatement(node)) indexFor = true;
      else if (Node.isForOfStatement(node)) forOf = true;
      else if (Node.isForInStatement(node)) forIn = true;
      else if (Node.isWhileStatement(node) || Node.isDoStatement(node)) whileLoop = true;
      else if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (Node.isPropertyAccessExpression(expr)) {
          if (ARRAY_METHODS.has(expr.getName())) arrayMethod = true;
        }
        // self-call => recursion (compare bare callee identifier to fn name)
        const calleeText = expr.getText();
        if (calleeText === fnName) recurses = true;
      }
    });
  }

  // Dominant single label by precedence. Explicit loop constructs win over
  // recursion when both are present (the loop is the structural workhorse;
  // recursion is exposed separately via `recurses`).
  let loop_style;
  if (indexFor) loop_style = 'index-for';
  else if (forOf) loop_style = 'for-of';
  else if (forIn) loop_style = 'for-in';
  else if (whileLoop) loop_style = 'while';
  else if (recurses) loop_style = 'recursion';
  else if (arrayMethod) loop_style = 'array-method';
  else loop_style = 'none';

  return { loop_style, recurses };
}

// ---- var_decl: dominant const vs let in the function body --------------------
function varDecl(body) {
  let constN = 0;
  let letN = 0;
  let varN = 0;
  if (body) {
    body.forEachDescendant((node) => {
      if (Node.isVariableStatement(node)) {
        const kind = node.getDeclarationKind(); // 'const' | 'let' | 'var'
        const count = node.getDeclarations().length;
        if (kind === 'const') constN += count;
        else if (kind === 'let') letN += count;
        else varN += count;
      }
    });
  }
  const total = constN + letN + varN;
  if (total === 0) return { var_decl: 'none', constN, letN, varN };
  if (constN > 0 && letN === 0 && varN === 0) return { var_decl: 'const', constN, letN, varN };
  if (letN > 0 && constN === 0 && varN === 0) return { var_decl: 'let', constN, letN, varN };
  return { var_decl: 'mixed', constN, letN, varN };
}

// ---- per-function fact extraction --------------------------------------------
function factsForFunction(fn, kind /* 'function' | 'arrow-const' | 'method' */) {
  const name = fn.getName ? (fn.getName() ?? '<anon>') : '<anon>';

  const params = fn.getParameters();
  const paramTypeTexts = params.map((p) => p.getTypeNode()?.getText() ?? '');

  const returnNode = fn.getReturnTypeNode?.();
  const returnText = returnNode?.getText() ?? '';
  const return_type = returnNode ? 'explicit' : 'inferred';

  const array_syntax = arraySyntax([...paramTypeTexts, returnText]);

  const body = fn.getBody?.();
  const { loop_style, recurses } = analyzeLoops(fn, name, body);
  const { var_decl, constN, letN, varN } = varDecl(body);

  return {
    name,
    fn_style: kind,
    array_syntax,
    return_type,
    loop_style,
    recurses,
    param_count: params.length,
    var_decl,
    _detail: { constN, letN, varN, paramTypeTexts, returnText },
  };
}

/**
 * Extract decision facts for every EXPORTED function-like in a file.
 * Returns an array (one entry per exported function/arrow/method).
 */
export function extractFile(filePath) {
  const project = makeProject();
  const sf = project.addSourceFileAtPath(filePath);
  const out = [];

  // Named function declarations.
  for (const fn of sf.getFunctions()) {
    if (!fn.getName() || !fn.isExported()) continue;
    out.push(factsForFunction(fn, 'function'));
  }

  // Arrow / function-expression consts.
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer();
    if (!init) continue;
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue;
    const stmt = v.getParent()?.getParent();
    const isExported = stmt && Node.isVariableStatement(stmt) ? stmt.isExported() : false;
    if (!isExported) continue;
    // graft the variable name onto the function node for naming
    const f = factsForFunction(init, 'arrow-const');
    f.name = v.getName();
    out.push(f);
  }

  // Exported class methods.
  for (const cls of sf.getClasses()) {
    if (!cls.isExported()) continue;
    const cn = cls.getName() ?? 'Anon';
    for (const m of cls.getMethods()) {
      const f = factsForFunction(m, 'method');
      f.name = `${cn}.${m.getName()}`;
      out.push(f);
    }
  }

  return out;
}

/** The categorical dimensions we report distributions / outliers over. */
export const DIMENSIONS = [
  'array_syntax',
  'fn_style',
  'return_type',
  'loop_style',
  'param_count',
  'var_decl',
];

/**
 * Build the per-dimension distribution (value -> count) across a list of
 * { file, facts } records (one facts object per file; first exported fn).
 */
export function distributions(records) {
  const dist = {};
  for (const dim of DIMENSIONS) {
    dist[dim] = {};
    for (const r of records) {
      const v = String(r.facts[dim]);
      dist[dim][v] = (dist[dim][v] ?? 0) + 1;
    }
  }
  return dist;
}

/**
 * Per-decision outlier flagging. A file's choice on a dimension is an outlier
 * when that value is held by a strict minority -- specifically when its share
 * is at or below `threshold` (default 0.3) AND it is not the most common value.
 * Ties for rarest are all flagged. Returns array of
 * { file, dim, value, count, total }.
 */
export function flagOutliers(records, dist, threshold = 0.3) {
  const total = records.length;
  const flags = [];
  for (const dim of DIMENSIONS) {
    const counts = dist[dim];
    const maxCount = Math.max(...Object.values(counts));
    for (const r of records) {
      const v = String(r.facts[dim]);
      const c = counts[v];
      const share = c / total;
      // Outlier if a minority value (share <= threshold) and not the mode.
      if (c < maxCount && share <= threshold) {
        flags.push({ file: r.file, dim, value: v, count: c, total });
      }
    }
  }
  return flags;
}
