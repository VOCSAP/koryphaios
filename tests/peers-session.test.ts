import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { computeGroupId } from "../shared/config.ts";
import { DEPOSIT_CAPABILITY_ENV, hashCapability } from "../shared/context-buffer.ts";
import {
  readGlobalSessionIdentityFile,
  writeGlobalSessionIdentityFile,
  type WriterGeneration,
} from "../shared/peer-cache.ts";
import {
  createPeersSession,
  rememberBounded,
  TOOLS,
  type PeersSession,
  type PeersSessionDeps,
  type PeersSessionInput,
  type PeersSessionSettings,
} from "../shared/peers-session.ts";
import { createRoadmapServer } from "../shared/roadmap-server.ts";
import { reachedWithin } from "./_bounded-await.ts";

// Every session below talks to a fake broker through the injected fetch and
// WebSocket: no port, no child process, so the whole file runs in milliseconds
// plus the git probes the session makes at registration.

const SOCKET = "peers-session-test-socket";
const RELAY_PID = 777;
const CLAUDE_PID = 4242;

/** Every key a /register body carries, at boot and after switch_group. */
const IDENTITY_KEYS = [
  "pid",
  "cwd",
  "git_root",
  "tty",
  "summary",
  "host",
  "client_pid",
  "claude_cli_pid",
  "project_key",
  "group_id",
  "group_secret_hash",
  "role",
  "desk_session",
  "cc_session_id",
  "deposit_capability_hash",
  "context_resume_version",
];

interface BrokerCall {
  path: string;
  body: Record<string, unknown>;
}

interface FakeBroker {
  calls: BrokerCall[];
  gates: Map<string, Promise<void>>;
  fetch: typeof fetch;
}

function fakeBroker(): FakeBroker {
  const calls: BrokerCall[] = [];
  const gates = new Map<string, Promise<void>>();
  let registrations = 0;
  const handler = async (input: unknown, init?: { body?: unknown; signal?: AbortSignal }): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ path, body });
    const gate = gates.get(path);
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    switch (path) {
      case "/register":
        registrations += 1;
        return Response.json({
          peer_id: `peer-${registrations}`,
          instance_token: `token-${registrations}`,
          inbox_binding: null,
          role: body.role ?? null,
        });
      case "/set-id":
        return Response.json({ peer_id: body.new_peer_id, previous: "peer-1" });
      case "/list-peers":
        return Response.json([]);
      case "/peek-messages":
      case "/poll-messages":
        return Response.json({ messages: [] });
      case "/group-stats":
        return Response.json({ groups: [] });
      default:
        return Response.json({ ok: true });
    }
  };
  return { calls, gates, fetch: handler as unknown as typeof fetch };
}

/** Emits "close" synchronously on close(), like a socket that is closed locally. */
class FakeWebSocket {
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  private listeners = new Map<string, Array<() => void>>();
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get("close") ?? []) listener();
  }
}

const SETTINGS: PeersSessionSettings = {
  contextResumeKeyTtlMs: 300_000,
  pollFallbackIntervalMs: 3_600_000,
  heartbeatIntervalMs: 3_600_000,
  disconnectBoundMs: 3_000,
  wsReconnectInitialMs: 5,
};

const GENERATION: WriterGeneration = { platform: "linux", pid: RELAY_PID, startToken: "123456", bootId: "boot" };

interface Harness {
  session: PeersSession;
  client: Client;
  broker: FakeBroker;
  home: string;
  env: Record<string, string>;
  measured: number[];
  errors: string[];
  infos: string[];
}

interface OpenOptions {
  env?: Record<string, string>;
  groups?: Record<string, string>;
  /** More keys for the settings file, merged over `groups`. */
  config?: Record<string, unknown>;
  input?: Partial<PeersSessionInput>;
  deps?: Partial<PeersSessionDeps>;
  /** Runs before the session is created, with the session's home. */
  seed?: (home: string) => Promise<void>;
  /** Do not wait for registration. */
  skipReady?: boolean;
  /** Broker paths that never answer, from the first request. */
  hang?: string[];
}

