import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scrubEnv } from "./_scrub-env.ts";
import {
  CONTEXT_DEPOSIT_MAX_CHARS,
  CONTEXT_DEPOSIT_MAX_INPUT_BYTES,
  DEPOSIT_CAPABILITY_ENV,
  hashCapability,
} from "../shared/context-buffer.ts";

const CLI_PATH = resolve(import.meta.dir, "..", "cli.ts");
const REPO_ROOT = resolve(import.meta.dir, "..");

interface Recorded {
  path: string;
  body: Record<string, unknown>;
}

const requests: Recorded[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };
let fake: ReturnType<typeof Bun.serve>;
const dirs: string[] = [];
const CAP = randomBytes(32).toString("hex");

function okAnswer(extra: Record<string, unknown> = {}): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      ok: true,
      deposit_id: "0123456789abcdef",
      owner_peer_id: "tile-peer",
      chars: 12,
      limit_chars: CONTEXT_DEPOSIT_MAX_CHARS,
      deposited_at: "2026-10-12T12:00:00.000Z",
      head_at_deposit: null,
      branch: null,
      state: "held",
      held: [],
      ...extra,
    },
  };
}

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === "POST" ? await req.text() : "";
      requests.push({ path: url.pathname, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      return Response.json(answer.body, { status: answer.status });
    },
  });
});

