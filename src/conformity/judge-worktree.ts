/**
 * judge-worktree.ts -- step 4 of the Conformity Judge: the JUDGMENT surface.
 *
 * The descriptive pool (the committed whole-body vectors) is already built by
 * sync/backfill. This module answers the developer-facing question "is what I'm
 * writing like what's already in this codebase?" by parsing the working tree (or
 * a given file), embedding each function's representation text (lightly-
 * normalized whole body), and measuring its distance to the COMMITTED pool --
 * reporting not just a verdict but the nearest existing functions it conforms to
 * / diverges from.
 *
 * Self-exclusion: a function already committed has its own vector in the pool.
 * Judging it against that vector would report a perfect self-match, which is
 * meaningless ("you conform to yourself"). So each function is judged against
 * the pool MINUS its own node id -- i.e. against OTHER code.
 *
 * Gate: like the sync hook and backfill, this degrades gracefully. If
 * conformity is disabled or Postgres is unreachable, it returns a structured
 * `{ unavailable: true, reason }` result rather than throwing, so the MCP tool /
 * CLI can print a clear "how to fix" message.
 *
 * Injectability: store + embedder are injectable so the whole surface is unit-
 * tested with a fake store (canned pool) and a deterministic offline embedder --
 * no Postgres, no model download.
 */

import type { ParsedFunction } from '../sync/ast-parser.js';
import { embed as defaultEmbed, type Embedder } from './embed.js';
import { categoryOf, representationText } from './category.js';
import { knnPoolDistance, knnNearest, DEFAULT_K } from './distance.js';
import { DRAFT_OUTLIER_THRESHOLD, type Verdict, type PoolEntry } from './judge.js';
import {
  createConformityStore,
  nodeIdOf,
  type ConformityStore,
} from './store.js';
import { isConformityEnabled } from './sync-hook.js';
import { realPgRunner, type PgRunner } from './pg-client.js';
import { getWorkingTreeFiles } from '../sync/git-diff.js';
import { parseFiles, clearProjectCache } from '../sync/parser.js';

/** One nearest existing function the judged function was compared against. */
export interface Neighbor {
  /** Stable node id of the existing function (`<filePath>::<name>`). */
  nodeId: string;
  /** Cosine distance from the judged function's representation, in [0, 2]. */
  distance: number;
}

/** The judgment of a single working-tree function against the committed pool. */
export interface FunctionJudgment {
  /** Function name. */
  name: string;
  /** File the function lives in. */
  filePath: string;
  /** Stable node id of the judged function (`<filePath>::<name>`). */
  nodeId: string;
  /** The conformity category it was classified into. */
  category: string;
  /** The canonical representation text that was embedded (lightly-normalized body). */
  skeleton: string;
  /** Mean cosine distance to the k nearest pool entries, or null if no peers. */
  distance: number | null;
  /** PROVISIONAL verdict; `unjudged` when there were no peers to compare to. */
  verdict: Verdict | 'unjudged';
  /** Nearest existing functions, ascending by distance (excludes self). */
  nearest: Neighbor[];
  /** How many same-category peers were available AFTER self-exclusion. */
  poolSize: number;
}

/** Returned when conformity can't run (disabled / Postgres unreachable). */
export interface UnavailableResult {
  unavailable: true;
  reason: string;
}

/** Either the judgments or a structured "can't run" result. Never throws the gate. */
export type JudgeResult = FunctionJudgment[] | UnavailableResult;

/** Type guard: narrows a {@link JudgeResult} to the unavailable case. */
export function isUnavailable(r: JudgeResult): r is UnavailableResult {
  return (r as UnavailableResult).unavailable === true;
}

/** Options shared by the judge entry points. */
export interface JudgeWorktreeOptions {
  /** Vector store to load committed pools from. Defaults to the real store. */
  store?: ConformityStore;
  /** Embedding backend. Defaults to the real in-process @xenova embedder. */
  embedder?: Embedder;
  /** Pg runner used only by the availability gate. Defaults to the real runner. */
  runner?: PgRunner;
  /** Nearest-neighbor count for distance + reported neighbors. Defaults {@link DEFAULT_K}. */
  k?: number;
}

/**
 * The reason string for the availability gate, mirroring the sync hook/backfill
 * wording so the surfaces read consistently.
 */
function gateReason(): string {
  return (process.env.CODEBASE_PKG_CONFORMITY ?? '').toLowerCase() === 'off'
    ? 'disabled (CODEBASE_PKG_CONFORMITY=off)'
    : 'Postgres not configured/reachable';
}

/**
 * Judge a single function against an already-loaded pool. Pure: no DB, no gate.
 * Exposed mainly for composition/testing; callers normally use
 * {@link judgeFunctions}, which loads the pool and applies self-exclusion.
 *
 * The function's own node id is excluded from `pool` BEFORE this is called.
 */
