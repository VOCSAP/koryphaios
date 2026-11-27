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

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, post, type TestBroker, openBrokerDb } from "./_helper.ts";
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
  const db = openBrokerDb(b.dbPath);
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
      "a queue move marks the card dirty to be pushed, but never versions its content",
      readSeq(db) - seqBeforeQueue,
      afterQueue.content_rev,
      afterQueue.sync_dirty,
    ]).toEqual([
      "a queue move marks the card dirty to be pushed, but never versions its content",
      1,
      beforeQueue.content_rev,
      1,
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

test("the content date is outside the content versioning: a date-only write bumps rev, never content_rev or the dirty flag", async () => {
  const b = await startBroker();
  const db = openDb(b);
  try {
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, { project_key: PK, by: "agent-date", title: "date versioning fixture" });
    const id = created.body.item.id;
    db.run("UPDATE roadmap_items SET sync_dirty = 0 WHERE id = ?", [id]);
    const before = readRow(db, id);
    const seqBefore = readSeq(db);

    db.run("UPDATE roadmap_items SET content_updated_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", id]);
    const after = readRow(db, id);
    expect([
      "a date-only write draws one revision (the pull cursor) and versions no content",
      readSeq(db) - seqBefore,
      after.content_rev === before.content_rev,
      after.sync_dirty,
    ]).toEqual(["a date-only write draws one revision (the pull cursor) and versions no content", 1, true, 0]);
    expect(after.rev).toBeGreaterThan(before.rev);
  } finally {
    db.close();
    await stopBroker(b);
  }
}, 20_000);

describe("lot revisions", () => {
  let b: TestBroker;
  let db: Database;
  beforeAll(async () => {
    b = await startBroker();
    db = openDb(b);
  });
  afterAll(async () => {
    db.close();
    await stopBroker(b);
  });

  const writeCard = (verb: string, id: string, project: string, lot: string | null, queue: number | null) =>
    db.run(
      `${verb} INTO roadmap_items (id, project_key, kind, title, created_at, updated_at, lot_id, queue)
       VALUES (?, ?, 'feature', 'lot fixture', 'x', 'x', ?, ?)`,
      [id, project, lot, queue]
    );
  const lotRevs = (project: string): Record<string, number> =>
    Object.fromEntries(
      (db.query("SELECT lot_id, rev FROM roadmap_queue_state WHERE project_key = ?").all(project) as {
        lot_id: string;
        rev: number;
      }[]).map((row) => [row.lot_id, row.rev])
    );

  test("a transfer at the same rank advances both lots and the card, never its content", () => {
    writeCard("INSERT", "lot-transfer", "p/transfer", "lot-a", 1);
    const before = readRow(db, "lot-transfer");
    expect(lotRevs("p/transfer")).toEqual({ "lot-a": 1 });

    db.run("UPDATE roadmap_items SET lot_id = 'lot-b' WHERE id = 'lot-transfer'");

    expect(lotRevs("p/transfer")).toEqual({ "lot-a": 2, "lot-b": 1 });
    const after = readRow(db, "lot-transfer");
    expect([after.rev > before.rev, after.content_rev], "the pull cursor sees the transfer").toEqual([
      true,
      before.content_rev,
    ]);
    db.run("UPDATE roadmap_items SET queue = 2 WHERE id = 'lot-transfer'");
    expect(lotRevs("p/transfer"), "a rank move inside a lot counts once").toEqual({ "lot-a": 2, "lot-b": 2 });
  });

  test("an unranked card changing lot, leaving every lot or being deleted advances the lots it touches", () => {
    writeCard("INSERT", "lot-unranked", "p/unranked", "lot-a", null);
    db.run("UPDATE roadmap_items SET lot_id = 'lot-b' WHERE id = 'lot-unranked'");
    expect(lotRevs("p/unranked")).toEqual({ "lot-a": 2, "lot-b": 1 });
    db.run("UPDATE roadmap_items SET lot_id = NULL WHERE id = 'lot-unranked'");
    expect(lotRevs("p/unranked")).toEqual({ "lot-a": 2, "lot-b": 2 });
    db.run("UPDATE roadmap_items SET lot_id = 'lot-a' WHERE id = 'lot-unranked'");
    db.run("DELETE FROM roadmap_items WHERE id = 'lot-unranked'");
    expect(lotRevs("p/unranked")).toEqual({ "lot-a": 4, "lot-b": 2 });
  });

  test("replacing an unranked member advances the lot it leaves", () => {
    writeCard("INSERT", "lot-replaced", "p/replace", "lot-a", null);
    writeCard("INSERT OR REPLACE", "lot-replaced", "p/replace", "lot-b", null);
    expect(lotRevs("p/replace")).toEqual({ "lot-a": 2, "lot-b": 1 });
  });

  test("a transfer to another project at the same rank advances the old project and the new one", () => {
    writeCard("INSERT", "lot-moved-project", "p/from", "lot-a", 1);
    writeCard("INSERT OR REPLACE", "lot-moved-project", "p/to", "lot-a", 1);
    expect([lotRevs("p/from"), lotRevs("p/to")]).toEqual([{ "lot-a": 2 }, { "lot-a": 1 }]);
  });

  test("the database refuses a ranked card outside every lot, whichever statement writes it", () => {
    const refusal = "a queued roadmap card must belong to a lot";
    writeCard("INSERT", "lot-guard-held", "p/guard", "lot-a", 1);
    writeCard("INSERT", "lot-guard-free", "p/guard", null, null);

    expect(() => writeCard("INSERT", "lot-guard-born", "p/guard", null, 1)).toThrow(refusal);
    expect(() => writeCard("INSERT OR REPLACE", "lot-guard-held", "p/guard", null, 2)).toThrow(refusal);
    expect(() => db.run("UPDATE roadmap_items SET lot_id = NULL WHERE id = 'lot-guard-held'")).toThrow(refusal);
    expect(() => db.run("UPDATE roadmap_items SET queue = 3 WHERE id = 'lot-guard-free'")).toThrow(refusal);
    expect(
      db.query("SELECT id, lot_id, queue FROM roadmap_items WHERE project_key = 'p/guard' ORDER BY id").all()
    ).toEqual([
      { id: "lot-guard-free", lot_id: null, queue: null },
      { id: "lot-guard-held", lot_id: "lot-a", queue: 1 },
    ]);
  });
});

