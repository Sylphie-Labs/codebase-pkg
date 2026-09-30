/**
 * recallSimilar.ts -- semantic recall over recorded session events, decisions,
 * and learnings (agent_events / agent_decisions / agent_learnings).
 *
 * CHECK THIS BEFORE READING FILES: a past session may already have answered
 * the exact question at hand, recorded a decision that rules an approach in
 * or out, or logged a gotcha that would otherwise cost a rediscovery. A high-
 * similarity hit can answer the question directly without touching the repo.
 *
 * Ranking is a hybrid score (#6), not pure cosine -- see
 * SessionStore.recallSimilar / computeRankScore in ../../session/store.js for
 * the weights and rationale. `nearRefs` (also #6) is expanded to its
 * immediate Neo4j neighborhood here (the tool layer, which already owns
 * Neo4j access via graph-ref-validator.js) before being handed to the store,
 * which only ever does the boost/filter set-intersection -- SessionStore
 * itself never touches Neo4j.
 */

import {
  createSessionStore,
  RECALL_KINDS,
  type CaveatResolution,
  type FetchedDecision,
  type FetchedEvent,
  type FetchedItem,
  type FetchedLearning,
  type RecallKind,
  type RecalledDecision,
  type RecalledEvent,
  type RecalledItem,
  type RecalledLearning,
  type SessionStore,
} from '../../session/store.js';
import { expandNearRefs, type RunQueryFn } from './graph-ref-validator.js';

/** Max characters of the primary text field shown per hit in compact mode (#7). */
const COMPACT_SNIPPET_LEN = 120;

export interface RecallSimilarInput {
  query: string;
  kinds?: string[];
  k?: number;
  includeSuperseded?: boolean;
  /** Boost (default) or filter (with nearRefsFilter=true) items whose graphRefs touch these ids or their immediate Neo4j neighborhood (#6). */
  nearRefs?: string[];
  /** When true AND nearRefs is given, drop items with no graphRefs overlap instead of merely boosting them. Defaults to false. */
  nearRefsFilter?: boolean;
  /** Restrict recall to rows recorded under this sessionId (#9). */
  sessionId?: string;
  /** One line per hit (kind, id, similarity, first ~120 chars) instead of the full render (#7). Prefer this first; follow up with getRecallItem for the one or two hits worth expanding. */
  compact?: boolean;
  /** 'text' (default) for direct model consumption, or 'json' for a stable machine-parseable envelope (#10). */
  format?: 'text' | 'json';
}

/** Injectable dependencies for testing; production constructs the real store/runQuery. */
export interface RecallSimilarDeps {
  store?: SessionStore;
  /** Injectable Neo4j query fn for nearRefs neighborhood expansion (#6); production uses the real singleton. */
  runQuery?: RunQueryFn;
}

/**
 * Handle the recallSimilar tool call. Validates required fields + the `kinds`
 * enum itself so the error message names this tool; DB/embedding failures
 * propagate to the dispatcher's catch-all.
 */
export async function handleRecallSimilar(
  input: RecallSimilarInput,
  deps: RecallSimilarDeps = {},
): Promise<string> {
  if (typeof input?.query !== 'string' || input.query.trim() === '') {
    throw new Error('recallSimilar: "query" is required and must be a non-empty string');
  }

  let kinds: RecallKind[] | undefined;
  if (input.kinds != null) {
    if (!Array.isArray(input.kinds) || input.kinds.length === 0) {
      throw new Error('recallSimilar: "kinds" must be a non-empty array when given');
    }
    for (const k of input.kinds) {
      if (!(RECALL_KINDS as readonly string[]).includes(k)) {
        throw new Error(
          `recallSimilar: invalid kind "${k}" -- must be one of ${RECALL_KINDS.join(', ')}`,
        );
      }
    }
    kinds = input.kinds as RecallKind[];
  }

  let nearRefs: string[] | undefined;
  let nearRefsSkipNote = '';
  if (input.nearRefs && input.nearRefs.length > 0) {
    const expansion = await expandNearRefs(input.nearRefs, deps.runQuery);
    nearRefs = expansion?.expanded;
    if (expansion?.skipped) {
      nearRefsSkipNote =
        `\n(nearRefs neighborhood expansion skipped -- Neo4j unreachable ` +
        `(${expansion.skipReason ?? 'unknown error'}); boosting/filtering on the given refs only.)`;
    }
  }

  const store = deps.store ?? createSessionStore();
  const results = await store.recallSimilar({
    query: input.query,
    kinds,
    k: input.k,
    includeSuperseded: input.includeSuperseded,
    nearRefs,
    nearRefsFilter: input.nearRefsFilter,
    sessionId: input.sessionId,
  });

  if (input.format === 'json') {
    return JSON.stringify(
      {
        schemaVersion: 1,
        tool: 'recallSimilar',
        query: input.query,
        count: results.length,
        results,
      },
      null,
      2,
    );
  }

  if (results.length === 0) {
    return `RECALL: "${input.query}"\n${'='.repeat(60)}\n\nNo matching events, decisions, or learnings found.${nearRefsSkipNote}`;
  }

  const lines: string[] = [];
  lines.push(`RECALL: "${input.query}"`);
  lines.push('='.repeat(60));
  lines.push(
    `${results.length} match(es), ranked by hybrid score (cosine + lexical + recency; highest first).` +
      (input.compact
        ? ' Compact mode -- use getRecallItem(kind, id) for the full render of a hit.'
        : ''),
  );
  lines.push('');

  if (input.compact) {
    for (const r of results) lines.push(renderCompactLine(r));
  } else {
    for (const r of results) lines.push(...renderItem(r));
  }

  if (nearRefsSkipNote) lines.push(nearRefsSkipNote.trim());

  return lines.join('\n');
}

