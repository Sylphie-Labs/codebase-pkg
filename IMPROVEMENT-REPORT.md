# codebase-pkg — Improvement Research Report

**Prepared for:** Jim Tisdale · **Date:** June 27, 2026
**Scope:** Whole-project survey, focused on the real goal — help a human understand unfamiliar codebases, and give the agent best-in-class tools to search code and explain how things work
**Subject:** `@sylphie-labs/codebase-pkg` v0.5.0 (~12.8k LOC TypeScript)
**Constraint:** Neo4j stays. It is the fast multi-hop relationship engine and the whole point — recommendations are *additive* on top of the existing stack, not a re-platform.

---

## 1. Executive summary

`codebase-pkg` parses TS/TSX and Python into a Neo4j knowledge graph and serves it to Claude Code over MCP, with a genuinely novel conformity judge (deterministic style-decision facts + pgvector embedding-novelty) bolted on. The core is well-architected, honestly documented, and unit-tested.

The goal is not a visualization niche — it's a tool that helps you understand a codebase and gives the agent everything it needs to answer "where is X?" and "how does this work?" on demand. Measured against how coding agents actually retrieve code in 2026, that goal plays directly to what you've built.

The current best-practice retrieval stack is **three layers**, and the agent escalates by query shape:

1. **Lexical (grep/ripgrep)** — exact symbols, short keyword queries. Dominant: Claude Code, Cursor, and Devin run grep, not vector DBs; short keyword queries collapse most semantic models (CoREB benchmark, May 2026). *You cover this with `searchContent`.*
2. **Structural (graph / AST / call-hierarchy)** — "what calls this, how does data flow, how does X work." Pre-computed graphs win big here: independent tests measure ~58–70% fewer agent tool calls with a code-graph, and call-hierarchy lookups run ~900x faster and 5–34x cheaper in tokens than grepping for call sites. **This is Neo4j's home turf and your strongest asset** — `getDataFlow`, `CALLS`, `getFunctionDetail`.
3. **Semantic (embeddings)** — conceptual queries ("where is auth handled?"), best used *hybrid* with grep (Cursor measured +12.5% accuracy combining them). *You already compute the vectors but never expose them for search.*

There are **two audiences, served by two surfaces over the same graph:**

- **The agent** gets better retrieval *tools* (text in, structured context out) — semantic search + a "how does X work" traversal.
- **The dev (you)** gets a *visual* surface — an interactive view of how things actually work (call flows, data flows, request traces), for human comprehension and onboarding. Part of this also serves the agent, but its primary job is letting a person *see* the system.

The unifying insight: both are the same Neo4j multi-hop traversal rendered two ways — a synthesized text trace for the agent, an interactive flow diagram for the dev. Build the traversal once; surface it twice.

**Recommendation in one line:** keep Neo4j; make the agent's retrieval best-in-class by closing two additive gaps (expose the embeddings you already pay for as a semantic-search tool; add one high-level "how does X work" traversal tool that exploits Neo4j's multi-hop strength), give the dev a visual "how it works" view over that same traversal, and shore up the foundation with an end-to-end smoke test and wider language coverage.

---

## 2. The codebase today: assessment highlights

A deep read of `src/` (not just the README) confirms a focused, lean system with a clean two-phase design.

**Strengths.** Content-hash (SHA-256) change detection drives incremental sync; mutations are transaction-scoped (all-or-nothing); the cursor only advances after integrity checks pass; language dispatch is isolated at the parser layer; skills enrich the graph schemalessly (`DATA_FLOWS_TO`, `REACHES`/`hops`, `hubScore`, root `summary`/`purpose`) without touching the core schema; the conformity feature is cleanly optional (`CODEBASE_PKG_CONFORMITY=off`) and never fatal to sync. The `state.json` install model (drift detection, per-repo port allocation, clean upgrade/uninstall) is notably well-built. The README is honest about its own limits — a good maintainability signal.

**Real gaps (beyond what the README admits):**

