// Exercises migrateAll's pure logic against in-memory sqlite fixtures, never a
// real broker database.
// The schema is derived from broker.ts's actual CREATE/ALTER statements rather
// than hand-listed, so a newly added project_key-bearing table is covered
// automatically.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProjectKeyTables,
  findCollisions,
  countByCasing,
  migrateAll,
  parseArgs,
  openForMode
} from "../scripts/migrate-project-key-case.ts";

/**
 * Replays broker.ts's own schema-defining statements (CREATE TABLE / ALTER
 * TABLE, in source order) against an in-memory database, so this fixture stays
 * in sync as tables are added, removed, or renamed.
 * Does not mirror the FTS5 virtual table, its sync triggers, or index
 * definitions -- none of them carry or gate on project_key, so their absence
 * doesn't change what this file asserts.
 */
function loadRealSchemaFromBroker(db: Database): void {
  const src = readFileSync(join(import.meta.dir, "..", "broker.ts"), "utf-8");

  // Enables foreign_keys so an invalid group_id fails here the same way it
  // fails against the real broker.
  db.run("PRAGMA foreign_keys = ON");

  // Every CREATE TABLE in broker.ts lives in a `db.run(\`...\`)`
  // template-literal call, one statement per call, with no nested
  // backticks -- a non-greedy capture up to the next backtick is exact.
  const createTableRe = /db\.run\(`\s*(CREATE TABLE IF NOT EXISTS[\s\S]*?)`\)/g;
  let m: RegExpExecArray | null;
  let tableCount = 0;
  while ((m = createTableRe.exec(src))) {
    db.run(m[1]!);
    tableCount++;
  }
  // A `tableCount === 0` check alone only catches TOTAL failure. A reformat
  // that makes the regex miss SOME statements (e.g. a CREATE TABLE moved out
  // of the `db.run(\`...\`)` shape this regex expects) would silently pass
  // fewer tables through, and the fixed 5-table pin further down would just
  // as silently stop noticing a 6th table gaining project_key later -- two
  // derives needed to open that hole, which is why a mismatch here must
  // throw rather than warn. Cross-check against a DUMBER, harder-to-break
  // count: the literal substring "CREATE TABLE IF NOT EXISTS" (MEASURED,
  // `grep -c 'CREATE TABLE IF NOT EXISTS' broker.ts` -> 14, distinct from
  // `grep -c 'CREATE TABLE'` -> 15, whose 15th hit is inside a comment, not
  // a statement -- the IF-NOT-EXISTS-qualified substring count is exact).
  const naiveCreateTableCount = (src.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;
  if (tableCount !== naiveCreateTableCount) {
    throw new Error(
      `loadRealSchemaFromBroker extracted ${tableCount} CREATE TABLE statement(s) via regex, but broker.ts ` +
        `contains ${naiveCreateTableCount} literal "CREATE TABLE IF NOT EXISTS" occurrences -- the extraction ` +
        "regex missed some (broker.ts's db.run(`...`) wrapper shape likely changed); fix the regex here, " +
        "do not fall back to hand-listing tables"
    );
  }

  // Replays ALTER TABLE statements separately from CREATE TABLE, since columns
  // added later live in their own statement and would otherwise be invisible
  // here.
  // Swallows duplicate-column errors, mirroring broker.ts's own
  // idempotent-migration handling rather than special-casing which ALTERs are
  // now redundant.
  const alterTableRe = /db\.run\("(ALTER TABLE [^"]*)"\)/g;
  while ((m = alterTableRe.exec(src))) {
    try {
      db.run(m[1]!);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) throw e;
    }
  }

  // Seeds the 'default' group before any peers row, since peers.group_id's
  // foreign key requires it to exist first.
  db.run(
    `INSERT OR IGNORE INTO groups (group_id, secret_hash, name, created_at) VALUES ('default', NULL, 'default', datetime('now'))`
  );
}

function seededDb(): Database {
  const db = new Database(":memory:");
  loadRealSchemaFromBroker(db);
  return db;
}

const NOW = `datetime('now')`;

function insertRoadmapItem(db: Database, id: string, projectKey: string): void {
  db.run(
    `INSERT INTO roadmap_items (id, project_key, kind, title, created_at, updated_at) VALUES (?, ?, 'idea', 'test item', ${NOW}, ${NOW})`,
    [id, projectKey]
  );
}

