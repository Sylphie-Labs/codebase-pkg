/**
 * judgeConformity.ts -- the Conformity Judge MCP surface.
 *
 * Answers "does the code I'm writing fit the patterns already in this
 * codebase?" by parsing the working tree (or one file), embedding each
 * function's normalized signature skeleton, and measuring its distance to the
 * COMMITTED descriptive pool (the vectors sync/backfill wrote to Postgres). Per
 * function it reports category, distance, a verdict (decided against the
 * calibrated per-category threshold, or a fallback flagged as uncalibrated), and
 * the nearest existing functions -- so the developer can see what they're
 * diverging from (or matching).
 *
 * Unlike the other MCP tools, this one reads the conformity Postgres store (not
 * Neo4j). It is GATED: if conformity is disabled or Postgres is unreachable, it
 * returns a plain message explaining how to fix it rather than erroring.
 */

import {
  judgeFile,
  judgeWorkingTree,
  isUnavailable,
  type FunctionJudgment,
  type JudgeResult,
} from '../../conformity/judge-worktree.js';

export interface JudgeConformityInput {
  /**
   * Optional file to judge. When given, only that file's functions are judged;
   * otherwise the uncommitted working-tree changes (staged + unstaged +
   * untracked, in watched dirs) are judged.
   */
  filePath?: string;
  /**
   * Max nearest neighbors to report per function (also the kNN distance window).
   * Defaults to the engine's k.
   */
  maxResults?: number;
}

/**
 * Handle the judgeConformity tool call. Returns a readable report leading with
 * the outliers (the functions least like the existing codebase), or a clear
 * unavailable message when the pool/Postgres isn't there.
 */
export async function handleJudgeConformity(
  input: JudgeConformityInput,
): Promise<string> {
  const filePath = input?.filePath?.trim();
  const k = input?.maxResults && input.maxResults > 0 ? input.maxResults : undefined;

  const result: JudgeResult = filePath
    ? await judgeFile(filePath, { k })
    : await judgeWorkingTree({ k });

  if (isUnavailable(result)) {
    return (
      `CONFORMITY JUDGE — unavailable\n` +
      `${'='.repeat(60)}\n\n` +
      `Cannot judge: ${result.reason}.\n\n` +
      `The judge compares your code against a committed "descriptive pool" of\n` +
      `function signature skeletons stored in Postgres. To make it available:\n` +
      `  1. Provision Postgres (run \`codebase-pkg init\`).\n` +
      `  2. Build the pool once: \`codebase-pkg conformity-backfill\`.\n` +
      `  3. (Keep it fresh automatically on every \`codebase-pkg sync\`.)\n` +
      `If you disabled it on purpose, unset CODEBASE_PKG_CONFORMITY=off.`
    );
  }

  const scope = filePath ? `file: ${filePath}` : 'working-tree changes';

  if (result.length === 0) {
    return (
      `CONFORMITY JUDGE — ${scope}\n` +
      `${'='.repeat(60)}\n\n` +
      `No functions to judge` +
      (filePath
        ? ` in ${filePath}.`
        : ` — no uncommitted changes to watched source files.`)
    );
  }

  const outliers = result.filter((j) => j.verdict === 'outlier');
  const conformers = result.filter((j) => j.verdict === 'conforms');
  const unjudged = result.filter((j) => j.verdict === 'unjudged');

  const lines: string[] = [];
  lines.push(`CONFORMITY JUDGE — ${scope}`);
  lines.push('='.repeat(60));
  lines.push(
    `Judged ${result.length} function(s): ` +
      `${outliers.length} outlier, ${conformers.length} conforms` +
      (unjudged.length ? `, ${unjudged.length} unjudged (no peers)` : ''),
  );
  // Calibration status: if every judged-with-peers function used a calibrated
  // threshold, the verdicts are trustworthy; otherwise note that some fell back.
  const judged = result.filter((j) => j.verdict !== 'unjudged');
  const anyUncalibrated = judged.some((j) => j.calibrated === false);
  if (judged.length > 0 && anyUncalibrated) {
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

  // Lead with the outliers (what you're diverging from), then conformers, then
  // anything that had no peers to compare against.
  section('OUTLIERS (least like existing code)', outliers);
  section('CONFORMS', conformers);
  section('UNJUDGED (no same-category peers yet)', unjudged);

  return lines.join('\n');
}

/** Render one function's judgment block. */
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
