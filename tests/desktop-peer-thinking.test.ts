import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeCwdKey,
  sanitizeSessionId,
  resolvePeerId
} from "../desktop/src/main/peer-state.ts";
import { ThinkingDetector, type ThinkingEvent } from "../desktop/src/main/thinking.ts";

const tmpDirs: string[] = [];
function tmpPeersDir(): string {
  const d = mkdtempSync(join(tmpdir(), "peers-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ----- sanitizeSessionId (mirror of shared/peer-cache.ts) -----

test("sanitizeSessionId replaces non-[A-Za-z0-9-] with '_' and caps at 64", () => {
  expect(sanitizeSessionId("abc-123")).toBe("abc-123");
  expect(sanitizeSessionId("a b/c.d")).toBe("a_b_c_d");
  expect(sanitizeSessionId(undefined)).toBe("");
  expect(sanitizeSessionId("x".repeat(80)).length).toBe(64);
});

// ----- resolvePeerId -----

test("resolves the exact per-session file deterministically", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  const sid = "11111111-2222-3333-4444-555555555555";
  writeFileSync(join(dir, `peer-id-${key}-${sid}.txt`), "dev-pc-proj-2\n", "utf-8");
  // A different, newer session file for the same cwd must NOT win.
  writeFileSync(join(dir, `peer-id-${key}-99999999.txt`), "other-peer", "utf-8");
  expect(resolvePeerId(cwd, sid, dir)).toBe("dev-pc-proj-2");
});

test("falls back to the newest file when the exact one is absent", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  const older = join(dir, `peer-id-${key}-aaaa.txt`);
  const newer = join(dir, `peer-id-${key}-bbbb.txt`);
  writeFileSync(older, "older-peer", "utf-8");
  writeFileSync(newer, "newer-peer", "utf-8");
  // Make `newer` clearly the most recent.
  const now = Date.now() / 1000;
  utimesSync(older, now - 100, now - 100);
  utimesSync(newer, now, now);
  // sessionId 'cccc' has no exact file -> newest fallback.
  expect(resolvePeerId(cwd, "cccc", dir)).toBe("newer-peer");
});

test("returns null when nothing matches", () => {
  const dir = tmpPeersDir();
  expect(resolvePeerId("/home/u/empty", "sid", dir)).toBeNull();
});

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
