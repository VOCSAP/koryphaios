// The pure decide()/trace() functions cover the matching logic directly and
// fast; the end-to-end spawns of the real .mjs (self-built, not the checked-in
// bundle -- it isn't committed) cover the process boundary: stdin parsing,
// stdout shape, exit code, and the fail-open trace sink.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  composeWallDecision,
  decide,
  overBudgetTraceLine,
  parseHookPayload,
  readExisting,
  runHook,
  runHookBounded,
  trace,
  type HookPayload,
  type WorkerInput,
} from "../desktop/hooks/ttsr-hook.ts";
import { KORY_EFFECTIVE_RULES } from "../desktop/src/shared/ttsr-builtin";

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
  expect(
    out.hookSpecificOutput.permissionDecision,
    'a warn match must never carry a permissionDecision: "allow" would skip the operator\'s permission prompt for this call'
  ).toBeUndefined();
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

test("parseHookPayload degrades malformed/empty stdin to {} instead of throwing, with a trace", () => {
  const logPath = join(makeTmpDir("ttsr-payload-log-"), "ttsr.log");
  process.env.CLAUDE_PEERS_TTSR_LOG = logPath;
  expect(parseHookPayload("")).toEqual({});
  expect(parseHookPayload("not json")).toEqual({});
  expect(parseHookPayload("null")).toEqual({});
  expect(parseHookPayload("[1]")).toEqual({});
  const log = readFileSync(logPath, "utf-8");
  expect(log.match(/stdin is not JSON/g), "each unparsable stdin leaves a trace").toHaveLength(2);
  expect(log.match(/stdin is not a JSON object/g), "each non-object stdin leaves a trace").toHaveLength(2);
});

test("decide(): an effective file that exists but cannot be read (a directory) is traced, not silently skipped", () => {
  const dir = makeTmpDir("ttsr-eisdir-");
  process.env.CLAUDE_PEERS_TTSR_FILE = dir;
  process.env.CLAUDE_PEERS_TTSR_LOG = join(dir, "..", `${basename(dir)}.log`);
  tmpDirs.push(process.env.CLAUDE_PEERS_TTSR_LOG);
  expect(decide(loadJson<HookPayload>("payload-deny-write.json"))).toBeNull();
  expect(readFileSync(process.env.CLAUDE_PEERS_TTSR_LOG, "utf-8")).toContain(`cannot read effective rules file ${dir}`);
});

test("runHook(): a decide() that throws fails open with a trace, never a decision", () => {
  const logPath = join(makeTmpDir("ttsr-throw-"), "ttsr.log");
  process.env.CLAUDE_PEERS_TTSR_LOG = logPath;
  const out = runHook(JSON.stringify({ hook_event_name: "PreToolUse" }), () => {
    throw new Error("boom in decide");
  });
  expect(out, "an internal error must fail open: no stdout decision").toBe("");
  expect(readFileSync(logPath, "utf-8")).toContain("internal error, failing open: boom in decide");
});

test("decide(): a deny rule whose path cannot be resolved (ELOOP) denies by default, traced", () => {
  const dir = realpathSync.native(makeTmpDir("ttsr-eloop-"));
  symlinkSync(join(dir, "b"), join(dir, "a"));
  symlinkSync(join(dir, "a"), join(dir, "b"));
  const eff = join(dir, "eff.json");
  const scoped = { id: "scoped", event: "PreToolUse", tools: ["Write"], field: "added", paths: ["src/**"], pattern: "SECRET_TOKEN",
    mode: "deny", message: "m", source: "repo", qualifiedId: "repo/scoped" };
  const plain = { ...scoped, id: "plain", source: "kory", qualifiedId: "kory/plain" } as Record<string, unknown>;
  delete plain.paths;
  process.env.CLAUDE_PEERS_TTSR_FILE = eff;
  process.env.CLAUDE_PEERS_TTSR_LOG = join(dir, "hook.log");
  process.env.CLAUDE_PROJECT_DIR = dir;
  const payload = { hook_event_name: "PreToolUse", tool_name: "Write", cwd: dir, tool_input: { file_path: join(dir, "a", "x.ts"), content: "SECRET_TOKEN" } };
  // The failing rule is the Kory one, so it runs first in deny order.
  writeFileSync(eff, JSON.stringify({ version: 1, rules: [{ ...scoped, source: "kory", qualifiedId: "kory/scoped" }, { ...plain, source: "user", qualifiedId: "user/plain" }] }));
  const out = decide(payload) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } };
  expect(out?.hookSpecificOutput.permissionDecision, "a deny that could not be evaluated is not let through").toBe("deny");
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain("kory/scoped");
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain("rule evaluation failed; denied by default");
  expect(readFileSync(join(dir, "hook.log"), "utf-8")).toContain("rule evaluation threw (deny, denied by default): kory/scoped");
});

