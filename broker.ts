#!/usr/bin/env bun
/**
 * claude-peers broker daemon (v0.9.0)
 *
 * Singleton HTTP server on 127.0.0.1:<port> backed by SQLite.
 * Tracks registered Claude Code peers, isolates them by group, persists session
 * identity across reconnects, and routes messages between them.
 *
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig } from "./shared/config.ts";
import { createLogger, coreLogDir } from "./shared/logger.ts";
import { validateDraftPayload } from "./shared/graph-draft.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  SendMessageResponse,
  PollMessagesRequest,
  PollMessagesResponse,
  DisconnectRequest,
  UnregisterRequest,
  SetIdRequest,
  SetIdResponse,
  GroupStatsResponse,
  AnnounceRequest,
  AnnounceResponse,
  RoadmapArchiveRequest,
  RoadmapArchiveResponse,
  RoadmapItem,
  RoadmapKind,
  RoadmapLevel,
  RoadmapListRequest,
  RoadmapListResponse,
  RoadmapPriority,
  RoadmapStatus,
  RoadmapUpsertRequest,
  RoadmapUpsertResponse,
  GraphDraft,
  GraphDraftAddRequest,
  GraphDraftAddResponse,
  GraphDraftListRequest,
  GraphDraftListResponse,
  GraphDraftOpenRequest,
  GraphDraftOpenResponse,
  GraphDraftStatus,
  OperatorInboxRequest,
  OperatorInboxResponse,
  OperatorInboxMessage,
  Peer,
  Message,
  GroupId,
  InstanceToken,
} from "./shared/types.ts";
import {
  DECK_INSTANCE_TOKEN,
  DECK_PEER_ID,
  OPERATOR_INSTANCE_TOKEN,
  OPERATOR_PEER_ID,
  RESERVED_PEER_IDS,
} from "./shared/types.ts";

const config = await loadConfig();
const PORT = config.port;
const DB_PATH = config.db;
const BIND_HOST = config.bind_host ?? "127.0.0.1";
const BROKER_TOKEN = config.broker_token ?? null;
const DORMANT_TTL_HOURS = parseInt(
  process.env.CLAUDE_PEERS_DORMANT_TTL_HOURS ?? "24",
  10
);
const PEER_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const ACTIVITY_TIMEOUT_MS = parseInt(process.env.CLAUDE_PEERS_ACTIVITY_TIMEOUT_SEC ?? "1800", 10) * 1000;
const WS_IDLE_TIMEOUT_SEC = parseInt(process.env.CLAUDE_PEERS_WS_IDLE_TIMEOUT_SEC ?? "600", 10);
const ACTIVE_STALE_SEC = Math.max(
  10,
  parseInt(process.env.CLAUDE_PEERS_ACTIVE_STALE_SEC ?? "120", 10)
);
const SWEEP_INTERVAL_SEC = Math.max(
  10,
  parseInt(process.env.CLAUDE_PEERS_DORMANT_SWEEP_SEC ?? "60", 10)
);
const CLEAN_INTERVAL_MS = Math.max(
  1_000,
  parseInt(process.env.CLAUDE_PEERS_CLEAN_INTERVAL_SEC ?? "30", 10) * 1000
);
// Roadmap work-lock sweep (PLAN K2): TTL without any write on the item, grace
// period before an owner-less lock is released, and sweep cadence.
const LOCK_TTL_SEC = Math.max(1, parseInt(process.env.CLAUDE_PEERS_LOCK_TTL_SEC ?? "21600", 10));
const LOCK_GRACE_SEC = Math.max(1, parseInt(process.env.CLAUDE_PEERS_LOCK_GRACE_SEC ?? "600", 10));
const LOCK_SWEEP_SEC = Math.max(1, parseInt(process.env.CLAUDE_PEERS_LOCK_SWEEP_SEC ?? "60", 10));
const FLUSH_MAX_COUNT = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_FLUSH_MAX_COUNT ?? "20", 10)
);
const FLUSH_MAX_AGE_HOURS = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_FLUSH_MAX_AGE_HOURS ?? "24", 10)
);
const MESSAGE_TTL_DAYS = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_MESSAGE_TTL_DAYS ?? "7", 10)
);
const PURGE_INTERVAL_SEC = Math.max(
  60,
  parseInt(process.env.CLAUDE_PEERS_PURGE_INTERVAL_SEC ?? "3600", 10)
);

// Rolling file log (PLAN-observabilite-erreurs O1/O2). The broker daemon often
// outlives the stderr of whoever spawned it (server.ts spawns it detached), so
// it must own its on-disk trail. Console mirroring keeps `bun broker.ts` usable.
const log = createLogger({ dir: coreLogDir(), name: "broker" }).child("broker");

// Last-resort safety nets: an unhandled error is logged to the file before the
// process dies (Bun would otherwise exit with a stack on a possibly-dead stderr).
process.on("uncaughtException", (e) => {
  log.error("uncaught exception, exiting", e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  log.error("unhandled rejection, exiting", e);
  process.exit(1);
});

/**
 * setInterval wrapper for the maintenance timers: they run outside the HTTP
 * handler's try/catch, so a transient SQLite error (SQLITE_BUSY, disk full)
 * must skip the iteration -- not kill the daemon.
 */
function guardedInterval(name: string, fn: () => unknown, ms: number): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      fn();
    } catch (e) {
      log.error(`timer ${name}: iteration failed (skipped)`, e);
    }
  }, ms);
}

try {
  mkdirSync(dirname(DB_PATH), { recursive: true });
} catch (e) {
  log.warn(`cannot create db directory for ${DB_PATH} (best-effort)`, e);
}

// --- Database setup (v0.3 schema, no migration path) ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
db.run("PRAGMA foreign_keys = ON");

db.run(`
  CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    secret_hash TEXT,
    name TEXT,
    created_at TEXT NOT NULL
  )
`);

db.run(`
  INSERT OR IGNORE INTO groups (group_id, secret_hash, name, created_at)
  VALUES ('default', NULL, 'default', datetime('now'))
`);

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    instance_token TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    group_id TEXT NOT NULL DEFAULT 'default',
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT '',
    client_pid INTEGER NOT NULL DEFAULT 0,
    project_key TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE (peer_id, group_id),
    FOREIGN KEY (group_id) REFERENCES groups(group_id)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_peers_group ON peers(group_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status)`);

// Migration: add last_activity_at column (idempotent)
try {
  db.run("ALTER TABLE peers ADD COLUMN last_activity_at TEXT DEFAULT NULL");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Migration: add claude_cli_pid column (idempotent)
// PID of the Claude Code CLI process (process.ppid of server.ts) -- used by
// the SessionEnd hook to mark a peer dormant without an instance_token.
try {
  db.run("ALTER TABLE peers ADD COLUMN claude_cli_pid INTEGER");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_token TEXT NOT NULL,
    to_token TEXT NOT NULL,
    group_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_token) REFERENCES peers(instance_token),
    FOREIGN KEY (to_token) REFERENCES peers(instance_token)
  )
`);

// Reserved system sender for Deck announcements (v0.3.4). messages.from_token has
// a NOT NULL FK to peers(instance_token), so /announce needs a real row to point
// at. This row stays 'dormant' forever: it never appears in list_peers/group-stats
// (both filter status='active') and is never a valid send_message target, so peers
// cannot reply to the Deck. cleanStalePeers excludes it from the dormant TTL purge.
db.run(
  `INSERT OR IGNORE INTO peers
     (instance_token, peer_id, group_id, pid, cwd, summary, registered_at, last_seen, host, client_pid, status)
   VALUES (?, ?, 'default', 0, '', '', datetime('now'), datetime('now'), '', 0, 'dormant')`,
  [DECK_INSTANCE_TOKEN, DECK_PEER_ID]
);

