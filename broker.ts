#!/usr/bin/env bun
/**
 * claude-peers broker daemon (v0.3.4)
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
  Peer,
  Message,
  GroupId,
  InstanceToken,
} from "./shared/types.ts";
import {
  DECK_INSTANCE_TOKEN,
  DECK_PEER_ID,
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

try {
  mkdirSync(dirname(DB_PATH), { recursive: true });
} catch {
  // best-effort
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
  if (!msg.includes("duplicate column name")) console.error(`[broker] migration: ${msg}`);
}

// Migration: add claude_cli_pid column (idempotent)
// PID of the Claude Code CLI process (process.ppid of server.ts) -- used by
// the SessionEnd hook to mark a peer dormant without an instance_token.
try {
  db.run("ALTER TABLE peers ADD COLUMN claude_cli_pid INTEGER");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) console.error(`[broker] migration: ${msg}`);
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
    deleted_at TEXT
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_roadmap_project ON roadmap_items(project_key, status)`);

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
       AND instance_token <> ?`
  ).all(cutoff, DECK_INSTANCE_TOKEN) as { instance_token: string }[];
  for (const { instance_token } of expired) {
    // Must clear BOTH FK directions before deleting the peer row:
    // messages.from_token and messages.to_token both reference peers(instance_token).
    db.run("DELETE FROM messages WHERE from_token = ? OR to_token = ?", [instance_token, instance_token]);
    db.run("DELETE FROM peer_sessions WHERE instance_token = ?", [instance_token]);
    db.run("DELETE FROM peers WHERE instance_token = ?", [instance_token]);
  }
}

cleanStalePeers();
setInterval(cleanStalePeers, CLEAN_INTERVAL_MS);

// --- Heartbeat-staleness sweep (active_stale_sec) ---

function sweepInactivePeers(): void {
  const cutoff = new Date(Date.now() - ACTIVE_STALE_SEC * 1000).toISOString();
  db.run(
    "UPDATE peers SET status = 'dormant' WHERE status = 'active' AND last_seen < ?",
    [cutoff]
  );
}
setInterval(sweepInactivePeers, SWEEP_INTERVAL_SEC * 1000);

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

function purgeOldMessages(): void {
  const cutoff = `-${MESSAGE_TTL_DAYS} days`;
  const result = purgeOldUndeliveredStmt.run(cutoff);
  if (result.changes > 0) {
    console.error(
      `[claude-peers broker] purged ${result.changes} stale undelivered messages (>${MESSAGE_TTL_DAYS}d)`
    );
  }
}
purgeOldMessages();
setInterval(purgeOldMessages, PURGE_INTERVAL_SEC * 1000);

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
      console.error(
        `[broker] session_key collision: existing active peer ${existingPeer.peer_id} keeps the session, minting new peer`
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

  const target = db.query(
    "SELECT instance_token FROM peers WHERE peer_id = ? AND group_id = ? AND status = 'active'"
  ).get(body.to_peer_id, sender.group_id) as { instance_token: InstanceToken } | null;
  if (!target) {
    return { ok: false, error: `Peer '${body.to_peer_id}' not found in your group` };
  }

  const sentAt = new Date().toISOString();
  const result = insertMessage.run(
    sender.instance_token,
    target.instance_token,
    sender.group_id,
    body.text,
    sentAt
  );
  const messageId = Number(result.lastInsertRowid);

  updateLastActivity.run(sentAt, sender.instance_token);
  updateLastActivity.run(sentAt, target.instance_token);

  // Heuristic ack: the sender has necessarily read everything addressed to it in
  // this group before sent_at (otherwise it could not be replying now). Mark
  // those as delivered=1 so the next WS reconnect does not avalanche the backlog.
  ackPriorMessagesForSender.run(sender.instance_token, sender.group_id, sentAt);

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

type RoadmapRow = Omit<RoadmapItem, "tags" | "depends_on"> & { tags: string; depends_on: string };

function rowToRoadmapItem(row: RoadmapRow): RoadmapItem {
  const parseList = (s: string): string[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return { ...row, tags: parseList(row.tags), depends_on: parseList(row.depends_on) };
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

  if (body.id) {
    // Partial patch: omitted fields keep their value; project_key never moves.
    const existing = getRoadmapItem(body.id);
    if (!existing) return { error: "unknown roadmap item", status: 404 };

    const next: RoadmapItem = {
      ...existing,
      kind: body.kind ?? existing.kind,
      title: body.title !== undefined ? body.title.trim() : existing.title,
      description: body.description ?? existing.description,
      rationale: body.rationale ?? existing.rationale,
      priority: body.priority ?? existing.priority,
      value: body.value ?? existing.value,
      effort: body.effort ?? existing.effort,
      status: body.status ?? existing.status,
      tags: cleanList(body.tags) ?? existing.tags,
      depends_on: cleanList(body.depends_on) ?? existing.depends_on,
      updated_by: by,
    };
    if (!next.title) return { error: "title cannot be empty", status: 400 };

    // A status change away from 'archived' restores the item (clears the soft
    // delete); archiving through upsert stamps it like /roadmap/archive does.
    db.run(
      `UPDATE roadmap_items SET
         kind = ?, title = ?, description = ?, rationale = ?, priority = ?,
         value = ?, effort = ?, status = ?, tags = ?, depends_on = ?,
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
        next.priority,
        next.value,
        next.effort,
        next.status,
        JSON.stringify(next.tags),
        JSON.stringify(next.depends_on),
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

  const id = randomUUID();
  db.run(
    `INSERT INTO roadmap_items
       (id, project_key, kind, title, description, rationale, priority, value,
        effort, status, tags, depends_on, created_by, updated_by,
        created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL)`,
    [
      id,
      projectKey,
      body.kind ?? "feature",
      title,
      body.description ?? "",
      body.rationale ?? "",
      body.priority ?? "could",
      body.value ?? "medium",
      body.effort ?? "medium",
      body.status ?? "idea",
      JSON.stringify(cleanList(body.tags) ?? []),
      JSON.stringify(cleanList(body.depends_on) ?? []),
      by,
      by,
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

  db.run(
    `UPDATE roadmap_items SET
       status = 'archived',
       deleted_at = COALESCE(deleted_at, datetime('now')),
       updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [by, body.id]
  );
  return { item: getRoadmapItem(body.id)! };
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
      if (path === "/admin/purge-messages") {
        // Manual trigger for the TTL sweep (also runs at boot + every PURGE_INTERVAL_SEC).
        // Returns the number of rows deleted. Used by tests and for ad-hoc cleanup.
        const cutoff = `-${MESSAGE_TTL_DAYS} days`;
        const result = purgeOldUndeliveredStmt.run(cutoff);
        return Response.json({ purged: result.changes, cutoff_days: MESSAGE_TTL_DAYS });
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
        case "/roadmap/archive": {
          const result = handleRoadmapArchive(body as RoadmapArchiveRequest);
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
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(
  `[claude-peers broker v0.3.4] listening on ${BIND_HOST}:${PORT} ` +
  `(db: ${DB_PATH}, dormant_ttl=${DORMANT_TTL_HOURS}h, msg_ttl=${MESSAGE_TTL_DAYS}d, ` +
  `flush_cap=${FLUSH_MAX_COUNT}/${FLUSH_MAX_AGE_HOURS}h, purge_interval=${PURGE_INTERVAL_SEC}s, ` +
  `activity_timeout=${ACTIVITY_TIMEOUT_MS / 1000}s, ws_idle=${WS_IDLE_TIMEOUT_SEC}s, ` +
  `active_stale=${ACTIVE_STALE_SEC}s, sweep_interval=${SWEEP_INTERVAL_SEC}s, ` +
  `auth=${BROKER_TOKEN ? "token" : "none"})`
);
