/**
 * recordSession.ts -- persist what a session was asked and what it concluded.
 *
 * Called by the Stop hook at the end of a session (or by an agent mid-session)
 * to durably record a query/summary pair in Postgres (agent_events), embedded
 * for later semantic recall via recallSimilar. Read-side: recallSimilar.
 *
 * Upsert-by-sessionId (#8): the Stop-hook capture protocol fires on every
 * stop, and a naive INSERT-only tool creates a new event row per firing --
 * one conversation with two segments produced two disjoint rows, and recall
 * then returned overlapping partial narratives of the same conversation.
 * When `sessionId` matches an existing row, SessionStore.recordEvent updates
 * it in place instead (see ../../session/store.js); this handler just
 * surfaces which happened in the returned text.
 */

import { createSessionStore, type SessionStore } from '../../session/store.js';
import { formatRedactionNotice } from '../../session/secrets.js';
import { validateGraphRefs, formatGraphRefReport, type RunQueryFn } from './graph-ref-validator.js';

export interface RecordSessionInput {
  query: string;
  summary: string;
  caveats?: string[];
  graphRefs?: string[];
  sessionId?: string;
  meta?: Record<string, unknown>;
}

/** Injectable dependencies for testing; production constructs the real store/runQuery. */
export interface RecordSessionDeps {
  store?: SessionStore;
  /** Injectable Neo4j query fn for graphRefs validation (#4); production uses the real singleton. */
  runQuery?: RunQueryFn;
}

/**
 * Handle the recordSession tool call. Validates required fields itself (in
 * addition to the store's own validation) so the error message names this
 * tool. DB/embedding failures propagate to the dispatcher's catch-all, which
 * returns them as `isError` with the underlying message. graphRefs
 * validation (#4) never throws -- an unreachable Neo4j is reported inline,
 * not surfaced as a tool failure, since the Postgres write already committed.
 */
export async function handleRecordSession(
  input: RecordSessionInput,
  deps: RecordSessionDeps = {},
): Promise<string> {
  if (typeof input?.query !== 'string' || input.query.trim() === '') {
    throw new Error('recordSession: "query" is required and must be a non-empty string');
  }
  if (typeof input?.summary !== 'string' || input.summary.trim() === '') {
    throw new Error('recordSession: "summary" is required and must be a non-empty string');
  }

  const store = deps.store ?? createSessionStore();
  const { id, updated, redaction } = await store.recordEvent({
    query: input.query,
    summary: input.summary,
    caveats: input.caveats,
    graphRefs: input.graphRefs,
    sessionId: input.sessionId,
    meta: input.meta,
  });

  const lines: string[] = [
    updated
      ? `Updated session event #${id} (appended a new segment to the existing sessionId).`
      : `Recorded session event #${id}.`,
  ];

  if (redaction) {
    const notice = formatRedactionNotice(redaction.findings);
    if (notice) lines.push(notice);
  }

  if (input.graphRefs && input.graphRefs.length > 0) {
    const report = formatGraphRefReport(await validateGraphRefs(input.graphRefs, deps.runQuery));
    if (report) lines.push(report);
  }

  return lines.join('\n');
}