// Reserved OPERATOR inbox sentinel (PLAN C12): the human in front of the Deck.
// Agents send_message to 'operator'; the Deck drains /operator-inbox. Same
// lifecycle rules as the deck row (permanently dormant, never listed/purged).
db.run(
  `INSERT OR IGNORE INTO peers
     (instance_token, peer_id, group_id, pid, cwd, summary, registered_at, last_seen, host, client_pid, status)
   VALUES (?, ?, 'default', 0, '', '', datetime('now'), datetime('now'), '', 0, 'dormant')`,
  [OPERATOR_INSTANCE_TOKEN, OPERATOR_PEER_ID]
);

db.run(`CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(to_token, delivered)`);

db.run(`
  CREATE TABLE IF NOT EXISTS peer_sessions (
    session_key TEXT PRIMARY KEY,
    instance_token TEXT NOT NULL,
    group_id TEXT NOT NULL,
    host TEXT NOT NULL,
    cwd TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    FOREIGN KEY (instance_token) REFERENCES peers(instance_token)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON peer_sessions(group_id, host, cwd)`);

// Roadmap items (v0.4, PLAN C3). Scoped by project_key, NOT group_id, and with
// deliberately NO foreign key to peers/groups: created_by/updated_by are plain
// text snapshots of a peer_id (or 'deck'), so items live independently of the
// session lifecycle -- no cleanup timer touches this table, and deletion is a
// reversible archive (deleted_at) rather than a DELETE.
db.run(`
  CREATE TABLE IF NOT EXISTS roadmap_items (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rationale TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'could',
    value TEXT NOT NULL DEFAULT 'medium',
    effort TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'idea',
    tags TEXT NOT NULL DEFAULT '[]',
    depends_on TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    queue INTEGER
  )
`);

