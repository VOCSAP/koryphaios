// Named without a server-/broker- prefix so the CI pure-module job's deny-list
// (card 0bbac537) includes it by default.
// Both message-delivery paths (WS push and poll fallback) are exercised against
// the same pure resolver, not assumed identical.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPeersSession, type PeersSession } from "../shared/peers-session.ts";
import { reachedWithin } from "./_bounded-await.ts";
import {
  WAIT_FOR_MESSAGE_HARD_CAP_SEC,
  WAIT_FOR_MESSAGE_DEFAULT_SEC,
  WAIT_FOR_MESSAGE_MIN_SEC,
  clampWaitTimeoutSec,
  matchesWaitFilter,
  selectFreshWaitCandidates,
  buildWaitPlan,
  selectPeekMatch,
  buildWaiter,
  runWaitForMessage,
  tryResolveWaiters,
  removeWaiter,
  type MessageWaiter,
  type WaitCandidateMessage,
  type WaitPlan,
} from "../shared/wait-for-message.ts";
import { isExempt } from "../scripts/pure-module-partition.ts";

test("hard cap is 115s, strictly under CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS's 120s default", () => {
  expect(WAIT_FOR_MESSAGE_HARD_CAP_SEC).toBe(115);
  expect(WAIT_FOR_MESSAGE_HARD_CAP_SEC).toBeLessThan(120);
});