const opened: Harness[] = [];
const homes: string[] = [];

/** A snapshot left by an earlier process for the same socket. */
async function writeStaleSnapshot(home: string): Promise<void> {
  await writeGlobalSessionIdentityFile(
    SOCKET,
    "stale-peer",
    "stale-group",
    "stale-token",
    "github.com/example/stale",
    home,
    GENERATION,
    "http://127.0.0.1:17999/"
  );
}

async function openSession(options: OpenOptions = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "cp-peers-session-"));
  homes.push(home);
  if (options.groups || options.config) {
    mkdirSync(join(home, "claude-peers"), { recursive: true });
    writeFileSync(
      join(home, "claude-peers", "config.json"),
      JSON.stringify({ ...(options.groups ? { groups: options.groups } : {}), ...options.config })
    );
  }
  await options.seed?.(home);
  const env = {
    XDG_CONFIG_HOME: home,
    APPDATA: home,
    CLAUDE_PEERS_PORT: "17999",
    CLAUDE_PEERS_LOG_DIR: join(home, "logs"),
    ...options.env,
  };
  const broker = fakeBroker();
  for (const path of options.hang ?? []) broker.gates.set(path, new Promise<void>(() => {}));
  const measured: number[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const session = createPeersSession(
    { env, cwd: home, pid: RELAY_PID, ppid: CLAUDE_PID, stdinIsTty: false, ...options.input },
    {
      log: { log: (message) => infos.push(message), logError: (message) => errors.push(message) },
      home,
      hostname: () => "test-host",
      ensureBroker: async () => {},
      measureWriterGeneration: async (pid) => {
        measured.push(pid);
        return { ...GENERATION, pid };
      },
      settings: SETTINGS,
      fetch: broker.fetch,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      ...options.deps,
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "peers-session-test", version: "1.0.0" });
  await client.connect(clientTransport);
  const harness: Harness = { session, client, broker, home, env, measured, errors, infos };
  opened.push(harness);
  if (!options.skipReady) await session.ready;
  return harness;
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

async function call(h: Harness, name: string, args: Record<string, unknown> = {}) {
  return h.client.callTool({ name, arguments: args });
}

async function toolNames(h: Harness): Promise<string[]> {
  return (await h.client.listTools()).tools.map((tool) => tool.name);
}

function callsTo(h: Harness, path: string): BrokerCall[] {
  return h.broker.calls.filter((c) => c.path === path);
}

/** Waits on a condition, not on a duration. */
async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  await reachedWithin(
    (async () => {
      while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
    })(),
    what,
    ms
  );
}

