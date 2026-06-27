/**
 * reset.ts -- `codebase-pkg reset` command.
 *
 * Wipes DATA (not files): the entire Neo4j graph and/or the conformity Postgres
 * tables (cfm_vectors, cfm_calibration, cfm_decisions). This is the data-side
 * counterpart to `uninstall`, which removes installed FILES but leaves the graph
 * and cold store intact.
 *
 * Scope:
 *   (default)          wipe BOTH Neo4j and the cfm_* tables
 *   --graph-only       only the Neo4j graph
 *   --conformity-only  only the cfm_* tables
 *   (--graph-only and --conformity-only are mutually exclusive)
 *
 * Behavior:
 *   wipe-only by default. `--reseed` rebuilds AFTER a successful wipe: the graph
 *   seed if the graph was wiped, and conformity-backfill if conformity was wiped.
 *   Reseed respects the scope flags.
 *
 * Safety (mirrors `uninstall`):
 *   --confirm / --yes  required to mutate; without it the plan is printed and the
 *                      command returns 0 (no-op).
 *   --dry-run          prints the plan and returns 0 without mutating, even if
 *                      --confirm is also present.
 *   The plan shows LIVE counts (queried before deleting): Neo4j node + relationship
 *   counts and per-table row counts.
 *
 * Targeting: reset must hit a SPECIFIC endpoint (it deletes data), so it does
 * NOT use the cwd-bound singleton driver/pool. It resolves the neo4j/pg URIs
 * (flag > env > state.json at the resolved root > default) and builds a
 * dedicated driver/pool against those URIs via createDriver/createPgPool,
 * closing whatever it creates in a finally. The dispatcher's own finally only
 * closes the shared singletons (which reset never touches here).
 *
 * Flags:
 *   --path / --root <dir>   filesystem root whose state.json supplies fallback URIs
 *   --neo4j-uri <uri>       explicit Neo4j endpoint (highest precedence)
 *   --pg-uri <uri>          explicit Postgres endpoint (highest precedence)
 *   (each also accepts the `=` form, e.g. --neo4j-uri=bolt://...)
 */

import { createDriver } from '../mcp-server/neo4j-client.js';
import { createPgPool, pgQueryOn } from '../conformity/pg-client.js';
import { resolveNeo4jConfig } from './neo4j-config.js';
import { resolvePgConfig } from '../conformity/pg-client.js';
import { resolveRoot } from './resolve-root.js';
import { readState } from '../upgrade/state.js';
import * as path from 'path';
import {
  VECTORS_TABLE,
  CALIBRATION_TABLE,
  DECISIONS_TABLE,
} from '../conformity/schema.js';
import neo4j, { type Driver } from 'neo4j-driver';
import type { Pool } from 'pg';

/** Postgres "undefined_table" error code -- a fresh install with no cfm_* tables. */
const PG_UNDEFINED_TABLE = '42P01';

/** The conformity tables this command truncates, in a stable order. */
const CFM_TABLES = [VECTORS_TABLE, CALIBRATION_TABLE, DECISIONS_TABLE] as const;

export interface ResetFlags {
  dryRun: boolean;
  confirm: boolean;
  graphOnly: boolean;
  conformityOnly: boolean;
  reseed: boolean;
  /** Explicit Neo4j endpoint from `--neo4j-uri`, if given. Highest precedence. */
  neo4jUri?: string;
  /** Explicit Postgres endpoint from `--pg-uri`, if given. Highest precedence. */
  pgUri?: string;
}

/**
 * Read a `--flag <value>` (or `--flag=<value>`) string option from `args`.
 * Returns the last occurrence's value, or undefined when absent.
 */
function readStrFlag(args: string[], flag: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      if (args[i + 1] !== undefined) found = args[i + 1];
    } else if (a.startsWith(flag + '=')) {
      found = a.slice(flag.length + 1);
    }
  }
  return found;
}

