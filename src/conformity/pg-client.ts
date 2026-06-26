/**
 * pg-client.ts -- Postgres/pgvector connection manager for the Conformity Judge
 * cold store.
 *
 * Mirrors the shape of src/mcp-server/neo4j-client.ts: a lazily-created
 * singleton pool, a thin query helper (pgQuery), and a closePgPool teardown.
 * All store code goes through pgQuery rather than managing its own clients.
 *
 * Connection settings resolve via resolvePgConfig (env > state.json > default),
 * so a per-instance DSN chosen at provisioning time is picked up automatically
 * from `.codebase-pkg/state.json`:
 *   CODEBASE_PKG_PG_URI > state.json postgres.uri >
 *     postgres://codebase-pkg:codebase-pkg-local@localhost:5432/codebase_pkg
 *
 * Injectability: the store layer does NOT depend on this module directly. It
 * accepts a `PgRunner` -- a minimal `{ query(text, params) }` interface that the
 * real pool satisfies. Tests pass a fake runner, so unit tests need no live
 * Postgres (mirroring how the rest of the package keeps the DB out of tests).
 */

import { Pool } from 'pg';
import { readState } from '../upgrade/state.js';

/**
 * Minimal query surface the store depends on. The real `pg.Pool` satisfies this
 * (its `query` returns `{ rows, ... }`), and tests can supply a hand-rolled fake
 * that records SQL + params and returns canned rows. Keeping this interface
 * narrow is what makes the store unit-testable without a live database.
 */
export interface PgRunner {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

let _pool: Pool | null = null;

/**
 * Resolve the effective Postgres DSN for the repo at `cwd`.
 *
 * Precedence env > state.json > default:
 *   uri: CODEBASE_PKG_PG_URI > state.postgres.uri >
 *        postgres://codebase-pkg:codebase-pkg-local@localhost:5432/codebase_pkg
 */
export function resolvePgConfig(cwd: string): { uri: string } {
  const state = readState(cwd) as { postgres?: { uri?: string } } | null;
  const stateUri = state?.postgres?.uri;

  return {
    uri:
      process.env.CODEBASE_PKG_PG_URI ??
      stateUri ??
      'postgres://codebase-pkg:codebase-pkg-local@localhost:5432/codebase_pkg',
  };
}

/**
 * Returns the singleton pg Pool, creating it on first call. The pool manages
 * connections internally -- do not call this per-query; use pgQuery instead.
 */
export function getPgPool(): Pool {
  if (_pool === null) {
    const { uri } = resolvePgConfig(process.cwd());
    _pool = new Pool({
      connectionString: uri,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    _pool.on('error', (err) => {
      // Idle-client errors are surfaced here, not thrown into user code.
      process.stderr.write(`[pg-client] pool error: ${err.message}\n`);
    });
  }
  return _pool;
}

/**
 * Closes the pool and releases all connections. Call this on process exit.
 */
export async function closePgPool(): Promise<void> {
  if (_pool !== null) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Run a SQL query against the singleton pool and return `{ rows }`.
 *
 * Throws a descriptive error if Postgres is unreachable or the query is
 * invalid. This is the real-pool implementation of {@link PgRunner}.
 *
 * @param text   - The SQL text, using $1, $2, ... placeholders.
 * @param params - Optional positional parameters.
 */
export async function pgQuery(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[] }> {
  const pool = getPgPool();
  try {
    const result = await pool.query(text, params as unknown[]);
    return { rows: result.rows };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Postgres query failed: ${message}\nQuery: ${text.slice(0, 200)}`);
  }
}

/** A {@link PgRunner} backed by the real singleton pool via {@link pgQuery}. */
export const realPgRunner: PgRunner = {
  query: (text: string, params?: unknown[]) => pgQuery(text, params ?? []),
};