test.each([
  ["a request above the cap is clamped down to it", 600, WAIT_FOR_MESSAGE_HARD_CAP_SEC],
  ["a request exactly at the cap passes through", 115, 115],
  ["a request well under the cap passes through", 30, 30],
  ["omitted (undefined) falls back to the default", undefined, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["NaN falls back to the default, never propagates", NaN, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["a non-numeric string falls back to the default", "soon", WAIT_FOR_MESSAGE_DEFAULT_SEC],
  // A numeric string is accepted, not rejected by type: this server never
  // validates MCP args against its own inputSchema, and an LLM caller regularly
  // emits a JSON number as a string.
  ["a numeric string is parsed, not silently defaulted", "30", 30],
  ["a numeric string with surrounding whitespace is parsed (Number() trims)", "  45  ", 45],
  ["a numeric string above the cap still clamps", "600", WAIT_FOR_MESSAGE_HARD_CAP_SEC],
  ["a non-numeric-looking string with trailing text still falls to the default", "30s", WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["zero falls back to the default", 0, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["a negative value falls back to the default", -30, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["Infinity falls back to the default", Infinity, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["a boolean is rejected by type (was: coerced to 1/0), falls to the default", true, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["a tiny positive fraction floors to WAIT_FOR_MESSAGE_MIN_SEC, not near-zero", 0.0001, WAIT_FOR_MESSAGE_MIN_SEC],
  ["a value between 0 and the floor also floors to WAIT_FOR_MESSAGE_MIN_SEC", 0.5, WAIT_FOR_MESSAGE_MIN_SEC],
])("clampWaitTimeoutSec: %s", (_name, input, expected) => {
  expect(clampWaitTimeoutSec(input)).toBe(expected);
});

test("clampWaitTimeoutSec: provably never throws, not even on a Symbol or a valueOf that throws", () => {
  // clampWaitTimeoutSec only ever evaluates typeof on the input, never Number()
  // on an arbitrary value, so a hostile valueOf/toString cannot make it throw.
  expect(() => clampWaitTimeoutSec(Symbol("x"))).not.toThrow();
  expect(clampWaitTimeoutSec(Symbol("x"))).toBe(WAIT_FOR_MESSAGE_DEFAULT_SEC);
  const poisoned = { valueOf(): number { throw new Error("boom"); } };
  expect(() => clampWaitTimeoutSec(poisoned)).not.toThrow();
  expect(clampWaitTimeoutSec(poisoned)).toBe(WAIT_FOR_MESSAGE_DEFAULT_SEC);
  expect(() => clampWaitTimeoutSec(10n)).not.toThrow(); // BigInt
  expect(() => clampWaitTimeoutSec(null)).not.toThrow();
});

// --- Filter matching ---

const fromA: Pick<WaitCandidateMessage, "from_peer_id"> = { from_peer_id: "peer-a" };
const fromB: Pick<WaitCandidateMessage, "from_peer_id"> = { from_peer_id: "peer-b" };

test("matchesWaitFilter: no filter matches any sender", () => {
  expect(matchesWaitFilter(fromA, undefined)).toBe(true);
  expect(matchesWaitFilter(fromB, null)).toBe(true);
});

test("matchesWaitFilter: filter matches only the named sender", () => {
  expect(matchesWaitFilter(fromA, "peer-a")).toBe(true);
  expect(matchesWaitFilter(fromB, "peer-a")).toBe(false);
});

// --- Waiter registry ---

function candidate(from_peer_id: string, id = 1): WaitCandidateMessage {
  return { id, from_peer_id, from_summary: "", from_host: "h", from_cwd: "/c", text: "hi", sent_at: "2026-08-26T00:00:00.000Z" };
}

function waiterFor(filterPeerId: string | undefined, sink: WaitCandidateMessage[]): MessageWaiter {
  return { filterPeerId, resolve: (m) => sink.push(m) };
}

test("buildWaitPlan: clamps timeout_sec and converts to milliseconds", () => {
  expect(buildWaitPlan({ timeout_sec: 600 }).timeoutMs).toBe(WAIT_FOR_MESSAGE_HARD_CAP_SEC * 1000);
  expect(buildWaitPlan({ timeout_sec: 30 }).timeoutMs).toBe(30 * 1000);
  expect(buildWaitPlan({}).timeoutMs).toBe(WAIT_FOR_MESSAGE_DEFAULT_SEC * 1000);
});

test("buildWaitPlan: trims from_peer_id, blank becomes undefined", () => {
  expect(buildWaitPlan({ from_peer_id: "  peer-a  " }).filterPeerId).toBe("peer-a");
  expect(buildWaitPlan({ from_peer_id: "   " }).filterPeerId).toBeUndefined();
  expect(buildWaitPlan({}).filterPeerId).toBeUndefined();
  expect(buildWaitPlan(undefined).filterPeerId).toBeUndefined();
});

test("buildWaitPlan: a non-string from_peer_id is treated as absent", () => {
  expect(buildWaitPlan({ from_peer_id: 42 }).filterPeerId).toBeUndefined();
});

test("selectPeekMatch: returns the first candidate MATCHING THE FILTER, not merely fresh[0]", () => {
  const candidates = [candidate("peer-b", 1), candidate("peer-a", 2)];
  const match = selectPeekMatch(candidates, "peer-a");
  expect(match?.id).toBe(2); // NOT candidates[0], which is peer-b
});

test("selectPeekMatch: an unfiltered plan matches the first candidate", () => {
  const candidates = [candidate("peer-b", 1), candidate("peer-a", 2)];
  expect(selectPeekMatch(candidates, undefined)?.id).toBe(1);
});

test("selectPeekMatch: no match returns undefined", () => {
  expect(selectPeekMatch([candidate("peer-b", 1)], "peer-a")).toBeUndefined();
});

test("buildWaiter: carries the plan's filterPeerId onto the waiter -- acceptance criterion 1 on the REAL wait, not just the peek (team-lead: worst of the seven mutations)", () => {
  const sink: WaitCandidateMessage[] = [];
  const onMatch = (m: WaitCandidateMessage) => sink.push(m);
  const waiter = buildWaiter({ timeoutMs: 1000, filterPeerId: "peer-a" }, onMatch);
  expect(waiter.filterPeerId).toBe("peer-a");
  expect(waiter.resolve).toBe(onMatch);
});

test("buildWaiter: an unfiltered plan produces an unfiltered waiter", () => {
  const waiter = buildWaiter({ timeoutMs: 1000, filterPeerId: undefined }, () => {});
  expect(waiter.filterPeerId).toBeUndefined();
});

// The opportunistic peek must apply the same notifiedMessageIds filter
// pollFallback does, or an undelivered-but-already-seen message resolves the
// wait with stale content instead of waiting for a new one.
// This is the tool's nominal case (an agent already mid-exchange), not an edge
// case.

test("selectFreshWaitCandidates: drops a candidate whose id was already notified this session", () => {
  const already = new Set([1]);
  const result = selectFreshWaitCandidates([candidate("peer-a", 1), candidate("peer-a", 2)], already);
  expect(result.map((m) => m.id)).toEqual([2]);
});

test("selectFreshWaitCandidates: an empty notified set drops nothing", () => {
  const result = selectFreshWaitCandidates([candidate("peer-a", 1)], new Set());
  expect(result.map((m) => m.id)).toEqual([1]);
});

test("an already-notified message does not resolve a wait_for_message opportunistic peek (bites the exact server.ts bug)", () => {
  // Reproduces server.ts's opportunistic-peek line: peek() -> filter fresh ->
  // find a filter match. Before the fix this test guards, that line skipped
  // the notifiedMessageIds filter entirely.
  const alreadyNotified = new Set([1]);
  const peeked = [candidate("peer-a", 1)]; // id 1: already dispatched via mcp.notification() earlier
  const fresh = selectFreshWaitCandidates(peeked, alreadyNotified);
  const preMatch = fresh.find((m) => matchesWaitFilter(m, "peer-a"));
  expect(preMatch).toBeUndefined(); // must NOT resolve on stale content
});

test("tryResolveWaiters: a message from a third peer during a filtered wait resolves nothing and leaves the waiter untouched (acceptance criterion 1)", () => {
  const sinkA: WaitCandidateMessage[] = [];
  const waitingForA = waiterFor("peer-a", sinkA);
  const { remaining, resolved } = tryResolveWaiters([waitingForA], candidate("peer-c", 42));
  expect(resolved).toEqual([]);
  expect(remaining).toEqual([waitingForA]);
  expect(remaining[0]).toBe(waitingForA); // same object, not a copy -- "untouched"
  expect(sinkA).toEqual([]); // resolve() was never called: nothing consumed by this waiter
});

test("tryResolveWaiters: an unfiltered waiter resolves on any sender", () => {
  const sink: WaitCandidateMessage[] = [];
  const w = waiterFor(undefined, sink);
  const { remaining, resolved } = tryResolveWaiters([w], candidate("peer-a"));
  expect(resolved).toEqual([w]);
  expect(remaining).toEqual([]);
});

test("tryResolveWaiters: two waiters with different filters -- only the matching one resolves, the other's array position/identity survives", () => {
  const sinkA: WaitCandidateMessage[] = [];
  const sinkB: WaitCandidateMessage[] = [];
  const waitingForA = waiterFor("peer-a", sinkA);
  const waitingForB = waiterFor("peer-b", sinkB);
  const { remaining, resolved } = tryResolveWaiters([waitingForA, waitingForB], candidate("peer-a"));
  expect(resolved).toEqual([waitingForA]);
  expect(remaining).toEqual([waitingForB]);
});

test("tryResolveWaiters: does not mutate its input array", () => {
  const w = waiterFor(undefined, []);
  const input: MessageWaiter[] = [w];
  tryResolveWaiters(input, candidate("peer-a"));
  expect(input).toEqual([w]);
  expect(input.length).toBe(1);
});

test("removeWaiter: removes exactly the target waiter by identity, others survive", () => {
  const w1 = waiterFor("peer-a", []);
  const w2 = waiterFor("peer-b", []);
  const after = removeWaiter([w1, w2], w1);
  expect(after).toEqual([w2]);
});

test("removeWaiter then tryResolveWaiters: a removed (cancelled/expired) waiter is never resolved by a later candidate (acceptance criteria 2 and 3)", () => {
  const sink: WaitCandidateMessage[] = [];
  const w = waiterFor(undefined, sink);
  const stillWaiting = removeWaiter([w], w); // simulates a timeout/cancellation cleanup
  const { resolved } = tryResolveWaiters(stillWaiting, candidate("peer-a"));
  expect(resolved).toEqual([]);
  expect(sink).toEqual([]); // never called: nothing was consumed for this waiter
});

// An orphaned waiter (a dead abort signal that never fires) is at worst a
// resource that outlives its usefulness up to WAIT_FOR_MESSAGE_HARD_CAP_SEC,
// not a lost message: wait_for_message never consumes via the broker's
// poll-messages endpoint.

test("registry leak check, RESOLUTION exit: a resolved waiter is gone, and a later candidate finds nobody left", () => {
  const sink: WaitCandidateMessage[] = [];
  const w = waiterFor("peer-a", sink);
  const afterMatch = tryResolveWaiters([w], candidate("peer-a", 1));
  expect(afterMatch.resolved).toEqual([w]);
  expect(afterMatch.remaining).toEqual([]);

  const afterNextCandidate = tryResolveWaiters(afterMatch.remaining, candidate("peer-a", 2));
  expect(afterNextCandidate.resolved).toEqual([]);
  expect(afterNextCandidate.remaining).toEqual([]);
});

test("registry leak check, EXPIRATION exit: an expired waiter is gone, and a later candidate finds nobody left", () => {
  const sink: WaitCandidateMessage[] = [];
  const w = waiterFor("peer-a", sink);
  const afterExpiry = removeWaiter([w], w); // what server.ts's setTimeout callback does
  expect(afterExpiry).toEqual([]);

  const { resolved } = tryResolveWaiters(afterExpiry, candidate("peer-a"));
  expect(resolved).toEqual([]);
  expect(sink).toEqual([]);
});

test("registry leak check, CANCELLATION exit: an aborted waiter is gone, and a later candidate finds nobody left", () => {
  const sink: WaitCandidateMessage[] = [];
  const w = waiterFor(undefined, sink);
  const afterAbort = removeWaiter([w], w); // what server.ts's abort listener does
  expect(afterAbort).toEqual([]);

  const { resolved } = tryResolveWaiters(afterAbort, candidate("peer-c"));
  expect(resolved).toEqual([]);
  expect(sink).toEqual([]);
});

test("registry leak check: resolving via WS while an expiry timer is still pending leaves no duplicate entry", () => {
  const sink: WaitCandidateMessage[] = [];
  const w = waiterFor("peer-a", sink);
  const other = waiterFor("peer-b", []);
  const { remaining, resolved } = tryResolveWaiters([w, other], candidate("peer-a"));
  expect(resolved).toEqual([w]);
  expect(remaining).toEqual([other]);
  // The WS path resolves first (server.ts's connectWs branch). server.ts's
  // own `settled` flag already stops the timer callback from acting a second
  // time on the SAME waiter, so this is defense in depth, not a documented
  // gap: it proves the underlying primitive is ALSO safe on its own terms --
  // calling removeWaiter again on an already-absent waiter must be a no-op,
  // never resurrecting or duplicating it, and must leave an UNRELATED
  // still-pending waiter alone.
  const afterLateTimerCleanup = removeWaiter(remaining, w);
  expect(afterLateTimerCleanup).toEqual([other]);
  expect(afterLateTimerCleanup.length).toBe(1);
});

// --- Both delivery paths, simulated with the exact candidate shape each produces ---

test("resolves a waiter the way connectWs's WS push handler would (frame.type === 'message')", () => {
  const wsFrame: WaitCandidateMessage = {
    id: 7,
    from_peer_id: "peer-a",
    from_summary: "reviewing",
    from_host: "DESKTOP-X",
    from_cwd: "/repo",
    text: "here's the answer",
    sent_at: "2026-08-26T09:00:00.000Z",
  };
  const sink: WaitCandidateMessage[] = [];
  const { resolved } = tryResolveWaiters([waiterFor("peer-a", sink)], wsFrame);
  expect(resolved.length).toBe(1);
  resolved[0]!.resolve(wsFrame);
  expect(sink).toEqual([wsFrame]);
});

test("resolves a waiter the way pollFallback's /peek-messages loop would (fresh, undelivered)", () => {
  const peeked: WaitCandidateMessage = {
    id: 8,
    from_peer_id: "peer-a",
    from_summary: "reviewing",
    from_host: "DESKTOP-X",
    from_cwd: "/repo",
    text: "here's the answer, via poll fallback",
    sent_at: "2026-08-26T09:05:00.000Z",
  };
  const sink: WaitCandidateMessage[] = [];
  const { resolved } = tryResolveWaiters([waiterFor("peer-a", sink)], peeked);
  expect(resolved.length).toBe(1);
  resolved[0]!.resolve(peeked);
  expect(sink).toEqual([peeked]);
});

// --- CI collection proof (measured, not assumed) ---

test("a file named tests/wait-for-message-logic.test.ts is collected by the CI pure-module job", () => {
  expect(isExempt("wait-for-message-logic.test.ts")).toBe(false);
});

test("the same file under a server-/broker- prefix would NOT be collected (the exemption this file avoids)", () => {
  expect(isExempt("server-wait-for-message.test.ts")).toBe(true);
  expect(isExempt("broker-wait-for-message.test.ts")).toBe(true);
});

// --- The real peers session, driven over an in-memory MCP transport ---

interface Wire {
  paths: string[];
  /** What both /peek-messages and /poll-messages answer with. */
  mailbox: WaitCandidateMessage[];
}

class FakeSocket {
  static CLOSED = 3;
  readyState = 0;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface Rig {
  session: PeersSession;
  client: Client;
  wire: Wire;
  sockets: FakeSocket[];
  channel: Array<{ method: string; params?: Record<string, unknown> }>;
  home: string;
}

const rigs: Rig[] = [];

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.client.close();
    await rig.session.close("bye");
    rmSync(rig.home, { recursive: true, force: true });
  }
});

async function openRig(pollFallbackIntervalMs = 3_600_000): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), "cp-wait-logic-"));
  const wire: Wire = { paths: [], mailbox: [] };
  const sockets: FakeSocket[] = [];
  class RecordedSocket extends FakeSocket {
    constructor() {
      super();
      sockets.push(this);
    }
  }
  const brokerFetch = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    wire.paths.push(path);
    if (path === "/register") {
      const body = JSON.parse(String(init?.body)) as { role?: string };
      return Response.json({ peer_id: "peer-1", instance_token: "token-1", inbox_binding: null, role: body.role ?? null });
    }
    if (path === "/peek-messages" || path === "/poll-messages") return Response.json({ messages: wire.mailbox });
    return Response.json({ ok: true });
  };
  const session = createPeersSession(
    {
      env: { XDG_CONFIG_HOME: home, APPDATA: home, CLAUDE_PEERS_PORT: "17999", CLAUDE_PEERS_LOG_DIR: join(home, "logs") },
      cwd: home,
      pid: 777,
      ppid: 4242,
      stdinIsTty: false,
    },
    {
      log: { log: () => {}, logError: () => {} },
      home,
      hostname: () => "test-host",
      ensureBroker: async () => {},
      measureWriterGeneration: async () => null,
      settings: {
        contextResumeKeyTtlMs: 300_000,
        pollFallbackIntervalMs,
        heartbeatIntervalMs: 3_600_000,
        disconnectBoundMs: 3_000,
        wsReconnectInitialMs: 60_000,
      },
      fetch: brokerFetch as unknown as typeof fetch,
      WebSocket: RecordedSocket as unknown as typeof WebSocket,
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "wait-logic-test", version: "1.0.0" });
  const channel: Rig["channel"] = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === "notifications/claude/channel") channel.push(notification);
  };
  await client.connect(clientTransport);
  const rig: Rig = { session, client, wire, sockets, channel, home };
  rigs.push(rig);
  await session.ready;
  return rig;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  await reachedWithin(
    (async () => {
      while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
    })(),
    what,
    3000
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function callsTo(rig: Rig, path: string): number {
  return rig.wire.paths.filter((p) => p === path).length;
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
}

/** The session's socket, opened: the WebSocket path is live and pollFallback stands down. */
async function openSocket(rig: Rig): Promise<FakeSocket> {
  await until(() => rig.sockets.length >= 1, "the session's WebSocket");
  const socket = rig.sockets[0]!;
  socket.emit("open");
  return socket;
}

/** A wait_for_message that has peeked once and registered its waiter. */
async function startWait(rig: Rig, args: Record<string, unknown> = {}): Promise<{ waiting: Promise<unknown> }> {
  const before = callsTo(rig, "/peek-messages");
  const waiting = rig.client.callTool({ name: "wait_for_message", arguments: { timeout_sec: 60, ...args } });
  await until(() => callsTo(rig, "/peek-messages") > before, "the wait's own peek");
  await flush();
  return { waiting };
}

function frame(from: string, id: number, text: string): { data: string } {
  return { data: JSON.stringify({ type: "message", ...candidate(from, id), text }) };
}

async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => false), flush().then(() => true)]);
}

