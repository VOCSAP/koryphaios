import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { writeGlobalSessionIdentityFile, type WriterGeneration } from "../shared/peer-cache.ts";
import { measureWriterGeneration } from "../shared/process-generation.ts";
import { createRoadmapServer } from "../shared/roadmap-server.ts";
import { ROADMAP_TOOLS } from "../shared/roadmap-tools.ts";

const IDENTITY_REFUSAL = "Roadmap companion identity is unavailable";
const EMPTY_ROADMAP = "The roadmap is empty (for these filters). Use roadmap_add to record features, bugs, debt or ideas.";
const GENERATION_MEASURABLE = process.platform === "win32" || process.platform === "linux";
const NEEDS_GENERATION = "needs a platform where a process generation can be measured (win32 or linux)";

interface Broker {
  url: string;
  port: number;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
}

interface Session {
  label: string;
  socket: string;
  home: string;
  projectKey: string;
  broker: Broker;
  env: Record<string, string>;
}

const stoppers: Array<() => void> = [];
const directories: string[] = [];
const clients: Client[] = [];

function startBroker(): Broker {
  const broker: Broker = { url: "", port: 0, requests: [] };
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      broker.requests.push({ path, body });
      if (path === "/roadmap/list") return Response.json({ items: [] });
      return Response.json({ error: `unexpected route ${path}` }, { status: 404 });
    },
  });
  stoppers.push(() => srv.stop(true));
  broker.port = srv.port as number;
  broker.url = `http://127.0.0.1:${broker.port}`;
  return broker;
}

function newSession(label: string, extraEnv: Record<string, string> = {}): Session {
  const home = mkdtempSync(join(tmpdir(), `cp-roadmap-server-${label}-`));
  directories.push(home);
  const broker = startBroker();
  const socket = `roadmap-server-${label}-${crypto.randomUUID()}`;
  return {
    label,
    socket,
    home,
    projectKey: `github.com/example/${label}`,
    broker,
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: socket,
      CLAUDE_PEERS_PORT: String(broker.port),
      XDG_CONFIG_HOME: home,
      APPDATA: home,
      ...extraEnv,
    },
  };
}

let ownGeneration: WriterGeneration;

async function writeSnapshot(
  session: Session,
  generation: WriterGeneration = ownGeneration,
  brokerUrl = new URL(session.broker.url).toString()
): Promise<void> {
  await writeGlobalSessionIdentityFile(
    session.socket,
    `writer-${session.label}`,
    "writer-group",
    `tok-${crypto.randomUUID()}`,
    session.projectKey,
    session.home,
    generation,
    brokerUrl
  );
}

async function connect(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "roadmap-server-test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function callTool(client: Client, name: string): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: {} })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
}

// The ambient values name a socket without a snapshot, a dead broker and a
// different allowlist: any read of process.env instead of the env argument
// changes what the servers below answer.
const AMBIENT = {
  CLAUDE_CODE_MESSAGING_SOCKET: "ambient-socket-without-snapshot",
  CLAUDE_PEERS_PORT: "1",
  CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:1",
  CLAUDE_PEERS_TOOLS: "roadmap_get",
} as const;
let ambientBackup: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!GENERATION_MEASURABLE) return;
  const measured = await measureWriterGeneration(process.pid);
  if (!measured) throw new Error("this platform cannot measure a process generation: the snapshots cannot be built");
  ownGeneration = measured;
}, 60_000);

