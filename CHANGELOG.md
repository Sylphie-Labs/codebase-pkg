# Changelog

All notable changes to `@sylphie-labs/codebase-pkg` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Conformity Judge.** A local, offline read on how well new code fits the codebase's existing patterns. It judges three kinds of code entity, each against a pool of its own kind: functions and methods (`function:body`), types — classes, interfaces, enums, and type aliases (`type:body`), and module-level constant/config declarations (`module:const`). Each entity's **whole body, lightly normalized** (comments stripped and whitespace collapsed, identifiers/literals kept) is embedded and measured by cosine distance against the committed pool of same-category entities. It is an instrument, not a linter or a gate. Runs fully local — a code-specific embedding model (`jinaai/jina-embeddings-v2-base-code` via `@xenova/transformers`, ~162 MB, 768-dimensional, downloaded once then in-process), with `Xenova/jina-embeddings-v2-small-en` and MiniLM as fallbacks; no external API and no token cost.
- Conformity vectors live in a provisioned **pgvector Postgres** cold store (table `cfm_vectors`, keyed by `<filePath>::<name>` node id) with an in-memory hot cache doing the kNN. `init --docker` now provisions the Postgres/pgvector service in the same compose file alongside Neo4j, bootstraps the schema + an HNSW cosine ANN index once Postgres is reachable, and prefetches the embedding model. The Neo4j graph schema is unchanged — no conformity data lives in the graph.
- **Per-category calibrated outlier threshold.** The hard-coded distance cut is replaced by an in-distribution calibrated threshold computed independently for each category (`function:body`, `type:body`, `module:const`): the 95th percentile of leave-one-out kNN distances over that category's in-repo pool (so ~95% of the codebase's own code of that kind reads as "conforms"). Stored in a new `cfm_calibration` table. `conformity-backfill` now calibrates as its final step, and judgments report the threshold used plus whether it was calibrated; before backfill/calibration, verdicts fall back to a default and are flagged uncalibrated.
- New CLI commands: `conformity-backfill` (one-time: embed every committed entity — functions, types, and module-level constants — to build the descriptive pools, then calibrate), `conformity-calibrate` (recompute per-category thresholds from the stored vectors without re-embedding), and `conformity-judge [file]` (judge working-tree changes, or one file, against the pools).
- New MCP tool `judgeConformity({ filePath?, maxResults? })` (the 8th tool): per-entity category (`function:body`, `type:body`, or `module:const`), distance, verdict (`conforms`/`outlier`) with the threshold used and whether it was calibrated, and nearest existing entities of the same kind, leading with the outliers; judges each committed entity against its category's pool minus its own vector (no self-match).
- Normal `codebase-pkg sync` now keeps the pools fresh as a best-effort, non-fatal step (re-embeds changed entities, removes deleted ones); a failure or unreachable Postgres warns but never blocks the sync cursor.
- The TypeScript parser now captures default-parameter values (`hasDefault` / `defaultText`) on function arguments.
- New env vars/flags: `CODEBASE_PKG_PG_URI` (use an existing Postgres instead of the provisioned one), `CODEBASE_PKG_CONFORMITY=off` (disable the sync hook + judging), and `--no-model` / `CODEBASE_PKG_SKIP_MODEL_PREFETCH=1` (skip the model prefetch at `init`).
- New runtime dependency `pg` (Postgres client); `@xenova/transformers` provides the local embedding backend.

### Known limitations
- Conformity coverage spans functions/methods (`function:body`), types (`type:body`), and module-level const/var declarations (`module:const`), but the parser does not yet chunk bare top-level statements (side-effect calls), destructuring-pattern declarations, or Python module-level assignments — those entities aren't judged.
- The conformity signal separates best against genuinely different code; per our validation it is more modest against same-author / same-domain code that already looks alike, so read the distance and nearest neighbors, not just the label. Verdicts before backfill/calibration are uncalibrated (flagged `calibrated: false`).
- The Python parser does not yet capture default-parameter values (TypeScript/TSX only); this is unrelated to the whole-body embedding but the parser distinction still stands.
- End-to-end against live Neo4j + Postgres still wants a smoke test; the engine is unit-tested with fakes.