/** Lets already-scheduled continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const POISON = {
  CLAUDE_PEERS_FORCE_GROUP: "poisoned-force-secret",
  CLAUDE_PEERS_GROUP: "poisoned-group",
  CLAUDE_PEERS_TOOLS: "set_summary",
  CLAUDE_PEERS_ROLE: "poisoned-role",
  CLAUDE_PEERS_DESK_SESSION: "poisoned-tile",
  CLAUDE_CODE_MESSAGING_SOCKET: "poisoned-socket",
} as const;
let envBackup: Record<string, string | undefined> = {};

const stoppers: Array<() => void> = [];

beforeEach(() => {
  FakeWebSocket.instances = [];
  envBackup = {};
  for (const [key, value] of Object.entries(POISON)) {
    envBackup[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(async () => {
  for (const h of opened.splice(0)) {
    await h.client.close();
    await reachedWithin(h.session.close("bye"), "closing the session after the test");
  }
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const stop of stoppers.splice(0)) stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("the module", () => {
  test("importing it opens no connection and installs no process handler", async () => {
    // Mutation: a top-level fetch, WebSocket or process.on in the module turns this red.
    const events = ["uncaughtException", "unhandledRejection", "SIGINT", "SIGTERM", "exit", "beforeExit"] as const;
    const before = events.map((event) => process.listenerCount(event));
    const touched: string[] = [];
    const realFetch = globalThis.fetch;
    const RealWebSocket = globalThis.WebSocket;
    globalThis.fetch = (() => {
      touched.push("fetch");
      throw new Error("fetch at import");
    }) as unknown as typeof fetch;
    globalThis.WebSocket = class {
      constructor() {
        touched.push("WebSocket");
        throw new Error("WebSocket at import");
      }
    } as unknown as typeof WebSocket;
    try {
      await import(`../shared/peers-session.ts?fresh=${Date.now()}`);
    } finally {
      globalThis.fetch = realFetch;
      globalThis.WebSocket = RealWebSocket;
    }
    expect(touched).toEqual([]);
    expect(events.map((event) => process.listenerCount(event))).toEqual(before);
  });
});

describe("two sessions in one process", () => {
  const groups = { alpha: "alpha-secret", beta: "beta-secret" };

  test("each takes its group, role and tool list from its own env while process.env is poisoned", async () => {
    // Mutation: reading process.env instead of input.env anywhere in group
    // resolution, the tool allowlist or the register body turns this red.
    const a = await openSession({
      groups,
      env: { CLAUDE_PEERS_GROUP: "alpha", CLAUDE_PEERS_TOOLS: "whoami,list_groups", CLAUDE_PEERS_ROLE: "role-a" },
    });
    const b = await openSession({ groups, env: { CLAUDE_PEERS_GROUP: "beta" } });

    const whoA = JSON.parse(textOf(await call(a, "whoami")));
    const whoB = JSON.parse(textOf(await call(b, "whoami")));
    expect(whoA.group_name).toBe("alpha");
    expect(whoB.group_name).toBe("beta");
    expect(whoA.role).toBe("role-a");
    expect(whoB.role).toBeNull();
    expect(callsTo(a, "/register")[0]?.body.group_id).toBe(computeGroupId("alpha-secret"));
    expect(callsTo(b, "/register")[0]?.body.group_id).toBe(computeGroupId("beta-secret"));

    expect(await toolNames(a)).toEqual(["whoami", "list_groups"]);
    expect(await toolNames(b)).toEqual(TOOLS.map((tool) => tool.name));
  });

  test("closing one leaves the other heartbeating, and the closed one stops", async () => {
    // Mutation: a heartbeat timer that close() does not clear, or a timer kept
    // at module level and cleared for every session, turns this red.
    const settings = { ...SETTINGS, heartbeatIntervalMs: 20 };
    const a = await openSession({ groups, env: { CLAUDE_PEERS_GROUP: "alpha" }, deps: { settings } });
    const b = await openSession({ groups, env: { CLAUDE_PEERS_GROUP: "beta" }, deps: { settings } });
    await until(() => callsTo(a, "/heartbeat").length >= 1 && callsTo(b, "/heartbeat").length >= 1, "first heartbeats");

    await a.session.close("bye");
    const aAtClose = callsTo(a, "/heartbeat").length;
    const bAtClose = callsTo(b, "/heartbeat").length;
    await until(() => callsTo(b, "/heartbeat").length >= bAtClose + 3, "heartbeats of the open session");

    expect(callsTo(a, "/heartbeat").length, "the closed session kept heartbeating").toBe(aAtClose);
  });
});

describe("registration", () => {
  test("the boot and switch_group /register bodies carry every identity key, filled from the session env and pids", async () => {
    // Mutation: one site builds its body by hand, or any key (cc_session_id,
    // claude_cli_pid, ...) is dropped from the shared builder, or pid is process.pid.
    // A blank but defined desk session keeps the Inbox credential out of this test.
    const capability = randomBytes(32).toString("hex");
    const h = await openSession({
      groups: { alpha: "alpha-secret", beta: "beta-secret" },
      env: {
        CLAUDE_PEERS_GROUP: "alpha",
        CLAUDE_PEERS_ROLE: "role-x",
        CLAUDE_PEERS_DESK_SESSION: " ",
        CLAUDE_CODE_SESSION_ID: "cc-session-1",
        [DEPOSIT_CAPABILITY_ENV]: capability,
      },
    });
    expect(isError(await call(h, "switch_group", { name: "beta" }))).toBe(false);

    const bodies = callsTo(h, "/register").map((c) => c.body);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual([...IDENTITY_KEYS].sort());
      expect(body).toMatchObject({
        pid: RELAY_PID,
        client_pid: RELAY_PID,
        claude_cli_pid: CLAUDE_PID,
        role: "role-x",
        desk_session: " ",
        cc_session_id: "cc-session-1",
        deposit_capability_hash: hashCapability(capability),
      });
    }
    expect(RELAY_PID).not.toBe(process.pid);
  });

  test("the writer generation is measured on the relay pid, not on the host process", async () => {
    // Mutation: measuring process.pid.
    const h = await openSession({ env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET } });
    expect(h.measured).toEqual([RELAY_PID]);
  });

  test("a failed registration rejects ready and every tool call answers the cause", async () => {
    // Mutation: swallowing the ensureBroker error, or letting tools run unregistered.
    const h = await openSession({
      skipReady: true,
      deps: {
        ensureBroker: async () => {
          throw new Error("broker is down");
        },
      },
    });
    await expect(h.session.ready).rejects.toThrow("broker is down");
    const result = await call(h, "whoami");
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("broker is down");
  });
});

describe("the global snapshot the roadmap companion reads", () => {
  function failingWriter(state: { failing: boolean }): typeof writeGlobalSessionIdentityFile {
    return async (...args) => {
      if (state.failing) throw new Error("disk full");
      return writeGlobalSessionIdentityFile(...args);
    };
  }

  test("a registration whose snapshot cannot be written leaves no snapshot, so the companion refuses", async () => {
    // Mutation: not deleting the previous snapshot before writing the new one.
    const state = { failing: true };
    const h = await openSession({
      env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
      seed: writeStaleSnapshot,
      deps: { writeGlobalSessionIdentityFile: failingWriter(state) },
    });

    expect(await readGlobalSessionIdentityFile(SOCKET, h.home), "the stale snapshot survived").toBeNull();
    expect(h.errors).toContain("Could not write the global roadmap companion identity");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createRoadmapServer({ env: h.env, home: h.home }).connect(serverTransport);
    const companion = new Client({ name: "companion", version: "1.0.0" });
    await companion.connect(clientTransport);
    try {
      const result = await companion.callTool({ name: "roadmap_list", arguments: {} });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain("Roadmap companion identity is unavailable");
    } finally {
      await companion.close();
    }
  });

  test("the same registration publishes the snapshot when the write works", async () => {
    const h = await openSession({ env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET }, seed: writeStaleSnapshot });
    expect(await readGlobalSessionIdentityFile(SOCKET, h.home)).toMatchObject({
      peerId: "peer-1",
      instanceToken: "token-1",
    });
  });

  test("a set_id whose snapshot cannot be written leaves no snapshot, so the companion refuses", async () => {
    // Mutation: not deleting the previous snapshot before the new write.
    const state = { failing: false };
    const h = await openSession({
      env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
      deps: { writeGlobalSessionIdentityFile: failingWriter(state) },
    });
    expect((await readGlobalSessionIdentityFile(SOCKET, h.home))?.peerId, "control: the registration published").toBe("peer-1");

    state.failing = true;
    const renamed = await call(h, "set_id", { new_id: "renamed-peer" });

    expect(isError(renamed)).toBe(false);
    expect(await readGlobalSessionIdentityFile(SOCKET, h.home), "the old identity stayed published").toBeNull();
    expect(h.errors).toContain("Could not write the global roadmap companion identity");
  });
});

// The per-tile identity file needs a signed run credential and a real broker to
// be written at all; its removal on close is proved by server-cleanup-identity.
describe("close", () => {
  async function openPublished(): Promise<Harness> {
    const h = await openSession({ env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET } });
    expect((await readGlobalSessionIdentityFile(SOCKET, h.home))?.peerId, "control: the snapshot is written").toBe("peer-1");
    return h;
  }

  test("bye disconnects the peer once and removes the snapshot", async () => {
    // Mutation: dropping the /disconnect, calling it twice, or leaving the snapshot behind.
    const h = await openPublished();
    await h.session.close("bye");
    await h.session.close("bye");

    expect(callsTo(h, "/disconnect")).toEqual([{ path: "/disconnect", body: { instance_token: "token-1" } }]);
    expect(await readGlobalSessionIdentityFile(SOCKET, h.home)).toBeNull();
  });

  test("daemon_stop removes the snapshot but never disconnects the peer", async () => {
    // Mutation: ignoring the reason.
    const h = await openPublished();
    await h.session.close("daemon_stop");

    expect(callsTo(h, "/disconnect")).toEqual([]);
    expect(await readGlobalSessionIdentityFile(SOCKET, h.home)).toBeNull();
  });

  test("a wait_for_message in flight ends as cancelled instead of outliving the session", async () => {
    // Mutation: the session abort signal not reaching the wait.
    const h = await openSession();
    const waiting = call(h, "wait_for_message", { timeout_sec: 60 });
    await until(() => callsTo(h, "/peek-messages").length >= 1, "the wait's own peek");
    await flush();

    await h.session.close("bye");

    const result = await reachedWithin(waiting, "wait_for_message after close");
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toBe("wait_for_message cancelled.");
  });
});

describe("bounds and ordering", () => {
  test("at most 8 wait_for_message calls wait at once", async () => {
    // Mutation: removing the bound.
    const h = await openSession();
    const waiting: Array<Promise<unknown>> = [];
    for (let i = 1; i <= 8; i++) {
      waiting.push(call(h, "wait_for_message", { timeout_sec: 60 }));
      await until(() => callsTo(h, "/peek-messages").length >= i, `peek of wait ${i}`);
      await flush();
    }

    const ninth = await reachedWithin(call(h, "wait_for_message", { timeout_sec: 60 }), "the ninth wait");
    expect(isError(ninth)).toBe(true);
    expect(textOf(ninth)).toContain("max 8");

    await h.session.close("bye");
    await reachedWithin(Promise.all(waiting), "the eight waits after close");
  });

  test("a full id set drops its smallest id and keeps the newest", () => {
    // Mutation: dropping the newest id, or never dropping.
    const ids = new Set<number>();
    for (let id = 1; id <= 6; id++) rememberBounded(ids, id, 4);
    expect([...ids].sort((x, y) => x - y)).toEqual([3, 4, 5, 6]);
  });

  test("switch_group and set_id never overlap: set_id waits for the switch to finish", async () => {
    // Mutation: running the two without the identity chain.
    const h = await openSession({ groups: { alpha: "alpha-secret", beta: "beta-secret" }, env: { CLAUDE_PEERS_GROUP: "alpha" } });
    let release!: () => void;
    h.broker.gates.set("/disconnect", new Promise<void>((resolve) => (release = resolve)));

    const switching = call(h, "switch_group", { name: "beta" });
    let renaming: Promise<unknown> = Promise.resolve();
    try {
      await until(() => callsTo(h, "/disconnect").length === 1, "the switch's /disconnect");
      renaming = call(h, "set_id", { new_id: "renamed-peer" });
      await flush();
      expect(callsTo(h, "/set-id"), "set_id reached the broker while the switch was in flight").toEqual([]);
    } finally {
      release();
    }
    await reachedWithin(Promise.all([switching, renaming]), "both calls");
    const paths = h.broker.calls.map((c) => c.path);
    expect(paths.indexOf("/set-id")).toBeGreaterThan(paths.lastIndexOf("/register"));
  });
});

describe("closing a session that still has work in flight", () => {
  test("a closed session opens no new WebSocket, even when the closed socket reports its close", async () => {
    // Mutation: the "close" listener or connectWs not testing `closed`.
    const h = await openSession();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await h.session.close("bye");
    await new Promise((resolve) => setTimeout(resolve, SETTINGS.wsReconnectInitialMs * 10));

    expect(FakeWebSocket.instances, "a closed session reconnected").toHaveLength(1);
  });

  test("a close during registration waits for it, leaves no snapshot and disconnects the registered instance", async () => {
    // Mutation: dropping both the closed check after the generation measure and the wait on the identity chain.
    let measuring = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = await openSession({
      skipReady: true,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
      deps: {
        measureWriterGeneration: async (pid) => {
          measuring = true;
          await gate;
          return { ...GENERATION, pid };
        },
      },
    });
    await until(() => measuring, "the generation measure");

    const closing = h.session.close("bye");
    release();
    await reachedWithin(closing, "close during registration");
    await reachedWithin(h.session.ready, "ready after close");

    expect(await readGlobalSessionIdentityFile(SOCKET, h.home), "a snapshot was written after the close").toBeNull();
    expect(callsTo(h, "/disconnect").map((c) => c.body.instance_token)).toEqual(["token-1"]);
  });

  test("a /register that never answers does not hold the close: it settles and removes the stale snapshot", async () => {
    // Mutation: the /register of the boot without the session abort signal.
    const h = await openSession({
      skipReady: true,
      hang: ["/register"],
      env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
      seed: writeStaleSnapshot,
    });
    await until(() => callsTo(h, "/register").length === 1, "the boot /register");
    expect(await readGlobalSessionIdentityFile(SOCKET, h.home), "control: the stale snapshot is on disk").not.toBeNull();

    await reachedWithin(h.session.close("bye"), "close while /register hangs");

    expect(await readGlobalSessionIdentityFile(SOCKET, h.home)).toBeNull();
    expect(h.errors.some((message) => message.startsWith("An identity operation did not settle"))).toBe(false);
  });

  test("a switch_group whose /register never answers is cancelled by the close, which settles and removes the snapshot", async () => {
    // Mutation: the /register of switch_group without the session abort signal.
    const h = await openSession({
      groups: { alpha: "alpha-secret", beta: "beta-secret" },
      env: { CLAUDE_PEERS_GROUP: "alpha", CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
    });
    h.broker.gates.set("/register", new Promise<void>(() => {}));
    const switching = call(h, "switch_group", { name: "beta" });
    await until(() => callsTo(h, "/register").length === 2, "the switch's /register");

    await reachedWithin(h.session.close("bye"), "close while the switch's /register hangs");

    expect(isError(await reachedWithin(switching, "the switch_group call"))).toBe(true);
    expect(await readGlobalSessionIdentityFile(SOCKET, h.home)).toBeNull();
    expect(h.errors.some((message) => message.startsWith("An identity operation did not settle"))).toBe(false);
  });

  test("a switch_group whose /disconnect never answers is cancelled by the close", async () => {
    // Mutation: the /disconnect of switch_group without the session abort signal.
    const h = await openSession({
      groups: { alpha: "alpha-secret", beta: "beta-secret" },
      env: { CLAUDE_PEERS_GROUP: "alpha" },
      deps: { settings: { ...SETTINGS, disconnectBoundMs: 30 } },
    });
    h.broker.gates.set("/disconnect", new Promise<void>(() => {}));
    const switching = call(h, "switch_group", { name: "beta" });
    await until(() => callsTo(h, "/disconnect").length === 1, "the switch's /disconnect");

    await reachedWithin(h.session.close("bye"), "close while the switch's /disconnect hangs");

    expect(isError(await reachedWithin(switching, "the switch_group call"))).toBe(true);
    expect(h.errors.some((message) => message.startsWith("An identity operation did not settle"))).toBe(false);
  });

  test("a set_id whose /set-id never answers is cancelled by the close", async () => {
    // Mutation: the /set-id call without the session abort signal.
    const h = await openSession();
    h.broker.gates.set("/set-id", new Promise<void>(() => {}));
    const renaming = call(h, "set_id", { new_id: "renamed-peer" });
    await until(() => callsTo(h, "/set-id").length === 1, "the /set-id call");

    await reachedWithin(h.session.close("bye"), "close while /set-id hangs");

    expect(isError(await reachedWithin(renaming, "the set_id call"))).toBe(true);
  });

  test("an operation that escapes the abort signal holds the close only for the bound, and the deletions still run", async () => {
    // Mutation: waiting for the identity chain without a bound.
    let measuring = false;
    const h = await openSession({
      skipReady: true,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
      seed: writeStaleSnapshot,
      deps: {
        settings: { ...SETTINGS, disconnectBoundMs: 30 },
        measureWriterGeneration: async () => {
          measuring = true;
          return new Promise<never>(() => {});
        },
      },
    });
    await until(() => measuring, "the generation measure");

    await reachedWithin(h.session.close("bye"), "close while the measure hangs");

    expect(h.errors.some((message) => message.startsWith("An identity operation did not settle"))).toBe(true);
    expect(await readGlobalSessionIdentityFile(SOCKET, h.home)).toBeNull();
    expect(callsTo(h, "/disconnect").map((c) => c.body.instance_token)).toEqual(["token-1"]);
  });

  test("close resolves when the broker never answers /disconnect", async () => {
    // Mutation: an unbounded /disconnect.
    const h = await openSession({ deps: { settings: { ...SETTINGS, disconnectBoundMs: 30 } } });
    h.broker.gates.set("/disconnect", new Promise<void>(() => {}));

    await reachedWithin(h.session.close("bye"), "close against a silent broker");

    expect(h.errors.some((message) => message.startsWith("Disconnect failed or timed out"))).toBe(true);
  });

  test("a tool call on a closed session is refused", async () => {
    // Mutation: dropping the closed guard of tools/call.
    const h = await openSession();
    await h.session.close("bye");

    const result = await call(h, "whoami");

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toBe("This claude-peers session is closed");
  });

  describe("the background summary upgrade", () => {
    async function openWithSummaryProvider(): Promise<{ h: Harness; answer: () => void; asked: () => boolean }> {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let requested = false;
      const provider = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch() {
          requested = true;
          await gate;
          return Response.json({ choices: [{ message: { content: "an upgraded summary" } }] });
        },
      });
      stoppers.push(() => provider.stop(true));
      const h = await openSession({
        config: {
          summary_provider: "openai-compat",
          summary_base_url: `http://127.0.0.1:${provider.port}/v1`,
          summary_api_key: "key",
        },
      });
      await until(() => requested, "the summary request");
      return { h, answer: release, asked: () => requested };
    }

    test("is sent to the broker while the session is open", async () => {
      const { h, answer } = await openWithSummaryProvider();
      answer();
      await until(() => callsTo(h, "/set-summary").length === 1, "the summary upgrade");
      expect(callsTo(h, "/set-summary")[0]?.body.summary).toBe("an upgraded summary");
    });

    test("is dropped when the session closed before the provider answered", async () => {
      // Mutation: sending the upgrade without testing `closed`.
      const { h, answer } = await openWithSummaryProvider();
      await h.session.close("bye");
      answer();
      await until(() => h.infos.some((message) => message.startsWith("Summary provider:")), "the provider answer");
      await flush();

      expect(callsTo(h, "/set-summary")).toEqual([]);
    });
  });
});
