// Card a21f1303, H4 volet 3: shared/wait-for-message.ts is a pure module (no
// broker, no server, no bun:sqlite, no timers) so its filter/cap/registry
// logic is tested directly here, no daemon needed.
//
// Named tests/wait-for-message-logic.test.ts (not
// tests/server-wait-for-message.test.ts) deliberately: the CI "pure modules"
// job (.github/workflows/desktop-build.yml, `bun scripts/partition-pure-tests.ts`)
// runs a DENY-list keyed on scripts/pure-module-partition.ts's EXEMPTIONS
// (card 0bbac537) -- only the `broker-`/`server-` filename prefixes (plus two
// exact files) are excluded, everything else runs by default. Measured
// directly against the real isExempt() below, not assumed from the filename
// convention alone.
//
// The two message-delivery paths (WS push in connectWs, poll fallback in
// pollFallback) are exercised here by feeding tryResolveWaiters the exact
// candidate shape each call site produces -- proving the SAME pure resolver
// handles both, and a source-scan proves both call sites actually invoke it
// (not just one, leaving the other a declared-but-unwired consumer).

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// --- Cap measurement (Arbitrage 1, team-lead 2026-08-26) ---

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
  // Team-lead review round 3, 2026-08-26 (U2): a numeric STRING is a
  // realistic input (this server never validates MCP args against its own
  // inputSchema, and an LLM caller regularly emits a JSON number as a
  // string) -- rejecting it by type alone silently substituted the default
  // for what the caller asked for, with no signal. Number() on a primitive
  // string cannot throw, so accepting it does not reopen "never throws".
  ["a numeric string is parsed, not silently defaulted", "30", 30],
  ["a numeric string with surrounding whitespace is parsed (Number() trims)", "  45  ", 45],
  ["a numeric string above the cap still clamps", "600", WAIT_FOR_MESSAGE_HARD_CAP_SEC],
  ["a non-numeric-looking string with trailing text still falls to the default", "30s", WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["zero falls back to the default", 0, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["a negative value falls back to the default", -30, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["Infinity falls back to the default", Infinity, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  // Team-lead review, 2026-08-26 (R6): two reachable inputs used to slip
  // through with no lower bound. `true` used to coerce to the number 1 (a
  // silently-plausible 1-second wait); a tiny positive fraction used to pass
  // through nearly as-is (a sub-millisecond timer, functionally the polling
  // loop this tool exists to remove). Both now floor to
  // WAIT_FOR_MESSAGE_MIN_SEC or fall to the default -- see the two cases
  // below.
  ["a boolean is rejected by type (was: coerced to 1/0), falls to the default", true, WAIT_FOR_MESSAGE_DEFAULT_SEC],
  ["a tiny positive fraction floors to WAIT_FOR_MESSAGE_MIN_SEC, not near-zero", 0.0001, WAIT_FOR_MESSAGE_MIN_SEC],
  ["a value between 0 and the floor also floors to WAIT_FOR_MESSAGE_MIN_SEC", 0.5, WAIT_FOR_MESSAGE_MIN_SEC],
])("clampWaitTimeoutSec: %s", (_name, input, expected) => {
  expect(clampWaitTimeoutSec(input)).toBe(expected);
});

test("clampWaitTimeoutSec: provably never throws, not even on a Symbol or a valueOf that throws", () => {
  // Team-lead review, 2026-08-26 (R6): the doc comment claims "never throws"
  // unconditionally. Before the fix, `Number(requested)` was called on
  // whatever `requested` was, and Number() invokes valueOf/toString on an
  // object -- a hostile one can throw from there. The rewritten clamp only
  // ever runs `typeof requested`, which cannot throw for any value.
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

// --- buildWaitPlan / selectPeekMatch / buildWaiter (team-lead R1, 2026-08-26) ---
// These three replace what used to be five separate inline expressions
// written directly in server.ts's case (clamp, seconds->ms, trim, first-peek-
// match selection, and the waiter's filterPeerId field) -- none reachable by
// execution from a test that cannot import server.ts. A mutation of any one
// of them used to leave this whole suite green, because the only assertions
// touching server.ts were source-scan `toContain` checks, true regardless of
// what the matched substring's own arguments did. Direct execution here
// closes that gap.

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

// --- Opportunistic-peek freshness filter (team-lead finding, 2026-08-26) ---
// server.ts's wait_for_message case peeks once for an already-pending match
// before registering a waiter. That peek must apply the SAME
// notifiedMessageIds filter pollFallback already does (server.ts), or a
// message dispatched via mcp.notification() earlier in the session -- still
// sitting delivered=0 in the broker (WS push and /peek-messages never mark
// delivered) -- would instantly "resolve" a wait with stale, already-seen
// content instead of actually waiting for a NEW one. That is the tool's
// NOMINAL use case (an agent that already exchanged messages, now waiting
// for the next reply), not an edge case.

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

// --- Registry leak checks: the registry must empty on EVERY exit (team-lead
// arbitrage, 2026-08-26). The pure registry is what server.ts's three exit
// sites (a resolved waiter, setTimeout's expiry callback, extra.signal's
// abort listener) all funnel through -- tryResolveWaiters on the resolution
// side, removeWaiter on the other two -- so proving these three leave the
// registry empty, and that a later probe never rediscovers the departed
// waiter, covers all three without needing a live timer or a live
// AbortSignal. A dead extra.signal (never fires) does not reopen zero-loss:
// wait_for_message never calls the broker's consuming /poll-messages, so an
// orphaned waiter is, at worst, a resource that outlives its usefulness for
// up to WAIT_FOR_MESSAGE_HARD_CAP_SEC -- not a lost message. This is exactly
// the residual the setTimeout branch bounds regardless of the signal ever
// firing, so a leaked waiter cannot survive past that cap either way.

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
  // Team-lead review, 2026-08-26: the original fixture called removeWaiter on
  // an ALREADY-EMPTY list, so the assertion held for any implementation that
  // does not fabricate elements out of nothing -- it had no discriminating
  // power. A second, still-pending waiter alongside `w` restores it: a
  // broken removeWaiter (e.g. one that clears the whole list, or that
  // resurrects the just-removed entry) now has something to get wrong.
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
  // Shape of `f` at server.ts:332-341, the WS frame's own fields.
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
  // Shape of `msg` at server.ts:394-410, one row of PollMessagesResponse.messages.
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

// --- Wiring proof: both call sites actually invoke tryResolveWaiters, not just one ---
// (CLAUDE.md: a consumer/producer pairing must be checked by grepping the real
// call, not trusted from a comment -- e.g. DeckApi.onX shipped with zero emitters.)

function extractFunctionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start === -1) throw new Error(`extractFunctionBody: header not found: ${header}`);
  // Bounded to the next top-level declaration/section marker, not the whole
  // file -- avoids a match anywhere below merely because the identifier
  // exists somewhere else in server.ts. Also bounds at the next `case "` (4-
  // space indent, matching the switch's own style) so this same helper
  // extracts a `case "...": {` header's body too, without sweeping in every
  // OTHER case that follows it up to the next function/section marker --
  // team-lead review round 4, 2026-08-26: reused for the wait_for_message
  // case, not duplicated into a second helper.
  const rest = source.slice(start + header.length);
  const nextMarkerRe = /\n(?:function |async function |\/\/ --- | {4}case ")/;
  const end = rest.search(nextMarkerRe);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Strips // line comments and /* block comments *\/ so a match inside a
 * comment doesn't count as a real call (project precedent:
 * project_source_scan_regex_brittle_to_comment_insertion). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Team-lead review, 2026-08-26: a bare `toContain` proves PRESENCE, not the
// ORDER the test's own name asserts. Measured: moving the whole
// tryResolveWaiters resolution block to AFTER connectWs's mcp.notification()
// call left the old toContain-only assertion green, while the agent would
// now receive the same message TWICE (once via the notification that fires
// unconditionally, once via the waiter that still resolves afterward).
// indexOf both and compare positions instead.

test("connectWs's WS message handler calls tryResolveWaiters before falling back to mcp.notification()", () => {
  const source = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf-8");
  const body = stripComments(extractFunctionBody(source, "function connectWs()"));
  expect(body).toContain("tryResolveWaiters(");
  expect(body).toContain("mcp.notification(");
  expect(body.indexOf("tryResolveWaiters(")).toBeLessThan(body.indexOf("mcp.notification("));
});

test("pollFallback calls tryResolveWaiters before falling back to mcp.notification()", () => {
  const source = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf-8");
  const body = stripComments(extractFunctionBody(source, "async function pollFallback()"));
  expect(body).toContain("tryResolveWaiters(");
  expect(body).toContain("mcp.notification(");
  expect(body.indexOf("tryResolveWaiters(")).toBeLessThan(body.indexOf("mcp.notification("));
});

test("server.ts registers a wait_for_message MCP tool", () => {
  // Team-lead review, 2026-08-26: a bare '"wait_for_message"' substring check
  // is fail-open -- it also matches the `case "wait_for_message":` switch
  // label, so deleting the TOOLS array entry entirely (making the tool
  // invisible to every agent, delivered dead) leaves this test green.
  // Anchor on the TOOLS entry's own `name:` key specifically. A regex
  // (round 3, U5) rather than a literal `toContain` so a formatter putting
  // `name:` and the value on separate lines, or varying whitespace, does not
  // produce a gratuitous false red.
  const source = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf-8");
  expect(stripComments(source)).toMatch(/name:\s*"wait_for_message"/);
});

// Team-lead review round 4, 2026-08-26: measured that a ONE-CHARACTER change
// in server.ts -- "/peek-messages" -> "/poll-messages" at either call site --
// left the whole suite green. /poll-messages MARKS messages delivered
// (broker.ts); /peek-messages does not. That single substitution turns
// wait_for_message (or pollFallback) from non-consuming into consuming, so
// an expired/cancelled wait would DESTROY the very messages it just read --
// the zero-message-lost property this whole card is built on holds today
// only because of this literal, nothing guards it. A source-scan is
// generally weak (CLAUDE.md), but this is the one shape where it genuinely
// bites: a bare string literal, no substitutable argument, no branching --
// there is no execution path that could hide the substitution from a text
// match the way a variable or a computed value could.
test("wait_for_message's opportunistic peek and pollFallback both call the non-consuming /peek-messages endpoint, never the consuming /poll-messages one", () => {
  const source = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf-8");
  const waitBody = stripComments(extractFunctionBody(source, 'case "wait_for_message": {'));
  const pollFallbackBody = stripComments(extractFunctionBody(source, "async function pollFallback()"));

  expect(waitBody).toContain('"/peek-messages"');
  expect(waitBody).not.toContain('"/poll-messages"');
  expect(pollFallbackBody).toContain('"/peek-messages"');
  expect(pollFallbackBody).not.toContain('"/poll-messages"');
});

// --- runWaitForMessage: the whole decision, injected (team-lead U1, round 3, 2026-08-26) ---
//
// A mutation battery on an earlier version of server.ts's case (which moved
// only VALUE transforms into the pure module, not the CONTROL FLOW) found 12
// of 13 mutations invisible: no source-scan test can prove a peeked
// candidate's freshness filter result is actually USED (as opposed to
// computed and discarded), that the timer is armed with the CLAMPED value,
// that cancellation actually suppresses a later result, or that two
// concurrent settle paths (timer vs waiter vs cancel) cannot double-fire.
// These tests execute runWaitForMessage directly with fake deps -- no
// network, no real timer -- so each of those properties is proven by running
// the real decision code, not by scanning server.ts's text for a token.

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

// Team-lead review round 4, 2026-08-26: the "cancellation while the peek is
// still in flight" test above only exercises cancellation BEFORE any waiter
// exists. Measured gap: a mutation that resolves "cancelled" directly
// (bypassing finish()'s cleanup) stayed green against that test, because no
// waiter is registered yet at that point for the missing unregister call to
// matter. The uncaught consequence: an orphaned waiter would stay in
// server.ts's pendingWaiters after its own call has already resolved
// cancelled, and a later WS/poll message matching its filter would resolve
// it anyway -- one dead call "consuming" a message (the notifiedMessageIds
// side effect on that path marks it notified) that the agent who actually
// asked for it never sees, since its own tool call already returned.
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