/** One-line compact render (#7): `[kind] id=N similarity=0.9000 session=<id>  <snippet>`. */
function renderCompactLine(r: RecalledItem): string {
  const snippet = truncate(primaryText(r), COMPACT_SNIPPET_LEN);
  return `[${r.kind}] id=${r.id} similarity=${r.similarity.toFixed(4)} session=${r.sessionId ?? 'none'}  ${snippet}`;
}

/** The single most representative text field per kind, for compact-mode snippets. */
function primaryText(r: RecalledItem | FetchedItem): string {
  switch (r.kind) {
    case 'event':
      return `${r.query} -- ${r.summary}`;
    case 'decision':
      return r.insteadOf ? `${r.decision} (instead of ${r.insteadOf})` : r.decision;
    case 'learning':
      return r.content;
  }
}

function truncate(text: string, maxLen: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen - 1)}…`;
}

/** Full render of one recalled (query-ranked) item: header WITH similarity, then the shared body. */
export function renderItem(r: RecalledItem): string[] {
  const out: string[] = [renderHeader(r.kind, r.id, r.createdAt, r.sessionId, r.similarity)];
  out.push(...renderBody(r));
  if (r.graphRefs.length > 0) out.push(`  Graph refs: ${r.graphRefs.join(', ')}`);
  out.push('');
  return out;
}

/** Full render of one fetched-by-id item (#7 getRecallItem, #9 getSession): header WITHOUT similarity (there was no query to rank against), then the shared body. */
export function renderFetchedItem(r: FetchedItem): string[] {
  const out: string[] = [renderHeader(r.kind, r.id, r.createdAt, r.sessionId)];
  out.push(...renderBody(r));
  if (r.graphRefs.length > 0) out.push(`  Graph refs: ${r.graphRefs.join(', ')}`);
  out.push('');
  return out;
}

/** `[kind]  id=N  similarity=0.9000  session=<id|none>  <createdAt>` -- similarity segment omitted when not given. Renders `session=<id>` per #9. */
function renderHeader(
  kind: RecallKind,
  id: number,
  createdAt: string,
  sessionId: string | null,
  similarity?: number,
): string {
  const parts = [`[${kind}]`, `id=${id}`];
  if (similarity != null) parts.push(`similarity=${similarity.toFixed(4)}`);
  parts.push(`session=${sessionId ?? 'none'}`, createdAt);
  return parts.join('  ');
}

/** Kind-specific body lines, shared between the ranked (RecalledItem) and unranked (FetchedItem) renders -- both shapes carry the same fields minus similarity/score. */
function renderBody(r: RecalledItem | FetchedItem): string[] {
  const out: string[] = [];
  switch (r.kind) {
    case 'event':
      out.push(...renderEventBody(r));
      break;
    case 'decision':
      out.push(...renderDecisionBody(r));
      break;
    case 'learning':
      out.push(...renderLearningBody(r));
      break;
  }
  return out;
}

function renderEventBody(r: RecalledEvent | FetchedEvent): string[] {
  const out: string[] = [];
  out.push(`  Query:   ${r.query}`);
  out.push(`  Summary: ${r.summary}`);
  if (r.caveats.length > 0) out.push(`  Caveats: ${renderCaveats(r.caveats, r.resolutions)}`);
  if (r.repo) out.push(`  Repo: ${r.repo}`);
  return out;
}

function renderDecisionBody(r: RecalledDecision | FetchedDecision): string[] {
  const out: string[] = [];
  out.push(`  Decision: ${r.decision}`);
  if (r.insteadOf) out.push(`  Instead of: ${r.insteadOf}`);
  if (r.context) out.push(`  Context: ${r.context}`);
  if (r.scope) out.push(`  Scope: ${r.scope}`);
  out.push(
    `  Status: ${r.status}${r.supersededBy != null ? ` (superseded by #${r.supersededBy})` : ''}`,
  );
  return out;
}

function renderLearningBody(r: RecalledLearning | FetchedLearning): string[] {
  const out: string[] = [];
  out.push(`  [${r.learningKind}] ${r.content}`);
  if (r.status !== 'active') {
    out.push(
      `  Status: ${r.status}${r.supersededBy != null ? ` (superseded by #${r.supersededBy})` : ''}`,
    );
  }
  return out;
}

/**
 * Render an event's caveats, appending `[resolved <date>: note]` to any
 * index with a resolution (#5) -- the original caveat text is never edited
 * or dropped, only annotated, so a stale-looking obligation stays visible
 * alongside proof it was closed out.
 */
function renderCaveats(caveats: unknown[], resolutions: CaveatResolution[] | undefined): string {
  const byIndex = new Map((resolutions ?? []).map((r) => [r.caveatIndex, r]));
  return caveats
    .map((c, i) => {
      const res = byIndex.get(i);
      if (!res) return String(c);
      const date = res.resolvedAt.slice(0, 10);
      return `${String(c)} [resolved ${date}${res.note ? `: ${res.note}` : ''}]`;
    })
    .join('; ');
}
