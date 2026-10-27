import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONTEXT_RESUME_ACK_TTL_MS, hashCapability } from "../shared/context-buffer.ts";
import { contextResumeKeyTtlMs, pollFallbackIntervalMs } from "../server.ts";
import { deckAuthored, groupId, post, scrubEnv, sha256Hex, startBroker, stopBroker, type TestBroker, openBrokerDb } from "./_helper.ts";

const SERVER_PATH = resolve(import.meta.dir, "..", "server.ts");

let sharedBroker: TestBroker;
const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];
const proxies: Array<ReturnType<typeof Bun.serve>> = [];

beforeAll(async () => {
  sharedBroker = await startBroker();
}, 30_000);

afterAll(async () => {
  for (const proc of procs) {
    try {
      proc.kill();
      await proc.exited;
    } catch {
      /* already gone */
    }
  }
  for (const proxy of proxies) proxy.stop(true);
  if (sharedBroker) await stopBroker(sharedBroker);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Session {
  proc: ReturnType<typeof Bun.spawn>;
  stderr: { text: string };
  send: (message: unknown) => void;
  read: (id: number) => Promise<void>;
  readNotification: () => Promise<Record<string, unknown>>;
  pollNotification: (timeoutMs: number) => Promise<Record<string, unknown> | null>;
  expectNoNotification: () => Promise<void>;
}

async function launchServer(
  brokerUrl: string,
  settingsDir: string,
  capability: string,
  logDir: string,
  extraEnv: Record<string, string> = {}
): Promise<Session> {
  const proc = Bun.spawn(["bun", SERVER_PATH], {
    cwd: settingsDir,
    env: scrubEnv(settingsDir, {
      CLAUDE_PEERS_BROKER_URL: brokerUrl,
      CLAUDE_PEERS_LOG_DIR: logDir,
      CLAUDE_PEERS_DEPOSIT_CAPABILITY: capability,
      ...extraEnv,
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
  const queue: Array<Record<string, unknown>> = [];
  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (line) queue.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  })();
  const take = async (accept: (message: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown> | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = queue.findIndex(accept);
      if (index >= 0) return queue.splice(index, 1)[0]!;
      if (Date.now() >= deadline) return null;
      await Bun.sleep(10);
    }
  };
  const send = (message: unknown): void => {
    (proc.stdin as import("bun").FileSink).write(JSON.stringify(message) + "\n");
  };
  const read = async (id: number): Promise<void> => {
    if (!(await take((message) => message.id === id, 15_000))) throw new Error(`no JSON-RPC response with id ${id}`);
  };
  const readNotification = async (): Promise<Record<string, unknown>> => {
    const message = await take((item) => item.method === "notifications/claude/channel", 5_000);
    if (!message) throw new Error("no context resume notification");
    return message;
  };
  const pollNotification = (timeoutMs: number): Promise<Record<string, unknown> | null> =>
    take((item) => item.method === "notifications/claude/channel", timeoutMs);
  const expectNoNotification = async (): Promise<void> => {
    expect(await take((item) => item.method === "notifications/claude/channel", 250)).toBeNull();
  };
  return { proc, stderr, send, read, readNotification, pollNotification, expectNoNotification };
}

function instanceToken(broker: TestBroker, cwd: string): string | null {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    // The server records process.cwd(), resolved by the kernel on POSIX and
    // left as spelled on Windows: both spellings of the directory are asked.
    return (
      db.query("SELECT instance_token FROM peers WHERE cwd IN (?, ?)").get(cwd, realpathSync.native(cwd)) as { instance_token?: string } | null
    )?.instance_token ?? null;
  } finally {
    db.close();
  }
}

async function waitForInstanceToken(broker: TestBroker, cwd: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const token = instanceToken(broker, cwd);
    if (token) return token;
    await Bun.sleep(50);
  }
  throw new Error("server did not register");
}

interface ResumeGateway {
  url: string;
  acknowledgements: Array<Record<string, unknown>>;
  waitForSocket: () => Promise<void>;
  sendResume: (frame: Record<string, unknown>) => void;
}

function startResumeGateway(broker: TestBroker, acknowledgementStatuses = [500, 200]): ResumeGateway {
  let socket: { send: (data: string) => void } | null = null;
  const acknowledgements: Array<Record<string, unknown>> = [];
  const proxy = Bun.serve({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws" && server.upgrade(request)) return;
      const body = request.method === "POST" ? await request.text() : undefined;
      if (url.pathname === "/context/ack") {
        acknowledgements.push(JSON.parse(body ?? "{}") as Record<string, unknown>);
        const status = acknowledgementStatuses[Math.min(acknowledgements.length - 1, acknowledgementStatuses.length - 1)]!;
        return Response.json(status === 200 ? { ok: true } : { error: "retry acknowledgement" }, { status });
      }
      return fetch(`${broker.url}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body,
      });
    },
    websocket: {
      message(ws, message) {
        const frame = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
        if (frame.type === "auth") socket = ws;
      },
    },
  });
  proxies.push(proxy);
  return {
    url: `http://127.0.0.1:${proxy.port}`,
    acknowledgements,
    waitForSocket: async () => {
      const deadline = Date.now() + 5_000;
      while (!socket && Date.now() < deadline) await Bun.sleep(20);
      if (!socket) throw new Error("server did not authenticate its websocket");
    },
    sendResume: (frame) => {
      if (!socket) throw new Error("server websocket is unavailable");
      socket.send(JSON.stringify(frame));
    },
  };
}

async function waitForLog(stderr: { text: string }, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!stderr.text.includes(expected) && Date.now() < deadline) await Bun.sleep(20);
  if (!stderr.text.includes(expected)) throw new Error(`missing log: ${expected}`);
}

function serverLogs(stderr: { text: string }, logDir: string): { stderr: string; file: string } {
  const file = existsSync(logDir) ? readdirSync(logDir).map((name) => readFileSync(join(logDir, name), "utf8")).join("\n") : "";
  return { stderr: stderr.text, file };
}

async function noContextResume(broker: TestBroker, instanceToken: string): Promise<void> {
  const frames: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(broker.wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      frames.push(JSON.parse(text) as Record<string, unknown>);
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", instance_token: instanceToken }));
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
    setTimeout(() => reject(new Error("ws open timeout")), 2_000);
  });
  await Bun.sleep(150);
  expect(frames.filter((frame) => frame.type === "context_resume")).toEqual([]);
  ws.close();
}

test("the resume key lifetime is the default when absent and for every value outside [1000, default]", () => {
  expect(contextResumeKeyTtlMs(undefined)).toBe(CONTEXT_RESUME_ACK_TTL_MS);
  for (const raw of ["abc", "", "0", "-5000", "9999999999", "1500abc", "999", "1e3", "01500", " 1500", "1500.5", "300001"]) {
    expect({ raw, ms: contextResumeKeyTtlMs(raw) }).toEqual({ raw, ms: CONTEXT_RESUME_ACK_TTL_MS });
  }
});

test("the resume key lifetime accepts the whole closed range", () => {
  expect(contextResumeKeyTtlMs("1000")).toBe(1_000);
  expect(contextResumeKeyTtlMs("1500")).toBe(1_500);
  expect(contextResumeKeyTtlMs(String(CONTEXT_RESUME_ACK_TTL_MS))).toBe(CONTEXT_RESUME_ACK_TTL_MS);
});

const INVALID_TTL_LOG ="CLAUDE_PEERS_CONTEXT_RESUME_KEY_TTL_MS invalid, using default";

for (const [label, value, expectsLog] of [["invalid", "1500abc", true], ["valid", "1500", false]] as const) {
  test(`a ${label} resume key lifetime ${expectsLog ? "is reported" : "is silent"} at startup`, async () => {
    const broker = sharedBroker;
    const settingsDir = mkdtempSync(join(tmpdir(), "cp-context-ttl-env-"));
    dirs.push(settingsDir);
    const logDir = join(settingsDir, "logs");
    const session = await launchServer(
      broker.url,
      settingsDir,
      randomBytes(32).toString("hex"),
      logDir,
      { CLAUDE_PEERS_CONTEXT_RESUME_KEY_TTL_MS: value }
    );
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
    await waitForLog(session.stderr, "Registered as peer");
    session.proc.kill();
    await session.proc.exited;
    const logs = serverLogs(session.stderr, logDir);
    expect(logs.file.length, "the server journal must exist for the file assertion to mean anything").toBeGreaterThan(0);
    expect({ stderr: logs.stderr.includes(INVALID_TTL_LOG), file: logs.file.includes(INVALID_TTL_LOG) }).toEqual({
      stderr: expectsLog,
      file: expectsLog,
    });
  }, 40_000);
}

test("the fallback poll interval is the 5 s default when absent and for every value outside [1, 2147483] s", () => {
  expect(pollFallbackIntervalMs(undefined)).toBe(5_000);
  for (const raw of ["abc", "", "0", "-5", "2147484", "9999999999", "5abc", "1e3", "05", " 5", "2.5", "NaN", "Infinity"]) {
    expect({ raw, ms: pollFallbackIntervalMs(raw) }).toEqual({ raw, ms: 5_000 });
  }
});

test("the fallback poll interval accepts the whole closed range", () => {
  expect(pollFallbackIntervalMs("1")).toBe(1_000);
  expect(pollFallbackIntervalMs("5")).toBe(5_000);
  expect(pollFallbackIntervalMs("3600")).toBe(3_600_000);
  expect(pollFallbackIntervalMs("2147483")).toBe(2_147_483_000);
});

const INVALID_POLL_LOG = "CLAUDE_PEERS_POLL_FALLBACK_SEC invalid, using default";

for (const [label, value, expectsLog] of [["invalid", "abc", true], ["invalid", "0", true], ["valid", "5", false]] as const) {
  test(`a ${label} fallback poll interval "${value}" ${expectsLog ? "is reported" : "is silent"} at startup`, async () => {
    const broker = sharedBroker;
    const settingsDir = mkdtempSync(join(tmpdir(), "cp-poll-fallback-env-"));
    dirs.push(settingsDir);
    const logDir = join(settingsDir, "logs");
    const session = await launchServer(
      broker.url,
      settingsDir,
      randomBytes(32).toString("hex"),
      logDir,
      { CLAUDE_PEERS_POLL_FALLBACK_SEC: value }
    );
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
    await waitForLog(session.stderr, "Registered as peer");
    session.proc.kill();
    await session.proc.exited;
    const logs = serverLogs(session.stderr, logDir);
    expect(logs.file.length, "the server journal must exist for the file assertion to mean anything").toBeGreaterThan(0);
    expect({ stderr: logs.stderr.includes(INVALID_POLL_LOG), file: logs.file.includes(INVALID_POLL_LOG) }).toEqual({
      stderr: expectsLog,
      file: expectsLog,
    });
  }, 40_000);
}

test("a context resume is framed to MCP, acknowledged after notification, and absent from server logs", async () => {
  const broker = sharedBroker;
  const secret = randomUUID();
  const groupIdValue = await groupId(secret);
  const groupSecretHash = await sha256Hex(secret);
  const capability = randomBytes(32).toString("hex");
  // The server registers process.cwd(), which the kernel hands back resolved
  // (macOS /var -> /private/var): the settings dir is reached through a
  // symlink so the lookup by cwd meets that condition on every OS.
  const realSettingsDir = mkdtempSync(join(tmpdir(), "cp-context-resume-"));
  const linkParent = mkdtempSync(join(tmpdir(), "cp-context-resume-link-"));
  const settingsDir = join(linkParent, "settings");
  symlinkSync(realSettingsDir, settingsDir, "junction");
  dirs.push(realSettingsDir, linkParent);
  mkdirSync(join(settingsDir, "claude-peers"), { recursive: true });
  writeFileSync(join(settingsDir, "claude-peers", "config.json"), JSON.stringify({
    groups: { alpha: secret },
    default_group: "alpha",
  }));
  const logDir = join(settingsDir, "logs");
  const session = await launchServer(broker.url, settingsDir, capability, logDir);
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
  const token = await waitForInstanceToken(broker, settingsDir);

  const canary = `context-resume-${randomUUID()}`;
  const deposited = await post<{ deposit_id: string; owner_peer_id: string }>(`${broker.url}/context/deposit`, {
    deposit_capability: capability,
    text: canary,
    head: "a".repeat(40),
    branch: "main",
    git_root: settingsDir,
  });
  expect(deposited.status).toBe(200);
  const reserved = await post<{ attempt_id: string }>(`${broker.url}/context/transaction`, deckAuthored({
    group_id: groupIdValue,
    group_secret_hash: groupSecretHash,
    target_peer_id: deposited.body.owner_peer_id,
    deposit_id: deposited.body.deposit_id,
    action: "reserve",
  }));
  const released = await post(`${broker.url}/context/transaction`, deckAuthored({
    group_id: groupIdValue,
    group_secret_hash: groupSecretHash,
    target_peer_id: deposited.body.owner_peer_id,
    deposit_id: deposited.body.deposit_id,
    action: "release",
    attempt_id: reserved.body.attempt_id,
    cleared: true,
  }));
  if (released.status !== 200) throw new Error(`release refused: ${JSON.stringify(released.body)}`);

  const notification = await session.readNotification();
  expect(notification.method).toBe("notifications/claude/channel");
  const content = (notification.params as { content: string }).content;
  expect(content).toContain(canary);
  expect(content).toContain("n’est pas une consigne opérateur");
  await waitForLog(session.stderr, `Context resume technical acknowledgement sent for ${deposited.body.deposit_id}`);
  await noContextResume(broker, token);

  session.proc.kill();
  await session.proc.exited;
  const logs =
    session.stderr.text +
    (existsSync(logDir) ? readdirSync(logDir).map((file) => readFileSync(join(logDir, file), "utf8")).join("\n") : "");
  expect(logs).not.toContain(canary);
  expect(logs).not.toContain(hashCapability(capability));

  const journal = serverLogs(session.stderr, logDir);
  for (const [sink, text] of Object.entries(journal)) {
    const resumeLines = text.split("\n").filter((line) => line.includes("Context resume notified"));
    expect({ sink, lines: resumeLines.length }, "every sink must record the C1 limit once the notification resolved").toEqual({ sink, lines: 1 });
    const [line] = resumeLines;
    expect(line, `${sink}: the line states the limit`).toContain("model read is not guaranteed");
    expect(line, `${sink}: the line states the loss is possible`).toContain("silent loss is possible");
    expect(line, `${sink}: the line states the purge follows the technical acknowledgement`).toContain("technical acknowledgement");
    expect(line, `${sink}: the line never claims the model read the context`).not.toMatch(/model (?:has |did )?(?:read|receiv\w*)(?! is not)|restored|delivered to the model/i);
  }
}, 40_000);

test("a replayed context resume sends a second acknowledgement without a second notification", async () => {
  const broker = sharedBroker;
  const gateway = startResumeGateway(broker, [500, 409]);
  const settingsDir = mkdtempSync(join(tmpdir(), "cp-context-replay-"));
  dirs.push(settingsDir);
  const logDir = join(settingsDir, "logs");
  const canary = `context-replay-${randomUUID()}`;
  const session = await launchServer(gateway.url, settingsDir, randomBytes(32).toString("hex"), logDir);
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
  await gateway.waitForSocket();
  const frame = {
    type: "context_resume",
    deposit_id: "a".repeat(16),
    attempt_id: "b".repeat(32),
    deposited_at: "2026-10-16T10:00:00.000Z",
    head_at_deposit: "c".repeat(40),
    branch: "main",
    git_root: settingsDir,
    text: canary,
  };

  gateway.sendResume(frame);
  expect((await session.readNotification()).params).toMatchObject({ content: expect.stringContaining(canary) });
  const deadline = Date.now() + 5_000;
  while (gateway.acknowledgements.length < 1 && Date.now() < deadline) await Bun.sleep(20);
  expect(gateway.acknowledgements).toEqual([{
    instance_token: expect.any(String),
    deposit_id: frame.deposit_id,
    attempt_id: frame.attempt_id,
  }]);

  gateway.sendResume(frame);
  while (gateway.acknowledgements.length < 2 && Date.now() < deadline) await Bun.sleep(20);
  expect(gateway.acknowledgements).toHaveLength(2);
  await session.expectNoNotification();

  session.proc.kill();
  await session.proc.exited;
  const logs =
    session.stderr.text +
    (existsSync(logDir) ? readdirSync(logDir).map((file) => readFileSync(join(logDir, file), "utf8")).join("\n") : "");
  expect(logs).not.toContain(canary);
}, 40_000);

test("concurrent duplicate context resumes emit one notification and acknowledge each replay", async () => {
  const broker = sharedBroker;
  const gateway = startResumeGateway(broker, [500]);
  const settingsDir = mkdtempSync(join(tmpdir(), "cp-context-concurrent-"));
  dirs.push(settingsDir);
  const session = await launchServer(gateway.url, settingsDir, randomBytes(32).toString("hex"), join(settingsDir, "logs"));
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
  await gateway.waitForSocket();
  const frame = {
    type: "context_resume",
    deposit_id: "c".repeat(16),
    attempt_id: "d".repeat(32),
    deposited_at: "2026-10-16T10:00:00.000Z",
    head_at_deposit: "e".repeat(40),
    branch: "main",
    git_root: settingsDir,
    text: `context-concurrent-${randomUUID()}`,
  };

  for (let i = 0; i < 10; i++) gateway.sendResume(frame);
  expect((await session.readNotification()).params).toMatchObject({ content: expect.stringContaining(frame.text) });
  const deadline = Date.now() + 5_000;
  while (gateway.acknowledgements.length < 10 && Date.now() < deadline) await Bun.sleep(20);
  expect(gateway.acknowledgements).toHaveLength(10);
  await session.expectNoNotification();

  session.proc.kill();
  await session.proc.exited;
}, 40_000);

for (const finalStatus of [200, 409]) {
  test(`a replay after a final ${finalStatus} acknowledgement re-acknowledges without notifying, until the key expires`, async () => {
    const keyTtlMs = 1_500;
    const broker = sharedBroker;
    const gateway = startResumeGateway(broker, [finalStatus]);
    const settingsDir = mkdtempSync(join(tmpdir(), "cp-context-final-ack-"));
    dirs.push(settingsDir);
    const session = await launchServer(
      gateway.url,
      settingsDir,
      randomBytes(32).toString("hex"),
      join(settingsDir, "logs"),
      { CLAUDE_PEERS_CONTEXT_RESUME_KEY_TTL_MS: String(keyTtlMs) }
    );
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
    await gateway.waitForSocket();
    const frame = {
      type: "context_resume",
      deposit_id: "f".repeat(16),
      attempt_id: "0".repeat(32),
      deposited_at: "2026-10-16T10:00:00.000Z",
      head_at_deposit: "1".repeat(40),
      branch: "main",
      git_root: settingsDir,
      text: `context-final-${finalStatus}-${randomUUID()}`,
    };
    const waitForAcknowledgements = async (count: number): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (gateway.acknowledgements.length < count && Date.now() < deadline) await Bun.sleep(20);
      expect(gateway.acknowledgements).toHaveLength(count);
    };

    gateway.sendResume(frame);
    expect((await session.readNotification()).params).toMatchObject({ content: expect.stringContaining(frame.text) });
    await waitForAcknowledgements(1);
    const acknowledgedAt = Date.now();
    await waitForLog(
      session.stderr,
      finalStatus === 200
        ? `Context resume technical acknowledgement sent for ${frame.deposit_id}`
        : `context resume acknowledgement failed for ${frame.deposit_id}`
    );

    gateway.sendResume(frame);
    await waitForAcknowledgements(2);
    await session.expectNoNotification();

    // Replays re-acknowledge until the key expires; the first one after that notifies.
    let afterExpiry: Record<string, unknown> | null = null;
    for (const giveUpAt = acknowledgedAt + keyTtlMs + 5_000; !afterExpiry && Date.now() < giveUpAt; ) {
      gateway.sendResume(frame);
      afterExpiry = await session.pollNotification(100);
    }
    expect(afterExpiry?.params).toMatchObject({ content: expect.stringContaining(frame.text) });

    session.proc.kill();
    await session.proc.exited;
  }, 40_000);
}
