import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createActivityTracker,
  ACTIVITY_IDLE_MS,
  type Activity
} from "../desktop/src/main/detect/activity.ts";
import { createOscParser } from "../desktop/src/main/detect/osc.ts";
import { findMatchingClose } from "./_braced-body";

// ----- fake clock/timer, shared by sections 1 and 2 ------------------------

interface FakeTimer {
  at: number;
  fn: () => void;
  id: number;
}

function fakeClock() {
  let now = 0;
  const timers: FakeTimer[] = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: number): void => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    /** Fires every due timer in chronological order, then sets `now` to `t`. */
    advanceTo: (t: number): void => {
      for (;;) {
        const due = timers
          .filter((x) => x.at <= t)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
      now = t;
    }
  };
}

// ----- 1. Pure unit tests of createActivityTracker -------------------------

test("starts 'unknown', and observe(0) (no title ever applied) is a no-op", () => {
  const clock = fakeClock();
  const t = createActivityTracker<number>({ idleMs: 3000, ...clock });
  expect(t.state()).toBe("unknown");
  t.observe(0);
  expect(t.state()).toBe("unknown");
});

test("a real titleSeq increase arms 'working' immediately, and notifies the listener", () => {
  const clock = fakeClock();
  const t = createActivityTracker<number>({ idleMs: 3000, ...clock });
  const seen: Activity[] = [];
  t.on((s) => seen.push(s));
  t.observe(1);
  expect(t.state()).toBe("working");
  expect(seen).toEqual(["working"]);
});

test("decays to 'idle' idleMs after the LAST observed increase, front-edge not level", () => {
  const clock = fakeClock();
  const t = createActivityTracker<number>({ idleMs: 3000, ...clock });
  t.observe(1);
  clock.advanceTo(1000);
  t.observe(2); // re-arm: deadline is now 1000+3000=4000, not 0+3000
  clock.advanceTo(2999);
  expect(t.state()).toBe("working");
  clock.advanceTo(4000);
  expect(t.state()).toBe("idle");
});

test("a burst of increases each re-arms the timer -- idle only after the LAST of the burst, not the first (M4)", () => {
  const clock = fakeClock();
  const t = createActivityTracker<number>({ idleMs: 3000, ...clock });
  // Six emissions ~960ms apart, mirroring the design doc's own M4 measurement.
  const times = [0, 960, 1920, 2880, 3840, 4800];
  times.forEach((at, i) => {
    clock.advanceTo(at);
    t.observe(i + 1);
  });
  // Just before last+idleMs: still working.
  clock.advanceTo(4800 + 2999);
  expect(t.state()).toBe("working");
  clock.advanceTo(4800 + 3000);
  expect(t.state()).toBe("idle");
});

test("an unchanged seq (same value re-observed) is a no-op: does not re-arm, does not re-notify", () => {
  const clock = fakeClock();
  const t = createActivityTracker<number>({ idleMs: 3000, ...clock });
  const seen: Activity[] = [];
  t.on((s) => seen.push(s));
  t.observe(1);
  clock.advanceTo(2999);
  t.observe(1); // same value: must NOT re-arm the idle deadline to 2999+3000
  clock.advanceTo(3000);
  expect(t.state()).toBe("idle");
  expect(seen).toEqual(["working", "idle"]);
});

test("stop() cancels the pending idle timer -- no late transition after the tracker is torn down", () => {
  const clock = fakeClock();
  const t = createActivityTracker<number>({ idleMs: 3000, ...clock });
  const seen: Activity[] = [];
  t.on((s) => seen.push(s));
  t.observe(1);
  t.stop();
  clock.advanceTo(10_000);
  expect(t.state()).toBe("working"); // stale, but nothing fired a spurious 'idle'
  expect(seen).toEqual(["working"]);
});

// ----- 2. Behavioural replay of the real fixture ----------------------------

type Chunk = { t: number; data: string };
const FIXTURES = join(import.meta.dir, "pty-harness", "fixtures");
const load = (name: string): Chunk[] => JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));

function replay(chunks: Chunk[], idleMs: number = ACTIVITY_IDLE_MS) {
  const clock = fakeClock();
  const osc = createOscParser();
  const tracker = createActivityTracker<number>({ idleMs, ...clock });
  const sorted = [...chunks].sort((a, b) => a.t - b.t);
  let idx = 0;
  return {
    /**
     * Feeds every not-yet-delivered chunk whose own timestamp is <= t (in
     * order, advancing the clock to each one's real t so its idle-timer
     * side effects land at the right moment), THEN advances to t itself and
     * reads state -- checkpoints must be queried with non-decreasing t, same
     * as a real PTY stream.
     */
    stateAt: (t: number): Activity => {
      while (idx < sorted.length && sorted[idx]!.t <= t) {
        const c = sorted[idx]!;
        clock.advanceTo(c.t);
        const snap = osc.feed(c.data);
        tracker.observe(snap.titleSeq);
        idx++;
      }
      clock.advanceTo(t);
      return tracker.state();
    }
  };
}

