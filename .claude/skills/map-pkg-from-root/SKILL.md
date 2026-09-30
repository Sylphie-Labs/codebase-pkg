# Map PKG From Root

Map the codebase knowledge graph **top-down**: start at the application's true entry point (its root) and descend, summarizing what each surface does and what it reaches. This complements the bottom-up `/infer-pkg-connections` (which aggregates individual functions upward) by working in the opposite direction — from "the page you see" down into "what that page is built from." No external LLM API call — the active Claude Code session runs Cypher and applies judgment.

## Usage

```
/map-pkg-from-root                          # Detect and map every app root
/map-pkg-from-root --root <name|filePath>   # Start from one specific root (e.g. App.tsx, a route)
/map-pkg-from-root --kind frontend|backend|cli
/map-pkg-from-root --depth 5                # Max descent depth (default 5)
/map-pkg-from-root --dry-run                # Report only, no graph writes
```

## Prerequisites

1. Neo4j reachable at `CODEBASE_PKG_NEO4J_URI` (default `bolt://localhost:7687`, user `neo4j`).
2. Graph seeded (`npx codebase-pkg seed`).
3. Recommended: domains classified (`/classify-pkg-domains`) and connections inferred (`/infer-pkg-connections`) first — `domain`, `hubScore`, and the inferred edges sharpen the summaries and tell you which reached nodes are significant.

Run Cypher via `cypher-shell` (`docker exec "$(docker ps -q --filter name=codebase-pkg-neo4j)" cypher-shell -u neo4j -p codebase-pkg-local "<query>"`) or via the `neo4j-driver` npm package. (The container name is `codebase-pkg-neo4j-<slug>` for per-instance installs; the name-prefix filter resolves it for both old fixed and new slugged names.)

---

## Workflow

### Step 1: Identify the root entry point(s)

A root is where execution (or rendering) begins. Detect roots per kind. In a monorepo, scope each query per `Service` node and map one service at a time.

**Frontend root** — the top-most app file and the root component it defines:

```cypher
MATCH (file:File)-[:DEFINES]->(root:Function)
WHERE file.fileName IN ['App.tsx', 'App.jsx', 'main.tsx', 'main.jsx', 'index.tsx']
  AND root.isExported = true
RETURN file.fileName AS fileName, file.filePath AS filePath,
       root.name AS rootName, root.domain AS domain
ORDER BY size(file.filePath)
LIMIT 5
```

Prefer the shortest `filePath` in the watched dir (the top-most one) as the primary frontend root.

**Backend root** — the bootstrap file plus the HTTP route surface:

```cypher
// Bootstrap entry file
MATCH (file:File)-[:DEFINES]->(root:Function)
WHERE file.fileName IN ['main.ts', 'server.ts', 'app.ts', 'index.ts']
RETURN file.fileName AS fileName, file.filePath AS filePath,
       root.name AS rootName, root.domain AS domain
ORDER BY size(file.filePath)
LIMIT 5

// Route surface — each route handler is a sub-root
MATCH (f:Function)
WHERE f.httpMethod IS NOT NULL
RETURN f.httpMethod AS method, f.routePath AS routePath,
       f.name AS name, f.filePath AS filePath, f.domain AS domain
ORDER BY f.routePath
```

**CLI root** — command entry points:

```cypher
MATCH (f:Function)
WHERE (f.filePath CONTAINS '/cli/' OR f.filePath CONTAINS '\\cli\\')
   OR (f.isExported = true AND f.name IN ['main', 'run'])
RETURN f.name AS name, f.filePath AS filePath, f.domain AS domain
ORDER BY f.filePath
```

Honor `--kind` by running only the matching detector. Honor `--root` by matching a single node by name or path:

```cypher
MATCH (root:Function)
WHERE root.name = $root OR root.filePath CONTAINS $root
RETURN root.name AS name, root.filePath AS filePath, root.domain AS domain
LIMIT 1
```

(If `--root` names a `File` rather than a `Function`, match `(:File)` on `fileName`/`filePath` and descend from the function(s) it `DEFINES`.)

### Step 2: Descend from the root

Breadth-first down from the root, following `CALLS` (Function→Function) and module `IMPORTS`, bounded by `--depth` (default 5). Record the hop count at each reached node:

```cypher
MATCH path = (root:Function {filePath: $rootFile, name: $rootName})-[:CALLS*1..5]->(reached:Function)
WITH reached, min(length(path)) AS hops
RETURN reached.name AS name, reached.filePath AS filePath,
       reached.domain AS domain, reached.httpMethod AS httpMethod,
       reached.hubScore AS hubScore, hops
ORDER BY hops, reached.filePath
```

Substitute the `*1..5` upper bound with `--depth`. For the module-level reach (which files/packages a root pulls in), follow `IMPORTS`:

