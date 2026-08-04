// PLAN K2: agent work-lock on roadmap items. Covers the implicit lock on
// in_progress writes (non-'deck' authors), the 409 guard against another
// peer's status writes, the deck/force bypasses, the release on leaving
// in_progress, and the stale-lock sweep (TTL + owner gone).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import { Database } from "bun:sqlite";
import type { RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/lock-repo";

type UpsertRes = { item: RoadmapItem };

async function add(fields: Record<string, unknown>): Promise<RoadmapItem> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    ...fields,
  });
  expect(res.status).toBe(200);
  return res.body.item;
}

async function patch(
  id: string,
  by: string,
  fields: Record<string, unknown>
): Promise<{ status: number; item?: RoadmapItem; error?: string }> {
  const res = await post<UpsertRes & { error?: string }>(`${broker.url}/roadmap/upsert`, {
    id,
    by,
    ...fields,
  });
  return { status: res.status, item: res.body.item, error: res.body.error };
}

// ----- implicit lock / unlock -----

test("agent write of status=in_progress locks the item under its peer_id", async () => {
  const item = await add({ title: "lock me" });
  expect(item.locked).toBe(false);
  expect(item.locked_by).toBeNull();
  expect(item.locked_at).toBeNull();

  const r = await patch(item.id, "agent-a", { status: "in_progress" });
  expect(r.status).toBe(200);
  expect(r.item!.locked).toBe(true);
  expect(r.item!.locked_by).toBe("agent-a");
  expect(r.item!.locked_at).toBeTruthy();
});

test("deck write of status=in_progress does NOT lock (submitted, not started)", async () => {
  const item = await add({ title: "deck launches" });
  const r = await patch(item.id, "deck", { status: "in_progress" });
  expect(r.status).toBe(200);
  expect(r.item!.locked).toBe(false);
  // The agent then claims the deck-launched item with a same-status write.
  const claim = await patch(item.id, "agent-b", { status: "in_progress" });
  expect(claim.status).toBe(200);
  expect(claim.item!.locked).toBe(true);
  expect(claim.item!.locked_by).toBe("agent-b");
});

test("leaving in_progress releases the lock (done / planned / archive)", async () => {
  const item = await add({ title: "finish me", status: "in_progress" });
  expect(item.locked).toBe(true); // born in_progress from an agent => locked

  const done = await patch(item.id, "test-peer", { status: "done" });
  expect(done.item!.locked).toBe(false);
  expect(done.item!.locked_by).toBeNull();
  expect(done.item!.locked_at).toBeNull();

  const again = await add({ title: "archive me", status: "in_progress" });
  const arch = await post<UpsertRes>(`${broker.url}/roadmap/archive`, {
    id: again.id,
    by: "test-peer",
  });
  expect(arch.status).toBe(200);
  expect(arch.body.item.locked).toBe(false);
});

test("explicit locked:false releases while staying in_progress; true re-claims", async () => {
  const item = await add({ title: "explicit", status: "in_progress" });
  expect(item.locked).toBe(true);

  const release = await patch(item.id, "test-peer", { locked: false });
  expect(release.item!.status).toBe("in_progress");
  expect(release.item!.locked).toBe(false);

  const reclaim = await patch(item.id, "other-peer", { locked: true });
  expect(reclaim.item!.locked).toBe(true);
  expect(reclaim.item!.locked_by).toBe("other-peer");
});

test("same-owner re-claim keeps the original locked_at", async () => {
  const item = await add({ title: "stable timestamp", status: "in_progress" });
  const first = item.locked_at;
  const r = await patch(item.id, "test-peer", { status: "in_progress" });
  expect(r.item!.locked_at).toBe(first!);
});

// ----- guard -----

