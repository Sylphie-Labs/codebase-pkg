/**
 * resolveCaveat.ts -- mark an event's caveat resolved WITHOUT deleting it (#5).
 *
 * Events carry caveats like "Jim owes a runtime restart" or "firewall rule
 * not yet created". Once the condition clears, the caveat is *misleading* on
 * every future recall -- and event rows are otherwise immutable. This tool
 * appends a resolution record to the event's `resolutions` column (see
 * SessionStore.resolveCaveat in ../../session/store.js); recallSimilar
 * renders the original caveat text plus `[resolved <date>: note]`, keeping
 * the history honest rather than deleting anything.
 */

import { createSessionStore, type SessionStore } from '../../session/store.js';

export interface ResolveCaveatInput {
  eventId: number;
  caveatIndex: number;
  note?: string;
}

/** Injectable dependencies for testing; production constructs the real store. */
export interface ResolveCaveatDeps {
  store?: SessionStore;
}

/**
 * Handle the resolveCaveat tool call. Validates required fields itself so
 * the error message names this tool; DB failures (including "no such event"
 * / "index out of range", both raised by the store) propagate to the
 * dispatcher's catch-all.
 */
export async function handleResolveCaveat(
  input: ResolveCaveatInput,
  deps: ResolveCaveatDeps = {},
): Promise<string> {
  if (!Number.isInteger(input?.eventId)) {
    throw new Error('resolveCaveat: "eventId" is required and must be an integer id');
  }
  if (!Number.isInteger(input?.caveatIndex) || input.caveatIndex < 0) {
    throw new Error('resolveCaveat: "caveatIndex" is required and must be a non-negative integer');
  }

  const store = deps.store ?? createSessionStore();
  const result = await store.resolveCaveat({
    eventId: input.eventId,
    caveatIndex: input.caveatIndex,
    note: input.note,
  });

  const dateStr = result.resolvedAt.slice(0, 10);
  return (
    `Resolved caveat #${result.caveatIndex} on event #${result.id} (${dateStr})` +
    `${input.note ? `: ${input.note}` : ''}.\n` +
    `Original caveat text preserved (not deleted): "${result.caveatText}"`
  );
}
