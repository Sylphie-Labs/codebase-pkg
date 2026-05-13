# @agent-gear/codebase-pkg

**A queryable knowledge graph of your codebase, for Claude Code agents.**

`codebase-pkg` parses your TypeScript/TSX source tree into a Neo4j graph (functions, types, imports, call chains, constraints, change history) and exposes it to Claude Code over MCP. Instead of re-greping and re-reading files every session, the agent queries the graph.

> Status: 0.1.0 — initial public release. TypeScript only. No test suite yet (see [CHANGELOG](./CHANGELOG.md) for known limitations).

## Install

Two install modes, pick what fits.

**Global** (recommended for solo dev / cross-repo use):

```bash
npm install -g @agent-gear/codebase-pkg
```

Then in any repo:

```bash
codebase-pkg init
```

**Local** (recommended for teams who want version pinning):

```bash
npm install --save-dev @agent-gear/codebase-pkg
npx codebase-pkg init --local
```

You'll also need a Neo4j instance. `init --docker` writes a `docker-compose.codebase-pkg.yml` for you, or use whatever Neo4j you already have.

## Quickstart

```bash
# 1. Install (global)
npm install -g @agent-gear/codebase-pkg

# 2. From your repo root
codebase-pkg init --docker

# 3. Bring up Neo4j
docker compose -f docker-compose.codebase-pkg.yml up -d

# 4. Seed the graph from the current state of your repo
codebase-pkg seed

# 5. Start a Claude Code session — the MCP tools are now available
```

`init` copies skill templates into `.claude/skills/`, patches `.mcp.json` with the MCP server stanza, writes `constraints.json` from the bundled example, and records what it did in `.codebase-pkg/state.json` so `upgrade`, `status`, and `uninstall` can later operate on the install cleanly.

## Lifecycle

```bash
codebase-pkg init      [--local] [--docker] [--force] [--dry-run]
codebase-pkg upgrade   [--plan] [--confirm] [--force]
codebase-pkg status                                # show install state + drift
codebase-pkg doctor    [--no-network]              # structural checks
codebase-pkg uninstall --confirm
```

**`init`** is one-time per repo. It writes a state file that subsequent commands read.

**`upgrade`** walks the migration graph from the version recorded in `state.json` to the version of the CLI you currently have installed. Always shows the plan first; nothing is applied without `--confirm`. Drifted files (modified since install) are skipped with a warning unless `--force` is also passed (which creates `.bak.<timestamp>` backups).

**`status`** is a quick `git status`-style report of what's installed, the package's view of each managed file, and any drift.

**`doctor`** runs six structural checks: state file present, version matches, managed files present, MCP stanza registered, constraints file populated, Neo4j reachable.

**`uninstall`** removes every file recorded in `state.json` with `--confirm`. Modified files are backed up to `.bak.<timestamp>` rather than deleted unless `--force`.

> `setup` is a deprecated alias for `init` and will be removed before 1.0.

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

## CLI reference

```bash
# Lifecycle
codebase-pkg init        [--local] [--docker] [--force] [--dry-run]
codebase-pkg upgrade     [--plan] [--confirm] [--force] [--verbose]
codebase-pkg status
codebase-pkg doctor      [--no-network]
codebase-pkg uninstall   --confirm [--force] [--dry-run]

# Graph operations
codebase-pkg seed                 # initial full graph build
codebase-pkg sync                 # incremental sync since last commit
codebase-pkg validate             # run integrity checks against the graph
codebase-pkg backfill-changes     # populate Change nodes from git history
codebase-pkg add-constraint --file constraints.json [--validate]
```

`codebase-pkg-mcp` runs the MCP server directly (Claude Code launches it for you via `.mcp.json`).

## License

MIT. See [LICENSE](./LICENSE).