test("real fixture replay (turn-chunks-inherited-env.json): unknown before the first title, working through the isolated early titles, idle in the real gap, working through the sustained alternation -- MEASURED sequence, see file header for the documented divergence from the design doc's own illustrative numbers", () => {
  const chunks = load("turn-chunks-inherited-env.json");
  const r = replay(chunks);

  expect(r.stateAt(200)).toBe("unknown"); // before t=297, nothing observed yet
  expect(r.stateAt(2000)).toBe("working"); // t=297's title, well inside its 3s window
  expect(r.stateAt(8000)).toBe("idle"); // real gap: 1487+3000=4487 fired, next title only at 11051
  expect(r.stateAt(11500)).toBe("working"); // t=11051 re-armed it
  expect(r.stateAt(19850)).toBe("working"); // sustained alternation + t=17769 keep it armed past the fixture's last byte (t=19879)
  // Extrapolated past the fixture's own captured window: the LAST real
  // observation (t=17769) + idleMs = 20769 -- by 25000 it must have decayed,
  // proving the mechanism does eventually reach 'idle' rather than being
  // stuck 'working' by construction.
  expect(r.stateAt(25_000)).toBe("idle");
});

// ----- 3. Negative control: no OSC 0 at all --------------------------------

// Strips every well-formed OSC 0/2 sequence from real captured bytes -- an
// honest stand-in for "an agent-kind whose CLI paints everything but the
// title" (design doc section 6, "moitie 2" of the coverage audit: codex,
// gemini, a bare shell, sandbox -- unmeasured, SUPPOSE). None of the 8
// fixtures under tests/pty-harness/fixtures/ are naturally OSC-0-free (even
// a resting screen paints the idle glyph, design doc section 2 fact 2), so
// this constructs the negative control from real bytes rather than
// fabricating a session from scratch.
function stripOsc0(data: string): string {
  // eslint-disable-next-line no-control-regex -- OSC 0/2 are ESC ] 0|2 ; ... BEL|ST
  return data.replace(/\x1b\]0;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\]2;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

test("stripping OSC 0 from the real fixture (simulating a title-blind agent-kind): titleSeq never increases, activity stays 'unknown' forever -- never decays to 'idle'", () => {
  const rawChunks = load("turn-chunks-inherited-env.json");
  const strippedChunks = rawChunks.map((c) => ({ t: c.t, data: stripOsc0(c.data) }));

  // The assertions below alone are vacuous against a mutant stripOsc0 that
  // strips the whole chunk instead of just OSC 0 -- both read all-'unknown' for
  // different reasons.
  // Pins that the strip is surgical: a known substring outside any OSC 0/2
  // sequence must survive.
  const strippedText = strippedChunks.map((c) => c.data).join("");
  expect(strippedText).toContain("v2.1.229");

  const r = replay(strippedChunks);
  expect(r.stateAt(200)).toBe("unknown");
  expect(r.stateAt(11500)).toBe("unknown"); // where the real fixture was 'working'
  expect(r.stateAt(19850)).toBe("unknown");
  expect(r.stateAt(60_000)).toBe("unknown"); // long past any idleMs window -- still unknown, not idle
});

test("stripOsc0 sanity: it actually removes the titles this fixture is known to carry (guards the negative control itself against a no-op strip)", () => {
  const chunks = load("turn-chunks-inherited-env.json");

  const rawParser = createOscParser();
  let rawSeq = 0;
  for (const c of chunks) rawSeq = rawParser.feed(c.data).titleSeq;
  expect(rawSeq).toBeGreaterThan(0);

  const strippedParser = createOscParser();
  let strippedSeq = 0;
  for (const c of chunks) strippedSeq = strippedParser.feed(stripOsc0(c.data)).titleSeq;
  expect(strippedSeq).toBe(0);
});

// ----- 4. Wiring proof: session-service.ts's pty.on('data') handler --------

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");
const PTY_DATA_HANDLER_ANCHOR = "this.pty.on('data', (e: { id: string; data: string }) => {";

