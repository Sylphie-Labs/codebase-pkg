/**
 * corpus-run.mjs -- run the per-decision style-conformity extractor across a
 * REAL codebase (codebase-pkg's own ./src) to test USEFULNESS at scale.
 *
 * The deterministic ts-morph extractor was already proven CORRECT on 10
 * controlled fixtures (see extract.mjs + probe.test.mjs). This harness asks the
 * next question: when pointed at real TypeScript, does per-decision conformity
 * surface REAL house conventions and SENSIBLE outliers, or just noise?
 *
 * Differences from extract.mjs:
 *   - Extracts EVERY function-like in a file: named function declarations,
 *     arrow/function-expression consts (exported OR not), AND all class methods
 *     (including private/static, plus constructors). Not "one export per file".
 *   - Adds candidate dimensions that plausibly vary in real TS and are cheap to
 *     detect deterministically: error_handling, null_check, async_style,
 *     export_style, string_style.
 *   - Computes per-dimension distributions, house choice, identifies uniform
 *     (no-signal) vs real-variation dimensions, flags minority-value outliers,
 *     and ranks functions by deviation count.
 *
 * No model, no DB. Pure ts-morph. Deterministic.
 */

import { Project, Node } from 'ts-morph';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { walk } from '../conformity-corpus/walk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

// ---------------------------------------------------------------------------
// ts-morph project (offline, no tsconfig needed for fact extraction)
// ---------------------------------------------------------------------------
function makeProject() {
  return new Project({
    compilerOptions: { target: 99, module: 99, strict: true, esModuleInterop: true },
    skipFileDependencyResolution: true,
  });
}

// ---------------------------------------------------------------------------
// array_syntax: T[] vs Array<T> across param + return type annotations
// ---------------------------------------------------------------------------
function arraySyntax(typeTexts) {
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
// loop_style + recursion
// ---------------------------------------------------------------------------
const ARRAY_METHODS = new Set([
  'map', 'filter', 'reduce', 'reduceRight', 'forEach', 'flatMap', 'every', 'some', 'find',
]);

function analyzeLoops(fnName, body) {
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
        if (Node.isPropertyAccessExpression(expr) && ARRAY_METHODS.has(expr.getName())) {
          arrayMethod = true;
        }
        if (fnName && expr.getText() === fnName) recurses = true;
      }
    });
  }

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

// ---------------------------------------------------------------------------
// var_decl: dominant const/let/var in the body
// ---------------------------------------------------------------------------
function varDecl(body) {
  let constN = 0, letN = 0, varN = 0;
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
  let var_decl;
  if (total === 0) var_decl = 'none';
  else if (constN > 0 && letN === 0 && varN === 0) var_decl = 'const';
  else if (letN > 0 && constN === 0 && varN === 0) var_decl = 'let';
  else var_decl = 'mixed';
  return { var_decl, constN, letN, varN };
}

// ---------------------------------------------------------------------------
// NEW candidate dimensions
// ---------------------------------------------------------------------------

// error_handling: does the body try/catch, throw, both, or neither?
function errorHandling(body) {
  let hasTry = false;
  let hasThrow = false;
  if (body) {
    body.forEachDescendant((node) => {
      if (Node.isTryStatement(node)) hasTry = true;
      else if (Node.isThrowStatement(node)) hasThrow = true;
    });
  }
  if (hasTry && hasThrow) return 'try-catch+throw';
  if (hasTry) return 'try-catch';
  if (hasThrow) return 'throw';
  return 'none';
}