test("a WebSocket message with no wait pending is pushed to the channel", async () => {
  const rig = await openRig();
  const socket = await openSocket(rig);
  socket.emit("message", frame("peer-a", 11, "no waiter here"));
  await until(() => rig.channel.length === 1, "the channel notification");
  expect(String(rig.channel[0]!.params?.content)).toContain("no waiter here");
});

test("a WebSocket message resolves the pending wait_for_message and is not also pushed to the channel", async () => {
  const rig = await openRig();
  const socket = await openSocket(rig);
  const { waiting } = await startWait(rig);
  socket.emit("message", frame("peer-a", 11, "answer via the websocket"));
  const result = await reachedWithin(waiting, "the wait resolved by the WebSocket frame", 2000);
  expect(textOf(result)).toContain("answer via the websocket");
  await flush();
  expect(rig.channel, "a message handed to its waiter was also pushed as a channel notification").toEqual([]);
  expect(callsTo(rig, "/poll-messages"), "the wait consumed the message through /poll-messages").toBe(0);
});

test("a WebSocket message from another sender than the wait's from_peer_id is pushed and leaves the wait pending", async () => {
  const rig = await openRig();
  const socket = await openSocket(rig);
  const { waiting } = await startWait(rig, { from_peer_id: "peer-z" });
  socket.emit("message", frame("peer-a", 11, "from the wrong sender"));
  await until(() => rig.channel.length === 1, "the channel notification of the unmatched message");
  expect(await stillPending(waiting), "a wait filtered on peer-z resolved with a message from peer-a").toBe(true);
  socket.emit("message", frame("peer-z", 12, "from the awaited sender"));
  const result = await reachedWithin(waiting, "the wait resolved by the awaited sender", 2000);
  expect(textOf(result)).toContain("from the awaited sender");
});

