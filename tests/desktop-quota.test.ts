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
  await wait(90);
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
