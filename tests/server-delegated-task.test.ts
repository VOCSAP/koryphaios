// End to end: a real broker and real server.ts processes over stdio, asserting
// on the text each agent actually reads on every arrival path.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, scrubEnv, type TestBroker } from "./_helper.ts";
import { DELEGATE_CLOSE_NOTE, DELEGATOR_CHECK_NOTE } from "../shared/inbound-framing.ts";

const FORCED_GROUP = "delegated-task-e2e-ba30b865";
const TASK_ID = /tracked task ([0-9a-f-]{36})/;

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const b of brokers) await stopBroker(b);
});

interface JsonRpcResponse {
  id?: number;
  method?: string;
  params?: { content?: string };
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
}

interface Peer {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  send: (msg: unknown) => void;
}

let nextRpcId = 1;

async function readMatching(p: Peer, match: (msg: JsonRpcResponse) => boolean, what: string): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let idx: number;
    while ((idx = p.buffer.text.indexOf("\n")) >= 0) {
      const line = p.buffer.text.slice(0, idx).trim();
      p.buffer.text = p.buffer.text.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (match(msg)) return msg;
      } catch {
        /* not a complete JSON line yet */
      }
    }
    const { value, done } = await p.reader.read();
    if (done) break;
    p.buffer.text += decoder.decode(value, { stream: true });
  }
  throw new Error(`no ${what} within 30 s`);
}

async function spawnPeer(b: TestBroker, extraEnv: Record<string, string> = {}): Promise<Peer> {
  const proc = Bun.spawn(["bun", "server.ts"], {
    env: scrubEnv(b.tmpDir, {
      CLAUDE_PEERS_BROKER_URL: b.url,
      CLAUDE_PEERS_PORT: String(b.port),
      CLAUDE_PEERS_FORCE_GROUP: FORCED_GROUP,
      ...extraEnv,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  const peer: Peer = {
    reader: proc.stdout.getReader(),
    buffer: { text: "" },
    send: (msg) => {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    },
  };
  const id = nextRpcId++;
  peer.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: "delegated-task-harness", version: "0.0.1" },
    },
  });
  await readMatching(peer, (m) => m.id === id, `initialize response ${id}`);
  return peer;
}

async function callTool(p: Peer, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const id = nextRpcId++;
  p.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return readMatching(p, (m) => m.id === id, `response ${id} to ${name}`);
}

function toolText(res: JsonRpcResponse): string {
  return res.result?.content?.[0]?.text ?? "";
}

async function peerIdOf(p: Peer): Promise<string> {
  const text = toolText(await callTool(p, "whoami", {}));
  const m = text.match(/peer_id:\s*(\S+)/i) ?? text.match(/"peer_id"\s*:\s*"([^"]+)"/);
  if (!m?.[1]) throw new Error(`could not read peer_id out of whoami: ${text.slice(0, 400)}`);
  return m[1];
}

async function readChannel(p: Peer, body: string): Promise<string> {
  const pushed = await readMatching(
    p,
    (m) => m.method === "notifications/claude/channel" && (m.params?.content ?? "").includes(body),
    `channel notification carrying ${JSON.stringify(body)}`
  );
  return pushed.params?.content ?? "";
}

