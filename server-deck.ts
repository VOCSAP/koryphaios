// This companion reuses the sibling tile identity and never registers a second peer.

import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, coreLogDir } from "./shared/logger.ts";
import { readSessionIdentityFile } from "./shared/peer-cache.ts";
import { OPERATOR_CEILING_ENV, OPERATOR_TOOLS, resolveMountCeiling } from "./shared/mount-ceiling.ts";
import {
  DECK_ONLY_TOOLS,
  TOOLS_ALLOWLIST,
  handleGraphDraftPrepare,
  handleAskOperator,
  handleNotifyOperator,
  handleGraphDraftSend,
  type CompanionIdentity,
} from "./server.ts";

const fileLog = createLogger({ dir: coreLogDir(), name: "server-deck", mirrorToConsole: false });

function log(msg: string) {
  console.error(`[kory-operator] ${msg}`);
  fileLog.info(msg);
}

const DECK_TOOL_NAMES = OPERATOR_TOOLS;
const CEILING = resolveMountCeiling(OPERATOR_CEILING_ENV, process.env[OPERATOR_CEILING_ENV], DECK_TOOL_NAMES);
if (!CEILING.ok) log(`mount refused, no tool served: ${CEILING.reason}`);
const DECK_TOOLS = DECK_ONLY_TOOLS.filter((tool) => {
  if (!CEILING.ok || !CEILING.value.includes(tool.name)) return false;
  if (tool.name === "notify_operator") {
    return TOOLS_ALLOWLIST === null || TOOLS_ALLOWLIST.includes("send_message");
  }
  return TOOLS_ALLOWLIST === null || TOOLS_ALLOWLIST.includes(tool.name);
});

const mcp = new Server(
  { name: "kory-operator", version: "0.9.0" },
  {
    capabilities: { tools: {} },
    instructions: CEILING.ok
      ? "Kory operator tools for a lead or supervisor tile. Use ask_operator for blocking questions and notify_operator for one-way signed notices."
      : "No operator tool is served: the mount ceiling is missing or invalid.",
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
      "CLAUDE_PEERS_DESK_SESSION is unset -- graph_draft_send and new ask_operator deposits cannot use a confirmed identity"
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
  if (!DECK_TOOLS.some((t) => t.name === name)) {
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
    case "notify_operator":
      return handleNotifyOperator(args, await resolveCompanionIdentity());
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
