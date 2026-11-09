import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeGroupId } from "../shared/config.ts";
import { startDaemon, type DaemonHandle } from "../shared/mcp-daemon-server.ts";
import { readGlobalSessionIdentityFile } from "../shared/peer-cache.ts";
import { createPeersFamily } from "../shared/peers-family.ts";
import { createPeersSession } from "../shared/peers-session.ts";
import { measureWriterGeneration } from "../shared/process-generation.ts";
import { canonicalWriterGeneration } from "../shared/relay-liveness.ts";
import { get, startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { linkTestKey } from "./_mcp-daemon-fake-relay.ts";
import { DaemonRelay, RELAY_CODE_ROOT } from "./_mcp-daemon-relay.ts";

const GENERATION_MEASURABLE = process.platform === "win32" || process.platform === "linux";
const NEEDS_GENERATION = "needs a platform where a process generation can be measured (win32 or linux)";

const POISON_GROUP = "poisoned-process-env-group";
const POISON_NAME = "poisoned-process-env-name";
const WAIT_BOUND_MS = 10_000;
const RELAY_PROCESSES = 12;

interface Tile {
  label: string;
  relay: DaemonRelay;
  child: ReturnType<typeof Bun.spawn>;
  env: Record<string, string>;
  cwd: string;
  socket: string;
  peerId: string;
}

interface Run {
  group: string;
  name: string;
}

interface Whoami {
  peer_id: string;
  group_name: string;
  ws_connected: boolean;
}

let broker: TestBroker;
let daemon: DaemonHandle;
let keyPath: string;
let home: string;
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const spareProcesses: Array<ReturnType<typeof Bun.spawn>> = [];
const relays: DaemonRelay[] = [];
const peeks = new Map<string, number>();

function observedFetch(label: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === "/peek-messages") peeks.set(label, (peeks.get(label) ?? 0) + 1);
    return response;
  }) as typeof fetch;
}

function serve(port: number): DaemonHandle {
  return startDaemon({
    port,
    keyPath,
    logDir: join(home, "logs"),
    codeRoot: RELAY_CODE_ROOT,
    home,
    brokers: { ensure: async () => ({ action: "already-running" }) },
    families: {
      peers: createPeersFamily({
        createSession: (input, deps) =>
          createPeersSession(input, { ...deps, fetch: observedFetch(input.env.CLAUDE_CODE_MESSAGING_SOCKET ?? "") }),
      }),
    },
  });
}

