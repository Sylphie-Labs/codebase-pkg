/**
 * judgeConformity.ts -- the Conformity Judge MCP surface.
 *
 * Answers "does the code I'm writing fit this codebase?" with TWO signals:
 *
 *   1. STYLE CONFORMITY (per-decision) -- the PRIMARY signal. For each function
 *      it reads the discrete coding DECISIONS made on a curated set of
 *      equivalent-choice axes (var_decl / string_style / async_style /
 *      array_syntax / export_style) and judges each against the codebase's own
 *      effective target (descriptive seed + conformity-target.json overrides).
 *      Findings are deterministic and explainable: "uses let; target is const".
 *
 *   2. SEMANTIC NOVELTY (embedding distance) -- the SECONDARY signal. For each
 *      function it embeds the normalized body and measures its kNN distance to
 *      the committed descriptive pool, flagging the ones least like existing
 *      code. This is a softer "is this shaped like other code?" hint.
 *
 * Both read the conformity Postgres store (not Neo4j). The tool is GATED: if
 * conformity is disabled or Postgres is unreachable, it says so once and skips
 * both rather than erroring.
 */

import {
  judgeFile,
  judgeWorkingTree,
  isUnavailable,
  type FunctionJudgment,
  type JudgeResult,
} from '../../conformity/judge-worktree.js';
import {
  judgeFileDecisions,
  judgeWorkingTreeDecisions,
  isDecisionUnavailable,
  type DecisionFileResult,
  type DecisionFunctionResult,
  type DecisionJudgeResult,
} from '../../conformity/decisions/judge-decisions.js';

export interface JudgeConformityInput {
  /**
   * Optional file to judge. When given, only that file's functions are judged;
   * otherwise the uncommitted working-tree changes (staged + unstaged +
   * untracked, in watched dirs) are judged.
   */
  filePath?: string;
  /**
   * Max nearest neighbors to report per function in the SEMANTIC NOVELTY section
   * (also the kNN distance window). Defaults to the engine's k.
   */
  maxResults?: number;
}

/**
 * Handle the judgeConformity tool call. Runs BOTH judges and renders a report
 * leading with per-decision STYLE conformity (primary), followed by embedding-
 * distance SEMANTIC NOVELTY (secondary). If the conformity store is unavailable,
 * says so once and returns a clear how-to-fix message.
 */
