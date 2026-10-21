// Tests only quota.ts's own units
// (detectRateLimit/parseResetClock/QuotaDetector); it never exercises
// session-service.ts, so it does not guard the gating behavior there.

import { test, expect } from "bun:test";

import {
  detectRateLimit,
  parseResetClock,
  stripAnsi,
  QuotaDetector,
  type QuotaLimitEvent,
  type QuotaResumeDueEvent
} from "../desktop/src/main/quota.ts";

const DEFAULT_PERIODIC_FOR_TEST = 15 * 60_000;
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
⎿  You've hit your limit · resets 10:30pm (Europe/London)

  ❯ 1. Stop and wait for limit to reset
    2. Use extra usage to continue
`;

const MINUTES_FORMAT = `⎿  Limit reached (resets 8m)`;

// Raw PTY bytes of Claude Code 2.1.304 (and 2.1.306 for the reference wording):
// every space is written as ESC[1C, so stripping the CSI without a replacement
// fuses the words.
const CAPTURED_SESSION_LIMIT =
  "\x1b[48;2;55;55;55m\x1b[13;1H❯ \x1b[38;2;255;255;255mC1 probe: continue\x1b[K\x1b[38;2;153;153;153m\x1b[49m\r\n" +
  " \x1b[1C⎿\x1b[1C\u00a0\x1b[38;2;255;107;128mYou've\x1b[1Chit\x1b[1Cyour\x1b[1Csession\x1b[1Climit\x1b[1C·\x1b[1Cresets\x1b[1C7:10pm\x1b[1C(Europe/Paris)\x1b[1C·\x1b[1Cprogress\x1b[1Csaved\x1b[38;2;136;136;136m\x1b[16;1H";
const CAPTURED_REFERENCE_LIMIT =
  " \x1b[1C⎿\x1b[1C\u00a0\x1b[38;2;255;107;128mYou've\x1b[1Chit\x1b[1Cyour\x1b[1Climit\x1b[1C·\x1b[1Cresets\x1b[1C10pm\x1b[1C(Europe/London)\x1b[38;2;136;136;136m\x1b[16;1H";
// Rows copied from raw-stock.bin and joined: an excerpt, not one contiguous capture.
const EXCERPT_TRUST_DIALOG =
  "\x1b[1m\x1b[3;2HAccessing\x1b[1Cworkspace:\x1b[m\x1b[7;2HQuick\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject\x1b[1Cyou\x1b[1Ccreated?\x1b[38;2;153;153;153m\x1b[18;2HEnter\x1b[1Cto\x1b[1Cconfirm\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel";

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

test("detects the session-limit wording with its reset time, or without one", () => {
  const now = todayAt(9, 0);
  expect(detectRateLimit("⎿  You've hit your session limit · resets 7:10pm (Europe/Paris) · progress saved", now)).toEqual({
    resetAt: todayAt(19, 10)
  });
  expect(detectRateLimit("⎿  You've hit your session limit (resets 8m)", now)).toEqual({ resetAt: now + 8 * 60_000 });
  expect(detectRateLimit("⎿  You've hit your session limit — try later", now)).toEqual({ resetAt: null });
  expect(detectRateLimit("⎿  You have hit your session limit — progress saved", now)).toEqual({ resetAt: null });
});

test("fallback: limit text without a parseable time -> resetAt null", () => {
  const now = todayAt(9, 0);
  expect(detectRateLimit("⎿  You've hit your limit — try later", now)).toEqual({ resetAt: null });
  expect(detectRateLimit("⎿  weekly limit reached, resets in 2 hours", now)).toEqual({
    resetAt: null
  });
});

test("prose near-misses do not match (word boundaries)", () => {
  const now = todayAt(9, 0);
  expect(detectRateLimit("The limit of my patience has been tested", now)).toBeNull();
  expect(detectRateLimit("Please rate your experience with limits", now)).toBeNull();
  expect(detectRateLimit("unlimited reachedness", now)).toBeNull();
});

test("a CLI row that only mentions a limit is no quota limit: just the real labels match", () => {
  const now = todayAt(9, 0);
  for (const line of [
    "⎿  Context limit reached · ",
    "⎿  Fable limit reached · continuing on",
    "⎿  Fast limit reached and temporarily disabled · resets in",
    "⎿  Concurrent subagent limit reached",
    "⎿  Usage limit reachedness",
    "⎿  desktop/src/main/quota.ts:61: '5-hour limit reached'"
  ]) {
    expect(detectRateLimit(line, now), line).toBeNull();
  }
  expect(detectRateLimit("⎿  Usage limit reached · limit resets 7pm", now)).toEqual({ resetAt: todayAt(19, 0) });
  expect(detectRateLimit("⎿  You've hit your session limit · resets 7:10pm", now)).toEqual({ resetAt: todayAt(19, 10) });
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
  d.feed("s1", "⎿  You've hit your li");
  expect(ev.limits.length).toBe(0);
  d.feed("s1", "mit · resets 10pm (Europe/London)");
  expect(ev.limits.length).toBe(1);
  expect(ev.limits[0].resetAt).toBe(todayAt(22, 0));
  d.stop();
});

test("a captured limit screen whose spaces are cursor-forward moves raises a limit with its reset time", () => {
  const session = new QuotaDetector(() => todayAt(9, 0));
  const sessionEvents = collect(session);
  session.feed("s1", CAPTURED_SESSION_LIMIT);
  expect(sessionEvents.limits).toEqual([{ id: "s1", resetAt: todayAt(19, 10) }]);
  session.stop();

  const reference = new QuotaDetector(() => todayAt(9, 0));
  const referenceEvents = collect(reference);
  reference.feed("s1", CAPTURED_REFERENCE_LIMIT);
  expect(referenceEvents.limits).toEqual([{ id: "s1", resetAt: todayAt(22, 0) }]);
  reference.stop();
});

test("a cursor-forward move split across two PTY chunks still separates the words", () => {
  const d = new QuotaDetector(() => todayAt(9, 0));
  const ev = collect(d);
  d.feed("s1", "⎿ You've\x1b[1Chit\x1b[1Cyour\x1b[1Csession\x1b[");
  expect(ev.limits.length).toBe(0);
  d.feed("s1", "1Climit\x1b[1C·\x1b[1Cresets\x1b[1C7:10pm");
  expect(ev.limits).toEqual([{ id: "s1", resetAt: todayAt(19, 10) }]);
  d.stop();
});

test("a cursor-forward move of any width, or without a count, separates the words", () => {
  const d = new QuotaDetector(() => todayAt(9, 0));
  const ev = collect(d);
  d.feed("s1", "⎿ You've\x1b[3Chit\x1b[Cyour\x1b[12Climit\x1b[C·\x1b[Cresets\x1b[2C10pm");
  expect(ev.limits).toEqual([{ id: "s1", resetAt: todayAt(22, 0) }]);
  d.stop();
});

test("a captured screen without a quota message raises no limit", () => {
  const d = new QuotaDetector(() => todayAt(9, 0));
  const ev = collect(d);
  d.feed("s1", EXCERPT_TRUST_DIALOG);
  expect(ev.limits).toEqual([]);
  d.stop();
});

// The CLI paints every space of the assistant's prose as ESC[1C too, so once those become spaces
// only the row marker tells the CLI's own notice from text an agent wrote.
const paintedProse = (text: string): string => `\r\n\x1b[1C●\x1b[1C${text.split(" ").join("\x1b[1C")}\r\n`;
const PROSE_THAT_READS_LIKE_A_LIMIT = [
  "The build was rate limited yesterday.",
  "The API limit reached its ceiling, resets 1m later.",
  "You have hit your session limit, resets 8m.",
  "You've hit your limit · resets 2pm",
];

for (const sentence of PROSE_THAT_READS_LIKE_A_LIMIT) {
  test(`an assistant row painted like the CLI paints it raises no limit: ${sentence}`, () => {
    const d = new QuotaDetector(() => todayAt(9, 0));
    const ev = collect(d);
    d.feed("s1", paintedProse(sentence));
    d.feed("s1", `\x1b[1C\x1b[1C${sentence.split(" ").join("\x1b[1C")}\r\n`);
    expect(ev.limits).toEqual([]);
    d.stop();
  });
}

test("a row marker in the middle of a row does not open a limit notice", () => {
  const d = new QuotaDetector(() => todayAt(9, 0));
  const ev = collect(d);
  d.feed("s1", paintedProse("It printed ⎿ You've hit your limit · resets 2pm"));
  expect(ev.limits).toEqual([]);
  d.stop();
});

test("a notice painted by cursor positioning alone, with no line feed before it, is still read", () => {
  const d = new QuotaDetector(() => todayAt(9, 0));
  const ev = collect(d);
  d.feed("s1", "\x1b[14;1Hsome row\x1b[15;1H\x1b[1C⎿\x1b[1C You've\x1b[1Chit\x1b[1Cyour\x1b[1Climit\x1b[1C·\x1b[1Cresets\x1b[1C2pm");
  expect(ev.limits).toEqual([{ id: "s1", resetAt: todayAt(14, 0) }]);
  d.stop();
});

test("only a cursor-forward move stands for a space: a move back or to a column does not", () => {
  const row = (gap: string): string =>
    `\r\n⎿\x1b[1C${["You've", "hit", "your", "limit", "·", "resets", "2pm"].join(gap)}`;
  const probe = (gap: string): QuotaLimitEvent[] => {
    const d = new QuotaDetector(() => todayAt(9, 0));
    const ev = collect(d);
    d.feed("s1", row(gap));
    d.stop();
    return ev.limits;
  };
  expect(probe("\x1b[1C")).toHaveLength(1);
  expect(probe("\x1b[5D")).toEqual([]);
  expect(probe("\x1b[3G")).toEqual([]);
});

test("stripAnsi stays a bare strip: a cursor-forward move leaves no space", () => {
  expect(stripAnsi("a\x1b[1Cb")).toBe("ab");
});

test("a rate-limited sentence in a CLI row is not a quota notice", () => {
  expect(detectRateLimit("⎿  The request was rate limited", todayAt(9, 0))).toBeNull();
});

test("busy cues end the episode (manual or auto resume) and re-arm detection", () => {
  let now = todayAt(9, 0);
  const d = new QuotaDetector(() => now);
  const ev = collect(d);
  d.feed("s1", MINUTES_FORMAT);
  expect(ev.limits.length).toBe(1);
  now += 2000; // past the window where cues still belong to the limited turn
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
  d.feed("s1", "⎿  5-hour limit reached ∙ resets 2:55pm");
  expect(ev.limits.length).toBe(1);
  expect(ev.limits[0].resetAt).toBe(todayAt(14, 55));
  await wait(30);
  expect(ev.dues).toEqual(["s1"]); // one-shot: no second fire
  await wait(30);
  expect(ev.dues).toEqual(["s1"]);
  d.stop();
});

test("unknown reset time -> periodic resume-due while the episode lasts", async () => {
  const d = new QuotaDetector(Date.now, 25, 0); // 25ms periodic, no busy grace
  const ev = collect(d);
  d.feed("s1", "⎿  You've hit your limit");
  expect(ev.limits[0].resetAt).toBeNull();
  // This assertion is racy because armTimer re-arms from inside its own
  // callback (a chained setTimeout), so lateness accumulates per hop.
  // It retries only this flag with an early exit on first success, keeping the
  // assertion binary; its neighbors use a fixed wait since a single timer armed
  // before the deadline timer always wins ordering.
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
  d.feed("s1", "⎿  You've hit your limit");
  d.clear("s1");
  await wait(60);
  expect(ev.dues).toEqual([]);
  d.stop();
});

// OSC sequences must be stripped, closing a false-positive an OSC-carried
// literal phrase could otherwise cause against FALLBACK_PATTERNS.
// Direction 1 (presence): stripAnsi actually removes an OSC 777 body.
// Direction 2 (regression): the fixed output does not match text that only ever
// existed inside that OSC payload, distinguishing it from a real limit screen,
// which spells the same phrase in plain PTY text with no OSC wrapper.
test("stripAnsi removes an OSC 777 sequence, not just CSI", () => {
  const withOsc = "\x1b]777;notify;Claude Code;limit reached\x07plain screen text";
  expect(stripAnsi(withOsc)).toBe("plain screen text");
});

test("an OSC-carried 'limit reached' phrase does not spuriously trigger detectRateLimit (it is not a real limit screen)", () => {
  const chunk = "\x1b]777;notify;Claude Code;limit reached\x07plain screen text, no real limit here";
  expect(detectRateLimit(stripAnsi(chunk), Date.now())).toBeNull();
});

test("a real limit screen (plain text, no OSC wrapper) still triggers detectRateLimit after the OSC fix", () => {
  const chunk = "⎿  You've hit your limit · resets 8pm";
  expect(detectRateLimit(stripAnsi(chunk), Date.now())).not.toBeNull();
});

// The busy cue reads the escape-safe delta: an OSC head whose terminator has
// not arrived yet must not leak its payload as screen text.
test("busy text carried inside an OSC title FRAGMENTED across two chunks does not falsely end an open limit episode", () => {
  const d = new QuotaDetector(Date.now, DEFAULT_PERIODIC_FOR_TEST, 0);
  const limitEv: unknown[] = [];
  const clearEv: unknown[] = [];
  d.on("limit", (e: QuotaLimitEvent) => limitEv.push(e));
  d.on("clear", () => clearEv.push(true));

  d.feed("s1", "⎿  5-hour limit reached · resets 2pm\n");
  expect(limitEv.length).toBe(1);

  // Idle title glyph, so only a leak of its payload as screen text could clear.
  const osc = "\x1b]0;✳ (3s · esc to interrupt)\x07";
  d.feed("s1", osc.slice(0, 12)); // carries "(3s ·", no terminator yet
  d.feed("s1", osc.slice(12)); // the terminator
  expect(clearEv.length, "an OSC payload leaked into the busy text cue").toBe(0);

  d.stop();
});

// A spinner-row frame as the CLI paints it, with a statusLine (no footer hint).
const SPINNER_FRAME = "\x1b[22;1H✶\x1b[1CEnchanting…\x1b[2C(0s · thinking)";

test("once resume-due fired, a busy frame inside the post-limit window ends the episode", async () => {
  const t0 = new Date(2026, 0, 1, 9, 0).getTime();
  let now = t0;
  const d = new QuotaDetector(() => now);
  const ev = collect(d);
  const clears: string[] = [];
  d.on("clear", (e: { id: string }) => clears.push(e.id));
  d.feed("s1", "⎿  You've hit your limit · resets 9am (Europe/London)"); // reset already due
  await waitUntil(() => ev.dues.length >= 1);
  now = t0 + 100;
  expect(ev.dues, "a reset time already past must fire resume-due at once").toEqual(["s1"]);
  now = t0 + 300;
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "the resumed turn's busy frame was swallowed by the post-limit window").toEqual(["s1"]);
  d.stop();
});

test("without resume-due, a busy frame inside the post-limit window does not end the episode", () => {
  const t0 = new Date(2026, 0, 1, 9, 0).getTime();
  let now = t0;
  const d = new QuotaDetector(() => now);
  const ev = collect(d);
  const clears: string[] = [];
  d.on("clear", (e: { id: string }) => clears.push(e.id));
  d.feed("s1", "⎿  You've hit your limit · resets 10pm (Europe/London)");
  now = t0 + 300;
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "a trailing frame of the limited turn ended the episode").toEqual([]);
  expect(ev.dues).toEqual([]);
  now = t0 + 1600;
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "a busy frame after the window must end the episode").toEqual(["s1"]);
  d.stop();
});

test("a new episode re-applies the post-limit window after a resumed one", async () => {
  const t0 = new Date(2026, 0, 1, 9, 0).getTime();
  let now = t0;
  const d = new QuotaDetector(() => now);
  const ev = collect(d);
  const clears: string[] = [];
  d.on("clear", (e: { id: string }) => clears.push(e.id));
  d.feed("s1", "⎿  You've hit your limit · resets 9am (Europe/London)");
  await waitUntil(() => ev.dues.length >= 1);
  now = t0 + 300;
  d.feed("s1", SPINNER_FRAME);
  expect(clears).toEqual(["s1"]);
  now = t0 + 10_000;
  d.feed("s1", "⎿  You've hit your limit · resets 10pm (Europe/London)");
  now = t0 + 10_200;
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "the previous episode's resume leaked into the next one's window").toEqual(["s1"]);
  d.stop();
});

test("a periodic resume-due also lifts the post-limit window", async () => {
  const t0 = new Date(2026, 0, 1, 9, 0).getTime();
  let now = t0;
  const d = new QuotaDetector(() => now, 20);
  const ev = collect(d);
  const clears: string[] = [];
  d.on("clear", (e: { id: string }) => clears.push(e.id));
  d.feed("s1", "⎿  You've hit your limit");
  await waitUntil(() => ev.dues.length >= 1);
  now = t0 + 300;
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "the retried turn's busy frame was swallowed by the post-limit window").toEqual(["s1"]);
  d.stop();
});

test("an immediate resume-due does not let the limited turn's own trailing frame end the episode", async () => {
  const t0 = new Date(2026, 0, 1, 9, 0).getTime();
  let now = t0;
  const d = new QuotaDetector(() => now);
  const ev = collect(d);
  const clears: string[] = [];
  d.on("clear", (e: { id: string }) => clears.push(e.id));
  d.feed("s1", "⎿  You've hit your limit · resets 9am (Europe/London)"); // reset already due
  await waitUntil(() => ev.dues.length >= 1);
  expect(ev.dues).toEqual(["s1"]);
  now = t0 + 70;
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "the limited turn's trailing spinner frame ended the episode").toEqual([]);
  now = t0 + 200; // past the keystrokes, still inside the observed tail
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "a late trailing frame of the limited turn ended the episode").toEqual([]);
  now = t0 + 400;
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "the resumed turn's busy frame must end the episode").toEqual(["s1"]);
  d.stop();
});

test("after a late resume-due, a busy frame before the injected keystrokes does not end the episode", async () => {
  const t0 = new Date(2026, 0, 1, 9, 0).getTime();
  let now = t0;
  const d = new QuotaDetector(() => now, 20);
  const ev = collect(d);
  const clears: string[] = [];
  d.on("clear", (e: { id: string }) => clears.push(e.id));
  d.feed("s1", "⎿  You've hit your limit");
  now = t0 + 500; // the periodic resume-due fires at this clock
  await waitUntil(() => ev.dues.length >= 1);
  now = t0 + 550;
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "a frame painted before 'continue' was typed ended the episode").toEqual([]);
  now = t0 + 650;
  d.feed("s1", SPINNER_FRAME);
  expect(clears, "a busy frame after the keystrokes must end the episode").toEqual(["s1"]);
  d.stop();
});
