#!/usr/bin/env bun
/**
 * Second MCP entrypoint (Card c9269fef), loaded only by supervisor/team-lead
 * tiles. Exposes the five Kory-only tools and imports their
 * definitions/handlers from server.ts rather than redefining them.
 * Deliberately not a peer (no /register, no heartbeat, no WebSocket): a
 * second registration for the same tile would collide on the same
 * sessionKey(host, cwd, group_id, desk_session) as server.ts and mint a
 * fantom duplicate peer sharing its role -- no fallback self-registration
 * exists anywhere in this file, by construction, not by discipline.
 * No `instructions` block: Claude Code concatenates every connected
 * server's instructions into one shared budget and silently truncates
 * whichever connects last.
 */

import { hostname } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, coreLogDir } from "./shared/logger.ts";
import { readSessionIdentityFile } from "./shared/peer-cache.ts";
import {
  TOOLS,
  TOOLS_ALLOWLIST,
  filterTools,
  handleGraphDraftPrepare,
  handleAskOperator,
  handleRoadmapDispatch,
  handleGraphDraftSend,
  type CompanionIdentity,
} from "./server.ts";

const fileLog = createLogger({ dir: coreLogDir(), name: "server-deck", mirrorToConsole: false });

function log(msg: string) {
  console.error(`[claude-peers-deck] ${msg}`);
  fileLog.info(msg);
}

const DECK_TOOL_NAMES = [
  "ask_operator",
  "ask_operator_wait",
  "graph_draft_prepare",
  "graph_draft_send",
  "roadmap_dispatch",
] as const;

// Applies CLAUDE_PEERS_TOOLS the same way server.ts's own FILTERED_TOOLS
// does (filterTools(TOOLS, TOOLS_ALLOWLIST)), so a tile configured OUT of a
// tool via SessionDef.peerTools cannot regain it through this second server.
const DECK_TOOLS = filterTools(TOOLS, TOOLS_ALLOWLIST).filter((t) =>
  (DECK_TOOL_NAMES as readonly string[]).includes(t.name)
);

const mcp = new Server(
  { name: "claude-peers-deck", version: "0.9.0" },
  {
    capabilities: { tools: {} },
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: DECK_TOOLS,
}));

/**
 * Read the sibling server.ts process's identity for THIS tile, at call time
 * rather than at boot: the two MCP processes start concurrently, so a
 * boot-time read would race server.ts's own /register. A missing or
 * unreadable file resolves to a null identity, which every companion-eligible
 * handler turns into an explicit refusal (reply_route "pty", or a broker-side
 * "instance_token is required") rather than a silent success or a fallback
 * self-registration. instanceToken is a credential -- never logged, here or
 * anywhere downstream.
 */
async function resolveCompanionIdentity(): Promise<CompanionIdentity> {
  const host = hostname();
  const token = process.env.CLAUDE_PEERS_DESK_SESSION ?? "";
  const identity = token ? await readSessionIdentityFile(token) : null;
  if (token && !identity) {
    log(`No usable session-identity file for desk_session '${token}' -- falling back to an unproven identity`);
  }
  return {
    host,
    peerId: identity?.peerId ?? null,
    groupId: identity?.groupId ?? "",
    instanceToken: identity?.instanceToken ?? null,
    projectKey: "",
    // Same fallback shape as server.ts's own roadmapAuthor(), so the
    // operator inbox never shows an empty sender when identity is unknown.
    fromPeer: identity?.peerId ?? `${host || "unknown"}-unregistered`,
  };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  // Same coverage rule as server.ts's own tools/call guard: hiding a tool
  // from tools/list alone still leaves it callable by name, which would make
  // CLAUDE_PEERS_TOOLS decorative on this second server.
  if (
    (DECK_TOOL_NAMES as readonly string[]).includes(name) &&
    !DECK_TOOLS.some((t) => t.name === name)
  ) {
    return {
      content: [{ type: "text" as const, text: `Error: tool not available: ${name}` }],
      isError: true,
    };
  }
  switch (name) {
    case "graph_draft_prepare":
      return handleGraphDraftPrepare(args);
    case "ask_operator":
    case "ask_operator_wait":
      return handleAskOperator(name, args, await resolveCompanionIdentity());
    case "roadmap_dispatch":
      return handleRoadmapDispatch(await resolveCompanionIdentity());
    case "graph_draft_send":
      return handleGraphDraftSend(args, await resolveCompanionIdentity());
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport(process.stdin, process.stdout);
  await mcp.connect(transport);
  log(`MCP connected, ${DECK_TOOLS.length} tools`);
}

if (import.meta.main) {
  main().catch((e) => {
    log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

export { DECK_TOOLS, mcp };
