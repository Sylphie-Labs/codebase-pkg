# MCP server — improvement suggestions

Written 2026-08-06 by a Claude Code session working in the wombat repo, after
using the server end-to-end (record → recall → audit the recall quality). Each
suggestion is grounded in a friction point actually hit, not speculation.
Ordered roughly by value-for-effort.

## 1. Learnings need an amend/supersede path

`agent_decisions` has `status` / `supersededBy`; `agent_learnings` has nothing.
A learning recorded with weak `graphRefs` (or one that later turns out to be
partially wrong) can only be "fixed" by writing a second, near-duplicate
learning — which pollutes recall rankings with two overlapping hits forever.
This was hit directly: learning #9 was anchored to the config declaration
instead of the registration site a debugger would actually land on, and the
correct move was to leave it wrong.

Suggestion: either an `amendLearning(id, {content?, graphRefs?})` tool, or a
`supersedes: id` param on `recordLearning` that flips the old row to a
non-default status excluded from recall (mirroring the decision model).

## 2. Secret scanning on all `record*` free text

Nothing filters `query` / `summary` / `caveats` / `content` / `context`. A
local Postgres DSN with its password is now embedded verbatim in a recorded
event — tolerable for a dev credential, but the same path would happily
persist an API key or pairing token, and recall then replays it into future
model contexts indefinitely.

Suggestion: run a cheap pattern pass at record time (key-shaped strings like
`sk-…`, `AKIA…`, `GOCSPX-…`, `password@` inside URLs, JWT shapes). Options in
increasing strictness: warn in the tool result, redact in place
(`postgresql://user:****@host`), or refuse like `SettingsStore` refuses
`SecretStr` fields. Redact-with-notice is probably the right default.

## 3. Near-duplicate detection at record time

The embedding needed for the insert already exists at write time; comparing it
against existing rows is nearly free. If the new item's similarity to an
existing one exceeds a threshold (~0.85), return the existing row in the tool
result — "this looks like learning #N, consider amending instead" — rather
than silently inserting. This is the other half of #1: today the agent can
neither detect nor repair duplication.

## 4. Validate `graphRefs` at record time

`graphRefs` are free strings in `<absoluteFilePath>::<name>` form; nothing
checks they resolve to real Neo4j nodes. A typo'd ref fails silently and the
anchoring value is lost with no signal. Suggestion: look refs up on write and
report per-ref resolution in the result (`2/3 refs resolved; unresolved:
…::RemoteASRSourc`). Warn, don't refuse — a ref can legitimately point at
code committed later the same session. A periodic `verify-refs` sweep (like
`conformity-backfill`) could re-check old rows after renames.

## 5. Caveats go stale with no resolution mechanism

Events carry caveats like "Jim owes a runtime restart" or "firewall rule not
yet created". Once the restart happens, the caveat is *misleading* on every
future recall — and event rows are immutable. Over months this accumulates
into a recall surface that asserts stale obligations with high confidence.

Suggestion: a `resolveCaveat(eventId, caveatIndex, note?)` tool that marks the
caveat resolved (rendered as `[resolved 2026-08-07: …]` rather than deleted,
keeping the history honest). Even a session-level `annotate(eventId, note)`
would cover most of this.

## 6. Recall ranking: pure cosine similarity surfaces red herrings

Observed directly: for the failure-mode query "POST /v1/voice returns nothing
— phone audio never transcribed", the top hit was a *TTS output* incident
(Fish key 401) — shared vocabulary ("voice", "fish", "audio", "not working"),
wrong subsystem — while the learning containing the actual diagnostic ranked
fourth. Pure embedding similarity rewards vocabulary overlap over topical
precision.

Suggestions, independently useful:
- **Hybrid scoring**: blend vector similarity with lexical (BM25/pg_trgm)
  match so exact identifiers (`/v1/voice`, `wombat_remote_voice`) get the
  weight they deserve. Identifiers are the highest-precision signal in a
  codebase context and embeddings dilute them.
- **graphRef-scoped recall**: an optional `nearRefs: string[]` param that
  boosts (or filters to) items whose `graphRefs` touch the caller's area of
  interest, using the Neo4j neighborhood the server already has.
- **Mild recency weighting** within near-tied similarity bands, so the newest
  instance of a recurring class (e.g. the env-shadow bug family) wins ties.

## 7. Output size control on `recallSimilar`

Default is k=5 *per kind* (up to 15 items), each rendered in full — a single
call can return several thousand tokens, mostly re-reading summaries the
caller doesn't need. Suggestion: a `compact` mode returning one line per hit
(kind, id, similarity, first ~120 chars), plus a `getRecallItem(kind, id)`
fetch for the one or two hits worth expanding. The current full render can
stay the default for backward compatibility, but the hint text should steer
agents to compact-first.

## 8. One conversation should map to one session event

The Stop-hook capture protocol fires on every stop, and each firing creates a
*new* event row: this conversation produced events #10 and #11 for what is one
session with two segments. Recall then returns overlapping partial narratives
of the same conversation. Suggestion: make `recordSession` upsert when called
again with the same `sessionId` (append to summary/caveats, bump timestamp)
instead of inserting a sibling row. The hook already knows the session id; the
tool just doesn't use it as a key.

## 9. Render `sessionId` and support recall-by-session

Rows carry `sessionId` but the recall rendering omits it, so a future session
seeing a promising event hit cannot pull the sibling learnings/decisions
recorded alongside it. Two small changes: include `session=<id>` in the
rendered header, and accept `sessionId` as a `recallSimilar` filter (or add a
trivial `getSession(sessionId)` that returns everything recorded under it).
This turns isolated hits into recoverable narratives.

## 10. Structured output option

Every tool returns preformatted text. That is right for direct model
consumption, but hooks and scripts (e.g. the wombat-memory pipeline, or a
future dashboard) end up regex-parsing it. A `format: "json"` input param on
the read-side tools (`recallSimilar`, `searchSemantic`, `getModuleContext`)
would cost little and make the server composable beyond the chat loop.

---

Smallest high-value slice if only three land: **#2 (secret redaction)**,
**#6 hybrid scoring**, and **#1/#3 together** (amend + dedup — they solve the
same append-only pollution problem from both ends).
