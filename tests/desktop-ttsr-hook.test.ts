// The pure decide()/trace() functions cover the matching logic directly and
// fast; the end-to-end spawns of the real .mjs (self-built, not the checked-in
// bundle -- it isn't committed) cover the process boundary: stdin parsing,
// stdout shape, exit code, and the fail-open trace sink.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { decide, parseHookPayload, trace, type HookPayload } from "../desktop/hooks/ttsr-hook.ts";

const DESKTOP_DIR = resolve(import.meta.dir, "..", "desktop");
const FIXTURES_DIR = join(import.meta.dir, "fixtures", "ttsr");

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(fixturePath(name), "utf-8")) as T;
}

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CLAUDE_PEERS_TTSR_FILE;
  delete process.env.CLAUDE_PEERS_TTSR_LOG;
  delete process.env.CLAUDE_PROJECT_DIR;
});

// --- Unit level: decide() against the fixtures, no subprocess ---

test("decide(): no CLAUDE_PEERS_TTSR_FILE set -> null (no decision)", () => {
  delete process.env.CLAUDE_PEERS_TTSR_FILE;
  const payload = loadJson<HookPayload>("payload-deny-write.json");
  expect(decide(payload)).toBeNull();
});

test("decide(): effective file does not exist -> null, not an error", () => {
  process.env.CLAUDE_PEERS_TTSR_FILE = join(makeTmpDir("ttsr-missing-"), "nope.json");
  const payload = loadJson<HookPayload>("payload-deny-write.json");
  expect(decide(payload)).toBeNull();
});

test("decide(): a Write matching the deny rule -> permissionDecision deny, message present", () => {
  process.env.CLAUDE_PEERS_TTSR_FILE = fixturePath("effective-basic.json");
  const payload = loadJson<HookPayload>("payload-deny-write.json");
  const out = decide(payload) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } };
  expect(out).not.toBeNull();
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain("kory/no-secret");
});

test("decide(): an Edit matching the warn rule -> additionalContext, NEVER permissionDecision allow", () => {
  process.env.CLAUDE_PEERS_TTSR_FILE = fixturePath("effective-basic.json");
  const payload = loadJson<HookPayload>("payload-warn-edit.json");
  const out = decide(payload) as {
    hookSpecificOutput: { additionalContext?: string; permissionDecision?: string };
  };
  expect(out).not.toBeNull();
  // The central safety guarantee this hook must never violate: a warn match
  // must never carry permissionDecision "allow", which would skip the
  // operator's own permission prompt for this tool call.
  expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(out.hookSpecificOutput.additionalContext).toContain("repo/no-console-error");
});

test("decide(): a call matching no rule -> null", () => {
  process.env.CLAUDE_PEERS_TTSR_FILE = fixturePath("effective-basic.json");
  const payload = loadJson<HookPayload>("payload-no-match.json");
  expect(decide(payload)).toBeNull();
});

test("decide(): an invalid effective file -> null (fails open), never a thrown error", () => {
  process.env.CLAUDE_PEERS_TTSR_FILE = fixturePath("effective-corrupt.json");
  const payload = loadJson<HookPayload>("payload-deny-write.json");
  expect(decide(payload)).toBeNull();
});

test("parseHookPayload degrades malformed/empty stdin to {} instead of throwing", () => {
  expect(parseHookPayload("")).toEqual({});
  expect(parseHookPayload("not json")).toEqual({});
  expect(parseHookPayload("null")).toEqual({});
});

test("trace(): writes to $CLAUDE_PEERS_TTSR_LOG when set, and never throws when the path is unwritable", () => {
  const logPath = join(makeTmpDir("ttsr-log-"), "ttsr.log");
  process.env.CLAUDE_PEERS_TTSR_LOG = logPath;
  trace("hello from a test");
  expect(existsSync(logPath)).toBe(true);
  expect(readFileSync(logPath, "utf-8")).toContain("hello from a test");

  process.env.CLAUDE_PEERS_TTSR_LOG = "/nonexistent-dir-xyz/ttsr.log";
  expect(() => trace("must not throw even on a bad log path")).not.toThrow();
});

// --- End-to-end: the real, self-built .mjs over stdin/stdout/exit code ---