test("decide(): a deny regex cut at the JavaScriptCore match limit denies, and the overrun is traced", () => {
  const dir = makeTmpDir("ttsr-budget-");
  const eff = join(dir, "eff.json");
  const rule = { id: "deny-danger", event: "PreToolUse", tools: ["Bash"], field: "command", pattern: "x(?:ab|a|b)*$|DANGER",
    mode: "deny", message: "DANGER is denied", source: "user", qualifiedId: "user/deny-danger" };
  writeFileSync(eff, JSON.stringify({ version: 1, rules: [rule] }));
  process.env.CLAUDE_PEERS_TTSR_FILE = eff;
  process.env.CLAUDE_PEERS_TTSR_LOG = join(dir, "hook.log");
  const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command: `echo x${"ab".repeat(40)}! DANGER` } };
  const out = decide(payload) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } };
  expect(out?.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain("denied by default");
  expect(readFileSync(join(dir, "hook.log"), "utf-8")).toMatch(
    /regex over budget \(deny, denied by default\): user\/deny-danger took \d+ ms on command \(94 chars\), budget 50 ms/
  );
});

test("overBudgetTraceLine(): one wording per reason, naming what was decided", () => {
  const at = { qualifiedId: "user/r", field: "added" as const, chars: 12 };
  expect(overBudgetTraceLine({ ...at, mode: "deny", reason: "deadline", ms: 2104 })).toBe(
    "evaluation deadline exceeded (deny, denied by default): user/r after 2104 ms, deadline 2000 ms"
  );
  expect(overBudgetTraceLine({ ...at, mode: "warn", reason: "deadline", ms: 2104 })).toBe(
    "evaluation deadline exceeded (warn, not applied): user/r after 2104 ms, deadline 2000 ms"
  );
  expect(overBudgetTraceLine({ ...at, mode: "deny", reason: "budget", ms: 300 })).toBe(
    "regex over budget (deny, denied by default): user/r took 300 ms on added (12 chars), budget 50 ms"
  );
  expect(overBudgetTraceLine({ ...at, mode: "deny", reason: "threw", ms: 1, error: "boom" })).toBe(
    "rule evaluation threw (deny, denied by default): user/r on added (12 chars): boom"
  );
});

test("decide(): paths are relative to the git toplevel even when the session runs in a subdirectory", () => {
  const repo = realpathSync.native(makeTmpDir("ttsr-subdir-"));
  expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
  mkdirSync(join(repo, "src", "ui"), { recursive: true });
  const eff = join(repo, "eff.json");
  writeFileSync(eff, JSON.stringify({ version: 1, rules: [{ id: "no-emoji-ui", event: "PreToolUse", tools: ["Write"], field: "added",
    paths: ["src/ui/**"], pattern: "\\p{Extended_Pictographic}", flags: "u", mode: "deny", message: "No emoji.", source: "repo",
    qualifiedId: "repo/no-emoji-ui" }] }));
  process.env.CLAUDE_PEERS_TTSR_FILE = eff;
  process.env.CLAUDE_PROJECT_DIR = join(repo, "src");
  const payload = { hook_event_name: "PreToolUse", tool_name: "Write", cwd: join(repo, "src"),
    tool_input: { file_path: join(repo, "src", "ui", "x.tsx"), content: "\u{1F600}" } };
  expect(decide(payload), "a session launched in src/ must still see src/ui/** as src/ui/**, like the Deck and the CLI").toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
  process.env.CLAUDE_PROJECT_DIR = realpathSync.native(makeTmpDir("ttsr-nogit-"));
  const outside = { ...payload, tool_input: { ...payload.tool_input, file_path: join(process.env.CLAUDE_PROJECT_DIR, "src", "ui", "x.tsx") } };
  expect(decide(outside), "outside a repository the project dir itself is the root").toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
});