/** The listener of a stopped daemon is released by the OS a moment after `stop()` resolves. */
async function serveAgainOn(port: number): Promise<DaemonHandle> {
  const deadline = Date.now() + WAIT_BOUND_MS;
  for (;;) {
    try {
      return serve(port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function eventually(check: () => Promise<boolean> | boolean, what: string, boundMs = WAIT_BOUND_MS): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${boundMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function freshRun(): Run {
  const id = crypto.randomUUID();
  return { group: `mcp-daemon-peers-run-${id}`, name: `run-${id.slice(0, 8)}` };
}

function freshCwd(): string {
  return mkdtempSync(join(home, "work-"));
}

function tileEnv(label: string, run: Run | null): Record<string, string> {
  const id = crypto.randomUUID();
  return {
    CLAUDE_CODE_MESSAGING_SOCKET: `mcp-daemon-peers-${label}-${id}`,
    CLAUDE_PEERS_PORT: String(broker.port),
    XDG_CONFIG_HOME: home,
    APPDATA: home,
    ...(run ? { CLAUDE_PEERS_FORCE_GROUP: run.group, CLAUDE_PEERS_FORCE_GROUP_NAME: run.name } : {}),
  };
}

function takeRelayProcess(): ReturnType<typeof Bun.spawn> {
  const child = spareProcesses.pop();
  if (!child) throw new Error(`the ${RELAY_PROCESSES} spare relay processes are used up`);
  return child;
}

async function whoamiOf(relay: DaemonRelay): Promise<Whoami> {
  const reply = await relay.callTool("whoami");
  expect(reply.isError, `whoami answered: ${reply.text}`).toBe(false);
  return JSON.parse(reply.text) as Whoami;
}

async function openRelay(tile: Pick<Tile, "env" | "cwd" | "child">, over: { replay?: boolean; resume_ticket?: string } = {}) {
  const relay = await DaemonRelay.open(daemon.port, keyPath);
  relays.push(relay);
  const reply = await relay.hello({
    family: "peers",
    cwd: tile.cwd,
    env: tile.env,
    pid: tile.child.pid,
    ppid: process.pid,
    ...over,
  });
  return { relay, reply };
}

async function openTile(label: string, options: { run?: Run | null; cwd?: string } = {}): Promise<Tile> {
  const run = options.run === undefined ? freshRun() : options.run;
  const base = { env: tileEnv(label, run), cwd: options.cwd ?? freshCwd(), child: takeRelayProcess() };
  const { relay, reply } = await openRelay(base);
  expect(reply.kind, `the daemon must serve the peers family for ${label}`).toBe("welcome");
  const who = await whoamiOf(relay);
  return { label, relay, socket: base.env.CLAUDE_CODE_MESSAGING_SOCKET as string, peerId: who.peer_id, ...base };
}

async function channelConnected(tile: Tile): Promise<void> {
  await eventually(async () => (await whoamiOf(tile.relay)).ws_connected, `${tile.label} to hold its broker WebSocket`);
}

function pushes(tile: Tile): Array<{ content: string; fromPeerId: string }> {
  return tile.relay.notifications
    .filter((message) => message.method === "notifications/claude/channel")
    .map((message) => ({ content: String(message.params?.content), fromPeerId: String(message.params?.meta?.from_peer_id) }));
}

async function send(from: Tile, to: Tile, message: string): Promise<void> {
  const reply = await from.relay.callTool("send_message", { to_peer_id: to.peerId, message });
  expect(reply.isError, `send_message from ${from.label} to ${to.label}: ${reply.text}`).toBe(false);
}

async function activePeersOf(group: string): Promise<number> {
  const stats = await get<{ groups: Array<{ group_id: string; active_peers: number }> }>(`${broker.url}/group-stats`);
  expect(stats.status).toBe(200);
  return stats.body.groups.find((entry) => entry.group_id === computeGroupId(group))?.active_peers ?? 0;
}

async function withPoisonedProcessEnv(body: () => Promise<void>): Promise<void> {
  const poison = {
    CLAUDE_PEERS_FORCE_GROUP: POISON_GROUP,
    CLAUDE_PEERS_FORCE_GROUP_NAME: POISON_NAME,
    CLAUDE_PEERS_PORT: "1",
  };
  const saved = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
  Object.assign(process.env, poison);
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeAll(async () => {
  broker = await startBroker();
  // Spawned before any listener exists: on Windows a child inherits the listening sockets that are open when it
  // starts, and a daemon restarted on the same port would find the port still held by it.
  for (let i = 0; i < RELAY_PROCESSES; i++) {
    const child = Bun.spawn([process.execPath, "-e", "await new Promise(() => {})"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(child);
    spareProcesses.push(child);
  }
  home = mkdtempSync(join(tmpdir(), "mcp-daemon-peers-"));
  keyPath = join(home, "peers", "mcp-daemon.key");
  linkTestKey(home, keyPath);
  daemon = serve(0);
}, 60_000);

afterEach(() => {
  for (const relay of relays.splice(0)) relay.close();
});

afterAll(async () => {
  for (const relay of relays.splice(0)) relay.close();
  await daemon?.stop();
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  if (broker) await stopBroker(broker);
  if (home) rmSync(home, { recursive: true, force: true });
});

test("a message goes to the connection of its addressee and to no other session", async () => {
  const run = freshRun();
  const a = await openTile("push-a", { run });
  const b = await openTile("push-b", { run });
  const c = await openTile("push-c", { run });
  for (const tile of [a, b, c]) await channelConnected(tile);

  // A TCP stream keeps its order: once a session holds the later message addressed to it, an earlier one
  // misrouted to it would already be in `pushes`, so the exact-contents checks below cannot race.
  await send(a, b, "toward-b");
  await eventually(() => pushes(b).length > 0, "the push addressed to B");
  await send(b, c, "toward-c");
  await eventually(() => pushes(c).length > 0, "the push addressed to C");
  await send(c, a, "toward-a");
  await eventually(() => pushes(a).length > 0, "the push addressed to A");

  const expected: Array<[Tile, Tile, string]> = [
    [b, a, "toward-b"],
    [c, b, "toward-c"],
    [a, c, "toward-a"],
  ];
  for (const [receiver, sender, text] of expected) {
    const received = pushes(receiver);
    expect(received.length, `${receiver.label} received exactly one push, got ${JSON.stringify(received)}`).toBe(1);
    expect(received[0]?.content, `the push on ${receiver.label} carries its own message`).toContain(text);
    expect(received[0]?.fromPeerId, `the push on ${receiver.label} names its real sender`).toBe(sender.peerId);
  }
});

test.skipIf(!GENERATION_MEASURABLE)(
  `two tiles of one directory keep their own identity across a daemon restart (${NEEDS_GENERATION})`,
  async () => {
    const run = freshRun();
    const cwd = freshCwd();
    const a = await openTile("resume-a", { run, cwd });
    const b = await openTile("resume-b", { run, cwd });
    expect(a.peerId, "two tiles of one directory are two peers before the restart").not.toBe(b.peerId);
    await eventually(() => a.relay.tickets.length > 0 && b.relay.tickets.length > 0, "a resume ticket for each tile");
    const ticketA = a.relay.tickets.at(-1) as string;
    const ticketB = b.relay.tickets.at(-1) as string;

    const port = daemon.port;
    await daemon.stop();
    daemon = await serveAgainOn(port);

    const againA = await openRelay(a, { replay: true, resume_ticket: ticketA });
    const againB = await openRelay(b, { replay: true, resume_ticket: ticketB });
    for (const again of [againA, againB]) {
      expect(again.reply.kind, "the restarted daemon welcomes the replayed hello").toBe("welcome");
      expect(again.reply.kind === "welcome" && again.reply.resumed, "the daemon accepted the resume ticket").toBe(true);
    }
    expect((await whoamiOf(againA.relay)).peer_id, "tile A is the same peer after the restart").toBe(a.peerId);
    expect((await whoamiOf(againB.relay)).peer_id, "tile B is the same peer after the restart").toBe(b.peerId);
  },
);

test("a session registers on the broker and the group of its hello, whatever the daemon process env holds", async () => {
  await withPoisonedProcessEnv(async () => {
    const run = freshRun();
    const forced = await openTile("env-forced", { run });
    const bare = await openTile("env-bare", { run: null });

    expect((await whoamiOf(forced.relay)).group_name, "a forced group comes from the hello").toBe(run.name);
    expect(
      (await whoamiOf(bare.relay)).group_name,
      "a hello with no forced group does not inherit the one in the daemon process env",
    ).not.toBe(POISON_NAME);
    expect(await activePeersOf(POISON_GROUP), "no peer of the daemon-side group is registered").toBe(0);
    expect(await activePeersOf(run.group), "the forced group holds its tile").toBeGreaterThan(0);
  });
});

test("closing a session leaves the wait_for_message of another session pending and answerable", async () => {
  const run = freshRun();
  const a = await openTile("wait-a", { run });
  const b = await openTile("wait-b", { run });
  const c = await openTile("wait-c", { run });
  for (const tile of [a, b, c]) await channelConnected(tile);

  const peeksBefore = peeks.get(b.socket) ?? 0;
  const waiting = b.relay.callTool("wait_for_message", { timeout_sec: 25 }, 15_000);
  waiting.catch(() => undefined);
  await eventually(
    () => (peeks.get(b.socket) ?? 0) > peeksBefore,
    "B's wait to have asked the broker for pending messages",
  );

  const closedBefore = daemon.stats().sessionsClosed;
  a.relay.close();
  await eventually(() => daemon.stats().sessionsClosed > closedBefore, "the daemon to finish closing A");

  await send(c, b, "for-the-waiter-of-b");
  const answer = await waiting;
  expect(answer.isError, `B's wait answered: ${answer.text}`).toBe(false);
  expect(answer.text, "B's wait resolved with the message sent after A closed").toContain("for-the-waiter-of-b");
  expect(pushes(b), "the waiter took the message, so no channel push duplicates it").toHaveLength(0);
  expect((await whoamiOf(b.relay)).ws_connected, "B still holds its broker WebSocket").toBe(true);
}, 30_000);

test.skipIf(!GENERATION_MEASURABLE)(
  `the global snapshot of a session carries the generation of its relay pid, not the daemon's (${NEEDS_GENERATION})`,
  async () => {
    const tile = await openTile("snapshot");
    let snapshot = null as Awaited<ReturnType<typeof readGlobalSessionIdentityFile>>;
    await eventually(async () => {
      snapshot = await readGlobalSessionIdentityFile(tile.socket, home);
      return snapshot !== null;
    }, "the global snapshot to be written");

    const relayGeneration = await measureWriterGeneration(tile.child.pid);
    expect(relayGeneration, "the relay stand-in has a measurable generation").not.toBeNull();
    const written = snapshot?.writerGeneration;
    expect(written?.pid, "the snapshot names the relay pid, not the daemon pid").toBe(tile.child.pid);
    expect(written?.pid).not.toBe(process.pid);
    expect(written && canonicalWriterGeneration(written), "the snapshot carries the measured generation of the relay").toBe(
      relayGeneration && canonicalWriterGeneration(relayGeneration),
    );
    expect(snapshot?.peerId, "the snapshot belongs to the registered peer").toBe(tile.peerId);
  },
);
