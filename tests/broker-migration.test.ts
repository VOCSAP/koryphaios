import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, post, type TestBroker, openBrokerDb } from "./_helper.ts";
import { Database } from "bun:sqlite";
import type { RoadmapItem } from "../shared/types.ts";

const brokers: TestBroker[] = [];
const seededDirs: string[] = [];
afterAll(async () => {
  for (const b of brokers) await stopBroker(b);
  for (const d of seededDirs) rmSync(d, { recursive: true, force: true });
});

test("broker boots on a db whose roadmap_context_documents predates the sync columns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-legacy-docs-"));
  seededDirs.push(dir);
  const dbPath = join(dir, "peers.db");
  const seed = new Database(dbPath);
  seed.run(
    "CREATE TABLE roadmap_context_documents (id TEXT PRIMARY KEY, roadmap_item_id TEXT NOT NULL, project_key TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)"
  );
  seed.close();

  const b = await startBroker({ CLAUDE_PEERS_DB: dbPath });
  brokers.push(b);

  const db = openBrokerDb(dbPath, { readonly: true });
  const cols = (db.query("PRAGMA table_info(roadmap_context_documents)").all() as { name: string }[]).map(
    (c) => c.name
  );
  const index = db
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_roadmap_context_documents_sync_rev'")
    .get();
  db.close();
  expect(cols, "legacy roadmap_context_documents was not migrated with the sync columns").toEqual(
    expect.arrayContaining(["sync_rev", "sync_dirty"])
  );
  expect(index, "sync_rev index missing after migrating a legacy roadmap_context_documents").toBeTruthy();
});

