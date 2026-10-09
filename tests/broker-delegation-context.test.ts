import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { groupId, livePid, post, sha256Hex, startBroker, stopBroker, type TestBroker } from "./_helper.ts";

interface Peer {
  peer_id: string;
  instance_token: string;
}

interface TaskRef {
  task_id: string;
  label: string;
  due_at: string | null;
  status: string;
  recipient_side?: string;
}

interface DelegationContext {
  task?: TaskRef;
  open_from_recipient_to_sender?: { total: number; tasks: TaskRef[] };
}

interface Frame {
  type: string;
  id: number;
  text: string;
  delegation_context?: DelegationContext;
}

interface Delivered {
  id: number;
  text: string;
  delegation_context?: DelegationContext;
}

const INTERNAL_FIELDS = ["delegator_token", "delegate_binding", "owner_broker_id", "instance_token", "from_token", "to_token"];

let broker: TestBroker;
let group: string;
let secretHash: string;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  broker = await startBroker();
  const secret = `delegation-context-${randomUUID()}`;
  group = await groupId(secret);
  secretHash = await sha256Hex(secret);
});

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await stopBroker(broker);
});

async function register(name: string): Promise<Peer> {
  const result = await post<Peer>(`${broker.url}/register`, {
    pid: livePid(),
    cwd: `/${name}-${randomUUID()}`,
    git_root: null,
    tty: null,
    summary: "",
    host: name,
    client_pid: 1,
    project_key: null,
    group_id: group,
    group_secret_hash: secretHash,
  });
  expect(result.status).toBe(200);
  return result.body;
}

async function send(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; task?: { task_id: string } }> {
  const result = await post<{ ok: boolean; error?: string; task?: { task_id: string } }>(`${broker.url}/send-message`, body);
  expect(result.status).toBe(200);
  expect(result.body.error).toBeUndefined();
  expect(result.body.ok).toBeTrue();
  return result.body;
}

async function delegate(from: Peer, to: Peer, label: string, deadlineSec = 600): Promise<string> {
  const result = await send({
    from_token: from.instance_token,
    to_peer_id: to.peer_id,
    text: `Please handle ${label}`,
    deadline_sec: deadlineSec,
    task_label: label,
  });
  return result.task!.task_id;
}

async function openWs(peer: Peer): Promise<Frame[]> {
  const frames: Frame[] = [];
  const ws = new WebSocket(broker.wsUrl);
  sockets.push(ws);
  ws.addEventListener("message", (ev) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    frames.push(JSON.parse(text) as Frame);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 2000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: "auth", instance_token: peer.instance_token }));
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  await Bun.sleep(150);
  return frames;
}

async function frameWithText(frames: Frame[], text: string): Promise<Frame> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = frames.find((f) => f.type === "message" && f.text === text);
    if (found) return found;
    await Bun.sleep(25);
  }
  throw new Error(`no frame with text ${JSON.stringify(text)} within 3 s`);
}

function storedTaskId(text: string): string | null {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT task_id FROM messages WHERE text = ?").get(text) as { task_id: string | null } | null;
    if (!row) throw new Error(`message ${JSON.stringify(text)} not stored`);
    return row.task_id;
  } finally {
    db.close();
  }
}

function makeOverdue(taskId: string): void {
  const db = new Database(broker.dbPath);
  try {
    db.run("PRAGMA busy_timeout = 3000");
    db.run("UPDATE delegated_tasks SET status = 'overdue', decision_due_at_ms = ? WHERE task_id = ?", [
      Date.now() + 600_000,
      taskId,
    ]);
  } finally {
    db.close();
  }
}

function dueAtFromDb(taskId: string): string {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT due_at_ms FROM delegated_tasks WHERE task_id = ?").get(taskId) as { due_at_ms: number };
    return new Date(row.due_at_ms).toISOString();
  } finally {
    db.close();
  }
}

function expectNoInternals(value: unknown): void {
  const json = JSON.stringify(value);
  for (const field of INTERNAL_FIELDS) expect(json).not.toContain(field);
}