```cypher
MATCH (rootFile:File {filePath: $rootFile})<-[:CONTAINS_FILE]-(rootMod:Module)
MATCH path = (rootMod)-[:IMPORTS*1..5]->(reachedMod:Module)
WITH reachedMod, min(length(path)) AS hops
RETURN reachedMod.filePath AS modulePath, hops
ORDER BY hops
```

Note: frontend component composition is **approximated** via `CALLS` + `IMPORTS`. JSX child rendering (e.g. `<Sidebar/>` inside a component's return) does not always appear as a `CALLS` edge, so a parent component's reach may understate the real render tree — caveat this in the summary when mapping frontend roots.

### Step 3: Summarize top-down

Process roots one at a time. For each root — and then for each significant reached surface — the active session reads the names, `jsDoc`, `domain`, `routePath`, and `httpMethod` of the subtree and writes, in plain language:

- **`purpose`** — what this surface *is* (e.g. "Root React app shell; mounts routing and global providers", "POST /orders route handler").
- **`summary`** — what it *does*, what it *reaches*, and how it's *used* (reference the domains and routes it touches, the hubs it leans on, the layer it sits in — not a generic restatement of the name).

Summarize the root first, then its notable children. Keep summaries concrete and grounded in the domain/route context surfaced in Step 2.

### Step 4: Write back

All writes are parameterized. Set the entry-point annotations on the root node (a `Function` or `File`):

```cypher
MATCH (root:Function {filePath: $rootFile, name: $rootName})
SET root.entryPointKind = $kind,
    root.purpose = $purpose,
    root.summary = $summary,
    root.reachableCount = $n
```

Create `REACHES` edges from the root to the **significant** nodes it reaches, carrying the hop distance:

```cypher
MATCH (root:Function {filePath: $rootFile, name: $rootName})
MATCH (t:Function {filePath: $targetFile, name: $targetName})
MERGE (root)-[r:REACHES]->(t)
SET r.hops = $hops
```

Only create `REACHES` to *significant* nodes — hubs (high `hubScore`), domain-distinct functions, and types — not every transitively-called helper. Mapping the full transitive closure would explode the edge count and bury the signal. A `REACHES` edge says "this root meaningfully depends on this surface," not "this root can eventually call this."

Under `--dry-run`, print the `entryPointKind`/`purpose`/`summary`/`reachableCount` you would set and the `REACHES` edges you would create, and skip every `SET`/`MERGE`.

### Step 5: Dive deeper

Mapping is recursive. After a root is mapped, pick any surface it reaches — a page, a route handler, a CLI command — and re-run Steps 2–4 treating that surface as a **sub-root**. This is the "see a page, then dive deeper from there" behavior: each descent summarizes one level and exposes the next set of surfaces to drill into. `--root <name|filePath>` lets the user target a specific surface directly without re-detecting from the top.

### Step 6: Report

Print a tree of roots, each with its kind, purpose, reachable count, and the top few surfaces it reaches:

```
PKG ROOT MAP
============================================================
[frontend] App  (src/App.tsx)
  purpose:  Root React shell; mounts router + providers
  reaches:  37 surfaces
    → DashboardPage    (1 hop)  Renders the metrics dashboard; reads from the reporting domain
    → useAuth          (2 hops) Auth hub; gates protected routes
    → apiClient        (2 hops) HTTP client used by every page

[backend] POST /orders  (src/orders/orders.controller.ts)
  purpose:  Order-creation route handler
  reaches:  12 surfaces
    → OrderService.create (1 hop) Validates and persists a new order
    → PaymentGateway      (2 hops) Infrastructure bridge to the payment provider
============================================================
```

---

## Key Rules

- **No external LLM API calls** — the active Claude Code session is the analyzer. Use Cypher and judgment, not a separate Haiku/Sonnet call.
- Always use parameterized Cypher — never interpolate strings into queries.
- For `--dry-run`, print what would be written but skip all `SET`/`MERGE` writes.
- If no root is detected for a kind, say so and move on — not an error.
- Only create `REACHES` to *significant* nodes (hubs, domain-distinct functions, types), never the full transitive closure — avoid edge explosion.
- Summaries must reference domain/route context — not be a generic paraphrase of the node name.
- Descent is bounded by `--depth` (default 5) to avoid runaway traversal on deep graphs.
- Frontend reach is approximate: JSX child rendering may not appear as `CALLS` — caveat it.
- Process roots one at a time: summarize the root, then its notable children, before moving to the next root.
- Run Cypher via `cypher-shell` or the `neo4j-driver`; example:
  ```bash
  docker exec "$(docker ps -q --filter name=codebase-pkg-neo4j)" cypher-shell -u neo4j -p codebase-pkg-local "<query>"
  ```
  (The container name is `codebase-pkg-neo4j-<slug>` for per-instance installs; the name-prefix filter resolves it.)
