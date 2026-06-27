# @sylphie-labs/codebase-pkg

**A queryable knowledge graph of your codebase, for Claude Code agents.**

`codebase-pkg` parses your TypeScript/TSX and Python source tree into a Neo4j graph (functions, types, imports, call chains, constraints, change history) and exposes it to Claude Code over MCP. Instead of re-greping and re-reading files every session, the agent queries the graph.

> Status: 0.x — early release. TypeScript/TSX and Python (see [Language support](#language-support)). Tested with `node:test` (`npm test`). See the [CHANGELOG](./CHANGELOG.md) for what's new and known limitations.

## Language support

- **TypeScript / TSX** — parsed in-process with ts-morph. No extra requirements.
- **Python** — parsed with your own Python runtime via the stdlib `ast` module (zero extra npm dependencies). Needs `python3` or `python` (3.9+) on PATH, and only to index `.py` files — if no runtime is found, `.py` files are skipped with a warning and everything else works unchanged. Test files (`test_*.py`, `*_test.py`, `conftest.py`) and `__pycache__`/virtualenv directories are excluded automatically.

## Install

Two install modes, pick what fits.

**Global** (recommended for solo dev / cross-repo use):

```bash
npm install -g @sylphie-labs/codebase-pkg
```

Then in any repo:

```bash
codebase-pkg init
```

**Local** (recommended for teams who want version pinning):

```bash
npm install --save-dev @sylphie-labs/codebase-pkg
npx codebase-pkg init --local
```

You'll also need a Neo4j instance. `init --docker` writes a `docker-compose.codebase-pkg.yml` for you, or use whatever Neo4j you already have.

## Quickstart

```bash
# 1. Install (global)
npm install -g @sylphie-labs/codebase-pkg

# 2. From your repo root
codebase-pkg init --docker

# 3. Bring up Neo4j
docker compose -f docker-compose.codebase-pkg.yml up -d

# 4. Seed the graph from the current state of your repo
codebase-pkg seed

# 5. Start a Claude Code session — the MCP tools are now available
```

`init --docker` picks a free pair of host ports per repo and records the resulting Bolt URI in `.codebase-pkg/state.json`, so multiple repos can run Neo4j side by side without collisions. The exact ports and container name are printed by `init` and shown by `doctor`.

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

Skills add more on top of the seeded graph (schemaless — no migration or indexes needed): `/infer-pkg-connections` writes `DATA_FLOWS_TO` and `BRIDGES` edges plus `hubScore` properties, and `/map-pkg-from-root` writes `REACHES` edges (Function/File → Function/Type, with a `hops` property) along with root annotations (`entryPointKind`, `purpose`, `summary`, `reachableCount`) on entry-point nodes.

After the initial seed, run `codebase-pkg sync` to update only the deltas since the last synced commit. SHA-256 content hashes per entity drive change detection. Sync is a manual command — if you want it automatic, wire it into a `pre-push` git hook or a CI step.

> The [Conformity Judge](#conformity-judge) keeps its embedding vectors in a separate pgvector Postgres, keyed by Neo4j node id. The Neo4j graph schema above is unchanged by that feature.

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
| `judgeConformity(filePath?, maxResults?)` | How well your working-tree code fits the codebase's existing patterns — per-entity (functions, types, module constants) category, distance, verdict (with the threshold used and whether it was calibrated), and nearest existing entities of the same kind (see [Conformity Judge](#conformity-judge)) |

## Configuration

All settings are environment variables. Defaults work for a standard local Neo4j on the default Bolt port. When you use `init --docker`, the Bolt URI it chooses is auto-recorded in `.codebase-pkg/state.json` and used automatically by the MCP server and `doctor`; `CODEBASE_PKG_NEO4J_URI` still overrides everything.

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
| `CODEBASE_PKG_PG_URI` | (auto) | Postgres/pgvector DSN for the [Conformity Judge](#conformity-judge). Overrides the per-instance DSN recorded in `state.json`; point it at an existing Postgres instead of the provisioned one |
| `CODEBASE_PKG_CONFORMITY` | (unset) | Set to `off` to disable the conformity sync hook and judging entirely |
| `CODEBASE_PKG_SKIP_MODEL_PREFETCH` | (unset) | Set to `1` to skip the embedding-model prefetch at `init` (same as `--no-model`) |

## Constraints

Architectural invariants live in `constraints.json` at your repo root and surface via the `getConstraints` MCP tool. The tool reads from the graph, not the file — after adding or editing constraints, load them with:

```bash
codebase-pkg add-constraint --file constraints.json
```

Re-run that after every edit (add `--validate` to check the file without writing).

See `constraints.example.json` for the format.

## Conformity Judge

The Conformity Judge is a local, offline read on how well new code fits the patterns already in your codebase. It judges three kinds of code entity, each against a pool of its own kind: functions and methods (`function:body`), types — classes, interfaces, enums, and type aliases (`type:body`), and module-level constant/config declarations (`module:const`). For each entity it embeds the entity's **whole body, lightly normalized** — comments stripped and whitespace collapsed, but identifiers and literals kept — and measures the cosine distance from that vector to the committed pool of same-category entities. Each category carries its own in-distribution calibrated threshold. It is **not a linter or a gate**; it is an instrument. Use it to see what your in-progress code is diverging from (or matching), not to pass/fail a build.

It runs **fully local**: a code-specific embedding model (`jinaai/jina-embeddings-v2-base-code` via `@xenova/transformers`, ~162 MB, 768-dimensional, downloaded once then run in-process and offline), with `Xenova/jina-embeddings-v2-small-en` and MiniLM as fallbacks. No external API, no tokens, no cost. Note the one-time download is larger than the earlier small general model — the code model is what makes whole-body similarity separate cleanly.

### Architecture

Neo4j stays the canonical graph. The conformity vectors live in a separate **pgvector Postgres** (a cold store), keyed by the same node id as the graph (`<filePath>::<name>`), with an in-memory hot cache that serves per-category pools and does the kNN distance. When you run `init --docker`, the Postgres/pgvector service is provisioned in the same compose file alongside Neo4j, the schema (the `cfm_vectors` table plus an HNSW cosine ANN index) is bootstrapped once Postgres is reachable, and the embedding model is prefetched. The Neo4j schema is untouched — no conformity data lives in the graph.

### Workflow

```bash
# 1. Provision Neo4j + pgvector Postgres and prefetch the model
codebase-pkg init --docker
docker compose -f docker-compose.codebase-pkg.yml up -d

# 2. Seed the Neo4j graph as usual
codebase-pkg seed

# 3. One-time: embed every committed entity (functions, types, constants) into
#    the descriptive pools AND calibrate the per-category outlier thresholds
codebase-pkg conformity-backfill

# 4. Judge your working-tree code against that pool
codebase-pkg conformity-judge            # all uncommitted changes in watched dirs
codebase-pkg conformity-judge src/foo.ts # or a single file
```

`conformity-backfill` embeds every committed entity (functions, types, and module-level constants) and, as its final step, **calibrates** the verdict: per category it takes the 95th percentile of the leave-one-out kNN distances over that category's in-repo pool, so roughly 95% of the codebase's own code reads as "conforms". That threshold is stored in a `cfm_calibration` table. If you later tune the calibration or grow the pool via sync and want to refresh thresholds **without re-embedding**, run `codebase-pkg conformity-calibrate` — it re-reads the stored vectors and recomputes the thresholds (no model load).

After the one-time backfill, normal `codebase-pkg sync` keeps the pool fresh: it re-embeds changed entities and removes vectors for deleted ones as a best-effort, non-fatal step (a failure or unreachable Postgres warns but never blocks the sync cursor). You can also judge from a Claude Code session via the `judgeConformity` MCP tool.

### The `judgeConformity` MCP tool

The 8th MCP tool. Input `{ filePath?, maxResults? }` (with no `filePath`, it judges the uncommitted staged + unstaged + untracked working-tree changes in watched dirs; `maxResults` caps the nearest neighbors reported per entity and the kNN window, default 5). Returns, per entity, its category (`function:body`, `type:body`, or `module:const`), distance, a verdict (`conforms`/`outlier`), the **threshold** the verdict was decided against and whether that threshold was **calibrated**, and the nearest existing entities of the same kind — leading with the outliers. Each entity is judged against its category's pool *minus its own committed vector*, so a committed entity is compared to other code, never to itself. Before `conformity-backfill`/`conformity-calibrate` has run there is no calibrated threshold, so verdicts fall back to a default and are flagged `calibrated: false` — in that state the distance and nearest-neighbor list remain the trustworthy signal. If conformity is disabled or Postgres is unreachable, it returns a plain message explaining how to enable it rather than erroring.

### Caveats

- **Some declarations aren't chunked yet.** The judge covers functions/methods (`function:body`), types (`type:body`), and module-level const/var declarations (`module:const`), but the parser does not yet chunk bare top-level statements (side-effect calls), destructuring-pattern declarations, or Python module-level assignments — those entities aren't judged.
- **The conformity signal separates best against genuinely different code.** In our validation it cleanly distinguishes unrelated code, but is more modest against same-author / same-domain code that already looks alike. Read the distance and nearest-neighbor list, not just the label.
- **Before backfill/calibration the threshold is uncalibrated.** A judged function reports `calibrated: false` and falls back to a default cut until `conformity-backfill` (or `conformity-calibrate`) has run; in that state the distance and nearest neighbors are the trustworthy signal.
- **The Python parser does not yet capture default-parameter values** — only TypeScript/TSX functions surface default-position information. This is unrelated to the whole-body embedding (which uses the body text directly), but the parser distinction still stands.
- **End-to-end against live Neo4j + Postgres still wants a smoke test.** The engine is unit-tested with fakes; a full run against provisioned services has not been exercised here.

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

# Conformity Judge (see below)
codebase-pkg conformity-backfill  # one-time: embed all committed entities into the pools, then calibrate
codebase-pkg conformity-calibrate # recompute per-category outlier thresholds (no re-embed)
codebase-pkg conformity-judge [file]  # judge working-tree code (or one file) against the pool
```

`codebase-pkg-mcp` runs the MCP server directly (Claude Code launches it for you via `.mcp.json`).

## License

MIT. See [LICENSE](./LICENSE).
