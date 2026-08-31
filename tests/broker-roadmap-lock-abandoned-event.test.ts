// Card 4441e883, mecanisme A: `releaseStaleLocks()` used to release a stale
// work-lock and revert the card to 'planned' IN SILENCE. This file proves the
// event that makes an abandonment VISIBLE, in the operator inbox (sentinel
// 'operator', table `messages`, no new table) -- and proves its ROUTING
// refuses to fall back to the 'default' group rather than leak the event
// where anyone holding the shared BROKER_TOKEN could read it.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, groupId, sha256Hex, type TestBroker } from "./_helper.ts";
import { OPERATOR_INSTANCE_TOKEN, DECK_INSTANCE_TOKEN, type RoadmapItem } from "../shared/types.ts";

const PK = "github.com/vocsap/lock-abandoned-event-repo";

type UpsertRes = { item: RoadmapItem };
type InboxRes = { messages: { id: number; from_peer_id: string; text: string; sent_at: string }[] } | { error: string };

async function pollUntil<T>(
  budgetMs: number,
  intervalMs: number,
  check: () => Promise<{ done: boolean; value: T }>
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const { done, value } = await check();
    last = value;
    if (done) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`pollUntil timed out after ${budgetMs}ms; last observed: ${JSON.stringify(last)}`);
}

test("releaseStaleLocks: a lock swept for TTL in a secret group deposits exactly one operator-inbox event, routed by the card's own locked_group", async () => {
  const g = { id: await groupId("lock-abandon-A"), hash: await sha256Hex("lock-abandon-A") };
  const b: TestBroker = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-abandon-a", git_root: null, tty: null,
      summary: "", host: "h-lock-abandon-a", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: g.id, group_secret_hash: g.hash,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "TTL-abandoned card", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);
    expect(held.body.item.locked_group).toBe(g.id);

    // TTL alone (no owner-gone condition needed): the peer stays 'active',
    // only `updated_at`/`locked_at` age past LOCK_TTL_SEC.
    const db = new Database(b.dbPath);
    db.run("UPDATE roadmap_items SET locked_at = datetime('now', '-60 seconds'), updated_at = datetime('now', '-60 seconds') WHERE id = ?", [
      held.body.item.id,
    ]);
    db.close();

    const after = await pollUntil(12_000, 300, async () => {
      const listed = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, { project_key: PK });
      const found = listed.body.items.find((i) => i.id === held.body.item.id)!;
      return { done: found.locked === false, value: found };
    });
    expect(after.status).toBe("planned");
    expect(after.locked_by_token).toBe(null);

    const drain = await post<InboxRes>(`${b.url}/operator-inbox`, {
      group_id: g.id, group_secret_hash: g.hash,
    });
    expect(drain.status).toBe(200);
    const messages = (drain.body as { messages: { from_peer_id: string; text: string }[] }).messages;
    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain(held.body.item.id);
    expect(messages[0]!.text).toContain("TTL-abandoned card");
    expect(messages[0]!.text).toContain(reg.body.peer_id);
    expect(messages[0]!.text).toContain("abandoned");
    expect(messages[0]!.text).toContain("planned");

    // One sweep, one event -- a second drain is empty, and no duplicate ever
    // landed even though the sweep tick keeps firing every second.
    const drainAgain = await post<InboxRes>(`${b.url}/operator-inbox`, {
      group_id: g.id, group_secret_hash: g.hash,
    });
    expect((drainAgain.body as { messages: unknown[] }).messages.length).toBe(0);
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("releaseStaleLocks: a card reclaimed and abandoned twice produces TWO events, never one view re-read", async () => {
  const g = { id: await groupId("lock-abandon-twice"), hash: await sha256Hex("lock-abandon-twice") };
  const b: TestBroker = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-abandon-twice", git_root: null, tty: null,
      summary: "", host: "h-lock-abandon-twice", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: g.id, group_secret_hash: g.hash,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "reclaimed twice", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    const db = new Database(b.dbPath);
    db.run("UPDATE roadmap_items SET locked_at = datetime('now', '-60 seconds'), updated_at = datetime('now', '-60 seconds') WHERE id = ?", [
      held.body.item.id,
    ]);
    db.close();

    await pollUntil(12_000, 300, async () => {
      const listed = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, { project_key: PK });
      const found = listed.body.items.find((i) => i.id === held.body.item.id)!;
      return { done: found.locked === false, value: found };
    });

    // Reclaim, then age it out a second time.
    const reheld = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      id: held.body.item.id, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      status: "in_progress",
    });
    expect(reheld.body.item.locked).toBe(true);

    const db2 = new Database(b.dbPath);
    db2.run("UPDATE roadmap_items SET locked_at = datetime('now', '-60 seconds'), updated_at = datetime('now', '-60 seconds') WHERE id = ?", [
      held.body.item.id,
    ]);
    db2.close();

    await pollUntil(12_000, 300, async () => {
      const listed = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, { project_key: PK });
      const found = listed.body.items.find((i) => i.id === held.body.item.id)!;
      return { done: found.locked === false, value: found };
    });

    const drain = await post<InboxRes>(`${b.url}/operator-inbox`, {
      group_id: g.id, group_secret_hash: g.hash,
    });
    const messages = (drain.body as { messages: { text: string }[] }).messages;
    expect(messages.length).toBe(2);
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("releaseStaleLocks: a lock in the secret-less 'default' group drops the event instead of routing it there", async () => {
  const b: TestBroker = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-abandon-default", git_root: null, tty: null,
      summary: "", host: "h-lock-abandon-default", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "default-group card, no event expected", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);
    expect(held.body.item.locked_group).toBe("default");

    const db = new Database(b.dbPath);
    db.run("UPDATE roadmap_items SET locked_at = datetime('now', '-60 seconds'), updated_at = datetime('now', '-60 seconds') WHERE id = ?", [
      held.body.item.id,
    ]);
    db.close();

    await pollUntil(12_000, 300, async () => {
      const listed = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, { project_key: PK });
      const found = listed.body.items.find((i) => i.id === held.body.item.id)!;
      return { done: found.locked === false, value: found };
    });

    // The operator inbox itself refuses a drain for a TOFU-exempt group
    // (groupMayCarryOperatorInbox's other half) -- this asserts the SWEEP
    // never routed a message there in the first place, straight off the
    // messages table, not through the (deliberately refused) drain route.
    const db2 = new Database(b.dbPath, { readonly: true });
    try {
      const rows = db2.query(
        "SELECT COUNT(*) AS n FROM messages WHERE from_token = ? AND to_token = ?"
      ).get(DECK_INSTANCE_TOKEN, OPERATOR_INSTANCE_TOKEN) as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      db2.close();
    }
  } finally {
    await stopBroker(b);
  }
}, 20_000);

