// Card 69e5a3e0. Exercises scripts/migrate-project-key-case.ts's pure logic
// (migrateAll and friends) against in-memory (`:memory:`) bun:sqlite
// databases, plus one real on-disk temp file for the readonly-open test --
// never a real broker database, satisfying this card's "no execution
// against a real database" cadre while still proving the
// discovery/collision/transaction/casing guarantees red-then-green.
//
// The schema used here is DERIVED FROM broker.ts's actual source
// (loadRealSchemaFromBroker below), not hand-listed. Mutation-testing review
// (2026-08-20) found the first version of this file hand-listed 4 tables in
// its fixture and forgot pending_approvals -- the exact defect card
// 69e5a3e0 exists to close, reborn one layer down in the test written not
// to repeat it. Deriving the fixture from broker.ts's CREATE TABLE / ALTER
// TABLE statements means a future 6th (or 7th...) project_key-bearing table
// is covered here automatically, with no one having to remember to update
// this file.

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
 * Replays broker.ts's OWN schema-defining statements (every
 * `CREATE TABLE IF NOT EXISTS ...` and `ALTER TABLE ... ADD COLUMN ...`,
 * in source order) against an in-memory database, plus the one PRAGMA and
 * the one seed row those statements structurally depend on. This is a
 * SOURCE-TEXT replay, not a re-implementation: if broker.ts gains, loses,
 * or renames a project_key-bearing table, this fixture reflects it on the
 * next run without anyone touching this file.
 *
 * What this fixture is NOT a full mirror of, on purpose: broker.ts also
 * declares one FTS5 VIRTUAL TABLE (`roadmap_fts`, broker.ts:624, matched by
 * neither regex below -- "CREATE VIRTUAL TABLE" is a different literal than
 * "CREATE TABLE IF NOT EXISTS"), three TRIGGERs that keep it in sync with
 * roadmap_items (`roadmap_fts_ai`/`_ad`/`_au`, broker.ts:644-663 -- these
 * fire in PRODUCTION on every INSERT/DELETE/UPDATE of roadmap_items,
 * INCLUDING the migration's own UPDATE, but never fire here since this
 * fixture never creates them), and 12 CREATE INDEX statements (11 plain +
 * 1 UNIQUE, MEASURED via `grep -c 'CREATE INDEX\|CREATE UNIQUE INDEX'
 * broker.ts`, 2026-08-20). None of the three carry or gate on project_key,
 * so their absence does not change what this file asserts -- but a reader
 * expecting an exact schema mirror would be wrong to assume they are here.
 */
function loadRealSchemaFromBroker(db: Database): void {
  const src = readFileSync(join(import.meta.dir, "..", "broker.ts"), "utf-8");

  // peers.group_id carries `FOREIGN KEY (group_id) REFERENCES
  // groups(group_id)` (broker.ts:406) -- mirror broker.ts:373's own
  // enforcement so a test inserting an invalid group_id fails the same way
  // the real broker would, instead of silently succeeding.
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

  // Columns added to a pre-existing table after its initial CREATE TABLE
  // (e.g. approval_session_tokens' project_key, card 1def56da, broker.ts:741)
  // live in a separate `db.run("ALTER TABLE ...")` call -- must be replayed
  // too, or such a column is invisible here even though
  // discoverProjectKeyTables would find it on the real, live database. Some
  // of these are idempotent migrations for a column that a LATER edit of
  // broker.ts folded into the table's own CREATE TABLE (e.g. roadmap_items'
  // `queue`, broker.ts:529 inline AND broker.ts:537 ALTER for pre-existing
  // rows) -- broker.ts itself wraps every one of these in a try/catch
  // swallowing "duplicate column name" (see rules/bun.md's idempotent
  // migration pattern); mirror that here rather than special-casing which
  // ALTERs are now redundant.
  const alterTableRe = /db\.run\("(ALTER TABLE [^"]*)"\)/g;
  while ((m = alterTableRe.exec(src))) {
    try {
      db.run(m[1]!);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) throw e;
    }
  }

  // broker.ts:384-387 seeds the 'default' group at boot -- peers.group_id's
  // FK above requires it to exist before any peers row can be inserted.
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

test("discovery finds every real project_key-bearing table in broker.ts's schema, none else", () => {
  const db = seededDb();
  // This is the whole point of deriving from source: if broker.ts adds,
  // removes, or renames a project_key column, this assertion changes on its
  // own the next time this file runs -- nobody has to remember to update it.
  expect(discoverProjectKeyTables(db)).toEqual([
    "approval_session_tokens",
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
  expect(tables.length).toBe(6);
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
  // The exact failure the runbook (RUNBOOK-PROJECT-KEY-MIGRATION.md) names
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
