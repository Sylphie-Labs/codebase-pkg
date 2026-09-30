/**
 * store.ts -- the session-capture data layer: durable agent memory (events,
 * decisions, learnings) in the same per-instance Postgres/pgvector the
 * Conformity Judge uses.
 *
 * Mirrors ../conformity/store.ts and ../conformity/decisions/decision-store.ts:
 * injectable {@link PgRunner} (production passes the real pool-backed runner,
 * tests pass a fake that records SQL and returns canned rows) and an
 * injectable {@link Embedder} (production uses the real in-process model,
 * tests pass a deterministic offline fake) -- so this whole module is unit-
 * testable without a live Postgres or a model download.
 *
 * Schema readiness: every public method ensures the schema exists before
 * touching the tables, but unlike a one-shot CLI command (e.g.
 * ../conformity/conformity-backfill.ts, which just calls ensureSchema()
 * unconditionally since it runs once), an MCP tool handler constructs a fresh
 * SessionStore on EVERY call (see mcp-server/tools/record*.ts) -- so a naive
 * per-instance flag would re-run the idempotent DDL on every single tool
 * invocation for the life of the server process. Instead the "ensured" flag is
 * memoized in a module-level `WeakMap<PgRunner, Promise<void>>` keyed by the
 * runner's object identity: production always passes the one real singleton
 * runner, so the schema is ensured exactly once per process; each test's fake
 * runner is its own object, so tests never share or leak this cache (mirrors
 * how ConformityStore keeps its hot cache instance-scoped for test isolation
 * -- same goal, different mechanism, since this needs to survive fresh
 * instances of THIS store rather than being tied to one instance).
 *
 * Embedding inputs (fixed, not caller-choosable -- keeps recall comparable
 * across rows written by different callers):
 *   - event:    `${query}\n${summary}`
 *   - decision: `${decision}` + ` instead of ${insteadOf}` when insteadOf is given
 *   - learning: `${content}`
 *
 * graph_refs convention: an array of Neo4j node-identity strings in the SAME
 * `<absFilePath>::<name>` form as {@link nodeIdOf} in ../conformity/store.ts
 * (not `{label, filePath, name}` objects) -- this is the id already used
 * throughout the package (cfm_vectors.node_id, judge-worktree neighbors), so
 * reusing it needs no new parsing convention and searchSemantic's node ids
 * line up with it directly.
 */

import { type PgRunner, realPgRunner } from '../conformity/pg-client.js';
import { embed as defaultEmbed, type Embedder } from '../conformity/embed.js';
import { CHOSEN_MODEL } from '../conformity/embed.js';
import {
  ensureSessionSchema,
  EMBEDDING_DIM,
  AGENT_EVENTS_TABLE,
  AGENT_DECISIONS_TABLE,
  AGENT_LEARNINGS_TABLE,
} from './schema.js';
import { redactSecrets, redactOptional, redactList, mergeFindings } from './secrets.js';

// ---------------------------------------------------------------------------
// Schema-readiness memoization -- see the module doc comment above for why
// this is keyed by runner identity rather than being a per-instance flag.
// ---------------------------------------------------------------------------

const schemaReadyByRunner = new WeakMap<PgRunner, Promise<void>>();

async function ensureReady(runner: PgRunner): Promise<void> {
  let ready = schemaReadyByRunner.get(runner);
  if (!ready) {
    ready = ensureSessionSchema(runner);
    schemaReadyByRunner.set(runner, ready);
  }
  await ready;
}

// ---------------------------------------------------------------------------
// pgvector text-literal helpers (mirrors ../conformity/store.ts; duplicated
// rather than imported since that module does not export them).
// ---------------------------------------------------------------------------

function toPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/** JSON-encode a value for a jsonb column parameter. */
function toJsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * Parse a jsonb column value back into JS. The real `pg` driver already
 * parses json/jsonb columns into JS values, but a fake test runner may hand
 * back the raw string it was given -- tolerate both.
 */
