import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { CONTEXT_RESUME_VERSION, hashCapability } from "../shared/context-buffer.ts";
import { deckAuthored, groupId, livePid, post, sha256Hex, startBroker, stopBroker, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

async function openAuthenticated(token: string): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(broker.wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      frames.push(JSON.parse(text) as Record<string, unknown>);
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", instance_token: token }));
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
    setTimeout(() => reject(new Error("ws open timeout")), 2_000);
  });
  return { ws, frames };
}

async function waitForResume(frames: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = frames.find((item) => item.type === "context_resume");
    if (frame) return frame;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for context_resume");
}

async function close(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve(), { once: true });
    ws.close();
  });
}

function functionBody(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`missing ${anchor}`);
  const opening = source.indexOf("{", start);
  let depth = 0;
  for (let i = opening; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(opening, i + 1);
  }
  throw new Error(`unterminated ${anchor}`);
}

test("a cleared context resume delivers only before acknowledgement", async () => {
  const secret = randomUUID();
  const groupIdValue = await groupId(secret);
  const groupSecretHash = await sha256Hex(secret);
  const capability = randomBytes(32).toString("hex");
  const registered = await post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(),
    cwd: "C:/context-resume",
    git_root: null,
    tty: null,
    summary: "",
    host: hostname(),
    client_pid: 1,
    project_key: null,
    group_id: groupIdValue,
    group_secret_hash: groupSecretHash,
    desk_session: randomUUID(),
    deposit_capability_hash: hashCapability(capability),
    context_resume_version: CONTEXT_RESUME_VERSION,
  });
  expect(registered.status).toBe(200);

  const deposited = await post<{ deposit_id: string }>(`${broker.url}/context/deposit`, {
    deposit_capability: capability,
    text: "resume-websocket-witness",
    head: null,
    branch: null,
    git_root: null,
  });
  const reserved = await post<{ attempt_id: string }>(`${broker.url}/context/transaction`, deckAuthored({
    group_id: groupIdValue,
    group_secret_hash: groupSecretHash,
    target_peer_id: registered.body.peer_id,
    deposit_id: deposited.body.deposit_id,
    action: "reserve",
  }));
  const released = await post(`${broker.url}/context/transaction`, deckAuthored({
    group_id: groupIdValue,
    group_secret_hash: groupSecretHash,
    target_peer_id: registered.body.peer_id,
    deposit_id: deposited.body.deposit_id,
    action: "release",
    attempt_id: reserved.body.attempt_id,
    cleared: true,
  }));
  expect(released).toMatchObject({ status: 200, body: { state: "resuming", resume_delivery: "pending" } });

  const first = await openAuthenticated(registered.body.instance_token);
  const resume = await waitForResume(first.frames);
  expect(Object.keys(resume).sort()).toEqual([
    "attempt_id",
    "branch",
    "deposit_id",
    "deposited_at",
    "git_root",
    "head_at_deposit",
    "text",
    "type",
  ]);
  expect(resume).toEqual({
    type: "context_resume",
    deposit_id: deposited.body.deposit_id,
    attempt_id: reserved.body.attempt_id,
    deposited_at: expect.any(String),
    head_at_deposit: null,
    branch: null,
    git_root: null,
    text: "resume-websocket-witness",
  });
  for (const privateKey of ["instance_token", "from_token", "pid", "client_pid"]) expect(resume).not.toHaveProperty(privateKey);
  await close(first.ws);

  const second = await openAuthenticated(registered.body.instance_token);
  const replay = await waitForResume(second.frames);
  expect(replay).toMatchObject({
    type: "context_resume",
    deposit_id: deposited.body.deposit_id,
    attempt_id: reserved.body.attempt_id,
  });

  const acknowledged = await post(`${broker.url}/context/ack`, {
    instance_token: registered.body.instance_token,
    deposit_id: deposited.body.deposit_id,
    attempt_id: reserved.body.attempt_id,
  });
  expect(acknowledged).toEqual({ status: 200, body: { ok: true } });
  await close(second.ws);

  const third = await openAuthenticated(registered.body.instance_token);
  await Bun.sleep(150);
  expect(third.frames.filter((frame) => frame.type === "context_resume")).toEqual([]);
  await close(third.ws);
});

test("a failed context resume push logs only its deposit and attempt", () => {
  const source = readFileSync(resolve(import.meta.dir, "..", "broker.ts"), "utf8");
  const body = functionBody(source, "function pushContextResume").replace("const frame: WsFrame", "const frame");
  const token = "secret-owner-token";
  const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const push = new Function("contextRegistry", "wsPool", "log", `return function(depositId, attemptId) ${body}`)(
    {
      takeReleasedForResume: () => ({
        deposit_id: "0123456789abcdef",
        released_attempt_id: "a".repeat(32),
        deposited_at: "2026-10-16T10:00:00.000Z",
        head_at_deposit: null,
        branch: null,
        git_root: null,
        text: "resume-witness",
        owner_instance_token: token,
      }),
      markResumeSent: () => { throw new Error("must not mark a failed send"); },
    },
    new Map([[token, { readyState: 1, send: () => { throw new Error("closed"); } }]]),
    { warn: (message: string, fields: Record<string, unknown>) => warnings.push({ message, fields }) },
  ) as (depositId: string, attemptId: string) => boolean;

  expect(push("0123456789abcdef", "a".repeat(32))).toBe(false);
  expect(warnings).toEqual([{
    message: "context resume ws push failed",
    fields: { deposit_id: "0123456789abcdef", attempt_id: "a".repeat(32) },
  }]);
  expect(JSON.stringify(warnings)).not.toContain(token);
});
