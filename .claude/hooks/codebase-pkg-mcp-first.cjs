// Hook: codebase-pkg "MCP-first" nudge.
// Runs on PreToolUse for Read -- ONCE PER SESSION, reminds the agent to try the
// codebase-pkg graph (recallSimilar / searchSemantic) before reading files to
// answer a question, since a similarity hit can answer directly and saves
// tokens versus re-reading source.
//
// Once-per-session gate: a marker file in os.tmpdir() keyed by session_id.
// The FIRST Read in a session creates the marker and emits the reminder;
// every subsequent Read in that same session is a silent no-op exit(0).
//
// Contract (see Claude Code PreToolUse hook docs): read a single JSON object
// from stdin (includes session_id, tool_name, tool_input), optionally print a
// JSON object to stdout with hookSpecificOutput.permissionDecision to allow/
// deny/ask the tool call, plus additionalContext to inject extra guidance.
// Top-level "suppressOutput":true hides that JSON from the user-facing
// transcript -- the model still receives additionalContext via
// hookSpecificOutput, only the raw JSON blob is kept off the user's screen.
// Any parse/IO error degrades to a silent, non-blocking exit(0) -- this hook
// must never block a Read.

const fs = require("fs");
const os = require("os");
const path = require("path");

let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  try {
    let input;
    try {
      input = JSON.parse(data);
    } catch {
      process.exit(0);
    }

    if (!input || typeof input !== "object") {
      process.exit(0);
    }

    const sessionId = typeof input.session_id === "string" && input.session_id
      ? input.session_id
      : "unknown-session";

    const markerPath = path.join(os.tmpdir(), `codebase-pkg-mcpfirst-${sessionId}`);

    if (fs.existsSync(markerPath)) {
      // Already reminded this session -- stay silent.
      process.exit(0);
    }

    // Best-effort marker write. If it fails (e.g. race with a concurrent Read),
    // still emit the reminder this once rather than throwing -- worst case is
    // an extra reminder, never a blocked Read.
    try {
      fs.writeFileSync(markerPath, String(Date.now()), "utf8");
    } catch {
      // ignore
    }

    const additionalContext =
      "Reminder (once per session): before reading files to answer a question, try " +
      "mcp__codebase-pkg__recallSimilar (past sessions/decisions/learnings) and " +
      "mcp__codebase-pkg__searchSemantic (semantic code search) first -- a similarity " +
      "hit can answer directly and saves tokens versus re-reading source. Skip this for " +
      "files you are about to edit; read those directly.";

    process.stdout.write(
      JSON.stringify({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          additionalContext,
        },
      }),
    );
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