function fromJsonb<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection (#3) + upsert-by-sessionId (#8) constants
// ---------------------------------------------------------------------------

/**
 * Cosine-similarity floor above which a new row is flagged as a likely
 * near-duplicate of an existing one of the same kind. The write is NEVER
 * blocked on this -- a refusal would lose the caller's data when it does not
 * retry -- the near-duplicate is only surfaced in the RecordResult so the
 * caller can choose to `supersedesId` it instead of leaving both. Matches
 * MCP-SERVER-IMPROVEMENTS.md #3's recommended ~0.85.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.85;

/** Separator inserted between segments when recordEvent upserts an existing sessionId's summary (#8). */
export const EVENT_SEGMENT_SEPARATOR = '\n\n--- (continued same session) ---\n\n';

// ---------------------------------------------------------------------------
// recallSimilar hybrid ranking (#6, MCP-SERVER-IMPROVEMENTS.md) -- named,
// commented weights rather than magic numbers so the trade-off is visible at
// the call site and adjustable in one place.
// ---------------------------------------------------------------------------

/**
 * Weight on the vector-cosine similarity term of the hybrid score. Cosine
 * stays the DOMINANT signal (0.65 vs 0.35 lexical below) because it is the
 * only one of the two that understands paraphrase/meaning at all -- lexical
 * overlap alone would miss a query phrased differently from how the row was
 * written. Lexical is a WEIGHT, not a veto: pure semantic recall must keep
 * working for queries with no literal-identifier overlap.
 */
export const HYBRID_COSINE_WEIGHT = 0.65;

/**
 * Weight on the trigram lexical-overlap term (see {@link computeRankScore}).
 * Large enough that an exact identifier match (`/v1/voice`,
 * `wombat_remote_voice`) can pull a row past a same-vocabulary-but-wrong-
 * subsystem neighbor that only wins on embedding distance -- the failure mode
 * MCP-SERVER-IMPROVEMENTS.md #6 was written against -- without being large
 * enough to let two unrelated rows that happen to share a common word (e.g.
 * "failed") out-rank genuine semantic matches. HYBRID_COSINE_WEIGHT +
 * HYBRID_LEXICAL_WEIGHT sum to 1.0 so the base hybrid score stays comparable
 * in magnitude to a plain cosine similarity before the additive boosts below.
 */
export const HYBRID_LEXICAL_WEIGHT = 0.35;

/**
 * Flat additive bonus applied when a row's graphRefs intersect the caller's
 * (possibly Neo4j-neighborhood-expanded) `nearRefs` set. Additive rather than
 * a multiplier so it reliably moves a topically-anchored row up a few slots
 * without being able to manufacture a top rank for a row that is otherwise
 * irrelevant (cosine+lexical near zero) -- it is a nudge toward the caller's
 * declared area of interest, not an override of topical relevance.
 */
export const NEAR_REF_BOOST = 0.15;

/**
 * Weight on the recency term. Deliberately small relative to
 * HYBRID_COSINE_WEIGHT/HYBRID_LEXICAL_WEIGHT (which sum to 1.0) so recency
 * only ever decides between rows that are ALREADY near-tied on topical
 * relevance -- per MCP-SERVER-IMPROVEMENTS.md #6's "mild recency weighting
 * within near-tied similarity bands", not a general newest-first bias that
 * would bury an older but more on-topic row.
 */
export const RECENCY_WEIGHT = 0.05;

/** Recency half-life in days: a row's recency term halves every this-many days old. */
export const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Blend cosine similarity, lexical (trigram) overlap, an optional graphRefs-
 * proximity boost, and a mild recency term into one ranking score for
 * recallSimilar (#6). Never throws: an unparseable `createdAt` (e.g. a test
 * fixture's placeholder string) just contributes zero recency rather than
 * poisoning the score with NaN.
 */
function computeRankScore(
  cosineSimilarity: number,
  lexicalScore: number,
  createdAt: string,
  graphRefs: string[],
  nearRefsSet: Set<string> | null,
): number {
  let score = HYBRID_COSINE_WEIGHT * cosineSimilarity + HYBRID_LEXICAL_WEIGHT * lexicalScore;

  if (nearRefsSet && graphRefs.some((ref) => nearRefsSet.has(ref))) {
    score += NEAR_REF_BOOST;
  }

  const createdMs = Date.parse(createdAt);
  if (Number.isFinite(createdMs)) {
    const ageDays = Math.max(0, (Date.now() - createdMs) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
    score += RECENCY_WEIGHT * recency;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface RecordEventInput {
  sessionId?: string;
  repo?: string;
  query: string;
  summary: string;
  caveats?: string[];
  meta?: Record<string, unknown>;
  graphRefs?: string[];
  /** Defaults to the embedder's chosen model when not given. */
  model?: string;
}

export interface RecordDecisionInput {
  sessionId?: string;
  decision: string;
  insteadOf?: string;
  context?: string;
  scope?: string;
  /**
   * Id of a prior decision this one supersedes. When given, the new row and
   * the supersede-update happen in one atomic statement (a single multi-CTE
   * SQL query -- Postgres runs the whole statement as one implicit
   * transaction, so there is no window where the new row exists without the
   * old one being marked superseded, or vice versa).
   */
  supersedesId?: number;
  meta?: Record<string, unknown>;
  graphRefs?: string[];
}

export interface RecordLearningInput {
  sessionId?: string;
  kind?: 'gotcha' | 'pattern' | 'fact' | (string & {});
  content: string;
  meta?: Record<string, unknown>;
  graphRefs?: string[];
  /**
   * Id of a prior learning this one supersedes (mirrors
   * RecordDecisionInput.supersedesId -- see SessionStore.recordDecision's
   * doc comment for the atomicity guarantee, which recordLearning gives the
   * same way). When given, the near-duplicate check (#3) is skipped: the
   * caller is already resolving the duplication explicitly.
   */
  supersedesId?: number;
}

export interface CaveatResolution {
  /** Index into the owning event's `caveats` array. */
  caveatIndex: number;
  /** ISO-8601 timestamp of the resolution. */
  resolvedAt: string;
  note?: string;
}

export interface ResolveCaveatInput {
  eventId: number;
  caveatIndex: number;
  note?: string;
}

export interface ResolveCaveatResult {
  id: number;
  caveatIndex: number;
  /** The original caveat text, unchanged -- resolving never deletes/edits it. */
  caveatText: string;
  resolvedAt: string;
}

export const RECALL_KINDS = ['event', 'decision', 'learning'] as const;
export type RecallKind = (typeof RECALL_KINDS)[number];

export interface RecallSimilarOptions {
  query: string;
  kinds?: RecallKind[];
  /** Top-k PER requested kind (not an overall cap). Defaults to 5. */
  k?: number;
  /** Include decisions AND learnings with status != 'active'. Defaults to false. */
  includeSuperseded?: boolean;
  /**
   * Graph-ref proximity set for the hybrid score's boost/filter term (#6) --
   * production passes the caller's `nearRefs` ALREADY expanded to include
   * their immediate Neo4j neighborhood (see
   * ../mcp-server/tools/graph-ref-validator.ts#expandNearRefs); the store
   * itself never touches Neo4j, it only intersects this set against each
   * row's own `graphRefs`.
   */
  nearRefs?: string[];
  /** When true AND `nearRefs` is given, items with no graphRefs overlap are dropped instead of merely de-prioritized. Defaults to false (boost, never filter). */
  nearRefsFilter?: boolean;
  /** Restrict recall to rows recorded under this sessionId (#9). */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Recalled row shapes -- one discriminated union, tagged by `kind`.
// ---------------------------------------------------------------------------

export interface RecalledEvent {
  kind: 'event';
  id: number;
  createdAt: string;
  sessionId: string | null;
  repo: string | null;
  query: string;
  summary: string;
  caveats: unknown[];
  /** Additive resolution ledger (#5) -- one entry per resolved caveat, keyed by index into `caveats`. Never shrinks/deletes. */
  resolutions: CaveatResolution[];
  meta: Record<string, unknown>;
  graphRefs: string[];
  model: string | null;
  similarity: number;
  /** Blended ranking score (#6: cosine + lexical + nearRefs boost + recency) -- what recallSimilar actually sorts by; `similarity` above stays pure cosine. */
  score: number;
}

export interface RecalledDecision {
  kind: 'decision';
  id: number;
  createdAt: string;
  sessionId: string | null;
  decision: string;
  insteadOf: string | null;
  context: string | null;
  scope: string | null;
  status: string;
  supersededBy: number | null;
  meta: Record<string, unknown>;
  graphRefs: string[];
  similarity: number;
  /** Blended ranking score (#6) -- see RecalledEvent.score. */
  score: number;
}

export interface RecalledLearning {
  kind: 'learning';
  id: number;
  createdAt: string;
  sessionId: string | null;
  /** The row's own `kind` column (gotcha/pattern/fact) -- distinct from the
   * discriminator field above, which is always 'learning'. */
  learningKind: string;
  content: string;
  /** Mirrors RecalledDecision.status (#1) -- 'active' unless superseded. */
  status: string;
  supersededBy: number | null;
  meta: Record<string, unknown>;
  graphRefs: string[];
  similarity: number;
  /** Blended ranking score (#6) -- see RecalledEvent.score. */
  score: number;
}

export type RecalledItem = RecalledEvent | RecalledDecision | RecalledLearning;

// ---------------------------------------------------------------------------
// Fetched-by-id row shapes (#7 getRecallItem, #9 getSession) -- identical to
// the Recalled* shapes above minus `similarity`/`score`: a direct id lookup
// or a session dump was never ranked against a query, so there is no
// similarity to report. Kept as separate types (rather than making
// `similarity`/`score` optional on RecalledItem) so every existing
// `r.similarity`/`r.score` read on a RecalledItem stays a plain required
// number with no new null-checks forced onto that code path.
// ---------------------------------------------------------------------------

export type FetchedEvent = Omit<RecalledEvent, 'similarity' | 'score'>;
export type FetchedDecision = Omit<RecalledDecision, 'similarity' | 'score'>;
export type FetchedLearning = Omit<RecalledLearning, 'similarity' | 'score'>;
export type FetchedItem = FetchedEvent | FetchedDecision | FetchedLearning;

/** Row shape returned for a write: the row's id, plus best-effort advisories. */
export interface RecordResult {
  id: number;
  /** True when recordEvent updated an existing row (upsert-by-sessionId, #8) rather than inserting a new one. */
  updated?: boolean;
  /** Present iff secret-scanning redacted something in this record's free text (#2). */
  redaction?: { findings: string[] };
  /** Present iff an existing ACTIVE row of the same kind/table is a likely duplicate (#3, cosine similarity >= NEAR_DUPLICATE_THRESHOLD). */
  nearDuplicate?: { id: number; similarity: number };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * The session-capture data layer. Construct with a {@link PgRunner} and/or
 * {@link Embedder}; defaults are the real pool-backed runner and the real
 * in-process embedder.
 */
export class SessionStore {
  private readonly runner: PgRunner;
  private readonly embedder: Embedder;

  constructor(runner: PgRunner = realPgRunner, embedder: Embedder = defaultEmbed) {
    this.runner = runner;
    this.embedder = embedder;
  }

  /** Embed a single string, asserting the returned vector has EMBEDDING_DIM length. */
  private async embedOne(text: string, label: string): Promise<number[]> {
    const [vector] = await this.embedder([text]);
    if (!vector || vector.length !== EMBEDDING_DIM) {
      throw new Error(
        `${label}: embedder returned a vector of length ${vector?.length ?? 0}, ` +
          `expected ${EMBEDDING_DIM}`,
      );
    }
    return vector;
  }

  /**
   * Near-duplicate escape hatch (#3): the single closest existing row in
   * `table` to `vector` by cosine distance, IF its similarity clears
   * {@link NEAR_DUPLICATE_THRESHOLD}. Returns null on an empty table or a
   * below-threshold nearest neighbor -- callers never block on this, they
   * only surface it as an advisory in RecordResult.
   */
  private async findNearDuplicate(
    table: string,
    vector: number[],
    extraWhere = '',
  ): Promise<{ id: number; similarity: number } | null> {
    const literal = toPgVector(vector);
    const { rows } = await this.runner.query(
      `SELECT id, embedding <=> $1 AS distance FROM ${table} ${extraWhere} ` +
        `ORDER BY embedding <=> $1 LIMIT 1;`,
      [literal],
    );
    if (rows.length === 0) return null;
    const r = rows[0] as { id: number | string; distance: number | string };
    const similarity = 1 - Number(r.distance);
    if (similarity < NEAR_DUPLICATE_THRESHOLD) return null;
    return { id: Number(r.id), similarity };
  }

  /** Most recent agent_events row for `sessionId`, or null. Backs recordEvent's upsert path (#8). */
  private async findLatestEventBySession(sessionId: string): Promise<{
    id: number;
    query: string;
    summary: string;
    caveats: string[];
    graphRefs: string[];
  } | null> {
    const { rows } = await this.runner.query(
      `SELECT id, query, summary, caveats, graph_refs ` +
        `FROM ${AGENT_EVENTS_TABLE} WHERE session_id = $1 ORDER BY id DESC LIMIT 1;`,
      [sessionId],
    );
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      id: Number(r.id),
      query: r.query as string,
      summary: r.summary as string,
      caveats: fromJsonb<string[]>(r.caveats, []),
      graphRefs: fromJsonb<string[]>(r.graph_refs, []),
    };
  }

  /**
   * Persist one session event (what a session was asked + what it concluded).
   *
   * Upsert-by-sessionId (#8): when `sessionId` matches an existing row, that
   * row is UPDATED in place -- the new summary is appended to the existing
   * one behind {@link EVENT_SEGMENT_SEPARATOR}, caveats and graphRefs are
   * merged (graphRefs deduplicated), `updated_at` moves to now(), and the
   * embedding is recomputed over the merged `query\nsummary` text. `query`,
   * `repo`, `model`, and `meta` are left as the FIRST segment wrote them (a
   * session's original ask/repo/model do not change mid-session). Otherwise
   * a near-duplicate check (#3) runs against other events and a fresh row is
   * inserted. `query`/`summary`/`caveats` are secret-scanned + redacted (#2)
   * before either path touches them.
   */
  async recordEvent(input: RecordEventInput): Promise<RecordResult> {
    const rawQuery = input?.query?.trim();
    const rawSummary = input?.summary?.trim();
    if (!rawQuery) throw new Error('recordEvent: "query" is required');
    if (!rawSummary) throw new Error('recordEvent: "summary" is required');

    const queryR = redactSecrets(rawQuery);
    const summaryR = redactSecrets(rawSummary);
    const caveatsR = redactList(input.caveats);
    const findings = mergeFindings(queryR.findings, summaryR.findings, caveatsR.findings);
    const redaction = findings.length > 0 ? { findings } : undefined;

    const query = queryR.text;
    const summary = summaryR.text;
    const caveats = caveatsR.items;

    await ensureReady(this.runner);

    if (input.sessionId) {
      const existing = await this.findLatestEventBySession(input.sessionId);
      if (existing) {
        const mergedSummary = `${existing.summary}${EVENT_SEGMENT_SEPARATOR}${summary}`;
        const mergedCaveats = [...existing.caveats, ...caveats];
        const mergedGraphRefs = [...new Set([...existing.graphRefs, ...(input.graphRefs ?? [])])];
        const vector = await this.embedOne(`${existing.query}\n${mergedSummary}`, 'recordEvent');

        await this.runner.query(
          `UPDATE ${AGENT_EVENTS_TABLE} ` +
            `SET summary = $1, caveats = $2, graph_refs = $3, updated_at = now(), embedding = $4 ` +
            `WHERE id = $5;`,
          [mergedSummary, toJsonb(mergedCaveats), toJsonb(mergedGraphRefs), toPgVector(vector), existing.id],
        );

        return { id: existing.id, updated: true, ...(redaction ? { redaction } : {}) };
      }
    }

    const vector = await this.embedOne(`${query}\n${summary}`, 'recordEvent');
    const nearDuplicate = await this.findNearDuplicate(AGENT_EVENTS_TABLE, vector);
    const model = input.model ?? CHOSEN_MODEL ?? null;

    const { rows } = await this.runner.query(
      `INSERT INTO ${AGENT_EVENTS_TABLE} ` +
        `(session_id, repo, query, summary, caveats, meta, graph_refs, model, embedding) ` +
        `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id;`,
      [
        input.sessionId ?? null,
        input.repo ?? null,
        query,
        summary,
        toJsonb(caveats),
        toJsonb(input.meta ?? {}),
        toJsonb(input.graphRefs ?? []),
        model,
        toPgVector(vector),
      ],
    );

    return {
      id: Number((rows[0] as { id: number | string }).id),
      ...(redaction ? { redaction } : {}),
      ...(nearDuplicate ? { nearDuplicate } : {}),
    };
  }

  /**
   * Persist one durable decision ("do X instead of Y"). Embeds
   * `${decision}` (+ ` instead of ${insteadOf}` when given).
   * `decision`/`insteadOf`/`context` are secret-scanned + redacted (#2)
   * first. When `supersedesId` is passed, the insert and the prior row's
   * status='superseded'/superseded_by=<new id> update happen in ONE SQL
   * statement (a multi-CTE query), so they commit atomically, and the
   * near-duplicate check (#3) is skipped -- the caller is already resolving
   * the duplication explicitly. Returns the new row's id.
   */
  async recordDecision(input: RecordDecisionInput): Promise<RecordResult> {
    const rawDecision = input?.decision?.trim();
    if (!rawDecision) throw new Error('recordDecision: "decision" is required');

    const decisionR = redactSecrets(rawDecision);
    const insteadOfR = redactOptional(input.insteadOf);
    const contextR = redactOptional(input.context);
    const findings = mergeFindings(decisionR.findings, insteadOfR.findings, contextR.findings);
    const redaction = findings.length > 0 ? { findings } : undefined;

    const decision = decisionR.text;
    const insteadOf = insteadOfR.text;
    const context = contextR.text;

    await ensureReady(this.runner);

    const embedText = insteadOf ? `${decision} instead of ${insteadOf}` : decision;
    const vector = await this.embedOne(embedText, 'recordDecision');

    const nearDuplicate =
      input.supersedesId == null
        ? await this.findNearDuplicate(AGENT_DECISIONS_TABLE, vector, `WHERE status = 'active'`)
        : null;

    const baseParams: unknown[] = [
      input.sessionId ?? null,
      decision,
      insteadOf ?? null,
      context ?? null,
      input.scope ?? null,
      toJsonb(input.meta ?? {}),
      toJsonb(input.graphRefs ?? []),
      toPgVector(vector),
    ];

    let sql: string;
    let params: unknown[];
    if (input.supersedesId != null) {
      sql =
        `WITH ins AS (` +
        `  INSERT INTO ${AGENT_DECISIONS_TABLE} ` +
        `    (session_id, decision, instead_of, context, scope, meta, graph_refs, embedding) ` +
        `  VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id` +
        `), upd AS (` +
        `  UPDATE ${AGENT_DECISIONS_TABLE} ` +
        `  SET status = 'superseded', superseded_by = (SELECT id FROM ins) ` +
        `  WHERE id = $9 RETURNING id` +
        `) SELECT id FROM ins;`;
      params = [...baseParams, input.supersedesId];
    } else {
      sql =
        `INSERT INTO ${AGENT_DECISIONS_TABLE} ` +
        `(session_id, decision, instead_of, context, scope, meta, graph_refs, embedding) ` +
        `VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id;`;
      params = baseParams;
    }

    const { rows } = await this.runner.query(sql, params);
    return {
      id: Number((rows[0] as { id: number | string }).id),
      ...(redaction ? { redaction } : {}),
      ...(nearDuplicate ? { nearDuplicate } : {}),
    };
  }

  /**
   * Persist one freestanding learning (gotcha/pattern/fact). Embeds
   * `content` (secret-scanned + redacted first, #2). Mirrors
   * {@link recordDecision}'s amend/supersede model (#1): when `supersedesId`
   * is given, the insert and the prior row's status='superseded'/
   * superseded_by=<new id> update happen in ONE atomic multi-CTE statement,
   * and the near-duplicate check (#3) is skipped. Returns the new row's id.
   */
  async recordLearning(input: RecordLearningInput): Promise<RecordResult> {
    const rawContent = input?.content?.trim();
    if (!rawContent) throw new Error('recordLearning: "content" is required');

    const contentR = redactSecrets(rawContent);
    const redaction = contentR.redacted ? { findings: contentR.findings } : undefined;
    const content = contentR.text;

    await ensureReady(this.runner);

    const vector = await this.embedOne(content, 'recordLearning');

    const nearDuplicate =
      input.supersedesId == null
        ? await this.findNearDuplicate(AGENT_LEARNINGS_TABLE, vector, `WHERE status = 'active'`)
        : null;

    const baseParams: unknown[] = [
      input.sessionId ?? null,
      input.kind ?? 'fact',
      content,
      toJsonb(input.meta ?? {}),
      toJsonb(input.graphRefs ?? []),
      toPgVector(vector),
    ];

    let sql: string;
    let params: unknown[];
    if (input.supersedesId != null) {
      sql =
        `WITH ins AS (` +
        `  INSERT INTO ${AGENT_LEARNINGS_TABLE} ` +
        `    (session_id, kind, content, meta, graph_refs, embedding) ` +
        `  VALUES ($1,$2,$3,$4,$5,$6) RETURNING id` +
        `), upd AS (` +
        `  UPDATE ${AGENT_LEARNINGS_TABLE} ` +
        `  SET status = 'superseded', superseded_by = (SELECT id FROM ins) ` +
        `  WHERE id = $7 RETURNING id` +
        `) SELECT id FROM ins;`;
      params = [...baseParams, input.supersedesId];
    } else {
      sql =
        `INSERT INTO ${AGENT_LEARNINGS_TABLE} ` +
        `(session_id, kind, content, meta, graph_refs, embedding) ` +
        `VALUES ($1,$2,$3,$4,$5,$6) RETURNING id;`;
      params = baseParams;
    }

    const { rows } = await this.runner.query(sql, params);
    return {
      id: Number((rows[0] as { id: number | string }).id),
      ...(redaction ? { redaction } : {}),
      ...(nearDuplicate ? { nearDuplicate } : {}),
    };
  }

  /**
   * Mark one caveat on an event resolved WITHOUT deleting/editing it (#5) --
   * event rows are otherwise immutable, and a caveat like "Jim owes a runtime
   * restart" is misleading on every future recall once it no longer applies.
   * Appends `{caveatIndex, resolvedAt, note?}` to the event's additive
   * `resolutions` column (re-resolving the same index replaces its prior
   * entry rather than accumulating stale ones). recallSimilar renders the
   * original caveat text plus `[resolved <date>: note]` from this ledger.
   * `note` is secret-scanned + redacted (#2) like any other free-text field.
   */
  async resolveCaveat(input: ResolveCaveatInput): Promise<ResolveCaveatResult> {
    if (!Number.isInteger(input?.eventId)) {
      throw new Error('resolveCaveat: "eventId" must be an integer id');
    }
    if (!Number.isInteger(input?.caveatIndex) || input.caveatIndex < 0) {
      throw new Error('resolveCaveat: "caveatIndex" must be a non-negative integer');
    }

    await ensureReady(this.runner);

    const { rows } = await this.runner.query(
      `SELECT caveats, resolutions FROM ${AGENT_EVENTS_TABLE} WHERE id = $1;`,
      [input.eventId],
    );
    if (rows.length === 0) {
      throw new Error(`resolveCaveat: no event #${input.eventId} found`);
    }
    const r = rows[0] as Record<string, unknown>;
    const caveats = fromJsonb<string[]>(r.caveats, []);
    if (input.caveatIndex >= caveats.length) {
      throw new Error(
        `resolveCaveat: event #${input.eventId} has ${caveats.length} caveat(s); ` +
          `caveatIndex ${input.caveatIndex} is out of range`,
      );
    }

    const existingResolutions = fromJsonb<CaveatResolution[]>(r.resolutions, []);
    const resolvedAt = new Date().toISOString();
    const { text: note } = redactOptional(input.note);
    const nextResolutions: CaveatResolution[] = [
      ...existingResolutions.filter((res) => res.caveatIndex !== input.caveatIndex),
      { caveatIndex: input.caveatIndex, resolvedAt, ...(note ? { note } : {}) },
    ];

    await this.runner.query(`UPDATE ${AGENT_EVENTS_TABLE} SET resolutions = $1 WHERE id = $2;`, [
      toJsonb(nextResolutions),
      input.eventId,
    ]);

    return {
      id: input.eventId,
      caveatIndex: input.caveatIndex,
      caveatText: caveats[input.caveatIndex],
      resolvedAt,
    };
  }

  /**
   * Recall the top-k (per requested kind) events/decisions/learnings nearest
   * to `query`, merged into one list and sorted by a blended hybrid score
   * descending (#6: cosine similarity + pg_trgm lexical overlap + an optional
   * `nearRefs` graph-proximity boost + a mild recency tiebreak -- see
   * {@link computeRankScore} and the HYBRID_COSINE_WEIGHT / HYBRID_LEXICAL_WEIGHT /
   * NEAR_REF_BOOST / RECENCY_WEIGHT constants above for the weights and their
   * rationale). `similarity` on
   * each result stays the RAW cosine value; `score` is what it is actually
   * ranked by. Candidates are still fetched top-k BY COSINE per kind (same
   * SQL shape as before #6) -- the hybrid score re-ranks that candidate set,
   * it does not widen retrieval, since the motivating case (MCP-SERVER-
   * IMPROVEMENTS.md #6's `/v1/voice` example) was a MIS-ORDERED top-k, not a
   * missing one. Decisions AND learnings are filtered to status='active'
   * unless `includeSuperseded` is set (#1 mirrors the decision model onto
   * learnings, including this recall exclusion); `sessionId` (#9), when
   * given, additionally restricts every kind's query to that session.
   */
  async recallSimilar(opts: RecallSimilarOptions): Promise<RecalledItem[]> {
    const query = opts?.query?.trim();
    if (!query) throw new Error('recallSimilar: "query" is required');

    const requested = opts.kinds && opts.kinds.length > 0 ? opts.kinds : RECALL_KINDS;
    const kinds = [...new Set(requested)].filter((k): k is RecallKind =>
      (RECALL_KINDS as readonly string[]).includes(k),
    );
    if (kinds.length === 0) {
      throw new Error(
        `recallSimilar: "kinds" must be a non-empty subset of ${RECALL_KINDS.join(', ')}`,
      );
    }
    const k = opts.k && opts.k > 0 ? opts.k : 5;
    const nearRefsSet = opts.nearRefs && opts.nearRefs.length > 0 ? new Set(opts.nearRefs) : null;

    await ensureReady(this.runner);

    const vector = await this.embedOne(query, 'recallSimilar');
    const literal = toPgVector(vector);

    // $1 = vector literal, $2 = k (LIMIT), $3 = raw query text (pg_trgm
    // lexical term), $4 = sessionId when filtering by it (#9) -- kept at a
    // fixed position across all three per-kind queries below.
    const sessionParams = opts.sessionId ? [opts.sessionId] : [];
    const baseParams = [literal, k, query, ...sessionParams];

    const out: RecalledItem[] = [];

    if (kinds.includes('event')) {
      const whereClause = opts.sessionId ? `WHERE session_id = $4 ` : '';
      const { rows } = await this.runner.query(
        `SELECT id, created_at, session_id, repo, query, summary, caveats, resolutions, meta, ` +
          `graph_refs, model, embedding <=> $1 AS distance, ` +
          `similarity(query || ' ' || summary, $3) AS lex_score ` +
          `FROM ${AGENT_EVENTS_TABLE} ${whereClause}ORDER BY embedding <=> $1 LIMIT $2;`,
        baseParams,
      );
      for (const r of rows as Array<Record<string, unknown>>) {
        const graphRefs = fromJsonb<string[]>(r.graph_refs, []);
        const createdAt = String(r.created_at);
        const similarity = 1 - Number(r.distance);
        out.push({
          kind: 'event',
          id: Number(r.id),
          createdAt,
          sessionId: (r.session_id as string | null) ?? null,
          repo: (r.repo as string | null) ?? null,
          query: r.query as string,
          summary: r.summary as string,
          caveats: fromJsonb<unknown[]>(r.caveats, []),
          resolutions: fromJsonb<CaveatResolution[]>(r.resolutions, []),
          meta: fromJsonb<Record<string, unknown>>(r.meta, {}),
          graphRefs,
          model: (r.model as string | null) ?? null,
          similarity,
          score: computeRankScore(similarity, Number(r.lex_score ?? 0), createdAt, graphRefs, nearRefsSet),
        });
      }
    }

    if (kinds.includes('decision')) {
      const conditions: string[] = [];
      if (!opts.includeSuperseded) conditions.push(`status = 'active'`);
      if (opts.sessionId) conditions.push(`session_id = $4`);
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')} ` : '';
      const { rows } = await this.runner.query(
        `SELECT id, created_at, session_id, decision, instead_of, context, scope, ` +
          `status, superseded_by, meta, graph_refs, embedding <=> $1 AS distance, ` +
          `similarity(decision || ' ' || coalesce(instead_of, '') || ' ' || coalesce(context, ''), $3) AS lex_score ` +
          `FROM ${AGENT_DECISIONS_TABLE} ${whereClause}` +
          `ORDER BY embedding <=> $1 LIMIT $2;`,
        baseParams,
      );
      for (const r of rows as Array<Record<string, unknown>>) {
        const graphRefs = fromJsonb<string[]>(r.graph_refs, []);
        const createdAt = String(r.created_at);
        const similarity = 1 - Number(r.distance);
        out.push({
          kind: 'decision',
          id: Number(r.id),
          createdAt,
          sessionId: (r.session_id as string | null) ?? null,
          decision: r.decision as string,
          insteadOf: (r.instead_of as string | null) ?? null,
          context: (r.context as string | null) ?? null,
          scope: (r.scope as string | null) ?? null,
          status: r.status as string,
          supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
          meta: fromJsonb<Record<string, unknown>>(r.meta, {}),
          graphRefs,
          similarity,
          score: computeRankScore(similarity, Number(r.lex_score ?? 0), createdAt, graphRefs, nearRefsSet),
        });
      }
    }

    if (kinds.includes('learning')) {
      const conditions: string[] = [];
      if (!opts.includeSuperseded) conditions.push(`status = 'active'`);
      if (opts.sessionId) conditions.push(`session_id = $4`);
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')} ` : '';
      const { rows } = await this.runner.query(
        `SELECT id, created_at, session_id, kind, content, status, superseded_by, meta, graph_refs, ` +
          `embedding <=> $1 AS distance, similarity(content, $3) AS lex_score ` +
          `FROM ${AGENT_LEARNINGS_TABLE} ${whereClause}` +
          `ORDER BY embedding <=> $1 LIMIT $2;`,
        baseParams,
      );
      for (const r of rows as Array<Record<string, unknown>>) {
        const graphRefs = fromJsonb<string[]>(r.graph_refs, []);
        const createdAt = String(r.created_at);
        const similarity = 1 - Number(r.distance);
        out.push({
          kind: 'learning',
          id: Number(r.id),
          createdAt,
          sessionId: (r.session_id as string | null) ?? null,
          learningKind: r.kind as string,
          content: r.content as string,
          status: r.status as string,
          supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
          meta: fromJsonb<Record<string, unknown>>(r.meta, {}),
          graphRefs,
          similarity,
          score: computeRankScore(similarity, Number(r.lex_score ?? 0), createdAt, graphRefs, nearRefsSet),
        });
      }
    }

    const filtered =
      nearRefsSet && opts.nearRefsFilter
        ? out.filter((item) => item.graphRefs.some((ref) => nearRefsSet.has(ref)))
        : out;

    filtered.sort((a, b) => b.score - a.score);
    return filtered;
  }

  /**
   * Fetch ONE event/decision/learning by kind+id, unranked (#7 getRecallItem,
   * #9 getSession) -- no embedding call, no similarity/score (there was no
   * query to rank against). Returns null when no row with that id exists in
   * the target table.
   */
  async getItem(kind: RecallKind, id: number): Promise<FetchedItem | null> {
    await ensureReady(this.runner);

    if (kind === 'event') {
      const { rows } = await this.runner.query(
        `SELECT id, created_at, session_id, repo, query, summary, caveats, resolutions, meta, graph_refs, model ` +
          `FROM ${AGENT_EVENTS_TABLE} WHERE id = $1;`,
        [id],
      );
      if (rows.length === 0) return null;
      const r = rows[0] as Record<string, unknown>;
      return {
        kind: 'event',
        id: Number(r.id),
        createdAt: String(r.created_at),
        sessionId: (r.session_id as string | null) ?? null,
        repo: (r.repo as string | null) ?? null,
        query: r.query as string,
        summary: r.summary as string,
        caveats: fromJsonb<unknown[]>(r.caveats, []),
        resolutions: fromJsonb<CaveatResolution[]>(r.resolutions, []),
        meta: fromJsonb<Record<string, unknown>>(r.meta, {}),
        graphRefs: fromJsonb<string[]>(r.graph_refs, []),
        model: (r.model as string | null) ?? null,
      };
    }

    if (kind === 'decision') {
      const { rows } = await this.runner.query(
        `SELECT id, created_at, session_id, decision, instead_of, context, scope, status, superseded_by, meta, graph_refs ` +
          `FROM ${AGENT_DECISIONS_TABLE} WHERE id = $1;`,
        [id],
      );
      if (rows.length === 0) return null;
      const r = rows[0] as Record<string, unknown>;
      return {
        kind: 'decision',
        id: Number(r.id),
        createdAt: String(r.created_at),
        sessionId: (r.session_id as string | null) ?? null,
        decision: r.decision as string,
        insteadOf: (r.instead_of as string | null) ?? null,
        context: (r.context as string | null) ?? null,
        scope: (r.scope as string | null) ?? null,
        status: r.status as string,
        supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
        meta: fromJsonb<Record<string, unknown>>(r.meta, {}),
        graphRefs: fromJsonb<string[]>(r.graph_refs, []),
      };
    }

    // kind === 'learning' (exhaustive over RecallKind -- validated by the caller)
    const { rows } = await this.runner.query(
      `SELECT id, created_at, session_id, kind, content, status, superseded_by, meta, graph_refs ` +
        `FROM ${AGENT_LEARNINGS_TABLE} WHERE id = $1;`,
      [id],
    );
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      kind: 'learning',
      id: Number(r.id),
      createdAt: String(r.created_at),
      sessionId: (r.session_id as string | null) ?? null,
      learningKind: r.kind as string,
      content: r.content as string,
      status: r.status as string,
      supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
      meta: fromJsonb<Record<string, unknown>>(r.meta, {}),
      graphRefs: fromJsonb<string[]>(r.graph_refs, []),
    };
  }

  /**
   * Fetch EVERY event/decision/learning recorded under `sessionId` (#9),
   * across all three tables regardless of status (a session dump is meant to
   * reconstruct what happened, including anything since superseded --
   * callers can read each item's own `status`), sorted chronologically
   * (oldest first) rather than by relevance -- there is no query to rank
   * against. No embedding call: this is a plain indexed lookup on
   * `session_id`, not a vector search.
   */
  async getBySession(sessionId: string): Promise<FetchedItem[]> {
    await ensureReady(this.runner);

    const out: FetchedItem[] = [];

    {
      const { rows } = await this.runner.query(
        `SELECT id, created_at, session_id, repo, query, summary, caveats, resolutions, meta, graph_refs, model ` +
          `FROM ${AGENT_EVENTS_TABLE} WHERE session_id = $1;`,
        [sessionId],
      );
      for (const r of rows as Array<Record<string, unknown>>) {
        out.push({
          kind: 'event',
          id: Number(r.id),
          createdAt: String(r.created_at),
          sessionId: (r.session_id as string | null) ?? null,
          repo: (r.repo as string | null) ?? null,
          query: r.query as string,
          summary: r.summary as string,
          caveats: fromJsonb<unknown[]>(r.caveats, []),
          resolutions: fromJsonb<CaveatResolution[]>(r.resolutions, []),
          meta: fromJsonb<Record<string, unknown>>(r.meta, {}),
          graphRefs: fromJsonb<string[]>(r.graph_refs, []),
          model: (r.model as string | null) ?? null,
        });
      }
    }

    {
      const { rows } = await this.runner.query(
        `SELECT id, created_at, session_id, decision, instead_of, context, scope, status, superseded_by, meta, graph_refs ` +
          `FROM ${AGENT_DECISIONS_TABLE} WHERE session_id = $1;`,
        [sessionId],
      );
      for (const r of rows as Array<Record<string, unknown>>) {
        out.push({
          kind: 'decision',
          id: Number(r.id),
          createdAt: String(r.created_at),
          sessionId: (r.session_id as string | null) ?? null,
          decision: r.decision as string,
          insteadOf: (r.instead_of as string | null) ?? null,
          context: (r.context as string | null) ?? null,
          scope: (r.scope as string | null) ?? null,
          status: r.status as string,
          supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
          meta: fromJsonb<Record<string, unknown>>(r.meta, {}),
          graphRefs: fromJsonb<string[]>(r.graph_refs, []),
        });
      }
    }

    {
      const { rows } = await this.runner.query(
        `SELECT id, created_at, session_id, kind, content, status, superseded_by, meta, graph_refs ` +
          `FROM ${AGENT_LEARNINGS_TABLE} WHERE session_id = $1;`,
        [sessionId],
      );
      for (const r of rows as Array<Record<string, unknown>>) {
        out.push({
          kind: 'learning',
          id: Number(r.id),
          createdAt: String(r.created_at),
          sessionId: (r.session_id as string | null) ?? null,
          learningKind: r.kind as string,
          content: r.content as string,
          status: r.status as string,
          supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
          meta: fromJsonb<Record<string, unknown>>(r.meta, {}),
          graphRefs: fromJsonb<string[]>(r.graph_refs, []),
        });
      }
    }

    out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return out;
  }
}

/** Convenience factory mirroring the class constructor's defaults. */
export function createSessionStore(
  runner: PgRunner = realPgRunner,
  embedder: Embedder = defaultEmbed,
): SessionStore {
  return new SessionStore(runner, embedder);
}