## [0.4.0] — 2026-06-19

### Added
- New top-down `/map-pkg-from-root` skill. Starts at the application's true entry point (frontend `App`/`main`, backend bootstrap and HTTP route surface, or CLI command) and descends via `CALLS`/`IMPORTS`, summarizing what each surface does and what it reaches. Writes `entryPointKind`/`purpose`/`summary`/`reachableCount` on root nodes and `REACHES` edges (with `hops`) to the significant surfaces they depend on. Complements the bottom-up `/infer-pkg-connections`; runs as an optional final step of `/sync-pkg`. Schemaless — no migration or new indexes.

## [0.3.0] — 2026-06-19

### Added
- `init --docker` now allocates a free host port pair per repo instead of the fixed `7474`/`7687`, and names the container, compose project, and volumes with a per-repo slug (`codebase-pkg-neo4j-<slug>`, where the slug is the repo basename plus 4 hex chars of a path hash). Multiple codebase-pkg instances can now run Neo4j side-by-side on one machine without port or container-name collisions.
- The chosen Bolt URI is recorded in `.codebase-pkg/state.json` under a new `neo4j` field; the MCP server and `doctor` read it (precedence: `CODEBASE_PKG_NEO4J_URI` env > `state.json` > `bolt://localhost:7687`).

### Changed
- The bundled cypher-shell skill snippets now discover the container by name-prefix filter instead of hardcoding `codebase-pkg-neo4j`, so they work with per-instance slug names.
- Existing installs are unaffected: their generated compose file and skills keep the old fixed names and ports and keep working. To adopt per-instance naming, re-run `codebase-pkg init --docker --force`, which recreates the container and volumes (volume names change, so re-seed afterward).

## [0.2.1] — 2026-06-10

### Added
- Registered a no-op `0.2.0 -> 0.2.1` migration (no managed files change in this release) so `codebase-pkg upgrade` works for existing 0.2.0 installs.

### Fixed
- `getDataFlow`: upstream traversal returned downstream results; now traverses incoming edges correctly, adds `DATA_FLOWS_TO` edges, and is label-anchored.
- `getConstraints`: displayed no constraints because it grouped by severity values the package never writes; now groups by `must`/`should`/`prefer`.
- `searchContent`: threw at runtime due to a float `LIMIT`; now uses `toInteger`.
- `getFunctionDetail`: related-type bodies were always empty; now reads `CodeBlock` `bodyText`.
- `getRecentChanges`: now prints commit short hashes.
- `getModuleContext`: added a result `LIMIT` and fixed multi-word over-matching; removed dead `Module.domain`/`description` fields.
- MCP server self-reported version `0.1.0`; now reads `package.json` at runtime.
- Deleted files were never removed from the graph due to a relative-vs-absolute path mismatch in `getDeletedFiles`; now fixed.
- Global-mode `init` wrote an `.mcp.json` stanza that could not start the server; it now invokes the `codebase-pkg-mcp` bin correctly (plus a defensive `mcp-server` dispatcher case).

## [0.2.0] — 2026-06-10

### Added
- **Python support.** `.py` files in watched directories are now indexed alongside TypeScript/TSX, using your own Python runtime (`python3` or `python`, 3.9+) and the stdlib `ast` module — zero new npm dependencies. Functions and async defs (with `ClassName.method` naming), classes as `Type` nodes (kind `class`, bases → `EXTENDS`/`IMPLEMENTS`, `__init__` → constructor params), decorators with FastAPI/Flask route detection (`httpMethod`/`routePath`), docstrings, callees, type annotations → type refs, and content hashes. If no Python runtime is on PATH, `.py` files are skipped with a single warning and nothing else changes.
- Python import resolution (relative dotted and absolute-within-watched-dirs imports) producing the same `IMPORTS` module edges as TypeScript, via a shared import resolver now used by both languages.
- Python hygiene exclusions: `__pycache__`, `venv`, `.venv`, `.tox`, `site-packages` directories and `test_*.py` / `*_test.py` / `conftest.py` files are never indexed.
- New library exports: `parseFiles` (language-dispatching), `parseTypeScriptFiles`, `parsePythonFiles`, `pythonAvailable`, `resolveImportTarget`, `resolvePythonImportTarget`, `getWatchedPackages`.
- Test suite using `node:test` (`npm test`), with no new dependencies.
- Registered a no-op `0.1.0 -> 0.2.0` migration (no managed files change in this release) so `codebase-pkg upgrade` works for existing installs.