function insertGraphDraft(db: Database, id: string, projectKey: string): void {
  db.run(
    `INSERT INTO graph_drafts (id, project_key, title, prompt, created_at) VALUES (?, ?, 'test draft', 'test prompt', ${NOW})`,
    [id, projectKey]
  );
}

function insertPeer(db: Database, instanceToken: string, projectKey: string | null): void {
  db.run(
    `INSERT INTO peers (instance_token, peer_id, group_id, pid, cwd, registered_at, last_seen, project_key)
     VALUES (?, ?, 'default', 1, '/tmp', ${NOW}, ${NOW}, ?)`,
    [instanceToken, instanceToken, projectKey]
  );
}

function insertApprovalSessionToken(db: Database, tokenId: string, projectKey: string): void {
  db.run(
    `INSERT INTO approval_session_tokens (token_id, operator_id, public_key, session_ref, created_at, expires_at, project_key)
     VALUES (?, 'op1', 'pub1', 'sess1', ${NOW}, ${NOW}, ?)`,
    [tokenId, projectKey]
  );
}

function insertPendingApproval(db: Database, id: string, projectKey: string): void {
  db.run(
    `INSERT INTO pending_approvals (id, operator_id, kind, title, question, created_at, notif_expires_at, project_key)
     VALUES (?, 'op1', 'ask_operator', 'title', 'question?', ${NOW}, ${NOW}, ?)`,
    [id, projectKey]
  );
}

function insertDispatchRequest(db: Database, id: string, projectKey: string): void {
  db.run(
    `INSERT INTO dispatch_requests (id, project_key, from_peer, status, created_at) VALUES (?, ?, 'lead-1', 'pending', ${NOW})`,
    [id, projectKey]
  );
}

test("discovery finds every real project_key-bearing table in broker.ts's schema, none else", () => {
  const db = seededDb();
  // Deriving the table list from source means this assertion changes on its own
  // if broker.ts adds, removes, or renames a project_key column.
  // dispatch_requests belongs in this list: its project_key is copied at
  // add-time from the proven peers row, and a peer migrated without migrating
  // this table would leave old mixed-case requests invisible to the Deck.
  expect(discoverProjectKeyTables(db)).toEqual([
    "approval_session_tokens",
    "dispatch_requests",
    "graph_drafts",
    "peers",
    "pending_approvals",
    "roadmap_items"
  ]);
});

test("a table added AFTER this module is written is still discovered -- proves no hardcoded list", () => {
  const db = seededDb();
  db.run(`CREATE TABLE future_widget_table (id TEXT PRIMARY KEY, project_key TEXT NOT NULL)`);
  const tables = discoverProjectKeyTables(db);
  expect(tables).toContain("future_widget_table");
  // 6 real tables in broker.ts's schema (see the assertion above) + this one.
  // Card bf76d37f took it from 5+1 to 6+1, and the fact that THIS test is what
  // reported the change is the guarantee it exists to give.
  expect(tables.length).toBe(7);
});

test("a column named in a different case (PROJECT_KEY) is still discovered -- PRAGMA table_info preserves declared casing, matching must not", () => {
  const db = seededDb();
  db.run(`CREATE TABLE t (id TEXT PRIMARY KEY, PROJECT_KEY TEXT NOT NULL)`);
  expect(discoverProjectKeyTables(db)).toContain("t");
});

test("dry-run writes nothing -- rows are byte-identical before and after", () => {
  const db = seededDb();
  insertRoadmapItem(db, "r1", "github.com/VOCSAP/koryphaios");
  insertPeer(db, "p1", "github.com/VOCSAP/koryphaios");
  insertPeer(db, "p2", null);

  const result = migrateAll(db, false);
  expect(result.status).toBe("dry-run");

  const row = db.query<{ project_key: string }, []>("SELECT project_key FROM roadmap_items WHERE id = 'r1'").get();
  expect(row?.project_key).toBe("github.com/VOCSAP/koryphaios");
  const peerRow = db
    .query<{ project_key: string }, []>("SELECT project_key FROM peers WHERE instance_token = 'p1'")
    .get();
  expect(peerRow?.project_key).toBe("github.com/VOCSAP/koryphaios");
});

test("dry-run before-counts classify mixed-case, already-lower and null-or-empty correctly", () => {
  const db = seededDb();
  insertRoadmapItem(db, "r1", "github.com/VOCSAP/koryphaios");
  insertRoadmapItem(db, "r2", "github.com/vocsap/koryphaios2");
  insertPeer(db, "p1", null);
  insertPeer(db, "p2", "");

  const c = countByCasing(db, "roadmap_items");
  expect(c).toEqual({ total: 2, mixedCase: 1, alreadyLower: 1, nullOrEmpty: 0 });

  const p = countByCasing(db, "peers");
  expect(p).toEqual({ total: 2, mixedCase: 0, alreadyLower: 0, nullOrEmpty: 2 });
});