test("pollFallback pushes a peeked message to the channel when no wait is pending", async () => {
  const rig = await openRig(10);
  rig.wire.mailbox = [{ ...candidate("peer-a", 21), text: "peeked with no waiter" }];
  await until(() => rig.channel.length === 1, "the channel notification from the poll");
  expect(String(rig.channel[0]!.params?.content)).toContain("peeked with no waiter");
  expect(callsTo(rig, "/poll-messages")).toBe(0);
});

test("pollFallback resolves the pending wait_for_message instead of pushing to the channel", async () => {
  const rig = await openRig(10);
  const socket = await openSocket(rig);
  const { waiting } = await startWait(rig);
  rig.wire.mailbox = [{ ...candidate("peer-a", 22), text: "answer via the poll fallback" }];
  socket.emit("close");
  const result = await reachedWithin(waiting, "the wait resolved by the poll fallback", 2000);
  expect(textOf(result)).toContain("answer via the poll fallback");
  await flush();
  expect(rig.channel, "a message handed to its waiter was also pushed as a channel notification").toEqual([]);
  expect(callsTo(rig, "/poll-messages"), "the poll fallback consumed the message through /poll-messages").toBe(0);
});

test("wait_for_message peeks without consuming: only check_messages reaches /poll-messages", async () => {
  const rig = await openRig();
  rig.wire.mailbox = [{ ...candidate("peer-a", 31), text: "already waiting" }];
  const result = await reachedWithin(
    rig.client.callTool({ name: "wait_for_message", arguments: { timeout_sec: 60 } }),
    "the wait answered by its opportunistic peek",
    2000
  );
  expect(textOf(result)).toContain("already waiting");
  expect(callsTo(rig, "/peek-messages")).toBeGreaterThanOrEqual(1);
  expect(callsTo(rig, "/poll-messages"), "an expired or cancelled wait would destroy the message it read").toBe(0);

  await rig.client.callTool({ name: "check_messages", arguments: {} });
  expect(callsTo(rig, "/poll-messages")).toBe(1);
});

