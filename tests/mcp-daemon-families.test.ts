import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { BrokerEnsurer } from "../shared/broker-ensure.ts";
import type { Logger } from "../shared/logger.ts";
import type { Hello } from "../shared/mcp-daemon-protocol.ts";
import type { FamilyContext, FamilyHandle } from "../shared/mcp-daemon-server.ts";
import { daemonFamilies } from "../shared/mcp-daemon-families.ts";
import { readPeersSessionSettings, type PeersSession } from "../shared/peers-session.ts";

const IDENTITY_REFUSAL = "Roadmap companion identity is unavailable";
const PROJECT = "github.com/example/daemon-families";

let broker: { url: string; projectKeys: unknown[]; stop(): void };
let home: string;
const clients: Client[] = [];

function startBroker() {
  const projectKeys: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      projectKeys.push(body.project_key);
      return Response.json({ items: [] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, projectKeys, stop: () => server.stop(true) };
}

const log: Logger = { info: () => {}, warn: () => {}, error: () => {}, child: () => log, file: "" };

function ctx(sessionId: string): FamilyContext {
  const brokers: BrokerEnsurer = { ensure: async () => ({ action: "already-running" }) };
  return {
    sessionId,
    log,
    home,
    resume: { kind: "none" },
    issueTicket: () => {},
    brokers,
    settings: readPeersSessionSettings({}, () => {}),
  };
}

function helloOf(socket: string): Hello {
  return {
    proto: 1,
    family: "peers",
    relay_version: "0.1.0",
    code_root: "/code",
    pid: 4242,
    ppid: 100,
    pid_start: "1",
    ppid_start: "claude-generation-1",
    cwd: "/work/a",
    stdin_is_tty: false,
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: socket,
      CLAUDE_PEERS_PORT: String(new URL(broker.url).port),
      XDG_CONFIG_HOME: home,
      APPDATA: home,
    },
    replay: false,
  };
}

function registeredPeers(): Parameters<typeof daemonFamilies>[0] {
  return {
    peers: {
      createSession: () =>
        ({
          server: {},
          ready: Promise.resolve(),
          close: async () => {},
          openChannel: () => {},
          identity: () => ({
            peerId: "linked-peer",
            instanceToken: "linked-token",
            projectKey: PROJECT,
            brokerUrl: new URL(broker.url).toString(),
          }),
        }) as unknown as PeersSession,
    },
  };
}

async function roadmapList(server: Server): Promise<{ isError: boolean; text: string }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "families-test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  const result = (await client.callTool({ name: "roadmap_list", arguments: {} })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "mcp-daemon-families-"));
  broker = startBroker();
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

afterAll(() => {
  broker.stop();
  rmSync(home, { recursive: true, force: true });
});

test("a peers session opened through the families is the identity the roadmap family serves, from the same hello", async () => {
  const families = daemonFamilies(registeredPeers());
  const hello = helloOf("families-socket-linked");
  families.peers(hello, ctx("peers-1"));
  await settle();

  const reply = await roadmapList(families.roadmap({ ...hello, family: "roadmap" }, ctx("roadmap-1")) as Server);

  expect(reply.isError, reply.text).toBe(false);
  expect(broker.projectKeys).toContain(PROJECT);
});

test("once that peers session is closed, the roadmap family of the same hello is refused", async () => {
  const families = daemonFamilies(registeredPeers());
  const hello = helloOf("families-socket-closed");
  const peers = families.peers(hello, ctx("peers-1")) as FamilyHandle;
  await settle();
  await peers.close("bye");
  const before = broker.projectKeys.length;

  const reply = await roadmapList(families.roadmap({ ...hello, family: "roadmap" }, ctx("roadmap-1")) as Server);

  expect(reply).toEqual({ isError: true, text: IDENTITY_REFUSAL });
  expect(broker.projectKeys, "a refused call must not reach the broker").toHaveLength(before);
});
