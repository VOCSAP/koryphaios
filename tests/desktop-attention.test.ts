// PLAN-v0.4 C11: "needs you" detection (desktop/src/main/attention).
// Fixtures mirror Claude Code's waiting screens (numbered chooser, trust
// prompt); prose/code containing question-like text must NOT trigger.

import { test, expect } from "bun:test";
import {
  AttentionDetector,
  detectWaiting,
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

// SYNTHETIC frame (no field capture available for this fix -- see
// startup-ack.ts's "field capture, 2026-07-28 audit" comment, which predates
// this card; that capture itself was not retrievable). Built from the
// pattern the comment describes (ConPTY inter-word spacing as \x1b[1C cursor
// moves), not from a captured PTY log -- do not read this as terrain proof.
test("the ConPTY repaint frame of the channels screen is still exempted", () => {
  const conpty =
    "\x1b[2J\x1b[H" +
    "WARNING:\x1b[1CLoading\x1b[1Cdevelopment\x1b[1Cchannels\r\n" +
    "❯\x1b[1C1.\x1b[1CI\x1b[1Cam\x1b[1Cusing\x1b[1Cthis\x1b[1Cfor\x1b[1Clocal\x1b[1Cdevelopment\r\n";
  const d = new AttentionDetector();
  const events = collect(d);
  d.feed("s1", conpty);
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