// Card 4441e883, Trou C (team-lead review): the three tests above only ever
// exercise clause 1 (TTL). C1 proves clause 2 (owner-gone) reaches the SAME
// emitLockAbandonedEvent call (broker.ts's release() helper is shared by all
// three clauses, but nothing pinned that the OTHER two clauses actually go
// through it). LOCK_TTL_SEC is set far outside this test's window so a TTL
// release cannot fire first and make the assertion pass for the wrong
// clause -- only owner-gone (LOCK_GRACE_SEC, short) can release this row.
test("releaseStaleLocks: a lock swept by clause 2 (owner-gone, not TTL) deposits the same operator-inbox event", async () => {
  const g = { id: await groupId("lock-abandon-owner-gone"), hash: await sha256Hex("lock-abandon-owner-gone") };
  const b: TestBroker = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    // locked_group is ONLY ever stamped from a PROVEN author's own real
    // `peers` row (resolveRoadmapAuthor's instance_token branch -- an
    // unproven "ghost-peer" claim, as used by the sibling owner-gone tests
    // in tests/broker-roadmap-lock.test.ts, would leave locked_group NULL,
    // which routes through the OTHER guard C2 exists to pin, not this one).
    // A real group therefore needs a REAL registered peer -- forced dormant
    // and stale directly via sqlite, same technique as that file's
    // "owner-gone sweep (site c)" tests, so it never heartbeats again and
    // clause 2 (not clause 1: LOCK_TTL_SEC is 3600s here) is what releases it.
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-abandon-owner-gone", git_root: null, tty: null,
      summary: "", host: "h-lock-abandon-owner-gone", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: g.id, group_secret_hash: g.hash,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "owner-gone-abandoned card", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);
    expect(held.body.item.locked_group).toBe(g.id);

    const db0 = new Database(b.dbPath);
    db0.run(
      "UPDATE peers SET status = 'dormant', last_seen = datetime('now', '-3600 seconds') WHERE instance_token = ?",
      [reg.body.instance_token]
    );
    db0.close();

    const after = await pollUntil(12_000, 300, async () => {
      const listed = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, { project_key: PK });
      const found = listed.body.items.find((i) => i.id === held.body.item.id)!;
      return { done: found.locked === false, value: found };
    });
    expect(after.status).toBe("planned");
    expect(after.locked_by_token).toBe(null);

    const drain = await post<InboxRes>(`${b.url}/operator-inbox`, {
      group_id: g.id, group_secret_hash: g.hash,
    });
    expect(drain.status).toBe(200);
    const messages = (drain.body as { messages: { text: string }[] }).messages;
    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain(held.body.item.id);
    expect(messages[0]!.text).toContain(reg.body.peer_id);
    expect(messages[0]!.text).toContain("abandoned");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