describe("messages remember the task they validly cite", () => {
  test("create, plain citation, rearm and close-with-report store the task id; an ordinary message stores none", async () => {
    const bob = await register("store-bob");
    const alice = await register("store-alice");
    const taskId = await delegate(bob, alice, "store-label");
    expect(storedTaskId("Please handle store-label")).toBe(taskId);

    await send({ from_token: alice.instance_token, to_peer_id: bob.peer_id, text: "store: ACK", task_id: taskId });
    expect(storedTaskId("store: ACK")).toBe(taskId);

    makeOverdue(taskId);
    await send({ from_token: bob.instance_token, to_peer_id: alice.peer_id, text: "store: rearm", task_id: taskId, deadline_sec: 600 });
    expect(storedTaskId("store: rearm")).toBe(taskId);

    await send({
      from_token: alice.instance_token,
      to_peer_id: bob.peer_id,
      text: "store: report",
      task_id: taskId,
      task_action: "close",
    });
    expect(storedTaskId("store: report")).toBe(taskId);

    await send({ from_token: alice.instance_token, to_peer_id: bob.peer_id, text: "store: ordinary" });
    expect(storedTaskId("store: ordinary")).toBeNull();
  });
});

describe("immediate WS push projects the delegation context", () => {
  test("the delegate receives the task it was given, with its side", async () => {
    const bob = await register("push-bob");
    const alice = await register("push-alice");
    const aliceFrames = await openWs(alice);
    const taskId = await delegate(bob, alice, "push-label");

    const frame = await frameWithText(aliceFrames, "Please handle push-label");
    expect(frame.delegation_context).toEqual({
      task: {
        task_id: taskId,
        label: "push-label",
        due_at: dueAtFromDb(taskId),
        status: "armed",
        recipient_side: "delegate",
      },
    });
    expectNoInternals(frame);
  });

  test("an uncited message from the delegate reminds the delegator of the open tasks with that sender", async () => {
    const bob = await register("remind-bob");
    const alice = await register("remind-alice");
    const taskId = await delegate(bob, alice, "remind-label");
    const bobFrames = await openWs(bob);

    await send({ from_token: alice.instance_token, to_peer_id: bob.peer_id, text: "remind: ACK, on it" });
    const frame = await frameWithText(bobFrames, "remind: ACK, on it");
    expect(frame.delegation_context).toEqual({
      open_from_recipient_to_sender: {
        total: 1,
        tasks: [{ task_id: taskId, label: "remind-label", due_at: dueAtFromDb(taskId), status: "armed" }],
      },
    });
    expectNoInternals(frame);
  });

  test("an overdue task is still open and keeps its due date and status in the reminder", async () => {
    const bob = await register("overdue-bob");
    const alice = await register("overdue-alice");
    const overdue = await delegate(bob, alice, "overdue-label", 60);
    const armed = await delegate(bob, alice, "armed-label", 600);
    makeOverdue(overdue);
    const bobFrames = await openWs(bob);

    await send({ from_token: alice.instance_token, to_peer_id: bob.peer_id, text: "overdue: still working" });
    const frame = await frameWithText(bobFrames, "overdue: still working");
    expect(frame.delegation_context).toEqual({
      open_from_recipient_to_sender: {
        total: 2,
        tasks: [
          { task_id: overdue, label: "overdue-label", due_at: dueAtFromDb(overdue), status: "overdue" },
          { task_id: armed, label: "armed-label", due_at: dueAtFromDb(armed), status: "armed" },
        ],
      },
    });
  });

  test("a cited message is a citation, not a reminder, for the delegator", async () => {
    const bob = await register("cite-bob");
    const alice = await register("cite-alice");
    const taskId = await delegate(bob, alice, "cite-label");
    await delegate(bob, alice, "cite-other");
    const bobFrames = await openWs(bob);

    await send({ from_token: alice.instance_token, to_peer_id: bob.peer_id, text: "cite: progress", task_id: taskId });
    const frame = await frameWithText(bobFrames, "cite: progress");
    expect(frame.delegation_context).toEqual({
      task: { task_id: taskId, label: "cite-label", due_at: expect.any(String), status: "armed", recipient_side: "delegator" },
    });
  });

  test("a report that closes a task is a citation of the closed task", async () => {
    const bob = await register("close-bob");
    const alice = await register("close-alice");
    const taskId = await delegate(bob, alice, "close-label");
    await delegate(bob, alice, "close-still-open");
    const bobFrames = await openWs(bob);

    await send({
      from_token: alice.instance_token,
      to_peer_id: bob.peer_id,
      text: "close: report",
      task_id: taskId,
      task_action: "close",
    });
    const frame = await frameWithText(bobFrames, "close: report");
    expect(frame.delegation_context).toEqual({
      task: { task_id: taskId, label: "close-label", due_at: null, status: "closed", recipient_side: "delegator" },
    });
  });

  test("the reminder keeps the exact total and lists at most five tasks, earliest due first", async () => {
    const bob = await register("cap-bob");
    const alice = await register("cap-alice");
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await delegate(bob, alice, `cap-${i}`, 7000 - i * 1000));
    const bobFrames = await openWs(bob);

    await send({ from_token: alice.instance_token, to_peer_id: bob.peer_id, text: "cap: status" });
    const frame = await frameWithText(bobFrames, "cap: status");
    const open = frame.delegation_context!.open_from_recipient_to_sender!;
    expect(open.total).toBe(7);
    expect(open.tasks.map((t) => t.task_id)).toEqual(ids.slice(2).reverse());
  });

  test("no context when there is nothing to say", async () => {
    const bob = await register("none-bob");
    const alice = await register("none-alice");
    const carol = await register("none-carol");
    await delegate(bob, alice, "none-label");
    const bobFrames = await openWs(bob);
    const aliceFrames = await openWs(alice);

    await send({ from_token: carol.instance_token, to_peer_id: bob.peer_id, text: "none: from a third peer" });
    await send({ from_token: bob.instance_token, to_peer_id: alice.peer_id, text: "none: delegator to delegate" });
    const third = await frameWithText(bobFrames, "none: from a third peer");
    const down = await frameWithText(aliceFrames, "none: delegator to delegate");
    expect("delegation_context" in third).toBeFalse();
    expect("delegation_context" in down).toBeFalse();
  });

  test("a stored task id whose pair does not match the message is not a citation", async () => {
    const bob = await register("pair-bob");
    const alice = await register("pair-alice");
    const carol = await register("pair-carol");
    const taskId = await delegate(bob, alice, "pair-secret-label");
    const db = new Database(broker.dbPath);
    try {
      db.run("PRAGMA busy_timeout = 3000");
      db.run(
        "INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered, task_id) VALUES (?, ?, ?, ?, ?, 0, ?)",
        [bob.instance_token, carol.instance_token, group, "pair: forged citation", new Date().toISOString(), taskId]
      );
    } finally {
      db.close();
    }

    const result = await post<{ messages: Delivered[] }>(`${broker.url}/peek-messages`, { instance_token: carol.instance_token });
    const forged = result.body.messages.find((m) => m.text === "pair: forged citation");
    expect(forged).toBeDefined();
    expect(forged!.delegation_context?.task).toBeUndefined();
    expect(JSON.stringify(result.body)).not.toContain("pair-secret-label");
  });

  test("a closed task no longer reminds the delegator", async () => {
    const bob = await register("closed-bob");
    const alice = await register("closed-alice");
    const taskId = await delegate(bob, alice, "closed-label");
    await post(`${broker.url}/delegations/close`, { from_token: bob.instance_token, task_id: taskId });
    const bobFrames = await openWs(bob);

    await send({ from_token: alice.instance_token, to_peer_id: bob.peer_id, text: "closed: late note" });
    const frame = await frameWithText(bobFrames, "closed: late note");
    expect("delegation_context" in frame).toBeFalse();
  });
});

