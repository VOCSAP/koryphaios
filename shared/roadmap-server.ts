import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { brokerHeaders, brokerUrl, canonicalBrokerUrl, loadConfig, type Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import { linkKeyOf, type LinkIndex, type LinkLookup } from "./mcp-daemon-links.ts";
import type { FamilyFactory } from "./mcp-daemon-server.ts";
import { readGlobalSessionIdentityFile } from "./peer-cache.ts";
import { measureWriterGeneration } from "./process-generation.ts";
import { callRoadmapTool, ROADMAP_INSTRUCTIONS } from "./roadmap-mcp.ts";
import { ROADMAP_TOOLS } from "./roadmap-tools.ts";
import { filterTools, resolveToolAllowlist, TOOLS_ENV_VAR } from "./tool-allowlist.ts";

export interface RoadmapServerOptions {
  /** The session's environment: the only source of the allowlist, the messaging socket and the broker config. */
  env: NodeJS.ProcessEnv;
  home?: string;
  /** The daemon's view of the peers session of the same Claude Code session; absent for a stdio server. */
  links?: { lookup(): LinkLookup; log: Logger };
}

async function brokerFetch<T>(config: Config, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${brokerUrl(config)}${path}`, {
    method: "POST",
    headers: brokerHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const payload = await response.text();
  if (!response.ok) throw new Error(`Broker error (${path}): ${response.status} ${payload}`);
  return JSON.parse(payload) as T;
}

/** The roadmap family of the daemon: each session resolves its identity from the peers session of its Claude Code session. */
export function createRoadmapFamily(index: LinkIndex, home?: string): FamilyFactory {
  return (hello, ctx) => {
    const key = linkKeyOf(hello);
    return createRoadmapServer({
      env: hello.env,
      home,
      links: { lookup: () => (key ? index.find(key) : { kind: "none" }), log: ctx.log },
    });
  };
}

/** The kory-roadmap MCP server of one session, not yet connected to a transport. */
export function createRoadmapServer({ env, home, links }: RoadmapServerOptions): Server {
  const filteredTools = filterTools(ROADMAP_TOOLS, resolveToolAllowlist(env[TOOLS_ENV_VAR]));

  const mcp = new Server(
    { name: "kory-roadmap", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: ROADMAP_INSTRUCTIONS },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: filteredTools }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (ROADMAP_TOOLS.some((tool) => tool.name === request.params.name) && !filteredTools.some((tool) => tool.name === request.params.name)) {
      return {
        content: [{ type: "text" as const, text: `Error: tool not available: ${request.params.name}` }],
        isError: true,
      };
    }
    const config = await loadConfig(env);
    const messagingSocket = env.CLAUDE_CODE_MESSAGING_SOCKET;
    const linked = links?.lookup() ?? { kind: "none" as const };
    if (linked.kind === "many") {
      links?.log.error(`Roadmap companion identity is ambiguous: sessions ${linked.sessionIds.join(", ")} share this Claude Code session`);
      return { content: [{ type: "text" as const, text: "Roadmap companion identity is ambiguous" }], isError: true };
    }
    const identity =
      linked.kind === "one"
        ? linked.identity
        : messagingSocket
          ? await readGlobalSessionIdentityFile(messagingSocket, home, {
              verifyWriterGeneration: true,
              measureWriterGeneration,
              requireProjectKey: true,
            })
          : null;
    if (!identity?.projectKey || identity.brokerUrl !== canonicalBrokerUrl(config)) {
      return {
        content: [{ type: "text" as const, text: "Roadmap companion identity is unavailable" }],
        isError: true,
      };
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    return {
      ...(await callRoadmapTool(request.params.name, args, {
        identity: {
          peerId: identity.peerId,
          instanceToken: identity.instanceToken,
          projectKey: identity.projectKey,
        },
        brokerFetch: (path, body) => brokerFetch(config, path, body),
      })),
    };
  });

  return mcp;
}
