import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkIndex, linkKeyOf } from "../shared/mcp-daemon-links.ts";
import { startDaemon, type DaemonHandle } from "../shared/mcp-daemon-server.ts";
import { writeGlobalSessionIdentityFile, type WriterGeneration } from "../shared/peer-cache.ts";
import { measureWriterGeneration } from "../shared/process-generation.ts";
import { createRoadmapFamily } from "../shared/roadmap-server.ts";
import { ROADMAP_TOOLS } from "../shared/roadmap-tools.ts";
import type { RegisterResponse, RoadmapItem } from "../shared/types.ts";
import { livePid, post, startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { linkTestKey } from "./_mcp-daemon-fake-relay.ts";
import { DaemonRelay, RELAY_CODE_ROOT, type RelayHello } from "./_mcp-daemon-relay.ts";

const IDENTITY_REFUSAL = "Roadmap companion identity is unavailable";
const GENERATION_MEASURABLE = process.platform === "win32" || process.platform === "linux";
const NEEDS_GENERATION = "needs a platform where a process generation can be measured (win32 or linux)";

const PROJECT_ALPHA = "github.com/example/mcp-daemon-roadmap-alpha";
const PROJECT_BETA = "github.com/example/mcp-daemon-roadmap-beta";
const PROJECT_SHARED = "github.com/example/mcp-daemon-roadmap-shared";
const TITLE_ALPHA = "alpha-only card";
const TITLE_BETA = "beta-only card";
const PARENT_GENERATION = "claude-process-generation-1";

interface FrontRequest {
  path: string;
  project_key: unknown;
  by: unknown;
}

interface Front {
  url: string;
  requests: FrontRequest[];
  stop(): void;
}

interface Peer {
  peerId: string;
  token: string;
}

interface Opened {
  relay: DaemonRelay;
  front: Front;
  socket: string;
  projectKey: string;
  peer?: Peer;
}

interface SessionOptions {
  projectKey: string;
  cwd?: string;
  kory?: boolean;
  tools?: string;
  snapshot?: "own" | "none" | { brokerFront: Front };
}

let broker: TestBroker;
let daemon: DaemonHandle;
let keyPath: string;
let home: string;
let ownGeneration: WriterGeneration;
const fronts: Front[] = [];
const relays: DaemonRelay[] = [];
const links = createLinkIndex();
const leaves: Array<() => void> = [];

function startFront(target: string): Front {
  const front: Front = { url: "", requests: [], stop: () => server.stop(true) };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const text = await req.text();
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      front.requests.push({ path, project_key: body.project_key, by: body.by });
      const upstream = await fetch(new URL(path, target), {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: req.method === "GET" ? undefined : text,
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  front.url = `http://127.0.0.1:${server.port}`;
  fronts.push(front);
  return front;
}

async function registerPeer(projectKey: string, cwd: string): Promise<Peer> {
  const res = await post<RegisterResponse>(`${broker.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host: "test-host",
    client_pid: livePid(),
    project_key: projectKey,
    group_id: "default",
    group_secret_hash: null,
  });
  expect(res.status, "the real broker must accept the registration").toBe(200);
  return { peerId: res.body.peer_id, token: res.body.instance_token };
}

async function seedCard(projectKey: string, title: string): Promise<void> {
  const res = await post(`${broker.url}/roadmap/upsert`, { project_key: projectKey, by: "unregistered-fixture", title });
  expect(res.status, `seeding "${title}" on the real broker`).toBe(200);
}

async function cardsOf(projectKey: string): Promise<RoadmapItem[]> {
  const res = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, { project_key: projectKey });
  expect(res.status).toBe(200);
  return res.body.items;
}

async function publishSnapshot(opened: Opened, brokerFront: Front = opened.front): Promise<void> {
  if (!opened.peer) throw new Error("a snapshot needs a registered peer");
  await writeGlobalSessionIdentityFile(
    opened.socket,
    opened.peer.peerId,
    "default",
    opened.peer.token,
    opened.projectKey,
    home,
    ownGeneration,
    new URL(brokerFront.url).toString(),
  );
}

async function openSession(label: string, options: SessionOptions): Promise<Opened> {
  const front = startFront(broker.url);
  const socket = `mcp-daemon-roadmap-${label}-${crypto.randomUUID()}`;
  const cwd = options.cwd ?? `/work/${label}`;
  const env: Record<string, string> = {
    CLAUDE_CODE_MESSAGING_SOCKET: socket,
    CLAUDE_PEERS_PORT: String(new URL(front.url).port),
    XDG_CONFIG_HOME: home,
    APPDATA: home,
    ...(options.kory
      ? { CLAUDE_PEERS_FORCE_GROUP: `kory-run-${crypto.randomUUID()}`, CLAUDE_PEERS_DESK_SESSION: `desk-${label}` }
      : {}),
    ...(options.tools ? { CLAUDE_PEERS_TOOLS: options.tools } : {}),
  };
  const snapshot = options.snapshot ?? "own";
  const opened: Opened = {
    relay: await DaemonRelay.open(daemon.port, keyPath),
    front,
    socket,
    projectKey: options.projectKey,
  };
  relays.push(opened.relay);
  if (snapshot !== "none") {
    opened.peer = await registerPeer(options.projectKey, cwd);
    await publishSnapshot(opened, snapshot === "own" ? front : snapshot.brokerFront);
  }
  const reply = await opened.relay.hello({ cwd, env, ppid_start: PARENT_GENERATION } as Partial<RelayHello> & { env: typeof env });
  expect(reply.kind, `the daemon must serve the roadmap family for ${label}`).toBe("welcome");
  return opened;
}

beforeAll(async () => {
  if (GENERATION_MEASURABLE) {
    const measured = await measureWriterGeneration(process.pid);
    if (!measured) throw new Error("this platform cannot measure a process generation: the snapshots cannot be built");
    ownGeneration = measured;
  }
  broker = await startBroker();
  home = mkdtempSync(join(tmpdir(), "mcp-daemon-roadmap-"));
  keyPath = join(home, "peers", "mcp-daemon.key");
  linkTestKey(home, keyPath);
  daemon = startDaemon({
    port: 0,
    keyPath,
    logDir: join(home, "logs"),
    codeRoot: RELAY_CODE_ROOT,
    families: { roadmap: createRoadmapFamily(links, home) },
  });
  await seedCard(PROJECT_ALPHA, TITLE_ALPHA);
  await seedCard(PROJECT_BETA, TITLE_BETA);
}, 60_000);

afterEach(() => {
  for (const relay of relays.splice(0)) relay.close();
  for (const leave of leaves.splice(0)) leave();
});

afterAll(async () => {
  for (const relay of relays.splice(0)) relay.close();
  await daemon?.stop();
  for (const front of fronts) front.stop();
  if (broker) await stopBroker(broker);
  if (home) rmSync(home, { recursive: true, force: true });
});

test.skipIf(!GENERATION_MEASURABLE)(
  `two sessions of two projects, open together, each list sees only its own project (${NEEDS_GENERATION})`,
  async () => {
    const [alpha, beta] = await Promise.all([
      openSession("alpha", { projectKey: PROJECT_ALPHA }),
      openSession("beta", { projectKey: PROJECT_BETA }),
    ]);

    const firstAlpha = await alpha.relay.callTool("roadmap_list");
    const firstBeta = await beta.relay.callTool("roadmap_list");
    const secondAlpha = await alpha.relay.callTool("roadmap_list");
    const [concurrentBeta, concurrentAlpha] = await Promise.all([
      beta.relay.callTool("roadmap_list"),
      alpha.relay.callTool("roadmap_list"),
    ]);

    for (const reply of [firstAlpha, secondAlpha, concurrentAlpha]) {
      expect(reply.isError, reply.text).toBe(false);
      expect(reply.text, "alpha must see its own card").toContain(TITLE_ALPHA);
      expect(reply.text, "alpha must not see beta's card").not.toContain(TITLE_BETA);
    }
    for (const reply of [firstBeta, concurrentBeta]) {
      expect(reply.isError, reply.text).toBe(false);
      expect(reply.text, "beta must see its own card").toContain(TITLE_BETA);
      expect(reply.text, "beta must not see alpha's card").not.toContain(TITLE_ALPHA);
    }
    expect(
      alpha.front.requests.map((r) => [r.path, r.project_key]),
      "every call of alpha must reach alpha's broker with alpha's project key",
    ).toEqual(Array(3).fill(["/roadmap/list", PROJECT_ALPHA]));
    expect(
      beta.front.requests.map((r) => [r.path, r.project_key]),
      "every call of beta must reach beta's broker with beta's project key",
    ).toEqual(Array(2).fill(["/roadmap/list", PROJECT_BETA]));
  },
  30_000,
);

test.skipIf(!GENERATION_MEASURABLE)(
  `a Kory session and a plain session of one project and one directory each author as their own peer (${NEEDS_GENERATION})`,
  async () => {
    const [kory, plain] = await Promise.all([
      openSession("kory", { projectKey: PROJECT_SHARED, cwd: "/work/shared", kory: true }),
      openSession("plain", { projectKey: PROJECT_SHARED, cwd: "/work/shared" }),
    ]);
    const koryPeer = kory.peer as Peer;
    const plainPeer = plain.peer as Peer;
    expect(koryPeer.peerId, "the two registrations must be two peers").not.toBe(plainPeer.peerId);

    const koryAdd = await kory.relay.callTool("roadmap_add", { title: "added by the kory session" });
    const plainAdd = await plain.relay.callTool("roadmap_add", { title: "added by the plain session" });
    const koryAddAgain = await kory.relay.callTool("roadmap_add", { title: "added again by the kory session" });
    for (const reply of [koryAdd, plainAdd, koryAddAgain]) expect(reply.isError, reply.text).toBe(false);

    const authors = new Map((await cardsOf(PROJECT_SHARED)).map((card) => [card.title, card.created_by]));
    expect(authors.get("added by the kory session"), "the kory card must be authored by the kory peer").toBe(
      koryPeer.peerId.toLowerCase(),
    );
    expect(authors.get("added again by the kory session")).toBe(koryPeer.peerId.toLowerCase());
    expect(authors.get("added by the plain session"), "the plain card must be authored by the plain peer").toBe(
      plainPeer.peerId.toLowerCase(),
    );
    expect(
      kory.front.requests.map((r) => [r.path, String(r.by)]),
      "the kory session must reach only its own broker front, as its own peer",
    ).toEqual(Array(2).fill(["/roadmap/upsert", koryPeer.peerId.toLowerCase()]));
    expect(
      plain.front.requests.map((r) => [r.path, String(r.by)]),
      "the plain session must reach only its own broker front, as its own peer",
    ).toEqual([["/roadmap/upsert", plainPeer.peerId.toLowerCase()]]);
  },
  30_000,
);

test.skipIf(!GENERATION_MEASURABLE)(
  `a session without a snapshot is refused before any broker traffic, and served once the snapshot appears (${NEEDS_GENERATION})`,
  async () => {
    const session = await openSession("nosnap", { projectKey: PROJECT_ALPHA, snapshot: "none" });

    expect(await session.relay.callTool("roadmap_list")).toEqual({ isError: true, text: IDENTITY_REFUSAL });
    expect(await session.relay.callTool("roadmap_add", { title: "must never reach the broker" })).toEqual({
      isError: true,
      text: IDENTITY_REFUSAL,
    });
    expect(session.front.requests, "a refused call must not produce any broker request").toEqual([]);
    expect(
      (await cardsOf(PROJECT_ALPHA)).map((card) => card.title),
      "the refused add must not have landed",
    ).not.toContain("must never reach the broker");

    session.peer = await registerPeer(PROJECT_ALPHA, "/work/nosnap");
    await publishSnapshot(session);
    const served = await session.relay.callTool("roadmap_list");
    expect(served.isError, served.text).toBe(false);
    expect(served.text).toContain(TITLE_ALPHA);
    expect(session.front.requests.map((r) => r.path), "the identity is read at each call, not once at hello").toEqual([
      "/roadmap/list",
    ]);
  },
  30_000,
);

test.skipIf(!GENERATION_MEASURABLE)(
  `a snapshot written for another broker is refused and no broker receives a request (${NEEDS_GENERATION})`,
  async () => {
    const other = startFront(broker.url);
    const session = await openSession("foreign", { projectKey: PROJECT_ALPHA, snapshot: { brokerFront: other } });

    expect(await session.relay.callTool("roadmap_list")).toEqual({ isError: true, text: IDENTITY_REFUSAL });
    expect(session.front.requests, "the session's own broker must not be called").toEqual([]);
    expect(other.requests, "the broker named by the snapshot must not be called either").toEqual([]);
  },
  30_000,
);

function publishLink(opened: Opened, sessionId: string, peer: Peer, ppidStart = PARENT_GENERATION): void {
  const key = linkKeyOf({ env: { CLAUDE_CODE_MESSAGING_SOCKET: opened.socket }, ppid: 100, ppid_start: ppidStart });
  if (!key) throw new Error("the fixture socket must give a link key");
  leaves.push(
    links.register(sessionId, key, () => ({
      peerId: peer.peerId,
      instanceToken: peer.token,
      projectKey: opened.projectKey,
      brokerUrl: new URL(opened.front.url).toString(),
    })),
  );
}

test("a session linked to a registered peers session is served as that peer with no snapshot on disk", async () => {
  const session = await openSession("linked", { projectKey: PROJECT_ALPHA, snapshot: "none" });
  const peer = await registerPeer(PROJECT_ALPHA, "/work/linked");
  publishLink(session, "peers-linked", peer);

  const listed = await session.relay.callTool("roadmap_list");
  const added = await session.relay.callTool("roadmap_add", { title: "added through the link" });

  expect(listed.isError, listed.text).toBe(false);
  expect(listed.text).toContain(TITLE_ALPHA);
  expect(added.isError, added.text).toBe(false);
  expect(session.front.requests.map((r) => [r.path, r.project_key])).toEqual([
    ["/roadmap/list", PROJECT_ALPHA],
    ["/roadmap/upsert", PROJECT_ALPHA],
  ]);
  const authors = new Map((await cardsOf(PROJECT_ALPHA)).map((card) => [card.title, card.created_by]));
  expect(authors.get("added through the link"), "the card must be authored by the linked peer").toBe(peer.peerId.toLowerCase());
}, 30_000);

test("two peers sessions linked to one Claude Code session refuse the call as ambiguous, before any broker traffic", async () => {
  const session = await openSession("twolinks", { projectKey: PROJECT_ALPHA, snapshot: "none" });
  publishLink(session, "peers-one", await registerPeer(PROJECT_ALPHA, "/work/twolinks"));
  publishLink(session, "peers-two", await registerPeer(PROJECT_ALPHA, "/work/twolinks"));

  expect(await session.relay.callTool("roadmap_list")).toEqual({ isError: true, text: "Roadmap companion identity is ambiguous" });
  expect(session.front.requests).toEqual([]);
}, 30_000);

test("a peers session of another parent generation is not linked: the call is refused as unavailable", async () => {
  const session = await openSession("othergen", { projectKey: PROJECT_ALPHA, snapshot: "none" });
  publishLink(session, "peers-stale", await registerPeer(PROJECT_ALPHA, "/work/othergen"), "an-older-claude-process");

  expect(await session.relay.callTool("roadmap_list")).toEqual({ isError: true, text: IDENTITY_REFUSAL });
  expect(session.front.requests).toEqual([]);
}, 30_000);

test("a hello for the peers family is refused with family_unavailable", async () => {
  const relay = await DaemonRelay.open(daemon.port, keyPath);
  relays.push(relay);

  const reply = await relay.hello({ family: "peers", env: {} });

  expect(reply.kind).toBe("refused");
  expect(reply.kind === "refused" ? reply.code : reply.kind, "the daemon serves the roadmap family only").toBe(
    "family_unavailable",
  );
});

test.skipIf(!GENERATION_MEASURABLE)(
  `a poisoned process.env changes neither the broker, nor the identity, nor the tools of any session (${NEEDS_GENERATION})`,
  async () => {
    const poison = {
      CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:1",
      CLAUDE_PEERS_PORT: "1",
      CLAUDE_PEERS_TOOLS: "roadmap_get",
      CLAUDE_CODE_MESSAGING_SOCKET: "ambient-socket-without-snapshot",
    };
    const backup = Object.fromEntries(Object.keys(poison).map((name) => [name, process.env[name]]));
    Object.assign(process.env, poison);
    try {
      const session = await openSession("poisoned", { projectKey: PROJECT_ALPHA });

      expect(await session.relay.toolNames(), "the allowlist comes from the hello env, not from process.env").toEqual(
        ROADMAP_TOOLS.map((tool) => tool.name),
      );
      const listed = await session.relay.callTool("roadmap_list");
      expect(listed.isError, listed.text).toBe(false);
      expect(listed.text).toContain(TITLE_ALPHA);
      expect(
        session.front.requests.map((r) => [r.path, r.project_key]),
        "the call must reach the broker named by the hello env",
      ).toEqual([["/roadmap/list", PROJECT_ALPHA]]);
    } finally {
      for (const [name, value] of Object.entries(backup)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
  30_000,
);

test.skipIf(!GENERATION_MEASURABLE)(
  `a CLAUDE_PEERS_TOOLS allowlist in one hello filters that session only (${NEEDS_GENERATION})`,
  async () => {
    const narrow = await openSession("narrow", { projectKey: PROJECT_ALPHA, tools: "roadmap_list,roadmap_get" });
    const wide = await openSession("wide", { projectKey: PROJECT_BETA });

    expect((await narrow.relay.toolNames()).sort()).toEqual(["roadmap_get", "roadmap_list"]);
    expect(await wide.relay.toolNames(), "the other session keeps the whole surface").toEqual(
      ROADMAP_TOOLS.map((tool) => tool.name),
    );
    const blocked = await narrow.relay.callTool("roadmap_add", { title: "outside the allowlist" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("tool not available");
    expect(narrow.front.requests, "a tool outside the allowlist must not reach the broker").toEqual([]);
  },
  30_000,
);
