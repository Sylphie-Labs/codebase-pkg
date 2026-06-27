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
codebase-pkg init      [--local] [--docker] [--force] [--dry-run] [--path <dir>] [--neo4j-uri <uri>] [--pg-uri <uri>]
codebase-pkg upgrade   [--plan] [--confirm] [--force] [--path <dir>]
codebase-pkg status                                [--path <dir>]   # show install state + drift
codebase-pkg doctor    [--no-network]              [--path <dir>]   # structural checks
codebase-pkg uninstall --confirm                   [--path <dir>]
codebase-pkg reset     [--graph-only|--conformity-only] [--reseed] --confirm [--path <dir>] [--neo4j-uri <uri>] [--pg-uri <uri>]
```

### Location

By default every location-aware command (`init`, `upgrade`, `status`, `doctor`, `uninstall`, `reset`) operates on the current directory. You can point them at a different filesystem root with `--path <dir>` (alias `--root <dir>`; both `--path X` and `--path=X` forms work), or with the `CODEBASE_PKG_ROOT` environment variable. Precedence is `--path`/`--root` flag &gt; `CODEBASE_PKG_ROOT` &gt; current directory. The resolved root is where `.codebase-pkg/state.json` is read/written and where managed files live; `init` creates the directory if it doesn't exist and records the absolute root in `state.json` (shown by `status` and `doctor`). If a later teardown resolves a root that differs from the recorded one, `uninstall`/`reset` print a one-line note and proceed.

**`init`** is one-time per repo. It writes a state file that subsequent commands read. Pass `--neo4j-uri <uri>` / `--pg-uri <uri>` to persist explicit database endpoints into `state.json` (`neo4j.uri` / `postgres.uri`) so later teardown reuses them without re-specifying — useful when your Neo4j/Postgres live somewhere other than the per-repo `--docker` defaults.

**`upgrade`** walks the migration graph from the version recorded in `state.json` to the version of the CLI you currently have installed. Always shows the plan first; nothing is applied without `--confirm`. Drifted files (modified since install) are skipped with a warning unless `--force` is also passed (which creates `.bak.<timestamp>` backups).

**`status`** is a quick `git status`-style report of what's installed, the package's view of each managed file, and any drift.

**`doctor`** runs six structural checks: state file present, version matches, managed files present, MCP stanza registered, constraints file populated, Neo4j reachable.

**`uninstall`** removes every file recorded in `state.json` with `--confirm`. Modified files are backed up to `.bak.<timestamp>` rather than deleted unless `--force`.

**`reset`** wipes *data*, not files (the data-side counterpart to `uninstall`). By default it deletes the entire Neo4j graph **and** truncates the conformity Postgres tables (`cfm_vectors`, `cfm_calibration`, `cfm_decisions`). Scope it with `--graph-only` or `--conformity-only` (mutually exclusive). Like `uninstall`, it requires `--confirm` (or `--yes`) to mutate and supports `--dry-run`; without `--confirm` it prints a plan showing live node/relationship and per-table row counts, then no-ops. Add `--reseed` to rebuild after a successful wipe — `seed` if the graph was wiped, `conformity-backfill` if conformity was wiped (respecting the scope flags). Absent `cfm_*` tables on a fresh install are skipped, not errored. Because `reset` deletes data, it targets a *specific* endpoint: it resolves the Neo4j/Postgres URIs (precedence `--neo4j-uri`/`--pg-uri` flag &gt; `CODEBASE_PKG_NEO4J_URI`/`CODEBASE_PKG_PG_URI` env &gt; `state.json` at the resolved `--path` root &gt; default) and runs the count/wipe against a dedicated driver/pool it builds and closes, independent of the cwd-bound singletons. The (credential-masked) resolved URIs are shown in the plan.

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
| `judgeConformity(filePath?, maxResults?)` | How well your working-tree code fits the codebase's existing patterns — **style-conformity primary** (per-function decision flags vs. the effective target: "uses `let`; target is `const`") plus **embedding-novelty secondary** (per-entity category, distance, verdict, and nearest same-kind entities). See [Conformity Judge](#conformity-judge) |

## Configuration

All settings are environment variables. Defaults work for a standard local Neo4j on the default Bolt port. When you use `init --docker`, the Bolt URI it chooses is auto-recorded in `.codebase-pkg/state.json` and used automatically by the MCP server and `doctor`; `CODEBASE_PKG_NEO4J_URI` still overrides everything.

| Variable | Default | Purpose |
|---|---|---|
| `CODEBASE_PKG_ROOT` | `<cwd>` | Filesystem root the location-aware commands (`init`, `upgrade`, `status`, `doctor`, `uninstall`, `reset`) operate on. Overridden by the `--path`/`--root` flag |
| `CODEBASE_PKG_NEO4J_URI` | `bolt://localhost:7687` | Bolt endpoint. Overridden by `reset --neo4j-uri` |
| `CODEBASE_PKG_NEO4J_USER` | `neo4j` | Neo4j user |
| `CODEBASE_PKG_NEO4J_PASSWORD` | `codebase-pkg-local` | Neo4j password |
| `CODEBASE_PKG_WATCHED_DIRS` | `apps,packages,src` | Comma-separated relative paths to index |
| `CODEBASE_PKG_PACKAGES` | (auto) | JSON array of `{name, dir}` for seed |
| `CODEBASE_PKG_WORKSPACE_SCOPE` | (none) | npm workspace scope prefix for import resolution (e.g. `@your-org`) |
| `CODEBASE_PKG_LOGS_DIR` | `<cwd>/logs` | Where `getLogContext` reads log files |
| `CODEBASE_PKG_DOMAIN_LABELS` | (generic set) | Comma-separated allowed domain labels for `Function.domain` |
| `CODEBASE_PKG_PG_URI` | (auto) | Postgres/pgvector DSN for the [Conformity Judge](#conformity-judge). Overrides the per-instance DSN recorded in `state.json`; point it at an existing Postgres instead of the provisioned one. Overridden by `reset --pg-uri` |
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

The Conformity Judge is a local, offline read on how well new code fits the patterns already in your codebase. It has two complementary lenses:

1. **Decision/style conformity — the PRIMARY signal.** A deterministic, explainable check of the discrete, interchangeable coding *decisions* a function makes — the curated axes `var_decl`, `string_style`, `async_style`, `array_syntax`, `export_style` — against an **effective target** (the codebase's own preferred value per axis). Each finding is a flat fact you can act on: "uses `let`; target is `const`". No model, no embeddings, no fuzziness.
2. **Embedding novelty — the SECONDARY lens.** A "semantic novelty" read: it embeds an entity's whole body and measures cosine distance to a pool of structurally similar peers, surfacing code that is *shaped* unlike anything else in the repo. This is the older whole-body signal; it now backs up the decision signal rather than leading it.

It is **not a linter or a gate**; it is an instrument. Use the decision flags to see exactly which conventions your in-progress code diverges from, and the novelty distance to see whether it is structurally unusual.

### Decision/style conformity (primary)

For each curated axis, the judge compares a function's choice to the **effective target** = a **descriptive seed** merged with an optional, git-tracked override file:

- **Descriptive seed.** The codebase's own *mode* per axis — whichever value the existing code uses most (e.g. if 75% of declarations are `const`, the seed target for `var_decl` is `const`). Computed over *substantive* decisions only; a function that declares no variables makes no `var_decl` decision and is never faulted for it.
- **`conformity-target.json` (optional, at repo root).** A small git-trackable file of accepted preferences, `{ "var_decl": "const", ... }`. Any axis you set here **overrides** the descriptive seed (so you can flip the target to a current minority — a deliberate "we're migrating to X" decision) and is **always enforced**, even past the base-rate guard.
- **Base-rate guard.** An axis is only enforced when the codebase has enough substantive examples of it (≥ 10 deciders) to have a real preference — *or* you've set it explicitly in `conformity-target.json`. Axes the codebase barely uses are left un-enforced rather than fabricating a convention from noise.

The **`conformity-target`** command is the read-only way to inspect and seed this:

```bash
codebase-pkg conformity-target          # show the effective target + per-axis migration progress
codebase-pkg conformity-target --init    # write a starter conformity-target.json from the current modes
codebase-pkg conformity-target --init --force  # overwrite an existing one
```

Show mode is a pure **lookup against the already-persisted decision facts** (the `cfm_decisions` table) — it never re-parses or re-embeds the tree. Per axis it prints the target value, whether it came from the seed or an override, whether it's enforced or guarded out, the substantive count, and **migration progress**: of the functions that decided that axis, what fraction already match the target and how many remain to migrate. `--init` seeds the file from the current descriptive modes for the enforced axes; edit it, commit it, and both the judge and `conformity-backfill` will honor it.

The decision axes are extracted with ts-morph, so they cover **TypeScript/TSX only**.

### Embedding novelty (secondary)

The novelty lens judges three kinds of code entity, each against a pool of its own kind: functions and methods (`function:body`), types — classes, interfaces, enums, and type aliases (`type:body`), and module-level constant/config declarations (`module:const`). For each entity it embeds the entity's **whole body, lightly normalized** — comments stripped and whitespace collapsed, but identifiers and literals kept — and measures the cosine distance from that vector to the committed pool of same-category entities. Each category carries its own in-distribution calibrated threshold.

It runs **fully local**: a code-specific embedding model (`jinaai/jina-embeddings-v2-base-code` via `@xenova/transformers`, ~162 MB, 768-dimensional, downloaded once then run in-process and offline), with `Xenova/jina-embeddings-v2-small-en` and MiniLM as fallbacks. No external API, no tokens, no cost. Note the one-time download is larger than the earlier small general model — the code model is what makes whole-body similarity separate cleanly.

### Architecture

Two stores back the feature. **Neo4j** stays the canonical graph (untouched — no conformity data lives in it). A separate **pgvector Postgres** holds the conformity data, keyed by the same node id as the graph (`<filePath>::<name>`): the embedding-novelty vectors live in `cfm_vectors` (with an HNSW cosine ANN index) plus a `cfm_calibration` table of per-category thresholds, and the **decision facts** live in `cfm_decisions` — one row per `(node_id, axis)` — so axis distributions and the migration backlog are plain SQL queries and the decision judge / `conformity-target` are a lookup, never a re-scan. When you run `init --docker`, the Postgres/pgvector service is provisioned in the same compose file alongside Neo4j, the schema is bootstrapped once Postgres is reachable, and the embedding model is prefetched.

### Workflow

```bash
# 1. Provision Neo4j + pgvector Postgres and prefetch the model
codebase-pkg init --docker
docker compose -f docker-compose.codebase-pkg.yml up -d

# 2. Seed the Neo4j graph as usual
codebase-pkg seed

# 3. One-time: persist the decision facts (the PRIMARY signal) AND embed every
#    committed entity into the novelty pools + calibrate the per-category thresholds
codebase-pkg conformity-backfill

# 4. (optional) Inspect the effective decision target + migration, and seed a
#    git-tracked conformity-target.json you can edit to set accepted preferences
codebase-pkg conformity-target
codebase-pkg conformity-target --init

# 5. Judge your working-tree code: decision/style flags (primary) + novelty (secondary)
codebase-pkg conformity-judge            # all uncommitted changes in watched dirs
codebase-pkg conformity-judge src/foo.ts # or a single file
```

`conformity-backfill` does two passes. The **decision pass** extracts and persists the per-entity style facts into `cfm_decisions`, then logs the effective target (seed merged with `conformity-target.json`) and per-axis migration progress. The **novelty pass** embeds every committed entity (functions, types, and module-level constants) and, as its final step, **calibrates** the verdict: per category it takes the 95th percentile of the leave-one-out kNN distances over that category's in-repo pool, so roughly 95% of the codebase's own code reads as "conforms". That threshold is stored in a `cfm_calibration` table. If you later tune the calibration or grow the pool via sync and want to refresh thresholds **without re-embedding**, run `codebase-pkg conformity-calibrate` — it re-reads the stored vectors and recomputes the thresholds (no model load). To inspect or re-seed the decision target on demand without any re-parse, use `codebase-pkg conformity-target`.

After the one-time backfill, normal `codebase-pkg sync` keeps the pool fresh: it re-embeds changed entities and removes vectors for deleted ones as a best-effort, non-fatal step (a failure or unreachable Postgres warns but never blocks the sync cursor). You can also judge from a Claude Code session via the `judgeConformity` MCP tool.

### The `judgeConformity` MCP tool

The 8th MCP tool. Input `{ filePath?, maxResults? }` (with no `filePath`, it judges the uncommitted staged + unstaged + untracked working-tree changes in watched dirs; `maxResults` caps the nearest neighbors reported per entity and the kNN window, default 5). It leads with the **style-conformity** report — per-function off-target decisions against the effective target — then the **embedding-novelty** report. For novelty it returns, per entity, its category (`function:body`, `type:body`, or `module:const`), distance, a verdict (`conforms`/`outlier`), the **threshold** the verdict was decided against and whether that threshold was **calibrated**, and the nearest existing entities of the same kind — leading with the outliers. Each entity is judged against its category's pool *minus its own committed vector*, so a committed entity is compared to other code, never to itself. Before `conformity-backfill`/`conformity-calibrate` has run there is no calibrated threshold, so verdicts fall back to a default and are flagged `calibrated: false` — in that state the distance and nearest-neighbor list remain the trustworthy signal. If conformity is disabled or Postgres is unreachable, it returns a plain message explaining how to enable it rather than erroring.

### Caveats

- **Decision axes are TypeScript-only.** The decision extractor uses ts-morph, so style-conformity covers `.ts`/`.tsx` functions, methods, and arrows only — not Python or other languages.
- **The decision axes don't cover everything.** The curated set is `var_decl`, `string_style`, `async_style`, `array_syntax`, `export_style`. Bare statements and destructuring-pattern declarations are not modeled as decisions, and a function that makes no decision on an axis (the axis's *absence* value) is never faulted on it.
- **Embedding novelty is a separate lens.** The two signals answer different questions — "did this code follow our conventions?" (decisions) vs. "is this code shaped unlike anything else?" (embedding distance). A clean style report does not imply low novelty, and vice versa.
- **Some declarations aren't chunked yet.** The judge covers functions/methods (`function:body`), types (`type:body`), and module-level const/var declarations (`module:const`), but the parser does not yet chunk bare top-level statements (side-effect calls), destructuring-pattern declarations, or Python module-level assignments — those entities aren't judged.
- **The conformity signal separates best against genuinely different code.** In our validation it cleanly distinguishes unrelated code, but is more modest against same-author / same-domain code that already looks alike. Read the distance and nearest-neighbor list, not just the label.
- **Before backfill/calibration the threshold is uncalibrated.** A judged function reports `calibrated: false` and falls back to a default cut until `conformity-backfill` (or `conformity-calibrate`) has run; in that state the distance and nearest neighbors are the trustworthy signal.
- **The Python parser does not yet capture default-parameter values** — only TypeScript/TSX functions surface default-position information. This is unrelated to the whole-body embedding (which uses the body text directly), but the parser distinction still stands.
- **End-to-end against live Neo4j + Postgres still wants a smoke test.** The engine is unit-tested with fakes; a full run against provisioned services has not been exercised here.

## CLI reference

```bash
# Lifecycle  (all accept --path/--root <dir> or CODEBASE_PKG_ROOT to set the install root)
codebase-pkg init        [--local] [--docker] [--force] [--dry-run] [--path <dir>] [--neo4j-uri <uri>] [--pg-uri <uri>]
codebase-pkg upgrade     [--plan] [--confirm] [--force] [--verbose] [--path <dir>]
codebase-pkg status      [--path <dir>]
codebase-pkg doctor      [--no-network] [--path <dir>]
codebase-pkg uninstall   --confirm [--force] [--dry-run] [--path <dir>]
codebase-pkg reset       [--graph-only|--conformity-only] [--reseed] --confirm [--dry-run] [--path <dir>] [--neo4j-uri <uri>] [--pg-uri <uri>]

# Graph operations
codebase-pkg seed                 # initial full graph build
codebase-pkg sync                 # incremental sync since last commit
codebase-pkg validate             # run integrity checks against the graph
codebase-pkg backfill-changes     # populate Change nodes from git history
codebase-pkg add-constraint --file constraints.json [--validate]

# Conformity Judge (see below)
codebase-pkg conformity-backfill  # one-time: persist decision facts + embed all entities, then calibrate
codebase-pkg conformity-calibrate # recompute per-category outlier thresholds (no re-embed)
codebase-pkg conformity-target [--init] [--force]  # show the effective decision target + migration, or seed conformity-target.json
codebase-pkg conformity-judge [file]  # judge working-tree code (or one file): style flags (primary) + novelty (secondary)
```

`codebase-pkg-mcp` runs the MCP server directly (Claude Code launches it for you via `.mcp.json`).

## License

MIT. See [LICENSE](./LICENSE).
