// PLAN-v0.4 C1: quota (usage-limit) detection + auto-resume scheduling.
// Fixtures mirror the real Claude Code screens the regexes were derived from
// (via henryaj/autoclaude's verified pattern families).
//
// Scope note (koryphaios card fd1914cc audit, 2026-08-19): this file tests
// ONLY quota.ts's own units (detectRateLimit/parseResetClock/QuotaDetector)
// -- it never touches session-service.ts. The double-injection bug that
// fd1914cc fixed lived one layer up, in SessionService's unconditional
// `quotaDetector.feed()` call, which nothing here exercises. So this file
// was already green before that fix landed, but that was never informative
// about the bug: it was never the relevant guard for it. The gating
// behaviour (isClaudeSession/quotaGateActive) is covered by
// tests/desktop-quota-gate.test.ts instead. Keep that split -- this file
// stays scoped to quota.ts's own parsing/detector contract, which is still
// genuinely exercised (conditionally) by session-service.ts today.

import { test, expect } from "bun:test";

import {
  detectRateLimit,
  parseResetClock,
  stripAnsi,
  QuotaDetector,
  type QuotaLimitEvent,
  type QuotaResumeDueEvent
} from "../desktop/src/main/quota.ts";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Card 69011831. Poll until `ok()` holds, early exit on the FIRST success.
 * Used by exactly ONE assertion in this file, the only one whose subject is a
 * CHAINED timer (see its call site): every other assertion here stays
 * single-shot, so a real regression still reddens on the first draw.
 */
async function waitUntil(ok: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok() && Date.now() < deadline) await wait(5);
}

