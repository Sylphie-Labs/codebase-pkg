/**
 * neo4j-config.ts -- Per-instance Neo4j configuration helpers.
 *
 * Multiple codebase-pkg installs can run on one machine, so each repo needs a
 * deterministic-yet-distinct Neo4j container name, port pair, and volume names.
 * This module derives those from the repo's cwd, finds free host ports, and
 * resolves the effective connection settings with env > state.json > default
 * precedence.
 *
 * Dependency-free: only node builtins (crypto, net) plus the local state reader.
 */

import * as crypto from 'crypto';
import * as net from 'net';
import * as path from 'path';
import { readState } from '../upgrade/state.js';

export interface Neo4jInstanceConfig {
  uri: string;
  user: string;
  password: string;
  containerName: string;
  httpPort: number;
  boltPort: number;
  slug: string;
}

/** SHA-256 hex digest of the given string. */
function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Derive a stable Docker-name-safe slug for a repo at `cwd`.
 *
 * Format: `<basename>-<hash4>` where basename is lowercased and non-alphanumeric
 * runs collapse to a single dash (trimmed), and hash4 is the first 4 hex chars
 * of sha256 over the absolute, normalized cwd path. The hash suffix keeps slugs
 * distinct even when two repos share a basename. Result matches [a-z0-9-] with
 * no leading/trailing dash.
 */
export function deriveInstanceSlug(cwd: string): string {
  const abs = path.resolve(cwd);
  const base = path
    .basename(abs)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const safeBase = base.length > 0 ? base : 'repo';
  const hash4 = sha256Hex(abs).slice(0, 4);
  return `${safeBase}-${hash4}`;
}

/**
 * Find a free TCP port on 127.0.0.1, starting at `preferred` and scanning
 * upward. Resolves with the first port a server can bind; rejects if none is
 * free within `preferred + 200`.
 */
export function findFreePort(preferred: number): Promise<number> {
  const MAX_OFFSET = 200;

  function tryPort(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', () => {
        // Port in use (or otherwise unbindable); signal caller to try the next.
        server.close(() => reject(new Error('port-in-use')));
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  return new Promise<number>((resolve, reject) => {
    const attempt = (offset: number): void => {
      if (offset > MAX_OFFSET) {
        reject(new Error(`no free port found in [${preferred}, ${preferred + MAX_OFFSET}]`));
        return;
      }
      tryPort(preferred + offset).then(resolve, () => attempt(offset + 1));
    };
    attempt(0);
  });
}

/**
 * Derive deterministic base ports from a slug so different repos start probing
 * from different points. http base in [7600, 8299], bolt base in [7700, 8399];
 * the ranges are offset so the two rarely collide before free-port scanning.
 */
export function deriveBasePorts(slug: string): { http: number; bolt: number } {
  const h = parseInt(sha256Hex(slug).slice(0, 8), 16);
  const h2 = parseInt(sha256Hex(slug).slice(8, 16), 16);
  const http = 7600 + (h % 700);
  const bolt = 7700 + (h2 % 700);
  return { http, bolt };
}

/**
 * Derive a deterministic base host port for this repo's Postgres (pgvector)
 * container. Uses its own range [5500, 6199] so it never overlaps the Neo4j
 * http/bolt ranges ([7600, 8299] / [7700, 8399]); a separate hash slice keeps it
 * decorrelated from those ports. The chosen base is the starting point for the
 * free-port scan in installDocker, so the actual mapped port may be higher.
 */
export function derivePgBasePort(slug: string): number {
  const h = parseInt(sha256Hex(slug).slice(16, 24), 16);
  return 5500 + (h % 700);
}

/**
 * Resolve the effective Neo4j connection settings for the install at `root`.
 *
 * `root` is the resolved filesystem root (see resolveRoot) whose
 * `.codebase-pkg/state.json` is consulted. Each value resolves independently:
 *   uri:      overrideUri (flag) > CODEBASE_PKG_NEO4J_URI > state.neo4j.uri > bolt://localhost:7687
 *   user:     CODEBASE_PKG_NEO4J_USER     > neo4j
 *   password: CODEBASE_PKG_NEO4J_PASSWORD > codebase-pkg-local
 *
 * @param root        - Install root dir whose state.json supplies the fallback URI.
 * @param overrideUri - Highest-precedence URI, e.g. from a `--neo4j-uri` flag.
 */
export function resolveNeo4jConfig(
  root: string,
  overrideUri?: string,
): { uri: string; user: string; password: string } {
  const state = readState(root);
  const stateUri = state?.neo4j?.uri;

  return {
    uri:
      overrideUri ??
      process.env.CODEBASE_PKG_NEO4J_URI ??
      stateUri ??
      'bolt://localhost:7687',
    user: process.env.CODEBASE_PKG_NEO4J_USER ?? 'neo4j',
    password: process.env.CODEBASE_PKG_NEO4J_PASSWORD ?? 'codebase-pkg-local',
  };
}
