# Infer PKG Connections

Analyze the codebase knowledge graph to discover cross-cutting patterns — hubs, pipelines, cross-package bridges, dead code, circular dependencies, and architectural layers. Writes discovered relationships and annotations back to the graph. No external LLM API call — the active Claude Code session runs Cypher and applies judgment.

## Usage

```
/infer-pkg-connections                     # Run all analyses
/infer-pkg-connections --analysis hubs     # Just hubs
/infer-pkg-connections --analysis pipelines
/infer-pkg-connections --analysis bridges
/infer-pkg-connections --analysis cycles
/infer-pkg-connections --analysis dead-code
/infer-pkg-connections --analysis layers
/infer-pkg-connections --dry-run           # Report only, no graph writes
```

## Prerequisites

1. Neo4j reachable at `CODEBASE_PKG_NEO4J_URI` (default `bolt://localhost:7687`, user `neo4j`).
2. Graph seeded (`npx codebase-pkg seed`).
3. Domains classified (`/classify-pkg-domains`).

Run Cypher via `cypher-shell` (`docker exec "$(docker ps -q --filter name=codebase-pkg-neo4j)" cypher-shell -u neo4j -p codebase-pkg-local "<query>"`) or via the `neo4j-driver` npm package. (The container name is `codebase-pkg-neo4j-<slug>` for per-instance installs; the name-prefix filter resolves it for both old fixed and new slugged names.)

---

## Analyses

### 1. Hub Detection (`hubs`)

Find functions and types with unusually high connectivity — architectural load-bearing nodes.

```cypher
// Functions with most incoming CALLS
MATCH (f:Function)<-[:CALLS]-(caller:Function)
WITH f, count(caller) AS inDegree
WHERE inDegree >= 3
RETURN f.name AS name, f.filePath AS filePath, f.domain AS domain, inDegree
ORDER BY inDegree DESC
LIMIT 30

// Types with most USES_TYPE references
MATCH (t:Type)<-[:USES_TYPE]-(f:Function)
WITH t, count(f) AS usageCount
WHERE usageCount >= 3
RETURN t.name AS name, t.filePath AS filePath, t.kind AS kind, usageCount
ORDER BY usageCount DESC
LIMIT 30
```

Write back:
```cypher
MATCH (f:Function {filePath: $filePath, name: $name})
SET f.hubScore = $score, f.hubKind = 'function-hub'
```

Classify hubs in your summary:
- **Utility hub**: called by many packages, usually in shared/utility code — healthy.
- **God function**: called by many AND calls many — may need decomposition.
- **Contract type**: interface/type used across 3+ packages — critical to keep stable.

### 2. Pipeline Detection (`pipelines`)

Find chains of CALLS forming processing pipelines (A→B→C→D).

```cypher
MATCH path = (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(c:Function)-[:CALLS]->(d:Function)
WHERE a.filePath <> b.filePath OR b.filePath <> c.filePath
RETURN [n IN nodes(path) | n.name] AS chain,
       [n IN nodes(path) | n.filePath] AS files,
       length(path) AS depth
ORDER BY depth DESC
LIMIT 20
```

Write back as `DATA_FLOWS_TO` edges with a pipeline name derived from the domain context (e.g. "request-handling-pipeline", "auth-validation-pipeline"):

```cypher
MATCH (a:Function {filePath: $aFile, name: $aName})
MATCH (b:Function {filePath: $bFile, name: $bName})
MERGE (a)-[r:DATA_FLOWS_TO]->(b)
SET r.pipelineName = $pipelineName, r.discoveredAt = timestamp()
```

### 3. Cross-Package Bridge Detection (`bridges`)

Find functions and types that create dependencies between packages.

```cypher
MATCH (caller:Function)-[:CALLS]->(callee:Function)
MATCH (cm:Module)-[:CONTAINS]->(caller)
MATCH (tm:Module)-[:CONTAINS]->(callee)
WHERE cm.packageName <> tm.packageName
RETURN cm.packageName AS fromPkg, tm.packageName AS toPkg,
       caller.name AS callerName, callee.name AS calleeName

MATCH (f:Function)-[:USES_TYPE]->(t:Type)
MATCH (fm:Module)-[:CONTAINS]->(f)
MATCH (tm:Module)-[:CONTAINS]->(t)
WHERE fm.packageName <> tm.packageName
RETURN fm.packageName AS consumerPkg, tm.packageName AS providerPkg,
       t.name AS typeName, count(f) AS usageCount
ORDER BY usageCount DESC
```

