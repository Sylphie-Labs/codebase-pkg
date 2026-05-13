#!/usr/bin/env node
/**
 * index.ts -- MCP server entry point for the Codebase PKG.
 *
 * Registers 7 tools that let Claude Code agents query codebase structure
 * from a Neo4j graph rather than reading files directly. Uses stdio transport
 * so Claude Code can spawn this as a subprocess.
 *
 * Tools:
 *   getModuleContext   — feature area overview (functions, types, constraints)
 *   getFunctionDetail  — full body + types + tests + change history for one function
 *   getDataFlow        — trace upstream/downstream data connections
 *   getRecentChanges   — cross-reference a concept with git/change history
 *   getConstraints     — architectural invariants for a scope
 *   getLogContext      — query log files on disk
 *   searchContent      — search function/type source code via CodeBlock nodes
 *
 * Usage:
 *   node dist/mcp-server/index.js
 */

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
          description: 'Concept, feature area, or module name to look up. Examples: "drive system", "executor", "voice loop", "Neo4j".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'getFunctionDetail',
    description:
      'Deep dive on a specific function: full body, complete type definitions, test file locations, and recent changes. ' +
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
      'Returns PR numbers, descriptions, and affected functions/types. ' +
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
          description: 'Service, module, or function name to find constraints for. Examples: "drive-engine", "executor", "neo4j".',
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
          description: 'Optional partial file path to narrow the search (e.g., "decision-making", "drive-engine").',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results to return. Default 20, max 50.',
        },
      },
      required: ['pattern'],
    },
  },
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'codebase-pkg', version: '0.1.0' },
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