- **No end-to-end test against live Neo4j + Postgres.** Everything is unit-tested with in-memory fakes; the MCP tool handlers (`src/mcp-server/tools/*.ts`) are untested. This is the single biggest confidence gap.
- **Seed builds nodes and edges in two separate passes** (`src/ingestion/initial-seed.ts`: node pass ~L455, relationship-edge pass "Step 5/8" ~L484). A crash in the second pass leaves a half-seeded graph that needs a manual `reset --graph-only`.
- **Module nodes have no rename/orphan lifecycle.** Move a directory and the old `Module` node persists with stale metadata; deleted files don't prune orphaned modules (`src/sync/mutation-builder.ts`).
- **Silent drops.** Unresolvable imports are skipped without warning; function bodies are truncated at 8000 chars with no signal.
- **Single-writer assumption.** The one `TODO(multi-writer)` in `src/conformity/store.ts` is a real race risk if `sync` and `conformity-judge` ever run concurrently (e.g. wired into CI).
- **Scalability is unproven.** `BATCH_SIZE=50` is a guess; no perf profile exists; MCP traversals (`getModuleContext`, `searchContent`) have no pagination, so large monorepos could OOM on seed or return unbounded results.
- **Language depth is thin.** Python is shape-only (no decorators, no default params); conformity decision axes are TS-only. No Go/Rust/Java/C#.

**What this means for the visualizer:** the graph already contains everything a rich human-facing view needs — the full call graph (`CALLS`), type hierarchy (`EXTENDS`/`IMPLEMENTS`), module/service structure, import graph, per-commit change history (`Change` nodes), HTTP endpoints (`httpMethod`/`routePath`), DI graph (`INJECTS`), plus skill-added `hubScore`, `REACHES`, and conformity outliers/embeddings in Postgres. You are not missing data; you are missing a renderer.

---

## 3. Competitive landscape (what already exists)

I split the field into two groups, because your project sits at their intersection.

### 3.1 Human-facing interactive code explorers (the visualizer niche)

| Tool | What it does | Status | Lesson for you |
|---|---|---|---|
| **Sourcetrail** | Offline interactive source explorer: symbol graph + search + synchronized code/graph panes. C/C++/Java/Python. | **Discontinued 2021**, open-sourced (CoatiSoftware/Sourcetrail) | The gold-standard UX for "interactive codebase walk." Steal its split-pane graph↔code model. The niche is *vacant*. |
| **CodeSee** | Web code maps, dependency views, review-impact ("what does this PR touch"). | **Shut down Feb 2024**, absorbed into GitKraken, brand sunset | Died partly from *not covering enough languages/stacks fast enough*. A direct warning re: your language gap. |
| **Sourcegraph** | Code search + cross-repo navigation; now pivoted to AI (Deep Search, Cody), ships a Claude Code MCP plugin. | Active, enterprise, moved up-market to AI | Not a static-viz competitor anymore; validates MCP-for-code as a direction. |
| **CodeCharta / repo viz tools** | 3D "code city" metric visualizations. | Niche/active | Metric-overlay idea (size/color by a property) is worth borrowing for `hubScore`/conformity. |

### 3.2 AI-era code knowledge graphs (your core's neighbors)

| Tool | Overlap with codebase-pkg | Differentiator vs you |
|---|---|---|
| **Understand Anything** (Egonex-AI) | Highest. Claude Code plugin → KG of files/functions/classes + **interactive dashboard with name/semantic search**. ~14.7k stars. | Indexes via **multi-agent LLM passes** (token cost, non-deterministic) and per-file English summaries. You index deterministically with ts-morph (no tokens) and add conformity — but they already shipped the dashboard you're contemplating. |
| **CodeGraph** (colbymchenry) | High. Pre-indexed code KG, auto-sync on change, 100% local, MCP for many agents. | Multi-agent ecosystem reach; "fewer tokens, fewer tool calls" pitch. No conformity/style signal. |
| **CodeGraphContext** | High. MCP server + CLI indexing code into a graph DB for AI; traces callers/callees across layers. | Similar core; no human viz, no conformity. |
| **FalkorDB CodeGraph / Memgraph GraphRAG / Graphify** | Medium. Graph(+vector) code understanding, NL querying; Graphify uses tree-sitter + NetworkX + Leiden clustering. | Graph-vendor-led; broader language reach via tree-sitter; less opinionated about agent workflow. |

**Read of the market:** the human-viz incumbents are gone; the AI-graph entrants are multiplying and starting to add dashboards and semantic search. The 2026 retrieval consensus also matters here — agents lean on grep for exact lookups but get their biggest token/tool-call savings from a **pre-computed structural graph** served over MCP. That is exactly what you have. Your defensible position is the **combination** of (a) deterministic, token-free AST indexing, (b) fast Neo4j multi-hop traversal for "how does this work," (c) the conformity judge (nobody else has this), and (d) a human flow view that exposes all of it — fully local/offline.

