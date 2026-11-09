import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../shared/logger.ts";
import { installProcessHandlers } from "../shared/mcp-daemon-lifecycle.ts";
import { startDaemon } from "../shared/mcp-daemon-server.ts";

const [keyPath, logDir, codeRoot] = process.argv.slice(2) as [string, string, string];

const daemon = startDaemon({
  port: 0,
  keyPath,
  logDir,
  codeRoot,
  families: {
    roadmap: () => {
      const server = new Server({ name: "rejecting-family", version: "0" }, { capabilities: { tools: {} } });
      const tools = ["ping", "reject"].map((name) => ({ name, description: name, inputSchema: { type: "object" as const } }));
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === "reject") void Promise.reject(new Error("rejected inside a session"));
        return { content: [{ type: "text", text: request.params.name }] };
      });
      return server;
    },
  },
});

const log: Logger = {
  info() {},
  warn() {},
  error: (message) => console.log(`LOGGED ${message}`),
  child: () => log,
  file: "",
};

installProcessHandlers(process, { stop: (reason) => void daemon.stop().then(() => process.exit(0)), log, now: Date.now });

console.log(`LISTENING ${daemon.port}`);
