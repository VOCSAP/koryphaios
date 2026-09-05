// The revision triggers are the whole coverage argument of the replication:
// they stamp `rev`/`content_rev` from every write path, present and future,
// instead of a helper each handler must remember to call. What must hold, and
// is asserted here on the LIVE schema:
//   - one write draws from the sequence exactly once per counter it stamps,
//     which is only true while nested triggers do not re-enter;
//   - a write that changes no content column (a queue move, a lock change)
//     bumps `rev` alone -- otherwise every reorder upstream would look like a
//     content divergence to every replica;
//   - a content write performed BY the replication itself does not mark the
//     card dirty, or the pull would immediately push what it just pulled.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

const PK = "github.com/vocsap/rev-repo";

type UpsertRes = { item: RoadmapItem };

interface RevRow {
  rev: number;
  content_rev: number;
  sync_dirty: number;
  lock_scope: string | null;
  lock_release_owner: string | null;
  status: string;
  locked: number;
}

function openDb(b: TestBroker): Database {
  const db = new Database(b.dbPath);
  db.run("PRAGMA busy_timeout = 3000");
  return db;
}

function readRow(db: Database, id: string): RevRow {
  return db
    .query(
      "SELECT rev, content_rev, sync_dirty, lock_scope, lock_release_owner, status, locked FROM roadmap_items WHERE id = ?"
    )
    .get(id) as RevRow;
}

function readSeq(db: Database): number {
  const row = db.query("SELECT value FROM roadmap_sync_meta WHERE key = 'rev_seq'").get() as {
    value: string;
  };
  return parseInt(row.value, 10);
}

test("one write draws exactly one revision per counter it stamps", async () => {
  const b = await startBroker();
  const db = openDb(b);
  try {
    const seqBefore = readSeq(db);
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-rev",
      title: "revision fixture",
    });
    expect(created.status).toBe(200);
    const id = created.body.item.id;

    const inserted = readRow(db, id);
    expect([
      "an INSERT draws one revision and stamps both counters with it",
      readSeq(db) - seqBefore,
      inserted.rev === inserted.content_rev,
    ]).toEqual(["an INSERT draws one revision and stamps both counters with it", 1, true]);
    expect(inserted.rev).toBeGreaterThan(0);

    // A content change: the rev trigger and the content trigger each draw
    // once. Two draws, and the two counters differ by exactly one -- more than
    // that would mean a trigger re-entered (recursive_triggers back on).
    const seqBeforeEdit = readSeq(db);
    const edited = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      id,
      by: "agent-rev",
      description: "a real content change",
    });
    expect(edited.status).toBe(200);
    const afterEdit = readRow(db, id);
    expect([
      "a content write draws exactly one revision per counter",
      readSeq(db) - seqBeforeEdit,
      Math.abs(afterEdit.rev - afterEdit.content_rev),
    ]).toEqual(["a content write draws exactly one revision per counter", 2, 1]);
    expect(afterEdit.rev).toBeGreaterThan(inserted.rev);
    expect(afterEdit.content_rev).toBeGreaterThan(inserted.content_rev);
    expect(afterEdit.sync_dirty).toBe(1);
  } finally {
    db.close();
    await stopBroker(b);
  }
}, 20_000);

test("a write that changes no content column bumps rev alone: queue move, lock change", async () => {
  const b = await startBroker();
  const db = openDb(b);
  try {
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-queue",
      title: "queue and lock fixture",
    });
    const id = created.body.item.id;
    // The insert itself marks nothing dirty to clear, but a later assertion
    // reads this flag, so start from a known value.
    db.run("UPDATE roadmap_items SET sync_dirty = 0 WHERE id = ?", [id]);
    const beforeQueue = readRow(db, id);
    const seqBeforeQueue = readSeq(db);

    const queued = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      id,
      by: "agent-queue",
      queue: 1,
    });
    expect(queued.status).toBe(200);
    const afterQueue = readRow(db, id);
    expect([
      "a queue move is not a content change: rev moves, content_rev and the dirty flag do not",
      readSeq(db) - seqBeforeQueue,
      afterQueue.content_rev,
      afterQueue.sync_dirty,
    ]).toEqual([
      "a queue move is not a content change: rev moves, content_rev and the dirty flag do not",
      1,
      beforeQueue.content_rev,
      0,
    ]);
    expect(afterQueue.rev).toBeGreaterThan(beforeQueue.rev);

    // A lock change with the status left alone: an owner dropping its own
    // lock. `status` stays 'in_progress', so no content column moves.
    const locked = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      id,
      by: "agent-queue",
      status: "in_progress",
    });
    expect(locked.body.item.locked).toBe(true);
    const beforeUnlock = readRow(db, id);
    const seqBeforeUnlock = readSeq(db);
    const unlocked = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      id,
      by: "agent-queue",
      locked: false,
    });
    expect(unlocked.body.item.locked).toBe(false);
    expect(unlocked.body.item.status).toBe("in_progress");
    const afterUnlock = readRow(db, id);
    expect([
      "a lock change is not a content change",
      readSeq(db) - seqBeforeUnlock,
      afterUnlock.content_rev,
    ]).toEqual(["a lock change is not a content change", 1, beforeUnlock.content_rev]);
    expect(afterUnlock.rev).toBeGreaterThan(beforeUnlock.rev);
  } finally {
    db.close();
    await stopBroker(b);
  }
}, 20_000);

