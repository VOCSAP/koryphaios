// PLAN-v0.4 C11: "needs you" detection (desktop/src/main/attention).
// Fixtures mirror Claude Code's waiting screens (numbered chooser, trust
// prompt); prose/code containing question-like text must NOT trigger.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AttentionDetector,
  detectWaiting,
  stripAnsi,
  type AttentionEvent
} from "../desktop/src/main/attention.ts";

const PERMISSION_SCREEN = `
Bash command: rm -rf node_modules
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No (esc)
`;

const TRUST_SCREEN = `Do you trust the files in this folder?`;

function collect(d: AttentionDetector): AttentionEvent[] {
  const events: AttentionEvent[] = [];
  d.on("attention", (e: AttentionEvent) => events.push(e));
  return events;
}

test("detectWaiting matches the numbered chooser and the trust prompt only", () => {
  expect(detectWaiting(PERMISSION_SCREEN)).toBe(true);
  expect(detectWaiting(TRUST_SCREEN)).toBe(true);
  // Question-like prose without a chooser must not match (streamed content).
  expect(detectWaiting("Do you want to refactor this later? I suggest…")).toBe(false);
  expect(detectWaiting("const menu = ['1.', '2.']")).toBe(false);
});

test("one episode per wait screen; busy output closes it and re-arms", () => {
  const d = new AttentionDetector();
  const events = collect(d);

  d.feed("s1", PERMISSION_SCREEN);
  d.feed("s1", PERMISSION_SCREEN); // redraw while waiting -> no second episode
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  d.feed("s1", "⠹ running… esc to interrupt");
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);

  // A later prompt opens a NEW episode.
  d.feed("s1", TRUST_SCREEN);
  expect(events.length).toBe(3);
  expect(events[2]).toEqual({ id: "s1", waiting: true });
  d.stop();
});