test("the Inbox provenance migration extends an older database twice over and keeps every historical NULL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-legacy-inbox-"));
  seededDirs.push(dir);
  const dbPath = join(dir, "peers.db");
  const seed = new Database(dbPath);
  seed.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_token TEXT NOT NULL, to_token TEXT NOT NULL,
    group_id TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)`);
  seed.run(`CREATE TABLE IF NOT EXISTS pending_approvals (
    id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, origin_host TEXT NOT NULL DEFAULT '', origin_user TEXT NOT NULL DEFAULT '',
    project_key TEXT NOT NULL DEFAULT '', group_id TEXT NOT NULL DEFAULT '', from_peer TEXT NOT NULL DEFAULT '',
    session_ref TEXT NOT NULL DEFAULT '', tile_ref TEXT NOT NULL DEFAULT '', reply_route TEXT NOT NULL DEFAULT 'pty',
    reply_token TEXT NOT NULL DEFAULT '', reply_group TEXT NOT NULL DEFAULT '', last_wait_at TEXT,
    producer_secret_hash TEXT NOT NULL DEFAULT '', questions_json TEXT, answers_json TEXT, kind TEXT NOT NULL,
    title TEXT NOT NULL, question TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
    answered_via TEXT, answer_kind TEXT, answer_text TEXT, created_at TEXT NOT NULL, notif_expires_at TEXT NOT NULL,
    answered_at TEXT, delivered_at TEXT)`);
  seed.run(`CREATE TABLE approval_session_tokens (
    token_id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, public_key TEXT NOT NULL, session_ref TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, project_key TEXT NOT NULL DEFAULT '')`);
  const now = new Date().toISOString();
  seed.run("INSERT INTO messages (from_token, to_token, group_id, text, sent_at) VALUES ('old-from', '__operator__', 'g-old', 'old note', ?)", [now]);
  seed.run(
    "INSERT INTO pending_approvals (id, operator_id, project_key, kind, title, question, created_at, notif_expires_at) VALUES ('old-approval', 'op-old', 'github.com/old/repo', 'permission', 't', 'q', ?, ?)",
    [now, now]
  );
  seed.run(
    "INSERT INTO approval_session_tokens (token_id, operator_id, public_key, session_ref, created_at, expires_at, project_key) VALUES ('old-token', 'op-old', 'pk', 'tile-1', ?, ?, 'github.com/old/repo')",
    [now, now]
  );
  seed.close();

  const b1 = await startBroker({ CLAUDE_PEERS_DB: dbPath });
  const b2 = await startBroker({ CLAUDE_PEERS_DB: dbPath });
  brokers.push(b2, b1);

  const db = openBrokerDb(dbPath, { readonly: true });
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  const oldMessage = db
    .query(
      `SELECT inbox_operator_id, inbox_run_ref, inbox_group_id, inbox_project_key, author_instance_ref,
              author_peer_id_snapshot, source_kind, provenance_version FROM messages WHERE text = 'old note'`
    )
    .get();
  const oldApproval = db
    .query(
      `SELECT inbox_run_ref, inbox_group_id, author_instance_ref, author_peer_id_snapshot, source_kind, provenance_version
         FROM pending_approvals WHERE id = 'old-approval'`
    )
    .get();
  const oldToken = db
    .query(
      `SELECT inbox_purpose, inbox_version, run_ref, group_id, parent_token_id, caller_ref, authority
         FROM approval_session_tokens WHERE token_id = 'old-token'`
    )
    .get();
  db.close();

  // Each SELECT above names every added column, so a missing one throws before this line.
  expect(tables).toEqual(expect.arrayContaining(["inbox_instance_bindings", "operator_inbox_run_sessions"]));
  const nulls = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));
  expect(oldMessage, "a historical message is never promoted").toEqual(
    nulls(["inbox_operator_id", "inbox_run_ref", "inbox_group_id", "inbox_project_key", "author_instance_ref", "author_peer_id_snapshot", "source_kind", "provenance_version"])
  );
  expect(oldApproval, "a historical approval is never attested").toEqual(
    nulls(["inbox_run_ref", "inbox_group_id", "author_instance_ref", "author_peer_id_snapshot", "source_kind", "provenance_version"])
  );
  expect(oldToken, "a historical token stays legacy").toEqual(
    nulls(["inbox_purpose", "inbox_version", "run_ref", "group_id", "parent_token_id", "caller_ref", "authority"])
  );
});

test("migration adds claude_cli_pid column to peers", async () => {
  const b = await startBroker();
  brokers.push(b);
  const db = openBrokerDb(b.dbPath, { readonly: true });
  const cols = db.query("PRAGMA table_info(peers)").all() as { name: string }[];
  db.close();
  expect(cols.some((c) => c.name === "claude_cli_pid")).toBe(true);
});

test("migration is idempotent on already-migrated db", async () => {
  const b1 = await startBroker();
  brokers.push(b1);
  // Restart the broker against the same DB path -- migration must not throw.
  // Note: b2.dbPath is stale (helper computes a fresh tmpDir regardless of envOverrides);
  // the broker process uses b1.dbPath via the CLAUDE_PEERS_DB env override.
  const b2 = await startBroker({ CLAUDE_PEERS_DB: b1.dbPath });
  brokers.push(b2);
  // If we got here, the second broker came up successfully.
  expect(b2.port).toBeGreaterThan(0);
});

test("first card in an empty roadmap survives a 2nd broker startup (card 5ce394ca)", async () => {
  const b1 = await startBroker();
  // Second startup against the same, still-empty db: the FTS triggers get
  // dropped and recreated a second time, which is what exposes the trigger-
  // ordering bug (roadmap_rev_ai firing before roadmap_fts_ai on an INSERT).
  const b2 = await startBroker({ CLAUDE_PEERS_DB: b1.dbPath });
  // b2 pushed before b1: both hold the SAME db file open (b1.dbPath via the
  // env override above), and afterAll stops brokers in array order. Stopping
  // b1 first would delete the shared tmpDir while b2 still has the file open,
  // leaking the directory on Windows (which cannot remove an open file).
  brokers.push(b2, b1);

  const res = await post<{ item: RoadmapItem; error?: string }>(`${b2.url}/roadmap/upsert`, {
    project_key: "github.com/vocsap/broker-migration-test",
    title: "first card in an empty roadmap",
    by: "broker-migration-fixture",
  });
  expect(res.status, `first card insert into an empty roadmap failed: ${res.status} ${JSON.stringify(res.body)}`).toBe(
    200
  );
  expect(res.body.item?.id, "upsert response is missing the created item's id").toBeTruthy();
});

test("roadmap_fts_au's AFTER UPDATE OF columns match the fts5 DDL columns (card 5ce394ca)", async () => {
  const b = await startBroker();
  brokers.push(b);
  const db = openBrokerDb(b.dbPath, { readonly: true });
  const tableSql = (
    db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roadmap_fts'").get() as {
      sql: string;
    }
  ).sql;
  const triggerSql = (
    db.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'roadmap_fts_au'").get() as {
      sql: string;
    }
  ).sql;
  db.close();

  // fts5 column args sit between the opening paren and `content=`. SQLite
  // strips "IF NOT EXISTS" from the sql it stores, so this parse never
  // depends on that fragment surviving -- it only ever sees the column list.
  const tableCols = tableSql
    .slice(tableSql.indexOf("(") + 1, tableSql.indexOf("content="))
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const ofMatch = triggerSql.match(/UPDATE OF (.+?) ON roadmap_items/);
  expect(
    ofMatch,
    `roadmap_fts_au trigger sql did not match the expected "UPDATE OF ... ON roadmap_items" shape: ${triggerSql}`
  ).toBeTruthy();
  const triggerCols = (ofMatch as RegExpMatchArray)[1].split(",").map((c) => c.trim());

  expect(
    triggerCols,
    `roadmap_fts_au's AFTER UPDATE OF columns (${triggerCols.join(", ")}) must match the fts5 DDL columns (${tableCols.join(", ")}) -- a mismatch silently stops reindexing whichever column is missing from the OF clause`
  ).toEqual(tableCols);
});
