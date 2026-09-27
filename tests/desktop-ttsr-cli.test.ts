// kory-rules is spawned end-to-end throughout (never imported): the CLI's
// contract is its stdout/exit code from a real process in a real git repo,
// exactly how the repo-rules skill invokes it.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DESKTOP_DIR = resolve(import.meta.dir, "..", "desktop");
const CLI_TS = join(DESKTOP_DIR, "cli", "kory-rules.ts");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {}
): Promise<RunResult> {
  const mergedEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete mergedEnv[k];
    else mergedEnv[k] = v;
  }
  const proc = Bun.spawn(["bun", CLI_TS, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: mergedEnv });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

const RULES_RELPATH = ".claude/claude-peers/rules.json";

const VALID_RULE = {
  version: 1,
  rules: [
    {
      id: "no-emoji-ui",
      event: "PreToolUse",
      tools: ["Edit", "Write"],
      field: "added",
      paths: ["src/**"],
      pattern: "EMOJI_MARK",
      mode: "deny",
      message: "No emoji in the UI: use a Greek SVG glyph instead.",
    },
  ],
};

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kory-rules-cli-"));
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "a@a.com");
  await git(dir, "config", "user.name", "a");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.txt"), "no marker here, all clean\n");
  writeFileSync(join(dir, "src", "b.txt"), "line one\nEMOJI_MARK right here\nline three\n");
  return dir;
}

function writeRules(dir: string, rules: unknown): void {
  mkdirSync(join(dir, ".claude", "claude-peers"), { recursive: true });
  writeFileSync(join(dir, RULES_RELPATH), JSON.stringify(rules, null, 2));
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function repoWith(rules: unknown): Promise<string> {
  const dir = await makeRepo();
  tmpDirs.push(dir);
  writeRules(dir, rules);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

// --- --help / usage ---

test("--help prints usage and exits 0", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["--help"], dir);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("kory-rules");
  expect(result.stdout).toContain("check");
});

test("no command at all is a usage error: exit 2", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli([], dir);
  expect(result.exitCode).toBe(2);
});

test("an unknown command is a usage error: exit 2", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["frobnicate"], dir);
  expect(result.exitCode).toBe(2);
});

// --- check ---

test("check: a valid rules file exits 0 with a short summary", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["check"], dir);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("valid:");
  expect(result.stdout).toContain("1 rule(s)");
});

test("check: an invalid rules file (unknown field) lists every error and exits 1", async () => {
  const dir = await repoWith({
    version: 1,
    rules: [{ id: "bad", event: "PreToolUse", tools: ["Edit"], field: "added", patern: "x", mode: "deny", message: "m" }],
  });
  const result = await runCli(["check"], dir);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("unknown field");
  expect(result.stdout).toContain("pattern"); // also flagged missing/empty, not just the typo
});

test("check: a missing file exits 1 (not a crash)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kory-rules-cli-nofile-"));
  tmpDirs.push(dir);
  const result = await runCli(["check", join(dir, "nope.json")], dir);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("cannot read");
});

// --- test ---

test("test: a matching case with --expect match exits 0 and prints match", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(
    ["test", "no-emoji-ui", "--text", "here is an EMOJI_MARK", "--path", "src/a.txt", "--expect", "match"],
    dir
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("match (deny)");
});

test("test: a non-matching case with --expect none exits 0 and prints none", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(
    ["test", "no-emoji-ui", "--text", "nothing here", "--path", "src/a.txt", "--expect", "none"],
    dir
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("none");
});

test("test: a result that contradicts --expect exits 1", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(
    ["test", "no-emoji-ui", "--text", "here is an EMOJI_MARK", "--path", "src/a.txt", "--expect", "none"],
    dir
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout.trim()).toBe("match (deny)");
});

test("test: an unknown rule id is a usage error, exit 2", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["test", "does-not-exist", "--text", "x"], dir);
  expect(result.exitCode).toBe(2);
});

test("test: --path outside the rule's paths filter does not match", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(
    ["test", "no-emoji-ui", "--text", "EMOJI_MARK", "--path", "docs/readme.md", "--expect", "none"],
    dir
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("none");
});

test("test: --file reads the tested text from a file", async () => {
  const dir = await repoWith(VALID_RULE);
  const fixture = join(dir, "snippet.txt");
  writeFileSync(fixture, "contains EMOJI_MARK inline");
  const result = await runCli(
    ["test", "no-emoji-ui", "--file", fixture, "--path", "src/a.txt", "--expect", "match"],
    dir
  );
  expect(result.exitCode).toBe(0);
});

// --- scan ---

test("scan: counts matching files/lines restricted to the rule's paths, and warns on a deny/Write hit", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["scan", "no-emoji-ui"], dir);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1 file(s) match");
  expect(result.stdout).toContain("src/b.txt");
  expect(result.stdout).toContain("WARNING");
});

test("scan: an unknown rule id is a usage error, exit 2", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["scan", "does-not-exist"], dir);
  expect(result.exitCode).toBe(2);
});

// --- list ---

test("list: without $CLAUDE_PEERS_TTSR_FILE, says so and reports repo rules as status unknown", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["list"], dir, { CLAUDE_PEERS_TTSR_FILE: undefined });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("is not set");
  expect(result.stdout).toContain("no-emoji-ui");
  expect(result.stdout).toContain("unknown");
});