test("another peer's status write on a locked item is refused with 409", async () => {
  const item = await add({ title: "guarded", status: "in_progress" });

  const steal = await patch(item.id, "intruder", { status: "done" });
  expect(steal.status).toBe(409);
  expect(steal.error).toContain("locked by 'test-peer'");

  const claim = await patch(item.id, "intruder", { status: "in_progress" });
  expect(claim.status).toBe(409);

  const archive = await post<{ error?: string }>(`${broker.url}/roadmap/archive`, {
    id: item.id,
    by: "intruder",
  });
  expect(archive.status).toBe(409);

  // Non-status writes stay open (context enrichment by anyone).
  const enrich = await patch(item.id, "intruder", { context: "useful pointer" });
  expect(enrich.status).toBe(200);
  expect(enrich.item!.locked_by).toBe("test-peer");
});

test("owner, deck and force:true bypass the guard", async () => {
  const a = await add({ title: "owner moves", status: "in_progress" });
  const owner = await patch(a.id, "test-peer", { status: "done" });
  expect(owner.status).toBe(200);

  const b = await add({ title: "deck moves", status: "in_progress" });
  const deck = await patch(b.id, "deck", { status: "planned" });
  expect(deck.status).toBe(200);
  expect(deck.item!.locked).toBe(false);

  // Card 39c40571 layer 1: `force` is a claim of certainty, so it is now only
  // honoured for a caller that PROVED who it is. An anonymous body could
  // otherwise take any locked item by adding a single field.
  const c = await add({ title: "forced", status: "in_progress" });
  const anonymous = await patch(c.id, "intruder", { status: "planned", force: true });
  expect(anonymous.status).toBe(409);

  const reg = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd: "/tmp/forcer", git_root: null, tty: null,
    summary: "", host: "h-force", client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "default", group_secret_hash: null,
  });
  expect(reg.status).toBe(200);
  const forced = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: c.id,
    by: reg.body.peer_id,
    instance_token: reg.body.instance_token,
    status: "planned",
    force: true,
  });
  expect(forced.status).toBe(200);
});

test("locked rejects non-boolean values", async () => {
  const item = await add({ title: "typed" });
  const bad = await patch(item.id, "test-peer", { locked: "yes" });
  expect(bad.status).toBe(400);
});

// ----- stale-lock sweep -----

test("TTL sweep releases a lock with no recent write and drops status to planned", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "2",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "3600",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const res = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-ttl",
      title: "stale",
      status: "in_progress",
    });
    expect(res.body.item.locked).toBe(true);

    // Backdate updated_at past the 2s TTL, then wait for a sweep tick.
    const db = new Database(b.dbPath);
    db.run("UPDATE roadmap_items SET updated_at = datetime('now', '-60 seconds') WHERE id = ?", [
      res.body.item.id,
    ]);
    db.close();
    await Bun.sleep(2_500);

    const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
      project_key: PK,
    });
    const item = after.body.items.find((i) => i.id === res.body.item.id)!;
    expect(item.locked).toBe(false);
    expect(item.locked_by).toBeNull();
    expect(item.status).toBe("planned");
    expect(item.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("owner-gone sweep releases after grace, but an active owner keeps the lock", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    // A live registered peer holds one lock; a ghost peer_id holds another.
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock", git_root: null, tty: null,
      summary: "", host: "h-lock", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      // Card 39c40571: writing as a REGISTERED peer now requires its token.
      // ("ghost-peer" below names no peer row, so it stays token-free.)
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "held", status: "in_progress",
    });
    const ghost = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: "ghost-peer", title: "abandoned", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);
    expect(ghost.body.item.locked).toBe(true);

    // Wait past the 2s grace + a sweep tick, heartbeating the live owner.
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(1_200);
      await post(`${b.url}/heartbeat`, { instance_token: reg.body.instance_token });
    }

    const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
      project_key: PK,
    });
    const heldAfter = after.body.items.find((i) => i.id === held.body.item.id)!;
    const ghostAfter = after.body.items.find((i) => i.id === ghost.body.item.id)!;
    expect(heldAfter.locked).toBe(true);
    expect(heldAfter.status).toBe("in_progress");
    expect(ghostAfter.locked).toBe(false);
    expect(ghostAfter.status).toBe("planned");
    expect(ghostAfter.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 20_000);
