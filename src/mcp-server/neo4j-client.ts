/**
 * neo4j-client.ts -- Neo4j connection manager for the Codebase PKG MCP server.
 *
 * Connects to a Neo4j instance on bolt://localhost:7687 by default. All tool
 * handlers import runQuery from here rather than managing their own sessions.
 *
 * Environment overrides:
 *   CODEBASE_PKG_NEO4J_URI      defaults to bolt://localhost:7687
 *   CODEBASE_PKG_NEO4J_USER     defaults to neo4j
 *   CODEBASE_PKG_NEO4J_PASSWORD defaults to codebase-pkg-local
 */

import neo4j, { Driver, Record as Neo4jRecord } from 'neo4j-driver';

const NEO4J_URI = process.env.CODEBASE_PKG_NEO4J_URI ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env.CODEBASE_PKG_NEO4J_USER ?? 'neo4j';
const NEO4J_PASSWORD = process.env.CODEBASE_PKG_NEO4J_PASSWORD ?? 'codebase-pkg-local';

let _driver: Driver | null = null;

/**
 * Returns the singleton Neo4j driver, creating it on first call.
 * The driver maintains a connection pool internally — do not call this
 * per-query; use runQuery instead.
 */
export function getDriver(): Driver {
  if (_driver === null) {
    _driver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
      {
        maxConnectionPoolSize: 10,
        connectionAcquisitionTimeout: 5000,
        logging: {
          level: 'warn',
          logger: (level, message) => {
            if (level === 'error' || level === 'warn') {
              process.stderr.write(`[neo4j-driver] [${level}] ${message}\n`);
            }
          },
        },
      }
    );
  }
  return _driver;
}

/**
 * Closes the driver and releases all connections. Call this on process exit.
 */
export async function closeDriver(): Promise<void> {
  if (_driver !== null) {
    await _driver.close();
    _driver = null;
  }
}

/**
 * Run a Cypher query and return the result records.
 *
 * Opens a new session for each call and closes it when done.
 * Throws a descriptive error if Neo4j is unreachable or the query is invalid.
 *
 * @param cypher - The Cypher query string.
 * @param params - Optional parameters map. Keys must match $param placeholders.
 * @returns Array of Neo4j Record objects. Use record.get('fieldName') to extract values.
 */
export async function runQuery(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<Neo4jRecord[]> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });

  try {
    const result = await session.run(cypher, params);
    return result.records;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Neo4j query failed: ${message}\nQuery: ${cypher.slice(0, 200)}`);
  } finally {
    await session.close();
  }
}
