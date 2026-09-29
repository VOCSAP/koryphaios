import { test, expect } from "bun:test";

import { ThinkingDetector, type ThinkingEvent } from "../desktop/src/main/thinking.ts";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ----- ThinkingDetector -----

test("emits busy on a marker and idle after the debounce, transitions only", async () => {
  const d = new ThinkingDetector(30);
  const events: ThinkingEvent[] = [];
  d.on("thinking", (e: ThinkingEvent) => events.push(e));

  d.feed("s1", "some output, esc to interrupt, working...");
  d.feed("s1", "still esc to interrupt"); // no second 'true' (already busy)
  expect(events).toEqual([{ id: "s1", busy: true }]);

  await wait(60);
  expect(events).toEqual([
    { id: "s1", busy: true },
    { id: "s1", busy: false }
  ]);
  d.stop();
});

test("detects the braille spinner and strips ANSI around the marker", () => {
  const d = new ThinkingDetector(30);
  const events: ThinkingEvent[] = [];
  d.on("thinking", (e: ThinkingEvent) => events.push(e));
  // Spinner frame wrapped in colour codes.
  d.feed("s1", "\x1b[33m⠹\x1b[0m thinking");
  expect(events).toEqual([{ id: "s1", busy: true }]);
  d.stop();
});

test("non-busy output never flips to busy", () => {
  const d = new ThinkingDetector(30);
  const events: ThinkingEvent[] = [];
  d.on("thinking", (e: ThinkingEvent) => events.push(e));
  d.feed("s1", "just a normal prompt > ");
  expect(events).toEqual([]);
  d.stop();
});

test("clear() cancels the pending idle flip (no stale busy=false leak)", async () => {
  const d = new ThinkingDetector(30);
  const events: ThinkingEvent[] = [];
  d.on("thinking", (e: ThinkingEvent) => events.push(e));
  d.feed("s1", "esc to interrupt");
  expect(events).toEqual([{ id: "s1", busy: true }]);
  d.clear("s1");
  await wait(60);
  // No idle event after clear.
  expect(events).toEqual([{ id: "s1", busy: true }]);
  d.stop();
});