export function parseFlags(args: string[]): ResetFlags {
  return {
    dryRun: args.includes('--dry-run'),
    confirm: args.includes('--confirm') || args.includes('--yes'),
    graphOnly: args.includes('--graph-only'),
    conformityOnly: args.includes('--conformity-only'),
    reseed: args.includes('--reseed'),
    neo4jUri: readStrFlag(args, '--neo4j-uri'),
    pgUri: readStrFlag(args, '--pg-uri'),
  };
}

/**
 * Resolve the effective scope from the flags. Throws on the mutually-exclusive
 * combination so the caller can surface a clean error + non-zero exit.
 */
export function resolveScope(flags: ResetFlags): { graph: boolean; conformity: boolean } {
  if (flags.graphOnly && flags.conformityOnly) {
    throw new Error('--graph-only and --conformity-only are mutually exclusive');
  }
  if (flags.graphOnly) return { graph: true, conformity: false };
  if (flags.conformityOnly) return { graph: false, conformity: true };
  return { graph: true, conformity: true };
}

/**
 * Strip credentials from a connection URI so the password is never printed.
 * Returns the input unchanged if it doesn't parse as a URL.
 */
export function maskUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.username || u.password) {
      u.username = u.username || '';
      u.password = '';
    }
    // URL renders `user@host` (no colon) when only the username is set.
    return u.toString();
  } catch {
    // Fallback: strip a `user:pass@` authority segment if present.
    return uri.replace(/\/\/[^/@]*@/, '//');
  }
}

/** A minimal Neo4j read surface so counts can be faked in tests. */
export interface CypherRunner {
  (cypher: string, params?: Record<string, unknown>): Promise<Array<{ get(key: string): unknown }>>;
}

/** A minimal SQL surface so counts/truncate can be faked in tests. */
export interface SqlRunner {
  (text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Coerce a Neo4j integer/bigint/number count into a JS number. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  // neo4j-driver Integer has toNumber(); duck-type it.
  if (v && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v);
}

export interface GraphCounts {
  nodes: number;
  relationships: number;
}

/** Query live Neo4j node + relationship counts. */
export async function getGraphCounts(cypher: CypherRunner): Promise<GraphCounts> {
  const nodeRecs = await cypher('MATCH (n) RETURN count(n) AS c');
  const relRecs = await cypher('MATCH ()-[r]->() RETURN count(r) AS c');
  return {
    nodes: nodeRecs.length ? toNumber(nodeRecs[0].get('c')) : 0,
    relationships: relRecs.length ? toNumber(relRecs[0].get('c')) : 0,
  };
}

export interface TableCount {
  table: string;
  /** Row count, or null when the table doesn't exist yet (fresh install). */
  rows: number | null;
}

/**
 * Query live row counts for each cfm_* table. A missing table (undefined_table /
 * 42P01) yields rows=null rather than failing -- a fresh install simply has
 * nothing to wipe.
 */
export async function getConformityCounts(sql: SqlRunner): Promise<TableCount[]> {
  const out: TableCount[] = [];
  for (const table of CFM_TABLES) {
    try {
      const { rows } = await sql(`SELECT count(*)::int AS c FROM ${table}`);
      const c = rows.length ? (rows[0] as { c: number }).c : 0;
      out.push({ table, rows: Number(c) });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      // pgQuery wraps the original error in a generic message, so also sniff text.
      if (code === PG_UNDEFINED_TABLE || /does not exist|undefined_table|42P01/i.test(message)) {
        out.push({ table, rows: null });
      } else {
        throw err;
      }
    }
  }
  return out;
}

function fmtRows(rows: number | null): string {
  return rows === null ? 'absent' : `${rows} rows`;
}

/** Build the human-readable plan block. Pure -- takes already-queried counts. */
export function renderPlan(opts: {
  scope: { graph: boolean; conformity: boolean };
  neo4jUri: string;
  pgUri: string;
  graphCounts: GraphCounts | null;
  tableCounts: TableCount[] | null;
  reseed: boolean;
}): string {
  const { scope, neo4jUri, pgUri, graphCounts, tableCounts, reseed } = opts;
  const lines: string[] = [];
  lines.push('[reset] Plan:');

  if (scope.graph && graphCounts) {
    lines.push(
      `  Neo4j graph (${maskUri(neo4jUri)}): ${graphCounts.nodes} nodes, ` +
        `${graphCounts.relationships} relationships -> DELETE`,
    );
  }

  if (scope.conformity && tableCounts) {
    lines.push(`  Conformity tables (${maskUri(pgUri)}):`);
    const width = Math.max(...tableCounts.map((t) => t.table.length));
    for (const t of tableCounts) {
      const action = t.rows === null ? 'skip (absent)' : 'TRUNCATE';
      lines.push(`    ${(t.table + ':').padEnd(width + 2)} ${fmtRows(t.rows).padStart(11)} -> ${action}`);
    }
  }

  const reseedDetail: string[] = [];
  if (reseed && scope.graph) reseedDetail.push('seed');
  if (reseed && scope.conformity) reseedDetail.push('conformity-backfill');
  lines.push(
    `  Reseed after wipe: ${reseed ? `yes (${reseedDetail.join(' + ')})` : 'no'}`,
  );

  return lines.join('\n');
}

/** Wipe the entire Neo4j graph inside a single WRITE transaction on `driver`. */
async function wipeGraph(driver: Driver): Promise<void> {
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    await session.executeWrite((tx) => tx.run('MATCH (n) DETACH DELETE n'));
  } finally {
    await session.close();
  }
}

