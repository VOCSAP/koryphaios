// Faults are real SQLite triggers on the broker's own database: the broker carries no fault hook.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";
import { OPERATOR_INSTANCE_TOKEN, type AtomicDispatchCapability, type AtomicDispatchIntent, type RoadmapItem } from "../shared/types.ts";
import {
  FIXTURE_OPERATOR,
  deckAuthored,
  get,
  groupId,
  livePid,
  openBrokerDb,
  post,
  sha256Hex,
  startBroker,
  stopBroker,
  type TestBroker,
} from "./_helper.ts";
import { reachedWithin } from "./_bounded-await.ts";

const otherOperator = generateCredential();
let broker: TestBroker;
let brokerId = "";

beforeAll(async () => {
  broker = await startBroker({}, { trustedOperators: [FIXTURE_OPERATOR.publicKey, otherOperator.publicKey] });
  const health = await get<{ atomic_dispatch: AtomicDispatchCapability }>(`${broker.url}/health`);
  brokerId = health.body.atomic_dispatch.broker_id;
});

afterAll(async () => {
  await stopBroker(broker);
});

let seq = 0;

interface Peer {
  peer_id: string;
  instance_token: string;
}

interface Scenario {
  group: { id: string; hash: string };
  project: string;
  lead: Peer;
  worker: Peer;
}

