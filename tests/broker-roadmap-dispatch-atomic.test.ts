// Faults are real SQLite triggers on the broker's own database: the broker carries no fault hook.

import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { buildAuthProof, deriveInstanceRef, deriveOperatorId, generateCredential } from "../shared/approval.ts";
import { OPERATOR_INSTANCE_TOKEN, type AtomicDispatchCapability, type AtomicDispatchIntent, type RoadmapItem } from "../shared/types.ts";
import type { RoadmapLotExecutionStateResponse } from "../shared/roadmap-lot.ts";
import {
  FIXTURE_OPERATOR,
  FIXTURE_OPERATOR_ID,
  createNamedLot,
  deckAuthored,
  mintRunCredential,
  registerAttestedInstance,
  type NamedLot,
  type RunCredential,
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
      const directive = await card(s, { kind: "directive", directive: "clear", status: "planned" });
      writeDb(`UPDATE roadmap_items SET queue = 1, lot_id = 'default' WHERE id = '${directive.id}'`);
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

test("an intent naming no lot refuses a named lot's card, assigned or as a wave, and writes nothing", async () => {
  const s = await scenario();
  const named = await card(s, { status: "planned" });
  writeDb(`UPDATE roadmap_items SET lot_id = 'lot-named', queue = 4 WHERE id = '${named.id}'`);
  const [listed] = await reread(s, [named.id]);

  const res = await dispatch(
    s,
    "execute",
    intentFor(s, [listed!], { mode: "assign", target_kind: "assignee", to_peer_id: s.worker.peer_id })
  );

  expect([res.body.delivery, res.body.reason, res.body.card_ids]).toEqual(["not-sent", "ineligible", [named.id]]);
  const wave = await dispatch(s, "execute", intentFor(s, [listed!]));
  expect([wave.body.delivery, wave.body.reason, wave.body.card_ids]).toEqual(["not-sent", "ineligible", [named.id]]);
  expect(readDb("SELECT queue, status FROM roadmap_items WHERE id = ?", named.id)).toEqual([{ queue: 4, status: "planned" }]);
  expect([...messagesTo(s.worker.instance_token), ...messagesTo(s.lead.instance_token)]).toHaveLength(0);
});

describe("dispatching a named lot", () => {
  interface LotScenario extends Scenario {
    run: RunCredential;
    lot: NamedLot & { ids: string[] };
  }

  async function attested(run: RunCredential, project: string, cwd: string): Promise<Peer> {
    const res = await registerAttestedInstance(broker, run, "lot-host", cwd, { project_key: project });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  /** An attested lead and worker, and a named lot holding one card per rank. */
  async function lotScenario(): Promise<LotScenario> {
    seq += 1;
    const secret = `atomic-lot-${seq}-${broker.port}`;
    const group = { id: await groupId(secret), hash: await sha256Hex(secret) };
    const project = `github.com/vocsap/atomic-lot-${seq}-${broker.port}`;
    const run = await mintRunCredential(broker, group, project);
    const lead = await attested(run, project, `/atomic/lot-lead${seq}`);
    const worker = await attested(run, project, `/atomic/lot-worker${seq}`);
    const lot = await createNamedLot(broker, project, "release", [{ title: "first" }, { title: "second" }]);
    lot.ids.forEach((id, n) => writeDb(`UPDATE roadmap_items SET queue = ${n + 1} WHERE id = '${id}'`));
    return { group, project, run, lead, worker, lot };
  }

  /** Sends the card of one rank as the operator's Deck signs it, to the lead unless told otherwise. */
  async function send(
    s: LotScenario,
    index: 0 | 1,
    epoch: number | null,
    over: Partial<AtomicDispatchIntent> = {},
    signed: { run_ref?: string } = { run_ref: s.run.run }
  ): Promise<{ status: number; body: Reply }> {
    const items = await reread(s, [s.lot.ids[index]!]);
    const lotId = s.lot.lotId;
    const lot = epoch === null ? { lot_id: lotId, epoch, closed_epoch: 0 } : { lot_id: lotId, epoch };
    const intent = intentFor(s, items, { lot, ...over });
    return post<Reply>(
      `${broker.url}/roadmap/dispatch-atomic`,
      deckAuthored({ action: "execute", intent, group_secret_hash: s.group.hash, ...signed })
    );
  }

  const assignTo = (peer: Peer): Partial<AtomicDispatchIntent> => ({
    mode: "assign",
    target_kind: "assignee",
    to_peer_id: peer.peer_id,
  });
  const executions = (s: LotScenario) =>
    readDb("SELECT * FROM roadmap_lot_executions WHERE project_key = ? ORDER BY epoch", s.project);
  const sends = (s: LotScenario) =>
    readDb(
      "SELECT card_id, lot_id, epoch, mode, target_peer_id FROM roadmap_lot_dispatched WHERE project_key = ? ORDER BY rowid",
      s.project
    );
  const cardsOf = (s: LotScenario) =>
    s.lot.ids.map((id) => readDb("SELECT status, queue, lot_id, content_rev FROM roadmap_items WHERE id = ?", id)[0]);
  const traces = (s: LotScenario) => ({
    cards: cardsOf(s),
    executions: executions(s),
    sends: sends(s),
    messages: [...messagesTo(s.lead.instance_token), ...messagesTo(s.worker.instance_token)].length,
  });

  type Attempt = [string, () => Promise<{ body: Reply }>, string];
  async function expectRefused(attempts: Attempt[]): Promise<void> {
    for (const [name, attempt, reason] of attempts) {
      const res = await attempt();
      expect([name, res.body.delivery, res.body.reason]).toEqual([name, "not-sent", reason]);
    }
  }

  test("the capability says the broker reads a lot", async () => {
    const health = await get<{ atomic_dispatch: AtomicDispatchCapability }>(`${broker.url}/health`);
    expect([health.body.atomic_dispatch.version, health.body.atomic_dispatch.lots]).toEqual([1, 1]);
  });

  test("a start opens the execution on the target's binding, sends the lot's head wave and records it", async () => {
    const s = await lotScenario();
    await queuedWave(s);

    const res = await send(s, 0, null);

    expect(res.body.delivery, JSON.stringify(res.body)).toBe("sent");
    expect(executions(s)).toMatchObject([
      {
        lot_id: s.lot.lotId,
        epoch: 1,
        state: "running",
        operator_id: FIXTURE_OPERATOR_ID,
        group_id: s.group.id,
        run_ref: s.run.run,
        controller_ref: deriveInstanceRef(s.lead.instance_token),
        controller_peer_id: s.lead.peer_id,
      },
    ]);
    expect(cardsOf(s)[0]).toMatchObject({ status: "planned", queue: null, lot_id: s.lot.lotId });
    expect(cardsOf(s)[1]).toMatchObject({ queue: 2 });
    const first = { card_id: s.lot.ids[0], lot_id: s.lot.lotId, epoch: 1, mode: "wave", target_peer_id: s.lead.peer_id };
    expect(sends(s)).toEqual([first]);
    expect(messagesTo(s.lead.instance_token)).toHaveLength(1);

    const next = await send(s, 1, 1);
    expect(next.body.delivery, JSON.stringify(next.body)).toBe("sent");
    expect(sends(s)).toEqual([first, { ...first, card_id: s.lot.ids[1] }]);
    expect(executions(s)).toHaveLength(1);

    const claim = await post(`${broker.url}/roadmap/upsert`, {
      id: s.lot.ids[0],
      by: s.lead.peer_id,
      instance_token: s.lead.instance_token,
      status: "in_progress",
    });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
  });

  test("a start with no provable controller, no signed run or no open epoch writes nothing", async () => {
    const s = await lotScenario();
    const bare = await register(broker, "lot-bare", `/atomic/lot-bare${seq}`, s.group);
    const otherRun = await mintRunCredential(broker, s.group, s.project);
    const far = await attested(otherRun, s.project, `/atomic/lot-far${seq}`);
    const before = traces(s);

    await expectRefused([
      ["an unattested target", () => send(s, 0, null, { to_peer_id: bare.peer_id }), "lot_execution_controller"],
      ["a target of another run", () => send(s, 0, null, { to_peer_id: far.peer_id }), "lot_execution_controller"],
      ["no signed run", () => send(s, 0, null, {}, {}), "lot_execution_controller"],
      ["another signed run", () => send(s, 0, null, {}, { run_ref: otherRun.run }), "lot_execution_controller"],
      ["the only active session", () => send(s, 0, null, { target_kind: "sole-active-fallback" }), "lot_execution_controller"],
      ["an assignment", () => send(s, 0, null, assignTo(s.worker)), "lot_execution_controller"],
      ["an epoch nobody opened", () => send(s, 0, 1), "lot_execution_not_started"],
    ]);

    expect(traces(s)).toEqual(before);
  });

  test("an open execution takes a send from its run, under its epoch, to its controller only", async () => {
    const s = await lotScenario();
    expect((await send(s, 0, null)).body.delivery).toBe("sent");
    const second = await attested(s.run, s.project, `/atomic/lot-second${seq}`);
    const otherRun = await mintRunCredential(broker, s.group, s.project);
    const before = traces(s);

    await expectRefused([
      ["a later epoch", () => send(s, 1, 2), "lot_execution_stale"],
      ["a second lead", () => send(s, 1, 1, { to_peer_id: second.peer_id }), "lot_execution_held"],
      ["an assignment to a worker", () => send(s, 1, 1, assignTo(s.worker)), "lot_execution_held"],
      ["another run", () => send(s, 1, 1, {}, { run_ref: otherRun.run }), "lot_execution_held"],
      ["a second start", () => send(s, 1, null), "lot_execution_held"],
    ]);
    expect(traces(s)).toEqual(before);

    const assigned = await send(s, 1, 1, assignTo(s.lead));
    expect(assigned.body.delivery, JSON.stringify(assigned.body)).toBe("sent");
    expect(cardsOf(s)[1]).toMatchObject({ status: "in_progress", queue: null });
    expect(sends(s)[1]).toMatchObject({ epoch: 1, mode: "assign" });
  });

  test("a send naming the epoch an execution left behind reaches nothing", async () => {
    const s = await lotScenario();
    expect((await send(s, 0, null)).body.delivery).toBe("sent");
    writeDb(`UPDATE roadmap_lot_executions SET epoch = 2 WHERE project_key = '${s.project}'`);
    const before = traces(s);

    await expectRefused([["the epoch left behind", () => send(s, 1, 1), "lot_execution_stale"]]);

    expect(traces(s)).toEqual(before);
  });

  test("an interruption found by a dispatch stays recorded after the refusal", async () => {
    const s = await lotScenario();
    expect((await send(s, 0, null)).body.delivery).toBe("sent");
    writeDb(
      `UPDATE approval_session_tokens SET revoked_at = '${new Date().toISOString()}' WHERE token_id = '${s.run.tokenId}'`
    );

    await expectRefused([["a send after the run ended", () => send(s, 1, 1), "lot_execution_interrupted"]]);

    expect(executions(s)).toMatchObject([{ state: "interrupted", interrupted_reason: "run-ended" }]);
    expect(sends(s)).toHaveLength(1);
  });

  test("a start whose message cannot be stored leaves no execution and no send", async () => {
    const s = await lotScenario();
    const before = traces(s);
    writeDb(
      `CREATE TRIGGER inject_fault BEFORE INSERT ON messages WHEN NEW.to_token = '${s.lead.instance_token}' BEGIN SELECT RAISE(ABORT, 'injected'); END`
    );
    try {
      await expectRefused([["a start under a failing message store", () => send(s, 0, null), "write-failed"]]);
    } finally {
      writeDb("DROP TRIGGER inject_fault");
    }
    expect(traces(s)).toEqual(before);
  });

  test("a closed lot takes no send", async () => {
    const s = await lotScenario();
    writeDb(`UPDATE roadmap_lots SET closed_at = '${new Date().toISOString()}' WHERE project_key = '${s.project}'`);
    const before = traces(s);

    await expectRefused([["a start on a closed lot", () => send(s, 0, null), "ineligible"]]);

    expect(traces(s)).toEqual(before);
  });

  describe("the execution routes and the send registry", () => {
    type RouteReply = Record<string, unknown> & { error?: string };

    const route = (name: string, body: Record<string, unknown>) =>
      post<RouteReply>(`${broker.url}/roadmap/lot/execution/${name}`, deckAuthored(body));
    const named = (s: LotScenario) => ({ project_key: s.project, lot_id: s.lot.lotId });
    const stateOf = async (s: LotScenario) => {
      const res = await route("state", named(s));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as unknown as RoadmapLotExecutionStateResponse;
    };
    const resumeBody = (s: LotScenario, to: Peer, run: RunCredential, epoch: number) => ({
      ...named(s),
      expected_epoch: epoch,
      to_peer_id: to.peer_id,
      group_id: s.group.id,
      group_secret_hash: s.group.hash,
      run_ref: run.run,
    });
    const close = (s: LotScenario, epoch: number, extra: Record<string, unknown> = {}) =>
      route("close", { ...named(s), expected_epoch: epoch, ...extra });
    const removeSend = (s: LotScenario, index: 0 | 1, epoch: number) =>
      route("remove-send", { ...named(s), expected_epoch: epoch, card_id: s.lot.ids[index] });
    const registry = (s: LotScenario) =>
      readDb<{ card_id: string; epoch: number; settled_as: string | null; claimed_at: string | null }>(
        "SELECT card_id, epoch, settled_as, claimed_at FROM roadmap_lot_dispatched WHERE project_key = ? ORDER BY rowid",
        s.project
      );
    const settlements = (s: LotScenario) => registry(s).map((r) => r.settled_as);
    const endRun = (run: RunCredential) =>
      writeDb(
        `UPDATE approval_session_tokens SET revoked_at = '${new Date().toISOString()}' WHERE token_id = '${run.tokenId}'`
      );
    const asPeer = (peer: Peer, id: string, fields: Record<string, unknown>) =>
      post<RouteReply>(`${broker.url}/roadmap/upsert`, {
        id,
        by: peer.peer_id,
        instance_token: peer.instance_token,
        ...fields,
      });
    const asOperator = (id: string, fields: Record<string, unknown>) =>
      post<RouteReply>(`${broker.url}/roadmap/upsert`, deckAuthored({ id, ...fields }));
    async function ok(pending: Promise<{ status: number; body: unknown }>): Promise<void> {
      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    /** A lot whose first card was sent to its lead under epoch 1. */
    async function started(): Promise<LotScenario> {
      const s = await lotScenario();
      const res = await send(s, 0, null);
      expect(res.body.delivery, JSON.stringify(res.body)).toBe("sent");
      return s;
    }

    /** The next window of the operator: a new run and the lead it attests. */
    async function nextWindow(s: LotScenario): Promise<{ run: RunCredential; lead: Peer }> {
      const run = await mintRunCredential(broker, s.group, s.project);
      return { run, lead: await attested(run, s.project, `/atomic/lot-next${++seq}`) };
    }

    test("state shows the execution without its run, the open sends and the ranked cards", async () => {
      const s = await started();

      const view = await stateOf(s);

      const [execution] = readDb<{ controller_ref: string }>(
        "SELECT controller_ref FROM roadmap_lot_executions WHERE project_key = ?",
        s.project
      );
      expect(JSON.stringify(view)).not.toContain(s.run.run);
      expect(JSON.stringify(view)).not.toContain(execution!.controller_ref);
      expect(view.execution).toEqual({
        epoch: 1,
        state: "running",
        group_id: s.group.id,
        controller_peer_id: s.lead.peer_id,
        started_at: expect.any(String),
        interrupted_at: null,
        interrupted_reason: null,
        own: true,
      });
      expect(view.closed_epoch).toBe(0);
      expect(view.open_sends).toEqual([
        {
          card_id: s.lot.ids[0]!,
          epoch: 1,
          mode: "wave",
          target_peer_id: s.lead.peer_id,
          sent_at: expect.any(String),
          claimed_at: null,
          own: true,
        },
      ]);
      const [ranked] = await reread(s, [s.lot.ids[1]!]);
      expect(view.queue).toEqual([
        { card_id: ranked!.id, queue: 2, content_rev: ranked!.content_rev!, dispatch_state_tag: ranked!.dispatch_state_tag! },
      ]);

      const theirs = await post<RoadmapLotExecutionStateResponse>(
        `${broker.url}/roadmap/lot/execution/state`,
        signedBy(otherOperator, named(s))
      );
      expect([theirs.body.execution?.own, theirs.body.open_sends[0]?.own]).toEqual([false, false]);
    });

    test("state records an interruption already due", async () => {
      const s = await started();
      endRun(s.run);

      expect((await stateOf(s)).execution).toMatchObject({ state: "interrupted", interrupted_reason: "run-ended" });
    });

    test("every execution route refuses a session that is not the operator", async () => {
      const s = await started();
      const before = traces(s);
      for (const name of ["state", "resume", "close", "remove-send"]) {
        const res = await post<RouteReply>(`${broker.url}/roadmap/lot/execution/${name}`, {
          ...resumeBody(s, s.lead, s.run, 1),
          card_id: s.lot.ids[0],
          confirm_open_sends: true,
          by: s.lead.peer_id,
          instance_token: s.lead.instance_token,
        });
        expect([name, res.status]).toEqual([name, 403]);
      }
      expect(traces(s)).toEqual(before);
    });

    test("resume hands an interrupted lot to the next window's lead, and sends nothing", async () => {
      const s = await started();
      endRun(s.run);
      const next = await nextWindow(s);
      const before = { cards: cardsOf(s), sends: sends(s), messages: messagesTo(next.lead.instance_token).length };

      const res = await route("resume", resumeBody(s, next.lead, next.run, 1));

      expect([res.status, res.body], JSON.stringify(res.body)).toEqual([200, { lot_id: s.lot.lotId, epoch: 2 }]);
      expect(executions(s)).toMatchObject([
        { epoch: 1, state: "closed" },
        {
          epoch: 2,
          state: "running",
          run_ref: next.run.run,
          controller_ref: deriveInstanceRef(next.lead.instance_token),
          controller_peer_id: next.lead.peer_id,
        },
      ]);
      expect({ cards: cardsOf(s), sends: sends(s), messages: messagesTo(next.lead.instance_token).length }).toEqual(before);
      expect((await stateOf(s)).open_sends.map((o) => o.epoch)).toEqual([1]);

      const nextScenario = { ...s, run: next.run, lead: next.lead };
      await expectRefused([["the epoch left behind", () => send(nextScenario, 1, 1), "lot_execution_stale"]]);
      expect((await send(nextScenario, 1, 2)).body.delivery).toBe("sent");
    });

    test("a refused resume changes nothing", async () => {
      const s = await started();
      const next = await nextWindow(s);
      const running = await route("resume", resumeBody(s, next.lead, next.run, 1));
      expect([running.status, running.body.error?.split(":")[0]]).toEqual([409, "lot_execution_held"]);
      endRun(s.run);
      await stateOf(s);
      const bare = await register(broker, "lot-bare", `/atomic/lot-bare${++seq}`, s.group);
      const before = traces(s);
      const good = resumeBody(s, next.lead, next.run, 1);
      const attempts: [string, Record<string, unknown>, number, string][] = [
        ["another epoch", { ...good, expected_epoch: 2 }, 409, "lot_execution_stale"],
        ["an unattested lead", { ...good, to_peer_id: bare.peer_id }, 403, "lot_execution_controller"],
        ["another signed run", { ...good, run_ref: s.run.run }, 403, "lot_execution_controller"],
        ["nobody", { ...good, to_peer_id: "nobody-here" }, 403, "lot_execution_controller"],
        ["the operator sentinel", { ...good, to_peer_id: "operator" }, 403, "lot_execution_controller"],
        ["no epoch", { ...good, expected_epoch: undefined }, 400, "expected_epoch"],
        ["a text epoch", { ...good, expected_epoch: "1" }, 400, "expected_epoch"],
        ["an unsafe epoch", { ...good, expected_epoch: 2 ** 60 }, 400, "expected_epoch"],
        ["a wrong group secret", { ...good, group_secret_hash: "0".repeat(64) }, 401, "group_secret_hash mismatch"],
        ["an unknown lot", { ...good, lot_id: "nowhere" }, 404, "unknown lot"],
      ];
      for (const [name, body, status, error] of attempts) {
        const res = await route("resume", body);
        expect([name, res.status, res.body.error?.includes(error)], res.body.error).toEqual([name, status, true]);
      }
      const theirs = await post<RouteReply>(`${broker.url}/roadmap/lot/execution/resume`, signedBy(otherOperator, good));
      expect([theirs.status, theirs.body.error?.split(":")[0]]).toEqual([409, "lot_execution_interrupted"]);
      expect(traces(s)).toEqual(before);
    });

    test("a resume that cannot open the next epoch leaves the interrupted one open", async () => {
      const s = await started();
      endRun(s.run);
      await stateOf(s);
      const next = await nextWindow(s);
      writeDb(
        `CREATE TRIGGER inject_fault BEFORE INSERT ON roadmap_lot_executions WHEN NEW.project_key = '${s.project}' BEGIN SELECT RAISE(ABORT, 'injected'); END`
      );
      try {
        expect((await route("resume", resumeBody(s, next.lead, next.run, 1))).status).toBe(500);
      } finally {
        writeDb("DROP TRIGGER inject_fault");
      }
      expect(executions(s)).toMatchObject([{ epoch: 1, state: "interrupted" }]);
    });

    test("close is refused while a send is open, and settles every one once confirmed", async () => {
      const s = await started();

      const refused = await close(s, 1);
      expect([refused.status, refused.body.error?.split(":")[0], refused.body.open_card_ids]).toEqual([
        409,
        "lot_execution_open_sends",
        [s.lot.ids[0]],
      ]);
      expect([executions(s)[0], settlements(s)]).toMatchObject([{ state: "running" }, [null]]);
      for (const [extra, epoch, status] of [
        [{ confirm_open_sends: "yes" }, 1, 400],
        [{ confirm_open_sends: true }, 2, 409],
      ] as const) {
        expect((await close(s, epoch, extra)).status).toBe(status);
      }
      const theirs = await post<RouteReply>(
        `${broker.url}/roadmap/lot/execution/close`,
        signedBy(otherOperator, { ...named(s), expected_epoch: 1, confirm_open_sends: true })
      );
      expect([theirs.status, theirs.body.error?.split(":")[0]]).toEqual([409, "lot_execution_held"]);
      expect([executions(s)[0], settlements(s)]).toMatchObject([{ state: "running" }, [null]]);

      const closed = await close(s, 1, { confirm_open_sends: true });

      expect([closed.status, closed.body]).toEqual([200, { lot_id: s.lot.lotId, epoch: 1, settled: [s.lot.ids[0]] }]);
      expect(executions(s)).toMatchObject([{ epoch: 1, state: "closed" }]);
      expect(settlements(s)).toEqual(["closed"]);
      const view = await stateOf(s);
      expect([view.execution, view.closed_epoch, view.open_sends]).toEqual([null, 1, []]);
      const replayed = await close(s, 1, { confirm_open_sends: true });
      expect([replayed.status, replayed.body.error?.split(":")[0]]).toEqual([409, "lot_execution_not_started"]);
    });

    test("close needs no confirmation once every sent card is closed", async () => {
      const s = await started();
      await ok(asPeer(s.lead, s.lot.ids[0]!, { status: "done" }));

      await ok(close(s, 1));
    });

    test("a start signed before a close reaches nothing after it, and one signed since starts", async () => {
      const s = await lotScenario();
      // Signed on the second card, which becomes the head wave once the first is sent.
      const items = await reread(s, [s.lot.ids[1]!]);
      const signedEarlier = intentFor(s, items, { lot: { lot_id: s.lot.lotId, epoch: null, closed_epoch: 0 } });
      expect((await send(s, 0, null)).body.delivery).toBe("sent");
      await ok(close(s, 1, { confirm_open_sends: true }));
      const before = traces(s);

      const res = await post<Reply>(
        `${broker.url}/roadmap/dispatch-atomic`,
        deckAuthored({ action: "execute", intent: signedEarlier, group_secret_hash: s.group.hash, run_ref: s.run.run })
      );

      expect([res.body.delivery, res.body.reason], JSON.stringify(res.body)).toEqual(["not-sent", "lot_execution_stale"]);
      expect(traces(s)).toEqual(before);
      const current = await send(s, 1, null, { lot: { lot_id: s.lot.lotId, epoch: null, closed_epoch: 1 } });
      expect(current.body.delivery, JSON.stringify(current.body)).toBe("sent");
      expect(executions(s)).toMatchObject([{ epoch: 1 }, { epoch: 2, state: "running" }]);
    });

    test("a closed card settles its send for good", async () => {
      for (const status of ["done", "archived"]) {
        const s = await started();
        await ok(asPeer(s.lead, s.lot.ids[0]!, { status }));
        expect([status, settlements(s)]).toEqual([status, ["card_closed"]]);
        await ok(asOperator(s.lot.ids[0]!, { status: "planned" }));
        expect([status, (await stateOf(s)).open_sends]).toEqual([status, []]);
      }
    });

    test("a card its running holder releases settles the send, a card never claimed keeps it", async () => {
      const s = await started();
      await ok(asOperator(s.lot.ids[0]!, { status: "idea" }));
      expect(settlements(s)).toEqual([null]);
      await ok(asPeer(s.lead, s.lot.ids[0]!, { status: "in_progress" }));
      expect([registry(s)[0]!.claimed_at === null, settlements(s)]).toEqual([false, [null]]);

      await ok(asPeer(s.lead, s.lot.ids[0]!, { release: true }));

      expect(settlements(s)).toEqual(["abandoned"]);
    });

    /** The write the broker's lock sweep makes on a card whose holder is gone. */
    const sweep = (id: string) =>
      writeDb(
        `UPDATE roadmap_items SET status = 'planned', locked = 0, locked_by = NULL, updated_by = 'lock-sweep' WHERE id = '${id}'`
      );

    // Runs the broker's own sweep, on a broker of its own: a short sweep period on
    // the shared one would record interruptions before the tests that look for them.
    test("a text write after the lock sweep leaves a lot's send open", async () => {
      const shared = { broker, brokerId };
      broker = await startBroker({ CLAUDE_PEERS_LOCK_SWEEP_SEC: "1" }, { trustedOperators: [FIXTURE_OPERATOR.publicKey] });
      try {
        brokerId = (await get<{ atomic_dispatch: AtomicDispatchCapability }>(`${broker.url}/health`)).body.atomic_dispatch.broker_id;
        for (const writer of ["bystander", "operator"]) {
          const s = await started();
          const id = s.lot.ids[0]!;
          await ok(asPeer(s.lead, id, { status: "in_progress" }));
          writeDb(`UPDATE roadmap_items SET updated_at = datetime('now', '-30 days') WHERE id = '${id}'`);
          const card = () => readDb("SELECT status, locked, updated_by FROM roadmap_items WHERE id = ?", id)[0];
          const swept = { status: "planned", locked: 0, updated_by: "lock-sweep" };
          for (const deadline = Date.now() + 8_000; !Bun.deepEquals(card(), swept) && Date.now() < deadline; ) {
            await Bun.sleep(50);
          }
          expect(card()).toEqual(swept);
          const bystander = await register(broker, "lot-bystander", `/atomic/lot-bystander${++seq}`, s.group);

          const edit = { description: "a text edit" };
          await ok(writer === "operator" ? asOperator(id, edit) : asPeer(bystander, id, edit));

          expect([writer, settlements(s)]).toEqual([writer, [null]]);
        }
      } finally {
        await stopBroker(broker);
        ({ broker, brokerId } = shared);
      }
    }, 30_000);

    test("a card taken back from work settles its send even when no lock held it", async () => {
      const s = await scenario();
      const [item] = await queuedWave(s, 1);
      expect((await dispatch(s, "execute", intentFor(s, [item!]))).body.delivery).toBe("sent");
      await ok(asOperator(item!.id, { status: "in_progress" }));
      expect(readDb("SELECT locked FROM roadmap_items WHERE id = ?", item!.id)).toEqual([{ locked: 0 }]);

      await ok(asOperator(item!.id, { status: "planned" }));

      expect(readDb("SELECT settled_as FROM roadmap_lot_dispatched WHERE card_id = ?", item!.id)).toEqual([
        { settled_as: "abandoned" },
      ]);
    });

    test("a lock dropped after the status had already moved still settles the send", async () => {
      const s = await scenario();
      const [item] = await queuedWave(s, 1);
      expect((await dispatch(s, "execute", intentFor(s, [item!]))).body.delivery).toBe("sent");
      await ok(asPeer(s.lead, item!.id, { status: "in_progress" }));
      const settled = () => readDb("SELECT settled_as FROM roadmap_lot_dispatched WHERE card_id = ?", item!.id);
      // A content write that leaves the lock in place, as a replica's push does, then its release.
      writeDb(`UPDATE roadmap_items SET status = 'planned' WHERE id = '${item!.id}'`);
      expect(settled()).toEqual([{ settled_as: null }]);

      writeDb(`UPDATE roadmap_items SET locked = 0, locked_by = NULL WHERE id = '${item!.id}'`);

      expect(settled()).toEqual([{ settled_as: "abandoned" }]);
    });

    test("a release by the lock sweep keeps a lot's send open, and settles a default queue one", async () => {
      const s = await started();
      await ok(asPeer(s.lead, s.lot.ids[0]!, { status: "in_progress" }));
      sweep(s.lot.ids[0]!);
      expect(settlements(s)).toEqual([null]);

      const plain = await scenario();
      const [item] = await queuedWave(plain, 1);
      expect((await dispatch(plain, "execute", intentFor(plain, [item!]))).body.delivery).toBe("sent");
      await ok(asPeer(plain.lead, item!.id, { status: "in_progress" }));
      sweep(item!.id);
      expect(readDb("SELECT settled_as FROM roadmap_lot_dispatched WHERE card_id = ?", item!.id)).toEqual([
        { settled_as: "abandoned" },
      ]);
    });

    test("on an interrupted lot only the operator's gesture on the card settles its send", async () => {
      const s = await started();
      await ok(asPeer(s.lead, s.lot.ids[0]!, { status: "in_progress" }));
      endRun(s.run);
      await stateOf(s);

      await ok(asOperator(s.lot.ids[0]!, { status: "planned", force: true }));
      expect(settlements(s)).toEqual([null]);
      const theirs = await post<RouteReply>(
        `${broker.url}/roadmap/lot/execution/remove-send`,
        signedBy(otherOperator, { ...named(s), expected_epoch: 1, card_id: s.lot.ids[0] })
      );
      expect([theirs.status, (await removeSend(s, 0, 2)).status, (await removeSend(s, 1, 1)).status]).toEqual([409, 409, 404]);
      expect(settlements(s)).toEqual([null]);

      const removed = await removeSend(s, 0, 1);

      expect([removed.status, removed.body]).toEqual([200, { lot_id: s.lot.lotId, card_id: s.lot.ids[0], settled: 1 }]);
      expect(settlements(s)).toEqual(["removed"]);
    });

    test("after a resume, the new controller releasing an earlier send leaves it open until it is sent again", async () => {
      const s = await started();
      await ok(asPeer(s.lead, s.lot.ids[0]!, { status: "in_progress" }));
      endRun(s.run);
      await stateOf(s);
      const next = await nextWindow(s);
      await ok(route("resume", resumeBody(s, next.lead, next.run, 1)));
      const resumed = { ...s, run: next.run, lead: next.lead };
      await ok(asOperator(s.lot.ids[0]!, { status: "planned", force: true }));
      await ok(asPeer(next.lead, s.lot.ids[0]!, { status: "in_progress" }));
      await ok(asPeer(next.lead, s.lot.ids[0]!, { release: true }));
      expect(settlements(s)).toEqual([null]);

      const resent = await send(resumed, 0, 2, assignTo(next.lead));

      expect(resent.body.delivery, JSON.stringify(resent.body)).toBe("sent");
      expect(registry(s).map((r) => [r.epoch, r.settled_as, r.claimed_at === null])).toEqual([
        [1, "resent", false],
        [2, null, false],
      ]);
    });

    test("a card an import replaces as done is not waited on", async () => {
      const s = await scenario();
      const [item] = await queuedWave(s, 1);
      expect((await dispatch(s, "execute", intentFor(s, [item!]))).body.delivery).toBe("sent");
      const [stored] = await reread(s, [item!.id]);
      await ok(
        post<RouteReply>(
          `${broker.url}/roadmap/import`,
          deckAuthored({ project_key: s.project, items: [{ ...stored!, status: "done" }] })
        )
      );

      const view = await post<RoadmapLotExecutionStateResponse>(
        `${broker.url}/roadmap/lot/execution/state`,
        deckAuthored({ project_key: s.project, lot_id: "default" })
      );

      expect(view.body.open_sends).toEqual([]);
    });

    test("a card with an open send keeps its lot, and may change it once the send is settled", async () => {
      for (const settle of ["done", "removed"]) {
        const s = await scenario();
        const [item] = await queuedWave(s, 1);
        const unranked = await card(s, { status: "planned" });
        const [listed] = await reread(s, [unranked.id]);
        expect((await dispatch(s, "execute", intentFor(s, [item!]))).body.delivery).toBe("sent");
        const assignment = intentFor(s, [listed!], { mode: "assign", target_kind: "assignee", to_peer_id: s.worker.peer_id });
        expect((await dispatch(s, "execute", assignment)).body.delivery).toBe("sent");
        const lot = await post<{ lot: { id: string } }>(
          `${broker.url}/roadmap/lot/create`,
          deckAuthored({ project_key: s.project, name: "elsewhere" })
        );
        const move = (id: string, from: string | null, to: string | null) =>
          post<RouteReply>(`${broker.url}/roadmap/lot/move`, deckAuthored({ project_key: s.project, ids: [id], from, to }));
        const places = () => readDb("SELECT id, lot_id FROM roadmap_items WHERE project_key = ? ORDER BY id", s.project);
        const before = places();

        // One send from the default queue lot, one of a card that has no lot at all.
        for (const [id, from] of [[item!.id, "default"], [unranked.id, null]] as const) {
          const refused = await move(id, from, lot.body.lot.id);
          expect([refused.status, refused.body.error?.split(":")[0]], refused.body.error).toEqual([409, "lot_open_send"]);
        }
        expect(places()).toEqual(before);
        await ok(move(unranked.id, null, "default"));

        for (const [id, from] of [[item!.id, "default"], [unranked.id, "default"]] as const) {
          if (settle === "done") await ok(asOperator(id, { status: "done" }));
          else {
            await ok(
              post<RouteReply>(
                `${broker.url}/roadmap/lot/execution/remove-send`,
                deckAuthored({ project_key: s.project, lot_id: "default", expected_epoch: 0, card_id: id })
              )
            );
          }
          await ok(move(id, from, lot.body.lot.id));
        }
      }
    });

    test("the operator removes a default queue send it made, and no other operator's", async () => {
      const s = await scenario();
      const [item] = await queuedWave(s, 1);
      expect((await dispatch(s, "execute", intentFor(s, [item!]))).body.delivery).toBe("sent");
      const body = { project_key: s.project, lot_id: "default", expected_epoch: 0, card_id: item!.id };
      const url = `${broker.url}/roadmap/lot/execution/remove-send`;

      const theirs = await post<RouteReply>(url, signedBy(otherOperator, body));
      expect(theirs.status).toBe(404);
      expect((await post<RouteReply>(url, deckAuthored({ ...body, expected_epoch: 1 }))).status).toBe(400);
      await ok(post<RouteReply>(url, deckAuthored(body)));
      const view = await post<RoadmapLotExecutionStateResponse>(
        `${broker.url}/roadmap/lot/execution/state`,
        deckAuthored({ project_key: s.project, lot_id: "default" })
      );
      expect([view.body.execution, view.body.open_sends]).toEqual([null, []]);
    });
  });

  test("a default queue send is recorded under the default lot and epoch 0", async () => {
    const s = await scenario();
    const items = await queuedWave(s);

    expect((await dispatch(s, "execute", intentFor(s, items))).body.delivery).toBe("sent");

    expect(
      readDb(
        "SELECT card_id, lot_id, epoch, target_peer_id FROM roadmap_lot_dispatched WHERE project_key = ? ORDER BY card_id",
        s.project
      )
    ).toEqual(items.map((i) => ({ card_id: i.id, lot_id: "default", epoch: 0, target_peer_id: s.lead.peer_id })));
  });

  test("a replica broker starts no lot", async () => {
    const replica = await startBroker(
      { CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:1", CLAUDE_PEERS_OFFLINE_REPLICA: "1" },
      { trustedOperators: [FIXTURE_OPERATOR.publicKey] }
    );
    try {
      const secret = `atomic-lot-replica-${replica.port}`;
      const group = { id: await groupId(secret), hash: await sha256Hex(secret) };
      const project = `github.com/vocsap/atomic-lot-replica-${replica.port}`;
      const run = await mintRunCredential(replica, group, project);
      const lead = await registerAttestedInstance(replica, run, "lot-host", "/atomic/replica-lead", {
        project_key: project,
      });
      expect(lead.status, JSON.stringify(lead.body)).toBe(200);
      const s: Scenario = { group, project, lead: lead.body, worker: lead.body };
      const created = await card(s, {}, replica);
      const db = openBrokerDb(replica.dbPath);
      db.run(
        "INSERT INTO roadmap_lots (project_key, id, name, created_by, created_at) VALUES (?, 'mirrored-lot', 'mirrored', 'deck', ?)",
        [project, new Date().toISOString()]
      );
      db.run("UPDATE roadmap_items SET lot_id = 'mirrored-lot', queue = 1 WHERE id = ?", [created.id]);
      db.close();
      const health = await get<{ atomic_dispatch: AtomicDispatchCapability }>(`${replica.url}/health`);
      const items = await reread(s, [created.id], replica);
      const intent = intentFor(
        s,
        items,
        { lot: { lot_id: "mirrored-lot", epoch: null, closed_epoch: 0 } },
        health.body.atomic_dispatch.broker_id
      );

      const res = await post<Reply>(
        `${replica.url}/roadmap/dispatch-atomic`,
        deckAuthored({ action: "execute", intent, group_secret_hash: group.hash, run_ref: run.run })
      );

      expect([res.body.delivery, res.body.reason], JSON.stringify(res.body)).toEqual([
        "not-sent",
        "lot_execution_replica",
      ]);
    } finally {
      await stopBroker(replica);
    }
  }, 30_000);
});
