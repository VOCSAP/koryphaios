// Auto-ack of Claude Code's development-channels warning (issue #42486):
// desktop/src/main/startup-ack. Fixtures mirror the real full-screen dialog;
// the MCP-server consent dialog and prose must NOT trigger it.

import { test, expect } from "bun:test";
import {
  StartupAckDetector,
  detectChannelsWarning,
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
