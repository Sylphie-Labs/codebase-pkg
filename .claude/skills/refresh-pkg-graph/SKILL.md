# Refresh PKG Graph

Refresh the codebase knowledge graph for a repo that has drifted since it was last fully classified/inferred — WITHOUT re-enriching the whole graph. Runs the mechanical sync (git-diff + contentHash), then re-runs domain classification and connection inference **scoped to only the nodes that actually changed**. This is the cheap, frequent sibling of `/sync-pkg`: `/sync-pkg` is the full three-step pipeline meant for occasional/manual use, this skill is meant to run unattended (e.g. from `codebase-pkg schedule-refresh`) on a repo that's mostly stable and just needs its stale corner touched up.

## Usage

```
/refresh-pkg-graph
```

## When to Use

- On a schedule (see `codebase-pkg schedule-refresh`) to keep the graph from drifting between manual `/sync-pkg` runs.
- After a small change (a few files) where re-classifying and re-inferring the ENTIRE graph would be wasteful.
- NOT a substitute for `/sync-pkg` after a large refactor or a long pause — for those, run the full pipeline.

## Prerequisites

1. Neo4j running on `bolt://localhost:7687` (override via `CODEBASE_PKG_NEO4J_URI`).
2. `@sylphie-labs/codebase-pkg` installed in this project.
3. The initial seed has been run at least once (`npx codebase-pkg seed`). If not, run that first instead.

Run Cypher via `cypher-shell` (`docker exec "$(docker ps -q --filter name=codebase-pkg-neo4j)" cypher-shell -u neo4j -p codebase-pkg-local "<query>"`) or via the `neo4j-driver` npm package. (The container name is `codebase-pkg-neo4j-<slug>` for per-instance installs; the name-prefix filter resolves it.)

---

## Workflow

### Step 1: Sync the graph (mechanical staleness)

Before running sync, capture the sync cursor it is about to advance FROM — read `.last-sync-commit` (or, if absent, note this is an initial sync) so the exact set of changed files can be re-derived afterward:

```bash
cat .last-sync-commit 2>/dev/null || echo "(no cursor yet — initial sync)"
```

Then run:

```bash
npx codebase-pkg sync
```

Wait for it to complete successfully. If it fails, report the error and stop — do not proceed to scoped classification/inference against a graph that may be half-mutated.

This step is purely mechanical (git-diff + contentHash comparison in `graph-differ.ts`) — it creates/updates/deletes Function, Type, and Constant nodes and their edges. It does **not** classify domains or infer connections; that's what makes it cheap, and why Steps 2–3 below are scoped rather than skipped.

### Step 2: Collect the touched nodes

Re-derive the exact list of files the sync just touched, using the cursor captured in Step 1 and the repo's current HEAD:

```bash
git diff --name-only <captured-cursor> HEAD -- '*.ts' '*.tsx' '*.py'
```

(If Step 1 found no prior cursor, this was an initial sync — every seeded file is "touched"; skip straight to classifying/inferring across the whole graph instead of scoping, since there is no meaningful smaller set.)

For each touched file path, pull every Function/Type/Constant node it defines — `DEFINES` covers all three node kinds uniformly (this is why file-level `git diff` + `DEFINES` is used here instead of the `Change`/`CHANGED_IN` audit trail: `CHANGED_IN` is only wired for Function/Type/Module today, so it would silently miss a file whose only edit was to a module-level constant):

```cypher
MATCH (file:File)-[:DEFINES]->(n)
WHERE file.filePath IN $touchedFilePaths
RETURN file.filePath AS filePath, labels(n) AS nodeLabels,
       n.name AS name, n.domain AS domain
ORDER BY file.filePath
```

This is the scope for Steps 3–4 below — nothing outside this node set gets touched.

### Step 3: Re-classify and re-infer, SCOPED

Re-run domain classification and connection inference, but restricted to the touched node set from Step 2 (plus, for inference, their immediate 1-hop neighbors — a hub/pipeline/bridge call needs to see what a touched node connects to, not the whole graph).

