// Card 399aa31a: releaseStaleLocks' owner-gone clause (broker.ts) used to
// anchor its LOCK_GRACE_SEC window on `roadmap_items.locked_at` (when the
// lock was TAKEN), not on any timestamp of the owner's disconnection. Any
// lock held longer than LOCK_GRACE_SEC -- the ordinary case -- got ZERO
// effective grace: the instant its owner's peers row left 'active', the very
// next sweep tick stripped it. The fix reanchors on `peers.last_seen` (the
// owner's last real heartbeat/activity), via the same peer_id/project_key
// join the clause already used. This file proves the one cell that did not
// exist before the fix -- a lock held well past LOCK_GRACE_SEC, whose owner
// then goes non-active with a RECENT last_seen, must survive -- and that the
// clause still eventually releases once last_seen itself ages past grace.
// broker-roadmap-lock.test.ts already covers: an ACTIVE owner keeps its lock
// indefinitely ("owner-gone sweep releases after grace, but an active owner
// keeps the lock"), a lock with no peer row at all releases immediately (the
// ghost-peer cells throughout that file), and park immunity to this clause
// ("park immunity: clauses 1/2 ... do not release a parked card") -- none of
// that is re-proven here, only pointed at.

import { test, expect } from "bun:test";
import { startBroker, stopBroker, post, livePid } from "./_helper.ts";
import { Database } from "bun:sqlite";
import type { RoadmapItem } from "../shared/types.ts";

const PK = "github.com/vocsap/lock-grace-repo";

type UpsertRes = { item: RoadmapItem };

// Same house pattern as broker-roadmap-lock.test.ts: poll the real condition
// instead of a fixed sleep, so the wait costs only the wall time actually
// used and a generous budget is free.
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
  throw new Error(
    `pollUntil timed out after ${budgetMs}ms; last observed: ${JSON.stringify(last)}`
  );
}

test("owner-gone sweep: a lock held past LOCK_GRACE_SEC survives a RECENT disconnect, then releases once last_seen itself ages past grace", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "30",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-grace", git_root: null, tty: null,
      summary: "", host: "h-lock-grace", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "held past grace, owner just disconnected", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    // Ghost card with no peers row at all -- releases on the very first
    // sweep tick under both the old and the new clause, so it drives the
    // poll below without needing its own timing assertions.
    const ghost = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: "ghost-peer", title: "abandoned, poll driver", status: "in_progress",
    });
    expect(ghost.body.item.locked).toBe(true);

    const db = new Database(b.dbPath);
    // Simulate "held longer than the grace window" (the ordinary case): push
    // locked_at well into the past. Under the pre-fix clause (anchored on
    // locked_at) this alone is enough to make the item eligible for release
    // the instant no active peer is found -- this is exactly the defect.
    db.run("UPDATE roadmap_items SET locked_at = datetime('now', '-60 seconds') WHERE id = ?", [
      held.body.item.id,
    ]);
    // Simulate the owner going non-active (crash/sleep/network drop) with a
    // FRESH last_seen -- it just disconnected. sweepInactivePeers never
    // rewrites last_seen, only status, so this is exactly what a real
    // disconnect leaves behind.
    db.run("UPDATE peers SET status = 'dormant', last_seen = datetime('now') WHERE instance_token = ?", [
      reg.body.instance_token,
    ]);
    db.close();

    // While the ghost card falls (proving the sweep is actually running),
    // the held card must stay locked every single tick -- its owner
    // disconnected less than LOCK_GRACE_SEC ago.
    const ghostAfter = await pollUntil(12_000, 300, async () => {
      const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      const heldItem = after.body.items.find((i) => i.id === held.body.item.id)!;
      const ghostItem = after.body.items.find((i) => i.id === ghost.body.item.id)!;
      expect(heldItem.locked).toBe(true);
      return { done: ghostItem.locked === false, value: ghostItem };
    });
    expect(ghostAfter.status).toBe("planned");

    // Now age the disconnect itself past the grace window and confirm the
    // clause still releases -- the fix changes the ANCHOR, not the outcome.
    const db2 = new Database(b.dbPath);
    db2.run("UPDATE peers SET last_seen = datetime('now', '-60 seconds') WHERE instance_token = ?", [
      reg.body.instance_token,
    ]);
    db2.close();

    const heldAfter = await pollUntil(12_000, 300, async () => {
      const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      const heldItem = after.body.items.find((i) => i.id === held.body.item.id)!;
      return { done: heldItem.locked === false, value: heldItem };
    });
    expect(heldAfter.status).toBe("planned");
    expect(heldAfter.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("owner-gone sweep: a STILL-ACTIVE owner keeps the lock even once its last_seen alone has aged past grace", async () => {
  // The clause is `p.status = 'active' OR datetime(p.last_seen) >= cutoff` --
  // the `status = 'active'` disjunct is not redundant just because last_seen
  // is usually fresher than that in production (ACTIVE_STALE_SEC=120 <
  // LOCK_GRACE_SEC=600 there). Proven here with GRACE=3600s/ACTIVE_STALE=3600s
  // so nothing ages the row to dormant on its own, and last_seen is pushed
  // stale by hand while status stays 'active': removing the disjunct makes
  // this cell fail (locked=false); with it, the still-active owner keeps its
  // lock regardless of how old last_seen is.
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "3",
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "3600",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-grace-active", git_root: null, tty: null,
      summary: "", host: "h-lock-grace-active", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "active owner, stale last_seen alone", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    const db = new Database(b.dbPath);
    // status stays 'active' -- only last_seen is aged past LOCK_GRACE_SEC.
    db.run("UPDATE peers SET last_seen = datetime('now', '-60 seconds') WHERE instance_token = ?", [
      reg.body.instance_token,
    ]);
    db.close();

    // Give the sweep several ticks to have run against the stale last_seen,
    // then assert the lock is still held -- the `status = 'active'` disjunct
    // must be the thing keeping it, since last_seen alone would fail.
    await Bun.sleep(3_500);
    const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
      project_key: PK,
    });
    const heldItem = after.body.items.find((i) => i.id === held.body.item.id)!;
    expect(heldItem.locked).toBe(true);
    expect(heldItem.status).toBe("in_progress");
  } finally {
    await stopBroker(b);
  }
}, 20_000);
