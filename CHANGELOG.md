# Changelog

All notable changes to `@sylphie-labs/codebase-pkg` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