test("the peers session serves a wait_for_message tool", async () => {
  const rig = await openRig();
  const names = (await rig.client.listTools()).tools.map((tool) => tool.name);
  expect(names).toContain("wait_for_message");
});

// These tests execute runWaitForMessage directly against fake dependencies --
// no network, no real timer -- because a source scan cannot prove a peeked
// candidate's freshness-filter result is actually used rather than computed and
// discarded, that the timer is armed with the clamped value, that cancellation
// actually suppresses a later result, or that the timer, waiter and cancel
// paths cannot double-fire against each other.
// Running the real decision code directly is what proves each of those
// properties.

/** A promise plus its resolver, exposed for a test to drive timing by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("runWaitForMessage: an opportunistic peek match resolves immediately, without registering a waiter", async () => {
  const marked: number[] = [];
  let registerCalled = false;
  const outcome = await runWaitForMessage(
    { from_peer_id: "peer-a" },
    {
      peek: async () => [candidate("peer-a", 5)],
      notifiedIds: new Set(),
      markNotified: (id) => marked.push(id),
      registerWaiter: () => {
        registerCalled = true;
        return () => {};
      },
      scheduleTimeout: () => () => {},
      onCancelled: () => () => {},
    }
  );
  expect(outcome).toEqual({ kind: "matched", message: candidate("peer-a", 5) });
  expect(marked).toEqual([5]);
  expect(registerCalled).toBe(false);
});

test("runWaitForMessage: an already-notified peek candidate is genuinely filtered out (not merely computed and discarded), falls through to a real waiter", async () => {
  // A previous version of this test used a throwing markNotified as the
  // "must not be called" assertion. That was VACUOUS: markNotified is
  // invoked inside the same try{} that also wraps `await deps.peek()`, so a
  // thrown Error there is caught by the SAME catch block that handles a
  // transient peek error, and falls through to registerWaiter regardless --
  // the test passed identically whether the freshness filter correctly
  // excluded id 1 or a mutation silently discarded it (measured: a mutation
  // that discards selectFreshWaitCandidates's result stayed green against
  // the throwing version). Recording calls in a plain array and asserting on
  // it AFTER the call, with no exception involved, has no such blind spot.
  let registeredPlan: WaitPlan | undefined;
  const markNotifiedCalls: number[] = [];
  const outcome = await runWaitForMessage(
    { from_peer_id: "peer-a" },
    {
      peek: async () => [candidate("peer-a", 1)], // id 1: already notified
      notifiedIds: new Set([1]),
      markNotified: (id) => {
        markNotifiedCalls.push(id);
      },
      registerWaiter: (plan, onMatch) => {
        registeredPlan = plan;
        onMatch(candidate("peer-a", 2));
        return () => {};
      },
      scheduleTimeout: () => () => {},
      onCancelled: () => () => {},
    }
  );
  expect(markNotifiedCalls).toEqual([]); // id 1 must NOT be (re-)marked notified
  expect(registeredPlan?.filterPeerId).toBe("peer-a"); // proves registerWaiter WAS reached
  expect(outcome).toEqual({ kind: "matched", message: candidate("peer-a", 2) });
});

test("runWaitForMessage: the timer is armed with the CLAMPED, millisecond value, and bounds the peek phase too (fires before peek resolves)", async () => {
  let scheduledMs: number | undefined;
  let registerCalled = false;
  const outcomePromise = runWaitForMessage(
    { timeout_sec: 600 }, // must clamp to 115s -> 115000ms, not 600000
    {
      peek: () => new Promise<WaitCandidateMessage[]>(() => {}), // never resolves on its own
      notifiedIds: new Set(),
      markNotified: () => {},
      registerWaiter: () => {
        registerCalled = true;
        return () => {};
      },
      scheduleTimeout: (ms, onExpire) => {
        scheduledMs = ms;
        onExpire(); // fire immediately: the peek is still pending
        return () => {};
      },
      onCancelled: () => () => {},
    }
  );
  const outcome = await outcomePromise;
  expect(scheduledMs).toBe(WAIT_FOR_MESSAGE_HARD_CAP_SEC * 1000);
  expect(outcome).toEqual({ kind: "timed_out" });
  expect(registerCalled).toBe(false); // never reached: the peek itself was bounded
});

test("runWaitForMessage: firing the timer AFTER a waiter is registered unregisters it and times out", async () => {
  const peeked = deferred<WaitCandidateMessage[]>();
  const registered = deferred<void>();
  let unregisterCalled = false;
  let fireTimer: (() => void) | undefined;
  const outcomePromise = runWaitForMessage({}, {
    peek: () => peeked.promise,
    notifiedIds: new Set(),
    markNotified: () => {},
    registerWaiter: () => {
      registered.resolve();
      return () => {
        unregisterCalled = true;
      };
    },
    scheduleTimeout: (ms, onExpire) => {
      fireTimer = onExpire;
      return () => {};
    },
    onCancelled: () => () => {},
  });
  peeked.resolve([]);
  await registered.promise;
  fireTimer?.();
  const outcome = await outcomePromise;
  expect(outcome).toEqual({ kind: "timed_out" });
  expect(unregisterCalled).toBe(true);
});

test("runWaitForMessage: a waiter match cancels the pending timer and unsubscribes cancellation", async () => {
  const peeked = deferred<WaitCandidateMessage[]>();
  const registered = deferred<(m: WaitCandidateMessage) => void>();
  let timerCancelled = false;
  let cancelUnsubscribed = false;
  const outcomePromise = runWaitForMessage({ from_peer_id: "peer-a" }, {
    peek: () => peeked.promise,
    notifiedIds: new Set(),
    markNotified: () => {},
    registerWaiter: (_plan, onMatch) => {
      registered.resolve(onMatch);
      return () => {};
    },
    scheduleTimeout: () => () => {
      timerCancelled = true;
    },
    onCancelled: () => () => {
      cancelUnsubscribed = true;
    },
  });
  peeked.resolve([]);
  const onMatch = await registered.promise;
  onMatch(candidate("peer-a", 9));
  const outcome = await outcomePromise;
  expect(outcome).toEqual({ kind: "matched", message: candidate("peer-a", 9) });
  expect(timerCancelled).toBe(true);
  expect(cancelUnsubscribed).toBe(true);
});

// Cancellation exercised only before any waiter exists does not catch a
// mutation that resolves 'cancelled' directly, bypassing cleanup: with no
// waiter registered yet, the missing unregister call has nothing to matter
// against.
// Left unchecked, an orphaned waiter would stay registered after its own call
// already resolved cancelled, and a later message matching its filter would
// resolve it anyway -- consumed by a call whose caller already stopped
// listening.
test("runWaitForMessage: cancellation AFTER the waiter is registered unregisters it exactly once", async () => {
  const peeked = deferred<WaitCandidateMessage[]>();
  const registered = deferred<void>();
  let unregisterCalls = 0;
  let cancelFn: (() => void) | undefined;
  const outcomePromise = runWaitForMessage({}, {
    peek: () => peeked.promise,
    notifiedIds: new Set(),
    markNotified: () => {},
    registerWaiter: () => {
      registered.resolve();
      return () => {
        unregisterCalls++;
      };
    },
    scheduleTimeout: () => () => {},
    onCancelled: (onCancel) => {
      cancelFn = onCancel;
      return () => {};
    },
  });
  peeked.resolve([]); // no match: falls through to registration
  await registered.promise; // the waiter is now really registered
  cancelFn?.();
  const outcome = await outcomePromise;
  expect(outcome).toEqual({ kind: "cancelled" });
  expect(unregisterCalls).toBe(1);
});

test("runWaitForMessage: cancellation while the peek is still in flight yields 'cancelled' and suppresses the later peek result entirely", async () => {
  const peeked = deferred<WaitCandidateMessage[]>();
  let cancelFn: (() => void) | undefined;
  let registerCalled = false;
  let markNotifiedCalled = false;
  const outcomePromise = runWaitForMessage({}, {
    peek: () => peeked.promise,
    notifiedIds: new Set(),
    markNotified: () => {
      markNotifiedCalled = true;
    },
    registerWaiter: () => {
      registerCalled = true;
      return () => {};
    },
    scheduleTimeout: () => () => {},
    onCancelled: (onCancel) => {
      cancelFn = onCancel;
      return () => {};
    },
  });
  cancelFn?.();
  const outcome = await outcomePromise;
  expect(outcome).toEqual({ kind: "cancelled" });
  // The peek "arrives" late, with what WOULD have been a match -- must be ignored.
  peeked.resolve([candidate("peer-a", 1)]);
  await new Promise((r) => setTimeout(r, 0));
  expect(registerCalled).toBe(false);
  expect(markNotifiedCalled).toBe(false);
});

test("runWaitForMessage: a transient peek() rejection falls through to waiter registration (same catch-and-continue as pollFallback)", async () => {
  let registerCalled = false;
  const outcome = await runWaitForMessage({}, {
    peek: async () => {
      throw new Error("broker unreachable");
    },
    notifiedIds: new Set(),
    markNotified: () => {},
    registerWaiter: (_plan, onMatch) => {
      registerCalled = true;
      onMatch(candidate("peer-a", 1));
      return () => {};
    },
    scheduleTimeout: () => () => {},
    onCancelled: () => () => {},
  });
  expect(registerCalled).toBe(true);
  expect(outcome).toEqual({ kind: "matched", message: candidate("peer-a", 1) });
});

test("runWaitForMessage: a waiter match arriving AFTER the timer already fired is ignored (settled guard, no double-resolve, cleanup runs at most once)", async () => {
  // A prior version of this test asserted only `.not.toThrow()` on the late
  // arrival. That alone is VACUOUS against removing the `settled` guard
  // entirely: JS Promises are single-settle by spec regardless, so a second
  // `resolve()` call never throws and never changes the awaited value either
  // way -- it stayed green when `finish()`'s own `if (settled) return;` was
  // deleted (measured). Counting the waiter's unregister calls closes it:
  // the guard's whole POINT is to run cleanup exactly once, not to protect
  // the return value (the Promise spec already does that for free).
  const registered = deferred<(m: WaitCandidateMessage) => void>();
  let fireTimer: (() => void) | undefined;
  let unregisterCalls = 0;
  const outcomePromise = runWaitForMessage({}, {
    peek: async () => [],
    notifiedIds: new Set(),
    markNotified: () => {},
    registerWaiter: (_plan, onMatch) => {
      registered.resolve(onMatch);
      return () => {
        unregisterCalls++;
      };
    },
    scheduleTimeout: (ms, onExpire) => {
      fireTimer = onExpire;
      return () => {};
    },
    onCancelled: () => () => {},
  });
  const onMatch = await registered.promise;
  fireTimer?.();
  onMatch(candidate("peer-a", 1)); // late arrival, must be a no-op
  const outcome = await outcomePromise;
  expect(outcome).toEqual({ kind: "timed_out" });
  expect(unregisterCalls).toBe(1); // not 0 (never cleaned up), not 2 (cleaned up twice)
});