### Fixed
- Incremental sync created self-loop `IMPORTS` edges on file-keyed `Module` nodes; it now resolves real source→target module edges matching the seed's shape, and imports of external packages no longer create edges. Edges whose imported names drift are re-synced.
- Incremental sync now `MERGE`s `Module` nodes, so directories added after the initial seed are linked instead of leaving their functions orphaned.
- Deleting an individual function or type now also deletes its `CodeBlock` node (previously stranded in the graph).
- `searchContent`: patterns now match across lines (DOTALL), so multiline function bodies actually match; fixed a crash when a match was a `Type`.
- `getFunctionDetail`: recent-changes section now reads the `Change` properties that actually exist; removed the test-coverage section that no pipeline populates; tool descriptions no longer promise PR numbers or test locations.
- `doctor`: the `constraints.json` check now understands the real root-level-array format instead of always reporting 0 constraints.
- `backfill-changes`: default Neo4j port corrected from 7688 to 7687, and it now uses the shared driver (honoring `CODEBASE_PKG_NEO4J_*`).
- Scrubbed origin-project leftovers: `getConstraints` no longer points to a nonexistent `docs/CANON.md`, `add-constraint` defaults to `constraints.json` at the repo root (not `packages/codebase-pkg/`), and `constraints.example.json` now ships generic examples instead of nine project-specific constraints that `init` copied into consumers' repos.

## [0.1.0] — 2026-05-12

Initial public release. Extracted from `drift-detector/packages/codebase-pkg` and made repo-agnostic.

### Added
- AST-driven TypeScript parser (ts-morph) producing `Function`, `Type`, `Module`, `Service`, `File`, `CodeBlock`, and `Change` nodes in Neo4j.
- Incremental sync pipeline: git-diff → AST parse → graph diff → Cypher mutations under a single transaction.
- Integrity-gated cursor advancement: six structural checks run after every sync; errors block `.last-sync-commit` advance.
- MCP stdio server exposing seven query tools: `getModuleContext`, `getFunctionDetail`, `getDataFlow`, `getRecentChanges`, `getConstraints`, `getLogContext`, `searchContent`.
- Initial-seed pipeline with 4 uniqueness constraints + 11 indexes.
- **Lifecycle command suite**: `init`, `upgrade`, `status`, `doctor`, `uninstall`. Tracks install state in `.codebase-pkg/state.json` with SHA-256 hashes per managed file so upgrades can detect drift, skip user-modified files with `--bak` backup on `--force`, and walk a migration graph from `state.version` to the currently-installed CLI version.
- **Migration framework** (`src/upgrade/`). Registry is empty in 0.1.0 — the first migration ships with 0.2.0. Plan-first UX (`--plan`); explicit `--confirm` required to apply.
- `setup` retained as a deprecated alias to `init` for the 0.x backwards-compat window.
- `CODEBASE_PKG_*` environment variables for Neo4j connection, watched directories, workspace scope, domain labels, and cursor file location.

### Known limitations
- TypeScript and TSX only. Tree-sitter integration for Python/Go/Rust is planned but not in this release.
- No test suite. Integrity checks substitute on the sync pipeline; consumers should treat this as 0.x-grade until tests land.
- Neo4j Community on Docker is the only supported backing store. Kuzu embedded backend is a future option.