describe("a failed projection never costs the message", () => {
  test("push, peek and poll deliver without context, and the failure is logged", async () => {
    const failing = await startBroker();
    try {
      const secret = `delegation-context-failing-${randomUUID()}`;
      const failingGroup = await groupId(secret);
      const failingHash = await sha256Hex(secret);
      const registerFailing = async (name: string): Promise<Peer> => {
        const result = await post<Peer>(`${failing.url}/register`, {
          pid: livePid(),
          cwd: `/${name}-${randomUUID()}`,
          git_root: null,
          tty: null,
          summary: "",
          host: name,
          client_pid: 1,
          project_key: null,
          group_id: failingGroup,
          group_secret_hash: failingHash,
        });
        expect(result.status).toBe(200);
        return result.body;
      };
      const bob = await registerFailing("failing-bob");
      const alice = await registerFailing("failing-alice");

      const db = new Database(failing.dbPath);
      try {
        db.run("PRAGMA busy_timeout = 3000");
        db.run("DROP TABLE delegated_tasks");
      } finally {
        db.close();
      }

      const frames: Frame[] = [];
      const ws = new WebSocket(failing.wsUrl);
      sockets.push(ws);
      ws.addEventListener("message", (ev) => {
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        frames.push(JSON.parse(text) as Frame);
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws open timeout")), 2000);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          ws.send(JSON.stringify({ type: "auth", instance_token: bob.instance_token }));
          resolve();
        });
      });
      await Bun.sleep(150);

      const sent = await post<{ ok: boolean; error?: string }>(`${failing.url}/send-message`, {
        from_token: alice.instance_token,
        to_peer_id: bob.peer_id,
        text: "failing: still delivered",
      });
      expect(sent.status).toBe(200);
      expect(sent.body.ok).toBeTrue();
      const pushed = await frameWithText(frames, "failing: still delivered");
      expect("delegation_context" in pushed).toBeFalse();

      for (const route of ["/peek-messages", "/poll-messages"]) {
        const result = await post<{ messages: Delivered[] }>(`${failing.url}${route}`, { instance_token: bob.instance_token });
        expect(result.status).toBe(200);
        const delivered = result.body.messages.find((m) => m.text === "failing: still delivered");
        expect(delivered).toBeDefined();
        expect("delegation_context" in delivered!).toBeFalse();
      }
      const after = await post<{ messages: Delivered[] }>(`${failing.url}/peek-messages`, { instance_token: bob.instance_token });
      expect(after.body.messages.find((m) => m.text === "failing: still delivered")).toBeUndefined();

      const logDir = join(failing.tmpDir, "logs");
      const logs = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf-8")).join("\n");
      expect(logs).toContain("delegation context: projection failed");
    } finally {
      await stopBroker(failing);
    }
  }, 30_000);
});

