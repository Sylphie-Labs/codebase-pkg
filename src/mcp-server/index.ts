#!/usr/bin/env node
/**
 * index.ts -- MCP server entry point for the Codebase PKG.
 *
 * Registers 14 tools that let Claude Code agents query codebase structure
 * from a Neo4j graph, search the conformity embedding pool, and read/write
 * durable session memory in Postgres, rather than reading files directly.
 * Uses stdio transport so Claude Code can spawn this as a subprocess.
 *
 * Tools:
 *   getModuleContext   — feature area overview (functions, types, constraints)
 *   getFunctionDetail  — full body + types + change history for one function
 *   getDataFlow        — trace upstream/downstream data connections
 *   getRecentChanges   — cross-reference a concept with git/change history
 *   getConstraints     — architectural invariants for a scope
 *   getLogContext      — query log files on disk
 *   searchContent      — search function/type source code via CodeBlock nodes
 *   judgeConformity    — does my working-tree code fit the codebase's patterns?
 *   searchSemantic     — semantic code search over the cfm_vectors embedding pool
 *   recordSession      — persist what a session was asked + concluded (upserts by sessionId)
 *   recordDecision     — persist a durable repo decision ("do X instead of Y")
 *   recordLearning     — persist a freestanding gotcha/pattern/fact (amend/supersede-able)
 *   recallSimilar      — hybrid-scored recall over recorded events/decisions/learnings
 *   resolveCaveat      — mark an event's caveat resolved without deleting it
 *   getRecallItem      — full render of one recallSimilar hit by kind+id (pairs with compact mode)
 *   getSession         — every event/decision/learning recorded under one sessionId
 *
 * Every record* tool also: redacts key-shaped secrets in free text before
 * writing, flags a likely near-duplicate of an existing row of the same
 * kind, and (when graphRefs are given) reports how many resolved in Neo4j --
 * all advisory, never blocking the write. recallSimilar, searchSemantic,
 * getModuleContext, and getRecallItem all accept `format: "json"` for a
 * stable machine-parseable envelope alongside the default text render. See
 * MCP-SERVER-IMPROVEMENTS.md.
 *
 * Usage:
 *   node dist/mcp-server/index.js
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { closeDriver } from './neo4j-client.js';
import { resolveNeo4jConfig } from '../cli/neo4j-config.js';
import { resolvePgConfig } from '../conformity/pg-client.js';
import { handleGetModuleContext, GetModuleContextInput } from './tools/getModuleContext.js';
import { handleGetFunctionDetail, GetFunctionDetailInput } from './tools/getFunctionDetail.js';
import { handleGetDataFlow, GetDataFlowInput } from './tools/getDataFlow.js';
import { handleGetRecentChanges, GetRecentChangesInput } from './tools/getRecentChanges.js';
import { handleGetConstraints, GetConstraintsInput } from './tools/getConstraints.js';
import { handleGetLogContext, GetLogContextInput } from './tools/getLogContext.js';
import { handleSearchContent, SearchContentInput } from './tools/searchContent.js';
import { handleJudgeConformity, JudgeConformityInput } from './tools/judgeConformity.js';
import { handleSearchSemantic, SearchSemanticInput } from './tools/searchSemantic.js';
import { handleRecordSession, RecordSessionInput } from './tools/recordSession.js';
import { handleRecordDecision, RecordDecisionInput } from './tools/recordDecision.js';
import { handleRecordLearning, RecordLearningInput } from './tools/recordLearning.js';
import { handleRecallSimilar, RecallSimilarInput } from './tools/recallSimilar.js';
import { handleResolveCaveat, ResolveCaveatInput } from './tools/resolveCaveat.js';
import { handleGetRecallItem, GetRecallItemInput } from './tools/getRecallItem.js';
import { handleGetSession, GetSessionInput } from './tools/getSession.js';

// ---------------------------------------------------------------------------
// Tool definitions (schema shown to Claude)
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: 'getModuleContext',
    description:
      'Given a concept, feature area, or module name, return related functions, types, files, and constraints. ' +
      'Use this as your first query when entering a new area of the codebase. ' +
      'Does NOT return function bodies — use getFunctionDetail for that.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Concept, feature area, or module name to look up. Examples: "authentication", "payment processing", "the user service", "database client".',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Default "text". "json" returns a stable, versioned envelope ({schemaVersion, query, modules, functions, types, constraints}) for hooks/scripts instead of the model-facing text render.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'getFunctionDetail',
    description:
      'Deep dive on a specific function: full body, complete type definitions, and recent changes. ' +
      'Use after getModuleContext to read implementation details.',
    inputSchema: {
      type: 'object',
      properties: {
        functionName: {
          type: 'string',
          description: 'Exact function name as it appears in the source.',
        },
        filePath: {
          type: 'string',
          description: 'Optional partial file path to disambiguate when multiple functions share a name.',
        },
      },
      required: ['functionName'],
    },
  },
  {
    name: 'getDataFlow',
    description:
      'Trace upstream or downstream data connections from a function or type. ' +
      'Shows how data moves through the codebase with file locations at each hop. ' +
      'Use to understand what feeds into a component or what a component affects.',
    inputSchema: {
      type: 'object',
      properties: {
        startNode: {
          type: 'string',
          description: 'Name of the function or type to start from.',
        },
        direction: {
          type: 'string',
          enum: ['upstream', 'downstream', 'both'],
          description: '"upstream" shows what feeds in. "downstream" shows what this feeds. "both" shows both directions.',
        },
        depth: {
          type: 'number',
          description: 'How many hops to follow. Default 3, max 6.',
        },
      },
      required: ['startNode', 'direction'],
    },
  },
  {
    name: 'getRecentChanges',
    description:
      'Cross-reference a concept area with git/change history. ' +
      'Returns commit hashes, messages, authors, and affected functions/types. ' +
      'Use before modifying code to understand what has changed recently.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Concept or area to search in change descriptions.',
        },
        since: {
          type: 'string',
          description: 'ISO date string (YYYY-MM-DD) to filter changes. Defaults to 30 days ago.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'getConstraints',
    description:
      'Return architectural invariants (rules you must not violate) for a service, module, or function. ' +
      'Always call this before making changes to a new area of the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Service, module, or function name to find constraints for. Examples: "the user service", "authentication", "database client".',
        },
      },
      required: ['scope'],
    },
  },
  {
    name: 'getLogContext',
    description:
      'Query log files on disk for matching entries. ' +
      'Returns log descriptions, severity, timestamps, and context. ' +
      'Use when debugging or understanding error patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional text to search in log lines.',
        },
        service: {
          type: 'string',
          description: 'Optional service name filter.',
        },
        severity: {
          type: 'string',
          description: 'Optional severity filter (e.g., "error", "warn", "info").',
        },
        since: {
          type: 'string',
          description: 'ISO date string (YYYY-MM-DD). Defaults to 7 days ago.',
        },
      },
      required: [],
    },
  },
  {
    name: 'searchContent',
    description:
      'Search function and type source code for a pattern. Returns the parent function/type metadata ' +
      'with matching code lines — a scalpel grep that tells you exactly which function contains the match. ' +
      'Use instead of raw grep when you want structured results tied to code entities.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or pattern to search for in function/type bodies. Case-insensitive.',
        },
        fileFilter: {
          type: 'string',
          description: 'Optional partial file path to narrow the search (e.g., "authentication", "user-service").',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results to return. Default 20, max 50.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'judgeConformity',
    description:
      'Judge whether the code you are writing fits the patterns already in this codebase, with two ' +
      'signals. PRIMARY — STYLE CONFORMITY (per-decision): for each function it checks the discrete ' +
      'coding decisions made on a curated set of equivalent-choice axes (var_decl, string_style, ' +
      'async_style, array_syntax, export_style) against the codebase\'s own effective target and ' +
      'reports explainable off-target findings ("uses let; target is const"), leading with the most ' +
      'divergent functions. SECONDARY — SEMANTIC NOVELTY (embedding distance): it embeds each ' +
      'function body and measures its distance to the committed body-vector pool, flagging the ones ' +
      'least like existing code. Judges your working-tree changes (or one file). Requires the ' +
      'conformity store (run `codebase-pkg init` then `codebase-pkg conformity-backfill`); says so ' +
      'plainly if unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Optional file to judge. If given, only that file is judged; otherwise the uncommitted ' +
            'working-tree changes (staged + unstaged + untracked source files) are judged.',
        },
        maxResults: {
          type: 'number',
          description:
            'Max nearest neighbors to report per function in the SEMANTIC NOVELTY section ' +
            '(also the kNN window). Default 5.',
        },
      },
      required: [],
    },
  },
  {
    name: 'searchSemantic',
    description:
      'Semantic code search over the committed embedding pool (cfm_vectors): finds functions/types/' +
      'module constants whose MEANING is close to your query, not just literal text. Use when you ' +
      'know what you want ("the function that validates a JWT") but not its name — searchContent only ' +
      'matches literal patterns, this matches concepts. Requires the conformity store (run ' +
      '`codebase-pkg init` then `codebase-pkg conformity-backfill`).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language or code-shaped description of what you are looking for.',
        },
        k: {
          type: 'number',
          description: 'Max results to return. Default 10, max 50.',
        },
        category: {
          type: 'string',
          enum: ['function:body', 'type:body', 'module:const'],
          description: 'Optional category filter to narrow the search to one entity kind.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Default "text". "json" returns a stable, versioned envelope ({schemaVersion, query, matches}) for hooks/scripts instead of the model-facing text render.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'recordSession',
    description:
      'Persist what THIS session was asked and what it concluded, for later semantic recall. ' +
      'Called by the Stop hook at the end of a session (or mid-session by an agent) so future ' +
      'sessions/agents can find this one via recallSimilar instead of re-deriving the same answer. ' +
      'Calling this again with the SAME sessionId updates that event in place (summary appended, ' +
      'caveats/graphRefs merged) instead of creating a sibling row -- pass sessionId on every call ' +
      'within one conversation. Free text is scanned for key-shaped secrets and redacted; the result ' +
      'says whether that happened and reports graphRefs resolution against the Neo4j graph.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the session was asked to do.' },
        summary: { type: 'string', description: 'What was concluded/done.' },
        caveats: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional caveats, open questions, or follow-ups worth flagging.',
        },
        graphRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional Neo4j node ids this event relates to (`<filePath>::<name>` form).',
        },
        sessionId: { type: 'string', description: 'Optional session identifier.' },
        meta: { type: 'object', description: 'Optional free-form metadata.' },
      },
      required: ['query', 'summary'],
    },
  },
  {
    name: 'recordDecision',
    description:
      'Persist a durable repo decision ("do X instead of Y") so it survives past this session and ' +
      'can be recalled later. Pass supersedesId to mark a prior decision superseded by this new one ' +
      '(atomic: the old row flips to status=superseded in the same write as the new row). The result ' +
      'flags a likely near-duplicate of an existing ACTIVE decision (consider supersedesId instead of ' +
      'leaving both), notes any secret redaction in the free text, and reports graphRefs resolution ' +
      'against the Neo4j graph.',
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', description: 'The decision, stated plainly ("use X").' },
        insteadOf: { type: 'string', description: 'Optional: what this decision replaces/rejects.' },
        context: { type: 'string', description: 'Optional: why this decision was made.' },
        scope: { type: 'string', description: 'Optional: what area/module this decision applies to.' },
        supersedesId: {
          type: 'number',
          description: 'Optional: id of a prior decision this one supersedes.',
        },
        sessionId: { type: 'string', description: 'Optional session identifier.' },
        graphRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional Neo4j node ids this decision relates to (`<filePath>::<name>` form).',
        },
      },
      required: ['decision'],
    },
  },
  {
    name: 'recordLearning',
    description:
      'Persist a freestanding gotcha, pattern, or fact worth recalling later — something learned ' +
      'that is not itself a decision or a session summary (e.g. "this API silently truncates at 1000 rows"). ' +
      'Pass supersedesId to mark a prior learning superseded by this new one (atomic: the old row flips ' +
      'to status=superseded in the same write, and is excluded from recallSimilar by default) — use this ' +
      'instead of leaving a near-duplicate row when a learning turns out weak, wrong, or mis-anchored. ' +
      'The result flags a likely near-duplicate of an existing ACTIVE learning, notes any secret ' +
      'redaction in `content`, and reports graphRefs resolution against the Neo4j graph.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The learning, stated plainly.' },
        kind: {
          type: 'string',
          enum: ['gotcha', 'pattern', 'fact'],
          description: 'Defaults to "fact".',
        },
        graphRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional Neo4j node ids this learning relates to (`<filePath>::<name>` form).',
        },
        sessionId: { type: 'string', description: 'Optional session identifier.' },
        supersedesId: {
          type: 'number',
          description:
            'Optional: id of a prior learning this one supersedes (mirrors recordDecision\'s ' +
            'supersedesId). The old learning flips to status=superseded, atomically, and drops out of ' +
            'recallSimilar by default.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'recallSimilar',
    description:
      'CHECK THIS BEFORE READING FILES: semantic recall over previously recorded session events, ' +
      'decisions, and learnings, ranked by a hybrid score (vector similarity blended with lexical/' +
      'identifier overlap, an optional graph-proximity boost, and a mild recency tiebreak) rather than ' +
      'pure cosine — so exact identifiers outrank same-vocabulary-wrong-subsystem noise. A high-' +
      'ranked hit may answer your question directly — a past session may have already solved this, or ' +
      'a recorded decision may rule an approach in or out — without you needing to re-read or re-' +
      'derive anything. PREFER compact: true FIRST — it returns one dense line per hit instead of the ' +
      'full multi-thousand-token render; follow up with getRecallItem on the one or two hits worth ' +
      'expanding.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to recall.' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['event', 'decision', 'learning'] },
          description: 'Which kinds to search. Defaults to all three.',
        },
        k: {
          type: 'number',
          description: 'Top-k results PER requested kind (not an overall cap). Default 5.',
        },
        includeSuperseded: {
          type: 'boolean',
          description: 'Include decisions AND learnings whose status is not "active". Default false.',
        },
        nearRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional Neo4j node ids (`<filePath>::<name>` form) you are working near. Boosts (default) or, with nearRefsFilter, restricts results to items whose graphRefs touch these ids or their immediate Neo4j neighborhood.',
        },
        nearRefsFilter: {
          type: 'boolean',
          description: 'When true AND nearRefs is given, drop items with no graphRefs overlap instead of merely boosting them. Default false.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional: restrict recall to rows recorded under this sessionId.',
        },
        compact: {
          type: 'boolean',
          description: 'One dense line per hit (kind, id, similarity, session, ~120-char snippet) instead of the full render. PREFER THIS FIRST; use getRecallItem to expand a specific hit. Default false.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Default "text". "json" returns a stable, versioned envelope ({schemaVersion, query, count, results}) for hooks/scripts instead of the model-facing text render.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'getRecallItem',
    description:
      'Fetch the full render of ONE previously recorded event/decision/learning by kind+id — the ' +
      'other half of recallSimilar\'s compact mode: expand a specific hit once you know it is worth ' +
      'reading in full, instead of paying the token cost to render every hit up front.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['event', 'decision', 'learning'], description: 'Which table the id belongs to (from a recallSimilar hit or getSession item).' },
        id: { type: 'number', description: 'The row id (from a recallSimilar hit or getSession item).' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Default "text". "json" returns a stable, versioned envelope ({schemaVersion, item}) for hooks/scripts instead of the model-facing text render.',
        },
      },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'getSession',
    description:
      'Fetch EVERY event/decision/learning recorded under one sessionId, chronologically. ' +
      'recallSimilar renders `session=<id>` on every hit — when a hit looks promising, call this with ' +
      'that id to recover the full narrative (sibling decisions/learnings from the same conversation) ' +
      'instead of just the one isolated row. Cheap: a plain session_id lookup, no embedding call.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The sessionId to fetch, as rendered by recallSimilar (`session=<id>`) or passed to recordSession/recordDecision/recordLearning.' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Default "text". "json" returns a stable, versioned envelope ({schemaVersion, sessionId, count, items}) for hooks/scripts instead of the model-facing text render.',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'resolveCaveat',
    description:
      'Mark one caveat on a previously recorded session event resolved, WITHOUT deleting it -- event ' +
      'rows are immutable, and an unresolved caveat like "Jim owes a runtime restart" is misleading on ' +
      'every future recall once it no longer applies. recallSimilar then renders that caveat with a ' +
      '`[resolved <date>: note]` annotation appended, so the history stays honest. Re-resolving the ' +
      'same caveatIndex replaces the prior note rather than stacking duplicates.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'number', description: 'Id of the event (from recordSession / recallSimilar) that owns the caveat.' },
        caveatIndex: {
          type: 'number',
          description: 'Zero-based index into that event\'s caveats array (as returned/rendered by recallSimilar).',
        },
        note: { type: 'string', description: 'Optional short note on how/why it was resolved.' },
      },
      required: ['eventId', 'caveatIndex'],
    },
  },
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

// Read the package version at runtime so it never drifts from package.json.
// This file compiles to dist/mcp-server/index.js, so package.json is two levels up.
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const server = new Server(
  { name: 'codebase-pkg', version: readPackageVersion() },
  { capabilities: { tools: {} } }
);

// Resolved connection endpoints, for the catch-all error message below. Uses
// the SAME resolution the real clients use (env > state.json > default), so
// the message reports where this server actually tried to connect rather than
// a hardcoded default that may be stale for this instance.
const RESOLVED_NEO4J_URI = resolveNeo4jConfig(process.cwd()).uri;
const RESOLVED_PG_URI = resolvePgConfig(process.cwd()).uri;

/** Tools backed by the Postgres/pgvector conformity+session store rather than Neo4j. */
const PG_BACKED_TOOLS = new Set([
  'judgeConformity',
  'searchSemantic',
  'recordSession',
  'recordDecision',
  'recordLearning',
  'recallSimilar',
  'resolveCaveat',
  'getRecallItem',
  'getSession',
]);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Dispatch tool calls
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case 'getModuleContext':
        result = await handleGetModuleContext(args as unknown as GetModuleContextInput);
        break;

      case 'getFunctionDetail':
        result = await handleGetFunctionDetail(args as unknown as GetFunctionDetailInput);
        break;

      case 'getDataFlow':
        result = await handleGetDataFlow(args as unknown as GetDataFlowInput);
        break;

      case 'getRecentChanges':
        result = await handleGetRecentChanges(args as unknown as GetRecentChangesInput);
        break;

      case 'getConstraints':
        result = await handleGetConstraints(args as unknown as GetConstraintsInput);
        break;

      case 'getLogContext':
        result = await handleGetLogContext(args as unknown as GetLogContextInput);
        break;

      case 'searchContent':
        result = await handleSearchContent(args as unknown as SearchContentInput);
        break;

      case 'judgeConformity':
        result = await handleJudgeConformity(args as unknown as JudgeConformityInput);
        break;

      case 'searchSemantic':
        result = await handleSearchSemantic(args as unknown as SearchSemanticInput);
        break;

      case 'recordSession':
        result = await handleRecordSession(args as unknown as RecordSessionInput);
        break;

      case 'recordDecision':
        result = await handleRecordDecision(args as unknown as RecordDecisionInput);
        break;

      case 'recordLearning':
        result = await handleRecordLearning(args as unknown as RecordLearningInput);
        break;

      case 'recallSimilar':
        result = await handleRecallSimilar(args as unknown as RecallSimilarInput);
        break;

      case 'getRecallItem':
        result = await handleGetRecallItem(args as unknown as GetRecallItemInput);
        break;

      case 'getSession':
        result = await handleGetSession(args as unknown as GetSessionInput);
        break;

      case 'resolveCaveat':
        result = await handleResolveCaveat(args as unknown as ResolveCaveatInput);
        break;

      default:
        result = `Unknown tool: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}`;
    }

    return {
      content: [{ type: 'text' as const, text: result }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = PG_BACKED_TOOLS.has(name)
      ? `This may indicate the codebase-pkg Postgres instance is not running/reachable at ${RESOLVED_PG_URI}.`
      : `This may indicate the codebase-pkg Neo4j instance is not running/reachable at ${RESOLVED_NEO4J_URI}.`;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error executing ${name}: ${message}\n\n${hint}`,
        },
      ],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[codebase-pkg] MCP server running on stdio\n');
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  process.stderr.write('[codebase-pkg] Shutting down...\n');
  await closeDriver();
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('disconnect', () => { void shutdown(); });

main().catch((err: unknown) => {
  process.stderr.write(`[codebase-pkg] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