/** Epoch ms for today at local hh:mm (tests reason in local time, like the parser). */
function todayAt(hour: number, minute = 0): number {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

// ----- fixtures (screen text after ANSI stripping) -----

const OLD_FORMAT = `
⎿  5-hour limit reached ∙ resets 2pm
   > continue
`;

const NEW_FORMAT = `
You've hit your limit · resets 10:30pm (Europe/London)

  ❯ 1. Stop and wait for limit to reset
    2. Use extra usage to continue
`;

const MINUTES_FORMAT = `Limit reached (resets 8m)`;

// ----- parseResetClock -----

test("parses plain and minuted clocks, am/pm, spaces", () => {
  const now = todayAt(9, 0);
  expect(parseResetClock("2pm", now)).toBe(todayAt(14, 0));
  expect(parseResetClock("10:30am", now)).toBe(todayAt(10, 30));
  expect(parseResetClock("3 pm", now)).toBe(todayAt(15, 0));
});

test("12am/12pm convert correctly", () => {
  const now = todayAt(1, 0);
  expect(parseResetClock("12am", now)).toBe(todayAt(0, 0));
  expect(parseResetClock("12pm", now)).toBe(todayAt(12, 0));
});

test("a time more than 1h in the past rolls to tomorrow; within 1h stays", () => {
  const now = todayAt(15, 0);
  // 10am is 5h past -> tomorrow 10am.
  expect(parseResetClock("10am", now)).toBe(todayAt(10, 0) + 24 * 3600_000);
  // 2:30pm is 30min past -> kept today (trigger fires immediately).
  expect(parseResetClock("2:30pm", now)).toBe(todayAt(14, 30));
});

test("rejects garbage clocks", () => {
  const now = todayAt(9, 0);
  expect(parseResetClock("25pm", now)).toBeNull();
  expect(parseResetClock("in 2 hours", now)).toBeNull();
});

// ----- detectRateLimit -----

test("detects the old format with a captured reset time", () => {
  const now = todayAt(9, 0);
  const m = detectRateLimit(OLD_FORMAT, now);
  expect(m).not.toBeNull();
  expect(m!.resetAt).toBe(todayAt(14, 0));
});

test("detects the new format (timezone suffix ignored, local time assumed)", () => {
  const now = todayAt(9, 0);
  const m = detectRateLimit(NEW_FORMAT, now);
  expect(m).not.toBeNull();
  expect(m!.resetAt).toBe(todayAt(22, 30));
});

test("detects the minutes format as now+N", () => {
  const now = todayAt(9, 0);
  const m = detectRateLimit(MINUTES_FORMAT, now);
  expect(m).not.toBeNull();
  expect(m!.resetAt).toBe(now + 8 * 60_000);
});

test("fallback: limit text without a parseable time -> resetAt null", () => {
  const now = todayAt(9, 0);
  expect(detectRateLimit("You've hit your limit — try later", now)).toEqual({ resetAt: null });
  expect(detectRateLimit("weekly limit reached, resets in 2 hours", now)).toEqual({
    resetAt: null
  });
});

test("prose near-misses do not match (word boundaries)", () => {
  const now = todayAt(9, 0);
  expect(detectRateLimit("The limit of my patience has been tested", now)).toBeNull();
  expect(detectRateLimit("Please rate your experience with limits", now)).toBeNull();
  expect(detectRateLimit("unlimited reachedness", now)).toBeNull();
});

test("stripAnsi removes CSI sequences around a marker", () => {
  expect(stripAnsi("\x1b[33mlimit reached\x1b[0m ∙ resets 2pm")).toBe("limit reached ∙ resets 2pm");
});

// ----- QuotaDetector -----

function collect(d: QuotaDetector): {
  limits: QuotaLimitEvent[];
  clears: string[];
  dues: string[];
} {
  const limits: QuotaLimitEvent[] = [];
  const clears: string[] = [];
  const dues: string[] = [];
  d.on("limit", (e: QuotaLimitEvent) => limits.push(e));
  d.on("clear", (e: { id: string }) => clears.push(e.id));
  d.on("resume-due", (e: QuotaResumeDueEvent) => dues.push(e.id));
  return { limits, clears, dues };
}

test("emits limit once per episode, even when the screen redraws", () => {
  // Fixed injected clock: assertions stay deterministic whatever the wall time.
  const d = new QuotaDetector(() => todayAt(9, 0));
  const ev = collect(d);
  d.feed("s1", OLD_FORMAT);
  d.feed("s1", OLD_FORMAT); // redraw while limited -> no second episode
  expect(ev.limits.length).toBe(1);
  expect(ev.limits[0].id).toBe("s1");
  expect(ev.limits[0].resetAt).toBe(todayAt(14, 0));
  d.stop();
});

test("detects a message split across two PTY chunks (rolling buffer)", () => {
  const d = new QuotaDetector(() => todayAt(9, 0));
  const ev = collect(d);
  d.feed("s1", "You've hit your li");
  expect(ev.limits.length).toBe(0);
  d.feed("s1", "mit · resets 10pm (Europe/London)");
  expect(ev.limits.length).toBe(1);
  expect(ev.limits[0].resetAt).toBe(todayAt(22, 0));
  d.stop();
});

test("busy cues end the episode (manual or auto resume) and re-arm detection", () => {
  const d = new QuotaDetector(() => todayAt(9, 0));
  const ev = collect(d);
  d.feed("s1", MINUTES_FORMAT);
  expect(ev.limits.length).toBe(1);
  d.feed("s1", "⠹ working… esc to interrupt");
  expect(ev.clears).toEqual(["s1"]);
  // A fresh limit after the episode ended starts a NEW episode.
  d.feed("s1", MINUTES_FORMAT);
  expect(ev.limits.length).toBe(2);
  d.stop();
});

test("resume-due fires once when the parsed reset is already past (<1h)", async () => {
  // Injected now = 15:00; "resets 2:55pm" is 5min past (<1h) -> kept -> ~0ms timer.
  const d = new QuotaDetector(() => todayAt(15, 0));
  const ev = collect(d);
  d.feed("s1", "5-hour limit reached ∙ resets 2:55pm");
  expect(ev.limits.length).toBe(1);
  expect(ev.limits[0].resetAt).toBe(todayAt(14, 55));
  await wait(30);
  expect(ev.dues).toEqual(["s1"]); // one-shot: no second fire
  await wait(30);
  expect(ev.dues).toEqual(["s1"]);
  d.stop();
});

test("unknown reset time -> periodic resume-due while the episode lasts", async () => {
  const d = new QuotaDetector(Date.now, 25); // 25ms periodic for the test
  const ev = collect(d);
  d.feed("s1", "You've hit your limit");
  expect(ev.limits[0].resetAt).toBeNull();
  // Card 69011831. This is the ONE racy assertion of the file, and it is racy
  // for a structural reason, not a thin-margin one: quota.ts's armTimer
  // re-arms the periodic retry from INSIDE its own callback (a chained
  // setTimeout, not an interval), so lateness ACCUMULATES per hop. A fixed
  // wait(90) needed two 25ms hops to land, i.e. 40ms of total headroom spread
  // over 3 timer hops. Measured 2026-08-28 (bun 1.3.13, 24 cores) under 72
  // CPU burners: 4 reds in 12 runs of this file, always this line; a synthetic
  // in-window event-loop chopper puts the cliff at 45-50ms of per-tick stall.
  // Its two neighbours are NOT affected and stay on a fixed wait() on purpose:
  // a SINGLE timer armed before the deadline timer always expires first
  // whatever the load (timers drain in expiry order), measured 25/25 green at
  // a 300ms chopper -- they are protected by ORDERING, not by margin.
  // Retry only this flag, early exit on first success; the assertion stays
  // binary, so the test still reddens if the periodic retry stops entirely.
  await waitUntil(() => ev.dues.length >= 2);
  expect(ev.dues.length).toBeGreaterThanOrEqual(2); // keeps retrying
  d.feed("s1", "⠹ esc to interrupt"); // episode ends
  const count = ev.dues.length;
  await wait(60);
  expect(ev.dues.length).toBe(count); // no more fires after clear
  d.stop();
});

test("clear() drops state and cancels pending timers", async () => {
  const d = new QuotaDetector(Date.now, 20);
  const ev = collect(d);
  d.feed("s1", "You've hit your limit");
  d.clear("s1");
  await wait(60);
  expect(ev.dues).toEqual([]);
  d.stop();
});

// Card 1aa69066 (H2): OSC sequences must be stripped, closing the FALLBACK_PATTERNS
// false-positive an OSC-carried literal phrase could otherwise cause. Direction 1
// (presence): stripAnsi actually removes an OSC 777 body. Direction 2 (regression):
// the fixed stripAnsi output no longer matches "limit reached" that only ever
// existed inside the OSC payload -- distinguishing this from a real limit screen,
// which spells the phrase in plain PTY text with no OSC wrapper at all.
test("stripAnsi removes an OSC 777 sequence, not just CSI", () => {
  const withOsc = "\x1b]777;notify;Claude Code;limit reached\x07plain screen text";
  expect(stripAnsi(withOsc)).toBe("plain screen text");
});

test("an OSC-carried 'limit reached' phrase does not spuriously trigger detectRateLimit (it is not a real limit screen)", () => {
  const chunk = "\x1b]777;notify;Claude Code;limit reached\x07plain screen text, no real limit here";
  expect(detectRateLimit(stripAnsi(chunk), Date.now())).toBeNull();
});

test("a real limit screen (plain text, no OSC wrapper) still triggers detectRateLimit after the OSC fix", () => {
  const chunk = "You've hit your limit · resets 8pm";
  expect(detectRateLimit(stripAnsi(chunk), Date.now())).not.toBeNull();
});

// Card 1aa69066 (H2) review, blocker F3: BUSY_RE's fast path (the
// `st.limited` branch in feed()) tests the raw per-chunk delta immediately,
// before the accumulated-buffer re-strip runs -- a stateless per-chunk regex
// cannot remove an escape sequence whose terminator has not arrived yet, so
// a braille glyph fragmented across two chunks leaked into BUSY_RE's input
// and falsely ended an OPEN rate-limit episode (which then disarms the
// auto-resume timer for real). MEASURED (reviewer, mutation review):
// reverting BUSY_RE to read raw `stripped` left this file's tests green --
// none of them fragment the OSC that carries the glyph.
test("an OSC-carried braille glyph FRAGMENTED across two chunks does not falsely end an open limit episode", () => {
  const d = new QuotaDetector();
  const limitEv: unknown[] = [];
  const clearEv: unknown[] = [];
  d.on("limit", (e: QuotaLimitEvent) => limitEv.push(e));
  d.on("clear", () => clearEv.push(true));

  d.feed("s1", "5-hour limit reached · resets 2pm\n");
  expect(limitEv.length).toBe(1);

  const osc = "\x1b]0;⣋ Claude is thinking\x07";
  d.feed("s1", osc.slice(0, 12)); // carries the glyph, no terminator yet
  d.feed("s1", osc.slice(12)); // the terminator
  expect(clearEv.length).toBe(0); // still limited, no false clear

  d.stop();
});
