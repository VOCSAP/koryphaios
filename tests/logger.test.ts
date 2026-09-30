import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger, coreLogDir, stderrMirror } from "../shared/logger.ts";
import { MAX_LOGGED_CHARS } from "../shared/log-redact.ts";

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

const tails = ["Q7vX2mR9kL4pW8nZ3cT6", "H5jN1bF8sD3gY6uE0aK9", "P2wM7qT4xV9cB1nL6rZ8"];
const anthropicKey = ["sk", "ant", "api03", tails[0]].join("-");

test("the log file never carries a value from a message, an error stack or a context object", () => {
  const log = createLogger({ dir, name: "t", mirrorToConsole: false, now: fixedNow });
  log.warn(`upstream refused Bearer ${tails[1]}`, { apiKey: tails[2] });
  log.error("provider failed", new Error(`provider rejected ${anthropicKey}`));

  const text = readFileSync(log.file, "utf-8");
  for (const tail of tails) expect(text, `value ${tail} left in clear in the core log`).not.toContain(tail);
  expect(text).toContain("upstream refused Bearer [redacted]");
  expect(text).toContain("provider rejected [redacted]");
});

test("the console mirror prints the masked line", () => {
  const printed: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { printed.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { printed.push(args.join(" ")); };
  try {
    const log = createLogger({ dir, name: "t", mirrorToConsole: true, now: fixedNow });
    log.info(`register with Bearer ${tails[1]}`);
    log.error("provider failed", new Error(`provider rejected ${anthropicKey}`));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  expect(printed.length).toBe(2);
  for (const tail of tails) expect(printed.join("\n"), `value ${tail} left in clear on the console`).not.toContain(tail);
});

test("the stderr mirror of a stdio process prints its tagged line masked, and logs the same entry to the file", () => {
  const printed: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { printed.push(args.join(" ")); };
  const fileLog = createLogger({ dir, name: "t", mirrorToConsole: false, now: fixedNow });
  try {
    const { log, logError } = stderrMirror(fileLog, "claude-peers");
    log(`register with Bearer ${tails[1]}`);
    logError(`provider rejected ${anthropicKey}`, new Error(`stack carries ${anthropicKey}`));
  } finally {
    console.error = originalError;
  }
  expect(printed).toEqual([
    "[claude-peers] register with Bearer [redacted]",
    "[claude-peers] provider rejected [redacted]",
  ]);
  const text = readFileSync(fileLog.file, "utf-8");
  for (const tail of tails) expect(text, `value ${tail} left in clear in the core log`).not.toContain(tail);
  expect(text).toContain("register with Bearer [redacted]");
});

test("a line longer than the logged cap is truncated before it reaches the file", () => {
  const log = createLogger({ dir, name: "t", mirrorToConsole: false, now: fixedNow });
  log.info(`Bearer ${tails[1]} ${"x".repeat(MAX_LOGGED_CHARS * 4)}`);
  const line = readFileSync(log.file, "utf-8").trimEnd();
  expect(line.length).toBeLessThanOrEqual(MAX_LOGGED_CHARS);
  expect(line).not.toContain(tails[1]!);
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
  for (let i = 0; i < 40; i++) log.info(`entry-${String(i).padStart(3, "0")}`);

  const files = readdirSync(dir).sort();
  expect(files).toEqual(["t.log", "t.log.1", "t.log.2"]);
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