test("a database written before lots restarts with its queue in the default lot, ranks and revisions untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-prelot-"));
  const dbPath = join(dir, "peers.db");
  const boot = () => startBroker({ CLAUDE_PEERS_DB: dbPath });
  const untouched = "SELECT title, queue, rev, content_rev, sync_dirty FROM roadmap_items ORDER BY title";
  const snapshot = () => {
    const db = openBrokerDb(dbPath);
    try {
      return {
        cards: db.query(untouched).all(),
        lots: db.query("SELECT title, lot_id FROM roadmap_items ORDER BY title").all(),
        state: db.query("SELECT * FROM roadmap_queue_state").all(),
        upstream: db.query("SELECT * FROM roadmap_queue_upstream").all(),
      };
    } finally {
      db.close();
    }
  };
  try {
    const first = await boot();
    for (const [title, queue] of [["a queued", 1], ["b unqueued", null]] as const) {
      const created = await post(`${first.url}/roadmap/upsert`, { project_key: PK, by: "agent-old", title, queue });
      expect(created.status).toBe(200);
    }
    await stopBroker(first);

    const db = openBrokerDb(dbPath);
    for (const { name } of db
      .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'roadmap_items'")
      .all() as { name: string }[]) {
      db.run(`DROP TRIGGER ${name}`);
    }
    db.run("DROP INDEX idx_roadmap_items_lot");
    db.run("ALTER TABLE roadmap_items DROP COLUMN lot_id");
    db.run("DROP TABLE roadmap_lots");
    db.run("DROP TABLE roadmap_queue_state");
    db.run("CREATE TABLE roadmap_queue_state (project_key TEXT PRIMARY KEY, rev INTEGER NOT NULL)");
    db.run("INSERT INTO roadmap_queue_state (project_key, rev) VALUES (?, 41)", [PK]);
    db.run("DROP TABLE roadmap_queue_upstream");
    db.run("CREATE TABLE roadmap_queue_upstream (project_key TEXT PRIMARY KEY, rev INTEGER NOT NULL)");
    db.run("INSERT INTO roadmap_queue_upstream (project_key, rev) VALUES (?, 17)", [PK]);
    const before = db.query(untouched).all();
    db.close();

    const migrated = {
      cards: before,
      lots: [
        { title: "a queued", lot_id: "default" },
        { title: "b unqueued", lot_id: null },
      ],
      state: [{ project_key: PK, lot_id: "default", rev: 41 }],
      upstream: [{ project_key: PK, lot_id: "default", rev: 17 }],
    };
    for (const run of ["first restart", "second restart"]) {
      await stopBroker(await boot());
      expect(snapshot(), run).toEqual(migrated);
    }
    const older = openBrokerDb(dbPath);
    try {
      older.run("INSERT INTO roadmap_queue_upstream (project_key, rev) VALUES ('github.com/vocsap/other', 2)");
      expect(
        older.query("SELECT lot_id FROM roadmap_queue_upstream WHERE project_key = 'github.com/vocsap/other'").get(),
        "an older broker's insert names no lot"
      ).toEqual({ lot_id: "default" });
    } finally {
      older.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
