#!/usr/bin/env node
/**
 * index.ts -- MCP server entry point for the Codebase PKG.
 *
 * Registers 8 tools that let Claude Code agents query codebase structure
 * from a Neo4j graph rather than reading files directly. Uses stdio transport
 * so Claude Code can spawn this as a subprocess.
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
import { handleGetModuleContext, GetModuleContextInput } from './tools/getModuleContext.js';
import { handleGetFunctionDetail, GetFunctionDetailInput } from './tools/getFunctionDetail.js';
import { handleGetDataFlow, GetDataFlowInput } from './tools/getDataFlow.js';
import { handleGetRecentChanges, GetRecentChangesInput } from './tools/getRecentChanges.js';
import { handleGetConstraints, GetConstraintsInput } from './tools/getConstraints.js';
import { handleGetLogContext, GetLogContextInput } from './tools/getLogContext.js';
import { handleSearchContent, SearchContentInput } from './tools/searchContent.js';
import { handleJudgeConformity, JudgeConformityInput } from './tools/judgeConformity.js';

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
      'Judge whether the code you are writing fits the patterns already in this codebase. ' +
      'Parses your working-tree changes (or one file), embeds each function\'s normalized signature ' +
      'skeleton, and measures its distance to the committed "descriptive pool" of existing functions. ' +
      'Returns per function: category, distance, a provisional verdict (conforms/outlier), and the ' +
      'nearest existing functions — so you can see what you are diverging from or matching. ' +
      'Leads with the outliers. Requires the conformity pool (run `codebase-pkg init` then ' +
      '`codebase-pkg conformity-backfill`); says so plainly if unavailable.',
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
          description: 'Max nearest neighbors to report per function (also the kNN window). Default 5.',
        },
      },
      required: [],
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

      default:
        result = `Unknown tool: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}`;
    }

    return {
      content: [{ type: 'text' as const, text: result }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error executing ${name}: ${message}\n\nThis may indicate the codebase-pkg Neo4j instance is not running on bolt://localhost:7687.`,
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