function extractPtyDataHandlerBody(src: string): string {
  const start = src.indexOf(PTY_DATA_HANDLER_ANCHOR);
  if (start === -1) {
    throw new Error(
      "PTY_DATA_HANDLER_ANCHOR not found in session-service.ts -- the pty.on('data', ...) " +
        "handler was renamed or reshaped; update the anchor in tests/desktop-activity.test.ts"
    );
  }
  const braceStart = start + PTY_DATA_HANDLER_ANCHOR.length - 1;
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error("PTY_DATA_HANDLER_ANCHOR found but its brace block never closed");
}

test("pty.on('data') wires activityTrackerFor(e.id).observe(...) with the EXACT titleSeq oscParserFor(e.id).feed(e.data) returned -- not e.id, not discarded, not a literal", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const handlerBody = extractPtyDataHandlerBody(src);
  // A regular `function`, NOT an arrow: the extracted body reads `this.*`
  // and only a regular function's `this` is rebindable via `.call()` --
  // an arrow function would close over this test's own module-level
  // `this` (undefined) and every `this.*` read below would throw instead
  // of exercising the stub.
  const fnSrc = `function(e) ${handlerBody}`;
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const handler = new Function("return " + fnSrc)() as (this: unknown, e: { id: string; data: string }) => void;

  const observeCalls: Array<{ id: string; seq: number }> = [];
  const self = {
    emit: () => {},
    outputAt: { set: () => {} },
    thinkingDetector: { feed: () => {} },
    quotaGateActive: () => false,
    quotaDetector: { feed: () => {} },
    attentionDetector: { feed: () => {} },
    startupAckDetector: { feed: () => {} },
    screenGuard: { feed: () => {} },
    oscParserFor: (_id: string) => ({
      // Sentinel value distinguishable from e.id, from 0, and from any small literal.
      feed: (_data: string) => ({ title: null, progress: null, notify: null, titleSeq: 4242 })
    }),
    activityTrackerFor: (id: string) => ({
      observe: (seq: number) => observeCalls.push({ id, seq })
    })
  };

  handler.call(self, { id: "session-under-test", data: "irrelevant bytes" });

  expect(observeCalls).toEqual([{ id: "session-under-test", seq: 4242 }]);
});

// Balances braces from openIdx (which must point at an opening brace) and
// returns the slice inclusive of both braces, so callers can wrap it directly
// as `function(x) ${body}` without re-adding braces.
// A different, unrelated helper elsewhere uses the opposite, exclusive
// convention -- the two must not be confused for each other, so this one is
// kept local rather than imported under the same name.
function extractBracedBody(src: string, openIdx: number): string {
  return src.slice(openIdx, findMatchingClose(src, openIdx, "{", "}"));
}

function extractByAnchor(src: string, anchor: string, label: string): string {
  const start = src.indexOf(anchor);
  if (start === -1) {
    throw new Error(`${label}: anchor not found in source -- renamed or reshaped?`);
  }
  return extractBracedBody(src, start + anchor.length - 1);
}

// ----- 5. Exit-path proof (B1): never CREATE an 'idle' the tracker never
// observed --------------------------------------------------------------

const PTY_EXIT_HANDLER_ANCHOR =
  "this.pty.on('exit', ({ id, exitCode }: { id: string; exitCode: number }) => {";

function makeExitHandler() {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = extractByAnchor(src, PTY_EXIT_HANDLER_ANCHOR, "pty.on('exit') handler");
  // The real handler destructures its single arg (`{ id, exitCode }`), not a
  // plain `e` -- the wrapper must reproduce that shape or `id`/`exitCode`
  // are unbound inside the extracted body.
  const fnSrc = `function({ id, exitCode }) ${body}`;
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  return new Function("return " + fnSrc)() as (
    this: unknown,
    e: { id: string; exitCode: number }
  ) => void;
}

function makeExitSelf(id: string, initialActivity: Activity) {
  return {
    defs: [] as Array<{ id: string; sessionId?: string }>,
    registry: { release: () => {} },
    thinkingDetector: { clear: () => {} },
    quotaDetector: { clear: () => {} },
    attentionDetector: { clear: () => {} },
    startupAckDetector: { clear: () => {} },
    screenGuard: { clear: () => {} },
    oscParsers: { delete: () => {} },
    activityTrackers: { get: () => undefined, delete: () => {} },
    pendingPrompt: { delete: () => {} },
    persist: () => {},
    emit: () => {},
    broadcast: () => {},
    runtime: new Map([[id, { activity: initialActivity, status: "running", exitCode: null as number | null }]])
  };
}