**Domain classification** (Function nodes only — Type/Constant nodes don't carry a `domain` property) — crib the batching/judgment rules from `/classify-pkg-domains` Step 2–3, scoped to the touched set:

```cypher
MATCH (f:Function)
WHERE f.filePath IN $touchedFilePaths
RETURN f.name AS name, f.filePath AS filePath,
       f.jsDoc AS jsDoc, f.returnType AS returnType,
       f.isAsync AS isAsync, f.args AS args
```

Classify every touched Function regardless of its current `domain` (a content change can move a function between domains — e.g. a helper promoted into a route handler) — do not filter to `domain = 'unclassified'` here the way the whole-graph skill does. Write back exactly as `/classify-pkg-domains` Step 3 does.

**Connection inference** — crib the hub/pipeline/bridge/cycle/dead-code/layer patterns from `/infer-pkg-connections`, adding a scope filter to each:

```cypher
// Hubs, scoped: only re-score touched functions (their inDegree may have changed)
MATCH (f:Function)<-[:CALLS]-(caller:Function)
WHERE f.filePath IN $touchedFilePaths
WITH f, count(caller) AS inDegree
WHERE inDegree >= 3
RETURN f.name AS name, f.filePath AS filePath, f.domain AS domain, inDegree

// Bridges, scoped: only pairs where at least one side was touched
MATCH (caller:Function)-[:CALLS]->(callee:Function)
WHERE caller.filePath IN $touchedFilePaths OR callee.filePath IN $touchedFilePaths
MATCH (cm:Module)-[:CONTAINS]->(caller)
MATCH (tm:Module)-[:CONTAINS]->(callee)
WHERE cm.packageName <> tm.packageName
RETURN cm.packageName AS fromPkg, tm.packageName AS toPkg,
       caller.name AS callerName, callee.name AS calleeName
```

Apply the same scope filter (`WHERE ... .filePath IN $touchedFilePaths`, extended to "OR the other side of the relationship") to pipelines, cycles, dead-code, and layers. Write back exactly as `/infer-pkg-connections` Steps 2–6 do (hubScore, DATA_FLOWS_TO, BRIDGES, possiblyDead, architecturalLayer) — cycles remain report-only.

Do NOT re-run classification or inference against nodes outside the touched set — that is the whole point of this skill existing separately from `/sync-pkg`.

### Step 4: Verify

Sanity-check the refresh before reporting it done:

```cypher
// Node/edge counts are non-negative and roughly proportional to the touched-file count
MATCH (n) WHERE n:Function OR n:Type OR n:Constant RETURN labels(n) AS kind, count(*) AS total

// No orphaned CodeBlock: every CodeBlock must be reachable from a Function/Type/Constant via HAS_CODE
MATCH (cb:CodeBlock)
WHERE NOT EXISTS { MATCH (n)-[:HAS_CODE]->(cb) WHERE n:Function OR n:Type OR n:Constant }
RETURN cb.filePath AS filePath, cb.functionName AS name
LIMIT 20
```

If the orphan query returns rows, flag them in the report — don't silently delete; a stray CodeBlock is a signal something upstream (mutation-builder / graph-differ) didn't clean up a delete correctly, worth escalating, not a routine finding.

### Step 5: Report

Print a short summary table:

```
PKG REFRESH REPORT
============================================================
Sync cursor:        <old-commit> -> <new-commit>
Files touched:       N
Nodes touched:       N functions, N types, N constants
Domains reclassified: N (M unchanged from prior label)
Hubs re-scored:      N
Bridges (re)found:   N
Orphaned CodeBlocks: N  (flagged above if > 0)
============================================================
```

If Step 1 reported "no prior cursor" (initial sync), say so plainly and note that this run behaved like a full `/sync-pkg` rather than a scoped refresh.

---

## Key Rules

- **Scope, don't re-enrich the whole graph.** Every classification/inference query in Step 3 must carry a `filePath IN $touchedFilePaths` (or 1-hop-neighbor) filter. If a query in this skill doesn't have one, that's a bug in the skill, not a shortcut to take.
- **No external LLM API calls** — the active Claude Code session does the classification/inference judgment, same as `/classify-pkg-domains` and `/infer-pkg-connections`.
- Always use parameterized Cypher — never interpolate strings into queries.
- If `codebase-pkg sync` fails, stop — do not run scoped classification/inference against a possibly-inconsistent graph.
- If the touched-file set is empty (sync had nothing to do), say so and stop — there is nothing to reclassify.
- An initial sync (no prior `.last-sync-commit`) has no meaningful "touched subset" — treat it as a full pass, not a scoped one.
- Always run the Step 4 orphaned-CodeBlock check before declaring the refresh done — it's the cheapest signal that something upstream broke.