// C2: emitLockAbandonedEvent's FIRST guard (broker.ts:1109-1114) -- a
// migration-era row (`locked_group IS NULL`) must be logged and DROPPED,
// never routed. This is a DIFFERENT guard than the "default group" test
// above (that one is groupMayCarryOperatorInbox, the SECOND guard, which
// only ever runs once the first has already let a non-null group through).
// Same technique as tests/broker-roadmap-lock.test.ts's "legacy row
// (locked_group NULL, pre-migration)" test: force the column back to NULL
// directly via sqlite, since no HTTP route lets a caller set it.
test("releaseStaleLocks: emitLockAbandonedEvent's first guard drops a migration-era row (locked_group NULL) instead of routing it anywhere", async () => {
  const g = { id: await groupId("lock-abandon-null-group"), hash: await sha256Hex("lock-abandon-null-group") };
  const b: TestBroker = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-abandon-null-group", git_root: null, tty: null,
      summary: "", host: "h-lock-abandon-null-group", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: g.id, group_secret_hash: g.hash,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "migration-era card, locked_group forced NULL", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);
    expect(held.body.item.locked_group).toBe(g.id);

    const db = new Database(b.dbPath);
    db.run(
      "UPDATE roadmap_items SET locked_group = NULL, locked_at = datetime('now', '-60 seconds'), updated_at = datetime('now', '-60 seconds') WHERE id = ?",
      [held.body.item.id]
    );
    db.close();

    const after = await pollUntil(12_000, 300, async () => {
      const listed = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, { project_key: PK });
      const found = listed.body.items.find((i) => i.id === held.body.item.id)!;
      return { done: found.locked === false, value: found };
    });
    // The row still releases normally -- the guard only refuses to ROUTE the
    // event, it never blocks the sweep's own release.
    expect(after.status).toBe("planned");

    // Real proof of absence, off the messages table itself (the drain route
    // would work fine here since g.id/g.hash are a real, TOFU-eligible
    // group -- the point is that nothing was ever inserted to drain).
    const db2 = new Database(b.dbPath, { readonly: true });
    try {
      const rows = db2.query(
        "SELECT COUNT(*) AS n FROM messages WHERE from_token = ? AND to_token = ?"
      ).get(DECK_INSTANCE_TOKEN, OPERATOR_INSTANCE_TOKEN) as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      db2.close();
    }
    const drain = await post<InboxRes>(`${b.url}/operator-inbox`, {
      group_id: g.id, group_secret_hash: g.hash,
    });
    expect(drain.status).toBe(200);
    expect((drain.body as { messages: unknown[] }).messages.length).toBe(0);
  } finally {
    await stopBroker(b);
  }
}, 20_000);