async function register(at: TestBroker, host: string, cwd: string, group: Scenario["group"]): Promise<Peer> {
  const res = await post<Peer>(`${at.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: 1,
    project_key: null,
    group_id: group.id,
    group_secret_hash: group.hash,
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function scenario(at: TestBroker = broker): Promise<Scenario> {
  seq += 1;
  const secret = `atomic-dispatch-${seq}-${at.port}`;
  const group = { id: await groupId(secret), hash: await sha256Hex(secret) };
  return {
    group,
    project: `github.com/vocsap/atomic-${seq}-${at.port}`,
    lead: await register(at, `hl${seq}`, `/atomic/lead${seq}`, group),
    worker: await register(at, `hw${seq}`, `/atomic/worker${seq}`, group),
  };
}

async function card(s: Scenario, fields: Record<string, unknown> = {}, at: TestBroker = broker): Promise<RoadmapItem> {
  const res = await post<{ item: RoadmapItem }>(
    `${at.url}/roadmap/upsert`,
    deckAuthored({ project_key: s.project, title: `card ${s.project} ${Math.random()}`, status: "planned", ...fields })
  );
  expect(res.status).toBe(200);
  return res.body.item;
}

async function reread(s: Scenario, ids: string[], at: TestBroker = broker): Promise<RoadmapItem[]> {
  const res = await post<{ items: RoadmapItem[] }>(`${at.url}/roadmap/list`, { project_key: s.project });
  return ids.map((id) => res.body.items.find((i) => i.id === id)!);
}

function intentFor(s: Scenario, items: RoadmapItem[], over: Partial<AtomicDispatchIntent> = {}, id = brokerId): AtomicDispatchIntent {
  return {
    broker_id: id,
    operation_id: `${Date.now() + 60_000}:${crypto.randomUUID()}`,
    project_key: s.project,
    group_id: s.group.id,
    mode: "wave",
    target_kind: "lead",
    to_peer_id: s.lead.peer_id,
    members: items.map((i) => ({
      id: i.id,
      expected_content_rev: i.content_rev!,
      expected_dispatch_state_tag: i.dispatch_state_tag!,
    })),
    ...over,
  };
}

interface Reply {
  delivery?: string;
  operation_id?: string;
  reason?: string;
  message_id?: number;
  card_ids?: string[];
  code?: string;
  error?: string;
}

function dispatch(
  s: Scenario,
  action: "execute" | "resolve",
  intent: AtomicDispatchIntent,
  at: TestBroker = broker,
  hash: string | null = s.group.hash
): Promise<{ status: number; body: Reply }> {
  return post<Reply>(`${at.url}/roadmap/dispatch-atomic`, deckAuthored({ action, intent, group_secret_hash: hash }));
}

function readDb<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    return db.query(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

function writeDb(...statements: string[]): void {
  const db = openBrokerDb(broker.dbPath);
  try {
    for (const sql of statements) db.run(sql);
  } finally {
    db.close();
  }
}

function messagesTo(token: string): { id: number; text: string; from_token: string }[] {
  return readDb("SELECT id, text, from_token FROM messages WHERE to_token = ? ORDER BY id", token);
}

function operations(group: string): { operation_id: string; result_json: string }[] {
  return readDb("SELECT operation_id, result_json FROM roadmap_dispatch_operations WHERE group_id = ?", group);
}

async function queuedWave(s: Scenario, count = 2): Promise<RoadmapItem[]> {
  const created: RoadmapItem[] = [];
  for (let n = 0; n < count; n++) created.push(await card(s, { status: n === 0 ? "idea" : "planned", queue: 1 }));
  // Queue order inside one rank is the card id, as the Deck derives it.
  return reread(s, created.map((c) => c.id).sort());
}

test("/health names the broker identity and the limits a client needs before its first request", async () => {
  const health = await get<{ atomic_dispatch: AtomicDispatchCapability }>(`${broker.url}/health`);
  expect(health.body.atomic_dispatch).toMatchObject({ version: 1, broker_id: brokerId });
  expect(health.body.atomic_dispatch.max_members).toBeGreaterThan(1);
  expect(health.body.atomic_dispatch.max_operation_ms).toBeGreaterThan(0);
});

test("a wave writes its cards, stores ONE message for the lead and records the sent result", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const res = await dispatch(s, "execute", intentFor(s, items));
  expect(res.status).toBe(200);
  expect(res.body.delivery).toBe("sent");

  const after = await reread(s, items.map((i) => i.id));
  expect(after.map((i) => [i.status, i.queue])).toEqual([["planned", null], ["planned", null]]);

  const stored = messagesTo(s.lead.instance_token);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.from_token).toBe("__deck__");
  expect(stored[0]!.id).toBe(res.body.message_id!);
  for (const i of items) expect(stored[0]!.text).toContain(i.id.slice(0, 8));
  expect(messagesTo(s.worker.instance_token)).toHaveLength(0);
  expect(operations(s.group.id)).toHaveLength(1);
});

test("replaying the same operation with a fresh proof returns the stored result and no second message", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const intent = intentFor(s, items);
  const first = await dispatch(s, "execute", intent);
  const again = await dispatch(s, "execute", intent);
  expect(again.status).toBe(200);
  expect(again.body).toEqual(first.body);
  expect((await dispatch(s, "resolve", intent)).body).toEqual(first.body);
  expect(messagesTo(s.lead.instance_token)).toHaveLength(1);

  const different = await dispatch(s, "execute", { ...intent, to_peer_id: s.worker.peer_id });
  expect(different.status).toBe(409);
  expect(different.body.code).toBe("dispatch-operation-mismatch");
  expect(messagesTo(s.worker.instance_token)).toHaveLength(0);
});

test("an assignment reaches the chosen peer, moves the card to in_progress and claims no lock", async () => {
  const s = await scenario();
  const [item] = await queuedWave(s, 1);
  const intent = intentFor(s, [item!], { mode: "assign", target_kind: "assignee", to_peer_id: s.worker.peer_id });
  const res = await dispatch(s, "execute", intent);
  expect(res.body.delivery).toBe("sent");
  const [after] = await reread(s, [item!.id]);
  expect([after!.status, after!.queue, after!.locked]).toEqual(["in_progress", null, false]);
  expect(messagesTo(s.lead.instance_token)).toHaveLength(0);
  const stored = messagesTo(s.worker.instance_token);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.text).toContain("assigned THIS roadmap item to you");
});

test("an assignment to a peer that is not there refuses and never falls back to the lead", async () => {
  const s = await scenario();
  const [item] = await queuedWave(s, 1);
  const intent = intentFor(s, [item!], { mode: "assign", target_kind: "assignee", to_peer_id: "nobody-here" });
  const res = await dispatch(s, "execute", intent);
  expect([res.status, res.body.reason]).toEqual([409, "no-target"]);
  expect(messagesTo(s.lead.instance_token)).toHaveLength(0);
  expect((await reread(s, [item!.id]))[0]!.queue).toBe(1);
});

test("a peer id active in two groups: each dispatch reaches the peer of its own group only", async () => {
  const a = await scenario();
  const secretB = `atomic-homonym-${seq}`;
  const groupB = { id: await groupId(secretB), hash: await sha256Hex(secretB) };
  const homonym = await register(broker, `hl${seq}`, `/atomic/lead${seq}`, groupB);
  const b: Scenario = { ...a, group: groupB, project: `${a.project}-b`, lead: homonym };
  expect(homonym.peer_id).toBe(a.lead.peer_id);
  expect(homonym.instance_token).not.toBe(a.lead.instance_token);

  const itemsA = await queuedWave(a);
  const itemsB = await queuedWave(b);
  expect((await dispatch(a, "execute", intentFor(a, itemsA))).body.delivery).toBe("sent");
  expect((await dispatch(b, "execute", intentFor(b, itemsB))).body.delivery).toBe("sent");

  const toA = messagesTo(a.lead.instance_token);
  const toB = messagesTo(homonym.instance_token);
  expect([toA.length, toB.length]).toEqual([1, 1]);
  for (const i of itemsA) {
    expect(toA[0]!.text).toContain(i.id.slice(0, 8));
    expect(toB[0]!.text).not.toContain(i.id.slice(0, 8));
  }
  for (const i of itemsB) {
    expect(toB[0]!.text).toContain(i.id.slice(0, 8));
    expect(toA[0]!.text).not.toContain(i.id.slice(0, 8));
  }
});

test("an echo that rewrites queue and lock with identical values moves rev, not the state tag or the dispatch", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const revBefore = readDb<{ rev: number }>("SELECT rev FROM roadmap_items WHERE id = ?", items[0]!.id)[0]!.rev;
  writeDb(`UPDATE roadmap_items SET queue = queue, locked = locked, locked_by = locked_by, locked_group = locked_group WHERE id = '${items[0]!.id}'`);
  const revAfter = readDb<{ rev: number }>("SELECT rev FROM roadmap_items WHERE id = ?", items[0]!.id)[0]!.rev;
  expect(revAfter).toBeGreaterThan(revBefore);
  const [again] = await reread(s, [items[0]!.id]);
  expect(again!.dispatch_state_tag).toBe(items[0]!.dispatch_state_tag!);
  expect((await dispatch(s, "execute", intentFor(s, items))).body.delivery).toBe("sent");
});

type Refusal = [string, (s: Scenario, items: RoadmapItem[]) => Promise<AtomicDispatchIntent>, string, (items: RoadmapItem[]) => string[]];

const REFUSALS: Refusal[] = [
  [
    "a card whose content changed since it was read",
    async (s, items) => {
      await post(`${broker.url}/roadmap/upsert`, deckAuthored({ id: items[1]!.id, title: "renamed meanwhile" }));
      return intentFor(s, items);
    },
    "card-changed",
    (items) => [items[1]!.id],
  ],
  [
    "a card whose queue moved without a content change",
    async (s, items) => {
      writeDb(`UPDATE roadmap_items SET queue = 7 WHERE id = '${items[0]!.id}'`);
      return intentFor(s, items);
    },
    "card-changed",
    (items) => [items[0]!.id],
  ],
  [
    "a card whose lock owner changed without a content change",
    async (s, items) => {
      writeDb(`UPDATE roadmap_items SET locked_by_token = 'someone-else' WHERE id = '${items[1]!.id}'`);
      return intentFor(s, items);
    },
    "card-changed",
    (items) => [items[1]!.id],
  ],
  [
    "a card parked since it was read",
    async (s, items) => {
      writeDb(`UPDATE roadmap_items SET lock_parked_by = 'op', lock_parked_at = '2026-01-01 00:00:00' WHERE id = '${items[0]!.id}'`);
      return intentFor(s, items);
    },
    "card-changed",
    (items) => [items[0]!.id],
  ],
  [
    "a head wave that gained a card",
    async (s, items) => {
      await card(s, { queue: 1 });
      return intentFor(s, items);
    },
    "queue-changed",
    (items) => items.map((i) => i.id),
  ],
  [
    "a directive card queued in the head wave",
    async (s, items) => {
      await card(s, { kind: "directive", directive: "clear", queue: 1, status: "planned" });
      return intentFor(s, items);
    },
    "queue-changed",
    (items) => items.map((i) => i.id),
  ],
  [
    "a member that is done",
    async (s, items) => {
      const closed = await card(s, { status: "done" });
      return intentFor(s, [...items, closed]);
    },
    "ineligible",
    () => [],
  ],
  [
    "a member that is inactive",
    async (s, items) => {
      const sleeper = await card(s, { inactive: true });
      return intentFor(s, [...items, sleeper]);
    },
    "ineligible",
    () => [],
  ],
  [
    "a member that is a directive",
    async (s, items) => {
      const directive = await card(s, { kind: "directive", directive: "clear" });
      return intentFor(s, [...items, directive]);
    },
    "ineligible",
    () => [],
  ],
  [
    "a member of another project",
    async (s, items) => {
      const foreign = await card({ ...s, project: `${s.project}-other` });
      return intentFor(s, [...items, foreign]);
    },
    "ineligible",
    () => [],
  ],
  [
    "a target peer that is not active in the group",
    async (s, items) => intentFor(s, items, { to_peer_id: "ghost-peer" }),
    "no-target",
    () => [],
  ],
];

test.each(REFUSALS)("%s refuses with no card and no message effect", async (_name, build, reason, ids) => {
  const s = await scenario();
  const items = await queuedWave(s);
  const intent = await build(s, items);
  const snapshot = JSON.stringify(await reread(s, items.map((i) => i.id)));
  const res = await dispatch(s, "execute", intent);
  expect([res.status, res.body.delivery, res.body.reason]).toEqual([409, "not-sent", reason]);
  const expectedIds = ids(items);
  if (expectedIds.length > 0) expect(res.body.card_ids).toEqual(expectedIds);
  expect(JSON.stringify(await reread(s, items.map((i) => i.id)))).toBe(snapshot);
  expect(messagesTo(s.lead.instance_token)).toHaveLength(0);
  expect(messagesTo(s.worker.instance_token)).toHaveLength(0);
});

test("a wrong group secret, an unsigned author and a claimed peer author are refused before any effect", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const intent = intentFor(s, items);
  const wrongSecret = await dispatch(s, "execute", intent, broker, await sha256Hex("not-the-secret"));
  expect(wrongSecret.status).toBe(401);
  const unsigned = await post<Reply>(`${broker.url}/roadmap/dispatch-atomic`, {
    by: "unregistered-fixture",
    action: "execute",
    intent,
    group_secret_hash: s.group.hash,
  });
  expect(unsigned.status).toBe(403);
  const claimed = await post<Reply>(`${broker.url}/roadmap/dispatch-atomic`, {
    by: s.lead.peer_id,
    action: "execute",
    intent,
    group_secret_hash: s.group.hash,
  });
  expect(claimed.status).toBe(401);
  expect((await reread(s, items.map((i) => i.id))).map((i) => i.queue)).toEqual([1, 1]);
  expect(messagesTo(s.lead.instance_token)).toHaveLength(0);
  expect(operations(s.group.id)).toHaveLength(0);
});

const FAULTS: [string, (s: Scenario, items: RoadmapItem[]) => string][] = [
  [
    "the second card write, after the first was written",
    (_s, items) => `CREATE TRIGGER inject_fault AFTER UPDATE ON roadmap_items WHEN NEW.id = '${items[1]!.id}' BEGIN SELECT RAISE(ABORT, 'injected'); END`,
  ],
  ["the message insert", () => "CREATE TRIGGER inject_fault BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END"],
  [
    "the sent-result record, after the message was inserted",
    () =>
      `CREATE TRIGGER inject_fault BEFORE INSERT ON roadmap_dispatch_operations
         WHEN NEW.result_json LIKE '%"delivery":"sent"%' BEGIN SELECT RAISE(ABORT, 'injected'); END`,
  ],
];

test.each(FAULTS)("a fault at %s leaves no card, message or sent result and records write-failed", async (_name, trigger) => {
  const s = await scenario();
  const items = await queuedWave(s);
  const intent = intentFor(s, items);
  const snapshot = JSON.stringify(await reread(s, items.map((i) => i.id)));
  writeDb(trigger(s, items));
  try {
    const res = await dispatch(s, "execute", intent);
    expect([res.status, res.body.delivery, res.body.reason]).toEqual([409, "not-sent", "write-failed"]);
    expect(JSON.stringify(await reread(s, items.map((i) => i.id)))).toBe(snapshot);
    expect(messagesTo(s.lead.instance_token)).toHaveLength(0);
    expect(operations(s.group.id)).toHaveLength(1);
  } finally {
    writeDb("DROP TRIGGER IF EXISTS inject_fault");
  }
  const retried = await dispatch(s, "execute", intent);
  expect([retried.status, retried.body.reason]).toEqual([409, "write-failed"]);
  expect(messagesTo(s.lead.instance_token)).toHaveLength(0);
});

test("a failure that also stops the result from being kept answers an error and the same id runs later", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const intent = intentFor(s, items);
  writeDb("CREATE TRIGGER inject_fault BEFORE INSERT ON roadmap_dispatch_operations BEGIN SELECT RAISE(ABORT, 'injected'); END");
  try {
    const res = await dispatch(s, "execute", intent);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await reread(s, items.map((i) => i.id))).map((i) => i.queue)).toEqual([1, 1]);
    expect(messagesTo(s.lead.instance_token)).toHaveLength(0);
  } finally {
    writeDb("DROP TRIGGER IF EXISTS inject_fault");
  }
  expect((await dispatch(s, "execute", intent)).body.delivery).toBe("sent");
});

async function openLeadSocket(token: string): Promise<{ frames: { type: string; id: number; text: string }[]; ws: WebSocket }> {
  const frames: { type: string; id: number; text: string }[] = [];
  const ws = new WebSocket(broker.wsUrl);
  ws.addEventListener("message", (ev) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    frames.push(JSON.parse(text));
  });
  await reachedWithin(
    new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "auth", instance_token: token }));
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("ws error")));
    }),
    "lead websocket open"
  );
  return { frames, ws };
}

async function nextMessageFrame(frames: { type: string }[], from: number): Promise<number> {
  return reachedWithin(
    (async () => {
      for (;;) {
        const at = frames.findIndex((f, i) => i >= from && f.type === "message");
        if (at >= 0) return at;
        await Bun.sleep(10);
      }
    })(),
    "a message frame on the lead socket"
  );
}

test("no frame leaves for a rolled-back dispatch, and the committed one arrives with the stored message", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const { frames, ws } = await openLeadSocket(s.lead.instance_token);
  try {
    writeDb(
      `CREATE TRIGGER inject_fault BEFORE INSERT ON roadmap_dispatch_operations
         WHEN NEW.result_json LIKE '%"delivery":"sent"%' BEGIN SELECT RAISE(ABORT, 'injected'); END`
    );
    try {
      const failed = await dispatch(s, "execute", intentFor(s, items));
      expect(failed.body.reason).toBe("write-failed");
    } finally {
      writeDb("DROP TRIGGER IF EXISTS inject_fault");
    }
    // The sentinel travels the same socket after the failed attempt: a frame
    // pushed from inside the rolled-back transaction would precede it.
    const sentinel = await post<{ sent: number }>(`${broker.url}/announce`, {
      group_id: s.group.id,
      group_secret_hash: s.group.hash,
      to_peer_id: s.lead.peer_id,
      text: "sentinel after the rolled-back dispatch",
    });
    expect(sentinel.body.sent).toBe(1);
    const first = await nextMessageFrame(frames, 0);
    expect(frames[first]!.text).toBe("sentinel after the rolled-back dispatch");

    const ok = await dispatch(s, "execute", intentFor(s, items));
    expect(ok.body.delivery).toBe("sent");
    const second = await nextMessageFrame(frames, first + 1);
    expect(frames[second]!.id).toBe(ok.body.message_id!);
    expect(frames[second]!.text).toBe(messagesTo(s.lead.instance_token).find((m) => m.id === ok.body.message_id)!.text);
    expect(operations(s.group.id).filter((o) => o.result_json.includes('"sent"'))).toHaveLength(1);
  } finally {
    ws.close();
  }
});

test("resolve of an unknown operation cancels it, and the delayed execute with that id acts on nothing", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const intent = intentFor(s, items);
  const resolved = await dispatch(s, "resolve", intent);
  expect([resolved.status, resolved.body.delivery, resolved.body.reason]).toEqual([409, "not-sent", "cancelled-before-execution"]);
  const late = await dispatch(s, "execute", intent);
  expect([late.status, late.body.reason]).toEqual([409, "cancelled-before-execution"]);
  expect((await reread(s, items.map((i) => i.id))).map((i) => i.queue)).toEqual([1, 1]);
  expect(messagesTo(s.lead.instance_token)).toHaveLength(0);
});

test("an operation past its deadline cannot execute and an unknown one resolves to unknown expired", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const intent = intentFor(s, items, { operation_id: `${Date.now() - 1}:${crypto.randomUUID()}` });
  const executed = await dispatch(s, "execute", intent);
  expect([executed.status, executed.body.code]).toEqual([409, "dispatch-operation-expired"]);
  const resolved = await dispatch(s, "resolve", intent);
  expect(resolved.status).toBe(200);
  expect(resolved.body).toEqual({ delivery: "unknown", operation_id: intent.operation_id, reason: "expired" });
  expect(messagesTo(s.lead.instance_token)).toHaveLength(0);
  expect(operations(s.group.id)).toHaveLength(0);
});

test("a reserved identity as the target is an invalid request, never a lookup", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  for (const reserved of ["operator", "deck"]) {
    const res = await dispatch(s, "execute", intentFor(s, items, { to_peer_id: reserved }));
    expect([reserved, res.status, res.body.code]).toEqual([reserved, 400, "dispatch-invalid-request"]);
  }
  expect(messagesTo(OPERATOR_INSTANCE_TOKEN)).toHaveLength(0);
  expect(operations(s.group.id)).toHaveLength(0);
});

test("a deadline beyond the advertised maximum and an intent with an unknown field are invalid requests", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const far = await dispatch(s, "execute", intentFor(s, items, { operation_id: `${Date.now() + 3_600_000}:${crypto.randomUUID()}` }));
  expect([far.status, far.body.code]).toEqual([400, "dispatch-invalid-request"]);
  const extra = await dispatch(s, "execute", { ...intentFor(s, items), status: "done" } as AtomicDispatchIntent);
  expect([extra.status, extra.body.code]).toEqual([400, "dispatch-invalid-request"]);
});

function signedBy(operator: ReturnType<typeof generateCredential>, payload: Record<string, unknown>): Record<string, unknown> {
  const body = { ...payload, by: "deck", public_key: operator.publicKey };
  return {
    ...body,
    auth: buildAuthProof(operator.privateKey, body, { kind: "operator", operator_id: deriveOperatorId(operator.publicKey) }),
  };
}

test("another operator never reads this operator's result, even with the same operation id and intent", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const intent = intentFor(s, items);
  const mine = await dispatch(s, "execute", intent);
  expect(mine.body.delivery).toBe("sent");
  const theirs = await post<Reply>(
    `${broker.url}/roadmap/dispatch-atomic`,
    signedBy(otherOperator, { action: "resolve", intent, group_secret_hash: s.group.hash })
  );
  expect([theirs.status, theirs.body.reason]).toEqual([409, "cancelled-before-execution"]);
  expect((await dispatch(s, "resolve", intent)).body).toEqual(mine.body);
  expect(messagesTo(s.lead.instance_token)).toHaveLength(1);
});

test("the result survives a broker restart on the same database, and another database refuses the identity", async () => {
  const first = await startBroker({}, { trustedOperators: [FIXTURE_OPERATOR.publicKey] });
  let second: TestBroker | null = null;
  try {
    const firstId = (await get<{ atomic_dispatch: AtomicDispatchCapability }>(`${first.url}/health`)).body.atomic_dispatch.broker_id;
    const s = await scenario(first);
    const created: RoadmapItem[] = [];
    for (let n = 0; n < 2; n++) created.push(await card(s, { queue: 1 }, first));
    const items = await reread(s, created.map((c) => c.id).sort(), first);
    const intent = intentFor(s, items, {}, firstId);
    const sent = await dispatch(s, "execute", intent, first);
    expect(sent.body.delivery).toBe("sent");

    first.proc.kill();
    await first.proc.exited;
    second = await startBroker({ CLAUDE_PEERS_DB: first.dbPath }, { trustedOperators: [FIXTURE_OPERATOR.publicKey] });
    const restarted = (await get<{ atomic_dispatch: AtomicDispatchCapability }>(`${second.url}/health`)).body.atomic_dispatch.broker_id;
    expect(restarted).toBe(firstId);
    const resolved = await dispatch(s, "resolve", intent, second);
    expect(resolved.body).toEqual(sent.body);

    const elsewhere = await dispatch(s, "execute", intent, broker);
    expect([elsewhere.status, elsewhere.body.code]).toEqual([409, "dispatch-broker-mismatch"]);
    expect(operations(s.group.id)).toHaveLength(0);
  } finally {
    if (second) await stopBroker(second);
    await stopBroker(first);
  }
}, 40_000);

test("a ranked card of a named lot is not part of the head wave", async () => {
  const s = await scenario();
  const items = await queuedWave(s);
  const named = await card(s, { status: "planned" });
  writeDb(`UPDATE roadmap_items SET lot_id = 'lot-named', queue = 1 WHERE id = '${named.id}'`);

  const res = await dispatch(s, "execute", intentFor(s, items));

  expect(res.body.delivery, JSON.stringify(res.body)).toBe("sent");
  expect(readDb("SELECT queue FROM roadmap_items WHERE id = ?", named.id)).toEqual([{ queue: 1 }]);
});
