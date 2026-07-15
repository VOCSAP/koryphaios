import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, get, livePid, groupId, sha256Hex, type TestBroker } from "./_helper.ts";

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

async function announce(group: { id: string; hash: string | null }, text: string, exclude_peer_id?: string) {
  return post<{ sent: number } | { error: string }>(`${broker.url}/announce`, {
    group_id: group.id,
    group_secret_hash: group.hash,
    text,
    exclude_peer_id: exclude_peer_id ?? null,
  });
}

function readDb<T = unknown>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    return db.query(sql).all(...(params as any[])) as T[];
  } finally {
    db.close();
  }
}

test("/announce inserts one delivered=0 message per active peer from 'deck'", async () => {
  const g = { id: await groupId("ann-A"), hash: await sha256Hex("ann-A") };
  const a = await register("hA1", "/annA1", g);
  const b = await register("hA2", "/annA2", g);

  const res = await announce(g, "team standup in 5");
  expect(res.status).toBe(200);
  expect((res.body as { sent: number }).sent).toBe(2);

  const rows = readDb<{ from_token: string; to_token: string; text: string; delivered: number }>(
    "SELECT from_token, to_token, text, delivered FROM messages WHERE group_id = ? ORDER BY id",
    g.id
  );
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.from_token === "__deck__")).toBe(true);
  expect(rows.every((r) => r.delivered === 0)).toBe(true);
  expect(rows.every((r) => r.text === "team standup in 5")).toBe(true);
  const targets = new Set(rows.map((r) => r.to_token));
  expect(targets.has(a.body.instance_token)).toBe(true);
  expect(targets.has(b.body.instance_token)).toBe(true);
});

test("/announce honours exclude_peer_id (joiner does not receive its own join)", async () => {
  const g = { id: await groupId("ann-excl"), hash: await sha256Hex("ann-excl") };
  const older = await register("hX1", "/annX1", g);
  const joiner = await register("hX2", "/annX2", g);

  const res = await announce(g, `New peer: ${joiner.body.peer_id}`, joiner.body.peer_id);
  expect((res.body as { sent: number }).sent).toBe(1);

  const rows = readDb<{ to_token: string }>(
    "SELECT to_token FROM messages WHERE group_id = ? AND from_token = '__deck__'",
    g.id
  );
  expect(rows.length).toBe(1);
  expect(rows[0]!.to_token).toBe(older.body.instance_token);
});

test("/announce is group-isolated: a peer in another group never receives it", async () => {
  const gA = { id: await groupId("ann-isoA"), hash: await sha256Hex("ann-isoA") };
  const gB = { id: await groupId("ann-isoB"), hash: await sha256Hex("ann-isoB") };
  const a = await register("hI1", "/annI1", gA);
  const b = await register("hI2", "/annI2", gB);

  await announce(gA, "only for group A");

  const toB = readDb<{ id: number }>(
    "SELECT id FROM messages WHERE to_token = ?",
    b.body.instance_token
  );
  expect(toB.length).toBe(0);
  const toA = readDb<{ id: number }>(
    "SELECT id FROM messages WHERE to_token = ?",
    a.body.instance_token
  );
  expect(toA.length).toBe(1);
});

test("/announce to a group with no active peers returns sent:0", async () => {
  const g = { id: await groupId("ann-empty"), hash: await sha256Hex("ann-empty") };
  const res = await announce(g, "anybody?");
  expect(res.status).toBe(200);
  expect((res.body as { sent: number }).sent).toBe(0);
});

test("/announce rejects a wrong group secret with 401", async () => {
  const g = { id: await groupId("ann-secret"), hash: await sha256Hex("ann-secret") };
  await register("hS1", "/annS1", g); // establishes the group with its real hash

  const res = await announce({ id: g.id, hash: await sha256Hex("WRONG") }, "spoofed");
  expect(res.status).toBe(401);
});

test("deck announcements are pollable and never auto-delivered", async () => {
  const g = { id: await groupId("ann-poll"), hash: await sha256Hex("ann-poll") };
  const a = await register("hP1", "/annP1", g);

  await announce(g, "ping all");

  const poll = await post<{ messages: { from_token: string; text: string }[] }>(
    `${broker.url}/poll-messages`,
    { instance_token: a.body.instance_token }
  );
  expect(poll.body.messages.length).toBe(1);
  expect(poll.body.messages[0]!.from_token).toBe("__deck__");
  expect(poll.body.messages[0]!.text).toBe("ping all");
});

test("the reserved deck row never surfaces in group-stats", async () => {
  const stats = await get<{ groups: { group_id: string; active_peers: number }[] }>(
    `${broker.url}/group-stats`
  );
  // The deck row is in group 'default' and dormant -- if it leaked it would show
  // as an active default peer even though no real default peer registered here.
  const def = stats.body.groups.find((row) => row.group_id === "default");
  // No test registered a 'default' peer, so 'default' must be absent (deck excluded).
  expect(def).toBeUndefined();
});

// ----- targeted announce (PLAN C10): the team-lead notification path -----

test("to_peer_id delivers to ONE active peer only; unknown target -> 404", async () => {
  const lead = await register("t-host", "/lead");
  const other = await register("t-host", "/other");

  const targeted = await post<{ sent: number }>(`${broker.url}/announce`, {
    group_id: "default",
    group_secret_hash: null,
    text: "next item: fix login",
    to_peer_id: lead.body.peer_id,
  });
  expect(targeted.status).toBe(200);
  expect(targeted.body.sent).toBe(1);

  const leadPoll = await post<{ messages: { from_token: string; text: string }[] }>(
    `${broker.url}/poll-messages`,
    { instance_token: lead.body.instance_token }
  );
  expect(leadPoll.body.messages.some((m) => m.text === "next item: fix login")).toBe(true);
  expect(
    leadPoll.body.messages.find((m) => m.text === "next item: fix login")!.from_token
  ).toBe("__deck__");

  const otherPoll = await post<{ messages: { text: string }[] }>(`${broker.url}/poll-messages`, {
    instance_token: other.body.instance_token,
  });
  expect(otherPoll.body.messages.some((m) => m.text === "next item: fix login")).toBe(false);

  const missing = await post(`${broker.url}/announce`, {
    group_id: "default",
    group_secret_hash: null,
    text: "hello",
    to_peer_id: "ghost-peer",
  });
  expect(missing.status).toBe(404);
});
