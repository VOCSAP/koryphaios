---
paths:
  - "server.ts"
  - "server-deck.ts"
  - "desktop/mcp/**"
  - "tests/*mcp*"
---

# MCP tool surface

Adding a tool: `add-broker-feature` skill, step 4.

- Removing or renaming a tool sweeps the `instructions` string as well as the `TOOLS` array and the call switch, and the absence test asserts on both `tools/list` and `instructions`.
  Why: a removed tool still named in `instructions` is read by every session on every turn and answers `Unknown tool`.
- A new tool argument gets two tests: one on behaviour, one asserting its `inputSchema` entry over `tools/list`.
  Why: the MCP SDK forwards undeclared arguments, so the behaviour test stays green while no agent can learn the argument exists.
- Enforce a constraint on a tool argument in the receiving code (`validateEntry` or the dispatch in `desktop/src/main/deck-control.ts`, as `EFFORT_LEVELS` does), never by a schema `enum` alone.
  Why: `tools/call` forwards arguments verbatim; the schema is documentation for the calling model.
- Keep in a tool description or `instructions` only what changes how the tool is called; the reason goes in a code comment. When `tests/peer-mcp-surface-budget.test.ts` or `tests/deck-mcp-surface-budget.test.ts` fails, move text out, never raise the ceiling.
  Why: that text is re-sent on every turn of every session; comments are not.
- The team-lead kory-deck ceiling is 11,000 characters, equal to the supervisor ceiling, because both receive the same twenty deck tools.
  Why: the role changes authority checks in the Deck main process, not the served deck surface.
- A new `roadmap_*` tool gets its entry in `ROADMAP_TOOL_ACK_DOMAINS` (`tests/mcp-roadmap-ack.test.ts`); `null` only when its ack is not a `RoadmapItem` field pick-list.
  Why: the file goes red for an unlisted tool.