test("a wait screen split across chunks is caught by the rolling buffer", () => {
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", "Do you want to proceed?\n❯ ");
  expect(events.length).toBe(0);
  d.feed("s1", "1. Yes\n  2. No");
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

test("busy output in the same chunk resets stale context but keeps what follows", () => {
  const d = new AttentionDetector();
  const events = collect(d);
  // Old prose accumulates, then a chunk ends the turn AND prints the chooser.
  d.feed("s1", "streaming some prose with ❯ nothing conclusive");
  d.feed("s1", "⠹ esc to interrupt … done.\nDo you want to proceed?\n❯ 1. Yes");
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

test("clear() drops the session state entirely", () => {
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.clear("s1");
  d.feed("s1", "⠹ busy again");
  // No waiting=false leak after clear (state was dropped, not closed).
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

// Card 4f0143ff review, MAJOR 3/4: the dev-channels startup dialog
// ("❯ 1. I am using this for local development") is a numbered chooser by
// construction and must NOT raise the flag, but the exemption must require
// BOTH of startup-ack.ts's cues (title + accept wording), not the title
// alone -- a bare title floating through the buffer must not suppress a
// real, unrelated wait.
const DEV_CHANNELS_TITLE_ONLY = "Loading development channels...\n";
const CHANNELS_WARNING = `WARNING: Loading development channels
This uses unreleased code.
❯ 1. I am using this for local development
  2. Cancel`;

test("a bare dev-channels title (no accept line) does not suppress a later real chooser", () => {
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", DEV_CHANNELS_TITLE_ONLY);
  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

test("a genuinely raised flag is NOT cleared by a bare dev-channels title arriving after it (reverse-order, minimal cue)", () => {
  // Team-lead's asymmetry finding (review of 4f0143ff): the re-scan clearer
  // must never reuse the raise-side exemption. Before the fix this cleared
  // a real chooser's flag the moment the dev-channels title text entered
  // the retained buffer, even though "❯ 1." (the pattern that raised it)
  // never left the screen. Deliberately the WEAKEST possible trigger (title
  // only, no accept wording): see the debugger's full-dialog variant below
  // for the realistic-screen case.
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.feed("s1", DEV_CHANNELS_TITLE_ONLY);
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

// --- Exemption coverage (debugger's fixtures, card 4f0143ff review): each
// case is one way the dev-channels screen can degrade or be imitated.
//
// Which test guards which fix, MEASURED by reverting one change at a time
// and re-running this file (final review of 4f0143ff). Do not trim this
// suite by eye: a test's name says what it exercises, not what it protects,
// and the sole guards below read like adjacent coverage.
//
//   revert `st.buf = ''` at raise time -> fails the two clear-side cases
//     plus the reverse-order one. Sole guards of that fix.
//   revert stillWaiting back to detectWaiting -> fails exactly ONE test,
//     the reverse-order case. Sole guard of the raise/clear asymmetry.
//   revert to the intermediate title-only exemption -> fails the
//     reworded-accept-option case and the genuine-chooser-on-the-same-buffer
//     case. Sole guards of the two-cue predicate. The other two exemption
//     cases pass on BOTH versions: they document adjacent behaviour and
//     protect nothing, which is fine as long as nobody counts them.
//
// NOT guarded by anything in this file, recorded rather than implied:
// deleting the re-scan clearer outright, or making purgeScreenMemory a
// no-op, leaves this suite fully green. Both mechanisms ship without a
// sensitivity test; a card is open for the two that are missing.

test("the channels exemption needs BOTH cues, so a reworded accept option stops exempting", () => {
  const titleOnly = `WARNING: Loading development channels
❯ 1. Continue anyway
  2. Cancel`;
  expect(detectWaiting(CHANNELS_WARNING)).toBe(false);
  expect(detectWaiting(titleOnly)).toBe(true);
});

test("the accept option alone, with the title scrolled off, does not exempt", () => {
  const acceptOnly = `This uses unreleased code.
❯ 1. I am using this for local development
  2. Cancel`;
  expect(detectWaiting(acceptOnly)).toBe(true);
});

test("a genuine chooser rendered on a screen carrying the channels title still raises", () => {
  const mixed = `WARNING: Loading development channels
Bash command: rm -rf /
Do you want to proceed?
❯ 1. Yes
  2. No`;
  expect(detectWaiting(mixed)).toBe(true);
});

test("a reworded title upstream falls back to raising, never to silence", () => {
  const reworded = `WARNING: Loading dev channels
❯ 1. I am using this for local development`;
  expect(detectWaiting(reworded)).toBe(true);
});

test("a pure-ANSI repaint does not clear a raised flag", () => {
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.feed("s1", "\x1b[2J\x1b[1;1H\x1b[?25l\x1b[?25h");
  expect(events.map((e) => e.waiting)).toEqual([true]);
  d.stop();
});

test("the exempted screen arriving later does not clear a raised flag", () => {
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.feed("s1", CHANNELS_WARNING);
  expect(events.map((e) => e.waiting)).toEqual([true]);
  d.stop();
});

test("streamed prose mentioning the exempted wording does not clear a raised flag", () => {
  // The case that matters most: on the intermediate (title-only exemption)
  // version, a single streamed SENTENCE -- not a screen, not a repaint --
  // could wipe a real chooser's flag. An agent narrating its own actions in
  // prose could silently erase the operator's attention request.
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.feed(
    "s1",
    "I checked the docs: loading development channels is what the warning screen is about."
  );
  expect(events.map((e) => e.waiting)).toEqual([true]);
  d.stop();
});

// FIELD CAPTURE, card 00588e6c phase 2. spec_17343687. This frame was
// SYNTHETIC until 2026-08-26 -- built from the pattern startup-ack.ts's
// comment described, on the strength of a 2026-07-28 capture nobody kept.
// It is now the real thing: tests/pty-harness/fixtures/channels-warning-
// conpty-win.json holds 26 real chunks of one Windows PTY session, recorded
// upstream of every detector by KORY_PTY_RAW_CAPTURE (pty-manager.ts,
// proc.onData before handleData). The encoding the old fixture guessed was
// right -- \x1b[1C between words -- but the guess was incomplete: the CLI
// repaints the same dialog in LITERAL spaces ~130 ms later. Both forms must
// stay exempted, so both are asserted below. Provenance and the measurement
// itself live in tests/desktop-startup-ack.test.ts's field-capture block.
type ChannelsChunk = { t: number; data: string };
const CHANNELS_FIELD_CAPTURE: ChannelsChunk[] = JSON.parse(
  readFileSync(
    join(import.meta.dir, "pty-harness", "fixtures", "channels-warning-conpty-win.json"),
    "utf-8"
  )
);

/**
 * The recorded chunks that belong to the channels screen itself, first paint
 * through last repaint. SCOPED DELIBERATELY, and the bound is load-bearing:
 * the capture runs on past the auto-Enter into Claude Code's own welcome
 * screen, whose arrival (chunk 23, the banner plus supervisor.ts's `Start
 * now:` starter prompt) DOES raise attention for ~7 s before clearing itself
 * -- not because that screen matches (it does not, fed alone) but because the
 * channels screen is still in the accumulated buffer and recombines with it.
 * Measured and filed as card d3a4021a; feeding those chunks here would
 * silently turn this exemption test into a red assertion about that bug
 * instead.
 */
const CHANNELS_SCREEN_CHUNKS = (() => {
  const hasCue = (c: ChannelsChunk) =>
    /Loading.{0,8}development.{0,8}channels/.test(stripAnsi(c.data));
  const first = CHANNELS_FIELD_CAPTURE.findIndex(hasCue);
  let last = first;
  CHANNELS_FIELD_CAPTURE.forEach((c, i) => {
    if (hasCue(c)) last = i;
  });
  return CHANNELS_FIELD_CAPTURE.slice(first, last + 1);
})();

test("the ConPTY repaint frame of the channels screen is still exempted (real capture, both spacings)", () => {
  // Guard the slice itself: an empty or one-chunk window would make the
  // assertion below pass while proving nothing. Both spacings must be in it.
  expect(CHANNELS_SCREEN_CHUNKS.length).toBeGreaterThan(1);
  const joined = CHANNELS_SCREEN_CHUNKS.map((c) => c.data).join("");
  expect(joined).toContain("WARNING:\x1b[1CLoading\x1b[1Cdevelopment\x1b[1Cchannels");
  expect(stripAnsi(joined)).toContain("WARNING: Loading development channels");

  const d = new AttentionDetector();
  const events = collect(d);
  // Replayed chunk by chunk, exactly as node-pty delivered them: the
  // compressed first paint AND the literal-space repaints go through.
  for (const c of CHANNELS_SCREEN_CHUNKS) d.feed("s1", c.data);
  expect(events).toEqual([]);
  d.stop();
});

test("purgeScreenMemory clears the retained buffer without touching a live waiting state", () => {
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.purgeScreenMemory("s1");
  // Buffer purged: the re-scan fallback sees only what arrives from here on.
  // A busy cue must still close the episode normally.
  d.feed("s1", "⠹ esc to interrupt");
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});

// Card c8d69928, residu 1 (root cause of the missing guard, mutation-measured
// on the final review of 4f0143ff): the re-scan fallback (feed()'s
// stillWaiting branch, attention.ts ~184) and purgeScreenMemory each have
// ZERO sensitivity in this file before the two tests below -- deleting the
// re-scan branch entirely, or replacing purgeScreenMemory's body with a
// no-op, leaves the 16 tests above fully green. Every test above that raises
// then clears does so via the busy-cue branch (attention.ts:168), which is
// unconditional on buffer content and so proves nothing about either
// mechanism. Measured 2026-08-05 by neutralizing each mechanism in turn and
// re-running this file; see the commit message for the exact red-first
// output of both.

test("card c8d69928 residu 1a: the buffer-slide clearer (path D) actually clears once the raising pattern leaves the MAX_BUF window", () => {
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  // MAX_BUF is 4096 (attention.ts); one feed() chunk over that size, with no
  // busy cue and no waiting-pattern text of its own, fully evicts the
  // retained PERMISSION_SCREEN text from st.buf's trailing window regardless
  // of exactly how many characters the screen fixture itself contributed
  // (slice(-MAX_BUF) on a chunk already longer than MAX_BUF drops the old
  // content outright). This is path D of the MAX_BUF comment: no busy cue,
  // no purge, no manual clear -- only the window sliding past the pattern.
  const ORDINARY_LINE = "The build compiled successfully; no errors were found in the log.\n";
  const filler = ORDINARY_LINE.repeat(Math.ceil(4200 / ORDINARY_LINE.length));
  expect(filler.length).toBeGreaterThan(4096);

  d.feed("s1", filler);
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});

test("card c8d69928 residu 1b: purgeScreenMemory actually empties the buffer, observed without a busy cue", () => {
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  d.purgeScreenMemory("s1");
  // Deliberately NOT a busy cue: the busy-cue branch clears unconditionally
  // regardless of buffer content (attention.ts:168) and would pass even if
  // purgeScreenMemory were a no-op -- exactly the false-negative the
  // pre-existing purge test above has. The bare dev-channels title matches
  // neither WAITING_PATTERNS entry on its own, so stillWaiting() only
  // reports "cleared" here if the buffer no longer carries PERMISSION_SCREEN's
  // "❯ 1." from before the purge -- i.e. only if the purge actually emptied it.
  d.feed("s1", DEV_CHANNELS_TITLE_ONLY);
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});

// Card 1aa69066 (H2): OSC sequences must be stripped, closing a false clear
// BUSY_RE could otherwise produce from a braille glyph carried inside an OSC
// title -- Claude Code's own OSC 0 title is measured to carry the spinner
// glyph (docs/DESIGN-NOTIFY-EVENTS.md), which is exactly BUSY_RE's braille
// range. Direction 1 (presence): stripAnsi actually removes an OSC sequence.
// Direction 2 (regression): a real waiting episode does NOT get cleared by
// OSC-carried noise alone -- only a busy cue in the actual screen content
// should end it.
test("stripAnsi removes an OSC sequence, not just CSI", () => {
  const withOsc = "\x1b]0;⣋title\x07plain screen text";
  expect(stripAnsi(withOsc)).toBe("plain screen text");
});

test("an OSC-carried braille glyph does not spuriously clear a real waiting episode", () => {
  const d = new AttentionDetector();
  const events = collect(d);

  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  // The braille glyph lives ONLY inside the OSC 0 title payload, never in
  // the plain screen text -- a real busy cue would be plain-text, this is
  // exactly the OSC-noise case the fix distinguishes from the real thing.
  d.feed("s1", "\x1b]0;⣋ Claude is thinking\x07");
  expect(events).toEqual([{ id: "s1", waiting: true }]); // still waiting, no false clear

  // A genuine plain-text busy cue still clears it, unaffected by the fix.
  d.feed("s1", "⣋ esc to interrupt");
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});

// Card 1aa69066 (H2) review, blocker F3: the test above only exercises the
// OSC sequence arriving WHOLE within one feed() call -- BUSY_RE's fast path
// tests the raw per-chunk delta immediately (before the accumulated-buffer
// re-strip runs), and a complete single-chunk OSC is already fully stripped
// by that per-chunk regex, so it never distinguished the fix from the bug.
// MEASURED (reviewer, mutation review): reverting BUSY_RE to read raw
// `stripped` left this file's tests green. This is the FRAGMENTED case: the
// braille glyph's introducer arrives in one chunk with no terminator yet, so
// a stateless per-chunk regex cannot remove it and the raw glyph leaks
// straight into BUSY_RE's input on that same chunk.
test("an OSC-carried braille glyph FRAGMENTED across two chunks still does not spuriously clear a real waiting episode", () => {
  const d = new AttentionDetector();
  const events = collect(d);

  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  const osc = "\x1b]0;⣋ Claude is thinking\x07";
  d.feed("s1", osc.slice(0, 12)); // carries the glyph, no terminator yet
  d.feed("s1", osc.slice(12)); // the terminator
  expect(events).toEqual([{ id: "s1", waiting: true }]); // still waiting, no false clear

  d.stop();
});
