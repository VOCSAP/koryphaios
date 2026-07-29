import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, groupId, sha256Hex, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => { broker = await startBroker(); });
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string, group: { id: string; hash: string } | null = null) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: 1,
    project_key: null,
    group_id: group?.id ?? "default",
    group_secret_hash: group?.hash ?? null,
  });
}

async function send(from_token: string, to_peer_id: string, text: string) {
  return post<{ ok: boolean }>(`${broker.url}/send-message`, { from_token, to_peer_id, text });
}

function readDb<T = unknown>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    return db.query(sql).all(...(params as any[])) as T[];
  } finally {
    db.close();
  }
}

test("ack heuristique: sender acquitte les messages anterieurs qui lui sont adresses", async () => {
  const x = await register("hack1x", "/ack1x");
  const y = await register("hack1y", "/ack1y");

  // X envoie 3 messages a Y
  await send(x.body.instance_token, y.body.peer_id, "x->y #1");
  await send(x.body.instance_token, y.body.peer_id, "x->y #2");
  await send(x.body.instance_token, y.body.peer_id, "x->y #3");

  // Avant le reply de Y : les 3 sont delivered=0
  const beforeAck = readDb<{ delivered: number }>(
    "SELECT delivered FROM messages WHERE to_token = ? ORDER BY id",
    y.body.instance_token
  );
  expect(beforeAck.length).toBe(3);
  expect(beforeAck.every((r) => r.delivered === 0)).toBe(true);

  // Y repond a X -- doit acquitter les 3 messages anterieurs adresses a Y
  await send(y.body.instance_token, x.body.peer_id, "y->x #1 (ack implicite)");

  const afterAck = readDb<{ id: number; delivered: number; text: string }>(
    "SELECT id, delivered, text FROM messages WHERE to_token = ? ORDER BY id",
    y.body.instance_token
  );
  expect(afterAck.length).toBe(3);
  expect(afterAck.every((r) => r.delivered === 1)).toBe(true);

  // Le nouveau message Y->X reste a delivered=0 (X n'a pas encore repondu)
  const reverse = readDb<{ delivered: number }>(
    "SELECT delivered FROM messages WHERE to_token = ?",
    x.body.instance_token
  );
  expect(reverse.length).toBe(1);
  expect(reverse[0]!.delivered).toBe(0);
});

test("isolation par group: l'ack ne touche pas les messages d'un autre group", async () => {
  const gA = await groupId("ack-grpA");
  const hA = await sha256Hex("ack-grpA");
  const gB = await groupId("ack-grpB");
  const hB = await sha256Hex("ack-grpB");

  // X et Y dans groupe A
  const xA = await register("hack2x", "/ack2xA", { id: gA, hash: hA });
  const yA = await register("hack2y", "/ack2yA", { id: gA, hash: hA });
  // Y existe aussi dans groupe B sous un autre cwd ; X aussi
  const xB = await register("hack2x", "/ack2xB", { id: gB, hash: hB });
  const yB = await register("hack2y", "/ack2yB", { id: gB, hash: hB });

  // Trafic dans groupe A: X -> Y
  await send(xA.body.instance_token, yA.body.peer_id, "A: x->y");
  // Trafic dans groupe B: X -> Y (peer Y different, instance_token different)
  await send(xB.body.instance_token, yB.body.peer_id, "B: x->y");

  // Y dans groupe A repond -- doit acquitter uniquement le message du groupe A
  await send(yA.body.instance_token, xA.body.peer_id, "A: y->x reply");

  const msgsA = readDb<{ delivered: number; text: string }>(
    "SELECT delivered, text FROM messages WHERE to_token = ?",
    yA.body.instance_token
  );
  expect(msgsA.length).toBe(1);
  expect(msgsA[0]!.delivered).toBe(1);

  const msgsB = readDb<{ delivered: number; text: string }>(
    "SELECT delivered, text FROM messages WHERE to_token = ?",
    yB.body.instance_token
  );
  expect(msgsB.length).toBe(1);
  // Le peer Y dans groupe B n'a PAS repondu, son message reste pending
  expect(msgsB[0]!.delivered).toBe(0);
});

test("ack ne touche pas les messages posterieurs au reply", async () => {
  const x = await register("hack3x", "/ack3x");
  const y = await register("hack3y", "/ack3y");

  // X envoie 1 message a Y
  await send(x.body.instance_token, y.body.peer_id, "before");
  // Y repond a X -- doit acquitter "before"
  await send(y.body.instance_token, x.body.peer_id, "y->x");
  // X envoie un autre message a Y APRES le reply
  await send(x.body.instance_token, y.body.peer_id, "after");

  // Ordered by id, not sent_at: sent_at is millisecond-resolution and two
  // sends on a fast local broker can tie within the same millisecond, which
  // makes ORDER BY sent_at non-deterministic on ties. id is the messages
  // table's AUTOINCREMENT primary key, assigned strictly in insertion order.
  const msgs = readDb<{ id: number; delivered: number; text: string; sent_at: string }>(
    "SELECT id, delivered, text, sent_at FROM messages WHERE to_token = ? ORDER BY id",
    y.body.instance_token
  );
  expect(msgs.length).toBe(2);
  expect(msgs[0]!.text).toBe("before");
  expect(msgs[0]!.delivered).toBe(1);
  expect(msgs[1]!.text).toBe("after");
  expect(msgs[1]!.delivered).toBe(0);
});

// Inserts directly with a FORCED identical sent_at, instead of relying on real
// sends racing into the same millisecond (broker card 82e3d293, follow-up to
// cf4af14d/commit 53526ca): this is deterministic on every run rather than
// depending on how fast the local broker happens to be.
function insertMessageAtSameMs(
  from_token: string,
  to_token: string,
  text: string,
  sentAtIso: string
) {
  const db = new Database(broker.dbPath);
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 3000");
    const group_id = db
      .query("SELECT group_id FROM peers WHERE instance_token = ?")
      .get(from_token) as { group_id: string };
    db.run(
      `INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [from_token, to_token, group_id.group_id, text, sentAtIso]
    );
  } finally {
    db.close();
  }
}

test("/poll-messages garde l'ordre d'insertion quand sent_at est identique (meme milliseconde)", async () => {
  const x = await register("hack4x", "/ack4x");
  const y = await register("hack4y", "/ack4y");

  // 5 messages avec exactement le meme sent_at -- un ORDER BY sent_at seul
  // serait non-deterministe sur ce lot ; id (AUTOINCREMENT, assigne dans
  // l'ordre d'insertion) doit departager.
  const tiedSentAt = new Date().toISOString();
  for (let i = 0; i < 5; i++) {
    insertMessageAtSameMs(x.body.instance_token, y.body.instance_token, `TIE#${i}`, tiedSentAt);
  }

  const poll = await post<{ messages: { text: string }[] }>(`${broker.url}/poll-messages`, {
    instance_token: y.body.instance_token,
  });
  expect(poll.status).toBe(200);
  expect(poll.body.messages.map((m) => m.text)).toEqual([
    "TIE#0",
    "TIE#1",
    "TIE#2",
    "TIE#3",
    "TIE#4",
  ]);
});