test("B1: a session that never observed a title ('unknown') stays 'unknown' through a crash exit -- never collapses to 'idle'", () => {
  const handler = makeExitHandler();
  const self = makeExitSelf("s1", "unknown");
  handler.call(self, { id: "s1", exitCode: 1 }); // non-zero: crash branch, tile kept on screen
  expect(self.runtime.get("s1")?.activity).toBe("unknown");
});

test("B1: a session that WAS 'working' at exit legitimately becomes 'idle' (it is certainly no longer producing)", () => {
  const handler = makeExitHandler();
  const self = makeExitSelf("s1", "working");
  handler.call(self, { id: "s1", exitCode: 1 });
  expect(self.runtime.get("s1")?.activity).toBe("idle");
});

test("B1: a session already 'idle' at exit stays 'idle'", () => {
  const handler = makeExitHandler();
  const self = makeExitSelf("s1", "idle");
  handler.call(self, { id: "s1", exitCode: 1 });
  expect(self.runtime.get("s1")?.activity).toBe("idle");
});

// ----- 6. waitIdle proof (B2): byte-recency, NOT RuntimeState.activity ----

const WAIT_IDLE_ANCHOR = "private async waitIdle(id: string, deadlineMs: number): Promise<boolean> {";

function makeWaitIdle() {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = extractByAnchor(src, WAIT_IDLE_ANCHOR, "waitIdle()");
  // Free identifiers ACTIVITY_IDLE_MS (imported real value) and
  // DIRECTIVE_IDLE_POLL_MS (module-private, not exported -- passed as a
  // small arbitrary poll interval; only its EXISTENCE as a real delay
  // matters for this proof, not its exact production value).
  const fnSrc = `async function(id, deadlineMs, ACTIVITY_IDLE_MS, DIRECTIVE_IDLE_POLL_MS) ${body}`;
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const factory = new Function("return " + fnSrc)() as (
    this: unknown,
    id: string,
    deadlineMs: number,
    activityIdleMs: number,
    pollMs: number
  ) => Promise<boolean>;
  return (self: unknown, id: string, deadlineMs: number): Promise<boolean> =>
    factory.call(self, id, deadlineMs, ACTIVITY_IDLE_MS, 10);
}

test("B2: waitIdle resolves true from BYTE RECENCY even when activity is 'working' -- proves it reads lastOutputAt, not RuntimeState.activity", async () => {
  const waitIdle = makeWaitIdle();
  const self = {
    runtime: new Map([["a", { activity: "working" as Activity }]]),
    // 5s of silence -- past the 3s ACTIVITY_IDLE_MS threshold.
    lastOutputAt: (_id: string) => Date.now() - 5000
  };
  const start = Date.now();
  const result = await waitIdle(self, "a", 500);
  expect(result).toBe(true);
  // Resolved on the FIRST tick (no polling needed) -- a mutant reading
  // `r.activity !== 'working'` would instead poll to the 500ms deadline and
  // return false, since activity IS 'working' here.
  expect(Date.now() - start).toBeLessThan(200);
});

test("B2: waitIdle resolves false at the deadline when bytes are still fresh, even though activity is 'idle' -- confirms activity does not drive it in either direction", async () => {
  const waitIdle = makeWaitIdle();
  const self = {
    runtime: new Map([["a", { activity: "idle" as Activity }]]),
    lastOutputAt: (_id: string) => Date.now() // just wrote -- not quiet yet
  };
  const result = await waitIdle(self, "a", 150);
  expect(result).toBe(false);
});

test("B2: an unknown session id resolves false immediately (no runtime entry)", async () => {
  const waitIdle = makeWaitIdle();
  const self = { runtime: new Map(), lastOutputAt: () => null };
  expect(await waitIdle(self, "missing", 100)).toBe(false);
});

test("B2: a session with a PRESENT runtime entry that has never produced a byte (lastOutputAt === null) resolves true immediately -- covers the `last === null` branch specifically, not the `!r` early return", async () => {
  const waitIdle = makeWaitIdle();
  const self = {
    runtime: new Map([["a", { activity: "unknown" as Activity }]]),
    lastOutputAt: (_id: string) => null
  };
  const start = Date.now();
  const result = await waitIdle(self, "a", 500);
  expect(result).toBe(true);
  expect(Date.now() - start).toBeLessThan(200); // first tick, no polling
});

// ----- 7. activityTrackerFor's `.on()` callback wiring (B3) ---------------

const ACTIVITY_TRACKER_FOR_ANCHOR =
  "private activityTrackerFor(id: string): ReturnType<typeof createActivityTracker<NodeJS.Timeout>> {";

