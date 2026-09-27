// Busy detection must not depend on the footer hint "esc to interrupt": Claude
// Code hides footer hints whenever a statusLine is configured. The replayed
// fixture was captured with a statusLine, so it never carries the hint.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CURSOR_FORWARD_MARK, createBusyCue, hasPartialRepaintCue, hasSpinnerRowCue } from "../desktop/src/main/detect/busy.ts";
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
  expect(textOnly.feed("\r✻ Pondering… (1m 5s · ↓ 1.2k tokens)"), "minute timer / k-token counter missed").toBe(true);
});

// Real frames from four statusLine / no-statusLine runs (claude 2.1.282). The
// diff renderer repaints only the cells that changed, so most frames carry a
// piece of the spinner row without its glyph.
const FRAME = {
  // Glyph repainted in column 1, timer on the same row.
  glyphTokens: "\x1b[?25l\x1b[H\r\x1b[33B\x1b[38;5;174m\u2722\x1b[3G\x1b[38;5;216mG\x1b[6G\x1b[38;5;174me\x1b[21G\x1b[38;5;246m\u2193\x1b[39m \x1b[38;5;246m25 tokens \u00b7 thinking)\x1b[39m\x1b[40;1H\x1b[37;3H\x1b[?25h",
  glyphCount: "\x1b[?25l\x1b[H\r\x1b[32B\x1b[38;5;174m\u2722\x1b[4Go\x1b[22G\x1b[38;5;246m113 tokens \u00b7 thinking)\x1b[39m\x1b[40;1H\x1b[36;3H\x1b[?25h",
  // First timer frame, painted alone.
  bareTimer: "\x1b[?25l\x1b[H\r\x1b[14C\x1b[32B\x1b[38;5;246m(1s \u00b7 \x1b[38;5;249mthinking\x1b[38;5;246m)\x1b[39m\x1b[40;1H\x1b[36;3H\x1b[?25h",
  // Partial repaints: CR, a cursor-forward over the unchanged cells, then the
  // changed tail of the row, with or without verb fragments.
  tokensNoGlyph: "\x1b[?25l\x1b[H\r\x1b[19C\x1b[32B\x1b[38;5;246m\u2193\x1b[39m \x1b[38;5;246m38 tokens \u00b7 \x1b[38;5;248mthinking\x1b[38;5;246m)\x1b[39m\x1b[40;1H\x1b[36;3H\x1b[?25h",
  verbFragmentTokens: "\x1b[?25l\x1b[H\r\x1b[3C\x1b[32B\x1b[38;5;216mn\x1b[7G\x1b[38;5;174ma\x1b[21G\x1b[38;5;246m\u2193\x1b[39m \x1b[38;5;246m25 tokens \u00b7 \x1b[38;5;247mthinking\x1b[38;5;246m)\x1b[39m\x1b[40;1H\x1b[36;3H\x1b[?25h",
};

test("spinner-row anchoring: which real delta frames count as busy", () => {
  const busy = (data: string): boolean => createBusyCue({ title: false }).feed(data);
  expect(busy(FRAME.glyphTokens), "glyph + token counter on one row missed").toBe(true);
  expect(busy(FRAME.glyphCount), "glyph + thinking suffix on one row missed").toBe(true);
  expect(busy(FRAME.bareTimer), "the bare first timer frame missed").toBe(true);
  expect(busy(FRAME.tokensNoGlyph), "a partial repaint of the token counter missed").toBe(true);
  expect(busy(FRAME.verbFragmentTokens), "a partial repaint behind verb fragments missed").toBe(true);
  // Committed fixtures: the only text-cue frame of each turn still counts.
  for (const name of ["turn-chunks-scrubbed-env.json", "turn-chunks-inherited-env.json"]) {
    const cs: Chunk[] = JSON.parse(readFileSync(join(import.meta.dir, "pty-harness", "fixtures", name), "utf8"));
    const cue = createBusyCue({ title: false });
    const hits = cs.filter((c) => cue.feed(c.data)).length;
    expect(hits, `${name}: spinner-row frame no longer recognised`).toBe(1);
  }
});

