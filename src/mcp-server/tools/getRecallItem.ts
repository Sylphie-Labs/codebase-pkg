/**
 * getRecallItem.ts -- fetch the full render of ONE previously recorded event/
 * decision/learning by kind+id (#7, MCP-SERVER-IMPROVEMENTS.md).
 *
 * recallSimilar's `compact: true` mode (../recallSimilar.js) returns a dense
 * one-line-per-hit summary rather than the full multi-thousand-token render
 * of every match -- this tool is the other half: given the kind+id from a
 * compact hit worth expanding, return its full render, unranked (no query to
 * compute a similarity against -- see SessionStore.getItem).
 */

import {
  createSessionStore,
  RECALL_KINDS,
  type RecallKind,
  type SessionStore,
} from '../../session/store.js';
import { renderFetchedItem } from './recallSimilar.js';

export interface GetRecallItemInput {
  kind: string;
  id: number;
  /** 'text' (default) for direct model consumption, or 'json' for a stable machine-parseable envelope (#10). */
  format?: 'text' | 'json';
}

/** Injectable dependencies for testing; production constructs the real store. */
export interface GetRecallItemDeps {
  store?: SessionStore;
}

/**
 * Handle the getRecallItem tool call. Validates `kind`/`id` itself so the
 * error message names this tool; a not-found id raises a plain error (caught
 * by the dispatcher's catch-all, same as every other tool's failure path).
 */
export async function handleGetRecallItem(
  input: GetRecallItemInput,
  deps: GetRecallItemDeps = {},
): Promise<string> {
  if (typeof input?.kind !== 'string' || !(RECALL_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`getRecallItem: "kind" must be one of ${RECALL_KINDS.join(', ')}`);
  }
  if (!Number.isInteger(input?.id)) {
    throw new Error('getRecallItem: "id" is required and must be an integer');
  }

  const store = deps.store ?? createSessionStore();
  const item = await store.getItem(input.kind as RecallKind, input.id);

  if (!item) {
    throw new Error(`getRecallItem: no ${input.kind} #${input.id} found`);
  }

  if (input.format === 'json') {
    return JSON.stringify({ schemaVersion: 1, tool: 'getRecallItem', item }, null, 2);
  }

  return renderFetchedItem(item).join('\n');
}
