# Sync PKG

Refresh the codebase knowledge graph: re-seed or incrementally sync from source, classify domains, and infer connections. Three steps, run sequentially.

## Usage

```
/sync-pkg
```

## When to Use

- After code changes that affect function signatures, module structure, or call patterns.
- When the graph needs to be brought up to date with the codebase before running analyses.
- After a long pause where many commits have landed.

## Prerequisites

1. Neo4j running on `bolt://localhost:7687` (override via `CODEBASE_PKG_NEO4J_URI`).
2. `@sylphie-labs/codebase-pkg` installed in this project.
3. The initial seed has been run at least once (`npx codebase-pkg seed`). If not, run that first instead of sync.

---

## Workflow

### Step 1: Sync the graph

Run in the terminal:

```bash
npx codebase-pkg sync
```

Wait for it to complete successfully before proceeding. If it fails, report the error and stop.

### Step 2: Classify domains

Run the `/classify-pkg-domains` skill.

Wait for it to complete before proceeding.

### Step 3: Infer connections

Run the `/infer-pkg-connections` skill.

---

## Key Rules

- Steps must run sequentially — each depends on the previous one.
- If any step fails, stop and report the error — do not continue to the next step.
- Do not pass extra flags to the sub-skills unless explicitly instructed.