describe("replay, poll and peek project the same context", () => {
  test("a message queued while the delegator was offline carries the reminder on WS replay", async () => {
    const bob = await register("replay-bob");
    const alice = await register("replay-alice");
    const taskId = await delegate(bob, alice, "replay-label");
    await send({ from_token: alice.instance_token, to_peer_id: bob.peer_id, text: "replay: queued" });

    const bobFrames = await openWs(bob);
    const frame = await frameWithText(bobFrames, "replay: queued");
    expect(frame.delegation_context?.open_from_recipient_to_sender?.tasks.map((t) => t.task_id)).toEqual([taskId]);
  });

  test("the delegate's replayed task message carries its task", async () => {
    const bob = await register("replay2-bob");
    const alice = await register("replay2-alice");
    const taskId = await delegate(bob, alice, "replay2-label");

    const aliceFrames = await openWs(alice);
    const frame = await frameWithText(aliceFrames, "Please handle replay2-label");
    expect(frame.delegation_context?.task).toMatchObject({ task_id: taskId, recipient_side: "delegate" });
  });

  test("peek then poll return the context, and an ordinary message has none", async () => {
    const bob = await register("poll-bob");
    const alice = await register("poll-alice");
    const carol = await register("poll-carol");
    const taskId = await delegate(bob, alice, "poll-label");
    await send({ from_token: alice.instance_token, to_peer_id: bob.peer_id, text: "poll: done?" });
    await send({ from_token: carol.instance_token, to_peer_id: bob.peer_id, text: "poll: unrelated" });

    for (const route of ["/peek-messages", "/poll-messages"]) {
      const result = await post<{ messages: Delivered[] }>(`${broker.url}${route}`, { instance_token: bob.instance_token });
      expect(result.status).toBe(200);
      const reminded = result.body.messages.find((m) => m.text === "poll: done?");
      const unrelated = result.body.messages.find((m) => m.text === "poll: unrelated");
      expect(reminded?.delegation_context?.open_from_recipient_to_sender?.tasks.map((t) => t.task_id)).toEqual([taskId]);
      expect(unrelated).toBeDefined();
      expect("delegation_context" in unrelated!).toBeFalse();
      expectNoInternals(result.body);
    }
  });
});
