/**
 * target-run.mjs -- TARGET (accepted/preferred) style layer over the
 * per-decision conformity probe (Half C).
 *
 * corpus-run.mjs computes the DESCRIPTIVE distribution: what the code actually
 * does, per decision axis. Flagging against that means "you disagree with the
 * current majority" -- which has two failure modes:
 *
 *   - bad consensus: if the majority chose the WORSE option, the good choice
 *     reads as the outlier. Descriptive flagging entrenches legacy.
 *   - cold start: an axis/value with no examples yet can't be a target at all.
 *
 * The PRESCRIPTIVE fix is a target pool: a preferred value per axis
 * ({ dimension: preferredValue }) that we judge against instead of "any
 * minority." The target can be seeded from the descriptive mode (the common
 * case: the convention already in force becomes the rule) and then OVERRIDDEN
 * by human-accepted preferences -- including flipping to a current minority
 * ("we've decided to standardize on Array<T>") or naming a value with zero
 * occurrences (cold start). Conformity then means "matches target," and the
 * descriptive-vs-target gap becomes a concrete migration backlog.
 *
 * No model, no DB. Pure ts-morph + counting. Deterministic. Reads ./src only;
 * never writes to it.
 */

import { Project, Node } from 'ts-morph';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { walk } from '../conformity-corpus/walk.mjs';
import {
  CURATED_AXES,
  AXIS_NONE_VALUE,
  seedTarget,
  applyOverrides,
  judgeAgainstTarget,
  migrationProgress,
} from './target.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

// ---------------------------------------------------------------------------
// Fact extraction -- identical detectors to corpus-run.mjs, restricted to the
// dimensions the curated axes need (we keep the full set so the facts object
// stays comparable, but only the curated axes drive target judging).
// ---------------------------------------------------------------------------
function makeProject() {
  return new Project({
    compilerOptions: { target: 99, module: 99, strict: true, esModuleInterop: true },
    skipFileDependencyResolution: true,
  });
}

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
  if (total === 0) return 'none';
  if (constN > 0 && letN === 0 && varN === 0) return 'const';
  if (letN > 0 && constN === 0 && varN === 0) return 'let';
  return 'mixed';
}

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