async function judgeAgainstPool(
  fn: ParsedFunction,
  pool: readonly PoolEntry[],
  embed: Embedder,
  k: number,
): Promise<FunctionJudgment> {
  const category = categoryOf(fn);
  const skeleton = representationText(fn);
  const nodeId = nodeIdOf(fn);

  const peers = pool.filter((e) => e.category === category);

  // No peers to conform to -> structured "unjudged", not a throw. (judgeChunk
  // throws here; the surface must keep going across many functions.)
  if (peers.length === 0) {
    return {
      name: fn.name,
      filePath: fn.filePath,
      nodeId,
      category,
      skeleton,
      distance: null,
      verdict: 'unjudged',
      nearest: [],
      poolSize: 0,
    };
  }

  const [vector] = await embed([skeleton]);
  if (!vector) {
    throw new Error(`judgeAgainstPool: embedder returned no vector for "${nodeId}"`);
  }

  const distance = knnPoolDistance(
    vector,
    peers.map((e) => e.vector),
    k,
  );
  const neighbors = knnNearest(vector, peers, k).map((n) => ({
    nodeId: n.entry.identifier,
    distance: n.distance,
  }));

  // PROVISIONAL -- see DRAFT_OUTLIER_THRESHOLD TODO in judge.ts.
  const verdict: Verdict =
    distance > DRAFT_OUTLIER_THRESHOLD ? 'outlier' : 'conforms';

  return {
    name: fn.name,
    filePath: fn.filePath,
    nodeId,
    category,
    skeleton,
    distance,
    verdict,
    nearest: neighbors,
    poolSize: peers.length,
  };
}

/**
 * Judge a list of parsed working-tree functions against the committed pool.
 *
 * For each function: derive its category, load that category's committed pool
 * from the store, EXCLUDE the function's own node id (so it is judged against
 * OTHER code), embed the representation text, and compute kNN distance + nearest
 * neighbors.
 *
 * Gated: if conformity is disabled or Postgres is unreachable, returns
 * {@link UnavailableResult} rather than throwing.
 *
 * Per-category pools are loaded once and cached for this call (the store also
 * hot-caches), so judging many functions of the same category hits Postgres
 * once.
 */
export async function judgeFunctions(
  functions: ParsedFunction[],
  opts: JudgeWorktreeOptions = {},
): Promise<JudgeResult> {
  const runner = opts.runner ?? realPgRunner;

  if (!(await isConformityEnabled(runner))) {
    return { unavailable: true, reason: gateReason() };
  }

  const store = opts.store ?? createConformityStore(runner);
  const embed = opts.embedder ?? defaultEmbed;
  const k = opts.k ?? DEFAULT_K;

  // Cache loaded pools per category for this call.
  const poolByCategory = new Map<string, PoolEntry[]>();
  const loadPool = async (category: string): Promise<PoolEntry[]> => {
    const cached = poolByCategory.get(category);
    if (cached) return cached;
    const pool = await store.loadPool(category);
    poolByCategory.set(category, pool);
    return pool;
  };

  const judgments: FunctionJudgment[] = [];
  for (const fn of functions) {
    const category = categoryOf(fn);
    const fullPool = await loadPool(category);
    const selfId = nodeIdOf(fn);
    // Self-exclusion: judge against OTHER code, not the function's own committed
    // vector (which would report a perfect self-match).
    const pool = fullPool.filter((e) => e.identifier !== selfId);
    judgments.push(await judgeAgainstPool(fn, pool, embed, k));
  }

  // Lead with the outliers: highest distance first, then unjudged, then the
  // conformers. Null distances (unjudged) sort after any real distance.
  judgments.sort((a, b) => {
    const da = a.distance ?? -1;
    const db = b.distance ?? -1;
    return db - da;
  });

  return judgments;
}

/**
 * Resolve the working-tree-changed source files in watched dirs, parse them, and
 * judge every function against the committed pool. The end-to-end "judge what
 * I'm editing right now" entry point.
 */
export async function judgeWorkingTree(
  opts: JudgeWorktreeOptions = {},
): Promise<JudgeResult> {
  const files = getWorkingTreeFiles();
  return judgeParsedFiles(files, opts);
}

/**
 * Judge a single file's functions against the committed pool. The file is
 * parsed fresh from disk (its current working-tree contents).
 */
export async function judgeFile(
  filePath: string,
  opts: JudgeWorktreeOptions = {},
): Promise<JudgeResult> {
  const normalized = filePath.replace(/\\/g, '/');
  return judgeParsedFiles([normalized], opts);
}

/**
 * Shared tail of {@link judgeWorkingTree}/{@link judgeFile}: gate first (so we
 * don't parse when conformity can't run), then parse the given files and judge.
 */
async function judgeParsedFiles(
  files: string[],
  opts: JudgeWorktreeOptions,
): Promise<JudgeResult> {
  const runner = opts.runner ?? realPgRunner;
  if (!(await isConformityEnabled(runner))) {
    return { unavailable: true, reason: gateReason() };
  }

  if (files.length === 0) return [];

  const parsed = parseFiles(files);
  clearProjectCache();

  const functions: ParsedFunction[] = [];
  for (const f of parsed) functions.push(...f.functions);

  return judgeFunctions(functions, opts);
}
