// Busy detection must not depend on the footer hint "esc to interrupt": Claude
// Code hides footer hints whenever a statusLine is configured. The replayed
// fixture was captured with a statusLine, so it never carries the hint.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createBusyCue } from "../desktop/src/main/detect/busy.ts";
import { QuotaDetector } from "../desktop/src/main/quota.ts";
import { AttentionDetector, type AttentionEvent } from "../desktop/src/main/attention.ts";

type Chunk = { t: number; data: string };
const FIXTURE = "turn-chunks-scrubbed-env.json";
const chunks: Chunk[] = JSON.parse(
  readFileSync(join(import.meta.dir, "pty-harness", "fixtures", FIXTURE), "utf8")
);

// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const isTitleOnly = (c: Chunk): boolean => c.data.replace(OSC_RE, "") === "" && /\x1b\]0;/.test(c.data);

// The turn starts with the first working title (◐) and ends with the idle
// title (✳) that follows it.
const turnStart = chunks.findIndex((c) => c.data.includes("\x1b]0;◐"));
const turnEnd = chunks.findIndex((c, i) => i > turnStart && c.data.includes("\x1b]0;✳"));
const turn = chunks.slice(turnStart, turnEnd);
const spinnerRow = chunks.find((c) => c.data.includes("26 tokens)"))!;
const statusLineRow = chunks.find((c) => c.data.includes("Opus"))!;

const LIMIT = "You've hit your limit · resets 10pm (Europe/London)\r\n";
const PERMISSION = "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n";

function quotaHarness(): { d: QuotaDetector; clears: string[]; advance: (ms: number) => void } {
  let now = new Date(2026, 0, 1, 9, 0).getTime();
  const d = new QuotaDetector(() => now);
  const clears: string[] = [];
  d.on("clear", (e: { id: string }) => clears.push(e.id));
  return { d, clears, advance: (ms) => (now += ms) };
}

test("fixture precondition: the captured turn has a statusLine and no footer hint", () => {
  expect(turnStart, "fixture lost its working title").toBeGreaterThan(0);
  expect(turnEnd, "fixture lost its end-of-turn idle title").toBeGreaterThan(turnStart);
  expect(statusLineRow, "fixture lost its statusLine row").toBeDefined();
  expect(
    chunks.some((c) => c.data.includes("esc to interrupt")),
    "fixture must not carry the footer hint, or it no longer proves hint independence"
  ).toBe(false);
});

test("a real busy turn WITHOUT 'esc to interrupt' ends a quota episode", () => {
  const { d, clears, advance } = quotaHarness();
  d.feed("s1", LIMIT);
  advance(5000);
  for (const c of turn) d.feed("s1", c.data);
  expect(clears, "a resumed turn under a statusLine must end the rate-limit episode").toEqual(["s1"]);
  d.stop();
});

test("the OSC 0 working title alone ends a quota episode", () => {
  const { d, clears, advance } = quotaHarness();
  d.feed("s1", LIMIT);
  advance(5000);
  for (const c of turn.filter(isTitleOnly)) d.feed("s1", c.data);
  expect(clears, "the working-title cue (◐/◑) must end the episode on its own").toEqual(["s1"]);
  d.stop();
});

test("the spinner-row text alone (titles removed) ends a quota episode", () => {
  const { d, clears, advance } = quotaHarness();
  d.feed("s1", LIMIT);
  advance(5000);
  for (const c of turn) d.feed("s1", c.data.replace(OSC_RE, ""));
  expect(clears, "the spinner-row timer/token cue must end the episode on its own").toEqual(["s1"]);
  d.stop();
});

test("the limit screen, its turn's trailing frames and idle repaints never end the episode", () => {
  const { d, clears, advance } = quotaHarness();
  d.feed("s1", LIMIT);
  // Trailing frames of the turn that printed the limit, flushed right after it.
  d.feed("s1", "\x1b]0;◑ Claude Code\x07");
  d.feed("s1", spinnerRow.data);
  advance(200);
  d.feed("s1", "\x1b]0;✳ Claude Code\x07");
  d.feed("s1", "\x1b[22;1H✻\x1b[1CWorked for 2s · done 10:58 PM\x1b[K\x1b[25;1H❯ ");
  expect(clears, "trailing frames of the limited turn ended the episode").toEqual([]);
  // Idle afterwards: title changes, statusLine refresh, a redrawn limit screen.
  advance(60_000);
  d.feed("s1", "\x1b]0;✳ Limit reached\x07");
  d.feed("s1", statusLineRow.data);
  d.feed("s1", LIMIT);
  expect(clears, "an idle repaint or the limit screen itself ended the episode").toEqual([]);
  d.stop();
});

test("a real spinner-row frame WITHOUT 'esc to interrupt' clears a waiting flag", () => {
  const d = new AttentionDetector();
  const events: AttentionEvent[] = [];
  d.on("attention", (e: AttentionEvent) => events.push(e));
  d.feed("s1", PERMISSION);
  d.feed("s1", "\x1b]0;✳ Claude Code\x07");
  d.feed("s1", statusLineRow.data);
  expect(events, "an idle title or a statusLine refresh cleared the waiting flag").toEqual([
    { id: "s1", waiting: true }
  ]);
  d.feed("s1", spinnerRow.data);
  expect(events, "the spinner-row cue must clear the waiting flag under a statusLine").toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});

test("createBusyCue: working title glyphs count, the idle glyph does not", () => {
  const cue = createBusyCue({ title: true });
  expect(cue.feed("\x1b]0;✳ Claude Code\x07"), "idle title read as busy").toBe(false);
  expect(cue.feed("\x1b]0;◐ Claude Code\x07"), "half-circle working title missed").toBe(true);
  expect(cue.feed("\x1b]0;⠹ Claude Code\x07"), "braille working title missed").toBe(true);
  expect(cue.feed("plain text"), "a title seen earlier re-counted without a new one").toBe(false);
  const textOnly = createBusyCue({ title: false });
  expect(textOnly.feed("\x1b]0;◐ Claude Code\x07"), "title cue fired with title: false").toBe(false);
  expect(textOnly.feed("✶ Cerebrating… (0s · thinking)"), "spinner-row timer missed").toBe(true);
  expect(textOnly.feed("(1m 5s · ↓ 1.2k tokens)"), "minute timer / k-token counter missed").toBe(true);
});
