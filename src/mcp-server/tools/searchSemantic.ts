/**
 * searchSemantic.ts -- semantic code search over the EXISTING conformity cold
 * store (cfm_vectors), the whole-body embedding pool already built by
 * `conformity-backfill` / the sync hook. This is IMPROVEMENT-REPORT P0 #1:
 * searchContent only does literal/regex matching, so there was previously no
 * way to ask "what code is like <this description>" via the MCP surface.
 *
 * Reuses the conformity layer's own connection + schema constants (pg-client,
 * schema, embed) rather than duplicating them -- this tool does not touch or
 * own cfm_vectors, it only reads it.
 */

import { realPgRunner, type PgRunner } from '../../conformity/pg-client.js';
import { VECTORS_TABLE, EMBEDDING_DIM } from '../../conformity/schema.js';
import { embed as defaultEmbed, type Embedder } from '../../conformity/embed.js';

export type SemanticCategory = 'function:body' | 'type:body' | 'module:const';

export interface SearchSemanticInput {
  query: string;
  k?: number;
  category?: SemanticCategory;
  /** 'text' (default) for direct model consumption, or 'json' for a stable machine-parseable envelope (#10, MCP-SERVER-IMPROVEMENTS.md). */
  format?: 'text' | 'json';
}

/** Injectable dependencies for testing; production uses the real pool + embedder. */
export interface SearchSemanticDeps {
  runner?: PgRunner;
  embedder?: Embedder;
}

export interface SemanticMatch {
  /** The raw cfm_vectors node id, `<absFilePath>::<name>` (see nodeIdOf). */
  nodeId: string;
  filePath: string;
  name: string;
  category: string;
  /** 1 - cosine distance, in roughly [-1, 1] (typically [0, 1] for normalized embeddings). */
  similarity: number;
}

const DEFAULT_K = 10;
const MAX_K = 50;

function toPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Split a `<absFilePath>::<name>` node id into its parts. Splits on the LAST
 * `::` occurrence -- a Windows absolute path's drive letter uses a single `:`,
 * so only the literal `::` separator (see nodeIdOf in ../../conformity/store.ts)
 * can collide, and it never appears elsewhere in the path.
 */
export function splitNodeId(nodeId: string): { filePath: string; name: string } {
  const idx = nodeId.lastIndexOf('::');
  if (idx === -1) return { filePath: nodeId, name: '' };
  return { filePath: nodeId.slice(0, idx), name: nodeId.slice(idx + 2) };
}

/**
 * Core semantic search, separated from the MCP handler so tests can inject a
 * fake runner + embedder without a live Postgres or model download.
 */
export async function searchSemanticCode(
  input: SearchSemanticInput,
  deps: SearchSemanticDeps = {},
): Promise<SemanticMatch[]> {
  const query = input?.query?.trim();
  if (!query) throw new Error('searchSemantic: "query" is required and must be a non-empty string');

  const k = input.k && input.k > 0 ? Math.min(Math.floor(input.k), MAX_K) : DEFAULT_K;
  const runner = deps.runner ?? realPgRunner;
  const embedder = deps.embedder ?? defaultEmbed;

  const [vector] = await embedder([query]);
  if (!vector || vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `searchSemantic: embedder returned a vector of length ${vector?.length ?? 0}, ` +
        `expected ${EMBEDDING_DIM}`,
    );
  }

  const literal = toPgVector(vector);
  const params: unknown[] = [literal];
  let sql = `SELECT node_id, category, embedding <=> $1 AS distance FROM ${VECTORS_TABLE}`;
  if (input.category) {
    params.push(input.category);
    sql += ` WHERE category = $${params.length}`;
  }
  params.push(k);
  sql += ` ORDER BY embedding <=> $1 LIMIT $${params.length};`;

  const { rows } = await runner.query(sql, params);
  return (rows as Array<{ node_id: string; category: string; distance: number | string }>).map(
    (r) => {
      const { filePath, name } = splitNodeId(r.node_id);
      return {
        nodeId: r.node_id,
        filePath,
        name,
        category: r.category,
        similarity: 1 - Number(r.distance),
      };
    },
  );
}

/**
 * Handle the searchSemantic tool call. `deps` is accepted purely for testing
 * (mirrors the other session tools' injectable `deps.store`); production
 * (mcp-server/index.js) always calls this with just the input, so
 * searchSemanticCode falls back to the real pool + embedder. Embedding/DB
 * failures propagate to the dispatcher's catch-all, which returns them as
 * `isError` with the underlying message (the conformity store being unbuilt
 * yet is one such case -- `run codebase-pkg conformity-backfill` first).
 */
export async function handleSearchSemantic(
  input: SearchSemanticInput,
  deps: SearchSemanticDeps = {},
): Promise<string> {
  const matches = await searchSemanticCode(input, deps);

  if (input.format === 'json') {
    return JSON.stringify(
      {
        schemaVersion: 1,
        tool: 'searchSemantic',
        query: input.query,
        category: input.category ?? null,
        count: matches.length,
        matches,
      },
      null,
      2,
    );
  }

  if (matches.length === 0) {
    return (
      `SEMANTIC CODE SEARCH: "${input.query}"\n${'='.repeat(60)}\n\n` +
      `No matches found.${input.category ? ` (category filter: ${input.category})` : ''} ` +
      `If this is a fresh repo, run \`codebase-pkg conformity-backfill\` first.`
    );
  }

  const lines: string[] = [];
  lines.push(`SEMANTIC CODE SEARCH: "${input.query}"`);
  if (input.category) lines.push(`Category filter: ${input.category}`);
  lines.push('='.repeat(60));
  lines.push(`${matches.length} match(es), ranked by similarity (highest first).\n`);

  for (const m of matches) {
    lines.push(`similarity=${m.similarity.toFixed(4)}  [${m.category}]`);
    lines.push(`  ${m.name}`);
    lines.push(`  File: ${m.filePath}`);
    lines.push('');
  }

  lines.push('Use getFunctionDetail for the full body of any matched function.');
  return lines.join('\n');
}
