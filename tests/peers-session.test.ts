import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { canonicalBrokerUrl, computeGroupId } from "../shared/config.ts";
import type { FamilyTicketClaims, ResumeOutcome } from "../shared/mcp-daemon-server.ts";
import type { TicketClaims } from "../shared/mcp-daemon-protocol.ts";
import { resolveProjectKey } from "../shared/project-key.ts";
import { canonicalWriterGeneration } from "../shared/relay-liveness.ts";
import { DEPOSIT_CAPABILITY_ENV, hashCapability } from "../shared/context-buffer.ts";
import {
  readGlobalSessionIdentityFile,
  readSessionIdentityFile,
  writeGlobalSessionIdentityFile,
  writeSessionIdentityFile,
  type WriterGeneration,
} from "../shared/peer-cache.ts";
import { generateCredential, INBOX_GATES, verifyInboxProof, type ApprovalAuthProof } from "../shared/approval.ts";
import type { CompanionIdentity } from "../shared/roadmap-dispatch.ts";
import {
  createPeersSession,
  handleGraphDraftPrepare,
  handleInboxClose,
  handleInboxList,
  rememberBounded,
  sendRegister,
  TOOLS,
  type OperatorToolContext,
  type RegisterAttempt,
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
  /** The next `times` requests to `path` fail: without any answer ("network") or with a 500 ("http"). */
  failures: Map<string, { times: number; kind: "network" | "http" }>;
  /** The /health body. */
  health: Record<string, unknown>;
  /** The token the broker agrees to resume, with the peer it belongs to. */
  resumable: { token: string; peer: string } | null;
  /** What /peek-messages and /poll-messages return. */
  inbox: Array<Record<string, unknown>>;
  fetch: typeof fetch;
}

function fakeBroker(): FakeBroker {
  const calls: BrokerCall[] = [];
  const gates = new Map<string, Promise<void>>();
  const failures = new Map<string, { times: number; kind: "network" | "http" }>();
  const state = {
    health: {} as Record<string, unknown>,
    resumable: null as { token: string; peer: string } | null,
    inbox: [] as Array<Record<string, unknown>>,
  };
  let registrations = 0;
  const handler = async (input: unknown, init?: { body?: unknown; signal?: AbortSignal }): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ path, body });
    const failure = failures.get(path);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      if (failure.kind === "network") throw new TypeError("fetch failed");
      return new Response("broker exploded", { status: 500 });
    }
    const gate = gates.get(path);
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    switch (path) {
      case "/health":
        return Response.json(state.health);
      case "/register":
        if (state.resumable && body.resume_instance_token === state.resumable.token) {
          return Response.json({
            peer_id: state.resumable.peer,
            instance_token: state.resumable.token,
            inbox_binding: null,
            role: body.role ?? null,
            resumed: "token",
          });
        }
        registrations += 1;
        return Response.json({
          peer_id: `peer-${registrations}`,
          instance_token: `token-${registrations}`,
          inbox_binding: null,
          role: body.role ?? null,
          ...(body.resume_instance_token !== undefined ? { resumed: false } : {}),
        });
      case "/set-id":
        return Response.json({ peer_id: body.new_peer_id, previous: "peer-1" });
      case "/list-peers":
        return Response.json([]);
      case "/peek-messages":
      case "/poll-messages":
        return Response.json({ messages: state.inbox });
      case "/group-stats":
        return Response.json({ groups: [] });
      default:
        return Response.json({ ok: true });
    }
  };
  return {
    calls,
    gates,
    failures,
    get health() {
      return state.health;
    },
    set health(value: Record<string, unknown>) {
      state.health = value;
    },
    get resumable() {
      return state.resumable;
    },
    set resumable(value: { token: string; peer: string } | null) {
      state.resumable = value;
    },
    get inbox() {
      return state.inbox;
    },
    set inbox(value: Array<Record<string, unknown>>) {
      state.inbox = value;
    },
    fetch: handler as unknown as typeof fetch,
  };
}

/** Emits "close" synchronously on close(), like a socket that is closed locally. */
class FakeWebSocket {
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get("close") ?? []) listener({});
  }
  /** Delivers a frame from the broker. */
  receive(frame: Record<string, unknown>): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(frame) });
  }
}

/** A clock that runs a timer only when the test says so, and remembers every delay asked for. */
class FakeClock {
  delays: number[] = [];
  private timers: Array<{ fn: () => void; cancelled: boolean; fired: boolean }> = [];
  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { fn, cancelled: false, fired: false };
    this.timers.push(timer);
    this.delays.push(ms);
    return timer;
  }
  clearTimeout(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }
  /** Runs the oldest timer still waiting. */
  runNext(): void {
    const timer = this.timers.find((t) => !t.cancelled && !t.fired);
    if (!timer) throw new Error("no timer is waiting");
    timer.fired = true;
    timer.fn();
  }
  get waiting(): number {
    return this.timers.filter((t) => !t.cancelled && !t.fired).length;
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
  /** The channel notifications the MCP client received. */
  notifications: Array<{ method: string; params?: Record<string, unknown> }>;
  /** The claims handed to deps.issueTicket, in order. */
  tickets: FamilyTicketClaims[];
  writes: { snapshot: number };
}