test("--write lowercases mixed-case project_key across every discovered table in one pass, leaves already-lower and NULL untouched", () => {
  const db = seededDb();
  insertRoadmapItem(db, "r1", "github.com/VOCSAP/koryphaios");
  insertGraphDraft(db, "g1", "github.com/VOCSAP/koryphaios");
  insertPeer(db, "p1", "github.com/VOCSAP/koryphaios");
  insertPeer(db, "p2", null);

  const result = migrateAll(db, true);
  expect(result.status).toBe("written");

  const roadmapRow = db.query<{ project_key: string }, []>(`SELECT project_key FROM roadmap_items`).get();
  expect(roadmapRow?.project_key).toBe("github.com/vocsap/koryphaios");
  const draftRow = db.query<{ project_key: string }, []>(`SELECT project_key FROM graph_drafts`).get();
  expect(draftRow?.project_key).toBe("github.com/vocsap/koryphaios");
  const peerRow = db
    .query<{ project_key: string }, []>("SELECT project_key FROM peers WHERE instance_token = 'p1'")
    .get();
  expect(peerRow?.project_key).toBe("github.com/vocsap/koryphaios");
  const nullPeer = db
    .query<{ project_key: string | null }, []>("SELECT project_key FROM peers WHERE instance_token = 'p2'")
    .get();
  expect(nullPeer?.project_key).toBeNull();
});