beforeEach(() => {
  ambientBackup = {};
  for (const [key, value] of Object.entries(AMBIENT)) {
    ambientBackup[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ambientBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  for (const client of clients) await client.close();
  for (const stop of stoppers) stop();
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!GENERATION_MEASURABLE)(
  `two servers built from two envs each serve their own identity and broker (${NEEDS_GENERATION})`,
  async () => {
    const a = newSession("alpha");
    const b = newSession("beta");
    await writeSnapshot(a);
    await writeSnapshot(b);
    const clientA = await connect(createRoadmapServer({ env: a.env, home: a.home }));
    const clientB = await connect(createRoadmapServer({ env: b.env, home: b.home }));

    expect(await callTool(clientA, "roadmap_list")).toEqual({ isError: false, text: EMPTY_ROADMAP });
    expect(await callTool(clientB, "roadmap_list")).toEqual({ isError: false, text: EMPTY_ROADMAP });
    expect(await callTool(clientA, "roadmap_list")).toEqual({ isError: false, text: EMPTY_ROADMAP });

    expect(
      a.broker.requests.map((r) => [r.path, r.body.project_key]),
      "server A must reach its own broker with its own project key, every time"
    ).toEqual([
      ["/roadmap/list", a.projectKey],
      ["/roadmap/list", a.projectKey],
    ]);
    expect(
      b.broker.requests.map((r) => [r.path, r.body.project_key]),
      "server B must reach its own broker with its own project key"
    ).toEqual([["/roadmap/list", b.projectKey]]);
  },
  60_000
);

test.skipIf(!GENERATION_MEASURABLE)(
  `a missing snapshot is refused before any broker traffic (${NEEDS_GENERATION})`,
  async () => {
    const s = newSession("nosnapshot");
    const client = await connect(createRoadmapServer({ env: s.env, home: s.home }));

    expect(await callTool(client, "roadmap_list")).toEqual({ isError: true, text: IDENTITY_REFUSAL });
    expect(s.broker.requests, "a refused call must not reach the broker").toEqual([]);
  },
  60_000
);

test.skipIf(!GENERATION_MEASURABLE)(
  `a snapshot written by another process generation is refused before any broker traffic (${NEEDS_GENERATION})`,
  async () => {
    const s = newSession("reusedpid");
    const reused: WriterGeneration =
      ownGeneration.platform === "win32"
        ? { ...ownGeneration, creationUtc: "2000-01-01T00:00:00.0000000Z" }
        : { ...ownGeneration, startToken: "1" };
    await writeSnapshot(s, reused);
    const client = await connect(createRoadmapServer({ env: s.env, home: s.home }));

    expect(await callTool(client, "roadmap_list")).toEqual({ isError: true, text: IDENTITY_REFUSAL });
    expect(s.broker.requests, "a stale writer generation must not reach the broker").toEqual([]);
  },
  60_000
);

test.skipIf(!GENERATION_MEASURABLE)(
  `a snapshot naming another broker than the env's is refused before any broker traffic (${NEEDS_GENERATION})`,
  async () => {
    const s = newSession("otherbroker");
    await writeSnapshot(s, ownGeneration, "http://127.0.0.1:2/");
    const client = await connect(createRoadmapServer({ env: s.env, home: s.home }));

    expect(await callTool(client, "roadmap_list")).toEqual({ isError: true, text: IDENTITY_REFUSAL });
    expect(s.broker.requests, "a snapshot for another broker must not reach this one").toEqual([]);
  },
  60_000
);

const INVENTED_GENERATION: WriterGeneration = { platform: "linux", pid: process.pid, startToken: "1", bootId: "invented" };

test.skipIf(GENERATION_MEASURABLE)(
  "a platform that cannot measure a process generation refuses every call before any broker traffic (runs on neither win32 nor linux)",
  async () => {
    const s = newSession("unmeasurable");
    await writeSnapshot(s, INVENTED_GENERATION);
    const client = await connect(createRoadmapServer({ env: s.env, home: s.home }));

    expect(await callTool(client, "roadmap_list")).toEqual({ isError: true, text: IDENTITY_REFUSAL });
    expect(s.broker.requests, "a snapshot whose writer cannot be checked must not reach the broker").toEqual([]);
  },
  60_000
);

test("the tool allowlist comes from the env argument, not from process.env", async () => {
  const restricted = newSession("restricted", { CLAUDE_PEERS_TOOLS: "roadmap_list" });
  const open = newSession("open");
  const restrictedClient = await connect(createRoadmapServer({ env: restricted.env, home: restricted.home }));
  const openClient = await connect(createRoadmapServer({ env: open.env, home: open.home }));

  expect((await restrictedClient.listTools()).tools.map((t) => t.name), "CLAUDE_PEERS_TOOLS of the env argument").toEqual(["roadmap_list"]);
  expect((await openClient.listTools()).tools.length, "an env without CLAUDE_PEERS_TOOLS lists every tool").toBe(ROADMAP_TOOLS.length);
  expect(await callTool(restrictedClient, "roadmap_get")).toEqual({ isError: true, text: "Error: tool not available: roadmap_get" });
  expect(restricted.broker.requests, "a tool outside the allowlist must not reach the broker").toEqual([]);
});
