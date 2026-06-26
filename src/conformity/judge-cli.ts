/**
 * judge-cli.ts -- `codebase-pkg conformity-judge [file]`.
 *
 * Thin CLI wrapper over the same judgment core the MCP `judgeConformity` tool
 * uses. It reuses the tool's readable-report renderer (handleJudgeConformity) so
 * the CLI and the agent surface stay in lockstep, then prints the report to
 * stdout. Returns a non-zero exit code only on an unexpected failure -- an
 * unavailable pool is a clean, explained exit (0), not an error.
 *
 * The judge core gates itself (disabled / Postgres unreachable -> structured
 * unavailable message), so this command never hard-fails just because the pool
 * has not been provisioned yet.
 */

import { handleJudgeConformity } from '../mcp-server/tools/judgeConformity.js';

/**
 * Run the conformity judge over a single `filePath` (if given) or the current
 * working-tree changes, and print the report. Resolves to a process exit code.
 */
export async function runConformityJudge(filePath?: string): Promise<number> {
  const report = await handleJudgeConformity(
    filePath ? { filePath } : {},
  );
  process.stdout.write(report + '\n');
  return 0;
}
