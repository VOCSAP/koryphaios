// Auto-ack of Claude Code's development-channels warning (issue #42486):
// desktop/src/main/startup-ack. Fixtures mirror the real full-screen dialog;
// the MCP-server consent dialog and prose must NOT trigger it.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  // ConPTY's resize repaint encodes inter-word spaces as \x1b[1C, which
  // ANSI-stripping removes entirely, joining the words together; patterns use
  // \s* so this frame still acks.
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

// Positive control for the accumulated-buffer re-strip: a per-chunk-only strip
// can't remove an OSC title split across two PTY chunks landing mid-cue, since
// chunk 1's OSC half has no terminator yet within that single chunk.
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

// Real captured Windows ConPTY stream: the first paint uses \x1b[1C throughout,
// but roughly 130ms later the same screen repaints with literal spaces.
// Both encodings occur within one session, so a space-anchored-only pattern
// would miss the first frame and only match the repaint -- a two-frame delay
// nobody notices until a version stops repainting.

type FieldChunk = { t: number; data: string };
const CHANNELS_FIELD_CAPTURE: FieldChunk[] = JSON.parse(
  readFileSync(
    join(import.meta.dir, "pty-harness", "fixtures", "channels-warning-conpty-win.json"),
    "utf-8"
  )
);

/** Index of the first recorded chunk that paints either warning cue. */
const FIRST_PAINT = CHANNELS_FIELD_CAPTURE.findIndex((c) =>
  /Loading|I.{0,8}am.{0,8}using/.test(stripAnsi(c.data))
);

test("field capture: the real ConPTY channels screen acks on its FIRST paint, fed chunk by chunk as the PTY delivered it", () => {
  const d = new StartupAckDetector();
  const events = collect(d);
  // One feed() per recorded chunk, in order: a pre-joined string would
  // silently skip the accumulation the detector depends on in production,
  // and would hide WHICH frame decided.
  let ackedAfter = -1;
  CHANNELS_FIELD_CAPTURE.forEach((c, i) => {
    d.feed("s1", c.data);
    if (ackedAfter === -1 && events.length > 0) ackedAfter = i;
  });
  expect(events).toEqual([{ id: "s1" }]);
  // The `\s*` earns its keep here and nowhere else: the ack fires on the
  // COMPRESSED first paint, not two repaints later. Pin the index, not just
  // the event -- an ack that slipped to the repaint would still be green
  // above while the detector had silently lost the frame it is written for.
  expect(ackedAfter).toBe(FIRST_PAINT);
});

test("field capture: the FIRST paint encodes inter-word spaces as \\x1b[1C, so a space-anchored pattern misses it", () => {
  const first = CHANNELS_FIELD_CAPTURE[FIRST_PAINT]!.data;
  // The encoding itself, measured on the wire, both cues in one chunk.
  expect(first).toContain("WARNING:\x1b[1CLoading\x1b[1Cdevelopment\x1b[1Cchannels");
  expect(first).toContain("I\x1b[1Cam\x1b[1Cusing\x1b[1Cthis\x1b[1Cfor\x1b[1Clocal\x1b[1Cdevelopment");

  // NEGATIVE CONTROL, and the whole point of the `\s*` in
  // CHANNELS_WARNING_PATTERNS: once stripped, the words are GLUED. A pattern
  // written with literal spaces -- the obvious way to write it -- sees
  // nothing on this frame, while the shipped one matches.
  const stripped = stripAnsi(first);
  expect(stripped).toContain("WARNING:Loadingdevelopmentchannels");
  expect(/loading development channels/i.test(stripped)).toBe(false);
  expect(detectChannelsWarning(stripped)).toBe(true);
});

test("field capture: the LATER repaints of the same screen use literal spaces -- both encodings are real", () => {
  // The CLI repaints the same dialog in plain spaces a fraction of a second
  // after the ANSI-coded first paint, which is why \s* (zero or more), not a
  // hardcoded \x1b[1C, is the right quantifier.
  const later = CHANNELS_FIELD_CAPTURE.slice(FIRST_PAINT + 1)
    .map((c) => stripAnsi(c.data))
    .filter((s) => /WARNING: Loading development channels/.test(s));
  expect(later.length).toBeGreaterThan(0);
  // And a detector fed ONLY the repaints still acks: the two cues survive
  // the alternate spacing.
  const d = new StartupAckDetector();
  const events = collect(d);
  for (const c of CHANNELS_FIELD_CAPTURE.slice(FIRST_PAINT + 1)) d.feed("s2", c.data);
  expect(events).toEqual([{ id: "s2" }]);
});