// Migration (v0.6, PLAN C15): dispatch-queue position on pre-existing tables.
try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN queue INTEGER");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Migration (v0.7, PLAN C20): agent briefing on pre-existing tables.
try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN context TEXT NOT NULL DEFAULT ''");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Migration (v0.8, PLAN K2): agent work-lock on pre-existing tables. locked_by
// is a plain-text peer_id snapshot (no FK), like created_by/updated_by.
for (const col of [
  "locked INTEGER NOT NULL DEFAULT 0",
  "locked_by TEXT",
  "locked_at TEXT",
]) {
  try {
    db.run(`ALTER TABLE roadmap_items ADD COLUMN ${col}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
  }
}

db.run(`CREATE INDEX IF NOT EXISTS idx_roadmap_project ON roadmap_items(project_key, status)`);

// Graph drafts: agent-escalated questions waiting to be opened in the Deck's
// graph view. Same durability philosophy as roadmap_items (no FK, plain-text
// peer snapshot) and deliberately NOT the messages table: listing is
// non-destructive (no drain), the status only flips when the OPERATOR opens
// the draft — a Deck crash or restart never loses a pending draft.
db.run(`
  CREATE TABLE IF NOT EXISTS graph_drafts (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    from_peer TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    opened_at TEXT
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_graph_drafts_project ON graph_drafts(project_key, status)`);

// --- Helpers ---

function sessionKey(host: string, cwd: string, groupId: GroupId): string {
  return createHash("sha256")
    .update(host)
    .update("\0")
    .update(cwd)
    .update("\0")
    .update(groupId)
    .digest("hex");
}

function deriveDefaultId(host: string, cwd: string, groupId: GroupId): string {
  const sanitize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const hostPart = sanitize(host).slice(0, 20) || "peer";
  const cwdPart = sanitize(cwd.split(/[/\\]/).pop() ?? "").slice(0, 12);
  const base = cwdPart ? `${hostPart}-${cwdPart}` : hostPart;

  const exists = db.query("SELECT 1 FROM peers WHERE peer_id = ? AND group_id = ?");
  let candidate = base;
  let suffix = 1;
  const MAX_SUFFIX = 1000;
  while (exists.get(candidate, groupId)) {
    suffix += 1;
    if (suffix > MAX_SUFFIX) {
      candidate = `${base}-${Date.now().toString(36)}`;
      break;
    }
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

// --- Stale cleanup (dormant lifecycle) ---

// Hostname of THIS broker process. PID-based liveness only applies to peers
// registered from the same machine. Cross-machine peers are reaped via the
// heartbeat staleness sweep (sweepInactivePeers).
const BROKER_HOST = hostname();

function cleanStalePeers(): void {
  // Phase 1: bascule active -> dormant pour les pids morts (same-host only).
  const actives = db.query(
    "SELECT instance_token, pid FROM peers WHERE status = 'active' AND host = ?"
  ).all(BROKER_HOST) as { instance_token: string; pid: number }[];
  for (const peer of actives) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      db.run(
        "UPDATE peers SET status = 'dormant' WHERE instance_token = ?",
        [peer.instance_token]
      );
    }
  }

  // Phase 2: purge dormants au-dela du TTL. The reserved Deck sender row is
  // exempt -- it is permanently dormant and must outlive the TTL so /announce's
  // from_token FK always resolves.
  const cutoff = `-${DORMANT_TTL_HOURS} hours`;
  const expired = db.query(
    `SELECT instance_token FROM peers
     WHERE status = 'dormant' AND last_seen < datetime('now', ?)
       AND instance_token <> ? AND instance_token <> ?`
  ).all(cutoff, DECK_INSTANCE_TOKEN, OPERATOR_INSTANCE_TOKEN) as { instance_token: string }[];
  for (const { instance_token } of expired) {
    purgeDormantPeerTx(instance_token);
  }
}

// Must clear BOTH FK directions before deleting the peer row (messages.from_token
// and messages.to_token both reference peers), and the three deletes must land
// together: an abrupt death in between would leave a peer without its sessions.
const purgeDormantPeerTx = db.transaction((instance_token: string) => {
  db.run("DELETE FROM messages WHERE from_token = ? OR to_token = ?", [instance_token, instance_token]);
  db.run("DELETE FROM peer_sessions WHERE instance_token = ?", [instance_token]);
  db.run("DELETE FROM peers WHERE instance_token = ?", [instance_token]);
});

cleanStalePeers();
guardedInterval("cleanStalePeers", cleanStalePeers, CLEAN_INTERVAL_MS);

// --- Heartbeat-staleness sweep (active_stale_sec) ---

function sweepInactivePeers(): void {
  const cutoff = new Date(Date.now() - ACTIVE_STALE_SEC * 1000).toISOString();
  db.run(
    "UPDATE peers SET status = 'dormant' WHERE status = 'active' AND last_seen < ?",
    [cutoff]
  );
}
guardedInterval("sweepInactivePeers", sweepInactivePeers, SWEEP_INTERVAL_SEC * 1000);

// --- Stale roadmap-lock sweep (PLAN K2) ---
// Releases agent work-locks whose owner is gone or that outlived the TTL, so a
// crashed or abandoned session never freezes an item forever. A released item
// drops back to 'planned': visibly up for grabs again. `datetime(...)` wraps
// the stored values because locked_at/updated_at may mix SQLite and ISO-8601
// formats depending on the writer.
function releaseStaleLocks(): void {
  const release = (where: string, params: string[]): void => {
    db.run(
      `UPDATE roadmap_items SET
         locked = 0, locked_by = NULL, locked_at = NULL,
         status = CASE WHEN status = 'in_progress' THEN 'planned' ELSE status END,
         updated_by = 'lock-sweep', updated_at = datetime('now')
       WHERE locked = 1 AND ${where}`,
      params
    );
  };
  // TTL: no write at all on the item for LOCK_TTL_SEC (any roadmap_update,
  // e.g. a context enrichment by the working agent, refreshes updated_at).
  release(`datetime(updated_at) < datetime('now', ?)`, [`-${LOCK_TTL_SEC} seconds`]);
  // Owner gone: no ACTIVE peer carries the lock owner's peer_id for this
  // project. The grace period keeps a reconnecting session (server.ts restart,
  // brief network drop) from being stripped of its lock mid-flight.
  release(
    `datetime(locked_at) < datetime('now', ?)
     AND NOT EXISTS (
       SELECT 1 FROM peers p
       WHERE p.peer_id = roadmap_items.locked_by
         AND p.status = 'active'
         AND (p.project_key IS NULL OR p.project_key = roadmap_items.project_key)
     )`,
    [`-${LOCK_GRACE_SEC} seconds`]
  );
}
guardedInterval("releaseStaleLocks", releaseStaleLocks, LOCK_SWEEP_SEC * 1000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (
    instance_token, peer_id, group_id, pid, cwd, git_root, tty, summary,
    registered_at, last_seen, last_activity_at, host, client_pid, project_key, claude_cli_pid, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
`);

const updateLastSeen = db.prepare(
  `UPDATE peers SET last_seen = ? WHERE instance_token = ?`
);

const updateSummary = db.prepare(
  `UPDATE peers SET summary = ? WHERE instance_token = ?`
);

const updateLastActivity = db.prepare(
  `UPDATE peers SET last_activity_at = ? WHERE instance_token = ?`
);

const updateActiveOnRegister = db.prepare(`
  UPDATE peers
  SET status = 'active',
      pid = ?,
      cwd = ?,
      git_root = ?,
      tty = ?,
      summary = ?,
      last_seen = ?,
      last_activity_at = ?,
      host = ?,
      client_pid = ?,
      project_key = ?,
      claude_cli_pid = ?
  WHERE instance_token = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(
  `SELECT * FROM messages WHERE to_token = ? AND delivered = 0 ORDER BY sent_at ASC`
);

// Capped variant used only by flushPendingForToken to avoid replaying the entire
// backlog at every WS reconnect. /poll-messages and /peek-messages keep using the
// uncapped selectUndelivered so an explicit check_messages still returns everything.
const selectUndeliveredCapped = db.prepare(
  `SELECT * FROM (
     SELECT * FROM messages
     WHERE to_token = ? AND delivered = 0
       AND sent_at > datetime('now', ?)
     ORDER BY sent_at DESC
     LIMIT ?
   ) ORDER BY sent_at ASC`
);

const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

// Heuristic ack: when a peer sends a message in a group, it has necessarily
// processed the messages addressed to it in that same group before sent_at.
// Promoting those to delivered=1 prevents the flushPendingForToken avalanche
// at the next WS reconnect for bidirectional conversations.
const ackPriorMessagesForSender = db.prepare(
  `UPDATE messages
     SET delivered = 1
   WHERE to_token = ?
     AND group_id = ?
     AND delivered = 0
     AND sent_at < ?`
);

// Message insert + activity refresh + heuristic ack land atomically: an abrupt
// broker death mid-sequence must not leave a message without its bookkeeping.
const recordMessageTx = db.transaction(
  (fromToken: string, toToken: string, groupId: string, text: string, sentAt: string): number => {
    const result = insertMessage.run(fromToken, toToken, groupId, text, sentAt);
    updateLastActivity.run(sentAt, fromToken);
    updateLastActivity.run(sentAt, toToken);
    ackPriorMessagesForSender.run(fromToken, groupId, sentAt);
    return Number(result.lastInsertRowid);
  }
);

const purgeOldUndeliveredStmt = db.prepare(
  `DELETE FROM messages
   WHERE delivered = 0
     AND sent_at < datetime('now', ?)`
);

const upsertPeerSession = db.prepare(`
  INSERT INTO peer_sessions (session_key, instance_token, group_id, host, cwd, last_active_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (session_key) DO UPDATE SET
    instance_token = excluded.instance_token,
    last_active_at = excluded.last_active_at
`);

// --- TTL purge of undelivered messages ---

// Opened graph drafts are kept for reference then swept; retention is
// operator-tunable (CLAUDE_PEERS_GRAPH_DRAFT_TTL_DAYS, default 30). Pending
// drafts are NEVER purged: they wait for the operator, however long.
const GRAPH_DRAFT_TTL_DAYS = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_GRAPH_DRAFT_TTL_DAYS ?? "30", 10)
);
const purgeOpenedDraftsStmt = db.prepare(
  `DELETE FROM graph_drafts
   WHERE status = 'opened'
     AND opened_at < datetime('now', ?)`
);

function purgeOldMessages(): { messages: number; drafts: number } {
  const cutoff = `-${MESSAGE_TTL_DAYS} days`;
  const result = purgeOldUndeliveredStmt.run(cutoff);
  if (result.changes > 0) {
    log.info(
      `purged ${result.changes} stale undelivered messages (>${MESSAGE_TTL_DAYS}d)`
    );
  }
  const drafts = purgeOpenedDraftsStmt.run(`-${GRAPH_DRAFT_TTL_DAYS} days`);
  return { messages: result.changes, drafts: drafts.changes };
}
purgeOldMessages();
guardedInterval("purgeOldMessages", purgeOldMessages, PURGE_INTERVAL_SEC * 1000);

// --- /register: TOFU + resume ---

function handleRegister(body: RegisterRequest): RegisterResponse | { error: string; status: number } {
  const groupId = body.group_id;
  const secretHash = body.group_secret_hash;
  const now = new Date().toISOString();

  // 1) Group authentication / TOFU.
  if (groupId !== "default") {
    const existing = db.query(
      "SELECT secret_hash FROM groups WHERE group_id = ?"
    ).get(groupId) as { secret_hash: string | null } | null;

    if (existing) {
      if (existing.secret_hash !== secretHash) {
        return { error: "group_secret_hash mismatch (TOFU rejected)", status: 401 };
      }
    } else {
      db.run(
        "INSERT INTO groups (group_id, secret_hash, name, created_at) VALUES (?, ?, NULL, ?)",
        [groupId, secretHash, now]
      );
    }
  }
  // For 'default', secret_hash is ignored.

  // 2) Resume lookup keyed on (host, cwd, group_id).
  const sk = sessionKey(body.host, body.cwd, groupId);
  const session = db.query(
    "SELECT instance_token FROM peer_sessions WHERE session_key = ?"
  ).get(sk) as { instance_token: string } | null;

  if (session) {
    const existingPeer = db.query(
      "SELECT instance_token, peer_id, status, pid, host FROM peers WHERE instance_token = ?"
    ).get(session.instance_token) as
      | { instance_token: string; peer_id: string; status: "active" | "dormant"; pid: number; host: string }
      | null;

    // If marked active but the bun server.ts pid is dead, treat as dormant.
    // This shrinks the post-crash window where the user would otherwise
    // receive a fresh peer_id while waiting for cleanStalePeers (30s tick).
    // Only valid for same-host peers: a Linux broker cannot probe a Windows
    // PID, the kill throws unconditionally, and the resurrect path would
    // silently steal the active peer's identity (see Bug D, 2026-05-15).
    if (existingPeer && existingPeer.status === "active" && existingPeer.host === BROKER_HOST) {
      try {
        process.kill(existingPeer.pid, 0);
      } catch {
        db.run(
          "UPDATE peers SET status = 'dormant' WHERE instance_token = ?",
          [existingPeer.instance_token]
        );
        existingPeer.status = "dormant";
      }
    }

    if (existingPeer && existingPeer.status === "dormant") {
      // Resurrect dormant.
      updateActiveOnRegister.run(
        body.pid,
        body.cwd,
        body.git_root,
        body.tty,
        body.summary,
        now,
        now,
        body.host,
        body.client_pid,
        body.project_key,
        body.claude_cli_pid ?? null,
        existingPeer.instance_token
      );
      upsertPeerSession.run(sk, existingPeer.instance_token, groupId, body.host, body.cwd, now);
      return {
        peer_id: existingPeer.peer_id,
        instance_token: existingPeer.instance_token,
      };
    }

    if (existingPeer && existingPeer.status === "active") {
      // Active collision: another process is already holding this session_key.
      // Mint a fresh peer with a derived id; do NOT touch peer_sessions
      // (the existing active row keeps the canonical session).
      log.warn(
        `session_key collision: existing active peer ${existingPeer.peer_id} keeps the session, minting new peer`
      );
      const freshToken = randomUUID();
      const freshId = deriveDefaultId(body.host, body.cwd, groupId);
      insertPeer.run(
        freshToken,
        freshId,
        groupId,
        body.pid,
        body.cwd,
        body.git_root,
        body.tty,
        body.summary,
        now,
        now,
        now,
        body.host,
        body.client_pid,
        body.project_key,
        body.claude_cli_pid ?? null
      );
      return { peer_id: freshId, instance_token: freshToken };
    }

    // peer row purged but the session_key remembered the token: reinsert reusing it.
    const reusedId = deriveDefaultId(body.host, body.cwd, groupId);
    insertPeer.run(
      session.instance_token,
      reusedId,
      groupId,
      body.pid,
      body.cwd,
      body.git_root,
      body.tty,
      body.summary,
      now,
      now,
      now,
      body.host,
      body.client_pid,
      body.project_key,
      body.claude_cli_pid ?? null
    );
    upsertPeerSession.run(sk, session.instance_token, groupId, body.host, body.cwd, now);
    return { peer_id: reusedId, instance_token: session.instance_token };
  }

  // 3) Fresh registration.
  const newToken = randomUUID();
  const newPeerId = deriveDefaultId(body.host, body.cwd, groupId);
  insertPeer.run(
    newToken,
    newPeerId,
    groupId,
    body.pid,
    body.cwd,
    body.git_root,
    body.tty,
    body.summary,
    now,
    now,
    now,
    body.host,
    body.client_pid,
    body.project_key,
    body.claude_cli_pid ?? null
  );
  upsertPeerSession.run(sk, newToken, groupId, body.host, body.cwd, now);
  return { peer_id: newPeerId, instance_token: newToken };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.instance_token);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.instance_token);
}

function handleDisconnect(body: DisconnectRequest): void {
  db.run(
    "UPDATE peers SET status = 'dormant', last_seen = ? WHERE instance_token = ?",
    [new Date().toISOString(), body.instance_token]
  );
}

function handleUnregister(body: UnregisterRequest): void {
  db.run("DELETE FROM messages WHERE from_token = ? OR to_token = ?", [body.instance_token, body.instance_token]);
  db.run("DELETE FROM peer_sessions WHERE instance_token = ?", [body.instance_token]);
  db.run("DELETE FROM peers WHERE instance_token = ?", [body.instance_token]);
}

function handleSetId(body: SetIdRequest): SetIdResponse | { error: string; status: number } {
  if (!PEER_ID_REGEX.test(body.new_peer_id)) {
    return {
      error: "invalid peer_id (must match ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$)",
      status: 400,
    };
  }
  // Reserved names are owned by the Deck system sender; refuse them so the
  // 'deck' sentinel stays unambiguous across every group.
  if (RESERVED_PEER_IDS.includes(body.new_peer_id)) {
    return { error: `peer_id '${body.new_peer_id}' is reserved`, status: 400 };
  }
  const me = db.query(
    "SELECT peer_id, group_id FROM peers WHERE instance_token = ?"
  ).get(body.instance_token) as { peer_id: string; group_id: string } | null;
  if (!me) return { error: "instance_token not found", status: 404 };

  if (me.peer_id === body.new_peer_id) {
    return { peer_id: me.peer_id, previous: me.peer_id };
  }

  // Conflict check covers BOTH active and dormant peers in the group.
  const conflict = db.query(
    "SELECT 1 FROM peers WHERE peer_id = ? AND group_id = ? AND instance_token <> ?"
  ).get(body.new_peer_id, me.group_id, body.instance_token);
  if (conflict) {
    return {
      error: `peer_id '${body.new_peer_id}' already taken in group '${me.group_id}'`,
      status: 409,
    };
  }

  db.run("UPDATE peers SET peer_id = ? WHERE instance_token = ?", [
    body.new_peer_id,
    body.instance_token,
  ]);
  return { peer_id: body.new_peer_id, previous: me.peer_id };
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  // Filter implicitly by the caller's group_id, derived from instance_token.
  const callerRow = db.query(
    "SELECT group_id FROM peers WHERE instance_token = ?"
  ).get(body.instance_token) as { group_id: string } | null;
  if (!callerRow) return [];
  const groupId = callerRow.group_id;

  type PeerRow = Omit<Peer, "activity_status">;
  let rows: PeerRow[];
  switch (body.scope) {
    case "machine":
      rows = db.query(
        "SELECT * FROM peers WHERE group_id = ? AND status = 'active'"
      ).all(groupId) as PeerRow[];
      break;
    case "directory":
      rows = db.query(
        "SELECT * FROM peers WHERE group_id = ? AND status = 'active' AND cwd = ?"
      ).all(groupId, body.cwd) as PeerRow[];
      break;
    case "repo":
      if (body.project_key) {
        rows = db.query(
          "SELECT * FROM peers WHERE group_id = ? AND status = 'active' AND project_key = ?"
        ).all(groupId, body.project_key) as PeerRow[];
      } else if (body.git_root) {
        rows = db.query(
          "SELECT * FROM peers WHERE group_id = ? AND status = 'active' AND git_root = ?"
        ).all(groupId, body.git_root) as PeerRow[];
      } else {
        rows = db.query(
          "SELECT * FROM peers WHERE group_id = ? AND status = 'active' AND cwd = ?"
        ).all(groupId, body.cwd) as PeerRow[];
      }
      break;
    default:
      rows = [];
  }

  const now = Date.now();
  return rows
    .filter((p) => p.instance_token !== body.instance_token)
    .map((p): Peer => {
      let activity_status: Peer["activity_status"];
      if (p.status === "dormant") {
        activity_status = "closed";
      } else if (p.last_activity_at && now - new Date(p.last_activity_at).getTime() <= ACTIVITY_TIMEOUT_MS) {
        activity_status = "active";
      } else {
        activity_status = "sleep";
      }
      return { ...p, activity_status };
    });
}

function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
  const sender = db.query(
    "SELECT instance_token, peer_id, group_id, summary, host, cwd FROM peers WHERE instance_token = ?"
  ).get(body.from_token) as
    | {
        instance_token: InstanceToken;
        peer_id: string;
        group_id: GroupId;
        summary: string;
        host: string;
        cwd: string;
      }
    | null;
  if (!sender) return { ok: false, error: "Sender not registered" };

  // Operator inbox (PLAN C12): 'operator' routes to the reserved sentinel,
  // scoped to the sender's group (the Deck drains it per group). No WS pool
  // entry exists for it, so delivery is purely poll-based.
  const target =
    body.to_peer_id === OPERATOR_PEER_ID
      ? { instance_token: OPERATOR_INSTANCE_TOKEN }
      : (db.query(
          "SELECT instance_token FROM peers WHERE peer_id = ? AND group_id = ? AND status = 'active'"
        ).get(body.to_peer_id, sender.group_id) as { instance_token: InstanceToken } | null);
  if (!target) {
    return { ok: false, error: `Peer '${body.to_peer_id}' not found in your group` };
  }

  const sentAt = new Date().toISOString();
  const messageId = recordMessageTx(
    sender.instance_token,
    target.instance_token,
    sender.group_id,
    body.text,
    sentAt
  );

  // Try WebSocket push if the target is connected.
  const ws = wsPool.get(target.instance_token);
  if (ws && ws.readyState === 1) {
    try {
      ws.send(
        JSON.stringify({
          type: "message",
          id: messageId,
          from_peer_id: sender.peer_id,
          from_summary: sender.summary,
          from_host: sender.host,
          from_cwd: sender.cwd,
          text: body.text,
          sent_at: sentAt,
        })
      );
      // Do NOT markDelivered here: the WS notification is fire-and-forget.
      // delivered=0 stays until check_messages is explicitly called by the LLM.
    } catch {
      // ws.send can throw on a half-closed socket; let the polling fallback ship it.
    }
  }

  return { ok: true };
}

// Fire-and-forget WS push for a Deck announcement. Mirrors handleSendMessage's
// push but with the reserved 'deck' sender; never marks delivered.
function pushDeckMessage(
  token: InstanceToken,
  messageId: number,
  text: string,
  sentAt: string
): void {
  const ws = wsPool.get(token);
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(
      JSON.stringify({
        type: "message",
        id: messageId,
        from_peer_id: DECK_PEER_ID,
        from_summary: "",
        from_host: "",
        from_cwd: "",
        text,
        sent_at: sentAt,
      })
    );
  } catch {
    // ws.send can throw on a half-closed socket; the polling fallback ships it.
  }
}

// POST /announce: the Deck broadcasts an outbound, fire-and-forget system message
// to every ACTIVE peer in a group, from the reserved non-routable 'deck' sender.
// Peers can never reply (the sender is dormant). An optional exclude_peer_id keeps
// a just-joined peer from receiving its own join announcement.
function handleAnnounce(body: AnnounceRequest): AnnounceResponse | { error: string; status: number } {
  const groupId = body.group_id;
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return { sent: 0 };

  // Group auth: a non-default group that already exists must present the right
  // secret. A group no peer has registered yet has no members -> sent:0 below.
  if (groupId !== "default") {
    const existing = db.query(
      "SELECT secret_hash FROM groups WHERE group_id = ?"
    ).get(groupId) as { secret_hash: string | null } | null;
    if (existing && existing.secret_hash !== (body.group_secret_hash ?? null)) {
      return { error: "group_secret_hash mismatch (TOFU rejected)", status: 401 };
    }
  }

  // Targeted announce (PLAN C10): deliver to ONE active peer (the team-lead
  // notification path). Same sender/no-reply semantics; 404 surfaces a
  // missing/dormant target so the Deck can tell the operator.
  if (body.to_peer_id) {
    const target = db.query(
      "SELECT instance_token FROM peers WHERE group_id = ? AND peer_id = ? AND status = 'active'"
    ).get(groupId, body.to_peer_id) as { instance_token: InstanceToken } | null;
    if (!target) return { error: `no active peer '${body.to_peer_id}' in group`, status: 404 };
    const at = new Date().toISOString();
    const res = insertMessage.run(DECK_INSTANCE_TOKEN, target.instance_token, groupId, text, at);
    updateLastActivity.run(at, target.instance_token);
    pushDeckMessage(target.instance_token, Number(res.lastInsertRowid), text, at);
    return { sent: 1 };
  }

  const exclude = body.exclude_peer_id ?? null;
  const targets = db.query(
    `SELECT instance_token FROM peers
     WHERE group_id = ? AND status = 'active'
       AND instance_token <> ?
       AND (? IS NULL OR peer_id <> ?)`
  ).all(groupId, DECK_INSTANCE_TOKEN, exclude, exclude) as { instance_token: InstanceToken }[];

  const sentAt = new Date().toISOString();
  let sent = 0;
  for (const target of targets) {
    const result = insertMessage.run(DECK_INSTANCE_TOKEN, target.instance_token, groupId, text, sentAt);
    const messageId = Number(result.lastInsertRowid);
    sent += 1;
    updateLastActivity.run(sentAt, target.instance_token);
    pushDeckMessage(target.instance_token, messageId, text, sentAt);
  }
  return { sent };
}

function flushPendingForToken(token: InstanceToken): void {
  const ws = wsPool.get(token);
  if (!ws || ws.readyState !== 1) return;
  type MessageRow = Omit<Message, "delivered"> & { delivered: number };
  // Capped replay: only the last FLUSH_MAX_COUNT messages within FLUSH_MAX_AGE_HOURS.
  // Beyond that, the LLM can still pull the full backlog via check_messages.
  const cutoff = `-${FLUSH_MAX_AGE_HOURS} hours`;
  const rows = selectUndeliveredCapped.all(token, cutoff, FLUSH_MAX_COUNT) as MessageRow[];
  for (const row of rows) {
    const sender = db.query(
      "SELECT peer_id, summary, host, cwd FROM peers WHERE instance_token = ?"
    ).get(row.from_token) as
      | { peer_id: string; summary: string; host: string; cwd: string }
      | null;
    if (!sender) continue;
    try {
      ws.send(
        JSON.stringify({
          type: "message",
          id: row.id,
          from_peer_id: sender.peer_id,
          from_summary: sender.summary,
          from_host: sender.host,
          from_cwd: sender.cwd,
          text: row.text,
          sent_at: row.sent_at,
        })
      );
      // Do NOT markDelivered: same rationale as handleSendMessage.
    } catch {
      break;
    }
  }
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  type MessageRow = Omit<Message, "delivered"> & { delivered: number };
  const rows = selectUndelivered.all(body.instance_token) as MessageRow[];
  for (const row of rows) {
    markDelivered.run(row.id);
  }
  const messages: Message[] = rows.map((r) => ({ ...r, delivered: Boolean(r.delivered) }));
  return { messages };
}

// Like handlePollMessages but does NOT mark delivered.
// Used by the server-side fallback poll (WS down) to push mcp.notification()
// without consuming messages -- only check_messages marks delivered.
function handlePeekMessages(body: PollMessagesRequest): PollMessagesResponse {
  type MessageRow = Omit<Message, "delivered"> & { delivered: number };
  const rows = selectUndelivered.all(body.instance_token) as MessageRow[];
  return { messages: rows.map((r) => ({ ...r, delivered: Boolean(r.delivered) })) };
}

// --- Roadmap handlers (v0.4, PLAN C3) ---

const ROADMAP_KINDS: readonly RoadmapKind[] = ["feature", "bug", "debt", "idea", "chore"];
const ROADMAP_PRIORITIES: readonly RoadmapPriority[] = ["must", "should", "could", "wont"];
const ROADMAP_LEVELS: readonly RoadmapLevel[] = ["low", "medium", "high"];
const ROADMAP_STATUSES: readonly RoadmapStatus[] = [
  "idea",
  "planned",
  "in_progress",
  "done",
  "archived",
];

type RoadmapRow = Omit<RoadmapItem, "tags" | "depends_on" | "locked"> & {
  tags: string;
  depends_on: string;
  locked: number;
};

function rowToRoadmapItem(row: RoadmapRow): RoadmapItem {
  const parseList = (s: string): string[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    ...row,
    tags: parseList(row.tags),
    depends_on: parseList(row.depends_on),
    locked: row.locked === 1,
    locked_by: row.locked_by ?? null,
    locked_at: row.locked_at ?? null,
  };
}

/** Sanitize an optional string[] payload into a JSON-storable list. */
function cleanList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

function badEnum<T extends string>(value: unknown, allowed: readonly T[]): boolean {
  return value !== undefined && !allowed.includes(value as T);
}

function getRoadmapItem(id: string): RoadmapItem | null {
  const row = db.query("SELECT * FROM roadmap_items WHERE id = ?").get(id) as RoadmapRow | null;
  return row ? rowToRoadmapItem(row) : null;
}

function handleRoadmapList(
  body: RoadmapListRequest
): RoadmapListResponse | { error: string; status: number } {
  if (!body.project_key || typeof body.project_key !== "string") {
    return { error: "project_key is required", status: 400 };
  }
  if (
    badEnum(body.kind, ROADMAP_KINDS) ||
    badEnum(body.status, ROADMAP_STATUSES) ||
    badEnum(body.priority, ROADMAP_PRIORITIES)
  ) {
    return { error: "invalid kind/status/priority filter", status: 400 };
  }

  let sql = "SELECT * FROM roadmap_items WHERE project_key = ?";
  const params: string[] = [body.project_key];
  if (body.status) {
    sql += " AND status = ?";
    params.push(body.status);
  } else if (!body.include_archived) {
    sql += " AND status != 'archived'";
  }
  if (body.kind) {
    sql += " AND kind = ?";
    params.push(body.kind);
  }
  if (body.priority) {
    sql += " AND priority = ?";
    params.push(body.priority);
  }
  sql += " ORDER BY created_at, id";

  let items = (db.query(sql).all(...params) as RoadmapRow[]).map(rowToRoadmapItem);
  if (body.tag) items = items.filter((i) => i.tags.includes(body.tag as string));
  return { items };
}

function handleRoadmapUpsert(
  body: RoadmapUpsertRequest
): RoadmapUpsertResponse | { error: string; status: number } {
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "";
  if (!by) return { error: "by (author peer_id) is required", status: 400 };
  if (
    badEnum(body.kind, ROADMAP_KINDS) ||
    badEnum(body.priority, ROADMAP_PRIORITIES) ||
    badEnum(body.value, ROADMAP_LEVELS) ||
    badEnum(body.effort, ROADMAP_LEVELS) ||
    badEnum(body.status, ROADMAP_STATUSES)
  ) {
    return { error: "invalid kind/priority/value/effort/status", status: 400 };
  }
  // Queue position (PLAN C15): positive integer or null (= unqueued).
  if (
    body.queue !== undefined &&
    body.queue !== null &&
    (!Number.isInteger(body.queue) || body.queue < 1)
  ) {
    return { error: "queue must be a positive integer or null", status: 400 };
  }
  if (body.locked !== undefined && typeof body.locked !== "boolean") {
    return { error: "locked must be a boolean", status: 400 };
  }

  if (body.id) {
    // Partial patch: omitted fields keep their value; project_key never moves.
    const existing = getRoadmapItem(body.id);
    if (!existing) return { error: "unknown roadmap item", status: 404 };

    // Lock guard (PLAN K2): while an agent holds the work-lock, only the owner
    // or the operator ('deck') may write the item's status or claim the lock
    // (a same-status in_progress write IS a claim attempt). Other writes
    // (context enrichment, tags...) stay open to everyone.
    if (
      existing.locked &&
      (body.status !== undefined || body.locked === true) &&
      by !== existing.locked_by &&
      by !== "deck" &&
      body.force !== true
    ) {
      return {
        error: `item is locked by '${existing.locked_by}' (actively working on it) -- pick another item, or pass force:true if you are certain`,
        status: 409,
      };
    }

    const next: RoadmapItem = {
      ...existing,
      kind: body.kind ?? existing.kind,
      title: body.title !== undefined ? body.title.trim() : existing.title,
      description: body.description ?? existing.description,
      rationale: body.rationale ?? existing.rationale,
      context: body.context ?? existing.context,
      priority: body.priority ?? existing.priority,
      value: body.value ?? existing.value,
      effort: body.effort ?? existing.effort,
      status: body.status ?? existing.status,
      tags: cleanList(body.tags) ?? existing.tags,
      depends_on: cleanList(body.depends_on) ?? existing.depends_on,
      queue: body.queue !== undefined ? body.queue : existing.queue,
      updated_by: by,
    };
    if (!next.title) return { error: "title cannot be empty", status: 400 };

    // Work-lock resolution (PLAN K2). Leaving in_progress always releases the
    // lock. While in_progress: an explicit `locked` wins; otherwise a non-'deck'
    // author WRITING status=in_progress claims the lock (the Deck's own
    // in_progress writes never lock -- the item is "submitted", the lock arrives
    // when the agent actually starts). A same-owner re-claim keeps locked_at.
    let locked = existing.locked;
    let lockedBy = existing.locked_by;
    if (next.status !== "in_progress") {
      locked = false;
    } else if (body.locked !== undefined) {
      locked = body.locked;
      if (body.locked) lockedBy = by;
    } else if (body.status === "in_progress" && by !== "deck" && !existing.locked) {
      locked = true;
      lockedBy = by;
    }
    if (!locked) lockedBy = null;
    const keptLockedAt =
      locked && existing.locked && existing.locked_by === lockedBy ? existing.locked_at : null;

    // A status change away from 'archived' restores the item (clears the soft
    // delete); archiving through upsert stamps it like /roadmap/archive does.
    db.run(
      `UPDATE roadmap_items SET
         kind = ?, title = ?, description = ?, rationale = ?, context = ?, priority = ?,
         value = ?, effort = ?, status = ?, tags = ?, depends_on = ?, queue = ?,
         locked = ?, locked_by = ?,
         locked_at = CASE WHEN ? = 0 THEN NULL ELSE COALESCE(?, datetime('now')) END,
         updated_by = ?, updated_at = datetime('now'),
         deleted_at = CASE
           WHEN ? = 'archived' THEN COALESCE(deleted_at, datetime('now'))
           ELSE NULL
         END
       WHERE id = ?`,
      [
        next.kind,
        next.title,
        next.description,
        next.rationale,
        next.context,
        next.priority,
        next.value,
        next.effort,
        next.status,
        JSON.stringify(next.tags),
        JSON.stringify(next.depends_on),
        next.queue,
        locked ? 1 : 0,
        lockedBy,
        locked ? 1 : 0,
        keptLockedAt,
        next.updated_by,
        next.status,
        body.id,
      ]
    );
    return { item: getRoadmapItem(body.id)! };
  }

  // Create.
  const projectKey = typeof body.project_key === "string" ? body.project_key.trim() : "";
  if (!projectKey) return { error: "project_key is required", status: 400 };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return { error: "title is required", status: 400 };
  if (body.status === "archived") {
    return { error: "cannot create an item directly archived", status: 400 };
  }

  // An item born in_progress from an agent is locked from the start (PLAN K2).
  const createStatus = body.status ?? "idea";
  const createLocked =
    createStatus === "in_progress" && (body.locked === true || (body.locked !== false && by !== "deck"));

  const id = randomUUID();
  db.run(
    `INSERT INTO roadmap_items
       (id, project_key, kind, title, description, rationale, context, priority, value,
        effort, status, tags, depends_on, created_by, updated_by,
        created_at, updated_at, deleted_at, queue, locked, locked_by, locked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL, ?, ?, ?,
             CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END)`,
    [
      id,
      projectKey,
      body.kind ?? "feature",
      title,
      body.description ?? "",
      body.rationale ?? "",
      body.context ?? "",
      body.priority ?? "could",
      body.value ?? "medium",
      body.effort ?? "medium",
      createStatus,
      JSON.stringify(cleanList(body.tags) ?? []),
      JSON.stringify(cleanList(body.depends_on) ?? []),
      by,
      by,
      body.queue ?? null,
      createLocked ? 1 : 0,
      createLocked ? by : null,
      createLocked ? 1 : 0,
    ]
  );
  return { item: getRoadmapItem(id)! };
}

function handleRoadmapArchive(
  body: RoadmapArchiveRequest
): RoadmapArchiveResponse | { error: string; status: number } {
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "";
  if (!by) return { error: "by (author peer_id) is required", status: 400 };
  if (!body.id) return { error: "id is required", status: 400 };
  const existing = getRoadmapItem(body.id);
  if (!existing) return { error: "unknown roadmap item", status: 404 };

  // Same lock guard as upsert (PLAN K2): archiving is a status change.
  if (existing.locked && by !== existing.locked_by && by !== "deck") {
    return {
      error: `item is locked by '${existing.locked_by}' (actively working on it) -- cannot archive`,
      status: 409,
    };
  }

  db.run(
    `UPDATE roadmap_items SET
       status = 'archived',
       deleted_at = COALESCE(deleted_at, datetime('now')),
       locked = 0, locked_by = NULL, locked_at = NULL,
       updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [by, body.id]
  );
  return { item: getRoadmapItem(body.id)! };
}

/** Full export of a project's roadmap (archived included) for backup/migration. */
function handleRoadmapExport(projectKey: string): {
  project_key: string;
  exported_at: string;
  items: RoadmapItem[];
} {
  const rows = db
    .query("SELECT * FROM roadmap_items WHERE project_key = ? ORDER BY created_at, id")
    .all(projectKey) as RoadmapRow[];
  return {
    project_key: projectKey,
    exported_at: new Date().toISOString(),
    items: rows.map(rowToRoadmapItem),
  };
}

/**
 * Bulk import (INSERT OR REPLACE) of exported items, preserving ids, statuses,
 * authors and timestamps -- the migration path between a local broker and a
 * central one. Every item is re-keyed to the given project_key.
 */
function handleRoadmapImport(body: {
  project_key?: string;
  items?: unknown;
}): { imported: number } | { error: string; status: number } {
  const projectKey =
    typeof body.project_key === "string" && body.project_key.trim() ? body.project_key.trim() : "";
  if (!projectKey) return { error: "project_key is required", status: 400 };
  if (!Array.isArray(body.items)) return { error: "items must be an array", status: 400 };

  const items = body.items as Partial<RoadmapItem>[];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (
      typeof it.id !== "string" ||
      !it.id.trim() ||
      typeof it.title !== "string" ||
      !it.title.trim() ||
      badEnum(it.kind, ROADMAP_KINDS) ||
      it.kind === undefined ||
      badEnum(it.priority, ROADMAP_PRIORITIES) ||
      badEnum(it.value, ROADMAP_LEVELS) ||
      badEnum(it.effort, ROADMAP_LEVELS) ||
      badEnum(it.status, ROADMAP_STATUSES)
    ) {
      return { error: `invalid item at index ${i}`, status: 400 };
    }
  }

  const insert = db.prepare(
    `INSERT OR REPLACE INTO roadmap_items
       (id, project_key, kind, title, description, rationale, context, priority, value,
        effort, status, tags, depends_on, created_by, updated_by,
        created_at, updated_at, deleted_at, queue)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const importAll = db.transaction((rows: Partial<RoadmapItem>[]) => {
    for (const it of rows) {
      insert.run(
        it.id!.trim(),
        projectKey,
        it.kind!,
        it.title!.trim(),
        it.description ?? "",
        it.rationale ?? "",
        it.context ?? "",
        it.priority ?? "could",
        it.value ?? "medium",
        it.effort ?? "medium",
        it.status ?? "idea",
        JSON.stringify(cleanList(it.tags) ?? []),
        JSON.stringify(cleanList(it.depends_on) ?? []),
        it.created_by ?? "",
        it.updated_by ?? "",
        it.created_at ?? new Date().toISOString(),
        it.updated_at ?? new Date().toISOString(),
        it.deleted_at ?? null,
        typeof it.queue === "number" && Number.isInteger(it.queue) && it.queue >= 1
          ? it.queue
          : null
      );
    }
  });
  importAll(items);
  return { imported: items.length };
}

/**
 * Drain the operator inbox of a group (PLAN C12): messages agents sent to the
 * reserved 'operator' sentinel. Same TOFU group auth as /announce. Returned
 * messages are marked delivered (the Deck displays and keeps them locally).
 */
function handleOperatorInbox(
  body: OperatorInboxRequest
): OperatorInboxResponse | { error: string; status: number } {
  const groupId = body.group_id;
  if (!groupId) return { error: "group_id is required", status: 400 };
  if (groupId !== "default") {
    const existing = db.query(
      "SELECT secret_hash FROM groups WHERE group_id = ?"
    ).get(groupId) as { secret_hash: string | null } | null;
    if (existing && existing.secret_hash !== (body.group_secret_hash ?? null)) {
      return { error: "group_secret_hash mismatch (TOFU rejected)", status: 401 };
    }
  }
  const rows = db.query(
    `SELECT m.id, m.text, m.sent_at, COALESCE(p.peer_id, '<gone>') AS from_peer_id
     FROM messages m LEFT JOIN peers p ON p.instance_token = m.from_token
     WHERE m.to_token = ? AND m.group_id = ? AND m.delivered = 0
     ORDER BY m.id`
  ).all(OPERATOR_INSTANCE_TOKEN, groupId) as OperatorInboxMessage[];
  for (const row of rows) markDelivered.run(row.id);
  return { messages: rows };
}

// --- Graph drafts (agent-escalated questions for the Deck's graph view) ---

type GraphDraftRow = {
  id: string;
  project_key: string;
  from_peer: string;
  title: string;
  prompt: string;
  status: GraphDraftStatus;
  created_at: string;
  opened_at: string | null;
};

function rowToGraphDraft(row: GraphDraftRow): GraphDraft {
  return { ...row };
}

function handleGraphDraftAdd(
  body: GraphDraftAddRequest
): GraphDraftAddResponse | { error: string; status: number } {
  if (!body.project_key || typeof body.project_key !== "string") {
    return { error: "project_key is required", status: 400 };
  }
  const payload = validateDraftPayload(body);
  if ("error" in payload) return { error: payload.error, status: 400 };
  const draft: GraphDraft = {
    id: randomUUID(),
    project_key: body.project_key,
    from_peer: typeof body.by === "string" ? body.by.slice(0, 128) : "",
    title: payload.title,
    prompt: payload.prompt,
    status: "pending",
    created_at: new Date().toISOString(),
    opened_at: null,
  };
  db.run(
    `INSERT INTO graph_drafts (id, project_key, from_peer, title, prompt, status, created_at, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [draft.id, draft.project_key, draft.from_peer, draft.title, draft.prompt, draft.status, draft.created_at, draft.opened_at]
  );
  return { draft };
}

function handleGraphDraftList(
  body: GraphDraftListRequest
): GraphDraftListResponse | { error: string; status: number } {
  if (!body.project_key || typeof body.project_key !== "string") {
    return { error: "project_key is required", status: 400 };
  }
  let sql = "SELECT * FROM graph_drafts WHERE project_key = ?";
  if (!body.include_opened) sql += " AND status = 'pending'";
  sql += " ORDER BY created_at, id";
  const rows = db.query(sql).all(body.project_key) as GraphDraftRow[];
  return { drafts: rows.map(rowToGraphDraft) };
}

function handleGraphDraftOpen(
  body: GraphDraftOpenRequest
): GraphDraftOpenResponse | { error: string; status: number } {
  if (!body.id || typeof body.id !== "string") {
    return { error: "id is required", status: 400 };
  }
  const row = db.query("SELECT * FROM graph_drafts WHERE id = ?").get(body.id) as GraphDraftRow | null;
  if (!row) return { error: "unknown graph draft", status: 404 };
  if (row.status !== "opened") {
    db.run("UPDATE graph_drafts SET status = 'opened', opened_at = ? WHERE id = ?", [
      new Date().toISOString(),
      row.id,
    ]);
  }
  const fresh = db.query("SELECT * FROM graph_drafts WHERE id = ?").get(body.id) as GraphDraftRow;
  return { draft: rowToGraphDraft(fresh) };
}

function handleGroupStats(): GroupStatsResponse {
  const rows = db.query(
    "SELECT group_id, COUNT(*) AS active_peers FROM peers WHERE status = 'active' GROUP BY group_id"
  ).all() as { group_id: GroupId; active_peers: number }[];
  return { groups: rows };
}

// --- WebSocket pool (instance_token -> live socket) ---

type WsData = { instance_token: InstanceToken | null };
const wsPool = new Map<InstanceToken, import("bun").ServerWebSocket<WsData>>();

// --- HTTP + WebSocket server ---

// Returns a 401 Response if BROKER_TOKEN is configured and the request lacks a valid
// "Authorization: Bearer <token>" header. Returns null when auth passes or is disabled.
// /health is always exempt so monitoring tools can reach it without credentials.
function unauthorizedIfToken(req: Request): Response | null {
  if (!BROKER_TOKEN) return null;
  if (req.headers.get("Authorization") === `Bearer ${BROKER_TOKEN}`) return null;
  return new Response("Unauthorized", { status: 401 });
}

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: BIND_HOST,
  websocket: {
    idleTimeout: WS_IDLE_TIMEOUT_SEC,
    open(ws) {
      // The auth handshake happens in the first message frame.
      // Until then, the socket is not in the pool.
    },
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      let frame: { type?: string; instance_token?: string };
      try { frame = JSON.parse(text); } catch { ws.close(1003, "invalid frame"); return; }
      if (frame.type !== "auth" || !frame.instance_token) {
        ws.close(1008, "expected auth frame");
        return;
      }
      const ok = db.query(
        "SELECT 1 FROM peers WHERE instance_token = ? AND status = 'active'"
      ).get(frame.instance_token);
      if (!ok) {
        ws.close(1008, "unknown or inactive instance_token");
        return;
      }
      ws.data.instance_token = frame.instance_token;
      wsPool.set(frame.instance_token, ws);
      flushPendingForToken(frame.instance_token);
    },
    close(ws) {
      const token = ws.data.instance_token;
      if (token && wsPool.get(token) === ws) wsPool.delete(token);
    },
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path !== "/health") {
      const deny = unauthorizedIfToken(req);
      if (deny) return deny;
    }

    if (path === "/ws") {
      if (server.upgrade(req, { data: { instance_token: null } as WsData })) {
        return undefined;
      }
      return new Response("ws upgrade failed", { status: 400 });
    }

    if (req.method !== "POST") {
      if (path === "/health") {
        const total = (db.query("SELECT COUNT(*) AS n FROM peers WHERE status = 'active'")
          .get() as { n: number }).n;
        return Response.json({ status: "ok", peers: total, ws_clients: wsPool.size });
      }
      if (path === "/group-stats") {
        return Response.json(handleGroupStats());
      }
      if (path === "/admin/peers") {
        const includeDormant = url.searchParams.get("include_dormant") === "1";
        const sql = includeDormant
          ? "SELECT * FROM peers ORDER BY group_id, peer_id"
          : "SELECT * FROM peers WHERE status = 'active' ORDER BY group_id, peer_id";
        const rows = db.query(sql).all() as Peer[];
        return Response.json(rows);
      }
      if (path === "/roadmap/export") {
        const pk = url.searchParams.get("project_key") ?? "";
        if (!pk) return Response.json({ error: "project_key is required" }, { status: 400 });
        return Response.json(handleRoadmapExport(pk));
      }
      if (path === "/admin/purge-messages") {
        // Manual trigger for the TTL sweep (also runs at boot + every PURGE_INTERVAL_SEC).
        // Returns the number of rows deleted. Used by tests and for ad-hoc cleanup.
        const result = purgeOldMessages();
        return Response.json({
          purged: result.messages,
          purged_drafts: result.drafts,
          cutoff_days: MESSAGE_TTL_DAYS,
          draft_cutoff_days: GRAPH_DRAFT_TTL_DAYS,
        });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register": {
          const result = handleRegister(body as RegisterRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/disconnect":
          handleDisconnect(body as DisconnectRequest);
          return Response.json({ ok: true });
        case "/unregister":
          handleUnregister(body as UnregisterRequest);
          return Response.json({ ok: true });
        case "/set-id": {
          const result = handleSetId(body as SetIdRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/announce": {
          const result = handleAnnounce(body as AnnounceRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/operator-inbox": {
          const result = handleOperatorInbox(body as OperatorInboxRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/list": {
          const result = handleRoadmapList(body as RoadmapListRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/upsert": {
          const result = handleRoadmapUpsert(body as RoadmapUpsertRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/import": {
          const result = handleRoadmapImport(body as { project_key?: string; items?: unknown });
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/archive": {
          const result = handleRoadmapArchive(body as RoadmapArchiveRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/graph-draft/add": {
          const result = handleGraphDraftAdd(body as GraphDraftAddRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/graph-draft/list": {
          const result = handleGraphDraftList(body as GraphDraftListRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/graph-draft/open": {
          const result = handleGraphDraftOpen(body as GraphDraftOpenRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/peek-messages":
          return Response.json(handlePeekMessages(body as PollMessagesRequest));
        case "/group-stats":
          return Response.json(handleGroupStats());
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The client only gets the message; keep the stack on the broker side.
      log.error(`request ${url.pathname} failed with 500`, e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

log.info(
  `[claude-peers broker v0.9.0] listening on ${BIND_HOST}:${PORT} ` +
  `(db: ${DB_PATH}, dormant_ttl=${DORMANT_TTL_HOURS}h, msg_ttl=${MESSAGE_TTL_DAYS}d, draft_ttl=${GRAPH_DRAFT_TTL_DAYS}d, ` +
  `flush_cap=${FLUSH_MAX_COUNT}/${FLUSH_MAX_AGE_HOURS}h, purge_interval=${PURGE_INTERVAL_SEC}s, ` +
  `activity_timeout=${ACTIVITY_TIMEOUT_MS / 1000}s, ws_idle=${WS_IDLE_TIMEOUT_SEC}s, ` +
  `active_stale=${ACTIVE_STALE_SEC}s, sweep_interval=${SWEEP_INTERVAL_SEC}s, ` +
  `lock_ttl=${LOCK_TTL_SEC}s, lock_grace=${LOCK_GRACE_SEC}s, ` +
  `auth=${BROKER_TOKEN ? "token" : "none"})`
);
