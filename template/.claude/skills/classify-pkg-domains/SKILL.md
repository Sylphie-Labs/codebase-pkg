# Classify PKG Domains

Classify unclassified `Function` nodes in the codebase knowledge graph into domain buckets. Runs locally — reads functions from Neo4j, classifies them using your own judgment, and writes labels back. No external LLM API call is made by this skill; the classification work is done by the active Claude Code session.

## Usage

```
/classify-pkg-domains
/classify-pkg-domains --limit 50           # Up to 50 functions
/classify-pkg-domains --package <name>     # Only one package/scope
```

## Prerequisites

1. Neo4j reachable at the URI in `CODEBASE_PKG_NEO4J_URI` (default `bolt://localhost:7687`).
2. The graph has been seeded (`npx codebase-pkg seed`).

## Domain labels

The set of allowed labels is whatever is configured via the `CODEBASE_PKG_DOMAIN_LABELS` env var (comma-separated). If unset, the package's default taxonomy is used:

| Domain | Description |
|---|---|
| `application` | Main application/domain logic |
| `web-api` | HTTP routes, controllers, request handlers |
| `frontend` | UI components, client-side code |
| `database` | DB clients, migrations, ORM code |
| `infrastructure` | Queues, caches, external service clients |
| `shared-utilities` | Generic helpers, types, logging |
| `cli` | Command-line entry points |
| `testing` | Test utilities, fixtures |
| `unclassified` | Default; functions you have not yet classified |

If `CODEBASE_PKG_DOMAIN_LABELS` is set, use those labels exactly. Override projects almost always do better with a project-specific taxonomy.

---

## Workflow

### Step 1: Query unclassified functions

Run this Cypher against Neo4j:

```cypher
MATCH (f:Function)
WHERE f.domain = 'unclassified' OR f.domain IS NULL
RETURN f.name AS name, f.filePath AS filePath,
       f.jsDoc AS jsDoc, f.returnType AS returnType,
       f.isAsync AS isAsync, f.args AS args
ORDER BY f.filePath
LIMIT $limit
```

Use `$limit` from the `--limit` flag (default: classify all).

If `--package` is given, add `AND f.filePath CONTAINS $package` to the WHERE clause.

### Step 2: Classify in batches

Process functions in batches of ~20. For each:

1. Read the function name, file path, JSDoc, return type, and arguments.
2. Use the **file path** as the strongest signal — the directory the function lives in usually maps to a domain.
3. Use **function name and JSDoc** as clarifying signals.
4. Use **return type and arguments** as supporting signals.
5. When ambiguous, prefer the more specific domain over `shared-utilities`.

### Step 3: Write labels back

For each classified function:

```cypher
MATCH (f:Function {filePath: $filePath, name: $name})
SET f.domain = $domain
```

Run in a single transaction per batch.

### Step 4: Report

Print a summary:

```
Classified X functions:
  application:        N
  web-api:            N
  database:           N
  ...
  Still unclassified: N
```

---

## Key Rules

- **No external LLM API calls** — the active Claude Code session is the classifier. Use your understanding of the code, not a separate Haiku/Sonnet call.
- Classify based on a function's **primary** purpose, not secondary effects.
- Genuinely general-purpose code (logging, config, type guards) → `shared-utilities`.
- HTTP controllers and route handlers → `web-api`.
- Service classes that do domain work → classify by what they do, not that they're services.
- Functions in `src/database/` → `database`, etc. — directory is the strongest signal.
- Run Cypher via `cypher-shell` or the `neo4j-driver`; example:
  ```bash
  docker exec codebase-pkg-neo4j cypher-shell -u neo4j -p codebase-pkg-local "<query>"
  ```
