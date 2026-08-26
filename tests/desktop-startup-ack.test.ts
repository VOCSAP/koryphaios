// Auto-ack of Claude Code's development-channels warning (issue #42486):
// desktop/src/main/startup-ack. Fixtures mirror the real full-screen dialog;
// the MCP-server consent dialog and prose must NOT trigger it.

import { test, expect } from "bun:test";
import {
  StartupAckDetector,
  detectChannelsWarning,
  stripAnsi,
  type StartupAckEvent
} from "../desktop/src/main/startup-ack.ts";

// The dialog the channels flag raises before Claude Code's UI (both cues).
const CHANNELS_WARNING = `
╭──────────────────────────────────────────────╮
│  WARNING: Loading development channels          │
│                                                 │
│  server:claude-peers                            │
│                                                 │
│  ❯ 1. I am using this for local development     │
│    2. Exit                                       │
╰──────────────────────────────────────────────╯
`;

// The project-consent dialog: DIFFERENT decision, must never auto-ack.
const MCP_CONSENT = `New MCP server found in this project: claude-peers
❯ 1. Use this MCP server
  2. Continue without it`;

function collect(d: StartupAckDetector): StartupAckEvent[] {
  const events: StartupAckEvent[] = [];
  d.on("ack", (e: StartupAckEvent) => events.push(e));
  return events;
}

test("detectChannelsWarning requires BOTH the title and the accept wording", () => {
  expect(detectChannelsWarning(CHANNELS_WARNING)).toBe(true);
  // Title alone (e.g. a log line) is not enough.
  expect(detectChannelsWarning("WARNING: Loading development channels")).toBe(false);
  // Accept wording alone is not enough.
  expect(detectChannelsWarning("I am using this for local development")).toBe(false);
  // The MCP-server consent dialog must never match.
  expect(detectChannelsWarning(MCP_CONSENT)).toBe(false);
  // Prose mentioning the feature must not match.
  expect(detectChannelsWarning("I am loading development channels to test the webhook.")).toBe(false);
});

test("emits ack once when the warning appears, across chunk boundaries", () => {
  const d = new StartupAckDetector();
  const events = collect(d);
  // Split the dialog across two feeds: the buffer accumulates.
  d.feed("s1", "WARNING: Loading development channels\nserver:claude-peers\n");
  expect(events.length).toBe(0);
  d.feed("s1", "❯ 1. I am using this for local development\n  2. Exit\n");
  expect(events).toEqual([{ id: "s1" }]);
  // Further output from the same run does not re-fire.
  d.feed("s1", "some later banner\nI am using this for local development (echoed)\n");
  expect(events.length).toBe(1);
});

test("ANSI escapes in the dialog are stripped before matching", () => {
  const d = new StartupAckDetector();
  const events = collect(d);
  d.feed(
    "s1",
    "\x1b[1mWARNING: Loading development channels\x1b[0m\n\x1b[7m❯ 1. I am using this for local development\x1b[0m\n"
  );
  expect(events).toEqual([{ id: "s1" }]);
});

test("matches the ConPTY repaint frame where spaces are cursor-forward sequences", () => {
  // Real Windows capture (2026-07-28 audit): the ConPTY resize repaint encodes
  // every inter-word space as \x1b[1C, which the ANSI strip removes entirely --
  // the words arrive JOINED ("WARNING:Loadingdevelopmentchannels"). The
  // patterns use \s* so this frame still acks.
  const d = new StartupAckDetector();
  const events = collect(d);
  d.feed(
    "s1",
    "\x1b[1m\x1b[3;3HWARNING:\x1b[1CLoading\x1b[1Cdevelopment\x1b[1Cchannels\x1b[m" +
      "\x1b[9;3H\x1b[38;2;177;185;249m❯\x1b[1C1.\x1b[1CI\x1b[1Cam\x1b[1Cusing\x1b[1Cthis\x1b[1Cfor\x1b[1Clocal\x1b[1Cdevelopment"
  );
  expect(events).toEqual([{ id: "s1" }]);
});

