// PLAN-observabilite-erreurs O1: rolling file logger (shared/logger.ts).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger, coreLogDir } from "../shared/logger.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-logger-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-07-19T10:00:00.000Z");

test("writes one line per entry with timestamp, level and context", () => {
  const log = createLogger({ dir, name: "t", mirrorToConsole: false, now: fixedNow });
  log.info("boot");
  log.warn("odd", { port: 7899 });
  log.error("bad", new Error("boom"));

  const lines = readFileSync(log.file, "utf-8").trimEnd().split("\n");
  expect(lines[0]).toBe("2026-07-19T10:00:00.000Z INFO  boot");
  expect(lines[1]).toBe('2026-07-19T10:00:00.000Z WARN  odd {"port":7899}');
  expect(lines[2]).toStartWith("2026-07-19T10:00:00.000Z ERROR bad Error: boom");
});

test("child(prefix) prefixes lines, nested children accumulate", () => {
  const log = createLogger({ dir, name: "t", mirrorToConsole: false, now: fixedNow });
  log.child("broker").error("db locked");
  log.child("broker").child("timer").info("tick");

  const lines = readFileSync(log.file, "utf-8").trimEnd().split("\n");
  expect(lines[0]).toContain("ERROR [broker] db locked");
  expect(lines[1]).toContain("INFO  [broker] [timer] tick");
});

test("rotates at maxBytes and keeps at most maxFiles files, oldest dropped", () => {
  const log = createLogger({
    dir,
    name: "t",
    maxBytes: 200,
    maxFiles: 3,
    mirrorToConsole: false,
    now: fixedNow,
  });
  // Each line is ~80 bytes; write enough to force several rotations.
  for (let i = 0; i < 40; i++) log.info(`entry-${String(i).padStart(3, "0")}`);

  const files = readdirSync(dir).sort();
  expect(files).toEqual(["t.log", "t.log.1", "t.log.2"]);
  // The newest entry is in the base file, the oldest surviving in .2 --
  // and rotation dropped the earliest entries entirely.
  expect(readFileSync(join(dir, "t.log"), "utf-8")).toContain("entry-039");
  expect(readFileSync(join(dir, "t.log.2"), "utf-8")).not.toContain("entry-000\n");
});

test("boot trim removes rotated files beyond maxFiles", () => {
  writeFileSync(join(dir, "t.log.7"), "stale\n");
  writeFileSync(join(dir, "t.log.2"), "kept\n");
  const log = createLogger({ dir, name: "t", maxFiles: 3, mirrorToConsole: false, now: fixedNow });
  log.info("first");

  expect(existsSync(join(dir, "t.log.7"))).toBe(false);
  expect(existsSync(join(dir, "t.log.2"))).toBe(true);
});

test("a write failure never throws (falls back to console)", () => {
  // Point the logger at a path that cannot be a directory: a regular file.
  const blocked = join(dir, "not-a-dir");
  writeFileSync(blocked, "occupied");
  const log = createLogger({ dir: join(blocked, "logs"), name: "t", mirrorToConsole: false, now: fixedNow });
  expect(() => log.error("lost line")).not.toThrow();
});

test("coreLogDir honors CLAUDE_PEERS_LOG_DIR override", () => {
  expect(coreLogDir({ CLAUDE_PEERS_LOG_DIR: "/x/logs" } as NodeJS.ProcessEnv)).toBe("/x/logs");
  const viaXdg = coreLogDir({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv);
  if (process.platform !== "win32") {
    expect(viaXdg).toBe("/xdg/claude-peers/logs");
  }
});