afterAll(() => {
  fake.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  answer = okAnswer();
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-cli-deposit-"));
  dirs.push(d);
  return d;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  opts: { cwd?: string; capability?: string | null; stdin?: string; brokerUrl?: string } = {}
): Promise<Run> {
  const home = scratch();
  const extra: Record<string, string> = { CLAUDE_PEERS_BROKER_URL: opts.brokerUrl ?? `http://127.0.0.1:${fake.port}` };
  if (opts.capability !== null) extra[DEPOSIT_CAPABILITY_ENV] = opts.capability ?? CAP;
  const proc = Bun.spawn(["bun", CLI_PATH, "context-deposit", ...args], {
    cwd: opts.cwd ?? scratch(),
    env: scrubEnv(home, extra),
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined) {
    const sink = proc.stdin as import("bun").FileSink;
    sink.write(opts.stdin);
    await sink.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function inputFile(content: string | Uint8Array, dir = scratch()): string {
  const path = join(dir, "context.md");
  writeFileSync(path, content);
  return path;
}

function expectNoSecretPrinted(run: Run, text?: string): void {
  const out = run.stdout + run.stderr;
  const leaks = [CAP, hashCapability(CAP), ...(text ? [text] : [])].filter((s) => out.includes(s));
  expect(leaks).toEqual([]);
}

describe("bun cli.ts context-deposit", () => {
  test("without a capability in the env it exits 5 and never calls the broker", async () => {
    const path = inputFile("next: rerun");
    const absent = await runCli(["--input", path], { capability: null });
    const malformed = await runCli(["--input", path], { capability: "not-a-capability" });
    for (const r of [absent, malformed]) {
      expect(r.code).toBe(5);
      expect(r.stderr.split("\n")[0]).toBe("context-deposit: refused (capability)");
    }
    expect(requests).toEqual([]);
  });

  test("a stored deposit exits 0 with stable key: value lines and prints no secret nor the text", async () => {
    const text = `witness-${randomUUID()}`;
    answer = okAnswer({ chars: text.length });
    const r = await runCli(["--input", inputFile(text)]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("context-deposit: stored");
    expect(lines).toContain("deposit_id: 0123456789abcdef");
    expect(lines).toContain("peer_id: tile-peer");
    expect(lines).toContain(`chars: ${text.length} (limit ${CONTEXT_DEPOSIT_MAX_CHARS})`);
    expect(lines).toContain("deposited_at: 2026-10-12T12:00:00.000Z");
    expect(lines).toContain("head_at_deposit: none  branch: none");
    expect(lines.some((l) => l.startsWith("kept: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("next: "))).toBe(true);
    expectNoSecretPrinted(r, text);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe("/context/deposit");
    expect(requests[0]!.body).toEqual({
      deposit_capability: CAP,
      text,
      head: null,
      branch: null,
      git_root: null,
    });
  });

  test("hostile repo files in the cwd change nothing in the request", async () => {
    const clean = scratch();
    const hostile = scratch();
    for (const name of [".claude-peers.json", ".claude-peers.local.json"]) {
      writeFileSync(join(hostile, name), JSON.stringify({ group: "hostile-group", broker_url: "http://127.0.0.1:1" }));
    }
    await runCli(["--input", inputFile("same text", clean)], { cwd: clean });
    await runCli(["--input", inputFile("same text", hostile)], { cwd: hostile });
    expect(requests).toHaveLength(2);
    expect(Object.keys(requests[1]!.body).sort()).toEqual(Object.keys(requests[0]!.body).sort());
    expect(requests[1]!.body).toEqual(requests[0]!.body);
    expect(JSON.stringify(requests[1]!.body)).not.toContain("hostile-group");
  });

  test("--replace is forwarded, and --input - reads stdin", async () => {
    const r = await runCli(["--input", "-", "--replace", "fedcba9876543210"], { stdin: "from stdin\r\nline two" });
    expect(r.code).toBe(0);
    expect(requests[0]!.body).toMatchObject({ text: "from stdin\r\nline two", replace: "fedcba9876543210" });
  });

  test("usage errors exit 2 without calling the broker", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "a-directory"));
    const cases: string[][] = [
      [],
      ["--input"],
      ["--input", inputFile("x"), "--by", "someone"],
      ["--input", inputFile("x"), "--group", "g"],
      ["--input", join(dir, "missing.md")],
      ["--input", join(dir, "a-directory")],
      ["--input", inputFile("")],
      ["--input", inputFile(new Uint8Array([0x66, 0xff, 0xfe, 0x66]))],
      ["--input", inputFile("x".repeat(CONTEXT_DEPOSIT_MAX_INPUT_BYTES + 1))],
      ["--input", inputFile("x"), "--replace"],
    ];
    for (const args of cases) {
      const r = await runCli(args);
      expect({ args: args.map((a) => a.replace(/^.*[\\/]/, "")), code: r.code }).toEqual({
        args: args.map((a) => a.replace(/^.*[\\/]/, "")),
        code: 2,
      });
    }
    const oversizedStdin = await runCli(["--input", "-"], { stdin: "y".repeat(CONTEXT_DEPOSIT_MAX_INPUT_BYTES + 1) });
    expect(oversizedStdin.code).toBe(2);
    expect(requests).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a FIFO given as --input is refused with code 2, without hanging", async () => {
    const fifo = join(scratch(), "context.fifo");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    expect(made.exitCode).toBe(0);
    const r = await Promise.race([
      runCli(["--input", fifo]),
      Bun.sleep(10_000).then(() => "hung" as const),
    ]);
    expect(r === "hung" ? "hung" : r.code).toBe(2);
    expect(requests).toEqual([]);
  }, 15_000);

  test("broker refusals map to the documented exit codes and remedies", async () => {
    const cases: Array<{ status: number; body: Record<string, unknown>; code: number; mention: string }> = [
      { status: 413, body: { reason: "too_long", max_chars: CONTEXT_DEPOSIT_MAX_CHARS, got_chars: CONTEXT_DEPOSIT_MAX_CHARS + 9 }, code: 3, mention: String(CONTEXT_DEPOSIT_MAX_CHARS + 9) },
      { status: 400, body: { reason: "empty_text" }, code: 3, mention: "empty_text" },
      { status: 400, body: { reason: "forbidden_characters" }, code: 3, mention: "forbidden_characters" },
      { status: 429, body: { reason: "quota_owner", held_ids: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"] }, code: 4, mention: "bbbbbbbbbbbbbbbb" },
      { status: 429, body: { reason: "quota_total" }, code: 4, mention: "quota_total" },
      { status: 404, body: { reason: "replace_not_found" }, code: 4, mention: "replace_not_found" },
      { status: 401, body: { reason: "capability" }, code: 5, mention: "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" },
      { status: 409, body: { reason: "contested" }, code: 5, mention: "contested" },
      { status: 500, body: { error: "internal error" }, code: 1, mention: "500" },
    ];
    for (const c of cases) {
      answer = { status: c.status, body: { error: "refused", ...c.body } };
      const r = await runCli(["--input", inputFile("some context")]);
      expect({ reason: c.body.reason ?? c.status, code: r.code }).toEqual({ reason: c.body.reason ?? c.status, code: c.code });
      expect(r.stderr).toContain(c.mention);
      if (c.body.reason) expect(r.stderr.split("\n")[0]).toBe(`context-deposit: refused (${c.body.reason})`);
      expectNoSecretPrinted(r, "some context");
    }
  });

  test("an unreachable broker exits 1", async () => {
    const r = await runCli(["--input", inputFile("x")], { brokerUrl: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expectNoSecretPrinted(r);
  });

  test("inside a git repository the request carries a well-formed HEAD and root", async () => {
    const r = await runCli(["--input", inputFile("in a repo")], { cwd: REPO_ROOT });
    expect(r.code).toBe(0);
    expect(requests[0]!.body.head).toMatch(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
    expect(typeof requests[0]!.body.git_root).toBe("string");
  });
});
