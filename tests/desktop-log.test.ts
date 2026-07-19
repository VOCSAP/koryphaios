// PLAN-observabilite-erreurs O3: main-process rolling log + journal snapshot
// (desktop/src/main/log.ts -- pure module, electron-free).

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRollingLogger, flushJournalSnapshot } from "../desktop/src/main/log";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-decklog-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-07-19T10:00:00.000Z");

test("rolling logger writes leveled lines and rotates at maxBytes", () => {
  const log = createRollingLogger({
    dir,
    name: "main",
    maxBytes: 150,
    maxFiles: 2,
    mirrorToConsole: false,
    now: fixedNow,
  });
  log.error("[scope] boom", new Error("cause"));
  for (let i = 0; i < 20; i++) log.info(`entry-${i}`);

  const files = readdirSync(dir).sort();
  expect(files).toEqual(["main.log", "main.log.1"]);
  expect(readFileSync(join(dir, "main.log"), "utf-8")).toContain("entry-19");
});

test("flushJournalSnapshot writes a stamped file and prunes old snapshots", () => {
  const stale = join(dir, "journal-old.log");
  writeFileSync(stale, "old run\n");
  const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
  utimesSync(stale, tenDaysAgo, tenDaysAgo);
  const recent = join(dir, "journal-recent.log");
  writeFileSync(recent, "recent run\n");

  const path = flushJournalSnapshot(dir, "line 1\nline 2", 7, fixedNow);

  expect(path).not.toBeNull();
  expect(readFileSync(path!, "utf-8")).toBe("line 1\nline 2\n");
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(recent)).toBe(true);
});

test("flushJournalSnapshot skips empty journals and never throws", () => {
  expect(flushJournalSnapshot(dir, "   ", 7, fixedNow)).toBeNull();
  // Unwritable dir (a regular file in the way): best-effort null.
  const blocked = join(dir, "not-a-dir");
  writeFileSync(blocked, "occupied");
  expect(flushJournalSnapshot(join(blocked, "logs"), "text", 7, fixedNow)).toBeNull();
});
