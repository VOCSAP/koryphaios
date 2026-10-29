#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { brokerHeaders, brokerUrl, canonicalBrokerUrl, loadConfig, type Config } from "./shared/config.ts";
import { readGlobalSessionIdentityFile } from "./shared/peer-cache.ts";
import { measureWriterGeneration } from "./shared/process-generation.ts";
import { callRoadmapTool, ROADMAP_INSTRUCTIONS } from "./shared/roadmap-mcp.ts";
import { ROADMAP_TOOLS } from "./shared/roadmap-tools.ts";
import { filterTools, resolveToolAllowlist, TOOLS_ENV_VAR } from "./shared/tool-allowlist.ts";

const TOOLS_ALLOWLIST = resolveToolAllowlist(process.env[TOOLS_ENV_VAR]);
const FILTERED_TOOLS = filterTools(ROADMAP_TOOLS, TOOLS_ALLOWLIST);

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

const mcp = new Server(
  { name: "kory-roadmap", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: ROADMAP_INSTRUCTIONS },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FILTERED_TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (ROADMAP_TOOLS.some((tool) => tool.name === request.params.name) && !FILTERED_TOOLS.some((tool) => tool.name === request.params.name)) {
    return {
      content: [{ type: "text" as const, text: `Error: tool not available: ${request.params.name}` }],
      isError: true,
    };
  }
  const config = await loadConfig();
  const messagingSocket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const identity = messagingSocket
    ? await readGlobalSessionIdentityFile(messagingSocket, undefined, {
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
  return callRoadmapTool(request.params.name, args, {
    identity: {
      peerId: identity.peerId,
      instanceToken: identity.instanceToken,
      projectKey: identity.projectKey,
    },
    brokerFetch: (path, body) => brokerFetch(config, path, body),
  });
});

await mcp.connect(new StdioServerTransport());