// null_check: how does the body guard against null/undefined?
//   optional-chaining (?.), nullish-coalescing (??), explicit (=== null / == null
//   / !x style checks against null/undefined), or none.
function nullCheck(body) {
  let optChain = false;
  let nullish = false;
  let explicit = false;
  if (body) {
    body.forEachDescendant((node) => {
      const k = node.getKindName();
      if (k === 'QuestionDotToken') optChain = true;
      // Optional chaining shows up structurally on PropertyAccess/ElementAccess/Call
      if (
        (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node) ||
          Node.isCallExpression(node)) &&
        typeof node.hasQuestionDotToken === 'function' && node.hasQuestionDotToken()
      ) {
        optChain = true;
      }
      if (Node.isBinaryExpression(node)) {
        const op = node.getOperatorToken().getText();
        if (op === '??') nullish = true;
        if (op === '===' || op === '!==' || op === '==' || op === '!=') {
          const l = node.getLeft().getText();
          const r = node.getRight().getText();
          if (/^(null|undefined)$/.test(l) || /^(null|undefined)$/.test(r)) explicit = true;
        }
      }
    });
  }
  // Single dominant label by precedence: optional-chaining is the most
  // idiomatic modern guard; then nullish; then explicit comparisons.
  if (optChain) return 'optional-chaining';
  if (nullish) return 'nullish-coalescing';
  if (explicit) return 'explicit';
  return 'none';
}

// async_style: async/await vs promise-.then() vs plain sync.
function asyncStyle(fn, body) {
  const isAsync = typeof fn.isAsync === 'function' ? fn.isAsync() : false;
  let hasThen = false;
  let hasAwait = false;
  if (body) {
    body.forEachDescendant((node) => {
      if (Node.isAwaitExpression(node)) hasAwait = true;
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (Node.isPropertyAccessExpression(expr) && (expr.getName() === 'then' || expr.getName() === 'catch')) {
          hasThen = true;
        }
      }
    });
  }
  if (isAsync || hasAwait) return 'async-await';
  if (hasThen) return 'promise-then';
  return 'sync';
}

