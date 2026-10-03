<!-- dgc-policy-v12 (revised 2026-09-18: mandatory dual-graph policy removed after security/cost review) -->
# Dual-Graph Context Policy (optional)

This project has a local dual-graph MCP server available. It is an **optional aid**,
not required. Do not force its use, and never skip normal grep/rg/bash file
exploration to satisfy it — see the user-level CLAUDE.md for the standing policy.

Reasonable use: if `graph_continue`/`graph_read` are already loaded and clearly
point at the right file for a large/unfamiliar area, use them. Otherwise just
use Grep/Glob/Read/Bash as normal. Do not call `count_tokens` before reads,
do not force `context-store.json` writes on every decision, and do not treat
any confidence level as a reason to avoid grep.

## Session End

When the user signals they are done (e.g. "bye", "done", "wrap up", "end session"),
optionally update `CONTEXT.md` in the project root with:
- **Current Task**: one sentence on what was being worked on
- **Key Decisions**: bullet list, max 3 items
- **Next Steps**: bullet list, max 3 items

Keep `CONTEXT.md` under 20 lines total. Do NOT summarize the full conversation —
only what's needed to resume next session.
