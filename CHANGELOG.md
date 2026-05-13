# Changelog

All notable changes to `@agent-gear/codebase-pkg` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