test("spinner-row cues printed off the spinner row do not count", () => {
  const cue = createBusyCue({ title: false });
  expect(cue.feed("\x1b[5;1H  12 +  const t = wait(3s \u00b7 x)\x1b[K"), "diff content with a timer counted").toBe(false);
  expect(cue.feed("\x1b[6;1H  13 +  // \u2193 12 tokens\x1b[K"), "diff content with a token counter counted").toBe(false);
  expect(cue.feed("\x1b[40;1H  Opus 5 \u2502 \u2193 3.4k tokens \u2502 main\x1b[K"), "a statusLine token counter counted").toBe(false);
  expect(cue.feed("\x1b[40;1H\u2193 3.4k tokens"), "a bare token counter counted").toBe(false);
  expect(cue.feed("\x1b[8;1H  \u23bf  Running\u2026 (3s \u00b7 \u2193 1.2k tokens)"), "a background-agent row counted").toBe(false);
  expect(cue.feed("\x1b[9;1H* note (3s \u00b7 x"), "a markdown bullet counted as the * spinner frame").toBe(false);
  expect(cue.feed("\x1b[22;1H\u273b\x1b[1CWorked for 2s \u00b7 done"), "the idle summary counted").toBe(false);
  expect(cue.feed("\r\u273bCrunched for 1s \u00b7 done 11:15 PM\r\r\u276f "), "the idle summary counted").toBe(false);
  expect(cue.feed("\x1b[9;1Hesc to interrupt"), "the footer hint must count anywhere").toBe(true);
  expect(hasSpinnerRowCue("\u00b7 Vibing\u2026 (4s \u00b7 \u2193 9 tokens)"), "the \u00b7 spinner frame missed").toBe(true);
  expect(hasSpinnerRowCue("* Vibing\u2026 (4s \u00b7 \u2193 9 tokens)"), "the * spinner frame missed").toBe(true);
  expect(hasSpinnerRowCue("\u2733 Vibing\u2026 (4s \u00b7 \u2193 9 tokens)"), "the macOS \u2733 spinner frame missed").toBe(true);
  expect(hasSpinnerRowCue("Inferring\u2026 \u00b7 2s \u00b7 \u21939 tokens)"), "a verb head without its glyph missed").toBe(true);
});

test("partial-repaint cue: only a CR + cursor-forward line whose tail is the counter closed by the thinking suffix", () => {
  const busy = (data: string): boolean => createBusyCue({ title: false }).feed(data);
  expect(busy("\r\x1b[5C\u2193 3.4k tokens\x1b[K"), "a repainted statusLine token counter counted").toBe(false);
  expect(busy("\r\x1b[12C\x1b[38;5;246m3.5k tokens \u2502 main"), "a repainted statusLine cell counted").toBe(false);
  expect(busy("\r\x1b[4C(3s \u00b7 x)\r\n\x1b[4C2. No"), "a repainted chooser/diff timer counted").toBe(false);
  expect(busy("\r\x1b[9C\u2193 12 tokens)"), "the counter without the thinking suffix counted").toBe(false);
  expect(busy("\r\x1b[2CWorked for 2s \u00b7 done"), "a repainted idle summary counted").toBe(false);
  expect(busy("\r  note\x1b[5C\u2193 3 tokens \u00b7 thinking)"), "a cursor-forward after text counted").toBe(false);
  expect(busy("\x1b[6;1H  13 +  // \u2193 12 tokens \u00b7 thinking)"), "the suffix on a row with no cursor-forward counted").toBe(false);
  const split = createBusyCue({ title: false });
  expect(split.feed("\r\x1b[1"), "first half of a split cursor-forward").toBe(false);
  expect(split.feed("9C\u2193 38 tokens \u00b7 thinking)"), "a cursor-forward split across chunks is not marked (accepted miss)").toBe(false);
  expect(hasPartialRepaintCue(`${CURSOR_FORWARD_MARK}na\u2193 25 tokens \u00b7 thinking)`), "marked verb-fragment line").toBe(true);
  expect(hasPartialRepaintCue("na\u2193 25 tokens \u00b7 thinking)"), "unmarked line").toBe(false);
});

test("real with-statusLine turns: exactly these frames read as busy", () => {
  const hits = (name: string): number[] => {
    const cs: Chunk[] = JSON.parse(readFileSync(join(import.meta.dir, "pty-harness", "fixtures", name), "utf8"));
    const cue = createBusyCue({ title: false });
    return cs.flatMap((c, i) => (cue.feed(c.data) ? [i] : []));
  };
  // 30 and 25 are the partial repaints; the others carry a glyph, a verb or the bare timer.
  expect(hits("turn-with-statusline-count.json"), "count turn").toEqual([21, 30, 35, 43]);
  expect(hits("turn-with-statusline-hi.json"), "hi turn").toEqual([22, 25]);
  expect(hits("turn-no-statusline-count.json"), "count turn, footer hint shown").toEqual([10, 15, 24, 30, 38]);
  expect(hits("turn-no-statusline-hi.json"), "hi turn, footer hint shown").toEqual([10, 15, 19]);
  for (const idle of ["prompt-idle-with-esc.json", "dialog-open-with-esc.json", "trust-dialog-quick-safety-check.json", "slash-menu-with-esc.json"]) {
    expect(hits(idle), `${idle}: no running turn`).toEqual([]);
  }
});

test("a chooser whose diff shows a timer or token counter keeps its waiting flag", () => {
  const d = new AttentionDetector();
  const events: AttentionEvent[] = [];
  d.on("attention", (e: AttentionEvent) => events.push(e));
  d.feed("s1", PERMISSION);
  d.feed("s1", "\x1b[5;1H  12 +  const t = wait(3s \u00b7 x)\x1b[K\r\n  13 +  // \u2193 12 tokens\x1b[K");
  d.feed("s1", "\x1b[40;1H  Opus 5 \u2502 \u2193 3.4k tokens");
  expect(events, "diff or statusLine text cleared the waiting flag").toEqual([{ id: "s1", waiting: true }]);
  d.feed("s1", FRAME.glyphTokens);
  expect(events, "a real spinner row must clear the flag").toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});