test("readExisting(): a regular file is read (capped), a missing one is null", () => {
  const dir = makeTmpDir("ttsr-existing-");
  const f = join(dir, "a.ts");
  writeFileSync(f, "const a = 1\n");
  expect(readExisting(f)).toBe("const a = 1\n");
  expect(readExisting(join(dir, "missing.ts"))).toBeNull();
});

test("readExisting(): a symlinked Write target is read as absent, never followed (strict side)", () => {
  const dir = makeTmpDir("ttsr-existing-");
  const legacy = join(dir, "legacy.ts");
  writeFileSync(legacy, "try { x() } catch (e) {}\n");
  const link = join(dir, "sym.ts");
  symlinkSync(legacy, link);
  expect(
    readExisting(link),
    "a symlink must not lend its target's legacy matches to the new content: null means the whole new content is judged"
  ).toBeNull();
});

test.skipIf(process.platform === "win32")("readExisting(): a FIFO Write target returns null at once instead of blocking the hook", () => {
  const dir = makeTmpDir("ttsr-existing-");
  const fifo = join(dir, "target.ts");
  const mk = spawnSync("mkfifo", [fifo]);
  if (mk.status !== 0) throw new Error(`mkfifo failed: ${mk.stderr}`);
  const t0 = Date.now();
  expect(readExisting(fifo), "a FIFO is read as absent (strict side), never opened for a blocking read").toBeNull();
  expect(Date.now() - t0, "readExisting on a FIFO must not wait for a writer").toBeLessThan(1000);
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

test("real .mjs, a deny regex that runs for tens of seconds is denied at the hook wall, in time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ttsr-wall-"));
  tmpDirs.push(dir);
  const eff = join(dir, "eff.json");
  const logPath = join(dir, "hook.log");
  const rule = { id: "quadratic", event: "PreToolUse", tools: ["Write"], field: "added", pattern: "[a-z]+\\d+x",
    mode: "deny", message: "No quadratic text.", source: "user", qualifiedId: "user/quadratic" };
  writeFileSync(eff, JSON.stringify({ version: 1, rules: [rule] }));
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    cwd: dir,
    tool_input: { file_path: join(dir, "a.ts"), content: "a".repeat(262144) },
  });
  const t0 = performance.now();
  const result = await runHookMjs(payload, { CLAUDE_PEERS_TTSR_FILE: eff, CLAUDE_PEERS_TTSR_LOG: logPath });
  const elapsed = performance.now() - t0;
  expect(result.exitCode).toBe(0);
  expect(elapsed, "the call must be decided before Claude Code's 10 s hook timeout lets it through").toBeLessThan(7000);
  const decision = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } };
  expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("hook wall of 6000 ms exceeded; denied by default");
  expect(readFileSync(logPath, "utf-8")).toContain("hook wall of 6000 ms exceeded, undecided rules");
}, 15000);

