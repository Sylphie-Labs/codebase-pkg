// Hook: codebase-pkg session capture.
// Runs on Stop -- instructs the agent to write this session's durable knowledge
// (the session summary, any directive decisions, any durable learnings) into the
// codebase-pkg knowledge graph via its MCP tools before the session is allowed
// to end.
//
// Loop guard: Claude Code sets stop_hook_active=true on the re-invocation that
// follows a blocking Stop hook, so this only fires ONCE per stop -- it never
// blocks forever.
//
// Contract (see Claude Code Stop hook docs): read a single JSON object from
// stdin, optionally print a JSON object to stdout. Printing
// {"decision":"block","reason":"..."} blocks the stop and feeds "reason" back
// to the agent as its next instruction. "suppressOutput":true hides that JSON
// from the user-facing transcript -- the model still gets "reason" via the
// decision protocol, only the raw JSON blob is kept off the user's screen.
// Any parse/IO error degrades to a silent, non-blocking exit(0) -- this hook
// must never wedge a session.

let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  try {
    let input;
    try {
      input = JSON.parse(data);
    } catch {
      // Malformed stdin -- degrade safely, never block on garbage input.
      process.exit(0);
    }

    if (!input || typeof input !== "object") {
      process.exit(0);
    }

    // Loop guard: this is the re-invocation after our own previous block.
    if (input.stop_hook_active === true) {
      process.exit(0);
    }

    const reason =
      "Before ending this session, record its durable knowledge in the codebase-pkg " +
      "graph so future sessions can recall it instead of re-deriving it:\n\n" +
      "1. Call mcp__codebase-pkg__recordSession ONCE with the session's ORIGINAL user " +
      "query (what was actually asked, verbatim or close to it), a final summary of " +
      "the response/outcome (what was actually done/decided), and caveats[] listing " +
      "any gotchas, limitations, or follow-ups worth flagging to a future session.\n\n" +
      "2. Call mcp__codebase-pkg__recordDecision for EACH directive-style decision the " +
      "user made this session -- i.e. any 'do X instead of Y', 'use A, not B', or " +
      "explicit correction/preference. Pass the decision and its insteadOf " +
      "(what was rejected/replaced), one call per decision. Skip this step if no such " +
      "decision was made.\n\n" +
      "3. Call mcp__codebase-pkg__recordLearning for any durable, non-obvious knowledge " +
      "gained this session that isn't already captured above (a gotcha in the codebase, " +
      "a constraint, a root cause, a convention). Where the learning points at specific " +
      "code, include graphRefs as '<absoluteFilePath>::<name>' entries so it's anchored " +
      "to the graph. Skip this step if nothing durable was learned.\n\n" +
      "Then stop again.";

    process.stdout.write(
      JSON.stringify({ decision: "block", reason, suppressOutput: true }),
    );
    process.exit(0);
  } catch {
    // Never let this hook fail a session close.
    process.exit(0);
  }
});