let builtMjsPath: string;
let buildScratchDir: string;
beforeAll(async () => {
  // Deliberately NOT pushed to `tmpDirs`: that array is drained by the
  // per-test afterEach above, which would delete this build directory (and
  // every subsequent end-to-end test's spawn target with it) right after the
  // first unit test finishes.
  buildScratchDir = mkdtempSync(join(tmpdir(), "ttsr-hook-selfbuild-"));
  builtMjsPath = join(buildScratchDir, "ttsr-hook.mjs");
  const proc = Bun.spawn(
    ["bun", "build", "hooks/ttsr-hook.ts", "--target=node", `--outfile=${builtMjsPath}`],
    { cwd: DESKTOP_DIR, stdout: "ignore", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`self-build of ttsr-hook.mjs failed (exit ${exitCode}): ${stderr}`);
  }
});

afterAll(() => {
  rmSync(buildScratchDir, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function buildEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

async function runHookMjs(stdinText: string, envOverrides: Record<string, string | undefined>): Promise<RunResult> {
  const proc = Bun.spawn(["bun", builtMjsPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: buildEnv(envOverrides),
  });
  proc.stdin.write(stdinText);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

test("real .mjs, no env var at all: exit 0, empty stdout", async () => {
  const payload = readFileSync(fixturePath("payload-deny-write.json"), "utf-8");
  const result = await runHookMjs(payload, { CLAUDE_PEERS_TTSR_FILE: undefined });
  expect(result.stdout).toBe("");
  expect(result.exitCode).toBe(0);
});

test("real .mjs, deny case: exit 0, stdout carries permissionDecision deny", async () => {
  const payload = readFileSync(fixturePath("payload-deny-write.json"), "utf-8");
  const result = await runHookMjs(payload, { CLAUDE_PEERS_TTSR_FILE: fixturePath("effective-basic.json") });
  expect(result.exitCode).toBe(0);
  const decision = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision?: string } };
  expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
});

test("real .mjs, warn case: exit 0, stdout carries additionalContext, no permissionDecision", async () => {
  const payload = readFileSync(fixturePath("payload-warn-edit.json"), "utf-8");
  const result = await runHookMjs(payload, { CLAUDE_PEERS_TTSR_FILE: fixturePath("effective-basic.json") });
  expect(result.exitCode).toBe(0);
  const decision = JSON.parse(result.stdout) as {
    hookSpecificOutput: { additionalContext?: string; permissionDecision?: string };
  };
  expect(decision.hookSpecificOutput.additionalContext).toContain("repo/no-console-error");
  expect(decision.hookSpecificOutput.permissionDecision).toBeUndefined();
});

test("real .mjs, corrupt effective file: exit 0, empty stdout, a stderr trace, and a log-file line", async () => {
  const scratch = makeTmpDir("ttsr-corrupt-log-");
  const logPath = join(scratch, "ttsr.log");
  const payload = readFileSync(fixturePath("payload-deny-write.json"), "utf-8");
  const result = await runHookMjs(payload, {
    CLAUDE_PEERS_TTSR_FILE: fixturePath("effective-corrupt.json"),
    CLAUDE_PEERS_TTSR_LOG: logPath,
  });
  expect(result.stdout).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("[ttsr-hook]");
  expect(result.stderr.toLowerCase()).toContain("invalid effective rules file");
  expect(existsSync(logPath)).toBe(true);
  expect(readFileSync(logPath, "utf-8")).toContain("[ttsr-hook]");
});

test("real .mjs: syntactically invalid JSON on stdin exits 0 with empty stdout (fail-open, not a crash)", async () => {
  const result = await runHookMjs("{ this is not valid json ", {
    CLAUDE_PEERS_TTSR_FILE: fixturePath("effective-basic.json"),
  });
  expect(result.stdout).toBe("");
  expect(result.exitCode).toBe(0);
});

test("real .mjs: empty stdin exits 0 with empty stdout", async () => {
  const result = await runHookMjs("", { CLAUDE_PEERS_TTSR_FILE: fixturePath("effective-basic.json") });
  expect(result.stdout).toBe("");
  expect(result.exitCode).toBe(0);
});