function stringStyle(body) {
  let template = false;
  let concat = false;
  if (body) {
    body.forEachDescendant((node) => {
      if (Node.isTemplateExpression(node) || Node.isNoSubstitutionTemplateLiteral(node)) template = true;
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

function factsForFunction(fn, kind, name, exportStyle) {
  const params = fn.getParameters();
  const paramTypeTexts = params.map((p) => p.getTypeNode()?.getText() ?? '');
  const returnNode = fn.getReturnTypeNode?.();
  const returnText = returnNode?.getText() ?? '';
  const body = fn.getBody?.();
  return {
    name,
    fn_style: kind,
    array_syntax: arraySyntax([...paramTypeTexts, returnText]),
    var_decl: varDecl(body),
    async_style: asyncStyle(fn, body),
    string_style: stringStyle(body),
    export_style: exportStyle,
  };
}

function extractFileAll(filePath, sf) {
  const out = [];
  const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');

  for (const fn of sf.getFunctions()) {
    const nm = fn.getName();
    if (!nm) continue;
    let exportStyle = 'none';
    if (fn.isExported()) exportStyle = fn.isDefaultExport?.() ? 'default' : 'named';
    const f = factsForFunction(fn, 'function', nm, exportStyle);
    f.file = rel; f.line = fn.getStartLineNumber();
    out.push(f);
  }
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
    f.file = rel; f.line = init.getStartLineNumber();
    out.push(f);
  }
  for (const cls of sf.getClasses()) {
    const cn = cls.getName() ?? 'Anon';
    const clsExported = cls.isExported();
    const es = clsExported ? (cls.isDefaultExport?.() ? 'default' : 'named') : 'none';
    for (const m of cls.getMethods()) {
      const f = factsForFunction(m, 'method', `${cn}.${m.getName()}`, es);
      f.file = rel; f.line = m.getStartLineNumber();
      out.push(f);
    }
    for (const ctor of cls.getConstructors()) {
      const f = factsForFunction(ctor, 'method', `${cn}.constructor`, es);
      f.file = rel; f.line = ctor.getStartLineNumber();
      out.push(f);
    }
  }
  return out;
}

function distributions(facts) {
  const dist = {};
  for (const dim of CURATED_AXES) {
    dist[dim] = {};
    for (const f of facts) {
      const v = String(f[dim]);
      dist[dim][v] = (dist[dim][v] ?? 0) + 1;
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
function main() {
  const files = walk(SRC_DIR);
  const project = makeProject();
  const allFacts = [];
  for (const fp of files) {
    const sf = project.addSourceFileAtPath(fp);
    allFacts.push(...extractFileAll(fp, sf));
  }
  const total = allFacts.length;
  const dist = distributions(allFacts);

  // Base-rate guard: an axis whose substantive (non-`none`) population is a tiny
  // absolute number can't carry a meaningful target -- a 1-of-2 "majority" is
  // noise. Require at least MIN_SUBSTANTIVE deciding functions on the axis.
  const MIN_SUBSTANTIVE = 10;
  const substantiveCount = {};
  for (const dim of CURATED_AXES) {
    let n = 0;
    for (const [v, c] of Object.entries(dist[dim])) {
      if (v !== AXIS_NONE_VALUE[dim]) n += c;
    }
    substantiveCount[dim] = n;
  }

  // 1+2. Seed the target from the descriptive mode (excluding the axis's
  // "absence" value -- a style guide says "use template literals", never
  // "use no strings").
  const seeded = seedTarget(dist);

  // -- console: inferred style guide --
  console.log(`\n=== TARGET STYLE LAYER: codebase-pkg/src ===`);
  console.log(`Functions/methods analyzed: ${total}   Curated axes: ${CURATED_AXES.join(', ')}`);

  console.log(`\n--- (1) Inferred style guide (seed = descriptive mode of substantive values) ---`);
  for (const dim of CURATED_AXES) {
    const guarded = substantiveCount[dim] < MIN_SUBSTANTIVE;
    const tv = seeded[dim];
    const c = tv == null ? 0 : (dist[dim][tv] ?? 0);
    const note = guarded ? '  [BASE-RATE GUARD: too few deciding fns, target not enforced]' : '';
    console.log(`    ${dim.padEnd(14)} -> ${String(tv).padEnd(16)} (${c}/${total} fns, ${substantiveCount[dim]} substantive)${note}`);
  }

  // 3a. Bad-consensus flip: array_syntax mode is `bracket` (~39%, the clear
  // substantive majority). Override the target to `generic` -- "we standardize
  // on Array<T>". The formerly-conforming bracket majority becomes to-migrate.
  // 3b. Cold start: target export_style = `default`, which has ZERO occurrences.
  const overrides = {
    array_syntax: 'generic', // (a) bad-consensus flip
    export_style: 'default', // (b) cold start (0 occurrences in src)
  };
  const target = applyOverrides(seeded, overrides);

  console.log(`\n--- (2) Overrides applied (human-accepted preferences) ---`);
  for (const dim of Object.keys(overrides)) {
    const fromV = seeded[dim];
    const toV = overrides[dim];
    const atTo = dist[dim][toV] ?? 0;
    const tag = atTo === 0 ? 'COLD START (0 occurrences)' : `was mode; ${atTo}/${total} already there`;
    console.log(`    ${dim.padEnd(14)} ${String(fromV).padEnd(16)} => ${String(toV).padEnd(16)} [${tag}]`);
  }

  console.log(`\n--- Final target pool (style guide in force) ---`);
  for (const dim of CURATED_AXES) {
    console.log(`    ${dim.padEnd(14)} = ${target[dim]}`);
  }

  // 4. Judge each function against the target.
  const verdicts = judgeAgainstTarget(allFacts, target, {
    enforce: CURATED_AXES.filter((d) => substantiveCount[d] >= MIN_SUBSTANTIVE || overrides[d] != null),
  });

  // 5. Migration progress per axis.
  const progress = migrationProgress(allFacts, target, {
    enforce: CURATED_AXES.filter((d) => substantiveCount[d] >= MIN_SUBSTANTIVE || overrides[d] != null),
  });

  console.log(`\n--- (3a) Bad-consensus flip: array_syntax bracket -> generic ---`);
  {
    const p = progress.array_syntax;
    console.log(`    Target = generic ("standardize on Array<T>").`);
    console.log(`    Before flip the bracket majority CONFORMED. After flip: ${p.offTarget} fns are off-target (to-migrate), ${p.atTarget} already at target.`);
    console.log(`    Polarity flipped: the formerly-conforming ${dist.array_syntax.bracket ?? 0} bracket fns now read as "diverges from target".`);
  }

  console.log(`\n--- (3b) Cold start: export_style target = default (0 in corpus) ---`);
  {
    const p = progress.export_style;
    console.log(`    Expressible even with zero examples. ${p.atTarget}/${p.considered} at target -> everything reads as not-yet-at-target.`);
  }

  console.log(`\n--- (4) Example per-function verdicts vs target (explainable, per-decision) ---`);
  // Show a spread: some fully conforming, some with off-target axes.
  const withFlags = verdicts.filter((v) => v.flags.length > 0);
  const clean = verdicts.filter((v) => v.flags.length === 0);
  const sample = [...withFlags.slice(0, 6), ...clean.slice(0, 2)];
  for (const v of sample) {
    console.log(`  ${v.file}:${v.line}  ${v.name}  -> ${v.flags.length === 0 ? 'CONFORMS (all enforced axes at target)' : `${v.flags.length} off-target`}`);
    for (const fl of v.flags) {
      console.log(`        ${fl.dim}: uses ${fl.value}; target is ${fl.target}`);
    }
  }

  console.log(`\n--- (5) Migration progress (descriptive-vs-target gap) ---`);
  for (const dim of CURATED_AXES) {
    const p = progress[dim];
    if (!p) {
      console.log(`    ${dim.padEnd(14)}  [not enforced - base-rate guard]`);
      continue;
    }
    console.log(`    ${dim.padEnd(14)}  ${p.pct.toFixed(1)}% at target (${p.atTarget}/${p.considered})   remaining to migrate: ${p.offTarget}`);
  }

  const offTargetFns = verdicts.filter((v) => v.flags.length > 0).length;
  console.log(`\n--- Summary ---`);
  console.log(`  Functions with >=1 off-target enforced axis: ${offTargetFns}/${total}`);

  // 6. JSON report.
  const report = {
    generatedAt: new Date().toISOString(),
    root: 'src',
    functionsAnalyzed: total,
    curatedAxes: CURATED_AXES,
    baseRateGuard: { minSubstantive: MIN_SUBSTANTIVE, substantiveCount },
    descriptiveDistribution: Object.fromEntries(
      CURATED_AXES.map((dim) => [dim, dist[dim]]),
    ),
    seededTarget: seeded,
    overrides,
    finalTarget: target,
    enforcedAxes: CURATED_AXES.filter((d) => substantiveCount[d] >= MIN_SUBSTANTIVE || overrides[d] != null),
    migrationProgress: progress,
    scenarios: {
      badConsensusFlip: {
        axis: 'array_syntax',
        from: seeded.array_syntax,
        to: overrides.array_syntax,
        atTarget: progress.array_syntax.atTarget,
        offTarget: progress.array_syntax.offTarget,
      },
      coldStart: {
        axis: 'export_style',
        to: overrides.export_style,
        occurrencesInCorpus: dist.export_style[overrides.export_style] ?? 0,
        atTarget: progress.export_style.atTarget,
        considered: progress.export_style.considered,
      },
    },
    offTargetFunctions: offTargetFns,
    sampleVerdicts: verdicts.slice(0, 25).map((v) => ({
      file: v.file, line: v.line, name: v.name, flags: v.flags,
    })),
  };
  const outPath = path.join(__dirname, 'target-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${path.relative(REPO_ROOT, outPath).replace(/\\/g, '/')}`);
}

main();
