// PLAN C12: operator inbox. Agents send_message to the reserved 'operator'
// peer; the Deck drains POST /operator-inbox per group (TOFU-authenticated,
// marks delivered). The sentinel row must never surface as a normal peer.

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

async function sendToOperator(fromToken: string, text: string) {
  return post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
    from_token: fromToken,
    to_peer_id: "operator",
    text,
  });
}

async function drain(group: { id: string; hash: string | null }) {
  return post<{ messages: { id: number; from_peer_id: string; text: string; sent_at: string }[] } | { error: string }>(
    `${broker.url}/operator-inbox`,
    { group_id: group.id, group_secret_hash: group.hash }
  );
}

test("send_message to 'operator' lands in the group inbox; drain marks delivered", async () => {
  const g = { id: await groupId("op-A"), hash: await sha256Hex("op-A") };
  const a = await register("hOp1", "/opA1", g);

  const sent = await sendToOperator(a.body.instance_token, "review is done, merge?");
  expect(sent.status).toBe(200);
  expect((sent.body as { ok: boolean }).ok).toBe(true);

  const first = await drain(g);
  expect(first.status).toBe(200);
  const messages = (first.body as { messages: { from_peer_id: string; text: string }[] }).messages;
  expect(messages.length).toBe(1);
  expect(messages[0]!.from_peer_id).toBe(a.body.peer_id);
  expect(messages[0]!.text).toBe("review is done, merge?");

  // Drained once -> delivered; a second drain is empty.
  const second = await drain(g);
  expect((second.body as { messages: unknown[] }).messages.length).toBe(0);

  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const rows = db.query(
      "SELECT delivered FROM messages WHERE to_token = '__operator__' AND group_id = ?"
    ).all(g.id) as { delivered: number }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.delivered).toBe(1);
  } finally {
    db.close();
  }
});

test("the inbox is group-isolated and rejects a wrong secret with 401", async () => {
  const gA = { id: await groupId("op-isoA"), hash: await sha256Hex("op-isoA") };
  const gB = { id: await groupId("op-isoB"), hash: await sha256Hex("op-isoB") };
  const a = await register("hOpI1", "/opI1", gA);
  await register("hOpI2", "/opI2", gB);

  await sendToOperator(a.body.instance_token, "only group A sees this");

  const drainB = await drain(gB);
  expect((drainB.body as { messages: unknown[] }).messages.length).toBe(0);

  const spoofed = await drain({ id: gA.id, hash: await sha256Hex("WRONG") });
  expect(spoofed.status).toBe(401);

  // The real drain still returns it (the spoofed one must not have consumed it).
  const drainA = await drain(gA);
  expect((drainA.body as { messages: { text: string }[] }).messages.length).toBe(1);
});

test("the reserved operator row never surfaces in list_peers or group-stats", async () => {
  const g = { id: await groupId("op-hidden"), hash: await sha256Hex("op-hidden") };
  const a = await register("hOpH1", "/opH1", g);

  const peers = await post<{ peer_id: string }[]>(`${broker.url}/list-peers`, {
    scope: "machine",
    instance_token: a.body.instance_token,
    cwd: "/opH1",
    git_root: null,
  });
  expect(peers.body.some((p) => p.peer_id === "operator")).toBe(false);

  const stats = await get<{ groups: { group_id: string }[] }>(`${broker.url}/group-stats`);
  // The sentinel sits dormant in 'default'; no test here registered a default
  // peer, so 'default' must be absent from the active stats.
  expect(stats.body.groups.find((row) => row.group_id === "default")).toBeUndefined();
});

test("set_id refuses the reserved name 'operator'", async () => {
  const g = { id: await groupId("op-rename"), hash: await sha256Hex("op-rename") };
  const a = await register("hOpR1", "/opR1", g);
  const res = await post<{ error?: string }>(`${broker.url}/set-id`, {
    instance_token: a.body.instance_token,
    new_peer_id: "operator",
  });
  expect(res.status).toBe(400);
});