async function killAndRestartBroker(b: TestBroker, downMs = 0): Promise<void> {
  try {
    b.proc.kill();
    await b.proc.exited;
  } catch {
    /* already gone */
  }
  if (downMs > 0) await Bun.sleep(downMs);
  const proc = Bun.spawn(["bun", "broker.ts"], {
    env: scrubEnv(b.tmpDir, {
      CLAUDE_PEERS_PORT: String(b.port),
      CLAUDE_PEERS_DB: b.dbPath,
      CLAUDE_PEERS_LOG_DIR: `${b.tmpDir}/logs`,
      CLAUDE_PEERS_DORMANT_TTL_HOURS: "24",
    }),
    stdio: ["ignore", "ignore", "ignore"],
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      const res = await fetch(`${b.url}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        b.proc = proc;
        return;
      }
    } catch {
      /* retry */
    }
    await Bun.sleep(20);
  }
  throw new Error("could not restart broker on the same port");
}

interface Pair {
  broker: TestBroker;
  bob: Peer;
  alice: Peer;
  bobId: string;
  aliceId: string;
}

async function pair(bobEnv: Record<string, string> = {}): Promise<Pair> {
  const broker = await startBroker();
  brokers.push(broker);
  const bob = await spawnPeer(broker, bobEnv);
  const alice = await spawnPeer(broker);
  return { broker, bob, alice, bobId: await peerIdOf(bob), aliceId: await peerIdOf(alice) };
}

async function delegate(p: Pair, message: string): Promise<string> {
  const res = await callTool(p.bob, "send_message", { to_peer_id: p.aliceId, message, deadline_sec: 600 });
  expect(res.result?.isError).toBeFalsy();
  const id = toolText(res).match(TASK_ID)?.[1];
  if (!id) throw new Error(`no task id in the ack: ${toolText(res)}`);
  return id;
}

function makeOverdue(b: TestBroker, taskId: string): void {
  const db = new Database(b.dbPath);
  try {
    db.run("PRAGMA busy_timeout = 3000");
    db.run("UPDATE delegated_tasks SET status = 'overdue', decision_due_at_ms = ? WHERE task_id = ?", [Date.now() + 600_000, taskId]);
  } finally {
    db.close();
  }
}

function taskIdByLabel(b: TestBroker, label: string): string {
  const db = new Database(b.dbPath, { readonly: true });
  try {
    return (db.query("SELECT task_id FROM delegated_tasks WHERE label = ?").get(label) as { task_id: string }).task_id;
  } finally {
    db.close();
  }
}

/** Stands in for a broker older than delegated tasks: the same answers, minus `task`. */
async function oldBrokerPair(): Promise<Pair & { stop: () => void }> {
  const broker = await startBroker();
  brokers.push(broker);
  const proxy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const res = await fetch(`${broker.url}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: req.method === "GET" ? undefined : await req.text(),
      });
      const text = await res.text();
      if (url.pathname !== "/send-message") {
        return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } });
      }
      const { task: _dropped, ...rest } = JSON.parse(text) as Record<string, unknown>;
      return Response.json(rest, { status: res.status });
    },
  });
  const viaProxy = { CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${proxy.port}` };
  const bob = await spawnPeer(broker, viaProxy);
  const alice = await spawnPeer(broker, viaProxy);
  return { broker, bob, alice, bobId: await peerIdOf(bob), aliceId: await peerIdOf(alice), stop: () => proxy.stop(true) };
}

function delivered(b: TestBroker, text: string): number {
  const db = new Database(b.dbPath, { readonly: true });
  try {
    return (db.query("SELECT delivered FROM messages WHERE text = ?").get(text) as { delivered: number }).delivered;
  } finally {
    db.close();
  }
}

describe("delegating through the MCP surface", () => {
  test("the delegate is told its task id on the WS push, and the delegator can keep working", async () => {
    const p = await pair();
    const body = "Audit the resume flow.";
    const taskId = await delegate(p, body);

    const content = await readChannel(p.alice, body);
    expect(content).toContain(`[claude-peers] Tracked task ${taskId} "Audit the resume flow."`);
    expect(content).toContain(DELEGATE_CLOSE_NOTE);
    expect(await peerIdOf(p.bob)).toBe(p.bobId);
  }, 90_000);

  test("an ACK without the task id closes nothing and reminds the delegator on the WS push and in check_messages", async () => {
    const p = await pair();
    const taskId = await delegate(p, "Write the migration test.");
    const ack = "ACK, on it";
    const sent = await callTool(p.alice, "send_message", { to_peer_id: p.bobId, message: ack });
    expect(sent.result?.isError).toBeFalsy();

    const pushed = await readChannel(p.bob, ack);
    expect(pushed).toContain("[claude-peers] This peer has 1 open task(s) from you:");
    expect(pushed).toContain(`- ${taskId} "Write the migration test.", due `);
    expect(pushed).toContain(DELEGATOR_CHECK_NOTE);

    const listed = toolText(await callTool(p.bob, "check_messages", { open_tasks_with: p.aliceId }));
    expect(listed).toContain(`1 open task(s) you delegated with '${p.aliceId}':`);
    expect(listed).toContain(`task ${taskId}`);
    expect(delivered(p.broker, ack)).toBe(0);

    const mail = toolText(await callTool(p.bob, "check_messages", {}));
    expect(mail).toContain(ack);
    expect(mail).toContain(`- ${taskId} "Write the migration test."`);
  }, 90_000);

  test("a close without a message closes the task and is not reported as a sent message", async () => {
    const p = await pair();
    const taskId = await delegate(p, "Rename the flag.");
    const res = await callTool(p.bob, "send_message", { task_id: taskId, task_action: "close" });
    expect(res.result?.isError).toBeFalsy();
    expect(toolText(res)).toBe(`No message sent; task ${taskId} "Rename the flag." is closed.`);
    expect(toolText(await callTool(p.bob, "check_messages", { open_tasks_with: "*" }))).toBe("No open tasks you delegated.");
  }, 90_000);

  test("a report that cites and closes the task draws no reminder", async () => {
    const p = await pair();
    const taskId = await delegate(p, "Measure the cold start.");
    const report = "Cold start measured: 412 ms.";
    const res = await callTool(p.alice, "send_message", {
      to_peer_id: p.bobId,
      message: report,
      task_id: taskId,
      task_action: "close",
    });
    expect(res.result?.isError).toBeFalsy();
    expect(toolText(res)).toBe(`Message sent to peer '${p.bobId}'; task ${taskId} "Measure the cold start." is closed.`);
    const pushed = await readChannel(p.bob, report);
    expect(pushed).not.toContain("open task(s) from you");
  }, 90_000);

  test("a rearm through send_message rearms the same task and says so", async () => {
    const p = await pair();
    const taskId = await delegate(p, "Rearm me.");
    makeOverdue(p.broker, taskId);
    const res = await callTool(p.bob, "send_message", {
      to_peer_id: p.aliceId,
      message: "Rearm: please finish.",
      task_id: taskId,
      deadline_sec: 600,
    });
    expect(res.result?.isError).toBeFalsy();
    expect(toolText(res)).toContain(`tracked task ${taskId} "Rearm me.", due `);
    expect(toolText(res)).toContain("rearms used 1/3.");
  }, 90_000);

  test("a close carrying a message but no to_peer_id is refused and leaves the task open", async () => {
    const p = await pair();
    const taskId = await delegate(p, "Keep me open.");
    const res = await callTool(p.alice, "send_message", { message: "Report without a recipient.", task_id: taskId, task_action: "close" });
    expect(res.result?.isError).toBeTrue();
    expect(toolText(res)).toBe("Missing 'to_peer_id'");
    expect(toolText(await callTool(p.bob, "check_messages", { open_tasks_with: "*" }))).toContain(`task ${taskId}`);
  }, 90_000);

  test("a close without a message refuses a deadline instead of ignoring it", async () => {
    const p = await pair();
    const taskId = await delegate(p, "Do not close me.");
    const res = await callTool(p.bob, "send_message", { task_id: taskId, task_action: "close", deadline_sec: 60 });
    expect(res.result?.isError).toBeTrue();
    expect(toolText(res)).toBe("deadline_sec cannot accompany task_action");
    expect(toolText(await callTool(p.bob, "check_messages", { open_tasks_with: "*" }))).toContain(`task ${taskId}`);
  }, 90_000);

  test("open_tasks_with that is not a peer id is refused without touching the mail", async () => {
    const p = await pair();
    const res = await callTool(p.bob, "check_messages", { open_tasks_with: 42 });
    expect(res.result?.isError).toBeTrue();
    expect(toolText(res)).toBe("open_tasks_with must be a peer_id or '*'");
  }, 90_000);
});

describe("a broker that answers ok without a task is an error, never a tracked task", () => {
  test("creating, rearming and closing with a report all say nothing was tracked", async () => {
    const p = await oldBrokerPair();
    try {
      const created = await callTool(p.bob, "send_message", { to_peer_id: p.aliceId, message: "Old broker task.", deadline_sec: 600 });
      expect(created.result?.isError).toBeTrue();
      expect(toolText(created)).toContain("NO task was tracked, rearmed or closed");

      const taskId = taskIdByLabel(p.broker, "Old broker task.");
      makeOverdue(p.broker, taskId);
      const rearmed = await callTool(p.bob, "send_message", {
        to_peer_id: p.aliceId,
        message: "Old broker rearm.",
        task_id: taskId,
        deadline_sec: 600,
      });
      expect(rearmed.result?.isError).toBeTrue();
      expect(toolText(rearmed)).toContain("NO task was tracked, rearmed or closed");

      const closed = await callTool(p.alice, "send_message", {
        to_peer_id: p.bobId,
        message: "Old broker report.",
        task_id: taskId,
        task_action: "close",
      });
      expect(closed.result?.isError).toBeTrue();
      expect(toolText(closed)).toContain("NO task was tracked, rearmed or closed");

      const cited = await callTool(p.alice, "send_message", { to_peer_id: p.bobId, message: "Old broker citation.", task_id: taskId });
      expect(cited.result?.isError).toBeFalsy();
    } finally {
      p.stop();
    }
  }, 90_000);
});

describe("the delegator reminder survives every other arrival path", () => {
  test("fallback poll", async () => {
    const p = await pair({ CLAUDE_PEERS_POLL_FALLBACK_SEC: "0" });
    const taskId = await delegate(p, "Check the fallback path.");
    await killAndRestartBroker(p.broker);
    const ack = "fallback: ACK";
    const sent = await callTool(p.alice, "send_message", { to_peer_id: p.bobId, message: ack });
    expect(sent.result?.isError).toBeFalsy();
    const pushed = await readChannel(p.bob, ack);
    expect(pushed).toContain(`- ${taskId} "Check the fallback path."`);
    expect(pushed).toContain(DELEGATOR_CHECK_NOTE);
  }, 90_000);

  test("wait_for_message whose waiter is resolved by the fallback poll", async () => {
    const p = await pair({ CLAUDE_PEERS_POLL_FALLBACK_SEC: "0" });
    const taskId = await delegate(p, "Check the polled waiter.");
    // Same window as the peek test below: the WS stays down while the poll runs.
    await killAndRestartBroker(p.broker, 3500);
    const waiting = callTool(p.bob, "wait_for_message", { timeout_sec: 10 });
    await Bun.sleep(300);
    const ack = "polled waiter: ACK";
    const sent = await callTool(p.alice, "send_message", { to_peer_id: p.bobId, message: ack });
    expect(sent.result?.isError).toBeFalsy();
    const text = toolText(await waiting);
    expect(text).toContain(ack);
    expect(text).toContain(`- ${taskId} "Check the polled waiter."`);
  }, 90_000);

  test("wait_for_message with a waiter already registered", async () => {
    const p = await pair();
    const taskId = await delegate(p, "Check the waiter path.");
    const waiting = callTool(p.bob, "wait_for_message", { timeout_sec: 20 });
    await Bun.sleep(500);
    const ack = "waiter: ACK";
    const sent = await callTool(p.alice, "send_message", { to_peer_id: p.bobId, message: ack });
    expect(sent.result?.isError).toBeFalsy();
    const text = toolText(await waiting);
    expect(text).toContain(ack);
    expect(text).toContain(`- ${taskId} "Check the waiter path."`);
    expect(text).toContain(DELEGATOR_CHECK_NOTE);
  }, 90_000);

  test("wait_for_message served by its opportunistic peek while the WS is down", async () => {
    const p = await pair({ CLAUDE_PEERS_POLL_FALLBACK_SEC: "3600" });
    const taskId = await delegate(p, "Check the peek path.");
    // Down long enough for two failed reconnects (1 s, then 2 s): the next try
    // is 4 s later, so the WS cannot push the message before the peek reads it.
    await killAndRestartBroker(p.broker, 3500);
    const ack = "peek: ACK";
    const sent = await callTool(p.alice, "send_message", { to_peer_id: p.bobId, message: ack });
    expect(sent.result?.isError).toBeFalsy();
    const text = toolText(await callTool(p.bob, "wait_for_message", { timeout_sec: 5 }));
    expect(text).toContain(ack);
    expect(text).toContain(`- ${taskId} "Check the peek path."`);
  }, 90_000);
});
