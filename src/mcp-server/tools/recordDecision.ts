/**
 * recordDecision.ts -- persist a durable repo decision ("do X instead of Y").
 *
 * Writes to Postgres (agent_decisions), embedded for later semantic recall via
 * recallSimilar. When `supersedesId` is given, the prior decision is marked
 * status='superseded' (superseded_by = the new row's id) atomically with the
 * insert -- see SessionStore.recordDecision.
 *
 * Also applies, on every call: secret redaction on free-text fields (#2),
 * a near-duplicate advisory against other ACTIVE decisions (#3, skipped when
 * `supersedesId` is given -- the caller is already resolving the duplicate),
 * and best-effort graphRefs validation against Neo4j (#4, warn-only).
 */

import { createSessionStore, type SessionStore } from '../../session/store.js';
import { formatRedactionNotice } from '../../session/secrets.js';
import { validateGraphRefs, formatGraphRefReport, type RunQueryFn } from './graph-ref-validator.js';

export interface RecordDecisionInput {
  decision: string;
  insteadOf?: string;
  context?: string;
  scope?: string;
  supersedesId?: number;
  sessionId?: string;
  graphRefs?: string[];
}

/** Injectable dependencies for testing; production constructs the real store/runQuery. */
export interface RecordDecisionDeps {
  store?: SessionStore;
  /** Injectable Neo4j query fn for graphRefs validation (#4); production uses the real singleton. */
  runQuery?: RunQueryFn;
}

/**
 * Handle the recordDecision tool call. Validates required fields itself so
 * the error message names this tool; DB/embedding failures propagate to the
 * dispatcher's catch-all. graphRefs validation (#4) never throws -- an
 * unreachable Neo4j is reported inline, not surfaced as a tool failure.
 */
export async function handleRecordDecision(
  input: RecordDecisionInput,
  deps: RecordDecisionDeps = {},
): Promise<string> {
  if (typeof input?.decision !== 'string' || input.decision.trim() === '') {
    throw new Error('recordDecision: "decision" is required and must be a non-empty string');
  }
  if (input.supersedesId != null && !Number.isInteger(input.supersedesId)) {
    throw new Error('recordDecision: "supersedesId" must be an integer id');
  }

  const store = deps.store ?? createSessionStore();
  const { id, redaction, nearDuplicate } = await store.recordDecision({
    decision: input.decision,
    insteadOf: input.insteadOf,
    context: input.context,
    scope: input.scope,
    supersedesId: input.supersedesId,
    sessionId: input.sessionId,
    graphRefs: input.graphRefs,
  });

  const lines: string[] = [
    input.supersedesId != null
      ? `Recorded decision #${id} (supersedes #${input.supersedesId}, now marked superseded).`
      : `Recorded decision #${id}.`,
  ];

  if (redaction) {
    const notice = formatRedactionNotice(redaction.findings);
    if (notice) lines.push(notice);
  }

  if (nearDuplicate) {
    lines.push(
      `This looks similar to existing decision #${nearDuplicate.id} ` +
        `(similarity ${nearDuplicate.similarity.toFixed(2)}) -- consider ` +
        `recordDecision({ ..., supersedesId: ${nearDuplicate.id} }) instead of leaving both active.`,
    );
  }

  if (input.graphRefs && input.graphRefs.length > 0) {
    const report = formatGraphRefReport(await validateGraphRefs(input.graphRefs, deps.runQuery));
    if (report) lines.push(report);
  }

  return lines.join('\n');
}