test("real .mjs, a warn decided before the wall still reaches the session when a later warn hangs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ttsr-wall-warn-"));
  tmpDirs.push(dir);
  const eff = join(dir, "eff.json");
  const base = { event: "PreToolUse", tools: ["Write"], field: "added", mode: "warn", source: "user" };
  const rules = [
    { ...base, id: "fast", pattern: "aaaa", message: "Fast warn text.", qualifiedId: "user/fast" },
    { ...base, id: "slow", pattern: "[a-z]+\\d+x", message: "Slow warn text.", qualifiedId: "user/slow" },
  ];
  writeFileSync(eff, JSON.stringify({ version: 1, rules }));
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    cwd: dir,
    tool_input: { file_path: join(dir, "a.ts"), content: "a".repeat(262144) },
  });
  const result = await runHookMjs(payload, { CLAUDE_PEERS_TTSR_FILE: eff, CLAUDE_PEERS_TTSR_LOG: join(dir, "hook.log") });
  const decision = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext?: string; permissionDecision?: string } };
  expect(decision.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(decision.hookSpecificOutput.additionalContext).toContain("Fast warn text.");
  expect(decision.hookSpecificOutput.additionalContext).not.toContain("Slow warn text.");
}, 15000);

/** runHookBounded() over three applicable rules read on the main thread, with a stand-in worker. */
async function boundedWith(
  worker: string | (() => never),
  wallMs: number
): Promise<{ reason: string; decision: string | undefined; log: string }> {
  const dir = makeTmpDir("ttsr-bounded-");
  const eff = join(dir, "eff.json");
  const base = { event: "PreToolUse", tools: ["Write"], field: "added", pattern: "never-matches-zz", source: "user" };
  writeFileSync(eff, JSON.stringify({ version: 1, rules: [
    { ...base, id: "decided-pass", mode: "deny", message: "Decided, did not match.", qualifiedId: "user/decided-pass" },
    { ...base, id: "undecided", mode: "deny", message: "Not decided.", qualifiedId: "user/undecided" },
    { ...base, id: "warn", mode: "warn", message: "Undecided warn.", qualifiedId: "user/warn" },
  ] }));
  process.env.CLAUDE_PEERS_TTSR_FILE = eff;
  process.env.CLAUDE_PEERS_TTSR_LOG = join(dir, "hook.log");
  const raw = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", cwd: dir, tool_input: { file_path: join(dir, "a.ts"), content: "x" } });
  const start =
    typeof worker === "string"
      ? (input: WorkerInput) => new Worker(pathToFileURL(fixturePath(worker)), { workerData: input })
      : worker;
  const out = await runHookBounded(raw, wallMs, start);
  const parsed = JSON.parse(out) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } };
  return {
    reason: parsed.hookSpecificOutput.permissionDecisionReason ?? "",
    decision: parsed.hookSpecificOutput.permissionDecision,
    log: readFileSync(join(dir, "hook.log"), "utf-8"),
  };
}

test("runHookBounded(): a worker that crashes mid-evaluation denies the deny rules it had not decided", async () => {
  const { reason, decision, log } = await boundedWith("crashing-worker.mjs", 5000);
  expect(decision).toBe("deny");
  expect(reason).toContain("user/undecided");
  expect(reason).toContain("evaluation worker crashed");
  expect(reason, "a deny decided as not matching stays not matching").not.toContain("user/decided-pass");
  expect(reason).not.toContain("user/warn");
  expect(log).toContain("the evaluation worker crashed");
});

test("runHookBounded(): the wall before the worker's first message denies every applicable deny", async () => {
  const { reason, decision, log } = await boundedWith("silent-worker.mjs", 300);
  expect(decision).toBe("deny");
  expect(reason).toContain("user/decided-pass");
  expect(reason).toContain("user/undecided");
  expect(reason).toContain("hook wall of 6000 ms exceeded; denied by default");
  expect(log).toContain("hook wall of 6000 ms exceeded, undecided rules");
});

test("runHookBounded(): a crash before the worker's first message denies every applicable deny", async () => {
  const { reason, decision } = await boundedWith("throwing-worker.mjs", 5000);
  expect(decision).toBe("deny");
  expect(reason).toContain("user/undecided");
  expect(reason).toContain("evaluation worker crashed");
});

test("runHookBounded(): a worker whose module cannot be found denies every applicable deny", async () => {
  const { reason, decision } = await boundedWith("no-such-worker-file.mjs", 5000);
  expect(decision).toBe("deny");
  expect(reason).toContain("user/undecided");
  expect(reason).toContain("the evaluation worker crashed");
});

