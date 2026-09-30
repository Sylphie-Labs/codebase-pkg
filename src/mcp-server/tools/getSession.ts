/**
 * getSession.ts -- fetch every event/decision/learning recorded under one
 * sessionId, chronologically (#9, MCP-SERVER-IMPROVEMENTS.md).
 *
 * Rows carry `sessionId` but recallSimilar's render used to omit it entirely,
 * so a future session seeing a promising hit had no way to pull the sibling
 * learnings/decisions recorded alongside it. recallSimilar now renders
 * `session=<id>` on every hit (see ../recallSimilar.js); this tool is the
 * other half -- given that id, return the whole narrative it belongs to, not
 * just one row. Unlike recallSimilar this is NOT a similarity search (no
 * embedding call): it is a plain lookup on `session_id`, so it is cheap to
 * call speculatively whenever a recall hit's sessionId looks promising.
 */

import { createSessionStore, type SessionStore } from '../../session/store.js';
import { renderFetchedItem } from './recallSimilar.js';

export interface GetSessionInput {
  sessionId: string;
  /** 'text' (default) for direct model consumption, or 'json' for a stable machine-parseable envelope (#10). */
  format?: 'text' | 'json';
}

/** Injectable dependencies for testing; production constructs the real store. */
export interface GetSessionDeps {
  store?: SessionStore;
}

/**
 * Handle the getSession tool call. Validates `sessionId` itself so the error
 * message names this tool; DB/embedding failures propagate to the
 * dispatcher's catch-all.
 */
export async function handleGetSession(
  input: GetSessionInput,
  deps: GetSessionDeps = {},
): Promise<string> {
  if (typeof input?.sessionId !== 'string' || input.sessionId.trim() === '') {
    throw new Error('getSession: "sessionId" is required and must be a non-empty string');
  }

  const store = deps.store ?? createSessionStore();
  const items = await store.getBySession(input.sessionId);

  if (input.format === 'json') {
    return JSON.stringify(
      { schemaVersion: 1, tool: 'getSession', sessionId: input.sessionId, count: items.length, items },
      null,
      2,
    );
  }

  if (items.length === 0) {
    return `SESSION: "${input.sessionId}"\n${'='.repeat(60)}\n\nNo events, decisions, or learnings recorded under this sessionId.`;
  }

  const lines: string[] = [];
  lines.push(`SESSION: "${input.sessionId}"`);
  lines.push('='.repeat(60));
  lines.push(`${items.length} item(s), chronological (oldest first).\n`);
  for (const item of items) lines.push(...renderFetchedItem(item));

  return lines.join('\n');
}