---

## 4. The two surfaces over your graph

Same Neo4j traversal, two audiences. Pillar A is the agent's retrieval tools (the priority — it's what makes "how does this work?" answerable). Pillar B is the dev's visual surface (your visualizer, reframed around its real job: *seeing* how things work).

### 4A. Agent retrieval — two additive tools (keep Neo4j, add nothing to the stack)

#### 4A.1 Semantic-search MCP tool — *highest leverage, nearly free*

You already compute a 768-dim embedding for every function/type/const (`cfm_vectors`, via the jina code model) and use it **only** to flag conformity outliers. The vectors and the model are already paid for. Expose them as a retrieval tool:

- New MCP tool `searchSemantic(query, kind?, maxResults?)`: embed the query, run pgvector cosine ANN against `cfm_vectors` (the HNSW index already exists), return the nearest entities with their graph context.
- Pair it with the existing `searchContent` (lexical) so the agent gets the **hybrid** that benchmarks reward (+12.5% accuracy in Cursor's testing). The agent picks lexical for exact symbols, semantic for "where is X handled?".
- This is the one capability competitors (Understand Anything) advertise loudly — and you can do it **deterministically, locally, offline**, with zero new dependencies. Effort: low (the hard parts — model, vectors, index — exist).

#### 4A.2 "How does X work" traversal tool — *exploits Neo4j's multi-hop strength*

Today the agent must orchestrate several tools to explain a flow (`getFunctionDetail` + `getDataFlow` + reading bodies). Collapse that into one:

- New MCP tool `explainFlow(symbol, direction?, depth?)`: from a seed node, do the multi-hop `CALLS`/`REACHES`/`DATA_FLOWS_TO` traversal Neo4j is fast at, then assemble the trace — each hop's signature, JSDoc, key body lines, and skill-added `summary`/`purpose` — into one structured response.
- This is precisely the "pre-computed graph → 58–70% fewer agent tool calls" win the 2026 benchmarks credit to code-graph tools. It turns "how does auth work?" from ~20 greps into one call, and it leans directly on the relationship-hopping you said is the whole point of keeping Neo4j.
- It also becomes the **shared engine for Pillar B**: the same traversal that returns a text trace to the agent feeds the dev's visual flow.

### 4B. The dev's visual surface — *seeing how things work*

Reframed from "a graph viewer" to its actual purpose: a **visual, interactive view of how the system works** — call flows, data flows, request traces — for human comprehension and onboarding. Some of it (the deep-linkable scene) is also handy to the agent, but its primary audience is you.

**Don't adopt an off-the-shelf one.** Understand Anything bundles a dashboard but re-indexes with LLM agents (token cost, non-deterministic), discarding your deterministic graph; Sourcetrail/CodeSee are dead; CodeGraph* have no human view. The data is yours and already built — this is a read-only renderer, not a pipeline.

**Recommended shape (local-first, offline, zero-service-to-view):**

1. **`codebase-pkg export` → `graph.json`.** Cypher dump of nodes + edges + key properties (join in `hubScore`/conformity). The page loads a static snapshot — the "static page that gets loaded up" you described — with no running Neo4j required, and the snapshot is diffable/shareable.
2. **Single self-contained HTML file**, no build step, no server.
3. **Flow-first views, not a node blob.** Because the dev wants to see *how things work*, lead with directed flow/trace views (pick an entry point → watch the call/data flow propagate) over a static force-directed cloud. Render with **Sigma.js + graphology** (WebGL, scales to 100k+ nodes; canvas renderers like Cytoscape.js degrade past ~3–5k). Cytoscape is the better pick only if you cap scope to a module subtree and want richer built-in layouts with less code.
4. **Split-pane UX (à la Sourcetrail):** flow/graph on one side, source + detail on the other. Click a node → body (`CodeBlock.bodyText`), JSDoc, recent `Change`s, conformity verdict.
5. **Search** over `name`/`filePath`/`domain`/`jsDoc`, optionally backed by the same `searchSemantic` vectors from 4A.1.
6. **URL filtering / deep links (your specific requirement):** encode the scene in the URL so a given URL renders exactly what's seen there — e.g. `#node=src/foo.ts::bar&depth=2&dir=downstream&filter=domain:auth&q=parseFile&color=hubScore`. Shareable, bookmarkable, reconstructed on load.

**Visual overlays competitors can't copy (your data):** conformity outliers badged on nodes; a change-history heatmap from `Change` nodes (CodeSee's lost killer feature); hub view sizing nodes by `hubScore`; an onboarding walk outward from entry-point roots (`entryPointKind`/`purpose`/`summary`).