test("runHookBounded(): a Worker constructor that throws synchronously denies every applicable deny", async () => {
  const { reason, decision, log } = await boundedWith(() => {
    throw new Error("EMFILE: too many open files");
  }, 5000);
  expect(decision).toBe("deny");
  expect(reason).toContain("user/undecided");
  expect(reason).toContain("the evaluation worker could not start (EMFILE: too many open files)");
  expect(log).toContain("the evaluation worker could not start");
});

test("runHookBounded(): an exception reported by the worker denies the undecided denies", async () => {
  const { reason, decision, log } = await boundedWith("failing-worker.mjs", 5000);
  expect(decision).toBe("deny");
  expect(reason).toContain("internal error (simulated evaluation exception); denied by default");
  expect(log).toContain("internal error (simulated evaluation exception), undecided rules");
});

test("composeWallDecision(): decided matches stand, an undecided deny denies, an undecided warn is dropped", () => {
  const rule = (id: string, mode: "deny" | "warn") => ({ qualifiedId: id, mode, message: `${id} message` });
  const applicable = [rule("kory/a", "deny"), rule("user/b", "deny"), rule("repo/w", "warn")];
  const none = composeWallDecision("PreToolUse", applicable, new Map([["kory/a", null]]));
  expect(none.undecided).toEqual(["user/b", "repo/w"]);
  const out = none.output as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } };
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain("user/b message (TTSR: hook wall of 6000 ms exceeded; denied by default)");
  expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain("repo/w");

  const matched = composeWallDecision("PreToolUse", applicable, new Map([["kory/a", applicable[0]!]]));
  const reason = (matched.output as { hookSpecificOutput: { permissionDecisionReason?: string } }).hookSpecificOutput.permissionDecisionReason;
  expect(reason, "a deny decided before the wall keeps its own message").toContain("kory/a message");

  const warnsOnly = composeWallDecision("PreToolUse", [rule("repo/w", "warn")], new Map());
  expect(warnsOnly.output, "an undecided warn alone gives no decision").toBeNull();
});

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

test("real .mjs: a slow user rule cannot cancel a Kory deny, which comes back fast", async () => {
  const dir = makeTmpDir("ttsr-slow-");
  const eff = join(dir, "eff.json");
  // Cubic backtracking: minutes on the payload below; placed first in the file.
  const slow = { id: "slow", event: "PreToolUse", tools: ["Write"], field: "added", pattern: "\\w+\\w+\\w+x", mode: "warn",
    message: "m", source: "user", qualifiedId: "user/slow" };
  writeFileSync(eff, JSON.stringify({ version: 1, rules: [slow, { ...slow, id: "slow-deny", mode: "deny", qualifiedId: "user/slow-deny" }, ...KORY_EFFECTIVE_RULES] }));
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", cwd: dir,
    tool_input: { file_path: join(dir, "a.ts"), content: `const k = "${"sk-" + "ant-"}api03-abcdefghijk";\n${"a".repeat(20000)}` } });
  const t0 = performance.now();
  const result = await runHookMjs(payload, { CLAUDE_PEERS_TTSR_FILE: eff, CLAUDE_PROJECT_DIR: dir });
  const ms = performance.now() - t0;
  expect(result.exitCode).toBe(0);
  const decision = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } };
  expect(decision.hookSpecificOutput.permissionDecision, "the Kory deny must survive a slow user rule").toBe("deny");
  expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("kory/secret-literal");
  expect(ms, "Kory denies run first and the first deny ends the hook: no slow rule is reached").toBeLessThan(3000);
}, 20000);

test("real .mjs: empty stdin exits 0 with empty stdout", async () => {
  const result = await runHookMjs("", { CLAUDE_PEERS_TTSR_FILE: fixturePath("effective-basic.json") });
  expect(result.stdout).toBe("");
  expect(result.exitCode).toBe(0);
});