test("list: with a matching effective file, the repo rule reads active, plus kory rules active", async () => {
  const dir = await repoWith(VALID_RULE);
  const effectivePath = join(dir, "effective.json");
  writeFileSync(
    effectivePath,
    JSON.stringify({
      version: 1,
      rules: [
        { ...VALID_RULE.rules[0], source: "repo", qualifiedId: "repo/no-emoji-ui" },
        {
          id: "empty-catch",
          event: "PreToolUse",
          tools: ["Edit", "MultiEdit", "Write"],
          field: "added",
          pattern: "catch",
          mode: "deny",
          message: "no empty catch",
          source: "kory",
          qualifiedId: "kory/empty-catch",
        },
      ],
    })
  );
  const result = await runCli(["list"], dir, { CLAUDE_PEERS_TTSR_FILE: effectivePath });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("no-emoji-ui  [PreToolUse Edit,Write]  active");
  expect(result.stdout).toContain("kory/empty-catch");
});

test("list: an edited-since-approval repo rule reads inactive, not active", async () => {
  const dir = await repoWith(VALID_RULE);
  const effectivePath = join(dir, "effective.json");
  const staleRule = { ...VALID_RULE.rules[0], message: "a different, older message" };
  writeFileSync(
    effectivePath,
    JSON.stringify({ version: 1, rules: [{ ...staleRule, source: "repo", qualifiedId: "repo/no-emoji-ui" }] })
  );
  const result = await runCli(["list"], dir, { CLAUDE_PEERS_TTSR_FILE: effectivePath });
  expect(result.exitCode).toBe(0);
  expect(result.stdout, "the CLI cannot tell pending from disabled: it must not claim either").toContain(
    "inactive (pending approval or disabled by the operator)"
  );
});

test("list: an effective file named but missing exits 0 with a note", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["list"], dir, { CLAUDE_PEERS_TTSR_FILE: join(dir, "gone.json") });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("does not exist");
  expect(result.stdout).toContain("no-emoji-ui");
});

// --- read containment, argument errors, paths without --path ---

test("check and test --file refuse a file outside the repository (exit 2), even through a symlink", async () => {
  const dir = await repoWith(VALID_RULE);
  const outside = mkdtempSync(join(tmpdir(), "kory-rules-outside-"));
  tmpDirs.push(outside);
  writeFileSync(join(outside, "secret.txt"), "EMOJI_MARK");
  symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
  for (const args of [
    ["check", join(outside, "secret.txt")],
    ["check", "link.txt"],
    ["test", "no-emoji-ui", "--file", join(outside, "secret.txt"), "--path", "src/a.txt"],
    ["test", "no-emoji-ui", "--file", "link.txt", "--path", "src/a.txt"],
  ]) {
    const result = await runCli(args, dir);
    expect(result.exitCode, `kory-rules ${args.join(" ")} must not read outside the repository`).toBe(2);
    expect(result.stderr).toContain("is outside the project");
  }
});

test("test: --text without a value is a usage error naming --text", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["test", "no-emoji-ui", "--text"], dir);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("--text requires a value");
});

test("test: a rule with paths and no --path is a usage error, not a silent none", async () => {
  const dir = await repoWith(VALID_RULE);
  const result = await runCli(["test", "no-emoji-ui", "--text", "EMOJI_MARK", "--expect", "none"], dir);
  expect(result.exitCode, "without a target the paths filter would drop the rule and every test would read none").toBe(2);
  expect(result.stderr).toContain("--path <repo-relative file>");
  const bash = await repoWith({
    version: 1,
    rules: [{ ...VALID_RULE.rules[0], id: "no-npm", tools: ["Bash"], field: "command", pattern: "^npm\\b" }],
  });
  const b = await runCli(["test", "no-npm", "--text", "npm i"], bash);
  expect(b.exitCode).toBe(2);
  expect(b.stderr).toContain("directory the command runs in");
  expect((await runCli(["test", "no-npm", "--text", "npm i", "--path", "src", "--expect", "match"], bash)).exitCode).toBe(0);
});

test("check: a pattern that backtracks is rejected as too slow (exit 1)", async () => {
  const dir = await repoWith({ version: 1, rules: [{ ...VALID_RULE.rules[0], pattern: "\\w+\\w+\\w+x" }] });
  const result = await runCli(["check"], dir);
  expect(result.exitCode, "check must run the timing probe, not only the parser").toBe(1);
  expect(result.stdout).toContain('rules[0] "no-emoji-ui": pattern: too slow');
}, 20000);

test("scan: tests each whole file like the hook (a match across lines, a file past the cap), lines for display only", async () => {
  const dir = await repoWith({ version: 1, rules: [{ ...VALID_RULE.rules[0], pattern: "BEGIN\\nEND" }] });
  writeFileSync(join(dir, "src", "multi.txt"), "x\nBEGIN\nEND\n");
  writeFileSync(join(dir, "src", "big.txt"), "a".repeat(300 * 1024) + "\nBEGIN\nEND\n");
  writeFileSync(join(dir, "src", "bigearly.txt"), "BEGIN\nEND\n" + "a".repeat(300 * 1024));
  await git(dir, "add", "src");
  await git(dir, "commit", "-q", "-m", "more");
  const result = await runCli(["scan", "no-emoji-ui"], dir);
  expect(result.exitCode).toBe(0);
  expect(result.stdout, "a match spanning two lines is found").toContain("src/multi.txt  (1)");
  expect(result.stdout, "a large file is scanned up to the cap, not skipped").toContain("src/bigearly.txt  (1)");
  expect(result.stdout, "past the cap the hook does not look either").not.toContain("src/big.txt");
});
