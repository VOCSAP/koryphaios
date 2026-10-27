/**
 * Second MCP entrypoint (Card c9269fef), loaded only by supervisor/team-lead
 * tiles. Exposes the five Kory-only tools and imports their
 * definitions/handlers from server.ts rather than redefining them.
 * No shebang: unlike server.ts/broker.ts/cli.ts, the
 * shipped artifact is desktop/deck-plugin/mcp/server-deck.mjs run explicitly
 * via `node <path>` (supervisor.ts), never executed as `./server-deck.ts` --
 * a `#!/usr/bin/env bun` surviving into that bundle would misdirect a direct
 * `chmod +x` invocation to bun instead of the node runtime it was built for.
 * Deliberately not a peer (no /register, no heartbeat, no WebSocket): a
 * second registration for the same tile would collide on the same
 * sessionKey(host, cwd, group_id, desk_session) as server.ts and mint a
 * fantom duplicate peer sharing its role -- no fallback self-registration
 * exists anywhere in this file, by construction, not by discipline.
 * Its `instructions` block carries ONLY what neither the core server's own
 * block nor the five tool descriptions already state, and stays under 400
 * characters: Claude Code concatenates every connected server's
 * instructions into one shared budget and silently truncates whichever
 * connects last, so a sentence written on both sides is paid twice and can
 * cost the core block its tail.
 */

import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, coreLogDir } from "./shared/logger.ts";
import { readSessionIdentityFile } from "./shared/peer-cache.ts";
import {
  DECK_ONLY_TOOLS,
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
// DECK_ONLY_TOOLS (server.ts) is already exactly the five names below; the
// extra name filter is belt-and-suspenders against the two lists drifting.
const DECK_TOOLS = filterTools(DECK_ONLY_TOOLS, TOOLS_ALLOWLIST).filter((t) =>
  (DECK_TOOL_NAMES as readonly string[]).includes(t.name)
);

const mcp = new Server(
  { name: "claude-peers-deck", version: "0.9.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Kory-only tools, provided only to a Koryphaios lead or supervisor tile. A kind='directive' card filed and queued with the core server's roadmap tools is executed here, by roadmap_dispatch.",
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: DECK_TOOLS,
}));

/**
 * Read the sibling server.ts process's identity for THIS tile, at call time
 * rather than at boot: the two MCP processes start concurrently, so a
 * boot-time read would race server.ts's own /register. A missing or
 * unreadable file resolves to a null identity, so a new operator question is
 * refused before its deposit. instanceToken is a credential -- never logged,
 * here or anywhere downstream.
 */
async function resolveCompanionIdentity(): Promise<CompanionIdentity> {
  const host = hostname();
  const token = process.env.CLAUDE_PEERS_DESK_SESSION ?? "";
  if (!token) {
    log(
      "CLAUDE_PEERS_DESK_SESSION is unset -- graph_draft_send, roadmap_dispatch and new ask_operator deposits cannot use a confirmed identity"
    );
  }
  const identity = token ? await readSessionIdentityFile(token) : null;
  if (token && !identity) {
    log(`No usable session-identity file for desk_session '${token}' -- falling back to an unproven identity`);
  }
  return {
    host,
    peerId: identity?.peerId ?? null,
    groupId: identity?.groupId ?? "",
    instanceToken: identity?.instanceToken ?? null,
    inboxBinding: identity?.inboxBinding ?? null,
    operatorId: identity?.operatorId ?? null,
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

/**
 * Not `import.meta.main` -- `bun build --target=node`
 * compiles it to `__require.main == __require.module`, a Bun-runtime-only
 * construct that throws a ReferenceError under plain node (the shipped
 * entrypoint), before main() ever runs. Both sides are realpath'd before
 * comparing: node resolves import.meta.url through a symlinked entry (its
 * default --preserve-symlinks-main is off) while leaving process.argv[1] as
 * invoked, so an uncanonicalized compare can read false for the real entry
 * module -- the same silent-death failure this guard exists to prevent.
 * A missing path (either side) resolves to false, never throws.
 */
function isEntryModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  main().catch((e) => {
    log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

export { DECK_TOOLS, DECK_TOOL_NAMES, mcp };
