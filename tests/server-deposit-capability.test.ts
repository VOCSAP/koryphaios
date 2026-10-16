import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scrubEnv, startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { CONTEXT_RESUME_VERSION, DEPOSIT_CAPABILITY_ENV, depositCapabilityHashFromEnv, hashCapability } from "../shared/context-buffer.ts";

const SERVER_PATH = resolve(import.meta.dir, "..", "server.ts");

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];
const proxies: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const p of proxies) p.stop(true);
  for (const b of brokers) await stopBroker(b);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("the /register field is the sha256 of a well-formed capability, and absent otherwise", () => {
  const cap = randomBytes(32).toString("hex");
  expect(depositCapabilityHashFromEnv({ [DEPOSIT_CAPABILITY_ENV]: cap })).toBe(hashCapability(cap));
  expect(depositCapabilityHashFromEnv({ [DEPOSIT_CAPABILITY_ENV]: "" })).toBeUndefined();
  expect(depositCapabilityHashFromEnv({})).toBeUndefined();
  expect(depositCapabilityHashFromEnv({ [DEPOSIT_CAPABILITY_ENV]: cap.toUpperCase() })).toBeUndefined();
  expect(depositCapabilityHashFromEnv({ [DEPOSIT_CAPABILITY_ENV]: `${cap}0` })).toBeUndefined();
  const body = JSON.parse(JSON.stringify({ a: 1, deposit_capability_hash: depositCapabilityHashFromEnv({}) }));
  expect(Object.keys(body)).toEqual(["a"]);
});

interface Session {
  proc: ReturnType<typeof Bun.spawn>;
  stderr: { text: string };
  send: (msg: unknown) => void;
  read: (id: number) => Promise<{ result?: { content?: Array<{ text?: string }>; isError?: boolean } }>;
}

async function launchServer(brokerUrl: string, settingsDir: string, capability: string, logDir: string): Promise<Session> {
  const proc = Bun.spawn(["bun", SERVER_PATH], {
    cwd: settingsDir,
    env: scrubEnv(settingsDir, {
      CLAUDE_PEERS_BROKER_URL: brokerUrl,
      CLAUDE_PEERS_DESK_SESSION: randomUUID(),
      CLAUDE_PEERS_LOG_DIR: logDir,
      [DEPOSIT_CAPABILITY_ENV]: capability,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  const stderr = { text: "" };
  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      stderr.text += decoder.decode(value, { stream: true });
    }
  })();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const buffer = { text: "" };
  const send = (msg: unknown): void => {
    (proc.stdin as import("bun").FileSink).write(JSON.stringify(msg) + "\n");
  };
  const read = async (wantedId: number) => {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      let idx: number;
      while ((idx = buffer.text.indexOf("\n")) >= 0) {
        const line = buffer.text.slice(0, idx).trim();
        buffer.text = buffer.text.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (msg.id === wantedId) return msg as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
        } catch {
          /* not a complete JSON line yet */
        }
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer.text += decoder.decode(value, { stream: true });
    }
    throw new Error(`no JSON-RPC response with id ${wantedId}`);
  };
  return { proc, stderr, send, read };
}

async function deposit(b: TestBroker, capability: string, text: string, replace?: string) {
  const res = await fetch(`${b.url}/context/deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deposit_capability: capability, text, head: null, branch: null, git_root: null, replace }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test(
  "both /register sites of server.ts carry the capability hash, never the raw value, and switch_group rebinds",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const registerBodies: Array<Record<string, unknown>> = [];
    const wire: string[] = [];
    const proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (body !== undefined) {
          wire.push(body);
          if (url.pathname === "/register") registerBodies.push(JSON.parse(body) as Record<string, unknown>);
        }
        return fetch(`${b.url}${url.pathname}${url.search}`, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body,
        });
      },
    });
    proxies.push(proxy);

    const settingsDir = mkdtempSync(join(tmpdir(), "cp-deposit-cap-"));
    dirs.push(settingsDir);
    mkdirSync(join(settingsDir, "claude-peers"), { recursive: true });
    writeFileSync(
      join(settingsDir, "claude-peers", "config.json"),
      JSON.stringify({ groups: { alpha: randomUUID(), beta: randomUUID() }, default_group: "alpha" })
    );
    const logDir = join(settingsDir, "logs");
    const cap = randomBytes(32).toString("hex");
    const session = await launchServer(`http://127.0.0.1:${proxy.port}`, settingsDir, cap, logDir);
    session.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { roots: {}, elicitation: {} },
        clientInfo: { name: "test-harness", version: "0.0.1" },
      },
    });
    await session.read(0);

    const deadline = Date.now() + 10_000;
    let booted = await deposit(b, cap, "after boot");
    while (booted.status !== 200 && Date.now() < deadline) {
      await Bun.sleep(100);
      booted = await deposit(b, cap, "after boot");
    }
    expect(booted.status).toBe(200);

    session.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "switch_group", arguments: { name: "beta" } } });
    const switched = await session.read(1);
    expect(switched.result?.isError ?? false).toBe(false);

    const afterSwitch = await deposit(b, cap, "after switch");
    expect(afterSwitch.status).toBe(200);
    expect((afterSwitch.body.held as unknown[]).length).toBe(1);
    expect((await deposit(b, cap, "t", booted.body.deposit_id as string)).status).toBe(404);

    expect(registerBodies).toHaveLength(2);
    for (const body of registerBodies) expect(body.deposit_capability_hash).toBe(hashCapability(cap));
    for (const body of registerBodies) expect(body.context_resume_version).toBe(CONTEXT_RESUME_VERSION);
    const [boot, sw] = registerBodies.map((body) => new Set(Object.keys(body)));
    const onlyOne = [...boot!].filter((k) => !sw!.has(k)).concat([...sw!].filter((k) => !boot!.has(k)));
    expect(onlyOne.sort()).toEqual(["claude_cli_pid"]);
    expect(wire.length).toBeGreaterThanOrEqual(2);
    expect(wire.filter((w) => w.includes(cap))).toEqual([]);

    session.proc.kill();
    await session.proc.exited;
    const logs =
      session.stderr.text +
      (existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("\n") : "");
    expect([cap, hashCapability(cap)].filter((s) => logs.includes(s))).toEqual([]);
  },
  40_000
);
