/**
 * recordLearning.ts -- persist a freestanding gotcha/pattern/fact.
 *
 * Writes to Postgres (agent_learnings), embedded for later semantic recall via
 * recallSimilar. Mirrors recordDecision's amend/supersede model (#1): pass
 * `supersedesId` to flip a prior learning to status='superseded' atomically
 * with the new insert -- a learning that turns out weak or wrong (e.g.
 * anchored to the wrong graphRef) no longer has to be "fixed" by leaving a
 * near-duplicate row that pollutes recall rankings forever.
 *
 * Also applies, on every call: secret redaction on `content` (#2), a
 * near-duplicate advisory against other ACTIVE learnings (#3, skipped when
 * `supersedesId` is given -- the caller is already resolving the duplicate),
 * and best-effort graphRefs validation against Neo4j (#4, warn-only).
 */

import { createSessionStore, type SessionStore } from '../../session/store.js';
import { formatRedactionNotice } from '../../session/secrets.js';
import { validateGraphRefs, formatGraphRefReport, type RunQueryFn } from './graph-ref-validator.js';

const VALID_KINDS = new Set(['gotcha', 'pattern', 'fact']);

export interface RecordLearningInput {
  content: string;
  kind?: 'gotcha' | 'pattern' | 'fact';
  graphRefs?: string[];
  sessionId?: string;
  /**
   * Id of a prior learning this one supersedes (mirrors recordDecision's
   * `supersedesId`, not the MCP-SERVER-IMPROVEMENTS.md doc's literal
   * `supersedes` name -- kept consistent with the sibling tool's existing
   * param name rather than introducing a second convention).
   */
  supersedesId?: number;
}

/** Injectable dependencies for testing; production constructs the real store/runQuery. */
export interface RecordLearningDeps {
  store?: SessionStore;
  /** Injectable Neo4j query fn for graphRefs validation (#4); production uses the real singleton. */
  runQuery?: RunQueryFn;
}

/**
 * Handle the recordLearning tool call. Validates required fields itself so
 * the error message names this tool; DB/embedding failures propagate to the
 * dispatcher's catch-all. graphRefs validation (#4) never throws -- an
 * unreachable Neo4j is reported inline, not surfaced as a tool failure.
 */
export async function handleRecordLearning(
  input: RecordLearningInput,
  deps: RecordLearningDeps = {},
): Promise<string> {
  if (typeof input?.content !== 'string' || input.content.trim() === '') {
    throw new Error('recordLearning: "content" is required and must be a non-empty string');
  }
  if (input.kind != null && !VALID_KINDS.has(input.kind)) {
    throw new Error(
      `recordLearning: "kind" must be one of ${[...VALID_KINDS].join(', ')}, got "${input.kind}"`,
    );
  }
  if (input.supersedesId != null && !Number.isInteger(input.supersedesId)) {
    throw new Error('recordLearning: "supersedesId" must be an integer id');
  }

  const store = deps.store ?? createSessionStore();
  const { id, redaction, nearDuplicate } = await store.recordLearning({
    content: input.content,
    kind: input.kind,
    graphRefs: input.graphRefs,
    sessionId: input.sessionId,
    supersedesId: input.supersedesId,
  });

  const lines: string[] = [
    input.supersedesId != null
      ? `Recorded learning #${id}${input.kind ? ` [${input.kind}]` : ''} (supersedes #${input.supersedesId}, now marked superseded).`
      : `Recorded learning #${id}${input.kind ? ` [${input.kind}]` : ''}.`,
  ];

  if (redaction) {
    const notice = formatRedactionNotice(redaction.findings);
    if (notice) lines.push(notice);
  }

  if (nearDuplicate) {
    lines.push(
      `This looks like existing learning #${nearDuplicate.id} ` +
        `(similarity ${nearDuplicate.similarity.toFixed(2)}) -- consider ` +
        `recordLearning({ ..., supersedesId: ${nearDuplicate.id} }) instead of leaving both.`,
    );
  }

  if (input.graphRefs && input.graphRefs.length > 0) {
    const report = formatGraphRefReport(await validateGraphRefs(input.graphRefs, deps.runQuery));
    if (report) lines.push(report);
  }

  return lines.join('\n');
}