test("a content write performed under the applying flag versions the card without marking it dirty", async () => {
  const b = await startBroker();
  const db = openDb(b);
  try {
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-applying",
      title: "applying fixture",
    });
    const id = created.body.item.id;
    db.run("UPDATE roadmap_items SET sync_dirty = 0 WHERE id = ?", [id]);
    const before = readRow(db, id);

    db.run("UPDATE roadmap_sync_meta SET value = '1' WHERE key = 'applying'");
    db.run("UPDATE roadmap_items SET description = ? WHERE id = ?", ["written by the sync", id]);
    db.run("UPDATE roadmap_sync_meta SET value = '0' WHERE key = 'applying'");

    const applied = readRow(db, id);
    expect([
      "a replication write versions the content but never marks it dirty",
      applied.content_rev > before.content_rev,
      applied.sync_dirty,
    ]).toEqual(["a replication write versions the content but never marks it dirty", true, 0]);

    // The same statement with the flag down is a local edit and does mark it.
    db.run("UPDATE roadmap_items SET description = ? WHERE id = ?", ["written by a local agent", id]);
    expect(readRow(db, id).sync_dirty).toBe(1);

    // A write that changes nothing versions nothing: the WHEN clause is what
    // keeps an upsert rewriting identical values from dirtying the card.
    db.run("UPDATE roadmap_items SET sync_dirty = 0 WHERE id = ?", [id]);
    const settled = readRow(db, id);
    db.run("UPDATE roadmap_items SET description = ? WHERE id = ?", ["written by a local agent", id]);
    const unchanged = readRow(db, id);
    expect([
      "rewriting identical content is not a content change",
      unchanged.content_rev,
      unchanged.sync_dirty,
    ]).toEqual(["rewriting identical content is not a content change", settled.content_rev, 0]);
  } finally {
    db.close();
    await stopBroker(b);
  }
}, 20_000);

test("lock scope is stamped on a replica only, and a local release records the owner it must send upstream", async () => {
  // Port 9 (discard) is refused instantly: the replication pass fails on every
  // tick, which is exactly the isolation this test wants -- the triggers are
  // the subject, the upstream is not.
  const replica = await startBroker({
    CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:9",
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "60000",
  });
  const plain = await startBroker();
  const replicaDb = openDb(replica);
  const plainDb = openDb(plain);
  try {
    for (const [broker, db, expectedClaimScope, expectedReleaseScope] of [
      [replica, replicaDb, "local", "release_pending"],
      [plain, plainDb, null, null],
    ] as const) {
      const created = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
        project_key: PK,
        by: "agent-scope",
        title: "lock scope fixture",
        status: "in_progress",
      });
      expect(created.body.item.locked).toBe(true);
      const id = created.body.item.id;
      const claimed = readRow(db, id);
      expect([broker.url, "scope after a local claim", claimed.lock_scope]).toEqual([
        broker.url,
        "scope after a local claim",
        expectedClaimScope,
      ]);

      const released = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
        project_key: PK,
        id,
        by: "agent-scope",
        locked: false,
      });
      expect(released.body.item.locked).toBe(false);
      const afterRelease = readRow(db, id);
      expect([broker.url, "scope after a local release", afterRelease.lock_scope]).toEqual([
        broker.url,
        "scope after a local release",
        expectedReleaseScope,
      ]);
      // locked_by is already NULL by the time the release trigger fires, so
      // the owner the upstream release must name is captured by the trigger
      // itself -- without it the pending release could never be addressed.
      expect([broker.url, "owner recorded for the pending release", afterRelease.lock_release_owner]).toEqual([
        broker.url,
        "owner recorded for the pending release",
        expectedReleaseScope === null ? null : "agent-scope",
      ]);
    }
  } finally {
    replicaDb.close();
    plainDb.close();
    await stopBroker(replica);
    await stopBroker(plain);
  }
}, 30_000);