**Effort & risk:** low-to-medium. Export is ~half a day of Cypher; the page is the real work but self-contained with no backend. Main risk is layout performance on big graphs — mitigated by Sigma + loading subgraphs on demand by URL filter rather than rendering everything at once.

---

## 5. Whole-project improvement survey (prioritized)

Ranked by leverage (impact ÷ effort). The two retrieval tools rise to the top because they're additive, near-free, and directly serve the goal (agent answers "where is X / how does this work").

**P0 — highest leverage, additive, no stack change**

1. **Semantic-search MCP tool** (§4A.1). Expose the embeddings you already compute as a search tool, hybridized with `searchContent`. Near-free (model + vectors + index exist); biggest jump in the agent's "where is X handled?" ability.
2. **"How does X work" traversal tool** (§4A.2). One MCP call that walks `CALLS`/`REACHES`/`DATA_FLOWS_TO` and assembles a trace. Exploits the exact Neo4j multi-hop strength you're keeping the graph for; also becomes the engine behind the visual flow view.

**P0 — strategic foundation**

3. **End-to-end smoke test against live Neo4j + Postgres.** Provision throwaway services, run init→seed→sync→conformity-backfill→judge on a fixture monorepo, assert node/edge/row counts and vector dims. Closes the project's biggest honesty caveat and protects every change after it.
4. **Language coverage via tree-sitter.** The clearest strategic gap (and the thing that killed CodeSee). tree-sitter (306+ grammars, incremental, used by GitHub's code-nav) unlocks Go/Rust/Java/C# behind your existing parser-dispatch layer. Prove one language end-to-end first. Widens addressable codebases more than any other single change.

**P1 — high value**

5. **The dev visual flow view** (§4B). A flow-first, deep-linkable view of how the system works, for human comprehension/onboarding — built on the §4A.2 traversal engine.
6. **Scalability profiling + pagination.** Add `--profile` timing/memory per pipeline step; test at 1k/5k/10k functions; tune `BATCH_SIZE`; add cursor/limit to unbounded MCP traversals (`getModuleContext`, `searchContent`). Required before this runs on a real enterprise monorepo.

**P2 — correctness & robustness**

5. **Atomic seed.** Fold edge-building into the per-batch transaction (or retry the relationship pass) so a mid-seed crash can't leave a half-built graph (`initial-seed.ts`, the "Step 5/8" relationship pass ~L484).
6. **Module lifecycle.** On sync, prune orphaned `Module` nodes and detect directory renames so the graph doesn't bloat/skew as the repo refactors (`mutation-builder.ts`).
7. **Surface silent drops.** Warn on unresolvable imports and body truncation instead of dropping them quietly.

**P3 — hygiene**

8. **Concurrency guard** on the conformity store (advisory lock or explicit single-writer doc) to make CI integration safe — resolves the lone `TODO`.

---

## 6. Recommended roadmap

A pragmatic sequence that ships agent value first, then the dev surface, while shoring up the foundation:

1. **Now:** ship the **semantic-search MCP tool** (§4A.1) — near-free, biggest immediate gain in the agent's ability to find code; and write the **end-to-end smoke test** (§5 P0-3) to de-risk everything after it.
2. **Next:** build the **`explainFlow` traversal tool** (§4A.2) — one call for "how does X work," and the shared engine for the visual view.
3. **Then:** `codebase-pkg export` → `graph.json` and the **dev flow view** (§4B): single-file, flow-first, search + URL-state deep links, with conformity/change/hub overlays competitors can't copy.
4. **In parallel / next milestone:** prove one new language through **tree-sitter** (§5 P0-4); add profiling + pagination.
5. **Cleanup pass:** atomic seed, module lifecycle, silent-drop warnings, concurrency guard.

The throughline: you already did the expensive, defensible part — a deterministic, conformity-aware code graph with fast multi-hop traversal. The highest-leverage moves are **surfacing that graph as great retrieval** (so the agent answers "where is X / how does this work" in one call) and **giving the dev a way to see it** — built on the same traversal, no change to the stack you're keeping.

---

## Sources

- [Best Codebase Visualization Tools (repowise)](https://www.repowise.dev/blog/comparisons/best-codebase-visualization-tools)
- [Sourcetrail — GitHub (CoatiSoftware)](https://github.com/CoatiSoftware/Sourcetrail) · [Sourcetrail — Wikipedia](https://en.wikipedia.org/wiki/Sourcetrail) · [Sourcegraph vs Sourcetrail (StackShare)](https://stackshare.io/stackups/sourcegraph-vs-sourcetrail)
- [CodeSee shutting down (LinkedIn, Shanea Leven)](https://www.linkedin.com/feed/update/urn:li:activity:7163970333912289281) · [CodeSee alternatives after GitKraken acquisition (Koalr)](https://koalr.com/blog/codesee-alternatives) · [Code Visualization: types & tools (CodeSee)](https://www.codesee.io/learning-center/code-visualization)
- [Understand Anything — GitHub (Lum1104/Egonex-AI)](https://github.com/Lum1104/Understand-Anything) · [Understand Anything deep dive (DEV Community)](https://dev.to/arshtechpro/understand-anything-turn-any-codebase-into-an-interactive-knowledge-graph-37ed)
- [CodeGraph — GitHub (colbymchenry)](https://github.com/colbymchenry/codegraph) · [CodeGraphContext — GitHub](https://github.com/CodeGraphContext/CodeGraphContext)
- [Sourcegraph – Claude Plugin (Anthropic)](https://claude.com/plugins/sourcegraph) · [Sourcegraph Claude Code plugin (GitHub)](https://github.com/sourcegraph-community/sourcegraph-claudecode-plugin)
- [CodeGraph / GraphRAG — FalkorDB](https://www.falkordb.com/blog/code-graph/) · [GraphRAG for Devs — Memgraph](https://memgraph.com/blog/graphrag-for-devs-coding-assistant) · [Graphify](https://graphify.net/)
- [Cytoscape.js](https://js.cytoscape.org/) · [Cytoscape vs vis-network vs Sigma.js 2026 (PkgPulse)](https://www.pkgpulse.com/blog/cytoscape-vs-vis-network-vs-sigma-graph-visualization-javascript-2026) · [Rendering large network graphs on the web (Medium)](https://weber-stephen.medium.com/the-best-libraries-and-methods-to-render-large-network-graphs-on-the-web-d122ece2f4dc) · [JS graph viz library comparison (Cylynx)](https://www.cylynx.io/blog/a-comparison-of-javascript-graph-network-visualisation-libraries/)
- [tree-sitter — GitHub](https://github.com/tree-sitter/tree-sitter) · [tree-sitter-language-pack (306+ grammars)](https://github.com/kreuzberg-dev/tree-sitter-language-pack) · [Incremental parsing with tree-sitter (Tomassetti)](https://tomassetti.me/incremental-parsing-using-tree-sitter/)
- [Code Search for AI Agents: ripgrep, ast-grep, or Semantic? (ceaksan)](https://ceaksan.com/en/code-search-for-ai-agents-which-tool-when) · [Why Cursor, Claude Code, and Devin use grep, not vectors (MindStudio)](https://www.mindstudio.ai/blog/is-rag-dead-what-ai-agents-use-instead) · [Grep vs. Graph: agentic search vs governed knowledge (Yu, Medium)](https://medium.com/@yu-joshua/grep-vs-graph-agentic-search-is-powerful-but-enterprise-ai-needs-governed-knowledge-8de709c31451) · [Code Intelligence Tools for AI Agents Compared (Ry Walker)](https://rywalker.com/research/code-intelligence-tools)
- [agent-lsp — MCP server (65 tools, 30 languages)](https://github.com/blackwell-systems/agent-lsp) · [LSP for Claude Code: symbol-level search at scale (claudefast)](https://claudefa.st/blog/tools/mcp-extensions/lsp-mcp-server) · [LSP with Claude Code for large codebases (MindStudio)](https://www.mindstudio.ai/blog/language-server-protocol-lsp-claude-code-large-codebases)