// The extracted body's own `createActivityTracker<NodeJS.Timeout>({...})`
// call is TypeScript generic-call syntax (a real type argument, not a
// comparison) -- plain `new Function()` has no TS transform, so `<`/`>`
// there parse as less-than/greater-than against a free `NodeJS` identifier
// (ReferenceError: NodeJS is not defined). Strip just that one known
// generic-call type argument; nothing else in this body uses the syntax.
function stripGenericCallTypeArg(body: string): string {
  return body.replace("createActivityTracker<NodeJS.Timeout>(", "createActivityTracker(");
}

test("B3: a real titleSeq transition through activityTrackerFor's wiring writes RuntimeState.activity, emits 'thinking', and calls broadcast()", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = stripGenericCallTypeArg(extractByAnchor(src, ACTIVITY_TRACKER_FOR_ANCHOR, "activityTrackerFor()"));
  const fnSrc = `function(id) ${body}`;
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const factory = new Function(
    "createActivityTracker",
    "ACTIVITY_IDLE_MS",
    "return " + fnSrc
  ) as (createFn: unknown, idleMs: number) => (this: unknown, id: string) => ReturnType<typeof createActivityTracker<NodeJS.Timeout>>;
  const activityTrackerFor = factory(createActivityTracker, ACTIVITY_IDLE_MS);

  const emitCalls: Array<[string, unknown]> = [];
  let broadcastCalls = 0;
  const self = {
    activityTrackers: new Map<string, ReturnType<typeof createActivityTracker<NodeJS.Timeout>>>(),
    runtime: new Map([["s1", { activity: "unknown" as Activity }]]),
    emit: (name: string, payload: unknown) => emitCalls.push([name, payload]),
    broadcast: () => {
      broadcastCalls++;
    }
  };

  const t = activityTrackerFor.call(self, "s1");
  t.observe(1); // real transition to 'working', fires the real .on() callback synchronously
  t.stop(); // no leaked real setTimeout past this test

  expect(self.runtime.get("s1")?.activity).toBe("working");
  expect(emitCalls).toEqual([["thinking", { id: "s1", state: "working" }]]);
  expect(broadcastCalls).toBe(1);
});

test("B3: activityTrackerFor mints exactly one tracker per id and reuses it on a second call", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = stripGenericCallTypeArg(extractByAnchor(src, ACTIVITY_TRACKER_FOR_ANCHOR, "activityTrackerFor()"));
  const fnSrc = `function(id) ${body}`;
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const factory = new Function(
    "createActivityTracker",
    "ACTIVITY_IDLE_MS",
    "return " + fnSrc
  ) as (createFn: unknown, idleMs: number) => (this: unknown, id: string) => ReturnType<typeof createActivityTracker<NodeJS.Timeout>>;
  const activityTrackerFor = factory(createActivityTracker, ACTIVITY_IDLE_MS);
  const self = {
    activityTrackers: new Map<string, ReturnType<typeof createActivityTracker<NodeJS.Timeout>>>(),
    runtime: new Map([["s1", { activity: "unknown" as Activity }]]),
    emit: () => {},
    broadcast: () => {}
  };
  const t1 = activityTrackerFor.call(self, "s1");
  const t2 = activityTrackerFor.call(self, "s1");
  expect(t1).toBe(t2);
  t1.stop();
});

const IPC_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "ipc.ts");
const STOP_STATE_ANCHOR = "regHandle('agents:stop-state', () => {";

test("correction 1: agents:stop-state counts 'unknown' SEPARATELY from busy and from idle -- never folded into either", () => {
  const src = readFileSync(IPC_PATH, "utf-8");
  const body = extractByAnchor(src, STOP_STATE_ANCHOR, "agents:stop-state handler");
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("service", `return (function() ${body})()`) as (service: unknown) => {
    live: number;
    busy: number;
    unknown: number;
    paused: number;
    parkedCards: number;
  };
  // Two 'working' tiles rather than a symmetric one-each fixture: a symmetric
  // fixture doesn't catch a swap of the busy/unknown filters, since swapping
  // them would yield the same pair of counts.
  const service = {
    list: () => [
      { status: "running", activity: "working" },
      { status: "running", activity: "working" },
      { status: "running", activity: "idle" },
      { status: "running", activity: "unknown" },
      { status: "exited", activity: "unknown" } // excluded: not live
    ]
  };
  const result = fn(service);
  expect(result).toEqual({ live: 4, busy: 2, unknown: 1, paused: 0, parkedCards: 0 });
});