export async function handleJudgeConformity(
  input: JudgeConformityInput,
): Promise<string> {
  const filePath = input?.filePath?.trim();
  const k = input?.maxResults && input.maxResults > 0 ? input.maxResults : undefined;

  // Run both judges. The decision judge is the primary signal; the embedding
  // judge is the secondary "novelty" signal.
  const [decisionResult, embeddingResult]: [DecisionJudgeResult, JudgeResult] =
    await Promise.all([
      filePath ? judgeFileDecisions(filePath) : judgeWorkingTreeDecisions(),
      filePath ? judgeFile(filePath, { k }) : judgeWorkingTree({ k }),
    ]);

  const scope = filePath ? `file: ${filePath}` : 'working-tree changes';

  // Both judges share the same gate (conformity disabled / Postgres down). If
  // EITHER reports unavailable, the store isn't there -- say so once, skip both.
  if (isDecisionUnavailable(decisionResult) || isUnavailable(embeddingResult)) {
    const reason = isDecisionUnavailable(decisionResult)
      ? decisionResult.reason
      : isUnavailable(embeddingResult)
        ? embeddingResult.reason
        : 'unavailable';
    return (
      `CONFORMITY JUDGE — unavailable\n` +
      `${'='.repeat(60)}\n\n` +
      `Cannot judge: ${reason}.\n\n` +
      `The judge compares your code against a committed conformity store in\n` +
      `Postgres (per-decision style facts + function-body vectors). To make it\n` +
      `available:\n` +
      `  1. Provision Postgres (run \`codebase-pkg init\`).\n` +
      `  2. Build the store once: \`codebase-pkg conformity-backfill\`.\n` +
      `  3. (Keep it fresh automatically on every \`codebase-pkg sync\`.)\n` +
      `If you disabled it on purpose, unset CODEBASE_PKG_CONFORMITY=off.`
    );
  }

  const lines: string[] = [];
  lines.push(`CONFORMITY JUDGE — ${scope}`);
  lines.push('='.repeat(60));

  // Empty scope: nothing to judge (both judges agree there are no entities).
  if (decisionResult.totalFunctions === 0 && embeddingResult.length === 0) {
    lines.push('');
    lines.push(
      `No code entities to judge` +
        (filePath
          ? ` in ${filePath}.`
          : ` — no uncommitted changes to watched source files.`),
    );
    return lines.join('\n');
  }

  renderDecisionSection(lines, decisionResult);
  renderNoveltySection(lines, embeddingResult);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// PRIMARY: per-decision STYLE conformity
// ---------------------------------------------------------------------------

/** Render the primary STYLE-CONFORMITY section from the decision judge result. */
function renderDecisionSection(lines: string[], result: DecisionFileResult): void {
  lines.push('');
  lines.push('#'.repeat(60));
  lines.push('STYLE CONFORMITY (per-decision) — PRIMARY');
  lines.push('#'.repeat(60));

  const targetSource = result.hasOverrides
    ? 'seed + conformity-target.json overrides'
    : 'seed-only (no conformity-target.json present — using the codebase mode)';
  lines.push(
    `Judged ${result.totalFunctions} function(s) against the effective target ` +
      `(${targetSource}):`,
  );
  lines.push(
    `  ${result.conformingFunctions} fully conform, ` +
      `${result.offTargetFunctions} have >=1 off-target decision ` +
      `(${result.totalFlags} off-target decision(s) total).`,
  );
  // Show the enforced target per axis so the developer sees what they're held to.
  lines.push(`  Enforced axes: ${result.enforcedAxes.length ? result.enforcedAxes.join(', ') : '(none — too few examples yet)'}`);

  const offTarget = result.functions.filter((f) => f.flags.length > 0);
  if (offTarget.length === 0) {
    lines.push('');
    lines.push('  All functions conform on every enforced axis. ✓');
    return;
  }

  lines.push('');
  lines.push('-'.repeat(40));
  lines.push('OFF-TARGET (most divergent first)');
  lines.push('-'.repeat(40));
  for (const fn of offTarget) lines.push(...renderDecisionFunction(fn));
}

/** Render one function's off-target decision block. */
function renderDecisionFunction(fn: DecisionFunctionResult): string[] {
  const out: string[] = [];
  out.push('');
  const n = fn.flags.length;
  out.push(`  ${fn.name}   [${n} off-target decision${n === 1 ? '' : 's'}]`);
  out.push(`    File: ${fn.filePath}:${fn.lineNumber}`);
  for (const flag of fn.flags) {
    out.push(`    - ${flag.axis}: uses ${flag.value}; target is ${flag.target}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SECONDARY: semantic novelty (embedding distance)
// ---------------------------------------------------------------------------

/** Render the secondary SEMANTIC-NOVELTY section from the embedding judge result. */
function renderNoveltySection(lines: string[], result: FunctionJudgment[]): void {
  lines.push('');
  lines.push('#'.repeat(60));
  lines.push('SEMANTIC NOVELTY (embedding distance) — SECONDARY');
  lines.push('#'.repeat(60));

  if (result.length === 0) {
    lines.push('');
    lines.push('  No code entities to compare against the embedding pool.');
    return;
  }

  const outliers = result.filter((j) => j.verdict === 'outlier');
  const conformers = result.filter((j) => j.verdict === 'conforms');
  const unjudged = result.filter((j) => j.verdict === 'unjudged');

  lines.push(
    `Compared ${result.length} code entit${result.length === 1 ? 'y' : 'ies'} ` +
      `(functions, types, constants) to the committed body-vector pool: ` +
      `${outliers.length} novel/outlier, ${conformers.length} typical` +
      (unjudged.length ? `, ${unjudged.length} unjudged (no peers)` : ''),
  );

  const judged = result.filter((j) => j.verdict !== 'unjudged');
  if (judged.length > 0 && judged.some((j) => j.calibrated === false)) {
    lines.push(
      `Some verdicts are UNCALIBRATED (no calibrated threshold for the category — ` +
        `run \`codebase-pkg conformity-backfill\`); treat those as a weak hint.`,
    );
  }

  const section = (title: string, items: FunctionJudgment[]): void => {
    if (items.length === 0) return;
    lines.push('');
    lines.push('-'.repeat(40));
    lines.push(title);
    lines.push('-'.repeat(40));
    for (const j of items) lines.push(...renderJudgment(j));
  };

  section('MOST NOVEL (least like existing code)', outliers);
  section('TYPICAL', conformers);
  section('UNJUDGED (no same-category peers yet)', unjudged);
}

/** Render one function's embedding-judgment block. */
function renderJudgment(j: FunctionJudgment): string[] {
  const out: string[] = [];
  const dist = j.distance == null ? 'n/a' : j.distance.toFixed(4);
  out.push('');
  out.push(`  ${j.name}   [${j.verdict}]  distance=${dist}`);
  if (j.verdict !== 'unjudged' && j.threshold != null) {
    const thr = j.threshold.toFixed(4);
    out.push(
      j.calibrated
        ? `    Threshold: ${thr} (calibrated)`
        : `    Threshold: ${thr} (uncalibrated — run conformity-backfill)`,
    );
  }
  out.push(`    File: ${j.filePath}`);
  out.push(`    Category: ${j.category}  (compared against ${j.poolSize} peer(s))`);
  out.push(`    Skeleton: ${j.skeleton}`);
  if (j.nearest.length > 0) {
    out.push(`    Nearest existing functions:`);
    for (const n of j.nearest) {
      out.push(`      ${n.distance.toFixed(4)}  ${n.nodeId}`);
    }
  } else if (j.verdict === 'unjudged') {
    out.push(`    (no committed peers in this category to compare against)`);
  }
  return out;
}