interface OpenOptions {
  /** Adjusts the fake broker before the session starts. */
  prepare?: (broker: FakeBroker) => void;
  /** Leave the server and the client unconnected; see connectHarness. */
  connect?: boolean;
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
  options.prepare?.(broker);
  const measured: number[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const tickets: FamilyTicketClaims[] = [];
  const writes = { snapshot: 0 };
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
      issueTicket: (claims) => tickets.push(claims),
      fetch: broker.fetch,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      writeGlobalSessionIdentityFile: async (...args) => {
        writes.snapshot += 1;
        return writeGlobalSessionIdentityFile(...args);
      },
      ...options.deps,
    }
  );
  const client = new Client({ name: "peers-session-test", version: "1.0.0" });
  const notifications: Harness["notifications"] = [];
  client.fallbackNotificationHandler = async (notification) => {
    notifications.push(notification as Harness["notifications"][number]);
  };
  const harness: Harness = { session, client, broker, home, env, measured, errors, infos, notifications, tickets, writes };
  opened.push(harness);
  if (options.connect !== false) await connectHarness(harness);
  if (!options.skipReady) await session.ready;
  return harness;
}

async function connectHarness(h: Harness): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await h.session.server.connect(serverTransport);
  await h.client.connect(clientTransport);
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

describe("close", () => {
  const CLOSE_TILE = "close-tile";

  async function openPublished(): Promise<Harness> {
    const h = await openSession({ env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET } });
    // Set after the registration: a tile token at boot demands a run credential.
    h.env.CLAUDE_PEERS_DESK_SESSION = CLOSE_TILE;
    await writeSessionIdentityFile(CLOSE_TILE, "peer-1", "default", "token-1", h.home);
    expect((await readGlobalSessionIdentityFile(SOCKET, h.home))?.peerId, "control: the snapshot is written").toBe("peer-1");
    expect((await readSessionIdentityFile(CLOSE_TILE, h.home))?.peerId, "control: the tile file is written").toBe("peer-1");
    return h;
  }

  test("bye disconnects the peer once and removes the snapshot and the tile file", async () => {
    // Mutation: dropping the /disconnect, calling it twice, or leaving either file behind.
    const h = await openPublished();
    await h.session.close("bye");
    await h.session.close("bye");

    expect(callsTo(h, "/disconnect")).toEqual([{ path: "/disconnect", body: { instance_token: "token-1" } }]);
    expect(await readGlobalSessionIdentityFile(SOCKET, h.home)).toBeNull();
    expect(await readSessionIdentityFile(CLOSE_TILE, h.home)).toBeNull();
  });

  test("daemon_stop keeps the snapshot and the tile file and never disconnects the peer", async () => {
    // Mutation: deleting either file, or disconnecting, whatever the reason.
    const h = await openPublished();
    await h.session.close("daemon_stop");

    expect(callsTo(h, "/disconnect")).toEqual([]);
    expect((await readGlobalSessionIdentityFile(SOCKET, h.home))?.peerId).toBe("peer-1");
    expect((await readSessionIdentityFile(CLOSE_TILE, h.home))?.peerId).toBe("peer-1");
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

describe("identity", () => {
  test("is null while the registration has not answered", async () => {
    // Mutation: answering the tokens held before the registration completes.
    const h = await openSession({ hang: ["/register"], skipReady: true });
    await until(() => callsTo(h, "/register").length === 1, "the boot /register");
    expect(h.session.identity()).toBeNull();

    await reachedWithin(h.session.close("bye"), "close while /register hangs");
  });

  test("is the registered peer with the project key and the broker URL the snapshot carries", async () => {
    // Mutation: a project key or a broker URL that differs from the snapshot read by the stdio roadmap companion.
    const h = await openSession({ env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET } });
    const snapshot = await readGlobalSessionIdentityFile(SOCKET, h.home);

    expect(h.session.identity()).toEqual({
      peerId: "peer-1",
      instanceToken: "token-1",
      projectKey: snapshot?.projectKey as string,
      brokerUrl: "http://127.0.0.1:17999/",
    });
    expect(snapshot?.brokerUrl).toBe("http://127.0.0.1:17999/");
  });

  describe("while the identity is being replaced", () => {
    const openSwitchable = () =>
      openSession({
        groups: { alpha: "alpha-secret", beta: "beta-secret" },
        env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET, CLAUDE_PEERS_GROUP: "alpha" },
      });

    test("is null from the switch_group /disconnect until the new identity is published", async () => {
      // Mutation: answering the old token while the broker has already disconnected it.
      const h = await openSwitchable();
      expect(h.session.identity()?.instanceToken, "control: published at boot").toBe("token-1");
      let release!: () => void;
      h.broker.gates.set("/register", new Promise<void>((resolve) => (release = resolve)));

      const switching = call(h, "switch_group", { name: "beta" });
      try {
        await until(() => callsTo(h, "/register").length === 2, "the switch's /register");
        expect(callsTo(h, "/disconnect")).toHaveLength(1);
        expect(h.session.identity()).toBeNull();
      } finally {
        release();
      }
      expect(isError(await switching)).toBe(false);
      expect(h.session.identity()).toMatchObject({ peerId: "peer-2", instanceToken: "token-2" });
    });

    test("stays null after a switch_group whose /register fails", async () => {
      // Mutation: restoring the flag when the switch fails after the /disconnect.
      const h = await openSwitchable();
      h.broker.failures.set("/register", { times: 10, kind: "http" });

      expect(isError(await call(h, "switch_group", { name: "beta" }))).toBe(true);
      expect(callsTo(h, "/disconnect")).toHaveLength(1);
      expect(h.session.identity()).toBeNull();
    });

    test("is null while set_id waits for the broker and follows the rename once published", async () => {
      // Mutation: a snapshot withdrawn for set_id that identity() does not see.
      const h = await openSwitchable();
      let release!: () => void;
      h.broker.gates.set("/set-id", new Promise<void>((resolve) => (release = resolve)));

      const renaming = call(h, "set_id", { new_id: "renamed-peer" });
      try {
        await until(() => callsTo(h, "/set-id").length === 1, "the /set-id request");
        expect(h.session.identity()).toBeNull();
      } finally {
        release();
      }
      expect(isError(await renaming)).toBe(false);
      expect(h.session.identity()).toMatchObject({ peerId: "renamed-peer", instanceToken: "token-1" });
    });

    test("is the old identity again after a set_id the broker refuses", async () => {
      // Mutation: the restore after a refusal not republishing, leaving the session unlinked for good.
      const h = await openSwitchable();
      h.broker.failures.set("/set-id", { times: 1, kind: "http" });

      expect(isError(await call(h, "set_id", { new_id: "renamed-peer" }))).toBe(true);
      expect(h.session.identity()).toMatchObject({ peerId: "peer-1", instanceToken: "token-1" });
    });
  });

  test("follows a rename of the peer", async () => {
    // Mutation: an identity captured once at registration.
    const h = await openSession({ env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET } });
    expect(h.session.identity()?.peerId, "control: the registered peer").toBe("peer-1");
    expect(isError(await call(h, "set_id", { new_id: "renamed-peer" }))).toBe(false);

    const snapshot = await readGlobalSessionIdentityFile(SOCKET, h.home);
    expect(h.session.identity()?.peerId).toBe(snapshot?.peerId as string);
    expect(h.session.identity()?.peerId).not.toBe("peer-1");
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

  test("an operation that escapes the abort signal holds the close for the bound only, uses up the shared deadline and the deletions still run", async () => {
    // Mutation: waiting for the identity chain without a bound, or giving /disconnect a deadline of its own.
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
    expect(callsTo(h, "/disconnect"), "the wait used up the deadline: no /disconnect of its own").toEqual([]);
    expect(h.errors.some((message) => message.startsWith("No time left to disconnect"))).toBe(true);
  });

  test("the /disconnect gets what is left of the deadline", async () => {
    // Mutation: the /disconnect bounded by the whole setting instead of the remainder.
    let reads = 0;
    const h = await openSession({
      deps: { now: () => (reads++ === 0 ? 1_000 : 1_400), settings: { ...SETTINGS, disconnectBoundMs: 500 } },
    });
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => {
      timeouts.push(ms);
      return realTimeout.call(AbortSignal, ms);
    };
    try {
      await reachedWithin(h.session.close("bye"), "close");
    } finally {
      AbortSignal.timeout = realTimeout;
    }

    expect(timeouts).toContain(100);
    expect(timeouts).not.toContain(500);
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

    test("is abandoned at the provider when the session closes while it is answering", async () => {
      // Mutation: the session abort signal not reaching the provider request.
      const realFetch = globalThis.fetch;
      let providerSignal: AbortSignal | undefined;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/chat/completions")) providerSignal = init?.signal ?? undefined;
        return realFetch(input, init);
      }) as typeof fetch;
      try {
        const { h } = await openWithSummaryProvider();
        expect(providerSignal?.aborted, "control: the provider request carries a live signal").toBe(false);

        await h.session.close("bye");

        expect(providerSignal?.aborted).toBe(true);
      } finally {
        globalThis.fetch = realFetch;
      }
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

const TICKET_GENERATION = canonicalWriterGeneration(GENERATION);
const KEPT_NOTICE = "claude-peers reconnected after a daemon restart; calls made during the outage failed; run check_messages";

function ticket(over: Partial<TicketClaims> = {}): ResumeOutcome {
  return {
    kind: "accepted",
    claims: {
      v: 1,
      family: "peers",
      relay_pid: RELAY_PID,
      relay_pid_start: "1",
      writer_generation: TICKET_GENERATION,
      instance_token: "token-old",
      peer_id: "peer-old",
      group_id: "default",
      notified_hwm: 7,
      issued_at: 0,
      ...over,
    },
  };
}

/** The broker knows the ticket's token and announces the resume protocol. */
function resumableBroker(broker: FakeBroker): void {
  broker.health = { register_resume_version: 1 };
  broker.resumable = { token: "token-old", peer: "peer-old" };
}

function channelTexts(h: Harness): string[] {
  return h.notifications.map((n) => String(n.params?.content ?? ""));
}

/** A message as the broker sends it on the WebSocket and returns it from /peek-messages. */
function messageFrame(id: number, text: string) {
  return {
    type: "message",
    id,
    from_peer_id: "peer-z",
    from_summary: "",
    from_host: "h",
    from_cwd: "/",
    text,
    sent_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("resuming after a daemon restart", () => {
  const keptSnapshot = async (home: string): Promise<void> => {
    await writeGlobalSessionIdentityFile(
      SOCKET,
      "peer-old",
      "default",
      "token-old",
      resolveProjectKey(null, null, home),
      home,
      GENERATION,
      canonicalBrokerUrl({ broker_url: null, offline_replica: false, port: 17999 })
    );
  };

  test("an accepted ticket resumes the token the broker agrees to, without a measure, a deletion or a rewrite of the snapshot", async () => {
    // Mutation: deleting the snapshot first, measuring the generation again, or rewriting an unchanged snapshot.
    const h = await openSession({
      env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
      input: { resume: ticket() },
      prepare: resumableBroker,
      seed: keptSnapshot,
    });

    expect(callsTo(h, "/register")[0]?.body).toMatchObject({
      resume_instance_token: "token-old",
      pid_generation: TICKET_GENERATION,
    });
    expect(JSON.parse(textOf(await call(h, "whoami"))).peer_id).toBe("peer-old");
    expect(h.measured).toEqual([]);
    expect(h.writes.snapshot).toBe(0);
    expect((await readGlobalSessionIdentityFile(SOCKET, h.home))?.peerId).toBe("peer-old");
    expect(h.tickets.at(-1)).toMatchObject({
      instance_token: "token-old",
      peer_id: "peer-old",
      group_id: "default",
      notified_hwm: 7,
      writer_generation: TICKET_GENERATION,
    });
    await until(() => channelTexts(h).length === 1, "the reconnection notice");
    expect(channelTexts(h)).toEqual([KEPT_NOTICE]);
  });

  test("a resumed identity whose snapshot was kept in place is published to the roadmap family", async () => {
    // Mutation: the kept-snapshot shortcut not marking the identity as published.
    const h = await openSession({
      env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
      input: { resume: ticket() },
      prepare: resumableBroker,
      seed: keptSnapshot,
    });

    expect(h.writes.snapshot, "control: the snapshot was kept, not rewritten").toBe(0);
    expect(h.session.identity()).toMatchObject({ peerId: "peer-old", instanceToken: "token-old" });
  });

  test("a snapshot that differs from the resumed identity is rewritten", async () => {
    // Mutation: never rewriting a kept snapshot.
    const h = await openSession({
      env: { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
      input: { resume: ticket() },
      prepare: resumableBroker,
      seed: async (home) => {
        await writeStaleSnapshot(home);
      },
    });

    expect(h.writes.snapshot).toBe(1);
    expect((await readGlobalSessionIdentityFile(SOCKET, h.home))?.peerId).toBe("peer-old");
  });

  test("a broker that does not announce register_resume_version gets the ordinary register and a notice that the identity changed", async () => {
    // Mutation: sending resume_instance_token without the /health announcement.
    const h = await openSession({
      input: { resume: ticket() },
      prepare: (broker) => {
        broker.resumable = { token: "token-old", peer: "peer-old" };
      },
    });

    const body = callsTo(h, "/register")[0]!.body;
    expect(body.resume_instance_token).toBeUndefined();
    expect(body.pid_generation).toBeUndefined();
    await until(() => channelTexts(h).length === 1, "the reconnection notice");
    expect(channelTexts(h)[0]).toContain("you are now peer `peer-1`");
  });

  test("a broker that refuses the token gives a new identity: the ticket is never taken as the proof", async () => {
    // Mutation: taking the ticket's peer and token when the broker answered resumed:false.
    const h = await openSession({
      input: { resume: ticket() },
      prepare: (broker) => {
        broker.health = { register_resume_version: 1 };
      },
    });

    expect(callsTo(h, "/register")[0]?.body.resume_instance_token).toBe("token-old");
    expect(JSON.parse(textOf(await call(h, "whoami"))).peer_id).toBe("peer-1");
    expect(h.tickets.at(-1)).toMatchObject({ instance_token: "token-1", peer_id: "peer-1", notified_hwm: 0 });
    await until(() => channelTexts(h).length === 1, "the reconnection notice");
    expect(channelTexts(h)[0]).toContain("you are now peer `peer-1`");

    // The new token has its own message stream: nothing in it was pushed before.
    FakeWebSocket.instances[0]!.receive(messageFrame(3, "first message of the new identity"));
    await until(() => channelTexts(h).some((t) => t.includes("first message of the new identity")), "the push");
  });

  test("a switch_group starts a new message stream: the resumed hwm no longer filters", async () => {
    // Mutation: keeping the filter base across switch_group.
    const h = await openSession({
      groups: { alpha: "alpha-secret", beta: "beta-secret" },
      env: { CLAUDE_PEERS_GROUP: "default" },
      input: { resume: ticket({ group_id: "default" }) },
      prepare: resumableBroker,
    });
    await call(h, "switch_group", { name: "beta" });
    FakeWebSocket.instances.at(-1)!.receive(messageFrame(3, "after the switch"));

    await until(() => channelTexts(h).some((t) => t.includes("after the switch")), "the push");
    expect(h.tickets.at(-1)).toMatchObject({ instance_token: "token-1", notified_hwm: 3 });
  });

  test("a refused ticket registers the ordinary way and says so", async () => {
    const h = await openSession({ input: { resume: { kind: "refused", cause: "ticket mac does not verify" } }, prepare: resumableBroker });

    expect(callsTo(h, "/register")[0]?.body.resume_instance_token).toBeUndefined();
    await until(() => channelTexts(h).length === 1, "the reconnection notice");
    expect(channelTexts(h)[0]).toContain("you are now peer `peer-1`");
  });

  test.each([
    ["a group other than the one this env resolves to", { group_id: "another-group" }],
    ["a generation of another pid", { writer_generation: canonicalWriterGeneration({ ...GENERATION, pid: 1 }) }],
    ["a malformed generation", { writer_generation: { platform: "linux" } }],
    ["a negative notified_hwm", { notified_hwm: -1 }],
  ])("a ticket with %s is not sent to the broker", async (_name, over) => {
    // Mutation: sending the token without checking the claims against this session.
    const h = await openSession({ input: { resume: ticket(over as Partial<TicketClaims>) }, prepare: resumableBroker });

    expect(callsTo(h, "/register")[0]?.body.resume_instance_token).toBeUndefined();
  });

  test("a message at or below notified_hwm is not pushed again, a newer one is, and the hwm rises with a ticket", async () => {
    // Mutation: pushing every message, or not raising the hwm.
    const h = await openSession({ input: { resume: ticket() }, prepare: resumableBroker });
    await until(() => channelTexts(h).length === 1, "the reconnection notice");
    const frame = (id: number, text: string) => ({
      type: "message",
      id,
      from_peer_id: "peer-z",
      from_summary: "",
      from_host: "h",
      from_cwd: "/",
      text,
      sent_at: "t",
    });

    FakeWebSocket.instances[0]!.receive(frame(5, "already pushed"));
    FakeWebSocket.instances[0]!.receive(frame(7, "also already pushed"));
    FakeWebSocket.instances[0]!.receive(frame(9, "brand new"));
    await until(() => channelTexts(h).some((t) => t.includes("brand new")), "the new message");

    expect(channelTexts(h).some((t) => t.includes("already pushed"))).toBe(false);
    expect(h.tickets.at(-1)?.notified_hwm).toBe(9);
  });

  test("a message at or below the resumed hwm stays readable by check_messages", async () => {
    // Mutation: dropping the message from the broker's answer instead of from the push.
    const h = await openSession({
      input: { resume: ticket({ notified_hwm: 10 }) },
      prepare: (broker) => {
        resumableBroker(broker);
        broker.inbox = [messageFrame(9, "pushed before the restart")];
      },
    });
    await until(() => channelTexts(h).length === 1, "the reconnection notice");

    FakeWebSocket.instances[0]!.receive(messageFrame(9, "pushed before the restart"));
    await flush();

    expect(channelTexts(h).some((t) => t.includes("pushed before the restart"))).toBe(false);
    expect(textOf(await call(h, "check_messages"))).toContain("pushed before the restart");
  });

  test("without a resume, an older message that was never pushed is still pushed after a newer one", async () => {
    // Mutation: filtering on the live hwm, which rises with every push.
    const h = await openSession();
    const socket = FakeWebSocket.instances[0]!;

    socket.receive(messageFrame(12, "newer"));
    await until(() => channelTexts(h).length === 1, "the first push");
    socket.receive(messageFrame(10, "older"));
    await until(() => channelTexts(h).length === 2, "the second push");

    expect(channelTexts(h)[1]).toContain("older");
    expect(h.tickets.at(-1)?.notified_hwm).toBe(12);
  });

  test("without a resume, wait_for_message still returns an older message that was never pushed", async () => {
    // Mutation: filtering the peek of wait_for_message on the live hwm.
    const h = await openSession();
    FakeWebSocket.instances[0]!.receive(messageFrame(12, "newer"));
    await until(() => channelTexts(h).length === 1, "the first push");
    h.broker.inbox = [messageFrame(10, "older but never pushed")];

    const result = await reachedWithin(call(h, "wait_for_message", { timeout_sec: 5 }), "wait_for_message");

    expect(textOf(result)).toContain("older but never pushed");
  });

  test("a push that failed is made again by the fallback poll, even after a newer message was pushed", async () => {
    // Mutation: filtering on the live hwm, which rises with every push.
    const h = await openSession({
      connect: false,
      deps: { settings: { ...SETTINGS, pollFallbackIntervalMs: 20 } },
    });
    h.session.openChannel();
    const socket = FakeWebSocket.instances[0]!;
    socket.receive(messageFrame(20, "failed once"));
    await flush();
    expect(channelTexts(h)).toEqual([]);

    await connectHarness(h);
    socket.receive(messageFrame(21, "newer"));
    await until(() => channelTexts(h).some((t) => t.includes("newer")), "the newer push");
    h.broker.inbox = [messageFrame(20, "failed once"), messageFrame(21, "newer")];
    await until(() => channelTexts(h).some((t) => t.includes("failed once")), "the push of the failed message");
  });

  describe("the tile identity file", () => {
    const TILE = "tile-under-test";

    async function openWithTileFile(resume: ResumeOutcome | undefined) {
      let ensureCalled = false;
      const h = await openSession({
        skipReady: true,
        env: { CLAUDE_PEERS_DESK_SESSION: TILE },
        input: { resume },
        seed: async (home) => {
          await writeSessionIdentityFile(TILE, "peer-old", "default", "token-old", home);
        },
        deps: {
          ensureBroker: async () => {
            ensureCalled = true;
            return new Promise<void>(() => {});
          },
        },
      });
      await until(() => ensureCalled, "the broker check");
      return readSessionIdentityFile(TILE, h.home);
    }

    test("is kept for a valid ticket, even if the registration never ends", async () => {
      // Mutation: deleting it at boot whatever the ticket.
      expect((await openWithTileFile(ticket()))?.peerId).toBe("peer-old");
    });

    test("kept for a valid ticket, is deleted once the registration fails for good", async () => {
      // Mutation: leaving the file, and its old token, after the final failure.
      const h = await openSession({
        skipReady: true,
        env: { CLAUDE_PEERS_DESK_SESSION: TILE },
        input: { resume: ticket() },
        seed: async (home) => {
          await writeSessionIdentityFile(TILE, "peer-old", "default", "token-old", home);
        },
        deps: {
          ensureBroker: async () => {
            throw new Error("the local broker was stopped manually");
          },
        },
      });

      await expect(reachedWithin(h.session.ready, "ready")).rejects.toThrow("stopped manually");

      expect(await readSessionIdentityFile(TILE, h.home)).toBeNull();
    });

    test("is deleted without a ticket", async () => {
      expect(await openWithTileFile(undefined)).toBeNull();
    });

    test("is deleted for a ticket of another group", async () => {
      // Mutation: keeping it on any accepted ticket.
      expect(await openWithTileFile(ticket({ group_id: "another-group" }))).toBeNull();
    });
  });

  test("tickets follow every change of identity", async () => {
    // Mutation: no ticket after a registration, a set_id or a switch_group.
    const h = await openSession({
      groups: { alpha: "alpha-secret", beta: "beta-secret" },
      env: { CLAUDE_PEERS_GROUP: "alpha", CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
    });
    expect(h.tickets).toHaveLength(1);
    expect(h.tickets[0]).toMatchObject({
      instance_token: "token-1",
      peer_id: "peer-1",
      group_id: computeGroupId("alpha-secret"),
      notified_hwm: 0,
      writer_generation: TICKET_GENERATION,
    });

    await call(h, "set_id", { new_id: "renamed-peer" });
    expect(h.tickets.at(-1)).toMatchObject({ peer_id: "renamed-peer", instance_token: "token-1" });

    await call(h, "switch_group", { name: "beta" });
    expect(h.tickets.at(-1)).toMatchObject({ instance_token: "token-2", group_id: computeGroupId("beta-secret") });
  });

  describe("the notice", () => {
    const NOW = 50_000_000;

    test("reconnections within ten minutes of the previous notice share it and count as an outage", async () => {
      // Mutation: sending a notice on every resume.
      const h = await openSession({
        input: { resume: ticket({ notice_at: NOW - 1_000, outages: 1 }) },
        prepare: resumableBroker,
        deps: { now: () => NOW },
      });
      await flush();

      expect(channelTexts(h)).toEqual([]);
      expect(h.tickets.at(-1)).toMatchObject({ notice_at: NOW - 1_000, outages: 2 });
    });

    test("an older notice is followed by a new one that counts the outages in between", async () => {
      // Mutation: dropping the outage count, or not moving notice_at.
      const h = await openSession({
        input: { resume: ticket({ notice_at: NOW - 11 * 60 * 1000, outages: 2 }) },
        prepare: resumableBroker,
        deps: { now: () => NOW },
      });
      await until(() => channelTexts(h).length === 1, "the reconnection notice");

      expect(channelTexts(h)[0]).toBe(`${KEPT_NOTICE} (2 outage(s) since the previous notice)`);
      expect(h.tickets.at(-1)).toMatchObject({ notice_at: NOW, outages: 0 });
    });

    test("a notice date in the future does not silence the notice", async () => {
      // Mutation: trusting notice_at without comparing it to now.
      const h = await openSession({
        input: { resume: ticket({ notice_at: NOW + 24 * 60 * 60 * 1000, outages: 0 }) },
        prepare: resumableBroker,
        deps: { now: () => NOW },
      });
      await until(() => channelTexts(h).length === 1, "the reconnection notice");

      expect(h.tickets.at(-1)).toMatchObject({ notice_at: NOW, outages: 0 });
    });

    test("a session that never resumed sends no notice", async () => {
      const h = await openSession();
      await flush();

      expect(channelTexts(h)).toEqual([]);
    });
  });
});

describe("a broker that is absent when the session registers", () => {
  test("the registration is retried with a growing delay while tool calls answer the last error", async () => {
    // Mutation: a constant delay, no retry, or tool calls that wait instead of answering.
    const clock = new FakeClock();
    const h = await openSession({
      skipReady: true,
      deps: { clock },
      prepare: (broker) => broker.failures.set("/register", { times: 2, kind: "network" }),
    });
    await until(() => clock.waiting === 1, "the first retry timer");
    expect(clock.delays).toEqual([1_000]);

    const meanwhile = await reachedWithin(call(h, "whoami"), "a tool call during the outage");
    expect(isError(meanwhile)).toBe(true);
    expect(textOf(meanwhile)).toContain("fetch failed");

    clock.runNext();
    await until(() => clock.delays.length === 2, "the second retry timer");
    expect(clock.delays).toEqual([1_000, 2_000]);
    clock.runNext();
    await reachedWithin(h.session.ready, "ready after the broker came back");

    expect(callsTo(h, "/register")).toHaveLength(3);
    expect(isError(await call(h, "whoami"))).toBe(false);
  });

  test("a close during the wait stops the retries", async () => {
    // Mutation: a retry timer that close() does not cancel.
    const clock = new FakeClock();
    const h = await openSession({
      skipReady: true,
      deps: { clock },
      prepare: (broker) => broker.failures.set("/register", { times: 5, kind: "network" }),
    });
    await until(() => clock.waiting === 1, "the retry timer");

    await h.session.close("bye");

    await expect(reachedWithin(h.session.ready, "ready after close")).rejects.toThrow("closed");
    expect(clock.waiting).toBe(0);
    expect(callsTo(h, "/register")).toHaveLength(1);
  });

  test("an answer from the broker that refuses the registration ends it, and the session logs why", async () => {
    // Mutation: retrying any failure.
    const h = await openSession({
      skipReady: true,
      prepare: (broker) => broker.failures.set("/register", { times: 1, kind: "http" }),
    });

    await expect(reachedWithin(h.session.ready, "ready")).rejects.toThrow("Broker error (/register): 500");
    expect(h.errors).toContain("Registration failed");
    expect(callsTo(h, "/register")).toHaveLength(1);
  });

  test("an ensureBroker refusal ends the registration without a second trace; a retryable one is retried", async () => {
    // Mutation: logging the caller's own refusal again, or retrying a refusal that is not retryable.
    const refused = await openSession({
      skipReady: true,
      deps: {
        ensureBroker: async () => {
          throw new Error("the local broker was stopped manually");
        },
      },
    });
    await expect(reachedWithin(refused.session.ready, "ready")).rejects.toThrow("stopped manually");
    expect(refused.errors).not.toContain("Registration failed");

    const clock = new FakeClock();
    let attempts = 0;
    const retrying = await openSession({
      skipReady: true,
      deps: {
        clock,
        ensureBroker: async () => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("the broker is still starting"), { retryable: true });
        },
      },
    });
    await until(() => clock.waiting === 1, "the retry timer");
    clock.runNext();
    await reachedWithin(retrying.session.ready, "ready after the retry");
    expect(attempts).toBe(2);
  });
});

describe("the channel and its limits", () => {
  test("the WebSocket opens only once the MCP transport is connected", async () => {
    // Mutation: opening the channel as soon as the registration ends.
    const h = await openSession({ connect: false });
    expect(FakeWebSocket.instances).toHaveLength(0);

    await connectHarness(h);
    h.session.openChannel();
    h.session.openChannel();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("a 257th live context resume key is refused and logged", async () => {
    // Mutation: no bound on the keys.
    const h = await openSession();
    const socket = FakeWebSocket.instances[0]!;
    for (let i = 0; i < 257; i++) {
      socket.receive({
        type: "context_resume",
        deposit_id: `deposit-${i}`,
        attempt_id: `attempt-${i}`,
        deposited_at: "t",
        head_at_deposit: null,
        branch: "b",
        git_root: "/",
        text: "context",
      });
    }
    await until(() => h.errors.some((message) => message.includes("keys are already held")), "the refusal");
    await until(
      () => h.notifications.filter((n) => (n.params?.meta as Record<string, unknown> | undefined)?.deposit_id !== undefined).length === 256,
      "the 256 notifications"
    );

    expect(h.errors.filter((message) => message.includes("keys are already held"))).toHaveLength(1);
  });

  test("the signed and the bare /register both carry the session abort signal", async () => {
    // Mutation: the signed branch posting without the signal.
    const seen: Array<AbortSignal | undefined> = [];
    const post = (async (_path: string, _body: unknown, signal?: AbortSignal) => {
      seen.push(signal);
      return { peer_id: "p", instance_token: "t", inbox_binding: null, role: null };
    }) as unknown as Parameters<typeof sendRegister>[1];
    const signal = new AbortController().signal;
    const base: Omit<RegisterAttempt, "signed"> = { path: "/register", bare: { group_id: "g" }, credential: null, requiresInboxBinding: false };

    await sendRegister({ ...base, signed: { group_id: "g" } }, post, signal, () => {});
    await sendRegister({ ...base, signed: null }, post, signal, () => {});

    expect(seen).toEqual([signal, signal]);
  });
});

describe("the kory-operator inbox tools", () => {
  const RUN = "11111111-1111-4111-8111-111111111111";
  const TILE_INSTANCE = ["tile", "instance", "marker"].join("-");
  const DECK_BEARER = ["deck", "bearer"].join("-");
  const runRoot = generateCredential();
  const identity: CompanionIdentity = {
    host: "h",
    peerId: "lead-peer",
    groupId: "g-run",
    instanceToken: TILE_INSTANCE,
    inboxBinding: { version: 1, runRef: RUN, groupId: "g-run" },
    operatorId: "op-1",
    projectKey: "",
    fromPeer: "lead-peer",
  };
  let credDir = "";
  beforeEach(() => {
    credDir = mkdtempSync(join(tmpdir(), "inbox-tools-"));
  });
  afterEach(() => rmSync(credDir, { recursive: true, force: true }));

  function writeCred(over: Record<string, unknown> = {}): string {
    const file = join(credDir, "cred.json");
    writeFileSync(file, JSON.stringify({
      brokerUrl: "http://broker.test", operatorId: "op-1", tokenId: "root-id", privateKey: runRoot.privateKey, publicKey: runRoot.publicKey,
      inbox: { version: 1, run_ref: RUN, group_id: "g-run" }, ...over,
    }));
    return file;
  }

  function ctx(answer: unknown, opts: { status?: number; credFile?: string | null; deck?: { url: string; token: string } } = {}) {
    const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const errors: string[] = [];
    const credFile = opts.credFile === undefined ? writeCred() : opts.credFile;
    const context: OperatorToolContext = {
      broker: {} as never,
      env: credFile ? { CLAUDE_PEERS_APPROVAL_FILE: credFile } : {},
      role: null,
      cwd: "/",
      log: { log: () => {}, logError: (m: string) => void errors.push(m) },
      deck: {
        ...(opts.deck ?? { url: "http://deck.test", token: DECK_BEARER }),
        fetch: (async (url: string, init: RequestInit) => {
          sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify({ ok: true, result: answer }), { status: opts.status ?? 200 });
        }) as never,
      },
    };
    return { context, sent, errors };
  }
  const textOf = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

  // Mutants: the raw reason signed; the list gate used for a close; the args spread into the body.
  test("inbox_close signs the cleaned reason under the author close gate and sends only op and the author proof", async () => {
    const h = ctx({ outcome: "closed", id: "m_x" });
    const got = await handleInboxClose(
      { id: "m_x", reason: `no longer\nneeded${String.fromCharCode(7)}`, role: "supervisor", authority: "supervisor", run_ref: "r", author: "forged" },
      identity,
      h.context
    );

    expect(textOf(got)).toBe("Closed m_x.");
    expect("isError" in got).toBe(false);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.url).toBe("http://deck.test/inbox");
    expect(h.sent[0]!.headers.Authorization).toBe(`Bearer ${DECK_BEARER}`);
    const body = h.sent[0]!.body as { op: string; author: { payload: Record<string, unknown>; auth: ApprovalAuthProof } };
    expect(Object.keys(body).sort()).toEqual(["author", "op"]);
    expect(body.op).toBe("close");
    expect(body.author.payload).toEqual({ inbox_operation: "close", entry_id: "m_x", reason: "no longer needed", instance_token: TILE_INSTANCE });
    expect(verifyInboxProof(runRoot.publicKey, body.author.payload, body.author.auth, INBOX_GATES.authorClose).ok).toBe(true);
    expect(verifyInboxProof(runRoot.publicKey, body.author.payload, body.author.auth, INBOX_GATES.authorList).ok).toBe(false);
    expect((body.author.auth as { token_id?: string }).token_id).toBe("root-id");
  });

  // Mutants: inbox_list signed under the close gate; the cursor dropped or moved into the signed payload.
  test("inbox_list signs under the author list gate, passes the cursor beside the proof and renders the page as JSON", async () => {
    const page = { outcome: "listed", entries: [{ id: "m_1", type: "message", author: "p", created_at: "t", text: "x", closable: true }], next_cursor: "n2" };
    const h = ctx(page);
    const got = await handleInboxList({ cursor: "n1", limit: 99 }, identity, h.context);

    expect(JSON.parse(textOf(got))).toEqual({ entries: page.entries, next_cursor: "n2" });
    const body = h.sent[0]!.body as { op: string; cursor: string; author: { payload: Record<string, unknown>; auth: ApprovalAuthProof } };
    expect(Object.keys(body).sort()).toEqual(["author", "cursor", "op"]);
    expect(body.cursor).toBe("n1");
    expect(body.author.payload).toEqual({ inbox_operation: "list", instance_token: TILE_INSTANCE });
    expect(verifyInboxProof(runRoot.publicKey, body.author.payload, body.author.auth, INBOX_GATES.authorList).ok).toBe(true);
  });

  // Mutant: the rendering chosen from a text instead of the typed outcome.
  test("each close outcome renders its own sentence, and a failure is an error", async () => {
    const cases: Array<[unknown, string]> = [
      [{ outcome: "settled", state: "closed" }, "Not closed: the item is already closed."],
      [{ outcome: "unknown" }, "Not closed: no open item m_x in this run."],
      [{ outcome: "forbidden" }, "Not closed: you may not close this item."],
      [{ outcome: "not-closable" }, "Not closed: this item has no closable answer route."],
      [{ outcome: "invalid", message: "id is not an inbox entry id" }, "Not closed: id is not an inbox entry id"],
      [{ outcome: "unavailable", cause: "mandate not ready" }, "inbox_close unavailable: mandate not ready. Retry later."],
    ];
    for (const [answer, text] of cases) {
      const got = await handleInboxClose({ id: "m_x", reason: "r" }, identity, ctx(answer).context);
      expect({ answer, text: textOf(got), isError: (got as { isError?: boolean }).isError }).toEqual({ answer, text, isError: true });
    }
  });

  // Mutants: a missing credential, registration or Deck endpoint still posting; an invalid reason still posting.
  test("without the run credential, a confirmed registration or the Deck endpoint, or with an invalid argument, nothing is posted", async () => {
    const unconfirmed: CompanionIdentity = { ...identity, inboxBinding: null };
    const runs: Array<[ReturnType<typeof ctx>, unknown, CompanionIdentity, RegExp]> = [
      [ctx({}, { credFile: null }), { id: "m_x", reason: "r" }, identity, /^inbox_close unavailable: the run credential is unavailable/],
      [ctx({}), { id: "m_x", reason: "r" }, unconfirmed, /^inbox_close unavailable: Inbox registration is not yet confirmed/],
      [ctx({}, { deck: { url: "", token: DECK_BEARER } }), { id: "m_x", reason: "r" }, identity, /^inbox_close unavailable: the Deck control endpoint/],
      [ctx({}, { deck: { url: "http://deck.test", token: "" } }), { id: "m_x", reason: "r" }, identity, /^inbox_close unavailable: the Deck control endpoint/],
      [ctx({}), { id: "m_x", reason: "" }, identity, /^Not closed: reason must not be empty/],
      [ctx({}), { id: "m_x", reason: "x".repeat(501) }, identity, /^Not closed: reason must be at most 500/],
      [ctx({}), { id: "i".repeat(65), reason: "r" }, identity, /^Not closed: id must be/],
    ];
    for (const [h, args, who, pattern] of runs) {
      const got = await handleInboxClose(args, who, h.context);
      expect(textOf(got)).toMatch(pattern);
      expect(h.sent).toEqual([]);
    }
    const listNoCred = ctx({}, { credFile: null });
    expect(textOf(await handleInboxList({}, identity, listNoCred.context))).toMatch(/^inbox_list unavailable: the run credential/);
    const listBadCursor = ctx({});
    expect(textOf(await handleInboxList({ cursor: "" }, identity, listBadCursor.context))).toMatch(/^inbox_list refused: cursor/);
    expect([...listNoCred.sent, ...listBadCursor.sent]).toEqual([]);
  });

  // Mutant: the one-shot spawned with ctx.env unchanged.
  test("the graph_draft_prepare one-shot never inherits the tile's deck-control endpoint or Bearer", async () => {
    const envs: Array<Record<string, string | undefined>> = [];
    const h = ctx({});
    h.context.env = { DECK_CONTROL_URL: "http://deck.test", DECK_CONTROL_TOKEN: DECK_BEARER, deck_control_extra: "x", KEPT: "1" };
    h.context.spawn = ((_cmd: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
      envs.push(opts.env);
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding(): void }; stderr: EventEmitter & { setEncoding(): void }; kill(): void };
      proc.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      proc.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      proc.kill = () => {};
      queueMicrotask(() => {
        proc.stdout.emit("data", "# A title\nthe prompt");
        proc.emit("close", 0, null);
      });
      return proc;
    }) as never;

    const got = await handleGraphDraftPrepare({ question: "why?" }, h.context);

    expect("isError" in got).toBe(false);
    expect(envs).toEqual([{ KEPT: "1" }]);
  });

  test("a Deck answering 401 is unavailable, and no log line carries the reason or the instance", async () => {
    const h = ctx({}, { status: 401 });
    const got = await handleInboxClose({ id: "m_x", reason: "SECRET-REASON" }, identity, h.context);
    expect(textOf(got)).toBe("inbox_close unavailable: the Deck answered 401. Retry later.");
    expect(h.errors.length).toBeGreaterThan(0);
    for (const line of h.errors) {
      expect(line).not.toContain("SECRET-REASON");
      expect(line).not.toContain(TILE_INSTANCE);
    }
  });
});