/**
 * Truncate the cfm_* tables. Tables absent on a fresh install are skipped, so we
 * only TRUNCATE the ones that currently exist (per the already-queried counts).
 */
async function wipeConformity(present: string[], sql: SqlRunner): Promise<void> {
  if (present.length === 0) return;
  await sql(`TRUNCATE TABLE ${present.join(', ')}`);
}

export interface RunResetDeps {
  cypher?: CypherRunner;
  sql?: SqlRunner;
  neo4jUri?: string;
  pgUri?: string;
  /** Override the graph wipe (tests). */
  doWipeGraph?: () => Promise<void>;
  /** Override the conformity wipe (tests). */
  doWipeConformity?: (present: string[]) => Promise<void>;
  /** Override the graph reseed (tests). */
  doSeed?: () => Promise<void>;
  /** Override the conformity reseed (tests). */
  doConformityBackfill?: () => Promise<void>;
}

export async function runReset(args: string[], deps: RunResetDeps = {}): Promise<number> {
  const flags = parseFlags(args);

  let scope: { graph: boolean; conformity: boolean };
  try {
    scope = resolveScope(flags);
  } catch (err) {
    process.stderr.write(
      `[reset] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  // Resolve the filesystem root (so we read the state.json at the chosen
  // location) and the effective DB URIs. The flag overrides take highest
  // precedence; deps.neo4jUri/deps.pgUri (tests) win over all of it.
  const root = resolveRoot(args);

  // Warn (but proceed) when the recorded install root differs from the one we
  // resolved -- the user may be resetting against a relocated state file.
  const recordedRoot = readState(root)?.root;
  if (recordedRoot && path.resolve(recordedRoot) !== root) {
    process.stdout.write(
      `[reset] note: resolved root ${root} differs from recorded install root ${recordedRoot}\n`,
    );
  }

  const neo4jUri = deps.neo4jUri ?? resolveNeo4jConfig(root, flags.neo4jUri).uri;
  const pgUri = deps.pgUri ?? resolvePgConfig(root, flags.pgUri).uri;

  // Build a DEDICATED driver/pool against the resolved URIs, lazily and only
  // when no test runner is injected for that store. reset OWNS and closes
  // these (the dispatcher finally only closes the shared singletons, which we
  // never use here). We default cypher/sql to runners bound to these.
  let ownDriver: Driver | null = null;
  let ownPool: Pool | null = null;

  const cypher: CypherRunner =
    deps.cypher ??
    (async (q, params) => {
      if (ownDriver === null) ownDriver = createDriver(neo4jUri);
      const session = ownDriver.session({ defaultAccessMode: neo4j.session.READ });
      try {
        const result = await session.run(q, params ?? {});
        return result.records;
      } finally {
        await session.close();
      }
    });

  const sql: SqlRunner =
    deps.sql ??
    (async (text, params) => {
      if (ownPool === null) ownPool = createPgPool(pgUri);
      return pgQueryOn(ownPool, text, params ?? []);
    });

  try {
    // --- Gather live counts BEFORE deleting anything. ---
    let graphCounts: GraphCounts | null = null;
    let tableCounts: TableCount[] | null = null;

    try {
      if (scope.graph) {
        graphCounts = await getGraphCounts(cypher);
      }
      if (scope.conformity) {
        tableCounts = await getConformityCounts(sql);
      }
    } catch (err) {
      process.stderr.write(
        `[reset] failed to read live counts: ${err instanceof Error ? err.message : String(err)}\n` +
          `[reset] is Neo4j / Postgres running and reachable? Nothing was changed.\n`,
      );
      return 1;
    }

    // --- Print the plan. ---
    process.stdout.write(
      renderPlan({ scope, neo4jUri, pgUri, graphCounts, tableCounts, reseed: flags.reseed }) + '\n',
    );

    if (flags.dryRun) {
      process.stdout.write(`\n[reset] dry-run — no changes made.\n`);
      return 0;
    }

    if (!flags.confirm) {
      process.stdout.write(
        `\nReset will permanently wipe the data above. Re-run with --confirm to proceed.\n`,
      );
      return 0;
    }

    // --- Mutate. ---
    try {
      if (scope.graph) {
        const wipe =
          deps.doWipeGraph ??
          (async () => {
            if (ownDriver === null) ownDriver = createDriver(neo4jUri);
            await wipeGraph(ownDriver);
          });
        await wipe();
        process.stdout.write(`[reset] Neo4j graph wiped.\n`);
      }

      if (scope.conformity) {
        const present = (tableCounts ?? [])
          .filter((t) => t.rows !== null)
          .map((t) => t.table);
        const wipe = deps.doWipeConformity ?? ((p: string[]) => wipeConformity(p, sql));
        await wipe(present);
        if (present.length > 0) {
          process.stdout.write(`[reset] Conformity tables truncated: ${present.join(', ')}.\n`);
        } else {
          process.stdout.write(`[reset] No conformity tables to truncate (fresh install).\n`);
        }
      }
    } catch (err) {
      process.stderr.write(
        `[reset] wipe failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }

    // --- Optional reseed AFTER a successful wipe. ---
    if (flags.reseed) {
      try {
        if (scope.graph) {
          process.stdout.write(`\n[reset] Reseeding graph (seed)…\n`);
          const seed =
            deps.doSeed ??
            (async () => {
              const { runSeed } = await import('../ingestion/initial-seed.js');
              await runSeed();
            });
          await seed();
        }
        if (scope.conformity) {
          process.stdout.write(`\n[reset] Rebuilding conformity pool (conformity-backfill)…\n`);
          const backfill =
            deps.doConformityBackfill ??
            (async () => {
              const { runConformityBackfill } = await import('../conformity/conformity-backfill.js');
              await runConformityBackfill();
            });
          await backfill();
        }
      } catch (err) {
        process.stderr.write(
          `[reset] wipe succeeded but reseed failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }

    process.stdout.write(`\n[reset] Done.\n`);
    return 0;
  } finally {
    // Close whatever WE created against the resolved URIs. The dispatcher's
    // finally only closes the shared singletons, which reset never uses here.
    // (The locals are reassigned inside closures, so read them via a cast that
    // reflects their declared type rather than TS's flow-narrowed `never`.)
    const d = ownDriver as Driver | null;
    const p = ownPool as Pool | null;
    if (d !== null) {
      await d.close().catch(() => {
        // best-effort close
      });
    }
    if (p !== null) {
      await p.end().catch(() => {
        // best-effort close
      });
    }
  }
}