// string_style: template-literals vs string concatenation (`a + b` where an
// operand is a string literal) vs none.
function stringStyle(body) {
  let template = false;
  let concat = false;
  if (body) {
    body.forEachDescendant((node) => {
      if (Node.isTemplateExpression(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        // NoSubstitutionTemplateLiteral = `plain` backtick string (still a choice
        // over '...'); TemplateExpression = `${...}` interpolation.
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
function factsForFunction(fn, kind, nameOverride, exportStyle) {
  const name = nameOverride ?? (fn.getName ? (fn.getName() ?? '<anon>') : '<anon>');

  const params = fn.getParameters();
  const paramTypeTexts = params.map((p) => p.getTypeNode()?.getText() ?? '');

  const returnNode = fn.getReturnTypeNode?.();
  const returnText = returnNode?.getText() ?? '';
  const return_type = returnNode ? 'explicit' : 'inferred';

  const array_syntax = arraySyntax([...paramTypeTexts, returnText]);

  const body = fn.getBody?.();
  const { loop_style, recurses } = analyzeLoops(name, body);
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
    error_handling: errorHandling(body),
    null_check: nullCheck(body),
    async_style: asyncStyle(fn, body),
    export_style: exportStyle,
    string_style: stringStyle(body),
    _detail: { constN, letN, varN },
  };
}

// Extract decision facts for EVERY function-like in a file.
function extractFileAll(filePath, sf) {
  const out = [];
  const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');

  // Named function declarations.
  for (const fn of sf.getFunctions()) {
    const nm = fn.getName();
    if (!nm) continue; // skip anonymous default-exported function expressions handled elsewhere
    let exportStyle = 'none';
    if (fn.isExported()) exportStyle = fn.isDefaultExport?.() ? 'default' : 'named';
    const f = factsForFunction(fn, 'function', nm, exportStyle);
    f.file = rel;
    f.line = fn.getStartLineNumber();
    out.push(f);
  }

  // Arrow / function-expression consts (exported OR not).
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer();
    if (!init) continue;
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue;
    const stmt = v.getParent()?.getParent();
    let exportStyle = 'none';
    if (stmt && Node.isVariableStatement(stmt) && stmt.isExported()) {
      exportStyle = stmt.isDefaultExport?.() ? 'default' : 'named';
    }
    const f = factsForFunction(init, 'arrow-const', v.getName(), exportStyle);
    f.file = rel;
    f.line = init.getStartLineNumber();
    out.push(f);
  }

  // Class methods (all: public/private/static), plus constructors.
  for (const cls of sf.getClasses()) {
    const cn = cls.getName() ?? 'Anon';
    const clsExported = cls.isExported();
    for (const m of cls.getMethods()) {
      // Methods don't carry their own export keyword; inherit the class's.
      const exportStyle = clsExported ? (cls.isDefaultExport?.() ? 'default' : 'named') : 'none';
      const f = factsForFunction(m, 'method', `${cn}.${m.getName()}`, exportStyle);
      f.file = rel;
      f.line = m.getStartLineNumber();
      out.push(f);
    }
    for (const ctor of cls.getConstructors()) {
      const exportStyle = clsExported ? (cls.isDefaultExport?.() ? 'default' : 'named') : 'none';
      const f = factsForFunction(ctor, 'method', `${cn}.constructor`, exportStyle);
      f.file = rel;
      f.line = ctor.getStartLineNumber();
      out.push(f);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// distributions / outliers
// ---------------------------------------------------------------------------
const DIMENSIONS = [
  'fn_style',
  'array_syntax',
  'return_type',
  'loop_style',
  'param_count',
  'var_decl',
  'error_handling',
  'null_check',
  'async_style',
  'export_style',
  'string_style',
];

function distributions(facts) {
  const dist = {};
  for (const dim of DIMENSIONS) {
    dist[dim] = {};
    for (const f of facts) {
      const v = String(f[dim]);
      dist[dim][v] = (dist[dim][v] ?? 0) + 1;
    }
  }
  return dist;
}

// House choice = mode per dimension. Uniform = a single value covers >= 95%.
function houseChoices(dist, total) {
  const house = {};
  for (const dim of DIMENSIONS) {
    const entries = Object.entries(dist[dim]).sort((a, b) => b[1] - a[1]);
    const [topVal, topCount] = entries[0];
    house[dim] = {
      value: topVal,
      count: topCount,
      share: topCount / total,
      distinct: entries.length,
      uniform: topCount / total >= 0.95,
    };
  }
  return house;
}

// Outlier: a function's value on a dimension is a clear minority
// (share <= threshold) AND not the mode. param_count handled separately as a
// numeric dimension (outlier if value is rare).
function flagOutliers(facts, dist, total, threshold) {
  const modeOf = {};
  for (const dim of DIMENSIONS) {
    let best = null, bestC = -1;
    for (const [v, c] of Object.entries(dist[dim])) {
      if (c > bestC) { bestC = c; best = v; }
    }
    modeOf[dim] = best;
  }

  const flagsByFn = new Map(); // key -> { fn, flags: [] }
  for (const f of facts) {
    const key = `${f.file}:${f.line}:${f.name}`;
    for (const dim of DIMENSIONS) {
      const v = String(f[dim]);
      const c = dist[dim][v];
      const share = c / total;
      if (v !== modeOf[dim] && share <= threshold) {
        if (!flagsByFn.has(key)) flagsByFn.set(key, { fn: f, flags: [] });
        flagsByFn.get(key).flags.push({ dim, value: v, count: c, share: +(share * 100).toFixed(1) });
      }
    }
  }
  return flagsByFn;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
function main() {
  const files = walk(SRC_DIR);
  const project = makeProject();
  const allFacts = [];
  const parseErrors = [];

  for (const fp of files) {
    try {
      const sf = project.addSourceFileAtPath(fp);
      const facts = extractFileAll(fp, sf);
      allFacts.push(...facts);
    } catch (err) {
      parseErrors.push({ file: path.relative(REPO_ROOT, fp), error: String(err?.message ?? err) });
    }
  }

  const total = allFacts.length;
  const dist = distributions(allFacts);
  const house = houseChoices(dist, total);
  const THRESHOLD = 0.12; // "clear minority" = <= 12% share
  const flagsByFn = flagOutliers(allFacts, dist, total, THRESHOLD);

  // Rank functions by # of deviating axes.
  const ranked = [...flagsByFn.values()]
    .sort((a, b) => b.flags.length - a.flags.length);

  const countGE = (n) => ranked.filter((r) => r.flags.length >= n).length;

  // ---- console report ----
  const pct = (c) => `${((c / total) * 100).toFixed(1)}%`;
  console.log(`\n=== PER-DECISION CONFORMITY: codebase-pkg/src ===`);
  console.log(`Files scanned: ${files.length}   Functions/methods analyzed: ${total}   Parse errors: ${parseErrors.length}`);

  console.log(`\n--- Per-dimension distributions (house choice marked *) ---`);
  const uniformDims = [];
  const signalDims = [];
  for (const dim of DIMENSIONS) {
    const entries = Object.entries(dist[dim]).sort((a, b) => b[1] - a[1]);
    const u = house[dim].uniform;
    (u ? uniformDims : signalDims).push(dim);
    console.log(`\n${dim}  ${u ? '[UNIFORM / no signal]' : '[variation]'}`);
    for (const [v, c] of entries) {
      const star = v === house[dim].value ? ' *' : '';
      console.log(`    ${v.padEnd(20)} ${String(c).padStart(4)}  ${pct(c)}${star}`);
    }
  }

  console.log(`\n--- Dimension signal summary ---`);
  console.log(`  Real variation : ${signalDims.join(', ')}`);
  console.log(`  Uniform (>=95% one value, no signal): ${uniformDims.join(', ') || '(none)'}`);

  console.log(`\n--- Outlier flagging (minority value <= ${THRESHOLD * 100}% & not mode) ---`);
  console.log(`  Functions with >=1 flagged decision: ${countGE(1)}`);
  console.log(`  Functions with >=2 flagged decisions: ${countGE(2)}`);
  console.log(`  Functions with >=3 flagged decisions: ${countGE(3)}`);

  console.log(`\n--- Top ${Math.min(10, ranked.length)} most-flagged functions ---`);
  for (const r of ranked.slice(0, 10)) {
    const dims = r.flags.map((x) => `${x.dim}=${x.value}(${x.share}%)`).join(', ');
    console.log(`  [${r.flags.length}] ${r.fn.file}:${r.fn.line}  ${r.fn.name}`);
    console.log(`        ${dims}`);
  }

  if (parseErrors.length) {
    console.log(`\n--- Parse errors ---`);
    for (const e of parseErrors) console.log(`  ${e.file}: ${e.error}`);
  }

  // ---- JSON report ----
  const report = {
    generatedAt: new Date().toISOString(),
    root: 'src',
    filesScanned: files.length,
    functionsAnalyzed: total,
    parseErrors,
    threshold: THRESHOLD,
    dimensions: DIMENSIONS.map((dim) => ({
      dim,
      uniform: house[dim].uniform,
      distinctValues: house[dim].distinct,
      houseChoice: house[dim].value,
      houseShare: +(house[dim].share * 100).toFixed(1),
      distribution: Object.fromEntries(
        Object.entries(dist[dim]).sort((a, b) => b[1] - a[1]).map(([v, c]) => [v, { count: c, pct: +((c / total) * 100).toFixed(1) }])
      ),
    })),
    signalDimensions: signalDims,
    uniformDimensions: uniformDims,
    flagCounts: { ge1: countGE(1), ge2: countGE(2), ge3: countGE(3) },
    topFlagged: ranked.slice(0, 15).map((r) => ({
      file: r.fn.file,
      line: r.fn.line,
      name: r.fn.name,
      fn_style: r.fn.fn_style,
      flagCount: r.flags.length,
      flags: r.flags,
    })),
  };

  const outPath = path.join(__dirname, 'corpus-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${path.relative(REPO_ROOT, outPath).replace(/\\/g, '/')}`);
}

main();