Write back:
```cypher
MATCH (a:Function {filePath: $callerFile, name: $callerName})
MATCH (b:Function {filePath: $calleeFile, name: $calleeName})
MERGE (a)-[r:BRIDGES]->(b)
SET r.fromPackage = $fromPkg, r.toPackage = $toPkg, r.discoveredAt = timestamp()
```

### 4. Circular Dependency Detection (`cycles`)

Find cycles in the CALLS and IMPORTS graphs.

```cypher
// Module-level circular imports (A imports B imports A)
MATCH (a:Module)-[:IMPORTS]->(b:Module)-[:IMPORTS]->(a)
WHERE id(a) < id(b)
RETURN a.filePath AS moduleA, b.filePath AS moduleB

// Function-level 2-cycle
MATCH (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(a)
WHERE id(a) < id(b)
RETURN a.name AS funcA, a.filePath AS fileA,
       b.name AS funcB, b.filePath AS fileB

// 3-hop cycle
MATCH path = (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(c:Function)-[:CALLS]->(a)
WHERE id(a) < id(b) AND id(b) < id(c)
RETURN [n IN nodes(path) | n.name] AS cycle,
       [n IN nodes(path) | n.filePath] AS files
```

Report only — do not persist cycles as edges. Cycles are a smell to surface, not a relationship to track.

### 5. Dead Code Detection (`dead-code`)

Find exported functions with no incoming CALLS edges.

```cypher
MATCH (f:Function)
WHERE NOT EXISTS { MATCH ()-[:CALLS]->(f) }
  AND NOT f.name STARTS WITH 'main'
  AND NOT f.name CONTAINS '.onModuleInit'
  AND NOT f.name CONTAINS '.onModuleDestroy'
  AND f.httpMethod IS NULL
  AND NOT (f.decorators CONTAINS 'Cron' OR f.decorators CONTAINS 'OnEvent')
  AND f.isExported = true
RETURN f.name AS name, f.filePath AS filePath, f.domain AS domain
ORDER BY f.filePath
```

Write back:
```cypher
MATCH (f:Function {filePath: $filePath, name: $name})
SET f.possiblyDead = true, f.deadCodeDetectedAt = timestamp()
```

**Caveats — always include in the report:**
- Decorator-driven functions (`@Cron`, `@OnEvent`, `@Subscribe`, framework hooks) are entry points.
- Constructor-injected services are entry points.
- Test helpers may appear dead but are used in test files (which are excluded from the watched paths).
- Flag as "possibly dead" — human review needed.

### 6. Architectural Layer Inference (`layers`)

Infer which architectural layer each module belongs to based on call patterns.

Heuristics:
- **Presentation**: modules containing HTTP endpoint functions.
- **Application**: modules orchestrating (called by presentation, calling into domain).
- **Domain**: core business logic (called by application, calling into infrastructure).
- **Infrastructure**: modules that interact with storage clients, queues, external services.

```cypher
// Presentation layer
MATCH (m:Module)-[:CONTAINS]->(f:Function)
WHERE f.httpMethod IS NOT NULL
RETURN DISTINCT m.filePath AS modulePath, 'presentation' AS layer

// Infrastructure layer (path-based heuristic)
MATCH (m:Module)-[:CONTAINS]->(f:Function)
WHERE f.filePath CONTAINS '/storage/' OR f.filePath CONTAINS '/database/'
   OR f.filePath CONTAINS '/clients/'
RETURN DISTINCT m.filePath AS modulePath, 'infrastructure' AS layer
```

Write back:
```cypher
MATCH (m:Module {filePath: $modulePath})
SET m.architecturalLayer = $layer
```

---

## Output

After all analyses run, print a summary:

```
PKG INFERENCE REPORT
============================================================
Hub Functions:    N (M god-functions flagged)
Hub Types:        N (M cross-package contract types)
Pipelines:        N discovered
Bridges:          N cross-package connections
Circular Deps:    N cycles detected
Dead Code:        N possibly-dead exported functions
Layer Assignment: N modules classified

New graph elements written:
  hubScore properties:    N
  DATA_FLOWS_TO edges:    N
  BRIDGES edges:          N
  possiblyDead flags:     N
  architecturalLayer:     N
============================================================
```

---

## Key Rules

- **No external LLM API calls** — the active Claude Code session is the analyzer. Use Cypher and judgment.
- Always use parameterized Cypher — never interpolate strings into queries.
- For `--dry-run`, print what would be written but skip all `SET`/`MERGE` writes.
- Run analyses in order: hubs → pipelines → bridges → cycles → dead-code → layers.
- If an analysis returns 0 results, say so and move on — not an error.
- Pipeline naming should reflect domain context, not just "pipeline-1".
- Dead code detection has high false-positive rate — always caveat results.