// Card bf76d37f. The two discovery assertions above name dispatch_requests in
// a LIST, which proves it is in the domain but not that migrating it produces
// a coherent result. This one measures the effect that actually matters: the
// parked request and the peers row its key was COPIED from must come out of
// one migration pass carrying the same key, or the Deck stops finding the
// request while its requester has been told it is parked and will be
// announced. Asserted as a JOIN on the value, not as two independent equality
// checks, because two rows both migrated but to different values is precisely
// the failure this is here to exclude.
test("a parked dispatch request stays findable: its project_key migrates in lockstep with the peers row it was copied from", () => {
  const db = seededDb();
  const stale = "github.com/VOCSAP/Koryphaios";
  insertPeer(db, "lead-1", stale);
  insertDispatchRequest(db, "d1", stale);
  // A neighbour on a DIFFERENT project, already lowercase: proves the pass
  // does not simply rewrite every row of the table to one value.
  insertDispatchRequest(db, "d2", "github.com/vocsap/other-repo");

  const result = migrateAll(db, true);
  expect(result.status).toBe("written");

  const joined = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM dispatch_requests d
         JOIN peers p ON p.project_key = d.project_key
        WHERE d.id = 'd1' AND p.instance_token = 'lead-1'`
    )
    .get();
  expect(joined?.n).toBe(1);

  const migrated = db
    .query<{ project_key: string }, []>("SELECT project_key FROM dispatch_requests WHERE id = 'd1'")
    .get();
  expect(migrated?.project_key).toBe("github.com/vocsap/koryphaios");
  const untouched = db
    .query<{ project_key: string }, []>("SELECT project_key FROM dispatch_requests WHERE id = 'd2'")
    .get();
  expect(untouched?.project_key).toBe("github.com/vocsap/other-repo");
});

test("a collision inside dispatch_requests is REFUSED, never merged", () => {
  // The script's contract is refuse-and-write-nothing on any collision, in any
  // table. Pinned for this table specifically because its rows are requests
  // AWAITING execution: silently merging two of them would be silently
  // dropping one lead's ask, and the long poll on the dropped one would time
  // out looking exactly like a slow Deck.
  const db = seededDb();
  insertDispatchRequest(db, "d1", "github.com/VOCSAP/koryphaios");
  insertDispatchRequest(db, "d2", "github.com/vocsap/koryphaios");

  const result = migrateAll(db, true);
  expect(result.status).toBe("collision");

  // Nothing written: the mixed-case row is still exactly as it was.
  const row = db
    .query<{ project_key: string }, []>("SELECT project_key FROM dispatch_requests WHERE id = 'd1'")
    .get();
  expect(row?.project_key).toBe("github.com/VOCSAP/koryphaios");
});

test("non-ASCII casing uses Unicode-correct JS toLowerCase(), never SQLite's ASCII-only LOWER()", () => {
  const db = seededDb();
  insertRoadmapItem(db, "r1", "github.com/VOCSAP/ÉTÉ"); // "github.com/VOCSAP/ÉTÉ"

  const result = migrateAll(db, true);
  expect(result.status).toBe("written");

  const row = db.query<{ project_key: string }, []>("SELECT project_key FROM roadmap_items WHERE id = 'r1'").get();
  // SQLite's LOWER() is ASCII-only and would leave the accented letters
  // alone, producing "github.com/vocsap/ÉtÉ" (a THIRD key runtime
  // code -- shared/project-key.ts's normalizeRemoteUrl, which uses JS
  // .toLowerCase() -- would never produce). The correct Unicode-aware
  // result is "github.com/vocsap/été".
  expect(row?.project_key).toBe("github.com/vocsap/été");
  expect(row?.project_key).not.toBe("github.com/vocsap/ÉtÉ");
});

test("re-running --write after a successful migration is a no-op (idempotent)", () => {
  const db = seededDb();
  insertRoadmapItem(db, "r1", "github.com/VOCSAP/koryphaios");

  const first = migrateAll(db, true);
  expect(first.status).toBe("written");
  if (first.status === "written") {
    expect(first.after.get("roadmap_items")?.mixedCase).toBe(0);
  }

  const second = migrateAll(db, true);
  expect(second.status).toBe("written");
  if (second.status === "written") {
    expect(second.before.get("roadmap_items")?.mixedCase).toBe(0);
    expect(second.after.get("roadmap_items")?.mixedCase).toBe(0);
  }
});

test("a collision (lowercase form already coexists with a mixed-case form) refuses and writes NOTHING, in ANY table", () => {
  const db = seededDb();
  // roadmap_items: collision -- both casings of the same key already present.
  insertRoadmapItem(db, "r1", "github.com/VOCSAP/koryphaios");
  insertRoadmapItem(db, "r2", "github.com/vocsap/koryphaios");
  // graph_drafts: NO collision on its own -- proves the refusal in one
  // table stops the whole run, not just that one table's write.
  insertGraphDraft(db, "g1", "github.com/VOCSAP/koryphaios");

  const result = migrateAll(db, true);
  expect(result.status).toBe("collision");
  if (result.status === "collision") {
    expect(result.collisions.has("roadmap_items")).toBe(true);
    expect(result.collisions.has("graph_drafts")).toBe(false);
  }

  // graph_drafts must be untouched even though it had no collision of its own.
  const draft = db.query<{ project_key: string }, []>("SELECT project_key FROM graph_drafts WHERE id = 'g1'").get();
  expect(draft?.project_key).toBe("github.com/VOCSAP/koryphaios");
  const r1 = db.query<{ project_key: string }, []>("SELECT project_key FROM roadmap_items WHERE id = 'r1'").get();
  expect(r1?.project_key).toBe("github.com/VOCSAP/koryphaios");
});

test("a non-ASCII collision is caught the same way -- collision detection also uses JS toLowerCase()", () => {
  const db = seededDb();
  insertRoadmapItem(db, "r1", "github.com/VOCSAP/ÉTÉ");
  insertRoadmapItem(db, "r2", "github.com/vocsap/été");

  const result = migrateAll(db, true);
  expect(result.status).toBe("collision");
});

test("findCollisions reports the exact colliding forms", () => {
  const db = seededDb();
  insertRoadmapItem(db, "r1", "github.com/VOCSAP/koryphaios");
  insertRoadmapItem(db, "r2", "github.com/vocsap/koryphaios");
  insertRoadmapItem(db, "r3", "github.com/other/repo");

  const collisions = findCollisions(db, "roadmap_items");
  expect(collisions).toHaveLength(1);
  expect(collisions[0]?.lowered).toBe("github.com/vocsap/koryphaios");
  expect(new Set(collisions[0]?.forms)).toEqual(
    new Set(["github.com/VOCSAP/koryphaios", "github.com/vocsap/koryphaios"])
  );
});

test("a table with zero project_key-bearing rows is discovered and reported without error", () => {
  const db = seededDb();
  const result = migrateAll(db, false);
  expect(result.status).toBe("dry-run");
  if (result.status === "dry-run") {
    expect(result.before.get("roadmap_items")).toEqual({
      total: 0,
      mixedCase: 0,
      alreadyLower: 0,
      nullOrEmpty: 0
    });
  }
});

test("atomicity: a failure partway through a multi-table write rolls back a table already migrated earlier in the same transaction", () => {
  const db = seededDb();
  // Tables are processed in alphabetical order (discoverProjectKeyTables's
  // `ORDER BY name`): approval_session_tokens, graph_drafts, peers,
  // pending_approvals, roadmap_items. graph_drafts is migrated BEFORE
  // roadmap_items -- forcing roadmap_items to fail mid-UPDATE proves the
  // already-committed-within-the-transaction graph_drafts write is undone.
  insertGraphDraft(db, "g1", "github.com/VOCSAP/koryphaios");
  insertRoadmapItem(db, "r1", "github.com/VOCSAP/koryphaios");

  db.run(`
    CREATE TRIGGER force_migration_failure
    BEFORE UPDATE OF project_key ON roadmap_items
    BEGIN
      SELECT RAISE(ABORT, 'forced failure for atomicity test');
    END
  `);

  expect(() => migrateAll(db, true)).toThrow();

  const draft = db.query<{ project_key: string }, []>("SELECT project_key FROM graph_drafts WHERE id = 'g1'").get();
  expect(draft?.project_key).toBe("github.com/VOCSAP/koryphaios");
  const item = db.query<{ project_key: string }, []>("SELECT project_key FROM roadmap_items WHERE id = 'r1'").get();
  expect(item?.project_key).toBe("github.com/VOCSAP/koryphaios");
});

test("--db is required -- the script never guesses the broker's db path", () => {
  expect(() => parseArgs([])).toThrow();
  expect(() => parseArgs(["--write"])).toThrow();
  expect(parseArgs(["--db", "/tmp/x.sqlite"])).toEqual({ dbPath: "/tmp/x.sqlite", write: false });
  expect(parseArgs(["--db", "/tmp/x.sqlite", "--write"])).toEqual({ dbPath: "/tmp/x.sqlite", write: true });
});

test("openForMode(dbPath, false) truly opens the database readonly -- a write attempt against it throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-pk-readonly-"));
  const dbPath = join(dir, "test.db");
  try {
    const setupDb = new Database(dbPath);
    setupDb.run(`CREATE TABLE roadmap_items (id TEXT PRIMARY KEY, project_key TEXT NOT NULL)`);
    setupDb.close();

    const readonlyDb = openForMode(dbPath, false);
    expect(() => readonlyDb.run(`INSERT INTO roadmap_items VALUES ('r1', 'x')`)).toThrow();
    readonlyDb.close();

    const writableDb = openForMode(dbPath, true);
    expect(() => writableDb.run(`INSERT INTO roadmap_items VALUES ('r1', 'x')`)).not.toThrow();
    writableDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nonexistent --db path refuses rather than silently creating an empty db", () => {
  // The exact failure the playbook (runbooks/broker-db-migration.md) names
  // as the worst possible outcome of this script: a mistyped/wrong path
  // that creates an empty database and reports a false "nothing to
  // migrate" success, while the real, mixed-case data sits untouched
  // elsewhere. `readonly: true, create: false` (openForMode's dry-run
  // branch) makes SQLite refuse to open a path that does not exist, rather
  // than creating it.
  const dir = mkdtempSync(join(tmpdir(), "migrate-pk-nopath-"));
  try {
    expect(() => openForMode(join(dir, "nope.db"), false)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no tables with a project_key column at all -- reported, not an error", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE unrelated (id TEXT PRIMARY KEY)`);
  expect(migrateAll(db, false)).toEqual({ status: "no-tables" });
});

test("insertPendingApproval/insertApprovalSessionToken fixtures insert cleanly against the real derived schema", () => {
  // Sanity check on the two helpers not otherwise exercised standalone above
  // -- proves their explicit column lists match broker.ts's real NOT NULL
  // columns for these two tables.
  const db = seededDb();
  insertPendingApproval(db, "a1", "github.com/VOCSAP/koryphaios");
  insertApprovalSessionToken(db, "t1", "github.com/VOCSAP/koryphaios");
  const a = db.query<{ project_key: string }, []>("SELECT project_key FROM pending_approvals WHERE id = 'a1'").get();
  expect(a?.project_key).toBe("github.com/VOCSAP/koryphaios");
  const t = db
    .query<{ project_key: string }, []>("SELECT project_key FROM approval_session_tokens WHERE token_id = 't1'")
    .get();
  expect(t?.project_key).toBe("github.com/VOCSAP/koryphaios");
});