test("the MCP-server consent dialog never fires an ack", () => {
  const d = new StartupAckDetector();
  const events = collect(d);
  d.feed("s1", MCP_CONSENT);
  expect(events.length).toBe(0);
});

test("clear() re-arms a session for the next process run", () => {
  const d = new StartupAckDetector();
  const events = collect(d);
  d.feed("s1", CHANNELS_WARNING);
  expect(events.length).toBe(1);
  // A restart clears state; the warning of the fresh process acks again.
  d.clear("s1");
  d.feed("s1", CHANNELS_WARNING);
  expect(events.length).toBe(2);
});

test("sessions are independent", () => {
  const d = new StartupAckDetector();
  const events = collect(d);
  d.feed("s1", CHANNELS_WARNING);
  d.feed("s2", "just some normal output\n");
  expect(events).toEqual([{ id: "s1" }]);
});

// Card 1aa69066 (H2): OSC sequences must be stripped, same fix as
// attention.ts/quota.ts. Direction 1 (presence): stripAnsi actually removes
// an OSC sequence. Direction 2 (the strip must not remove signal this
// detector still needs): the two-cue warning dialog still acks when an OSC
// title update happens to be interleaved with it -- proving the fix strips
// OSC bytes specifically, not the surrounding plain text the detector reads.
test("stripAnsi removes an OSC sequence, not just CSI", () => {
  const withOsc = "\x1b]0;busy\x07plain screen text";
  expect(stripAnsi(withOsc)).toBe("plain screen text");
});

test("the dev-channels warning still acks when an OSC title update is interleaved with it", () => {
  const d = new StartupAckDetector();
  const events = collect(d);
  d.feed(
    "s1",
    `\x1b]0;busy\x07WARNING: Loading development channels\n` +
      `\x1b]0;still busy\x07❯ 1. I am using this for local development\n`
  );
  expect(events).toEqual([{ id: "s1" }]);
});

// Card 1aa69066 (H2) review, blocker F2: the test above only exercises an OSC
// sequence that arrives WHOLE within one feed() call -- a per-chunk-only
// strip already handles that case, so it does not distinguish the fix (the
// accumulated-buffer re-strip) from the bug it closes. MEASURED (reviewer,
// mutation review): removing the accumulated-buffer re-strip left EVERY
// existing test in this suite green -- the fragmentation-across-chunks
// mechanism this file's own header comment describes was covered by
// nothing. This is the POSITIVE CONTROL: an OSC 0 title split across two PTY
// chunks, landing in the MIDDLE of the second warning cue. Only the
// accumulated-buffer re-strip can remove it -- a per-chunk strip cannot,
// because chunk 1's OSC half has no terminator yet, so nothing matches
// within that single chunk string. Two witnesses alongside it: the same OSC
// whole in one chunk (already covered above, repeated here for direct
// comparison) and no OSC at all (baseline) -- both must still ack.
test("the warning still acks when its OSC title update is FRAGMENTED across chunks, landing mid-cue", () => {
  const fragmented = new StartupAckDetector();
  const fragmentedEvents = collect(fragmented);
  fragmented.feed("s1", "WARNING: Loading development channels\n❯ 1. I am using this for local dev");
  fragmented.feed("s1", "\x1b]0;✳ Claude");
  fragmented.feed("s1", " Code\x07elopment\n");
  expect(fragmentedEvents).toEqual([{ id: "s1" }]);

  const whole = new StartupAckDetector();
  const wholeEvents = collect(whole);
  whole.feed("s1", "WARNING: Loading development channels\n❯ 1. I am using this for local dev");
  whole.feed("s1", "\x1b]0;✳ Claude Code\x07elopment\n");
  expect(wholeEvents).toEqual([{ id: "s1" }]);

  const noOsc = new StartupAckDetector();
  const noOscEvents = collect(noOsc);
  noOsc.feed("s1", "WARNING: Loading development channels\n❯ 1. I am using this for local dev");
  noOsc.feed("s1", "elopment\n");
  expect(noOscEvents).toEqual([{ id: "s1" }]);
});
