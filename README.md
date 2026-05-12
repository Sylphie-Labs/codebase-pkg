# @anthrorg-infra/codebase-pkg

**A queryable knowledge graph of your codebase, for Claude Code agents.**

`codebase-pkg` parses your TypeScript/TSX source tree into a Neo4j graph (functions, types, imports, call chains, constraints, change history) and exposes it to Claude Code over MCP. Instead of re-greping and re-reading files every session, the agent queries the graph.

> Status: 0.1.0 — initial public release. TypeScript only. No test suite yet (see [CHANGELOG](./CHANGELOG.md) for known limitations).

## Install

```bash
npm install --save-dev @anthrorg-infra/codebase-pkg
# or
pnpm add -D @anthrorg-infra/codebase-pkg
# or
yarn add -D @anthrorg-infra/codebase-pkg
```

You'll also need a Neo4j instance. The setup command can write a `docker-compose.codebase-pkg.yml` for you, or use whatever Neo4j you already have.

## Quickstart

```bash
# 1. Install package
npm install --save-dev @anthrorg-infra/codebase-pkg

# 2. Run the setup command from your repo root
npx codebase-pkg setup

# 3. Bring up Neo4j (skip if you already have one)
docker compose -f docker-compose.codebase-pkg.yml up -d

# 4. Seed the graph from the current state of your repo
npx codebase-pkg seed

# 5. Start a Claude Code session — the MCP tools are now available
```

`setup` does three things: copies skill templates into `.claude/skills/`, patches your `.mcp.json` with the codebase-pkg MCP server stanza, and writes `constraints.json` from `constraints.example.json` if you don't already have one.

## What's in the graph

**Nodes:** `File`, `Function`, `Type`, `Module`, `Service`, `CodeBlock`, `Change`.

**Edges:** `CONTAINS`, `DEFINES`, `BELONGS_TO`, `IMPORTS`, `USES_TYPE`, `CALLS`, `HAS_CODE`, `EXTENDS`, `IMPLEMENTS`, `INJECTS`, `CHANGED_IN`.

After the initial seed, every `git push` (or `npx codebase-pkg sync`) updates only the deltas. SHA-256 content hashes per entity drive change detection.

## MCP tools

| Tool | What it returns |
|---|---|
| `getModuleContext(query)` | Functions, types, files, constraints in a feature area |
| `getFunctionDetail(name, filePath?)` | Full body + signature + JSDoc + recent changes for one function |
| `getDataFlow(startNode, direction, depth?)` | Upstream/downstream graph traversal (default depth 3, max 6) |
| `getRecentChanges(query, since?)` | Concept ↔ git-history cross-reference |
| `getConstraints(scope)` | Architectural invariants from `constraints.json` and the graph |
| `getLogContext(query?, service?, severity?, since?)` | Query log files on disk |
| `searchContent(pattern, fileFilter?, maxResults?)` | Structured grep that returns code-entity context, not just byte offsets |

## Configuration

All settings are environment variables. Defaults work for a standard local Neo4j on the default Bolt port.

| Variable | Default | Purpose |
|---|---|---|
| `CODEBASE_PKG_NEO4J_URI` | `bolt://localhost:7687` | Bolt endpoint |
| `CODEBASE_PKG_NEO4J_USER` | `neo4j` | Neo4j user |
| `CODEBASE_PKG_NEO4J_PASSWORD` | `codebase-pkg-local` | Neo4j password |
| `CODEBASE_PKG_WATCHED_DIRS` | `apps,packages,src` | Comma-separated relative paths to index |
| `CODEBASE_PKG_PACKAGES` | (auto) | JSON array of `{name, dir}` for seed |
| `CODEBASE_PKG_WORKSPACE_SCOPE` | (none) | npm workspace scope prefix for import resolution (e.g. `@your-org`) |
| `CODEBASE_PKG_LOGS_DIR` | `<cwd>/logs` | Where `getLogContext` reads log files |
| `CODEBASE_PKG_DOMAIN_LABELS` | (generic set) | Comma-separated allowed domain labels for `Function.domain` |

## Constraints

Architectural invariants live in `constraints.json` at your repo root and surface via the `getConstraints` MCP tool. Add or remove constraints as your architecture evolves; the graph re-reads on every MCP call.

See `constraints.example.json` for the format.

## CLI

```bash
npx codebase-pkg setup                # one-time consumer setup
npx codebase-pkg seed                 # initial full graph build
npx codebase-pkg sync                 # incremental sync since last commit
npx codebase-pkg validate             # run integrity checks against the graph
npx codebase-pkg backfill-changes     # populate Change nodes from git history
npx codebase-pkg add-constraint       # CLI to add an architectural constraint
```

`npx codebase-pkg-mcp` runs the MCP server directly (Claude Code launches this for you via `.mcp.json`).

## License

MIT. See [LICENSE](./LICENSE).
