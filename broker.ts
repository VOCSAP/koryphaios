#!/usr/bin/env bun
/**
 * Singleton HTTP server on 127.0.0.1:<port>, SQLite-backed.
 * Persists session identity across reconnects and routes messages between
 * grouped peers.
 */

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { brokerMode, isLoopbackBrokerUrl, loadConfig, upstreamUrl } from "./shared/config.ts";
import { createLogger, coreLogDir } from "./shared/logger.ts";
import { validateProjectKey } from "./shared/project-key.ts";
import { loadOrCreateSecretKey, openSecret, sealSecret, secretHint } from "./shared/secret-box.ts";
import { NotificationRegistry, type RegistryStore } from "./notify/registry.ts";
import { TelegramChannel } from "./notify/telegram.ts";
import { DiscordChannel } from "./notify/discord.ts";
import { NtfyChannel, type NtfyConfig } from "./notify/ntfy.ts";
import {
  encodePairingPayload,
  isValidTopic,
  normalizeNtfyServer,
  NTFY_TOPIC_HEX_LEN,
} from "./notify/ntfy-protocol.ts";
import type {
  ChannelBinding,
  ChannelHost,
  ChannelKind,
  NotificationChannel,
} from "./notify/types.ts";
import { validateDraftPayload } from "./shared/graph-draft.ts";
import {
  resolveProvenGraphDraftPeer,
  isGraphDraftAuthError,
  type GraphDraftScopeDeps,
  type GraphDraftPeerRow,
} from "./shared/graph-draft-scope.ts";
import { planRoadmapAppendText, ROADMAP_APPEND_RESULT_MAX_CHARS } from "./shared/roadmap-append.ts";
import {
  contentEquals,
  mergeReopen,
  parseSyncContent,
  pickSyncContent,
} from "./shared/roadmap-sync.ts";
import {
  resolveRoadmapLock,
  refusesInactiveClaim,
  refusesInactiveToggle,
  refusesParkedArchive,
  isParked,
  matchesLockOwner,
  resolveLockedGroup,
  resolveLockedByToken,
  resolveKeptLockedAt,
} from "./shared/roadmap-lock.ts";
import {
  APPROVAL_ANSWER_KINDS,
  APPROVAL_VIAS,
  APPROVAL_WAIT_MAX_SEC,
  deriveOperatorId,
  deriveTokenId,
  isOperationAllowed,
  sanitizeAnswerForPty,
  validateApprovalDraft,
  verifyAuthProof,
  type ApprovalOperation,
} from "./shared/approval.ts";
import {
  createApprovalAuth,
  approvalWhere,
  approvalTileWhere,
  stampInsert,
  assertStampSessionRef,
  isAuthError,
  type ApprovalScope,
} from "./shared/approval-scope.ts";
// Card bf76d37f: the dispatch outcome is written by the Deck and READ BACK by
// an agent, so it crosses the same boundary as an approval answer and gets the
// same flattening. shared/text.ts is the dependency-free leaf (shared/approval.ts
// pulls node:crypto), which is why these two live there.
import { stripControl, truncate } from "./shared/text.ts";
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
  RoadmapDirective,
  RoadmapFacetBucket,
  RoadmapFacets,
  RoadmapItem,
  RoadmapKind,
  RoadmapLevel,
  RoadmapListRequest,
  RoadmapListResponse,
  RoadmapLockParkRequest,
  RoadmapLockParkResponse,
  RoadmapLockReleaseRequest,
  RoadmapLockReleaseResponse,
  RoadmapPriority,
  RoadmapReorderRequest,
  RoadmapReorderResponse,
  RoadmapStatus,
  RoadmapUpsertRequest,
  RoadmapUpsertResponse,
  RoadmapContextAppendRequest,
  RoadmapContextAppendResponse,
  GraphDraft,
  GraphDraftAddRequest,
  GraphDraftAddResponse,
  GraphDraftListRequest,
  GraphDraftListResponse,
  GraphDraftOpenRequest,
  GraphDraftOpenResponse,
  GraphDraftStatus,
  DispatchRequest,
  DispatchRequestAddRequest,
  DispatchRequestAddResponse,
  DispatchRequestListRequest,
  DispatchRequestListResponse,
  DispatchRequestOutcome,
  DispatchRequestResolveRequest,
  DispatchRequestResolveResponse,
  DispatchRequestStatus,
  DispatchedCard,
  Approval,
  ApprovalAddRequest,
  ApprovalAddResponse,
  ApprovalAuthProof,
  ApprovalClaimRequest,
  ApprovalClaimResponse,
  ApprovalDeliveredRequest,
  ApprovalDeliveredResponse,
  ApprovalListRequest,
  ApprovalListResponse,
  ApprovalReplyRoute,
  ApprovalStatus,
  ApprovalTokenMintRequest,
  ApprovalTokenMintResponse,
  ApprovalTokenRevokeRequest,
  ApprovalTokenRevokeResponse,
  ApprovalVia,
  ApprovalWaitRequest,
  ApprovalWaitResponse,
  OperatorInboxRequest,
  OperatorInboxResponse,
  OperatorInboxMessage,
  OperatorInboxPurgeRequest,
  OperatorInboxPurgeResponse,
  Peer,
  PublicPeer,
  Message,
  DeliveredMessage,
  GroupId,
  InstanceToken,
  RoadmapLockScope,
  RoadmapSyncConflict,
  RoadmapSyncConflictsRequest,
  RoadmapSyncConflictsResponse,
  RoadmapSyncContent,
  RoadmapSyncLockClaimResponse,
  RoadmapSyncLockReleaseResponse,
  RoadmapSyncLockRequest,
  RoadmapSyncPullRequest,
  RoadmapSyncPullResponse,
  RoadmapSyncPushConflict,
  RoadmapSyncPushItem,
  RoadmapSyncPushRequest,
  RoadmapSyncPushResponse,
  RoadmapSyncResolveRequest,
  RoadmapSyncResolveResponse,
  RoadmapSyncRow,
  RoadmapSyncState,
  RoadmapSyncStatus,
} from "./shared/types.ts";
import {
  DECK_INSTANCE_TOKEN,
  DECK_PEER_ID,
  OPERATOR_INSTANCE_TOKEN,
  OPERATOR_PEER_ID,
  RESERVED_PEER_IDS,
  ROADMAP_IMPORT_COLUMNS,
  ROADMAP_SYNC_CONTENT_FIELDS,
  type RoadmapImportColumn,
  isSentinelInstanceToken,
  SENTINEL_DEFINITIONS,
  SENTINEL_INSTANCE_TOKENS,
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
// Card a2f61172: deliberately a SEPARATE constant from PEER_ID_REGEX even
// though the pattern is identical today -- widening one must never widen
// the other, since peer_id and role are different fields with different
// authorization consequences.
const ROLE_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
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
// Card aaf4537d: a PARKED card (Pause stop) is immune to the two clauses
// above for up to this long -- its own, dedicated env var, never mixed with
// LOCK_TTL_SEC/LOCK_GRACE_SEC (a park is an operator's 24h decision, not an
// ordinary staleness timeout). Default 86400s (24h).
const LOCK_PARK_TTL_SEC = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_LOCK_PARK_TTL_SEC ?? "86400", 10)
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
// A dead-session cutoff for operator_inbox_sessions GC (Courrier lot 1C, card
// 1e81ee7b). 5 minutes (30 missed polls at the Deck's INBOX_POLL_MS = 10_000,
// desktop/src/main/index.ts) turned out too short: a SLEEPING (not dead)
// machine misses it in minutes while its Deck and agents are still alive,
// and a reaped session re-seeds at MAX(id), losing its own unread backlog on
// its next poll. 24h aligns with the dormant-peer retention window instead
// -- long enough for sleep/suspend, short enough to still reap Decks that
// are actually gone.
const OPERATOR_INBOX_SESSION_TTL_MIN = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_OPERATOR_INBOX_SESSION_TTL_MIN ?? "1440", 10)
);
const PURGE_INTERVAL_SEC = Math.max(
  60,
  parseInt(process.env.CLAUDE_PEERS_PURGE_INTERVAL_SEC ?? "3600", 10)
);

// Replication (DESIGN-OFFLINE-REPLICA). BROKER_MODE is read from the ONE
// function that decides it, so the broker and its clients cannot disagree on
// the deployment shape; UPSTREAM_URL is non-null only in replica mode.
const BROKER_MODE = brokerMode(config);
const UPSTREAM_URL = upstreamUrl(config);
// Cadence of the replication pass. Floored at 200 ms: a lower value would
// spend the broker's time on round-trips rather than on serving its clients.
const SYNC_TICK_MS = Math.max(
  200,
  parseInt(process.env.CLAUDE_PEERS_SYNC_TICK_MS ?? "5000", 10)
);
// Ceiling of a pull page, applied to the caller's `limit` as well as used as
// its default.
const SYNC_PULL_LIMIT_MAX = 500;
// Rows pushed per pass: an offline burst is drained over several passes rather
// than in one long series of round-trips that would delay the next pull.
const SYNC_PUSH_BATCH = 50;
// Failure backoff ceiling, and the number of consecutive failures that flips
// the online state to offline (one success flips it back).
const SYNC_BACKOFF_MAX_MS = 60_000;
const SYNC_OFFLINE_AFTER_FAILURES = 2;

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

// Replicating on ONESELF is a configuration error, not a case to tolerate: the
// pass would pull its own rows back and every card would look conflicted.
// The check is "is this me", not "is this loopback": two brokers on one machine
// (an upstream and its replica, the shape the replica test suite runs) are a
// legitimate topology, and a replica refuses to SERVE the upstream sync routes
// anyway, so no cycle can form.
if (BROKER_MODE === "replica") {
  if (!UPSTREAM_URL) {
    log.error("replica mode is on but broker_url is empty -- nothing to replicate against, exiting");
    process.exit(1);
  }
  let upstreamPort: number | null = null;
  try {
    const parsed = new URL(UPSTREAM_URL);
    upstreamPort = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
    if (isLoopbackBrokerUrl(UPSTREAM_URL) && upstreamPort === PORT) {
      log.error(
        `replica mode points at this very broker (${UPSTREAM_URL}) -- set broker_url to the remote broker, exiting`
      );
      process.exit(1);
    }
  } catch (e) {
    log.error(`replica mode has an unparsable broker_url (${UPSTREAM_URL}), exiting`, e);
    process.exit(1);
  }
}

/**
 * setInterval wrapper for the maintenance timers: they run outside the HTTP
 * handler's try/catch, so a transient SQLite error (SQLITE_BUSY, disk full)
 * must skip the iteration -- not kill the daemon.
 */
/**
 * Constant-time string comparison (M-SEC-1). The bearer broker_token and every
 * group_secret_hash are compared with this so a byte-by-byte timing oracle
 * cannot recover them over the network in HTTP mode. null inputs compare by
 * identity (both null → equal, the default-group case); differing lengths run a
 * fixed-cost compare so timing does not leak which byte diverged.
 */
function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // keep the cost independent of the length mismatch
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// Single source of truth for whether a group is TOFU-exempt: shared/config.ts
// only reflects this assumption on well-behaved clients, so the broker still
// enforces it itself rather than trusting the client side.
function isTofuExemptGroup(groupId: string): boolean {
  return groupId === "default";
}

/**
 * A TOFU-exempt group pins no secret, so the operator inbox -- its only
 * confidential payload -- is refused there rather than authenticated: pinning a
 * secret to authenticate it would break the zero-config rendezvous that makes
 * the group exempt in the first place.
 */
function groupMayCarryOperatorInbox(groupId: string): boolean {
  return !isTofuExemptGroup(groupId);
}

/**
 * Shared TOFU check for a group that already exists (used by /announce and
 * /operator-inbox, which only ever READ the pinned secret). /register is the
 * odd one out -- it also PINS the secret on first sight -- so it keeps its own
 * inline existing/insert branch but shares isTofuExemptGroup's exemption.
 */
function checkGroupSecret(
  groupId: string,
  providedHash: string | null
): { error: string; status: number } | null {
  if (isTofuExemptGroup(groupId)) return null;
  const existing = db.query(
    "SELECT secret_hash FROM groups WHERE group_id = ?"
  ).get(groupId) as { secret_hash: string | null } | null;
  if (existing && !safeEqual(existing.secret_hash, providedHash)) {
    return { error: "group_secret_hash mismatch (TOFU rejected)", status: 401 };
  }
  return null;
}

/**
 * checkGroupSecret authorizes an action inside a group but never proves the
 * group exists -- for an unseen group, TOFU just accepts it. Call this first on
 * any route whose write is anchored solely by group_id, with no peers/messages
 * row to scope it, like the operator-inbox tables.
 */
function groupExists(groupId: string): boolean {
  return db.query("SELECT 1 FROM groups WHERE group_id = ?").get(groupId) != null;
}

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

// Migration: add role column (idempotent). Card a2f61172: a launch property
// set from the transport (CLAUDE_PEERS_ROLE) on every /register, normalized
// in handleRegister. Existing rows are NULL.
try {
  db.run("ALTER TABLE peers ADD COLUMN role TEXT");
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

// Reserved sentinel senders (v0.3.4 deck, PLAN C12 operator; card 37a2b8c7 volet 3:
// looped over the single SENTINEL_DEFINITIONS source instead of one copy-pasted
// INSERT per sentinel). messages.from_token has a NOT NULL FK to peers(instance_token),
// so /announce and the operator inbox need a real row to point at. These rows stay
// 'dormant' forever: they never appear in list_peers/group-stats (both filter
// status='active') and are never a valid send_message target, so peers cannot reply.
// cleanStalePeers excludes them from the dormant TTL purge (see below).
for (const sentinel of SENTINEL_DEFINITIONS) {
  db.run(
    `INSERT OR IGNORE INTO peers
       (instance_token, peer_id, group_id, pid, cwd, summary, registered_at, last_seen, host, client_pid, status)
     VALUES (?, ?, 'default', 0, '', '', datetime('now'), datetime('now'), '', 0, 'dormant')`,
    [sentinel.instanceToken, sentinel.peerId]
  );
}

db.run(`CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(to_token, delivered)`);

db.run(`
  CREATE TABLE IF NOT EXISTS peer_sessions (
    session_key TEXT PRIMARY KEY,
    instance_token TEXT NOT NULL,
    group_id TEXT NOT NULL,
    host TEXT NOT NULL,
    cwd TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    cc_session_id TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (instance_token) REFERENCES peers(instance_token)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON peer_sessions(group_id, host, cwd)`);

// Migration (idempotent): cc_session_id on peer_sessions -- card 3d121a74, lot
// L3-a. STORED in the row, deliberately NOT part of session_key: the tile token
// decides WHICH ROW, this decides whether a row can be reclaimed after the tile
// token itself changed. It is what catches the Restore gesture, which mints a
// NEW tile id (fromWorkspaceSessions: id randomUUID()) while PRESERVING the CC
// session (sessionId: s.claudeSessionId) -- keyed on the tile token alone, a
// restored tile would lose its identity, which the operator's rule 3 forbids.
//
// The ALTER's own outcome is the migration flag for the one-shot purge below:
// it SUCCEEDS exactly once per pre-L3-a database, and throws duplicate-column
// forever after (and on a fresh database, where the CREATE TABLE above already
// carries the column and there is nothing to purge).
let peerSessionsColumnAdded = false;
try {
  db.run("ALTER TABLE peer_sessions ADD COLUMN cc_session_id TEXT NOT NULL DEFAULT ''");
  peerSessionsColumnAdded = true;
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

if (peerSessionsColumnAdded) {
  // Widening the session key makes every stored session_key unreachable, and
  // the rows cannot be migrated. Purge peer_sessions only, never peers: keeping
  // both keys around is the mechanism of the bug it fixes, handing a tile
  // another tile's row (its token, its mail).
  const undelivered = (db.query("SELECT COUNT(*) AS n FROM messages WHERE delivered = 0")
    .get() as { n: number }).n;
  const purged = (db.query("SELECT COUNT(*) AS n FROM peer_sessions").get() as { n: number }).n;
  db.run("DELETE FROM peer_sessions");
  log.info(
    `migration 3d121a74: peer_sessions purged for the widened identity key -- ${purged} session row(s) dropped, ${undelivered} undelivered message(s) now unreachable (peers untouched, tokens age out via the dormant TTL)`
  );
}

// Keyed by session_id, not group_id or operator_id: operator_id is deliberately
// shared across one person's machines, so keying on it would let two Decks of
// the same operator steal each other's inbox.
// A session polling under a different group_id gets its own row rather than
// silently migrating the original.
// Does not itself scope reads/writes to a group -- every statement below still
// carries its own explicit group_id filter.
db.run(`
  CREATE TABLE IF NOT EXISTS operator_inbox_sessions (
    session_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    last_id INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (session_id, group_id)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_operator_inbox_sessions_group ON operator_inbox_sessions(group_id, last_seen_at)`);

// Scoped by project_key, not group_id, with no foreign key to peers/groups:
// created_by/updated_by are plain-text peer_id snapshots, so items outlive the
// session lifecycle. Deletion is a reversible archive (deleted_at), never a
// DELETE.
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
    queue INTEGER,
    directive TEXT,
    target_peer_ids TEXT NOT NULL DEFAULT '[]'
  )
`);

try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN queue INTEGER");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN context TEXT NOT NULL DEFAULT ''");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

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

// Migration (card e344fa79): the missing half of the lock-owner composite
// key. `locked_by` alone is unique only PER GROUP (peers.UNIQUE(peer_id,
// group_id) above), so this column completes it -- the owning group_id,
// stored RAW (see RoadmapItem.locked_group's doc comment for why, and why
// that is safe now that rowToRoadmapItem is a pick-list, not a rest-spread).
// NULL on every pre-existing row is a deliberate fail-OPEN migration state
// (matchesLockOwner degrades to the old peer_id-only comparison for a NULL).
// Self-heals specifically on the row's next CLAIM (resolvedLock.claimed,
// see shared/roadmap-lock.ts), not on every write from the real owner --
// see RoadmapLockResolution.claimed's doc comment for why that distinction
// matters (an earlier version of this comment overclaimed the broader
// form, corrected in review).
try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN locked_group TEXT");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Migration (card 4441e883, mecanisme B): the lock owner's `instance_token`
// at the moment it CLAIMED the lock -- `locked_by` stays the display peer_id
// (a numbered-seat name, see the field's doc comment), this is the stable
// credential a caller can PROVE it still holds. NULL on every pre-existing
// row (fail-open migration state, same as `locked_group`), and NULL is also
// the permanent, correct value for any claim resolveRoadmapAuthor could not
// prove via a real instance_token (an unproven claim, or an operator/deck-
// signed write) -- this column is never guessed or backfilled from
// `locked_by`. See RoadmapItem.locked_by_token's doc comment for the full
// contract.
try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN locked_by_token TEXT");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Migration (CT1): directive cards. `directive` is null for every non-directive
// item; target_peer_ids is a JSON array of plain-text peer_id snapshots (no FK).
for (const col of ["directive TEXT", "target_peer_ids TEXT NOT NULL DEFAULT '[]'"]) {
  try {
    db.run(`ALTER TABLE roadmap_items ADD COLUMN ${col}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
  }
}

// Migration (card edefff05): last-operator-signed snapshot on pre-existing
// tables. NULLable, no DEFAULT -- see RoadmapAuthor/resolveRoadmapAuthor for
// what it records (a proven operator signature, not ownership; `locked_by`
// stays the ownership field).
try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN operator_id TEXT");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Migration (card c33a5968): operator-only "inactive" flag, see
// RoadmapItem.inactive in shared/types.ts for the full write-path contract.
try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN inactive INTEGER NOT NULL DEFAULT 0");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Migration (card aaf4537d, lots 1+2): PARKED lock state. Both NULLable, no
// DEFAULT -- nullity IS the state, see RoadmapItem.lock_parked_at/
// lock_parked_by in shared/types.ts for the full write-path contract.
try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN lock_parked_at TEXT");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}
try {
  db.run("ALTER TABLE roadmap_items ADD COLUMN lock_parked_by TEXT");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Replication columns (DESIGN-OFFLINE-REPLICA §3.1). `rev` is the pull cursor
// (bumped by ANY tracked write), `content_rev` versions the fifteen content
// columns alone, and the sync_* group is the replica's reconciliation state
// against its upstream. `lock_relay`/`lock_relay_seen`/`lock_contested_by` are
// the upstream half of the lock relay; `lock_scope` the replica half.
// `lock_release_owner` is not in the brief's table and is the one column added
// on top of it: the release trigger below fires when `locked_by` has ALREADY
// been cleared, and the upstream release refuses a relay whose owner it cannot
// match, so the owner has to survive the release somewhere.
for (const col of [
  "rev INTEGER NOT NULL DEFAULT 0",
  "content_rev INTEGER NOT NULL DEFAULT 0",
  "sync_base_rev INTEGER",
  "sync_base TEXT",
  "sync_dirty INTEGER NOT NULL DEFAULT 0",
  "sync_state TEXT NOT NULL DEFAULT 'clean'",
  "sync_remote TEXT",
  "lock_scope TEXT",
  "lock_relay TEXT",
  "lock_relay_seen TEXT",
  "lock_contested_by TEXT NOT NULL DEFAULT '[]'",
  "lock_release_owner TEXT",
]) {
  try {
    db.run(`ALTER TABLE roadmap_items ADD COLUMN ${col}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
  }
}

// Replication bookkeeping, one row per key: `rev_seq` (the revision sequence
// the triggers below draw from), `applying` ('1' while a replication write is
// in flight, so the content trigger does not mark it dirty), `mode` (read by
// the two lock triggers, which only exist on a replica), `replica_id` and
// `upstream_cursor`.
db.run(`
  CREATE TABLE IF NOT EXISTS roadmap_sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
for (const [key, value] of [
  ["rev_seq", "0"],
  ["applying", "0"],
  ["upstream_cursor", "0"],
]) {
  db.run("INSERT OR IGNORE INTO roadmap_sync_meta (key, value) VALUES (?, ?)", [key!, value!]);
}
// The mode is re-stamped on every startup: it follows the config, and a stale
// value would leave the lock triggers wired for the previous deployment.
db.run(
  `INSERT INTO roadmap_sync_meta (key, value) VALUES ('mode', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  [BROKER_MODE]
);
// And so is the applying flag. A transaction rollback already clears it, but
// the failure it guards against is silent -- a flag stuck at '1' would stop
// marking local edits dirty, so they would simply never be pushed -- and no
// running process can legitimately hold it across a startup.
db.run("UPDATE roadmap_sync_meta SET value = '0' WHERE key = 'applying'");

/** Reads one bookkeeping value; the table's primary key makes the row unique. */
function syncMetaGet(key: string): string | null {
  const row = db.query("SELECT value FROM roadmap_sync_meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

function syncMetaSet(key: string, value: string): void {
  db.run(
    `INSERT INTO roadmap_sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

// Rows written before this migration all carry rev = 0, and the pull cursor is
// exclusive (`rev > since_rev`, starting at 0) -- left at 0 they would be
// invisible to every replica forever. Numbered once, in rowid order, from the
// same sequence the triggers use.
const backfillRevs = db.transaction(() => {
  const rows = db
    .query("SELECT rowid AS rid FROM roadmap_items WHERE rev = 0 ORDER BY rowid")
    .all() as { rid: number }[];
  if (rows.length === 0) return 0;
  let seq = parseInt(syncMetaGet("rev_seq") ?? "0", 10);
  const stamp = db.prepare("UPDATE roadmap_items SET rev = ?, content_rev = ? WHERE rowid = ?");
  for (const row of rows) {
    seq += 1;
    stamp.run(seq, seq, row.rid);
  }
  syncMetaSet("rev_seq", String(seq));
  return rows.length;
});
const backfilled = backfillRevs();
if (backfilled > 0) log.info(`migration: numbered ${backfilled} roadmap row(s) into the replication sequence`);

db.run(`CREATE INDEX IF NOT EXISTS idx_roadmap_rev ON roadmap_items(rev)`);

// Revision stamping lives in TRIGGERS, not in a helper each handler calls: a
// helper fails OPEN the day a new write path forgets it, while a trigger covers
// /upsert, /archive, /append-context, /reorder, /import, the sweep and every
// future writer by construction.
// Nested triggers must not re-enter (each body UPDATEs the same table), which
// is SQLite's default; stated explicitly here because the whole scheme -- and
// the "one write, one stamp" test -- depends on it.
db.run("PRAGMA recursive_triggers = OFF");

// Column lists are GENERATED, never hand-copied: the tracked set is the live
// schema minus the columns whose own change must not count as a write, and the
// content set is the protocol constant itself.
const REV_UNTRACKED_COLUMNS = new Set([
  "rev",
  "content_rev",
  "sync_base_rev",
  "sync_base",
  "sync_dirty",
  "sync_state",
  "sync_remote",
  "lock_relay_seen",
]);
const roadmapTableColumns = (
  db.query("PRAGMA table_info(roadmap_items)").all() as { name: string }[]
).map((c) => c.name);
const revTrackedColumns = roadmapTableColumns.filter((c) => !REV_UNTRACKED_COLUMNS.has(c));
const syncContentColumns = [...ROADMAP_SYNC_CONTENT_FIELDS];
const missingContentColumns = syncContentColumns.filter((c) => !roadmapTableColumns.includes(c));
if (missingContentColumns.length > 0) {
  log.error(
    `roadmap replication: content column(s) absent from roadmap_items -- ${missingContentColumns.join(", ")}`
  );
}
/**
 * What a replica still owes its upstream: a card whose content moved since the
 * merge base, and a card that has NO base at all -- born here while offline,
 * or predating the switch to replica mode. Both are pushed with the base they
 * have (`sync_base_rev`, null for the second kind), and a card awaiting
 * arbitration is not pushed at all. One fragment, shared by the pass and by
 * the count the operator reads, so the two cannot disagree on what is pending.
 */
const SYNC_PENDING_PUSH_WHERE = "sync_state = 'clean' AND (sync_dirty = 1 OR sync_base_rev IS NULL)";

const NEXT_REV = "(SELECT CAST(value AS INTEGER) FROM roadmap_sync_meta WHERE key = 'rev_seq')";
const BUMP_REV_SEQ =
  "UPDATE roadmap_sync_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev_seq';";
const IS_APPLYING = "COALESCE((SELECT value FROM roadmap_sync_meta WHERE key = 'applying'), '0') = '1'";
const IS_REPLICA = "COALESCE((SELECT value FROM roadmap_sync_meta WHERE key = 'mode'), '') = 'replica'";

// Dropped and recreated on every startup rather than CREATE IF NOT EXISTS: the
// generated column lists change with the schema, and an "if not exists" would
// keep serving the definition compiled by an older broker.
for (const name of [
  "roadmap_rev_ai",
  "roadmap_rev_au",
  "roadmap_content_rev_au",
  "roadmap_lock_scope_ai",
  "roadmap_lock_scope_au",
  "roadmap_lock_release_au",
]) {
  db.run(`DROP TRIGGER IF EXISTS ${name}`);
}

db.run(`
  CREATE TRIGGER roadmap_rev_ai AFTER INSERT ON roadmap_items BEGIN
    ${BUMP_REV_SEQ}
    UPDATE roadmap_items SET rev = ${NEXT_REV}, content_rev = ${NEXT_REV}
     WHERE rowid = new.rowid;
  END
`);

db.run(`
  CREATE TRIGGER roadmap_rev_au AFTER UPDATE OF ${revTrackedColumns.join(", ")} ON roadmap_items BEGIN
    ${BUMP_REV_SEQ}
    UPDATE roadmap_items SET rev = ${NEXT_REV} WHERE rowid = new.rowid;
  END
`);

// The WHEN clause is what keeps a rewrite of identical values from versioning
// the content: every upsert SETs all fifteen columns, so without it a queue
// move or a lock claim would bump content_rev and mark the card dirty.
db.run(`
  CREATE TRIGGER roadmap_content_rev_au AFTER UPDATE OF ${syncContentColumns.join(", ")} ON roadmap_items
  WHEN ${syncContentColumns.map((c) => `old.${c} IS NOT new.${c}`).join(" OR ")}
  BEGIN
    ${BUMP_REV_SEQ}
    UPDATE roadmap_items
       SET content_rev = ${NEXT_REV},
           sync_dirty = CASE WHEN ${IS_APPLYING} THEN sync_dirty ELSE 1 END
     WHERE rowid = new.rowid;
  END
`);

// Lock scope is replica-only state, so all three lock triggers are gated on
// the mode AND on the applying flag: a scope the replication pass itself wrote
// (a lock mirrored from upstream) must not be reinterpreted as a local claim.
// A card can be BORN locked (an agent creating it in_progress), so the claim
// side needs an INSERT trigger as well as an UPDATE one.
db.run(`
  CREATE TRIGGER roadmap_lock_scope_ai AFTER INSERT ON roadmap_items
  WHEN new.locked = 1
   AND new.lock_scope IS NULL
   AND ${IS_REPLICA}
   AND NOT ${IS_APPLYING}
  BEGIN
    UPDATE roadmap_items SET lock_scope = 'local' WHERE rowid = new.rowid;
  END
`);

db.run(`
  CREATE TRIGGER roadmap_lock_scope_au AFTER UPDATE OF locked, locked_by ON roadmap_items
  WHEN new.locked = 1
   AND (old.locked = 0 OR old.locked_by IS NOT new.locked_by)
   AND ${IS_REPLICA}
   AND NOT ${IS_APPLYING}
  BEGIN
    UPDATE roadmap_items SET lock_scope = 'local', lock_release_owner = NULL WHERE rowid = new.rowid;
  END
`);

// Any local release -- explicit, a status change, the sweep -- becomes a
// pending upstream release without enumerating the paths that can cause one.
db.run(`
  CREATE TRIGGER roadmap_lock_release_au AFTER UPDATE OF locked ON roadmap_items
  WHEN old.locked = 1 AND new.locked = 0
   AND old.lock_scope IN ('local', 'global', 'contested')
   AND ${IS_REPLICA}
   AND NOT ${IS_APPLYING}
  BEGIN
    UPDATE roadmap_items
       SET lock_scope = 'release_pending', lock_release_owner = old.locked_by
     WHERE rowid = new.rowid;
  END
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_roadmap_project ON roadmap_items(project_key, status)`);

// Free-text search index (card 15952e09). External-content table: FTS5 owns
// no data of its own, it indexes roadmap_items by its rowid (written
// EXPLICITLY below even though it is the default, so a reader sees at a
// glance that alignment is on the implicit rowid and NOT on the `id` TEXT
// primary key). title/description/tags default-searched, rationale/context
// opt-in via `q_deep` (their `context` bodies run to thousands of characters
// and would otherwise drown every other match). unicode61 + remove_diacritics
// gives case/accent-insensitive, non-contiguous-term matching for free.
db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS roadmap_fts USING fts5(
    title, description, tags, rationale, context,
    content='roadmap_items', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  )
`);

// Three triggers keep roadmap_fts in sync with every write to roadmap_items,
// no matter which code path performs it (upsert, import, context-append, a
// future writer) -- the alternative (reindexing from handleRoadmapUpsert)
// would make "who else writes roadmap_items" a question whose answer matters;
// triggers make it not matter. Cheap at this corpus size (~115 cards); worth
// re-arbitrating past a few tens of thousands of rows.
//
// The UPDATE trigger issues a 'delete' using the OLD column values before
// inserting the NEW ones. Skipping the OLD values (e.g. passing new.* twice)
// leaves FTS5 unable to find the terms to remove: the index keeps phantom
// terms from the pre-update text, a silent desync that only shows up as
// stale search hits much later.
db.run(`
  CREATE TRIGGER IF NOT EXISTS roadmap_fts_ai AFTER INSERT ON roadmap_items BEGIN
    INSERT INTO roadmap_fts(rowid, title, description, tags, rationale, context)
    VALUES (new.rowid, new.title, new.description, new.tags, new.rationale, new.context);
  END
`);
db.run(`
  CREATE TRIGGER IF NOT EXISTS roadmap_fts_ad AFTER DELETE ON roadmap_items BEGIN
    INSERT INTO roadmap_fts(roadmap_fts, rowid, title, description, tags, rationale, context)
    VALUES ('delete', old.rowid, old.title, old.description, old.tags, old.rationale, old.context);
  END
`);
db.run(`
  CREATE TRIGGER IF NOT EXISTS roadmap_fts_au AFTER UPDATE ON roadmap_items BEGIN
    INSERT INTO roadmap_fts(roadmap_fts, rowid, title, description, tags, rationale, context)
    VALUES ('delete', old.rowid, old.title, old.description, old.tags, old.rationale, old.context);
    INSERT INTO roadmap_fts(rowid, title, description, tags, rationale, context)
    VALUES (new.rowid, new.title, new.description, new.tags, new.rationale, new.context);
  END
`);

// Rebuild on every startup: makes a desync (e.g. a row written before the
// triggers existed, or a DB edited outside the broker) impossible to survive
// a restart. Cheap: ~115 cards.
db.run(`INSERT INTO roadmap_fts(roadmap_fts) VALUES('rebuild')`);

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

// Dispatch requests (card bf76d37f): an agent asks the Deck to run the head
// wave of the roadmap queue, and the Deck posts back WHAT it dispatched. Same
// durability model as graph_drafts right above (no FK, plain-text peer
// snapshot, status flips, listing non-destructive): a Deck restart loses no
// parked request, and the row survives its answer so the requester can still
// read the outcome after its long poll gave up.
//
// `outcome` is JSON TEXT and stays NULL until resolved. It is deliberately not
// a set of columns: it is a report meant to be read once by the caller, not a
// thing to query on, and cards[] is variable-length.
db.run(`
  CREATE TABLE IF NOT EXISTS dispatch_requests (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    from_peer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    outcome TEXT
  )
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_dispatch_requests_project ON dispatch_requests(project_key, status)`
);

// operator_id names a PERSON, not a host: two OS accounts on one machine share
// a hostname but must never see each other's approvals.
// Only public keys are stored -- operator_id is a digest of the key, so the
// binding is self-certifying and reading this table grants no ability to
// impersonate anyone.
db.run(`
  CREATE TABLE IF NOT EXISTS approval_operators (
    operator_id TEXT PRIMARY KEY,
    public_key  TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )
`);

// Restricted per-session credentials (PLAN §6.8). Handed to spawned agents —
// including inside a sandbox container — so they may `add`/`wait` for their OWN
// session and nothing else. Never allowed to `claim`.
db.run(`
  CREATE TABLE IF NOT EXISTS approval_session_tokens (
    token_id    TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    public_key  TEXT NOT NULL,
    session_ref TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT
  )
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_approval_tokens_operator ON approval_session_tokens(operator_id, session_ref)`
);

// Card 1def56da. `project_key` becomes a CREDENTIAL-derived field, like
// `session_ref` already was: before this, an agent chose it in the request body,
// so the scope filter card 4df14b5b made mandatory applied to a dimension
// declared by the party being filtered. The Deck stamps it at mint time.
//
// Idempotent, and the DEFAULT is load-bearing: a token minted before this
// column existed gets '', and `resolveProjectKey` in shared/approval-scope.ts
// refuses it by NAME ("this session token predates project scoping") instead of
// falling back on the body -- the fallback would be the defect reintroduced
// under cover of compatibility.
try {
  db.run("ALTER TABLE approval_session_tokens ADD COLUMN project_key TEXT NOT NULL DEFAULT ''");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Notification channels an operator can be reached on (Telegram/Discord/ntfy).
db.run(`
  CREATE TABLE IF NOT EXISTS approval_channels (
    id           TEXT PRIMARY KEY,
    operator_id  TEXT NOT NULL,
    kind         TEXT NOT NULL,
    address      TEXT NOT NULL,
    label        TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    last_used_at TEXT
  )
`);
db.run(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_channel_uniq ON approval_channels(operator_id, kind, address)`
);

// Bot tokens, encrypted at rest (shared/secret-box.ts). They live here rather
// than in a server-side config file because the operator enrols from the app:
// requiring shell access to the broker host to paste a token is not an
// experience we ship. One row per (operator, kind) -- Telegram allows a single
// getUpdates consumer per token, so the gateway must be this singleton.
db.run(`
  CREATE TABLE IF NOT EXISTS approval_channel_secrets (
    operator_id TEXT NOT NULL,
    kind        TEXT NOT NULL,
    secret_enc  TEXT NOT NULL,
    hint        TEXT NOT NULL DEFAULT '',
    label       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    PRIMARY KEY (operator_id, kind)
  )
`);

// One-shot pairing codes: the Deck shows one, the operator sends it to the bot,
// the bot binds that address. Short-lived and consumed on first use, exactly
// like the companion's QR token.
db.run(`
  CREATE TABLE IF NOT EXISTS approval_pairing_codes (
    code        TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    kind        TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  )
`);

// Where each approval was posted, so every copy can be rewritten once one of
// them wins the race.
db.run(`
  CREATE TABLE IF NOT EXISTS approval_posts (
    approval_id  TEXT NOT NULL,
    kind         TEXT NOT NULL,
    binding_id   TEXT NOT NULL,
    external_ref TEXT NOT NULL,
    PRIMARY KEY (approval_id, kind, binding_id)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_approval_posts_ref ON approval_posts(kind, external_ref)`);

db.run(`
  CREATE TABLE IF NOT EXISTS pending_approvals (
    id             TEXT PRIMARY KEY,
    operator_id    TEXT NOT NULL,
    origin_host    TEXT NOT NULL DEFAULT '',
    origin_user    TEXT NOT NULL DEFAULT '',
    project_key    TEXT NOT NULL DEFAULT '',
    group_id       TEXT NOT NULL DEFAULT '',
    from_peer      TEXT NOT NULL DEFAULT '',
    session_ref    TEXT NOT NULL DEFAULT '',
    tile_ref       TEXT NOT NULL DEFAULT '',
    reply_route    TEXT NOT NULL DEFAULT 'pty',
    reply_token    TEXT NOT NULL DEFAULT '',
    reply_group    TEXT NOT NULL DEFAULT '',
    kind           TEXT NOT NULL,
    title          TEXT NOT NULL,
    question       TEXT NOT NULL,
    options_json   TEXT NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL DEFAULT 'pending',
    answered_via   TEXT,
    answer_kind    TEXT,
    answer_text    TEXT,
    created_at     TEXT NOT NULL,
    notif_expires_at TEXT NOT NULL,
    answered_at    TEXT,
    delivered_at   TEXT
  )
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_approvals_operator ON pending_approvals(operator_id, status)`
);

// Card 1def56da: rows written before project scoping carry project_key = '',
// which compares as an ordinary value here, not a wildcard -- nothing can claim
// them once every handler requires a scope.
// They are set abandoned rather than left pending forever, matching that
// status's own definition (producer gone, session closed).
// The WHERE clause only matches rows still pending, so rerunning this migration
// is a no-op on rows already handled.
{
  const stranded = db.run(
    `UPDATE pending_approvals SET status = 'abandoned'
      WHERE project_key = '' AND status IN ('pending','expired_notif')`
  ).changes;
  if (stranded > 0) {
    log.info(
      `migration: ${stranded} approval(s) predating project scoping marked abandoned (card 1def56da)`
    );
  }
}
db.run(
  `CREATE INDEX IF NOT EXISTS idx_approvals_project ON pending_approvals(project_key, status)`
);

// Migration: routing hint added once the hook stopped blocking — the verdict is
// now applied by the Deck, which needs to know WHICH tile to type into.
try {
  db.run("ALTER TABLE pending_approvals ADD COLUMN tile_ref TEXT NOT NULL DEFAULT ''");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Migration (chantier 3189b002+874e9053): whether a row PARTICIPATES in
// tile-scoped merging at all. A row from before this migration reads back 1,
// which is today's behaviour -- every row merged, because only notifications
// existed.
try {
  db.run("ALTER TABLE pending_approvals ADD COLUMN mergeable INTEGER NOT NULL DEFAULT 1");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
}

// Migration (C-9): the return path. 'channel' delivers the answer to the peer
// as a claude-peers message; 'pty' leaves it to the Deck's keystrokes.
for (const col of [
  "reply_route TEXT NOT NULL DEFAULT 'pty'",
  "reply_token TEXT NOT NULL DEFAULT ''",
  "reply_group TEXT NOT NULL DEFAULT ''",
]) {
  try {
    db.run(`ALTER TABLE pending_approvals ADD COLUMN ${col}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("duplicate column name")) log.error(`migration: ${msg}`);
  }
}

// --- Helpers ---

/**
 * The PRE-L3-a identity key: sha256(host, cwd, group_id). Kept verbatim, and
 * kept CALLED (by sessionKey below, on BOTH its branches) rather than merely
 * kept around: that is what makes "a legacy row is still resurrected by a
 * register with no discriminant" true BY CONSTRUCTION for every non-Deck CLI
 * user, instead of an equality a test would have to pin with a frozen hex
 * literal. This is the ONLY base chain in the file, so a change to it moves
 * both the legacy and the widened key together -- see sessionKey, which hashes
 * this DIGEST rather than re-listing the same fields (an earlier revision
 * re-copied them inline, and a review measured that a separator changed here
 * would then not have followed there).
 */
function legacySessionKey(host: string, cwd: string, groupId: GroupId): string {
  return createHash("sha256")
    .update(host)
    .update("\0")
    .update(cwd)
    .update("\0")
    .update(groupId)
    .digest("hex");
}

/**
 * deskSession must be an unguessable capability (a randomUUID stable across
 * /clear, compact and restart), never a derivable value like a tile index, slot
 * number, or pid -- those are visible to any agent in the same repo and would
 * turn this widening into a regression.
 * Residual: an agent that can already read another tile's environment can still
 * impersonate it; this only raises the bar, it does not create a new exposure.
 */
function sessionKey(
  host: string,
  cwd: string,
  groupId: GroupId,
  deskSession?: string | null
): string {
  const discriminant = (deskSession ?? "").trim();
  const base = legacySessionKey(host, cwd, groupId);
  if (!discriminant) return base;
  return createHash("sha256").update(base).update("\0").update(discriminant).digest("hex");
}

function deriveDefaultId(host: string, cwd: string, groupId: GroupId): string {
  const sanitize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const hostPart = sanitize(host).slice(0, 20) || "peer";
  const cwdPart = sanitize(cwd.split(/[/\\]/).pop() ?? "").slice(0, 12);
  const base = cwdPart ? `${hostPart}-${cwdPart}` : hostPart;

  const exists = db.query("SELECT 1 FROM peers WHERE peer_id = ? AND group_id = ?");
  // Card 39c40571 layer 2: this is the THIRD path that mints a peer_id, and it
  // was the only one not consulting RESERVED_PEER_IDS (set_id refuses them,
  // cleanPeerIds strips them). `host` and `cwd` come straight from the request
  // body, and sanitize("deck") is "deck" with an empty cwd basename, so a
  // caller could register a peer literally NAMED after a reserved identity and
  // then author writes as it with a perfectly real token. The collision loop
  // could not catch it either: it only looks inside the SAME group, while the
  // sentinel rows live in 'default'. Suffixed rather than refused, so a machine
  // whose hostname happens to be 'deck' still registers instead of being
  // locked out of the product by its own name.
  let candidate = RESERVED_PEER_IDS.includes(base) ? `${base}-1` : base;
  let suffix = 1;
  const MAX_SUFFIX = 1000;
  while (exists.get(candidate, groupId) || RESERVED_PEER_IDS.includes(candidate)) {
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

  // Phase 2: purge dormants au-dela du TTL. Every reserved sentinel row (card
  // 37a2b8c7 volet 3: derived from SENTINEL_INSTANCE_TOKENS, not one literal
  // per constant) is exempt -- it is permanently dormant and must outlive the
  // TTL so /announce's and the operator inbox's from_token FK always resolves.
  const cutoff = `-${DORMANT_TTL_HOURS} hours`;
  const sentinelPlaceholders = SENTINEL_INSTANCE_TOKENS.map(() => "?").join(", ");
  const expired = db.query(
    `SELECT instance_token FROM peers
     WHERE status = 'dormant' AND last_seen < datetime('now', ?)
       AND instance_token NOT IN (${sentinelPlaceholders})`
  ).all(cutoff, ...SENTINEL_INSTANCE_TOKENS) as { instance_token: string }[];
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

/**
 * Routes off the card's own locked_group column, never re-derived by joining
 * locked_by against a live peers row -- the sweep fires precisely when no live
 * peer for locked_by exists, so a join-based route would silently miss the
 * abandonment it exists to report.
 * A NULL locked_group (migration-era row) is logged and dropped, never
 * defaulted to 'default': that group pins no secret, so a misrouted message
 * would be readable by any holder of the shared token.
 * Sender is DECK_INSTANCE_TOKEN directly, not routed through the normal
 * message-send path: the sweep is not a peer, and there is no row for the usual
 * bookkeeping to update.
 */
function emitLockAbandonedEvent(row: {
  id: string;
  title: string;
  locked_by: string | null;
  locked_group: string | null;
  held_minutes: number | null;
  status: RoadmapStatus;
  lock_parked_at: string | null;
}): void {
  if (row.locked_group === null) {
    log.warn("releaseStaleLocks: dropped an abandonment event, row has no locked_group to route it (migration-era row)", {
      roadmap_id: row.id,
    });
    return;
  }
  if (!groupMayCarryOperatorInbox(row.locked_group)) {
    log.warn("releaseStaleLocks: dropped an abandonment event, group cannot carry the operator inbox", {
      roadmap_id: row.id,
      group_id: row.locked_group,
    });
    return;
  }
  const minutes = Math.max(0, row.held_minutes ?? 0);
  // Card 4441e883, team-lead correctif: this function serves BOTH clause 1/2
  // (owner-gone/TTL, a real abandonment) and clause 3 (a deliberate park that
  // expired) -- `lock_parked_at !== null` is what distinguishes them, since
  // clause 3 is the only one that ever releases a parked row (see the doc
  // comment on `release` above). And the UPDATE below only ever flips status
  // to 'planned' when it WAS 'in_progress' -- a locked row with any other
  // status (reachable via /roadmap/import writing locked=1 outside
  // resolveRoadmapLock) never gets that flip, so the "back to 'planned'"
  // fragment must not be asserted for it.
  const eventFragment = row.lock_parked_at !== null ? "its park expired" : "abandoned";
  const statusFragment = row.status === "in_progress" ? " -- it is back to 'planned'" : "";
  const text = `Card '${row.title}' (${row.id}) was held by '${row.locked_by ?? "unknown"}' for ${minutes} minute${minutes === 1 ? "" : "s"}, then ${eventFragment}${statusFragment}.`;
  insertMessage.run(DECK_INSTANCE_TOKEN, OPERATOR_INSTANCE_TOKEN, row.locked_group, text, new Date().toISOString());
}

// --- Stale roadmap-lock sweep (PLAN K2) ---
// Releases agent work-locks whose owner is gone or that outlived the TTL, so a
// crashed or abandoned session never freezes an item forever. A released item
// drops back to 'planned': visibly up for grabs again. `datetime(...)` wraps
// the stored values because locked_at/updated_at may mix SQLite and ISO-8601
// formats depending on the writer.
// Card c33a5968: no inactive guard here, deliberately -- this sweep only
// RELEASES (locked -> 0, in_progress -> planned), it never claims a card, so
// it cannot violate the "inactive card can't become in_progress/locked" rule.
function releaseStaleLocks(): void {
  // Each clause SELECTs the rows before the UPDATE clears them, so the
  // abandonment event reports the row's pre-release state, not the NULLs the
  // UPDATE just wrote.
  // held_minutes is computed in SQL via julianday, sidestepping the
  // space-vs-'T'-timestamp parsing pitfall that has to be handled explicitly in
  // JS.
  // A 'remote' scope means the lock is a MIRROR of one held on the upstream
  // broker, refreshed by the replication pull and by nothing else: no local
  // peer carries its owner and no local write refreshes updated_at, so every
  // clause below would release it on sight -- and the release would then be
  // pushed back as a local content change. Exempted once, in the shared
  // helper, so a fourth clause inherits the exemption.
  const release = (where: string, params: string[]): void => {
    const abandoned = db
      .query(
        `SELECT id, title, locked_by, locked_group, status, lock_parked_at,
                CAST((julianday('now') - julianday(locked_at)) * 1440 AS INTEGER) AS held_minutes
           FROM roadmap_items
          WHERE locked = 1 AND lock_scope IS NOT 'remote' AND ${where}`
      )
      .all(...params) as {
      id: string;
      title: string;
      locked_by: string | null;
      locked_group: string | null;
      status: RoadmapStatus;
      lock_parked_at: string | null;
      held_minutes: number | null;
    }[];
    db.run(
      `UPDATE roadmap_items SET
         locked = 0, locked_by = NULL, locked_group = NULL, locked_by_token = NULL, locked_at = NULL, operator_id = NULL,
         lock_parked_at = NULL, lock_parked_by = NULL,
         status = CASE WHEN status = 'in_progress' THEN 'planned' ELSE status END,
         updated_by = 'lock-sweep', updated_at = datetime('now')
       WHERE locked = 1 AND lock_scope IS NOT 'remote' AND ${where}`,
      params
    );
    for (const row of abandoned) emitLockAbandonedEvent(row);
  };
  // TTL: no write at all on the item for LOCK_TTL_SEC (any roadmap_update,
  // e.g. a context enrichment by the working agent, refreshes updated_at).
  // Card aaf4537d: prefixed with the park-immunity guard -- a PARKED card
  // (Pause stop) is exempt from this ordinary staleness timeout; clause 3
  // below is the only clause that may release it, and only once the park
  // itself expires (LOCK_PARK_TTL_SEC), or the park would defeat the sweep
  // that a paused agent's owner-gone silence would otherwise trigger.
  release(`lock_parked_at IS NULL AND datetime(updated_at) < datetime('now', ?)`, [
    `-${LOCK_TTL_SEC} seconds`,
  ]);
  // Grace is anchored on the owner's last real heartbeat, not on when the lock
  // was taken -- anchoring on lock time gave zero effective grace to any lock
  // held longer than the grace window, the common case.
  // Liveness is scoped by project_key alone; group_id stays out by design.
  // Uses SQL's NULL-safe `IS`, not `=`, so a NULL project_key only matches
  // other NULL project_keys rather than comparing as NULL/false against
  // everything.
  // A lock RELAYED for a replica's agent has no peers row on this broker by
  // construction (the agent is registered on the replica), so the owner-gone
  // clause would sweep it on its first pass. The relay's own heartbeat
  // (lock_relay_seen, refreshed by every claim of the replication pass) stands
  // in for the owner's: once the replica goes quiet for LOCK_GRACE_SEC the
  // lock falls exactly like an abandoned local one.
  release(
    `lock_parked_at IS NULL
     AND COALESCE(lock_relay IS NOT NULL AND datetime(lock_relay_seen) >= datetime('now', ?), 0) = 0
     AND NOT EXISTS (
       SELECT 1 FROM peers p
       WHERE p.peer_id = roadmap_items.locked_by
         AND p.project_key IS roadmap_items.project_key
         AND (roadmap_items.locked_group IS NULL OR p.group_id IS roadmap_items.locked_group)
         AND (p.status = 'active' OR datetime(p.last_seen) >= datetime('now', ?))
     )`,
    [`-${LOCK_GRACE_SEC} seconds`, `-${LOCK_GRACE_SEC} seconds`]
  );
  // The park itself expires: a card parked past the park TTL is swept even if
  // its updated_at was refreshed by a permitted edit meanwhile and its owner is
  // still alive -- the other two clauses never catch that case on their own.
  release(`lock_parked_at IS NOT NULL AND datetime(lock_parked_at) < datetime('now', ?)`, [
    `-${LOCK_PARK_TTL_SEC} seconds`,
  ]);
}
guardedInterval("releaseStaleLocks", releaseStaleLocks, LOCK_SWEEP_SEC * 1000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (
    instance_token, peer_id, group_id, pid, cwd, git_root, tty, summary,
    registered_at, last_seen, last_activity_at, host, client_pid, project_key, claude_cli_pid, role, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
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

// role is included in this SET list deliberately: it is a property of the
// launch, not persisted state, so the transport value overwrites on every
// register.
// An empty or absent transport value is a declaratively empty role and clears
// whatever role is stored, rather than leaving it untouched.
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
      claude_cli_pid = ?,
      role = ?
  WHERE instance_token = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?, 0)
`);

// Ordered by sent_at then id, not id alone: sent_at stays the primary sort key
// so intended chronological order is preserved, while id only breaks a genuine
// sent_at tie -- two sends can land in the same millisecond.
const selectUndelivered = db.prepare(
  `SELECT * FROM messages WHERE to_token = ? AND delivered = 0 ORDER BY sent_at ASC, id ASC`
);

// Capped variant used only to avoid replaying the whole backlog on every
// reconnect; the uncapped query stays in use elsewhere so an explicit full
// check still returns everything.
// Unlike the uncapped query, this one filters group_id -- the uncapped query's
// own callers already refuse a sentinel-shaped token by shape before it runs,
// so it doesn't need the same filter.
const selectUndeliveredCapped = db.prepare(
  `SELECT * FROM (
     SELECT * FROM messages
     WHERE to_token = ? AND group_id = ? AND delivered = 0
       AND sent_at > datetime('now', ?)
     ORDER BY sent_at DESC, id DESC
     LIMIT ?
   ) ORDER BY sent_at ASC, id ASC`
);

const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

// --- Courrier lot 1A/1C: operator_inbox_sessions cursor + purge statements ---
// (design doc desktop/docs/design-courrier-lot1.md section 6.1, cards
// 54b1c71a and 1e81ee7b broker half)

// A brand-new session_id seeds its cursor at the box's CURRENT MAX(id), not 0
// -- the design doc's explicit "starts empty" rule (section 6.1): a message
// sent while no Deck is attached is never retroactively shown to a session
// that mints later. Re-registering an EXISTING session_id only refreshes
// last_seen_at (keeps it alive for the purge GC below) and must NOT reset
// last_id back to MAX(id), or every poll would silently re-seed the cursor
// and the drain would never advance past "empty".
const upsertOperatorInboxSession = db.prepare(`
  INSERT INTO operator_inbox_sessions (session_id, group_id, last_id, started_at, last_seen_at)
  VALUES (
    ?, ?,
    COALESCE((SELECT MAX(id) FROM messages WHERE to_token = ? AND group_id = ?), 0),
    ?, ?
  )
  ON CONFLICT (session_id, group_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
`);

const selectOperatorInboxSession = db.prepare(
  `SELECT session_id, group_id, last_id FROM operator_inbox_sessions WHERE session_id = ? AND group_id = ?`
);

const selectOperatorInboxByCursor = db.prepare(
  `SELECT m.id, m.text, m.sent_at, COALESCE(p.peer_id, '<gone>') AS from_peer_id
   FROM messages m LEFT JOIN peers p ON p.instance_token = m.from_token
   WHERE m.to_token = ? AND m.group_id = ? AND m.id > ?
   ORDER BY m.id`
);

// `AND group_id = ?` is load-bearing (card 1e81ee7b BLOCKER 1): without it,
// a caller who only holds group A's secret can advance group B's session
// cursor by NAMING its session_id, permanently and silently hiding B's
// unread mail from its own Deck (messages.id is a GLOBAL autoincrement, so
// jumping to group A's MAX(id) jumps past B's pending ids too).
const advanceOperatorInboxCursor = db.prepare(
  `UPDATE operator_inbox_sessions SET last_id = ? WHERE session_id = ? AND group_id = ?`
);

// GC of dead sessions. Must run BEFORE computing MIN(last_id) for a 'session'
// scope purge: a session that stopped polling would otherwise pin the deletion
// floor forever, since a dead session's last_id never advances again.
// `group_id = ?` is load-bearing (card 1e81ee7b BLOCKER 2): without it this
// reaps every group's sessions, and it is reachable by an UNAUTHENTICATED
// caller naming a never-registered group (checkGroupSecret accepts an
// unknown group by construction, TOFU) -- see groupExists() and its two
// call sites, which are the actual gate against that.
const gcDeadOperatorInboxSessions = db.prepare(
  `DELETE FROM operator_inbox_sessions WHERE group_id = ? AND last_seen_at < datetime('now', ?)`
);

const minLiveOperatorInboxCursor = db.prepare(
  `SELECT MIN(last_id) AS floor FROM operator_inbox_sessions WHERE group_id = ?`
);

// `WHERE session_id = ? AND group_id = ?` (card 1e81ee7b BLOCKER 1, same
// reasoning as advanceOperatorInboxCursor above): this is the purge route's
// own cursor-bump, the second of the two places the cross-group hijack was
// reachable from.
const bumpOperatorInboxCursorToMax = db.prepare(
  `UPDATE operator_inbox_sessions
     SET last_id = COALESCE((SELECT MAX(id) FROM messages WHERE to_token = ? AND group_id = ?), last_id)
   WHERE session_id = ? AND group_id = ?`
);

const purgeOperatorInboxUpToId = db.prepare(
  `DELETE FROM messages WHERE to_token = ? AND group_id = ? AND id <= ?`
);

const purgeOperatorInboxByIds = (ids: number[]) =>
  db.prepare(
    `DELETE FROM messages WHERE to_token = ? AND group_id = ? AND id IN (${ids.map(() => "?").join(",")})`
  );

// Heuristic ack: a peer sending a message in a group has necessarily processed
// everything addressed to it in that group before sent_at, so those get
// promoted to delivered=1, avoiding a flush avalanche on the next reconnect.
// Ordered by row id, not sent_at -- sent_at is millisecond-resolution and two
// sends can tie or invert, so a strict sent_at cutoff can miss a message
// actually inserted earlier.
// This is a deliberate asymmetry from the recency queries' sent_at-first order,
// not an inconsistency: this needs a tie-free cutoff, those need a
// business-meaningful recency window.
const ackPriorMessagesForSender = db.prepare(
  `UPDATE messages
     SET delivered = 1
   WHERE to_token = ?
     AND group_id = ?
     AND delivered = 0
     AND id < ?`
);

// Message insert + activity refresh + heuristic ack land atomically: an abrupt
// broker death mid-sequence must not leave a message without its bookkeeping.
const recordMessageTx = db.transaction(
  (fromToken: string, toToken: string, groupId: string, text: string, sentAt: string): number => {
    const result = insertMessage.run(fromToken, toToken, groupId, text, sentAt);
    const messageId = Number(result.lastInsertRowid);
    updateLastActivity.run(sentAt, fromToken);
    updateLastActivity.run(sentAt, toToken);
    ackPriorMessagesForSender.run(fromToken, groupId, messageId);
    return messageId;
  }
);

const purgeOldUndeliveredStmt = db.prepare(
  `DELETE FROM messages
   WHERE delivered = 0
     AND sent_at < datetime('now', ?)`
);

const upsertPeerSession = db.prepare(`
  INSERT INTO peer_sessions (session_key, instance_token, group_id, host, cwd, last_active_at, cc_session_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (session_key) DO UPDATE SET
    instance_token = excluded.instance_token,
    last_active_at = excluded.last_active_at,
    cc_session_id = excluded.cc_session_id
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

// Card a2f61172: the ONE normalization point for `role` (trim -> lowercase ->
// validate). Empty/absent/malformed all collapse to NULL, never ''. /register
// must never fail because of a malformed role -- reject-to-null + log.warn
// instead of an error response, so a typo in CLAUDE_PEERS_ROLE can never kill
// a session's registration.
function normalizeRole(raw: unknown): string | null {
  // Card a2f61172 review fix: the router casts the parsed JSON body with a
  // bare `as RegisterRequest` (no runtime shape validation), so a hostile or
  // buggy HTTP client can send role: null / 42 / {} straight through. Without
  // this guard raw.trim() throws and /register 500s -- exactly the failure
  // mode this function's own comment above promises never happens.
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;
  if (!ROLE_REGEX.test(trimmed)) {
    log.warn(`register: rejected malformed role (falling back to null)`, {
      role: trimmed.slice(0, 64),
    });
    return null;
  }
  return trimmed;
}

// register must never fail on a malformed project_key -- a session still needs
// to come up -- so an invalid value collapses to null (not stored) with a warn
// trace, like a malformed role does.
// Trade-off: a peer stored with project_key=null owns zero roadmap locks
// (compared via IS, NULL matches nothing), so its locks get swept as owner-gone
// even while it keeps heartbeating.
function normalizeIncomingProjectKey(
  raw: unknown,
  context: { host: string; client_pid: number }
): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const result = validateProjectKey(raw);
  if (!result.ok) {
    log.warn(`register: rejected invalid project_key, storing null instead`, {
      reason: result.reason,
      length: raw.length,
      host: context.host,
      client_pid: context.client_pid,
    });
    return null;
  }
  return raw;
}

function handleRegister(body: RegisterRequest): RegisterResponse | { error: string; status: number } {
  const groupId = body.group_id;
  const secretHash = body.group_secret_hash;
  const now = new Date().toISOString();
  const normalizedRole = normalizeRole(body.role);
  const projectKey = normalizeIncomingProjectKey(body.project_key, {
    host: body.host,
    client_pid: body.client_pid,
  });

  // 1) Group authentication / TOFU. /register is the one caller that also
  // PINS the secret on first sight, so it keeps its own existing/insert
  // branch (card 37a2b8c7 volet 4) but shares the single exemption predicate.
  if (!isTofuExemptGroup(groupId)) {
    const existing = db.query(
      "SELECT secret_hash FROM groups WHERE group_id = ?"
    ).get(groupId) as { secret_hash: string | null } | null;

    if (existing) {
      if (!safeEqual(existing.secret_hash, secretHash)) {
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

  // 2) Resume lookup keyed on (host, cwd, group_id, desk_session).
  // Card 3d121a74 lot L3-a: the tile token widens the key so N agents sharing
  // one directory each own a row. Absent (non-Deck CLI), the key delegates to
  // the legacy triplet, so an existing legacy row still resurrects.
  const ccSessionId = (body.cc_session_id ?? "").trim();
  const sk = sessionKey(body.host, body.cwd, groupId, body.desk_session);
  let session = db.query(
    "SELECT instance_token FROM peer_sessions WHERE session_key = ?"
  ).get(sk) as { instance_token: string } | null;

  if (!session && ccSessionId) {
    // Secondary lookup only on a key miss, for the Restore gesture (a new tile
    // id, same CC session); the CC session id stays out of the primary key
    // since it rotates on /clear.
    // The empty-string check matters: cc_session_id defaults to '', so an
    // unguarded match would hand out any legacy row's token.
    // Scoped to (group_id, host, cwd) and fails closed when two rows match,
    // rather than picking one and misrouting a token.
    const candidates = db.query(
      `SELECT instance_token FROM peer_sessions
        WHERE group_id = ? AND host = ? AND cwd = ? AND cc_session_id = ?
        LIMIT 2`
    ).all(groupId, body.host, body.cwd, ccSessionId) as { instance_token: string }[];
    if (candidates.length === 1) {
      session = candidates[0] ?? null;
    } else if (candidates.length > 1) {
      log.warn(
        `cc_session_id ${ccSessionId.slice(0, 16)} matches ${candidates.length} session rows; refusing to pick one, minting a fresh peer`
      );
    }
  }

  if (session) {
    const existingPeer = db.query(
      "SELECT instance_token, peer_id, status, pid, host, role FROM peers WHERE instance_token = ?"
    ).get(session.instance_token) as
      | { instance_token: string; peer_id: string; status: "active" | "dormant"; pid: number; host: string; role: string | null }
      | null;

    // If marked active but the local pid is dead, treat as dormant to shrink
    // the post-crash window before the next cleanup tick.
    // Only valid for same-host peers -- probing a different host's pid always
    // throws, and treating that as dead would let the resurrect path silently
    // steal the active peer's identity.
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
      // Card a2f61172 (operator-arbitrated design reversal): role is a
      // property of the LAUNCH, not persistent identity like peer_id/
      // instance_token -- the transport's normalizedRole wins unconditionally
      // here too, overwriting whatever was stored. No comparison, no refusal.
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
        projectKey,
        body.claude_cli_pid ?? null,
        normalizedRole,
        existingPeer.instance_token
      );
      upsertPeerSession.run(sk, existingPeer.instance_token, groupId, body.host, body.cwd, now, ccSessionId);
      return {
        peer_id: existingPeer.peer_id,
        instance_token: existingPeer.instance_token,
        role: normalizedRole,
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
      // Card a2f61172: same rule as every other branch -- the transport's
      // normalizedRole applies.
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
        projectKey,
        body.claude_cli_pid ?? null,
        normalizedRole
      );
      return { peer_id: freshId, instance_token: freshToken, role: normalizedRole };
    }

    // peer row purged but the session_key remembered the token: reinsert reusing it.
    // Card a2f61172: same rule as every other branch -- the transport's
    // normalizedRole applies.
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
      projectKey,
      body.claude_cli_pid ?? null,
      normalizedRole
    );
    upsertPeerSession.run(sk, session.instance_token, groupId, body.host, body.cwd, now, ccSessionId);
    return { peer_id: reusedId, instance_token: session.instance_token, role: normalizedRole };
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
    projectKey,
    body.claude_cli_pid ?? null,
    normalizedRole
  );
  upsertPeerSession.run(sk, newToken, groupId, body.host, body.cwd, now, ccSessionId);
  return { peer_id: newPeerId, instance_token: newToken, role: normalizedRole };
}

// Card 37a2b8c7 review follow-up (MAJOR-2): the client-declared instance_token
// is treated as identity proof on 8 routes, not just the 3 volet-2 originally
// covered (send-message/poll-messages/peek-messages). A sentinel's row is REAL
// (seeded at boot, group_id 'default'), so these 5 handlers don't merely leak
// a read -- they let an attacker who guesses/knows the public "__operator__"
// or "__deck__" string mutate or DESTROY that row directly by declaring it as
// their own instance_token. Same guard, same shape predicate, at the same
// refuse-before-lookup point as the original 3.
function refuseSentinelInstanceToken(route: string, token: string): string | null {
  if (!isSentinelInstanceToken(token)) return null;
  log.warn(`${route}: refused a sentinel-shaped instance_token`, {
    instance_token: token.slice(0, 64),
  });
  return "instance_token cannot be a reserved sentinel identity";
}

function handleHeartbeat(body: HeartbeatRequest): { error: string } | void {
  const refused = refuseSentinelInstanceToken("heartbeat", body.instance_token);
  if (refused) return { error: refused };
  updateLastSeen.run(new Date().toISOString(), body.instance_token);
}

function handleSetSummary(body: SetSummaryRequest): { error: string } | void {
  const refused = refuseSentinelInstanceToken("set-summary", body.instance_token);
  if (refused) return { error: refused };
  updateSummary.run(body.summary, body.instance_token);
}

function handleDisconnect(body: DisconnectRequest): { error: string } | void {
  const refused = refuseSentinelInstanceToken("disconnect", body.instance_token);
  if (refused) return { error: refused };
  db.run(
    "UPDATE peers SET status = 'dormant', last_seen = ? WHERE instance_token = ?",
    [new Date().toISOString(), body.instance_token]
  );
}

function handleUnregister(body: UnregisterRequest): { error: string } | void {
  // Worst blast radius of the 5: unguarded, this DELETEs every undelivered
  // operator-inbox message across every group in one call, then the sentinel
  // row itself -- after which /send-message to 'operator' 404s on the FK
  // until the next boot reseeds it. Disclosure (volet 2) and destruction
  // (this route) are the same primitive, same prerequisite, two doors.
  const refused = refuseSentinelInstanceToken("unregister", body.instance_token);
  if (refused) return { error: refused };
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
  // The check above only guards the TARGET name. Without also refusing a
  // sentinel-shaped CALLER instance_token, a request could rename the
  // '__operator__'/'__deck__' row itself to any non-reserved peer_id.
  const refused = refuseSentinelInstanceToken("set-id", body.instance_token);
  if (refused) return { error: refused, status: 403 };
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

// B1: strip the routing token + local PIDs before a peer row crosses the HTTP
// boundary. Only the public columns are serialized to any client.
function toPublicPeer(p: Peer): PublicPeer {
  const { instance_token: _t, pid: _p, client_pid: _c, ...pub } = p;
  return pub;
}

// NF-A: resolve a message's sender to its public identity (peer_id + meta),
// server-side, so poll/peek never expose from_token/to_token. Reserved senders
// (deck/operator) map to their sentinel peer_id; an unresolvable/gone sender
// yields an empty from_peer_id (the client renders a "<dormant peer>" placeholder).
function resolveSenderMeta(
  fromToken: InstanceToken
): { from_peer_id: string; from_summary: string; from_host: string; from_cwd: string } {
  // Card 37a2b8c7 volet 3: loop over SENTINEL_DEFINITIONS instead of one
  // literal `if` per sentinel, so a third entry is mapped automatically.
  const sentinel = SENTINEL_DEFINITIONS.find((d) => d.instanceToken === fromToken);
  if (sentinel) {
    return { from_peer_id: sentinel.peerId, from_summary: "", from_host: "", from_cwd: "" };
  }
  const s = db.query(
    "SELECT peer_id, summary, host, cwd FROM peers WHERE instance_token = ?"
  ).get(fromToken) as { peer_id: string; summary: string; host: string; cwd: string } | null;
  return s
    ? { from_peer_id: s.peer_id, from_summary: s.summary, from_host: s.host, from_cwd: s.cwd }
    : { from_peer_id: "", from_summary: "", from_host: "", from_cwd: "" };
}

function handleListPeers(body: ListPeersRequest): PublicPeer[] {
  // Review pass 2 (card 37a2b8c7): the 9th route trusting a client-declared
  // instance_token as identity proof -- found by enumerating shared/types.ts
  // request interfaces carrying the field, not by re-reading handlers. No
  // live exploit today ('default' has no secret, so the same list is already
  // visible legitimately), but it holds only by two CONTINGENT properties
  // (sentinel rows live in 'default'; 'default' has no secret), one of which
  // volet 1's pending arbitration may change -- guard now rather than
  // document-and-hope. Empty result on refusal (never [error]) matches
  // poll/peek's validated "don't confirm to attacker" asymmetry.
  if (refuseSentinelInstanceToken("list-peers", body.instance_token)) return [];
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
    .map((p): PublicPeer => {
      let activity_status: Peer["activity_status"];
      if (p.status === "dormant") {
        activity_status = "closed";
      } else if (p.last_activity_at && now - new Date(p.last_activity_at).getTime() <= ACTIVITY_TIMEOUT_MS) {
        activity_status = "active";
      } else {
        activity_status = "sleep";
      }
      // Project to the public shape: instance_token / pids never leave the broker.
      return toPublicPeer({ ...p, activity_status });
    });
}

function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
  // Card 37a2b8c7 volet 2 (Chain A): the sentinel constants are PUBLIC, so a
  // client declaring one as ITS OWN from_token is an impersonation attempt,
  // never a legitimate identity -- refuse by shape before the lookup can ever
  // resolve it. Mirrors resolveRoadmapAuthor's refusal (layer 1, card 39c40571).
  if (isSentinelInstanceToken(body.from_token)) {
    log.warn(`send-message: refused sentinel-shaped from_token`, { from_token: body.from_token.slice(0, 64) });
    return { ok: false, error: "from_token cannot be a reserved sentinel identity" };
  }
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
  // Card 37a2b8c7 volet 1: the DEPOSIT half. A TOFU-exempt group cannot hold
  // the operator inbox (see groupMayCarryOperatorInbox), and the drain there is
  // refused, so accepting the write would store a message nobody can ever read.
  if (body.to_peer_id === OPERATOR_PEER_ID && !groupMayCarryOperatorInbox(sender.group_id)) {
    log.warn(`send-message: refused operator deposit in a secret-less group`, {
      group_id: sender.group_id,
      from_peer_id: sender.peer_id,
    });
    return {
      ok: false,
      // Review MINOR-2: the group is INTERPOLATED, not hardcoded as "default".
      // The refusal derives from isTofuExemptGroup, so a second exempt group
      // would inherit it -- and a message naming the wrong group would
      // contradict the very guard that produced it.
      error: `The operator inbox is unavailable in the '${sender.group_id}' group: it pins no secret, so anyone could read it. Join a group with a secret (a Koryphaios Deck always does) to message the operator.`,
    };
  }

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

  // Group auth (card 37a2b8c7 volet 4: shared checkGroupSecret, was its own
  // copy of the TOFU check). A group no peer has registered yet has no
  // members -> sent:0 below.
  const announceSecretError = checkGroupSecret(groupId, body.group_secret_hash ?? null);
  if (announceSecretError) return announceSecretError;

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

// Card 1d9f25e5: group_id comes from the CALLER, not from a lookup here.
// The single caller (ws-auth handshake, ~line 4715) already reads it off the
// same peers row it just used to confirm `status = 'active'`, one query
// earlier -- passing it through makes "this token's group is known" a
// STRUCTURAL guarantee (one read, no second query that could diverge or need
// its own early-return branch), not a comment asserting an execution-order
// fact about a second, separate lookup.
function flushPendingForToken(token: InstanceToken, group_id: string): void {
  const ws = wsPool.get(token);
  if (!ws || ws.readyState !== 1) return;
  type MessageRow = Omit<Message, "delivered"> & { delivered: number };
  // Capped replay: only the last FLUSH_MAX_COUNT messages within FLUSH_MAX_AGE_HOURS.
  // Beyond that, the LLM can still pull the full backlog via check_messages.
  const cutoff = `-${FLUSH_MAX_AGE_HOURS} hours`;
  const rows = selectUndeliveredCapped.all(
    token,
    group_id,
    cutoff,
    FLUSH_MAX_COUNT
  ) as MessageRow[];
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

// NF-A: map an internal message row to the public DeliveredMessage — sender
// resolved to peer_id + meta server-side, routing tokens dropped.
function toDeliveredMessage(
  r: Omit<Message, "delivered"> & { delivered: number }
): DeliveredMessage {
  return {
    id: r.id,
    ...resolveSenderMeta(r.from_token),
    group_id: r.group_id,
    text: r.text,
    sent_at: r.sent_at,
    delivered: Boolean(r.delivered),
  };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  // Card 37a2b8c7 volet 2 (Chain A, worst path): selectUndelivered has no
  // group_id filter, so a client declaring a sentinel instance_token would
  // drain (and mark delivered, i.e. destroy) every group's messages addressed
  // to that sentinel -- e.g. every operator inbox on the broker at once.
  // Refuse by shape before the lookup, mirroring resolveRoadmapAuthor.
  if (isSentinelInstanceToken(body.instance_token)) {
    log.warn(`poll-messages: refused sentinel-shaped instance_token`, { instance_token: body.instance_token.slice(0, 64) });
    return { messages: [] };
  }
  type MessageRow = Omit<Message, "delivered"> & { delivered: number };
  const rows = selectUndelivered.all(body.instance_token) as MessageRow[];
  for (const row of rows) {
    markDelivered.run(row.id);
  }
  return { messages: rows.map(toDeliveredMessage) };
}

// Like handlePollMessages but does NOT mark delivered.
// Used by the server-side fallback poll (WS down) to push mcp.notification()
// without consuming messages -- only check_messages marks delivered.
function handlePeekMessages(body: PollMessagesRequest): PollMessagesResponse {
  // Same refusal as handlePollMessages: peek does not mark delivered, but it
  // still leaks the content of every group's sentinel-addressed messages.
  if (isSentinelInstanceToken(body.instance_token)) {
    log.warn(`peek-messages: refused sentinel-shaped instance_token`, { instance_token: body.instance_token.slice(0, 64) });
    return { messages: [] };
  }
  type MessageRow = Omit<Message, "delivered"> & { delivered: number };
  const rows = selectUndelivered.all(body.instance_token) as MessageRow[];
  return { messages: rows.map(toDeliveredMessage) };
}

const ROADMAP_KINDS: readonly RoadmapKind[] = ["feature", "bug", "debt", "idea", "chore", "directive"];
const DIRECTIVE_COMMANDS: readonly RoadmapDirective[] = ["clear", "compact", "magic_compact"];
const MAX_DIRECTIVE_TARGETS = 16;
// card aaf4537d: this batch cap is deliberately separate from the
// directive-target cap -- lock-park/lock-release batch over every live tile in
// a Deck, a different population from a directive's hand-picked target list.
const LOCK_BATCH_MAX_TARGETS = 64;
const ROADMAP_PRIORITIES: readonly RoadmapPriority[] = ["must", "should", "could", "wont"];
const ROADMAP_LEVELS: readonly RoadmapLevel[] = ["low", "medium", "high"];
const ROADMAP_STATUSES: readonly RoadmapStatus[] = [
  "idea",
  "planned",
  "in_progress",
  "done",
  "archived",
];

type RoadmapRow = Omit<
  RoadmapItem,
  | "tags"
  | "depends_on"
  | "locked"
  | "target_peer_ids"
  | "operator_id"
  | "inactive"
  | "sync_state"
  | "lock_scope"
  | "lock_contested_by"
> & {
  tags: string;
  depends_on: string;
  locked: number;
  target_peer_ids: string;
  // NULLable column (no DEFAULT), unlike RoadmapItem.operator_id?: string --
  // bun:sqlite hands back NULL as null, not undefined.
  operator_id: string | null;
  inactive: number;
  // Free-text columns as SQLite returns them; the enums are narrowed on read,
  // never trusted, so a hand-edited database cannot inject a scope value the
  // rest of the code switches on.
  sync_state: string;
  lock_scope: string | null;
  lock_contested_by: string;
  rev: number;
  content_rev: number;
  sync_base_rev: number | null;
  sync_base: string | null;
  sync_dirty: number;
  sync_remote: string | null;
  lock_relay: string | null;
  lock_relay_seen: string | null;
  lock_release_owner: string | null;
};

const ROADMAP_LOCK_SCOPES: readonly RoadmapLockScope[] = [
  "local",
  "global",
  "contested",
  "remote",
  "release_pending",
];

/** Unknown stored value degrades to the safest reading: no conflict, no scope. */
function readSyncState(raw: string | null): RoadmapSyncState {
  return raw === "conflict" ? "conflict" : "clean";
}

function readLockScope(raw: string | null): RoadmapLockScope | null {
  return ROADMAP_LOCK_SCOPES.includes(raw as RoadmapLockScope) ? (raw as RoadmapLockScope) : null;
}

/**
 * Explicit pick-list, not a rest-spread: a table column added later stays
 * invisible here until a line is added for it (fails closed -- silent until
 * noticed) rather than becoming public to every group the moment the migration
 * runs (fails open).
 */
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
    id: row.id,
    project_key: row.project_key,
    kind: row.kind,
    title: row.title,
    description: row.description,
    rationale: row.rationale,
    context: row.context,
    priority: row.priority,
    value: row.value,
    effort: row.effort,
    status: row.status,
    tags: parseList(row.tags),
    depends_on: parseList(row.depends_on),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    queue: row.queue,
    directive: row.directive ?? null,
    // Legacy rows created before the migration have NULL here; default to [].
    target_peer_ids: row.target_peer_ids ? parseList(row.target_peer_ids) : [],
    locked: row.locked === 1,
    locked_by: row.locked_by ?? null,
    locked_at: row.locked_at ?? null,
    locked_group: row.locked_group ?? null,
    locked_by_token: row.locked_by_token ?? null,
    // string|null (SQLite) -> string|undefined (RoadmapItem's optional field).
    operator_id: row.operator_id ?? undefined,
    inactive: row.inactive === 1,
    lock_parked_at: row.lock_parked_at,
    lock_parked_by: row.lock_parked_by,
    sync_state: readSyncState(row.sync_state),
    lock_scope: readLockScope(row.lock_scope),
    // Legacy rows created before the migration have NULL here; default to [].
    lock_contested_by: row.lock_contested_by ? parseList(row.lock_contested_by) : [],
  };
}

/** Sanitize an optional string[] payload into a JSON-storable list. */
function cleanList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

/**
 * undefined means the file never mentioned the column, so the existing row's
 * value wins (or '' for a new card); anything else means the file did mention
 * it -- a string is taken as-is, and an explicit null (or any non-string)
 * clears the column, since a self-export must be able to blank a field.
 */
function importedText(value: unknown, existing: string | undefined): string {
  if (value === undefined) return existing ?? "";
  return typeof value === "string" ? value : "";
}

// `maxLen` defaults to MAX_DIRECTIVE_TARGETS for directive callers; lock-park/
// lock-release pass LOCK_BATCH_MAX_TARGETS instead (round-3 review, card
// aaf4537d) precisely so a truncation here can never again read as "nothing
// to do" for the tail -- both call sites now reject loudly BEFORE this
// function runs when the raw array exceeds their own cap, so this break is
// a defense-in-depth backstop, not the enforcement point.
function cleanPeerIds(v: unknown, maxLen: number = MAX_DIRECTIVE_TARGETS): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const id = x.trim();
    if (!PEER_ID_REGEX.test(id) || RESERVED_PEER_IDS.includes(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= maxLen) break;
  }
  return out;
}

function badEnum<T extends string>(value: unknown, allowed: readonly T[]): boolean {
  return value !== undefined && !allowed.includes(value as T);
}

function getRoadmapItem(id: string): RoadmapItem | null {
  const row = getRoadmapRow(id);
  return row ? rowToRoadmapItem(row) : null;
}

/**
 * The raw row, replication columns included -- `id` is the table's primary
 * key, so this `.get()` can only ever name one card. Callers that only need
 * the public item use getRoadmapItem; this one exists for the paths that must
 * read or carry over `rev`/`sync_*`/`lock_relay*`, which the public projection
 * deliberately drops.
 */
function getRoadmapRow(id: string): RoadmapRow | null {
  return db.query("SELECT * FROM roadmap_items WHERE id = ?").get(id) as RoadmapRow | null;
}

/**
 * Resolves WHO is writing before deciding whether the caller may act as it: a
 * presented instance_token wins over `by`, a sentinel token is refused
 * outright, and with no token the write may only claim a name belonging to no
 * real peer.
 * `proven` is what a caller-sensitive rule (currently `force`) keys on.
 */
interface RoadmapAuthor {
  by: string;
  proven: boolean;
  /**
   * Card edefff05: the operator credential's digest (auth.operator_id), set
   * ONLY in the reserved-peer-name branch below (a signed 'deck'/'operator'/
   * 'system' write) -- an ordinary agent's `by` is already its peer_id, so
   * there is no operator to name. Callers persist this onto
   * RoadmapItem.operator_id; see that field's doc for the ownership-vs-
   * attribution distinction.
   */
  operator_id?: string;
  /**
   * Card e344fa79: the resolved author's OWN group_id -- set ONLY on the
   * instance_token branch below, the one branch that reads a real `peers`
   * row (peer_id alone is not enough to know a peer's group; the row is).
   * `undefined` on the reserved-name/operator branch (a signature proves a
   * human, not a peer row -- there is no group to name) and on the unproven
   * fallback (no token means no row to read). Callers compare and persist
   * this value RAW against `locked_group` (see RoadmapItem.locked_group's
   * doc comment for why storing it raw is safe here).
   */
  group_id?: string;
  /**
   * Card 4441e883, mecanisme B: the caller's own, PROVEN `instance_token` --
   * set ONLY on the instance_token branch below (same one branch that sets
   * `group_id`, the one that reads a real `peers` row: the token itself is
   * that row's primary key, so a value here is unambiguous by construction).
   * `undefined` on the reserved-name/operator branch (a signature proves a
   * human, not a peer session -- there is no token to name) and on the
   * unproven fallback (no token was presented at all). Callers stamp this
   * onto `RoadmapItem.locked_by_token` ONLY on an actual lock claim (see
   * that field's doc comment) -- NEVER derived from `by`/`group_id`, and
   * never guessed when this is `undefined`.
   */
  instance_token?: string;
}

/**
 * Shared normalization for any author-identity field, also used for locked_by
 * on import -- the one other caller-supplied string that becomes an author
 * column outside this resolver.
 * Returns the offending character on failure, never the value: the error can
 * reach an LLM-facing tool-error context, where echoing a hostile string back
 * gains nothing.
 * Refuses the empty string explicitly: the regex this replaced already did via
 * `+`, but a plain disallowed-character search over '' would silently return
 * ok:true.
 */
function normalizeAuthorIdentity(
  raw: string
): { ok: true; value: string } | { ok: false; code: "empty" } | { ok: false; code: "bad_char"; badChar: string } {
  if (raw.length === 0) return { ok: false, code: "empty" };
  const value = raw.toLowerCase();
  const badCharMatch = value.match(/[^a-z0-9:_-]/);
  if (badCharMatch) return { ok: false, code: "bad_char", badChar: badCharMatch[0]! };
  return { ok: true, value };
}

function resolveRoadmapAuthor(
  body: { by?: unknown; instance_token?: unknown },
  route: string
): RoadmapAuthor | { error: string; status: number } {
  const rawBy = typeof body.by === "string" ? body.by.trim() : "";
  if (!rawBy) return { error: "by (author peer_id) is required", status: 400 };

  // Normalized before any comparison, not just at the reserved-name check --
  // `by` is free text, so it never passes through the same format gate a real
  // peer_id does.
  // Rejects on shape (lowercase, then anything outside the allowed charset)
  // rather than only folding case: a homoglyph or invisible character could
  // still display as a reserved name to the operator while bypassing a
  // case-only check.
  const normalizedBy = normalizeAuthorIdentity(rawBy);
  if (!normalizedBy.ok) {
    log.warn(`${route}: refused an author claim with a character outside [a-z0-9:_-]`, {
      claimed_by: rawBy,
    });
    return {
      // Names the offending CHARACTER, not the value (reviewer NIT, card
      // ad6aa6ed): this text can reach an LLM via roadmapToolError, and the
      // caller already knows what it sent. `code === "empty"` is
      // unreachable here (rawBy already refused empty above) but handled
      // for exhaustiveness, not assumed away.
      error:
        normalizedBy.code === "empty"
          ? "author is empty"
          : `author contains a disallowed character '${normalizedBy.badChar}' -- only [a-z0-9:_-] allowed`,
      status: 400,
    };
  }
  const by = normalizedBy.value;

  // 'deck' names the operator, and `proven` is what walks the work-lock guard,
  // so this reserved-name check must run BEFORE the instance_token branch below
  // -- reversed, a peer registered with a reserved hostname could resolve to a
  // proven claim via its own real token and skip the signature entirely.
  // Routed through the approval-auth layer so it inherits the signature check,
  // nonce replay guard, and operation table in one move.
  // Keyed on the whole reserved set, not one literal, so a future reserved name
  // inherits the protection automatically.
  if (RESERVED_PEER_IDS.includes(by)) {
    // Card 1def56da: identity, not scope. This is a ROADMAP write; it does not
    // touch `pending_approvals` at all, and it needs only the signature check,
    // the nonce replay guard and the operation table -- which is exactly why it
    // was routed through the approval authenticator in the first place.
    const auth = approvalAuth.authenticateOperator(
      body as { auth?: ApprovalAuthProof } & Record<string, unknown>,
      "roadmap-write"
    );
    if (isAuthError(auth)) {
      // LOUD, and specific enough to answer the question a silent refusal
      // cannot: an operator reading this knows the guard EXISTS and fired.
      // Silence here means the running broker predates this code -- a live
      // process can be hours older than the commit, and the two cases look
      // identical from the outside unless the refusal says so itself.
      log.warn(`${route}: refused an unsigned write claiming the reserved '${by}' author`, {
        reason: auth.error,
        status: auth.status,
      });
      return {
        error: `author '${by}' is a reserved identity naming the operator: sign the write with the operator credential (${auth.error}). A Deck older than this broker does not sign yet -- update it.`,
        status: auth.status,
      };
    }
    return { by, proven: true, operator_id: auth.operator_id };
  }

  const token = typeof body.instance_token === "string" ? body.instance_token.trim() : "";
  if (token) {
    if (isSentinelInstanceToken(token)) {
      log.warn(
        `${route}: refused a reserved sentinel instance_token (public constant, not a credential)`,
        { claimed_by: by }
      );
      return { error: "instance_token is a reserved sentinel", status: 403 };
    }
    // instance_token is the peers PRIMARY KEY, so this row is unambiguous.
    // group_id read alongside peer_id (card e344fa79): this is the one
    // lookup that can name the caller's OWN group unambiguously.
    const owner = db
      .query("SELECT peer_id, group_id FROM peers WHERE instance_token = ?")
      .get(token) as { peer_id: string; group_id: string } | null;
    if (!owner) {
      log.warn(`${route}: refused an unknown instance_token`, { claimed_by: by });
      return { error: "unknown instance_token", status: 401 };
    }
    // The resolved peer_id is checked too, not just the claimed one: a row
    // named after a reserved identity minted before that was blocked can still
    // exist in live databases, and this branch would otherwise hand it proven
    // authorship on the strength of its own token.
    if (RESERVED_PEER_IDS.includes(owner.peer_id)) {
      log.warn(`${route}: refused a token whose peer_id is a reserved identity`, {
        peer_id: owner.peer_id,
      });
      return {
        // Names the REMEDY, not just the refusal: this peer is legitimate (it
        // holds a real token) and is refused for its NAME alone, so a message
        // stopping at "reserved" reads as a breakage.
        //
        // The remedy is set_id, NOT re-registration, and the difference was
        // measured rather than assumed. Reconnecting cannot rename this peer:
        // resume is keyed on session_key and the dormant branch returns the
        // peer_id READ FROM THE ROW, so a legacy row named 'deck' comes back
        // named 'deck' with the same token. set_id refuses reserved names as a
        // TARGET, never as a source, so renaming AWAY from one is allowed.
        error: `peer_id '${owner.peer_id}' is a reserved identity and cannot author a roadmap write. This peer was registered before reserved names were refused: call set_id with a normal name (reconnecting will NOT rename it, the id is restored from the session row), then retry.`,
        status: 403,
      };
    }
    return { by: owner.peer_id, proven: true, group_id: owner.group_id, instance_token: token };
  }

  // Card 39c40571 LAYER 2: the one author layer 1 still took on faith.
  //
  // 'deck' names the operator, and its row carries a sentinel token, so the
  // check below reads it as "belongs to no real peer" and lets it through.
  // Any holder of the shared BROKER_TOKEN could therefore write as the human
  // and, through `proven`, walk the work-lock guard with force. The Deck now
  // SIGNS with the operator credential (Ed25519, operator_id = digest of the
  // public key, so it is self-certifying) and an unsigned claim is refused.
  //
  // No proof. Ask whether the claimed NAME belongs to a real peer -- deliberately
  // over every row rather than a `.get()`: one peer_id can exist in two groups
  // (two identities), and picking one of the two rows would answer at random.
  const rows = db
    .query("SELECT instance_token FROM peers WHERE peer_id = ?")
    .all(by) as { instance_token: string }[];
  if (rows.some((r) => !isSentinelInstanceToken(r.instance_token))) {
    log.warn(`${route}: refused an unproven write claiming a registered peer`, {
      claimed_by: by,
    });
    return {
      error: `author '${by}' is a registered peer -- prove it with its instance_token`,
      status: 401,
    };
  }
  return { by, proven: false };
}

/**
 * Card 15952e09: union a legacy singular filter with its plural counterpart,
 * deduped. `singular` may be `undefined` (no plural counterpart exists yet
 * for `effort`/`value`, so callers pass `undefined` there).
 */
function mergeEnumFilter<T extends string>(singular: T | undefined, plural: T[] | undefined): T[] {
  const out = new Set<T>();
  if (singular !== undefined) out.add(singular);
  if (plural) for (const v of plural) out.add(v);
  return [...out];
}

/** Array form of `badEnum`: true if any value in `values` is outside `allowed`. */
function invalidValues<T extends string>(values: readonly T[], allowed: readonly T[]): boolean {
  return values.some((v) => !allowed.includes(v));
}

/**
 * Card 15952e09, guard #3a: the caller's free-text `q` must never reach the
 * FTS5 MATCH expression by string concatenation. Split on whitespace, drop
 * tokens that are pure FTS5 punctuation once stripped of quotes, then wrap
 * each surviving token as its own quoted phrase (doubling internal `"`,
 * FTS5's own escaping rule) so it carries no operator meaning of its own
 * (`:`, `*`, `(`, `)`, `-`, bare AND/OR/NOT). Returns `[]` when nothing
 * survives, so the caller never emits `MATCH ''`.
 */
function tokenizeFtsQuery(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.replace(/"/g, "").length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
}

/**
 * `q_deep` toggles the COLUMN FILTER of the query, not the table (decision
 * 3 on card 15952e09): title+description+tags by default, +rationale+context
 * when the caller opts in. Returns null when `q` has no searchable token.
 */
function buildFtsMatchExpr(q: string, deep: boolean): string | null {
  const tokens = tokenizeFtsQuery(q);
  if (tokens.length === 0) return null;
  const cols = deep ? "title description tags rationale context" : "title description tags";
  return `{${cols}} : (${tokens.join(" ")})`;
}

/**
 * Unconditionally includes archived cards' tags, unlike the facet counts
 * elsewhere which respect the caller's include_archived -- this list only backs
 * the 'unknown tag' error, and a tag surviving only on archived cards must not
 * read as unknown just because a request happened to exclude them.
 */
function projectExistingTags(projectKey: string): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT je.value AS value FROM roadmap_items t, json_each(t.tags) je
        WHERE t.project_key = ? ORDER BY value`
    )
    .all(projectKey) as { value: string }[];
  return rows.map((r) => r.value);
}

/**
 * Card 15952e09, decision 5: facets are counted over the REFERENCE set --
 * this project's items after `include_archived` alone, no other filter --
 * never over the caller's filtered result (a counter calculated on the
 * filtered result would fall to zero or to itself the moment a filter is
 * active). Fixed-enum dimensions always emit every enum value, zero-count
 * buckets included; `tags` is dynamic and lists only tags that occur.
 * `project_key` is repeated in every query below (guard #3b): none of these
 * queries touch the FTS table, but they must each re-assert project_key on
 * their own, the same discipline the FTS-joined query in handleRoadmapList
 * needs for the same reason.
 */
function computeRoadmapFacets(projectKey: string, includeArchived: boolean): RoadmapFacets {
  const archived = (prefix: string) => (includeArchived ? "" : ` AND ${prefix}status != 'archived'`);

  const referenceTotal = (
    db.query(`SELECT COUNT(*) AS n FROM roadmap_items WHERE project_key = ?${archived("")}`).get(projectKey) as {
      n: number;
    }
  ).n;

  function fixedFacet<T extends string>(column: string, allowed: readonly T[]): RoadmapFacetBucket[] {
    const rows = db
      .query(
        `SELECT ${column} AS value, COUNT(*) AS count FROM roadmap_items
          WHERE project_key = ?${archived("")} GROUP BY ${column}`
      )
      .all(projectKey) as { value: string; count: number }[];
    const counts = new Map(rows.map((r) => [r.value, r.count]));
    return allowed.map((value) => ({ value, count: counts.get(value) ?? 0 }));
  }

  const tags = (
    db
      .query(
        `SELECT je.value AS value, COUNT(DISTINCT t.id) AS count
           FROM roadmap_items t, json_each(t.tags) je
          WHERE t.project_key = ?${archived("t.")}
          GROUP BY je.value
         HAVING COUNT(DISTINCT t.id) >= 1
          ORDER BY value`
      )
      .all(projectKey) as { value: string; count: number }[]
  ).map((r) => ({ value: r.value, count: r.count }));

  return {
    kind: fixedFacet("kind", ROADMAP_KINDS),
    priority: fixedFacet("priority", ROADMAP_PRIORITIES),
    effort: fixedFacet("effort", ROADMAP_LEVELS),
    value: fixedFacet("value", ROADMAP_LEVELS),
    status: fixedFacet("status", ROADMAP_STATUSES),
    tags,
    reference_total: referenceTotal,
  };
}

function handleRoadmapList(
  body: RoadmapListRequest
): RoadmapListResponse | { error: string; status: number } {
  if (!body.project_key || typeof body.project_key !== "string") {
    return { error: "project_key is required", status: 400 };
  }

  const kindsEff = mergeEnumFilter(body.kind, body.kinds);
  const statusesEff = mergeEnumFilter(body.status, body.statuses);
  const prioritiesEff = mergeEnumFilter(body.priority, body.priorities);
  const effortsEff = mergeEnumFilter<RoadmapLevel>(undefined, body.efforts);
  const valuesEff = mergeEnumFilter<RoadmapLevel>(undefined, body.values);
  const tagsEff = mergeEnumFilter(body.tag, body.tags);

  if (
    invalidValues(kindsEff, ROADMAP_KINDS) ||
    invalidValues(statusesEff, ROADMAP_STATUSES) ||
    invalidValues(prioritiesEff, ROADMAP_PRIORITIES) ||
    invalidValues(effortsEff, ROADMAP_LEVELS) ||
    invalidValues(valuesEff, ROADMAP_LEVELS)
  ) {
    return { error: "invalid kind/status/priority/effort/value filter", status: 400 };
  }

  const includeArchived = !!body.include_archived;

  // Unknown tag value is a 400, not a silent empty result -- a typo must not
  // read back as 'no such card'.
  // The reference set validated against is always the full project, archived
  // cards included, independent of this request's own include_archived.
  // Legacy singular `tag` gets the same 400 as plural `tags`: one engine, one
  // semantics.
  if (tagsEff.length > 0) {
    const existing = projectExistingTags(body.project_key);
    const unknown = tagsEff.filter((t) => !existing.includes(t));
    if (unknown.length > 0) {
      const known = existing.length > 0 ? existing.join(", ") : "(this project has no tags yet)";
      return {
        error: `unknown tag(s) ${unknown.map((t) => `'${t}'`).join(", ")} -- this project's tags are: ${known}`,
        status: 400,
      };
    }
  }

  const matchExpr = body.q ? buildFtsMatchExpr(body.q, !!body.q_deep) : null;

  // A card's short id lives in no FTS column, so a plain search for it only
  // matches cards that happen to mention it in text, not the card it actually
  // is.
  // An `id LIKE 'prefix%'` predicate is ORed alongside the FTS branch instead,
  // at a threshold of 4+ hex characters -- short enough to catch the short id,
  // long enough that an ordinary word rarely qualifies by accident.
  const qTrimmed = body.q?.trim();
  const idPrefix = qTrimmed && /^[0-9a-f]{4,}$/i.test(qTrimmed) ? qTrimmed : null;

  // The FTS table holds one row per card across all projects with no project
  // scoping of its own, so every FTS-joined query must re-assert project_key
  // itself or it leaks cards from other projects.
  let sql: string;
  const params: (string | number)[] = [];
  if (matchExpr && idPrefix) {
    // Both branches present: a text query that also happens to look like a
    // hex id prefix. bm25() ranking is dropped here (it requires the FTS
    // table joined directly, not via subquery) -- see the ORDER BY below.
    sql =
      "SELECT t.* FROM roadmap_items t WHERE t.project_key = ? AND (t.id LIKE ? OR t.rowid IN (SELECT rowid FROM roadmap_fts WHERE roadmap_fts MATCH ?))";
    params.push(body.project_key, `${idPrefix}%`, matchExpr);
  } else if (matchExpr) {
    sql =
      "SELECT t.* FROM roadmap_items t, roadmap_fts WHERE t.rowid = roadmap_fts.rowid AND roadmap_fts MATCH ? AND t.project_key = ?";
    params.push(matchExpr, body.project_key);
  } else if (idPrefix) {
    sql = "SELECT t.* FROM roadmap_items t WHERE t.project_key = ? AND t.id LIKE ?";
    params.push(body.project_key, `${idPrefix}%`);
  } else {
    sql = "SELECT t.* FROM roadmap_items t WHERE t.project_key = ?";
    params.push(body.project_key);
  }

  if (statusesEff.length > 0) {
    sql += ` AND t.status IN (${statusesEff.map(() => "?").join(", ")})`;
    params.push(...statusesEff);
  } else if (!includeArchived) {
    sql += " AND t.status != 'archived'";
  }
  if (kindsEff.length > 0) {
    sql += ` AND t.kind IN (${kindsEff.map(() => "?").join(", ")})`;
    params.push(...kindsEff);
  }
  if (prioritiesEff.length > 0) {
    sql += ` AND t.priority IN (${prioritiesEff.map(() => "?").join(", ")})`;
    params.push(...prioritiesEff);
  }
  if (effortsEff.length > 0) {
    sql += ` AND t.effort IN (${effortsEff.map(() => "?").join(", ")})`;
    params.push(...effortsEff);
  }
  if (valuesEff.length > 0) {
    sql += ` AND t.value IN (${valuesEff.map(() => "?").join(", ")})`;
    params.push(...valuesEff);
  }
  if (tagsEff.length > 0) {
    // Decision 4: tag lives in SQL (json_each), not a JS post-fetch filter --
    // one predicate engine, so bm25 ordering and every other filter compose
    // with it instead of a second engine silently dropping rows after the
    // fact.
    sql += ` AND EXISTS (SELECT 1 FROM json_each(t.tags) je WHERE je.value IN (${tagsEff
      .map(() => "?")
      .join(", ")}))`;
    params.push(...tagsEff);
  }

  // Only order by relevance when a text query was actually present -- never
  // change the existing order as a side effect of an unrelated filter.
  // bm25() ranking only holds when roadmap_fts is joined directly in FROM
  // (the matchExpr-only branch above); the combined branch queries it via a
  // subquery, so it falls back to the same stable order as the no-query case.
  sql += matchExpr && !idPrefix ? " ORDER BY bm25(roadmap_fts)" : " ORDER BY t.created_at, t.id";

  const items = (db.query(sql).all(...params) as RoadmapRow[]).map(rowToRoadmapItem);

  const response: RoadmapListResponse = { items };
  if (body.with_facets) {
    response.facets = computeRoadmapFacets(body.project_key, includeArchived);
  }
  return response;
}

/**
 * Only a write that actually moves `queue` to a new value is refused, never a
 * client round-tripping its already-queued position on every save -- an
 * absolute check would 403 every later edit of an unrelated field once an
 * inactive card is queued.
 * Un-queuing is never refused: it is the safe direction, same as clearing a
 * lock is not a claim.
 */
function refusesInactiveQueue(
  storedInactive: boolean,
  storedQueue: number | null,
  nextQueue: number | null | undefined
): boolean {
  return storedInactive && nextQueue != null && nextQueue !== storedQueue;
}

function handleRoadmapUpsert(
  body: RoadmapUpsertRequest
): RoadmapUpsertResponse | { error: string; status: number } {
  const author = resolveRoadmapAuthor(body, "/roadmap/upsert");
  if ("error" in author) return author;
  const by = author.by;
  if (
    badEnum(body.kind, ROADMAP_KINDS) ||
    badEnum(body.priority, ROADMAP_PRIORITIES) ||
    badEnum(body.value, ROADMAP_LEVELS) ||
    badEnum(body.effort, ROADMAP_LEVELS) ||
    badEnum(body.status, ROADMAP_STATUSES)
  ) {
    return { error: "invalid kind/priority/value/effort/status", status: 400 };
  }
  // Directive card fields (CT1). `directive` may be explicitly cleared (null);
  // any other non-enum value is rejected. target_peer_ids, when present, must be
  // an array (individual entries are sanitized by cleanPeerIds).
  if (badEnum(body.directive ?? undefined, DIRECTIVE_COMMANDS)) {
    return { error: "invalid directive (clear|compact|magic_compact)", status: 400 };
  }
  if (body.target_peer_ids !== undefined) {
    if (!Array.isArray(body.target_peer_ids)) {
      return { error: "target_peer_ids must be an array", status: 400 };
    }
    // Reject over the cap loudly rather than truncating silently (no-silent-
    // errors): the caller learns instead of some targets vanishing unnoticed.
    if (body.target_peer_ids.length > MAX_DIRECTIVE_TARGETS) {
      return {
        error: `too many target_peer_ids (max ${MAX_DIRECTIVE_TARGETS})`,
        status: 400,
      };
    }
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
  if (body.inactive !== undefined && typeof body.inactive !== "boolean") {
    return { error: "inactive must be a boolean", status: 400 };
  }

  if (body.id) {
    // Partial patch: omitted fields keep their value; project_key never moves.
    const existing = getRoadmapItem(body.id);
    if (!existing) return { error: "unknown roadmap item", status: 404 };

    // Card e344fa79: the caller's OWN group -- `undefined` (author.group_id
    // unresolved: an operator/deck-signed write, or an unproven claim with
    // no instance_token) compares as `null`, never as a wildcard match. See
    // matchesLockOwner's doc comment in shared/roadmap-lock.ts.
    const authorLockedGroup = author.group_id ?? null;

    // Work-lock resolution (PLAN K2), resolved ONCE, before the guard, so the
    // guard and the DB write below read the same answer instead of two
    // independent computations that can drift (card e7b364dc's original bug
    // shape). Pure function: shared/roadmap-lock.ts, no I/O, no Date.now().
    const nextStatus: RoadmapStatus = body.status ?? existing.status;
    const resolvedLock = resolveRoadmapLock(existing, nextStatus, body, by);

    // Inactive guards (card c33a5968), resolved right after the lock so both
    // read the same `resolvedLock`/`nextStatus` the write below will use.
    // `existing.inactive`/`existing.status`/`existing.locked` (the STORED,
    // pre-write values) are deliberately used for the arbitration guard
    // below, never the `next*` counterparts -- a single request that both
    // clears `inactive` and claims the card in the same call must still be
    // refused (see refusesInactiveClaim's doc comment, delta form).
    const nextInactive = body.inactive !== undefined ? body.inactive : existing.inactive;
    // Checked via the resolved operator_id, not a name comparison against
    // 'deck' -- equivalent today, but operator_id stays correct if a future
    // signed path is ever added without populating it, where a name-based check
    // would silently start accepting an unsigned toggle.
    if (refusesInactiveToggle(existing.inactive, nextInactive, author.operator_id !== undefined)) {
      return { error: "toggling inactive requires an operator-signed write", status: 403 };
    }
    if (
      refusesInactiveClaim(existing.inactive, existing.status, existing.locked, nextStatus, resolvedLock.locked)
    ) {
      return {
        error: "item is inactive -- clear inactive before moving it to in_progress",
        status: 403,
      };
    }
    // Uses the stored pre-write value, not the incoming one -- a single request
    // that both clears `inactive` and sets `queue` still reads the stored
    // inactive=true and is refused.
    if (refusesInactiveQueue(existing.inactive, existing.queue, body.queue)) {
      return {
        error: "item is inactive -- clear inactive before queuing it",
        status: 403,
      };
    }

    // Lock guard (PLAN K2): while an agent holds the work-lock, only the owner
    // or the operator ('deck') may write the item's status or claim the lock
    // (a same-status in_progress write IS a claim attempt). Other writes
    // (context enrichment, tags...) stay open to everyone -- EXCEPT when the
    // write would drop the lock as a side effect, which the delta clause
    // below refuses too: a locked item whose stored status is already not
    // in_progress resolves `nextStatus !== "in_progress"` to true even from a
    // body with neither `status` nor `locked` set, so an unrelated-field
    // write from a third party would otherwise silently clear the lock.
    if (
      existing.locked &&
      // Checks whether the resolved lock outcome actually differs from the
      // existing row, rather than enumerating body field names that might move
      // the lock -- an enumerated list needs manual upkeep for every new field
      // and silently misses one.
      // The status field must survive on its own: a same-status write from an
      // intruder resolves to zero delta yet is still an attempted claim.
      (body.status !== undefined ||
        resolvedLock.locked !== existing.locked ||
        resolvedLock.lockedBy !== existing.locked_by) &&
      // Card e344fa79: the OWNER check is a (peer_id, group) pair, not a bare
      // peer_id -- `by !== existing.locked_by` alone let a legitimately-
      // registered homonym peer in a DIFFERENT group satisfy this guard,
      // since peer_id is unique only per group. See matchesLockOwner.
      !matchesLockOwner(existing.locked_by, existing.locked_group, by, authorLockedGroup) &&
      by !== "deck" &&
      // `force` is a claim of certainty, honoured only for a proven caller --
      // an anonymous body could otherwise steal any locked item by adding one
      // field.
      // The reserved-name clause beside it is closed separately, upstream: an
      // unproven claim to it is already refused before this guard runs.
      !(body.force === true && author.proven)
    ) {
      return {
        error: `item is locked by '${existing.locked_by}' (actively working on it) -- pick another item, or pass force:true if you are certain`,
        status: 409,
      };
    }

    // Card bc0ccb17: same parked-archive guard as handleRoadmapArchive. Upsert
    // can also drive a card to status='archived' directly (RoadmapStatus
    // enum includes it, and the write below stamps deleted_at exactly like
    // /roadmap/archive does) -- without this check that second path bypassed
    // the guard entirely, a disguised fail-open of the same protection
    // archive() already enforces. Checked on `nextStatus`, not on a
    // from-not-archived transition, so a parked card re-saved with
    // status='archived' stays refused on every call, not only the first.
    if (
      nextStatus === "archived" &&
      refusesParkedArchive(
        existing.lock_parked_by,
        existing.lock_parked_at,
        new Date().toISOString(),
        LOCK_PARK_TTL_SEC,
        author.operator_id
      )
    ) {
      return {
        error: `item is parked by '${existing.lock_parked_by}' -- cannot archive`,
        status: 409,
      };
    }

    // Directive coherence (CT1): a 'directive' item must carry a valid command;
    // any other kind must not. Fields resolve against the existing row on patch.
    const nextKind = body.kind ?? existing.kind;
    let nextDirective: RoadmapDirective | null;
    let nextTargets: string[];
    if (nextKind === "directive") {
      nextDirective = (body.directive ?? existing.directive) ?? null;
      if (!nextDirective || !DIRECTIVE_COMMANDS.includes(nextDirective)) {
        return {
          error: "kind 'directive' requires a directive (clear|compact|magic_compact)",
          status: 400,
        };
      }
      nextTargets =
        body.target_peer_ids !== undefined
          ? cleanPeerIds(body.target_peer_ids)
          : existing.target_peer_ids;
    } else {
      if (body.directive != null) {
        return { error: "directive is only valid for kind 'directive'", status: 400 };
      }
      nextDirective = null;
      nextTargets = [];
    }

    const next: RoadmapItem = {
      ...existing,
      kind: nextKind,
      title: body.title !== undefined ? body.title.trim() : existing.title,
      description: body.description ?? existing.description,
      rationale: body.rationale ?? existing.rationale,
      context: body.context ?? existing.context,
      priority: body.priority ?? existing.priority,
      value: body.value ?? existing.value,
      effort: body.effort ?? existing.effort,
      status: nextStatus,
      tags: cleanList(body.tags) ?? existing.tags,
      depends_on: cleanList(body.depends_on) ?? existing.depends_on,
      directive: nextDirective,
      target_peer_ids: nextTargets,
      queue: body.queue !== undefined ? body.queue : existing.queue,
      updated_by: by,
      inactive: nextInactive,
    };
    if (!next.title) return { error: "title cannot be empty", status: 400 };

    // Reuses the same lock resolution computed earlier rather than resolving a
    // second time -- two separate reads of the body drifting apart is what
    // produced the original bug this closes.
    // Keys on whether the write actually claimed the lock, not a
    // same-owner-name comparison: a name match reads true on an ordinary
    // third-party write too, which stamped that writer's own group onto
    // locked_group even though nobody reclaimed the lock.
    const keptLockedAt = resolveKeptLockedAt(resolvedLock, existing.locked_at);
    const nextLockedGroup = resolveLockedGroup(resolvedLock, existing.locked_group, authorLockedGroup);
    // Card 4441e883, mecanisme B: same claimed-only discipline, one column
    // over -- see resolveLockedByToken's doc comment in shared/roadmap-lock.ts.
    const nextLockedByToken = resolveLockedByToken(resolvedLock, existing.locked_by_token, author.instance_token);
    // The park is scoped to the operator who parked it -- a separate question
    // from the peer-lock reclaim above.
    // It survives every write except the same operator reversing their own
    // park, or the park having already expired.
    const parkOwnerIsAuthor =
      existing.lock_parked_by !== null && author.operator_id === existing.lock_parked_by;
    const parkStillLive = isParked(existing.lock_parked_at, new Date().toISOString(), LOCK_PARK_TTL_SEC);
    const keptParkedAt = parkOwnerIsAuthor || !parkStillLive ? null : existing.lock_parked_at;
    const keptParkedBy = parkOwnerIsAuthor || !parkStillLive ? null : existing.lock_parked_by;

    // A status change away from 'archived' restores the item (clears the soft
    // delete); archiving through upsert stamps it like /roadmap/archive does.
    //
    // operator_id (card edefff05): COALESCE(?, operator_id) so a write NOT
    // signed by the operator (author.operator_id undefined -> bound NULL)
    // preserves whatever the last SIGNED write recorded, instead of erasing
    // it -- the column means "last operator to sign a write", and an
    // ordinary agent's write does not un-happen that fact.
    db.run(
      `UPDATE roadmap_items SET
         kind = ?, title = ?, description = ?, rationale = ?, context = ?, priority = ?,
         value = ?, effort = ?, status = ?, tags = ?, depends_on = ?, queue = ?,
         directive = ?, target_peer_ids = ?,
         locked = ?, locked_by = ?, locked_group = ?, locked_by_token = ?,
         locked_at = CASE WHEN ? = 0 THEN NULL ELSE COALESCE(?, datetime('now')) END,
         operator_id = COALESCE(?, operator_id),
         inactive = ?,
         lock_parked_at = ?, lock_parked_by = ?,
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
        next.directive,
        JSON.stringify(next.target_peer_ids),
        resolvedLock.locked ? 1 : 0,
        resolvedLock.lockedBy,
        nextLockedGroup,
        nextLockedByToken,
        resolvedLock.locked ? 1 : 0,
        keptLockedAt,
        author.operator_id ?? null,
        next.inactive ? 1 : 0,
        keptParkedAt,
        keptParkedBy,
        next.updated_by,
        next.status,
        body.id,
      ]
    );
    return { item: getRoadmapItem(body.id)! };
  }

  // Create.
  const rawCreateProjectKey = typeof body.project_key === "string" ? body.project_key : "";
  if (!rawCreateProjectKey) return { error: "project_key is required", status: 400 };
  // A refusal, not a silent trim: trimming a caller-declared project_key would
  // store a different key than the one the caller believes it used.
  const createProjectKeyCheck = validateProjectKey(rawCreateProjectKey);
  if (!createProjectKeyCheck.ok) {
    return { error: `project_key is invalid (${createProjectKeyCheck.reason})`, status: 400 };
  }
  const projectKey = rawCreateProjectKey;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return { error: "title is required", status: 400 };
  if (body.status === "archived") {
    return { error: "cannot create an item directly archived", status: 400 };
  }

  // An item born in_progress from an agent is locked from the start (PLAN K2).
  const createStatus = body.status ?? "idea";
  const createLocked =
    createStatus === "in_progress" && (body.locked === true || (body.locked !== false && by !== "deck"));

  // Inactive guards (card c33a5968): a row can be BORN locked=1 (above), so it
  // can equally be born inactive -- reuse the same predicates as the patch
  // path, with `false` standing in for "no prior stored value" (a virgin
  // row). `"idea"`/`false` stand in for `existingStatus`/`existingLocked` in
  // the delta form: any non-in_progress status works as the sentinel, since
  // a virgin row never had a prior in_progress/locked claim to delta against
  // -- so the delta collapses to the same absolute check the create path
  // always needed.
  const createInactive = body.inactive === true;
  if (refusesInactiveToggle(false, createInactive, author.operator_id !== undefined)) {
    return { error: "toggling inactive requires an operator-signed write", status: 403 };
  }
  if (refusesInactiveClaim(createInactive, "idea", false, createStatus, createLocked)) {
    return {
      error: "item is inactive -- clear inactive before creating it in_progress",
      status: 403,
    };
  }

  // Directive coherence (CT1), create path.
  const createKind = body.kind ?? "feature";
  let createDirective: RoadmapDirective | null = null;
  let createTargets: string[] = [];
  if (createKind === "directive") {
    createDirective = body.directive ?? null;
    if (!createDirective || !DIRECTIVE_COMMANDS.includes(createDirective)) {
      return {
        error: "kind 'directive' requires a directive (clear|compact|magic_compact)",
        status: 400,
      };
    }
    createTargets = cleanPeerIds(body.target_peer_ids);
  } else if (body.directive != null) {
    return { error: "directive is only valid for kind 'directive'", status: 400 };
  }

  // Card e344fa79: a card born locked stamps the creating author's own
  // group alongside locked_by, the same value every claim site stores.
  const createLockedGroup = createLocked ? (author.group_id ?? null) : null;
  // Card 4441e883, mecanisme B: same discipline, one column over -- NULL
  // unless the creating author's OWN instance_token was proven (see
  // RoadmapItem.locked_by_token's doc comment; never derived from `by`).
  const createLockedByToken = createLocked ? (author.instance_token ?? null) : null;

  const id = randomUUID();
  db.run(
    `INSERT INTO roadmap_items
       (id, project_key, kind, title, description, rationale, context, priority, value,
        effort, status, tags, depends_on, created_by, updated_by,
        created_at, updated_at, deleted_at, queue, directive, target_peer_ids, locked, locked_by, locked_group,
        locked_by_token, locked_at, operator_id, inactive, lock_parked_at, lock_parked_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL, ?, ?, ?, ?, ?, ?, ?,
             CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?, ?, NULL, NULL)`,
    [
      id,
      projectKey,
      createKind,
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
      createDirective,
      JSON.stringify(createTargets),
      createLocked ? 1 : 0,
      createLocked ? by : null,
      createLockedGroup,
      createLockedByToken,
      createLocked ? 1 : 0,
      author.operator_id ?? null,
      createInactive ? 1 : 0,
    ]
  );
  return { item: getRoadmapItem(id)! };
}

// Card c33a5968: no inactive guard here, deliberately -- this handler forces
// status='archived' and clears `locked`, so it structurally never moves a
// card toward in_progress/locked; archiving an inactive card is a legitimate
// operation, not a claim.
function handleRoadmapArchive(
  body: RoadmapArchiveRequest
): RoadmapArchiveResponse | { error: string; status: number } {
  const author = resolveRoadmapAuthor(body, "/roadmap/archive");
  if ("error" in author) return author;
  const by = author.by;
  if (!body.id) return { error: "id is required", status: 400 };
  const existing = getRoadmapItem(body.id);
  if (!existing) return { error: "unknown roadmap item", status: 404 };

  // Card e344fa79: same discipline as handleRoadmapUpsert's guard.
  const authorLockedGroup = author.group_id ?? null;

  // Same lock guard as upsert (PLAN K2): archiving is a status change.
  if (
    existing.locked &&
    !matchesLockOwner(existing.locked_by, existing.locked_group, by, authorLockedGroup) &&
    by !== "deck"
  ) {
    return {
      error: `item is locked by '${existing.locked_by}' (actively working on it) -- cannot archive`,
      status: 409,
    };
  }

  // Card aaf4537d: a parked card is the pause-stop operator's own decision --
  // refuse an archive coming from anyone else (or from an unproven write)
  // while the park is still live. See refusesParkedArchive's doc comment in
  // shared/roadmap-lock.ts for why this compares author.operator_id, never
  // `by`.
  if (
    refusesParkedArchive(
      existing.lock_parked_by,
      existing.lock_parked_at,
      new Date().toISOString(),
      LOCK_PARK_TTL_SEC,
      author.operator_id
    )
  ) {
    return {
      error: `item is parked by '${existing.lock_parked_by}' -- cannot archive`,
      status: 409,
    };
  }

  db.run(
    `UPDATE roadmap_items SET
       status = 'archived',
       deleted_at = COALESCE(deleted_at, datetime('now')),
       locked = 0, locked_by = NULL, locked_group = NULL, locked_by_token = NULL, locked_at = NULL,
       operator_id = COALESCE(?, operator_id),
       lock_parked_at = NULL, lock_parked_by = NULL,
       updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [author.operator_id ?? null, by, body.id]
  );
  return { item: getRoadmapItem(body.id)! };
}

/**
 * Operator-gated unconditionally, not just when the author is a reserved name
 * -- this route acts on other agents' locks by construction, since a peer never
 * parks its own.
 * lock_parked_by is always the operator's own id, never the claimed author or
 * the target peer_id.
 * A peer_id holding no lock is a silent no-op, not a failure -- most pause
 * targets simply hold none.
 * No inactive guard (card c33a5968): this handler only ever writes the park
 * fields, never status or locked, so it cannot claim a card.
 */
function handleRoadmapLockPark(
  body: RoadmapLockParkRequest
): RoadmapLockParkResponse | { error: string; status: number } {
  const author = resolveRoadmapAuthor(body, "/roadmap/lock-park");
  if ("error" in author) return author;
  if (author.operator_id === undefined) {
    return { error: "lock-park requires an operator-signed write", status: 403 };
  }
  const rawLockParkProjectKey = typeof body.project_key === "string" ? body.project_key : "";
  if (!rawLockParkProjectKey) return { error: "project_key is required", status: 400 };
  // Refused, not trimmed: this scopes an UPDATE, not a read filter, so a
  // silently trimmed key here would drift from what is actually stored.
  const lockParkProjectKeyCheck = validateProjectKey(rawLockParkProjectKey);
  if (!lockParkProjectKeyCheck.ok) {
    return { error: `project_key is invalid (${lockParkProjectKeyCheck.reason})`, status: 400 };
  }
  const projectKey = rawLockParkProjectKey;
  if (!Array.isArray(body.peer_ids) || body.peer_ids.length === 0) {
    return { error: "peer_ids must be a non-empty array", status: 400 };
  }
  if (body.peer_ids.length > LOCK_BATCH_MAX_TARGETS) {
    return { error: `too many peer_ids (max ${LOCK_BATCH_MAX_TARGETS})`, status: 400 };
  }

  const parked: string[] = [];
  const failed: string[] = [];
  for (const peerId of cleanPeerIds(body.peer_ids, LOCK_BATCH_MAX_TARGETS)) {
    try {
      // Reads the row before the UPDATE: an unconditional WHERE would let a
      // second operator silently re-park (and later archive) a card another
      // operator already parked, since a zero-rows-changed result alone can't
      // distinguish 'nothing to park' from 'refused, foreign park'.
      const row = db
        .query(
          `SELECT lock_parked_by FROM roadmap_items WHERE locked = 1 AND project_key = ? AND locked_by = ?`
        )
        .get(projectKey, peerId) as { lock_parked_by: string | null } | null;
      if (!row) continue;
      if (row.lock_parked_by !== null && row.lock_parked_by !== author.operator_id) {
        failed.push(peerId);
        continue;
      }
      // Card aaf4537d, round-3 review: write an ISO timestamp (with 'Z'),
      // not SQLite's bare datetime('now') -- a naive "YYYY-MM-DD HH:MM:SS"
      // string has no timezone marker, and isParked's Date.parse() then
      // reads it as LOCAL time (V8 behaviour), silently shrinking the park
      // by the host's UTC offset. releaseStaleLocks's SQL sweep (clause 3)
      // bites on this ISO form exactly as it did on the bare form -- SQLite
      // datetime() comparisons parse both.
      const parkedAtIso = new Date().toISOString();
      // The UPDATE's WHERE repeats the same park-owner condition as the
      // SELECT above, for the same reason lock-release's own repeated
      // predicate does (see that route's comment): this function is
      // synchronous end to end (no `await` in its body, bun:sqlite bindings
      // are sync), so the repeat is not a live defense against a race that
      // exists today, only a guard against a future regression that adds one.
      const res = db.run(
        `UPDATE roadmap_items SET
           lock_parked_at = ?, lock_parked_by = ?,
           updated_by = ?, updated_at = datetime('now')
         WHERE locked = 1 AND project_key = ? AND locked_by = ?
           AND (lock_parked_by IS NULL OR lock_parked_by = ?)`,
        [parkedAtIso, author.operator_id, author.by, projectKey, peerId, author.operator_id]
      );
      if (res.changes > 0) parked.push(peerId);
    } catch (e) {
      failed.push(peerId);
      log.error(`/roadmap/lock-park: park failed for peer '${peerId}'`, e);
    }
  }
  return { parked, failed };
}

/**
 * Releases outright -- lock, park, and in-progress status all cleared -- the
 * same end state as the stale-lock sweep, so an agent this action just stopped
 * doesn't keep the card claimed.
 * A row parked by a DIFFERENT operator is refused rather than released:
 * releasing it would silently clear the park owner and let that operator
 * archive around the parked-archive guard.
 * A row merely locked, never parked, stays releasable by any operator-proven
 * write.
 * No inactive guard (card c33a5968): this handler only ever decreases a
 * claim, so releasing a lock on an inactive card is legitimate.
 */
function handleRoadmapLockRelease(
  body: RoadmapLockReleaseRequest
): RoadmapLockReleaseResponse | { error: string; status: number } {
  const author = resolveRoadmapAuthor(body, "/roadmap/lock-release");
  if ("error" in author) return author;
  if (author.operator_id === undefined) {
    return { error: "lock-release requires an operator-signed write", status: 403 };
  }
  const rawLockReleaseProjectKey = typeof body.project_key === "string" ? body.project_key : "";
  if (!rawLockReleaseProjectKey) return { error: "project_key is required", status: 400 };
  // Refused, not trimmed: this handler scopes an UPDATE by project_key, and a
  // silently trimmed value here would let the same caller-declared string be
  // accepted where another route would refuse it.
  const lockReleaseProjectKeyCheck = validateProjectKey(rawLockReleaseProjectKey);
  if (!lockReleaseProjectKeyCheck.ok) {
    return { error: `project_key is invalid (${lockReleaseProjectKeyCheck.reason})`, status: 400 };
  }
  const projectKey = rawLockReleaseProjectKey;
  if (!Array.isArray(body.peer_ids) || body.peer_ids.length === 0) {
    return { error: "peer_ids must be a non-empty array", status: 400 };
  }
  if (body.peer_ids.length > LOCK_BATCH_MAX_TARGETS) {
    return { error: `too many peer_ids (max ${LOCK_BATCH_MAX_TARGETS})`, status: 400 };
  }

  const released: string[] = [];
  const failed: string[] = [];
  for (const peerId of cleanPeerIds(body.peer_ids, LOCK_BATCH_MAX_TARGETS)) {
    try {
      // Read the current park owner FIRST: a row with no lock at all under
      // this project/peer is a silent no-op (unchanged from lot 1), but a
      // row parked by a DIFFERENT operator must land in `failed`, not just
      // be skipped by the UPDATE's own WHERE below -- the two are
      // indistinguishable from `changes === 0` alone, and this route's
      // response contract requires telling them apart (arbitration above).
      const row = db
        .query(
          `SELECT lock_parked_at, lock_parked_by FROM roadmap_items WHERE locked = 1 AND project_key = ? AND locked_by = ?`
        )
        .get(projectKey, peerId) as { lock_parked_at: string | null; lock_parked_by: string | null } | null;
      if (!row) continue;
      // Round-4 mutation review (card aaf4537d): an EXPIRED park must be
      // treated as absent, the same threshold every other consumer of this
      // column already agrees on (refusesParkedArchive via isParked, the
      // upsert-path keptParkedAt/parkStillLive pair, releaseStaleLocks's own
      // SQL sweep clause). Checking only `lock_parked_by !== null` here
      // would let a park that died days ago still block a Hard Stop from a
      // DIFFERENT operator until the next sweep tick -- self-healing within
      // LOCK_SWEEP_SEC, but a live contradiction of shared/roadmap-lock.ts's
      // own doc comment that isParked is the threshold every other guard
      // must agree with.
      const parkStillLive = isParked(row.lock_parked_at, new Date().toISOString(), LOCK_PARK_TTL_SEC);
      if (row.lock_parked_by !== null && row.lock_parked_by !== author.operator_id && parkStillLive) {
        failed.push(peerId);
        continue;
      }
      // Redundant with the SELECT above today -- this function is fully
      // synchronous, so nothing can interleave between them -- but kept as a
      // guard against a future regression, such as an await introduced into
      // this loop, that would reopen the race.
      const res = db.run(
        `UPDATE roadmap_items SET
           locked = 0, locked_by = NULL, locked_by_token = NULL, locked_at = NULL, operator_id = NULL,
           lock_parked_at = NULL, lock_parked_by = NULL,
           status = CASE WHEN status = 'in_progress' THEN 'planned' ELSE status END,
           updated_by = ?, updated_at = datetime('now')
         WHERE locked = 1 AND project_key = ? AND locked_by = ?
           AND (
             lock_parked_by IS NULL OR lock_parked_by = ?
             OR datetime(lock_parked_at) < datetime('now', ?)
           )`,
        [author.by, projectKey, peerId, author.operator_id, `-${LOCK_PARK_TTL_SEC} seconds`]
      );
      if (res.changes > 0) released.push(peerId);
    } catch (e) {
      failed.push(peerId);
      log.error(`/roadmap/lock-release: release failed for peer '${peerId}'`, e);
    }
  }
  return { released, failed };
}

/**
 * Single UPDATE statement, no SELECT-then-UPDATE: a prior read would
 * reintroduce the destructive read-modify-write this route removes, and would
 * let two concurrent appends silently overwrite each other.
 * COALESCE on the column matters because SQLite's NULL concatenation evaluates
 * to NULL, which would otherwise wipe a NULL value instead of appending to it.
 * updated_at is deliberately not touched -- it is an arbitration field the lock
 * sweep keys its TTL off, so touching it here would let a third party's note
 * silently extend another agent's lock.
 * No inactive guard (card c33a5968): this handler only ever touches context
 * and operator_id, never status or locked, so it cannot claim a card.
 */
function handleRoadmapContextAppend(
  body: RoadmapContextAppendRequest
): RoadmapContextAppendResponse | { error: string; status: number } {
  const author = resolveRoadmapAuthor(body, "/roadmap/append-context");
  if ("error" in author) return author;
  const by = author.by;

  if (typeof body.id !== "string" || !body.id) {
    return { error: "id is required", status: 400 };
  }
  if (typeof body.text !== "string") {
    return { error: "text is required", status: 400 };
  }

  // Pre-refuse cheaply (delimiter, per-call cap) with the SAME numbers the
  // WHERE clause below re-derives for the result cap -- shared/roadmap-append.ts
  // is the single source of truth for both, see its own header comment.
  const nowIso = new Date().toISOString();
  const textPlan = planRoadmapAppendText({ text: body.text, author: by, nowIso });
  if (!textPlan.ok) {
    return { error: textPlan.message, status: 400 };
  }

  // Card 562fd9b5 review delta: SET touches `context` ONLY (plus, since card
  // edefff05, `operator_id` -- see the long comment above for why that
  // addition does not reopen the lock-TTL hazard). `updated_by`/`updated_at`
  // are deliberately left alone.
  const res = db.run(
    `UPDATE roadmap_items
        SET context = COALESCE(context,'') || ?,
            operator_id = COALESCE(?, operator_id)
      WHERE id = ? AND length(COALESCE(context,'')) + length(?) <= ?`,
    [
      textPlan.appended,
      author.operator_id ?? null,
      body.id,
      textPlan.appended,
      ROADMAP_APPEND_RESULT_MAX_CHARS,
    ]
  );

  if (res.changes === 0) {
    // Existence check AFTER the failed write, not before it: distinguishes
    // 404 (no such card) from 409 (cap exceeded) without ever informing
    // what got written above.
    const existing = getRoadmapItem(body.id);
    if (!existing) return { error: "unknown roadmap item", status: 404 };
    return {
      error:
        `append would push context over the ${ROADMAP_APPEND_RESULT_MAX_CHARS}-char cap -- ` +
        `compact the context first via roadmap_update (if that tool is available to you), ` +
        `\`bun cli.ts roadmap-import --force\` with a trimmed context, or ask the team lead`,
      status: 409,
    };
  }

  return { item: getRoadmapItem(body.id)! };
}

// Workflow lane reorder: hard cap on the queue size a single rewrite may
// submit (same spirit as the flush caps -- an unbounded ids array is NF-E).
const ROADMAP_REORDER_MAX = 500;

/**
 * The submitted list replaces the whole dispatch queue in order; every other
 * queued item of the project is unqueued in the same transaction, so an
 * operator's insert-in-the-middle never interleaves with an agent's
 * half-applied writes.
 * Refuses the whole batch if any id is inactive (card c33a5968), in the
 * id-validation loop, the same mechanism as the done/archived check.
 */
function handleRoadmapReorder(
  body: RoadmapReorderRequest
): RoadmapReorderResponse | { error: string; status: number } {
  const author = resolveRoadmapAuthor(body, "/roadmap/reorder");
  if ("error" in author) return author;
  const by = author.by;
  const rawReorderProjectKey = typeof body.project_key === "string" ? body.project_key : "";
  if (!rawReorderProjectKey) return { error: "project_key is required", status: 400 };
  // Refused, not trimmed: this handler selects items by project_key and writes
  // their queue, not a read-only filter, so a caller-declared value must not be
  // silently reshaped.
  const reorderProjectKeyCheck = validateProjectKey(rawReorderProjectKey);
  if (!reorderProjectKeyCheck.ok) {
    return { error: `project_key is invalid (${reorderProjectKeyCheck.reason})`, status: 400 };
  }
  const projectKey = rawReorderProjectKey;
  const ids = cleanList(body.ids);
  if (ids === null) return { error: "ids must be an array of item ids", status: 400 };
  if (ids.length > ROADMAP_REORDER_MAX) {
    return { error: `ids exceeds the ${ROADMAP_REORDER_MAX}-item cap`, status: 400 };
  }
  if (new Set(ids).size !== ids.length) return { error: "ids contains duplicates", status: 400 };

  const itemById = new Map<string, RoadmapItem>();
  for (const id of ids) {
    const item = getRoadmapItem(id);
    if (!item || item.project_key !== projectKey) {
      return { error: `unknown roadmap item '${id}' in this project`, status: 404 };
    }
    if (item.status === "done" || item.status === "archived") {
      return { error: `item '${id}' is ${item.status} and cannot be queued`, status: 400 };
    }
    // 403, not the 400 used for done/archived above: this is a 'clear the flag
    // first' permission gate, not a terminal-state validation.
    // Whole-batch refusal, not a partial skip -- the response has no field to
    // report a per-item skip.
    if (item.inactive) {
      return { error: `item '${id}' is inactive -- clear inactive before queuing it`, status: 403 };
    }
    itemById.set(id, item);
  }

  // Waves (roadmap card 42edc88b phase 1): additive optional grouping of
  // `ids` into queue-position ties. `ids` stays the authoritative flat order
  // -- waves must flatten back to it exactly, so a mismatched or stale
  // `waves` payload can never desync the queue it groups.
  let waves: string[][] | null = null;
  if (body.waves !== undefined) {
    if (!Array.isArray(body.waves) || !body.waves.every((w) => Array.isArray(w))) {
      return { error: "waves must be an array of arrays of ids", status: 400 };
    }
    if (body.waves.some((w) => w.length === 0)) {
      return { error: "waves cannot contain an empty wave", status: 400 };
    }
    // Trim discipline: at both boundaries (here, and desktop's
    // roadmap-reorder-validate.ts), `ids` and `waves` are trimmed before any
    // comparison between them. A shared broker also serves clients other
    // than this Deck (a different Deck version, a script, MCP), and one that
    // pads ids and waves identically must not be rejected because only one
    // side got trimmed here. Reject rather than silently drop a malformed
    // entry, since the wave shape is otherwise structurally validated and a
    // silent drop would change membership under the caller without a trace.
    const trimmedWaves: string[][] = [];
    for (const wave of body.waves) {
      const trimmed: string[] = [];
      for (const item of wave) {
        if (typeof item !== "string" || item.trim() === "") {
          return { error: "waves must contain only non-empty string ids", status: 400 };
        }
        trimmed.push(item.trim());
      }
      trimmedWaves.push(trimmed);
    }
    const flat = trimmedWaves.flat();
    if (flat.length !== ids.length || flat.some((id, i) => id !== ids[i])) {
      return { error: "waves must flatten to exactly ids, in the same order", status: 400 };
    }
    for (const wave of trimmedWaves) {
      if (wave.length <= 1) continue;
      const directiveId = wave.find((id) => itemById.get(id)?.kind === "directive");
      if (directiveId) {
        return {
          error: `directive item '${directiveId}' must be in a singleton wave`,
          status: 400,
        };
      }
    }
    waves = trimmedWaves;
  }

  // Card edefff05: none of the three UPDATEs below touch operator_id, and
  // that is deliberate, not an oversight. A reorder is a signed write, but
  // it is a write on the QUEUE, not an authorship event on a card -- each
  // UPDATE here moves N rows at once (unqueue, waves, or flat order), and
  // stamping operator_id on all of them would mark dozens of cards the
  // operator never opened with "last operator who signed a write", which
  // stops meaning anything once everyone carries it. The field tracks the
  // write that moves a card FORWARD, not its position in a list.
  const reorderTx = db.transaction(() => {
    // Unqueue everything first: the per-id UPDATE below re-stamps the kept ones.
    db.run(
      `UPDATE roadmap_items SET queue = NULL, updated_by = ?, updated_at = datetime('now')
       WHERE project_key = ? AND queue IS NOT NULL`,
      [by, projectKey]
    );
    if (waves) {
      // Every id in wave i shares queue = i+1 (a tie): the lane column
      // becomes the wave, depends_on stays a VALIDATION concern, not a
      // derivation of order (see the roadmap card's design note).
      waves.forEach((wave, i) => {
        for (const id of wave) {
          db.run(
            `UPDATE roadmap_items SET queue = ?, updated_by = ?, updated_at = datetime('now')
             WHERE id = ?`,
            [i + 1, by, id]
          );
        }
      });
    } else {
      ids.forEach((id, i) => {
        db.run(
          `UPDATE roadmap_items SET queue = ?, updated_by = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [i + 1, by, id]
        );
      });
    }
  });
  reorderTx();

  const rows = db
    .query(
      "SELECT * FROM roadmap_items WHERE project_key = ? AND queue IS NOT NULL ORDER BY queue, id"
    )
    .all(projectKey) as RoadmapRow[];
  return { items: rows.map(rowToRoadmapItem) };
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
  by?: unknown;
  instance_token?: unknown;
  force?: unknown;
}): { imported: number; skipped: string[] } | { error: string; status: number } {
  const rawImportProjectKey = typeof body.project_key === "string" ? body.project_key : "";
  if (!rawImportProjectKey) return { error: "project_key is required", status: 400 };
  // Card c92614ed lot L0: same refuse-don't-trim discipline as the create
  // branch above -- one project_key value re-keys the WHOLE batch, so a
  // silently-trimmed value here would move every imported item to a
  // different key than the caller declared.
  const importProjectKeyCheck = validateProjectKey(rawImportProjectKey);
  if (!importProjectKeyCheck.ok) {
    return { error: `project_key is invalid (${importProjectKeyCheck.reason})`, status: 400 };
  }
  const projectKey = rawImportProjectKey;
  if (!Array.isArray(body.items)) return { error: "items must be an array", status: 400 };

  // Card 40ddf1f5: same identity discipline as upsert/archive/reorder --
  // resolveRoadmapAuthor refuses a `by` that impersonates a real registered
  // peer without proof, and binds created_by/updated_by below to something
  // other than raw, untrusted file content.
  const author = resolveRoadmapAuthor(body, "/roadmap/import");
  if ("error" in author) return author;
  const by = author.by;
  // The declared author here is never a proven one -- no instance_token flows
  // through this route's auth -- so it must never be compared against a card's
  // locked_by to decide ownership, or a caller could simply declare ownership
  // and walk through the check.
  // Every locked card is skipped unconditionally instead, with an explicit
  // force escape hatch.
  const force = body.force === true;

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
      badEnum(it.status, ROADMAP_STATUSES) ||
      (it.inactive !== undefined && typeof it.inactive !== "boolean")
    ) {
      return { error: `invalid item at index ${i}`, status: 400 };
    }
    // Uphold the same directive coherence as create/patch: a 'directive' row
    // must carry a valid command (never persist kind='directive' + directive=null).
    if (it.kind === "directive" && (!it.directive || !DIRECTIVE_COMMANDS.includes(it.directive))) {
      return {
        error: `invalid item at index ${i}: kind 'directive' needs a directive (clear|compact|magic_compact)`,
        status: 400,
      };
    }
    // Card ad6aa6ed (review finding): `created_by`/`updated_by` on this route
    // already go through resolveRoadmapAuthor above, but `locked_by` is
    // FILE content, never resolved -- and it is displayed verbatim by
    // roadmap_get ("locked: by X since ..."), the same forgery surface the
    // `by`-claim fix closed on a different field. Same helper, same charset,
    // whole import refused (not just the one row) on a bad character, same
    // discipline as every other check in this pre-pass.
    if (typeof it.locked_by === "string") {
      const normalizedLockedBy = normalizeAuthorIdentity(it.locked_by);
      if (!normalizedLockedBy.ok) {
        // `code === "empty"` IS reachable here (unlike the `by` claim, which
        // is refused earlier): an imported locked_by:"" would otherwise
        // land as the lock owner, and an empty string never equals any real
        // `by`, permanently defeating the `by !== existing.locked_by`
        // comparison for that row (review delta, card ad6aa6ed).
        return {
          error:
            normalizedLockedBy.code === "empty"
              ? `invalid item at index ${i}: locked_by is an empty string -- omit the field instead`
              : `invalid item at index ${i}: locked_by contains a disallowed character '${normalizedLockedBy.badChar}' -- only [a-z0-9:_-] allowed`,
          status: 400,
        };
      }
    }
    // Card ad6aa6ed (review delta, widened in scope: pre-existing gap,
    // but it now sits in this same loop and combines with locked_by above).
    // releaseStaleLocks (below) compares datetime(updated_at)/datetime(
    // locked_at); SQLite's datetime() on an unparsable string returns NULL,
    // and NULL never satisfies a WHERE comparison -- measured:
    // `SELECT datetime('nope') IS NULL, (datetime('nope') < datetime('now','-60 seconds')) IS NULL`
    // -> `1|1`. An import with locked:true + locked_at:'nope' +
    // updated_at:'nope' creates a lock NEITHER sweep branch can ever
    // release: a permanent card freeze, reachable by any bearer-token
    // holder. Absence stays allowed (no presence requirement); only a
    // PRESENT, unparsable value is refused.
    for (const field of ["created_at", "updated_at", "deleted_at", "locked_at"] as const) {
      const v = it[field];
      if (v !== undefined && v !== null && Number.isNaN(Date.parse(String(v)))) {
        return {
          error: `invalid item at index ${i}: ${field} is not a parsable timestamp`,
          status: 400,
        };
      }
    }
  }

  // Column list and placeholders are both generated from the same column
  // constant, so count and order cannot drift apart.
  // A key missing from the values record binds undefined, which the driver
  // treats as NULL -- on a defaulted column that silently stores the default
  // instead of erroring, and nothing in this repo's typecheck/CI catches a
  // missing key; only the import test suite's real-value assertions do.
  const insert = db.prepare(
    `INSERT OR REPLACE INTO roadmap_items
       (${ROADMAP_IMPORT_COLUMNS.join(", ")})
     VALUES (${ROADMAP_IMPORT_COLUMNS.map(() => "?").join(", ")})`
  );
  const importAll = db.transaction((rows: Partial<RoadmapItem>[]) => {
    const skipped: string[] = [];
    let imported = 0;
    for (const it of rows) {
      const id = it.id!.trim();
      // Read fresh on every iteration (not hoisted before the loop): a
      // duplicate id earlier in the same file already wrote through this same
      // transaction, and this lookup must see that write, not the pre-import
      // state, to skip/preserve correctly for the later duplicate too.
      const existingRow = getRoadmapRow(id);
      const existing = existingRow ? rowToRoadmapItem(existingRow) : null;
      // Unconditional skip on a locked card, no author comparison -- comparing
      // the claimed author against locked_by here would be a self-declared
      // bypass, since the author is never proven on this route.
      // This is also this route's entire defense against archiving a parked
      // card in place: a parked card is, by construction, locked, so this same
      // skip already refuses it, with force as the one conscious exemption.
      if (existing?.locked && !force) {
        skipped.push(id);
        continue;
      }
      // Only carry the directive over for a coherent directive card (CT1);
      // ignore a stray directive on any other kind, matching upsert's rule.
      const importDirective =
        it.kind === "directive" && it.directive && DIRECTIVE_COMMANDS.includes(it.directive)
          ? it.directive
          : null;
      // Card 40ddf1f5 (defect 2): locked/locked_by/locked_at are now listed
      // explicitly, and default to the EXISTING row's value (never the table
      // DEFAULT) whenever the imported item omits the field -- REPLACE
      // deletes the row before reinserting, so any column left out of this
      // list used to fall back silently to its DEFAULT (locked=0), erasing
      // another card's lock state even on a wholly legitimate, unrelated
      // import. `!== undefined` (not `??`) so an explicit locked_by: null in
      // the file (a genuine unlock in a self-export) still takes effect,
      // instead of being masked by the existing-row fallback.
      const lockedVal = typeof it.locked === "boolean" ? it.locked : (existing?.locked ?? false);
      // Card ad6aa6ed: normalized the same way as `by` (lowercase). The
      // charset itself was already REFUSED for the whole import, above, if
      // any row's locked_by fell outside [a-z0-9:_-] -- only the case-fold
      // is left to do here.
      const lockedByVal =
        it.locked_by !== undefined
          ? typeof it.locked_by === "string"
            ? it.locked_by.toLowerCase()
            : null
          : (existing?.locked_by ?? null);
      const lockedAtVal =
        it.locked_at !== undefined
          ? typeof it.locked_at === "string"
            ? it.locked_at
            : null
          : (existing?.locked_at ?? null);
      // Same file-wins/existing-wins discipline as locked_by/locked_at, but
      // with no charset check: the value actually compared against this field
      // on every lock-acting route comes only from the resolved peers row,
      // never from request-body content, so a caller-supplied value here is
      // never trusted as an identity claim.
      const lockedGroupVal =
        it.locked_group !== undefined
          ? typeof it.locked_group === "string"
            ? it.locked_group
            : null
          : (existing?.locked_group ?? null);
      // Card 4441e883: same file-wins/existing-wins discipline as
      // locked_group just above, and the same reasoning for skipping a
      // charset check -- it is never compared as an identity CLAIM on this
      // route (the unconditional locked-and-!force skip above is this
      // route's entire answer to an untrustworthy `by`), it is compared only
      // against a value resolveRoadmapAuthor itself resolved elsewhere.
      const lockedByTokenVal =
        it.locked_by_token !== undefined
          ? typeof it.locked_by_token === "string"
            ? it.locked_by_token
            : null
          : (existing?.locked_by_token ?? null);
      // Card aaf4537d: same file-wins/existing-wins discipline as the three
      // lock columns just above (a re-import of a parked card must not
      // silently unpark it, and a file that WAS built from a parked export
      // must faithfully restore the park).
      const lockParkedAtVal =
        it.lock_parked_at !== undefined
          ? typeof it.lock_parked_at === "string"
            ? it.lock_parked_at
            : null
          : (existing?.lock_parked_at ?? null);
      const lockParkedByVal =
        it.lock_parked_by !== undefined
          ? typeof it.lock_parked_by === "string"
            ? it.lock_parked_by.toLowerCase()
            : null
          : (existing?.lock_parked_by ?? null);
      // inactive follows the same file-wins/existing-wins discipline as
      // ordinary content fields, unlike operator_id which never trusts the file
      // -- but a refusal here skips this row only, not the whole batch.
      // The comparison reads the pre-write row, not the about-to-be-written
      // values, so a force-import re-carrying a row's own
      // already-inactive-and-claimed state round-trips without being refused.
      const existingInactive = existing?.inactive ?? false;
      const existingStatusVal = existing?.status ?? "idea";
      const existingLockedVal = existing?.locked ?? false;
      const nextInactiveVal = typeof it.inactive === "boolean" ? it.inactive : existingInactive;
      const nextStatusVal = it.status ?? existing?.status ?? "idea";
      if (refusesInactiveToggle(existingInactive, nextInactiveVal, author.operator_id !== undefined)) {
        skipped.push(id);
        continue;
      }
      if (
        refusesInactiveClaim(existingInactive, existingStatusVal, existingLockedVal, nextStatusVal, lockedVal)
      ) {
        skipped.push(id);
        continue;
      }
      // A key present in the file wins, including an explicit null (a genuine
      // clear in a self-export); a key truly absent falls back to the existing
      // row; only a brand-new row falls back to the table default.
      // directive and target_peer_ids never fall back to the existing row,
      // since a partial import of a directive card would otherwise blank its
      // command and targets -- safe only because upstream validation already
      // refuses a directive item with no valid directive.
      const values: Record<RoadmapImportColumn, string | number | null> = {
        id,
        project_key: projectKey,
        kind: it.kind!,
        title: it.title!.trim(),
        description: importedText(it.description, existing?.description),
        rationale: importedText(it.rationale, existing?.rationale),
        context: importedText(it.context, existing?.context),
        priority: it.priority ?? existing?.priority ?? "could",
        value: it.value ?? existing?.value ?? "medium",
        effort: it.effort ?? existing?.effort ?? "medium",
        status: nextStatusVal,
        tags: JSON.stringify(
          it.tags !== undefined ? (cleanList(it.tags) ?? []) : (existing?.tags ?? [])
        ),
        depends_on: JSON.stringify(
          it.depends_on !== undefined
            ? (cleanList(it.depends_on) ?? [])
            : (existing?.depends_on ?? [])
        ),
        // Card 40ddf1f5 (defect 3): created_by/updated_by come from the
        // resolved, identity-checked author, never straight from the file's
        // own (untrusted) created_by/updated_by fields. created_by is
        // preserved from the existing row when re-importing a known card
        // (immutable attribution, like every other write path), and only
        // falls back to the resolved author for a brand-new row.
        created_by: existing?.created_by ?? by,
        updated_by: by,
        created_at: it.created_at ?? existing?.created_at ?? new Date().toISOString(),
        // updated_at is the one column an import legitimately stamps: the row
        // WAS just written, so a silent file means "now", not "keep the old".
        updated_at: it.updated_at ?? new Date().toISOString(),
        deleted_at:
          it.deleted_at !== undefined
            ? typeof it.deleted_at === "string"
              ? it.deleted_at
              : null
            : (existing?.deleted_at ?? null),
        queue:
          it.queue !== undefined
            ? typeof it.queue === "number" && Number.isInteger(it.queue) && it.queue >= 1
              ? it.queue
              : null
            : (existing?.queue ?? null),
        directive: importDirective,
        target_peer_ids: JSON.stringify(
          importDirective
            ? it.target_peer_ids !== undefined
              ? cleanPeerIds(it.target_peer_ids)
              : (existing?.target_peer_ids ?? [])
            : []
        ),
        locked: lockedVal ? 1 : 0,
        locked_by: lockedByVal,
        locked_group: lockedGroupVal,
        locked_by_token: lockedByTokenVal,
        locked_at: lockedAtVal,
        // Card edefff05: same discipline as created_by/updated_by above, not
        // the file-wins discipline the content fields use just above --
        // `it.operator_id` is UNTRUSTED file content, and this column exists
        // to prove which operator signed a write, so honouring a file-
        // declared value would let any import forge that proof for free.
        // COALESCE-equivalent of the SQL used on every other write path: a
        // freshly signed import (author.operator_id set) wins, otherwise the
        // existing row's value survives unchanged.
        operator_id: author.operator_id ?? existing?.operator_id ?? null,
        inactive: nextInactiveVal ? 1 : 0,
        lock_parked_at: lockParkedAtVal,
        lock_parked_by: lockParkedByVal,
        // Replication state is never file-declared, whatever the file says:
        // these columns are protocol bookkeeping, not content, and an import
        // that could set them would let any bearer-token holder rewrite a
        // card's merge base or forge a lock relay. Carried over from the
        // existing row (REPLACE would otherwise reset them to the table
        // default), table defaults for a new row -- `rev`/`content_rev` are
        // re-stamped by the INSERT trigger either way.
        rev: existingRow?.rev ?? 0,
        content_rev: existingRow?.content_rev ?? 0,
        sync_base_rev: existingRow?.sync_base_rev ?? null,
        sync_base: existingRow?.sync_base ?? null,
        sync_dirty: existingRow?.sync_dirty ?? 0,
        sync_state: existingRow?.sync_state ?? "clean",
        sync_remote: existingRow?.sync_remote ?? null,
        lock_scope: existingRow?.lock_scope ?? null,
        lock_relay: existingRow?.lock_relay ?? null,
        lock_relay_seen: existingRow?.lock_relay_seen ?? null,
        lock_contested_by: existingRow?.lock_contested_by ?? "[]",
        lock_release_owner: existingRow?.lock_release_owner ?? null,
      };
      insert.run(...ROADMAP_IMPORT_COLUMNS.map((column) => values[column]));
      imported++;
    }
    // INSERT OR REPLACE deletes-then-reinserts, but the FTS table's own delete
    // trigger only fires on a REPLACE conflict when recursive triggers are
    // enabled -- off by default, and unset here, so the old FTS row survives
    // orphaned.
    // Fixed locally by rebuilding the FTS index inside this same transaction,
    // rather than flipping that setting globally, which would change trigger
    // semantics for every table to fix one route.
    if (imported > 0) {
      db.run(`INSERT INTO roadmap_fts(roadmap_fts) VALUES('rebuild')`);
    }
    return { imported, skipped };
  });
  return importAll(items);
}

// --- Roadmap replication: the routes an upstream broker serves (§7) ---

/**
 * A replica_id is an identifier, not a credential (the Bearer token is the
 * credential): it is validated for SHAPE because it is concatenated into the
 * `"<peer_id>@<replica_id>"` contested-holder tags, where a stray '@' or a
 * quote would corrupt an entry the operator reads.
 */
const REPLICA_ID_REGEX = /^[a-z0-9][a-z0-9_-]{7,63}$/;
/** roadmap_items.id: what randomUUID produces, plus the dashed-hex tolerance. */
const ROADMAP_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Upstream round-trip budget. A pass that hangs here delays every later pass. */
const SYNC_HTTP_TIMEOUT_MS = 10_000;

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch (e) {
    log.warn("roadmap sync: a stored JSON list could not be parsed, read as empty", e);
    return [];
  }
}

/**
 * Integers off the wire, refused rather than clamped. `Number.isInteger`
 * rejects NaN and Infinity as well as floats -- every `<`/`>` comparison
 * against NaN is false, so a clamp alone would let it through silently.
 */
function syncInteger(
  value: unknown,
  name: string,
  min: number
): number | { error: string; status: number } {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { error: `${name} must be an integer`, status: 400 };
  }
  if (value < min) return { error: `${name} must be >= ${min}`, status: 400 };
  return value;
}

function syncReplicaId(value: unknown): string | { error: string; status: number } {
  if (typeof value !== "string" || !REPLICA_ID_REGEX.test(value)) {
    return { error: "replica_id must be 8 to 64 chars of [a-z0-9_-]", status: 400 };
  }
  return value;
}

/**
 * The three upstream-only routes. A replica refuses to serve them so no chain
 * of replicas -- and no cycle -- can form; 403 because the refusal is about
 * WHO may ask (a replica is nobody's upstream), not about the request's shape.
 */
function refuseWhenReplica(route: string): { error: string; status: number } | null {
  if (BROKER_MODE !== "replica") return null;
  log.warn(`${route}: refused, a replica broker never serves the upstream sync routes`);
  return {
    error: `${route} is served by an upstream broker only -- this broker is a replica`,
    status: 403,
  };
}

/**
 * The two replica-only routes. 409, not 400: the request is well-formed and
 * the caller is entitled to it, the deployment simply has no replication state
 * to answer with -- and the distinct status keeps this refusal apart from the
 * 403 above in the logs.
 */
function requireReplica(route: string): { error: string; status: number } | null {
  if (BROKER_MODE === "replica") return null;
  return {
    error: `${route} exists on a replica broker only -- this broker runs in '${BROKER_MODE}' mode`,
    status: 409,
  };
}

/**
 * Pick-list, not a rest-spread: `locked_by_token` and `operator_id` must never
 * cross the replication boundary in either direction, and a rest-spread would
 * ship the next column added to the table along with them. Listing every field
 * makes an omission a compile error and an addition a conscious line.
 */
function rowToSyncRow(row: RoadmapRow): RoadmapSyncRow {
  const item = rowToRoadmapItem(row);
  return {
    id: item.id,
    project_key: item.project_key,
    kind: item.kind,
    title: item.title,
    description: item.description,
    rationale: item.rationale,
    context: item.context,
    priority: item.priority,
    value: item.value,
    effort: item.effort,
    status: item.status,
    tags: item.tags,
    depends_on: item.depends_on,
    created_by: item.created_by,
    updated_by: item.updated_by,
    created_at: item.created_at,
    updated_at: item.updated_at,
    deleted_at: item.deleted_at,
    queue: item.queue,
    directive: item.directive,
    target_peer_ids: item.target_peer_ids,
    locked: item.locked,
    locked_by: item.locked_by,
    locked_at: item.locked_at,
    locked_group: item.locked_group,
    inactive: item.inactive,
    lock_parked_at: item.lock_parked_at,
    lock_parked_by: item.lock_parked_by,
    sync_state: item.sync_state,
    lock_scope: item.lock_scope,
    lock_contested_by: item.lock_contested_by,
    rev: row.rev,
    content_rev: row.content_rev,
  };
}

function handleRoadmapSyncPull(
  body: RoadmapSyncPullRequest
): RoadmapSyncPullResponse | { error: string; status: number } {
  const refused = refuseWhenReplica("/roadmap/sync/pull");
  if (refused) return refused;
  const replicaId = syncReplicaId(body.replica_id);
  if (typeof replicaId !== "string") return replicaId;
  const since = syncInteger(body.since_rev, "since_rev", 0);
  if (typeof since !== "number") return since;
  let limit = SYNC_PULL_LIMIT_MAX;
  if (body.limit !== undefined) {
    const asked = syncInteger(body.limit, "limit", 1);
    if (typeof asked !== "number") return asked;
    // Capped, not refused: the cap is a server-side page size, and a caller
    // asking for more simply gets a page plus a cursor to continue with.
    limit = Math.min(asked, SYNC_PULL_LIMIT_MAX);
  }
  const rows = db
    .query("SELECT * FROM roadmap_items WHERE rev > ? ORDER BY rev LIMIT ?")
    .all(since, limit) as RoadmapRow[];
  const items = rows.map(rowToSyncRow);
  // The last row of an ORDER BY rev page carries the greatest rev; an empty
  // page leaves the cursor where it was.
  const next_rev = items.length > 0 ? items[items.length - 1]!.rev : since;
  return { items, next_rev };
}

type SyncPushResult =
  | { ok: true; response: RoadmapSyncPushResponse }
  | { ok: false; conflict: RoadmapSyncPushConflict }
  | { error: string; status: number };

/**
 * Validates the pushed card the way /roadmap/upsert validates a body: the
 * replica is trusted at the token level, which is not a reason to write
 * unchecked enums, unparsable timestamps (an unparsable `updated_at` freezes
 * the lock sweep for that row) or an author outside the identity charset.
 * `created_by`/`updated_by` are KEPT as sent -- including 'deck': the replica
 * verified the signature locally and this route relays its verdict.
 */
function validatePushItem(
  raw: unknown
): { item: RoadmapSyncPushItem } | { error: string; status: number } {
  if (typeof raw !== "object" || raw === null) return { error: "item is required", status: 400 };
  const it = raw as Record<string, unknown>;
  if (typeof it.id !== "string" || !ROADMAP_ID_REGEX.test(it.id)) {
    return { error: "item.id is missing or malformed", status: 400 };
  }
  const rawProjectKey = typeof it.project_key === "string" ? it.project_key : "";
  const projectKeyCheck = validateProjectKey(rawProjectKey);
  if (!projectKeyCheck.ok) {
    return { error: `item.project_key is invalid (${projectKeyCheck.reason})`, status: 400 };
  }
  if (
    badEnum(it.kind, ROADMAP_KINDS) ||
    badEnum(it.priority, ROADMAP_PRIORITIES) ||
    badEnum(it.value, ROADMAP_LEVELS) ||
    badEnum(it.effort, ROADMAP_LEVELS) ||
    badEnum(it.status, ROADMAP_STATUSES)
  ) {
    return { error: "item has an invalid kind/priority/value/effort/status", status: 400 };
  }
  if (it.kind === undefined || it.priority === undefined || it.value === undefined ||
      it.effort === undefined || it.status === undefined) {
    return { error: "item is missing kind/priority/value/effort/status", status: 400 };
  }
  if (badEnum(it.directive ?? undefined, DIRECTIVE_COMMANDS)) {
    return { error: "item has an invalid directive", status: 400 };
  }
  if (it.kind === "directive" && !it.directive) {
    return { error: "item of kind 'directive' carries no directive", status: 400 };
  }
  const title = typeof it.title === "string" ? it.title.trim() : "";
  if (!title) return { error: "item.title is required", status: 400 };
  for (const field of ["description", "rationale", "context"] as const) {
    if (typeof it[field] !== "string") return { error: `item.${field} must be a string`, status: 400 };
  }
  if (typeof it.inactive !== "boolean") return { error: "item.inactive must be a boolean", status: 400 };
  for (const field of ["created_at", "updated_at"] as const) {
    if (typeof it[field] !== "string" || Number.isNaN(Date.parse(it[field] as string))) {
      return { error: `item.${field} is not a parsable timestamp`, status: 400 };
    }
  }
  if (it.deleted_at !== null && it.deleted_at !== undefined) {
    if (typeof it.deleted_at !== "string" || Number.isNaN(Date.parse(it.deleted_at))) {
      return { error: "item.deleted_at is not a parsable timestamp", status: 400 };
    }
  }
  const authors: { created_by: string; updated_by: string } = { created_by: "", updated_by: "" };
  for (const field of ["created_by", "updated_by"] as const) {
    const claimed = typeof it[field] === "string" ? (it[field] as string) : "";
    const normalized = normalizeAuthorIdentity(claimed);
    if (!normalized.ok) {
      log.warn(`/roadmap/sync/push: refused an author claim outside [a-z0-9:_-]`, { field });
      return {
        error:
          normalized.code === "empty"
            ? `item.${field} is empty`
            : `item.${field} contains a disallowed character '${normalized.badChar}' -- only [a-z0-9:_-] allowed`,
        status: 400,
      };
    }
    authors[field] = normalized.value;
  }
  return {
    item: {
      id: it.id,
      project_key: rawProjectKey,
      kind: it.kind as RoadmapKind,
      title,
      description: it.description as string,
      rationale: it.rationale as string,
      context: it.context as string,
      priority: it.priority as RoadmapPriority,
      value: it.value as RoadmapLevel,
      effort: it.effort as RoadmapLevel,
      status: it.status as RoadmapStatus,
      tags: cleanList(it.tags) ?? [],
      depends_on: cleanList(it.depends_on) ?? [],
      deleted_at: typeof it.deleted_at === "string" ? it.deleted_at : null,
      directive: (it.directive as RoadmapDirective | undefined) ?? null,
      target_peer_ids: it.kind === "directive" ? cleanPeerIds(it.target_peer_ids) : [],
      inactive: it.inactive,
      created_by: authors.created_by,
      updated_by: authors.updated_by,
      created_at: it.created_at as string,
      updated_at: it.updated_at as string,
    },
  };
}

function handleRoadmapSyncPush(body: RoadmapSyncPushRequest): SyncPushResult {
  const refused = refuseWhenReplica("/roadmap/sync/push");
  if (refused) return refused;
  const replicaId = syncReplicaId(body.replica_id);
  if (typeof replicaId !== "string") return replicaId;
  let expected: number | null = null;
  if (body.expected_content_rev !== null && body.expected_content_rev !== undefined) {
    const parsed = syncInteger(body.expected_content_rev, "expected_content_rev", 0);
    if (typeof parsed !== "number") return parsed;
    expected = parsed;
  }
  const validated = validatePushItem(body.item);
  if ("error" in validated) return validated;
  const item = validated.item;

  const existing = getRoadmapRow(item.id);
  if (existing) {
    // An `expected` of null claims the upstream has never seen this card, so a
    // row under the same id IS the divergence, whatever its content_rev.
    if (expected === null || existing.content_rev !== expected) {
      return { ok: false, conflict: { error: "conflict", item: rowToSyncRow(existing) } };
    }
    // Content plus the columns that ride with it. `queue` (the upstream owns
    // the order), every lock column (their own protocol) and `operator_id`
    // (a local signature proof) are deliberately absent from this SET list.
    db.run(
      `UPDATE roadmap_items SET
         kind = ?, title = ?, description = ?, rationale = ?, context = ?, priority = ?,
         value = ?, effort = ?, status = ?, tags = ?, depends_on = ?, deleted_at = ?,
         directive = ?, target_peer_ids = ?, inactive = ?,
         updated_by = ?, updated_at = ?
       WHERE id = ?`,
      [
        item.kind, item.title, item.description, item.rationale, item.context, item.priority,
        item.value, item.effort, item.status, JSON.stringify(item.tags),
        JSON.stringify(item.depends_on), item.deleted_at, item.directive,
        JSON.stringify(item.target_peer_ids), item.inactive ? 1 : 0,
        item.updated_by, item.updated_at, item.id,
      ]
    );
  } else {
    if (expected !== null) {
      // The replica derives from a row this broker no longer has: it cannot be
      // fast-forwarded and cannot be inserted under a base that is gone.
      return { ok: false, conflict: { error: "conflict", item: null } };
    }
    db.run(
      `INSERT INTO roadmap_items
         (id, project_key, kind, title, description, rationale, context, priority, value,
          effort, status, tags, depends_on, created_by, updated_by, created_at, updated_at,
          deleted_at, queue, directive, target_peer_ids, locked, inactive)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?)`,
      [
        item.id, item.project_key, item.kind, item.title, item.description, item.rationale,
        item.context, item.priority, item.value, item.effort, item.status,
        JSON.stringify(item.tags), JSON.stringify(item.depends_on), item.created_by,
        item.updated_by, item.created_at, item.updated_at, item.deleted_at, item.directive,
        JSON.stringify(item.target_peer_ids), item.inactive ? 1 : 0,
      ]
    );
  }
  const stored = getRoadmapRow(item.id)!;
  const row = rowToSyncRow(stored);
  return { ok: true, response: { item: row, rev: row.rev, content_rev: row.content_rev } };
}

type SyncLockResult =
  | { ok: true; claim: RoadmapSyncLockClaimResponse }
  | { ok: true; release: RoadmapSyncLockReleaseResponse }
  | { ok: false; contested: RoadmapSyncLockClaimResponse }
  | { error: string; status: number };

/**
 * The upstream half of the lock relay. A relayed lock keeps the agent's
 * peer_id in `locked_by` for display, carries `locked_by_token = NULL` (the
 * agent's credential never leaves its own broker) and is kept alive by
 * `lock_relay_seen`, which the sweep reads in place of the absent peer row.
 */
function handleRoadmapSyncLock(body: RoadmapSyncLockRequest): SyncLockResult {
  const refused = refuseWhenReplica("/roadmap/sync/lock");
  if (refused) return refused;
  const replicaId = syncReplicaId(body.replica_id);
  if (typeof replicaId !== "string") return replicaId;
  if (body.action !== "claim" && body.action !== "release") {
    return { error: "action must be 'claim' or 'release'", status: 400 };
  }
  if (typeof body.id !== "string" || !ROADMAP_ID_REGEX.test(body.id)) {
    return { error: "id is missing or malformed", status: 400 };
  }
  const owner = body.owner;
  if (typeof owner !== "object" || owner === null) {
    return { error: "owner { peer_id, group_id } is required", status: 400 };
  }
  const normalizedOwner = normalizeAuthorIdentity(
    typeof owner.peer_id === "string" ? owner.peer_id : ""
  );
  if (!normalizedOwner.ok) {
    return { error: "owner.peer_id is empty or outside [a-z0-9:_-]", status: 400 };
  }
  const ownerPeer = normalizedOwner.value;
  const ownerGroup = typeof owner.group_id === "string" ? owner.group_id : null;
  const tag = `${ownerPeer}@${replicaId}`;

  const row = getRoadmapRow(body.id);
  if (!row) {
    if (body.action === "release") {
      // A release for a card this broker does not have has nothing left to
      // undo: answering 200 lets the replica clear its pending release
      // instead of retrying it forever.
      return { ok: true, release: { released: false, item: null } };
    }
    return { error: "unknown roadmap item", status: 404 };
  }
  const contested = parseStringList(row.lock_contested_by);
  const withoutOwner = contested.filter((entry) => entry !== tag);
  const heldByThisRelay =
    row.locked === 1 && row.lock_relay === replicaId && row.locked_by === ownerPeer;

  if (body.action === "claim") {
    // The same rule an agent's own claim obeys: a card the operator set aside
    // cannot be taken, whichever broker the taker sits behind. The replica
    // refuses it locally too, so reaching this is a replica out of step -- not
    // a reason to let the claim through.
    if (refusesInactiveClaim(row.inactive === 1, row.status, row.locked === 1, row.status, true)) {
      return { error: "item is inactive -- clear inactive before locking it", status: 409 };
    }
    if (row.locked === 0) {
      db.run(
        `UPDATE roadmap_items SET
           locked = 1, locked_by = ?, locked_group = ?, locked_by_token = NULL,
           locked_at = datetime('now'), lock_relay = ?, lock_relay_seen = datetime('now'),
           lock_contested_by = ?
         WHERE id = ?`,
        [ownerPeer, ownerGroup, replicaId, JSON.stringify(withoutOwner), body.id]
      );
    } else if (heldByThisRelay) {
      // Re-assertion. `lock_relay_seen` alone is deliberately outside the
      // rev-tracked columns, so a heartbeat every tick does not re-publish
      // the row to every other replica.
      if (withoutOwner.length !== contested.length) {
        db.run(
          "UPDATE roadmap_items SET lock_relay_seen = datetime('now'), lock_contested_by = ? WHERE id = ?",
          [JSON.stringify(withoutOwner), body.id]
        );
      } else {
        db.run("UPDATE roadmap_items SET lock_relay_seen = datetime('now') WHERE id = ?", [body.id]);
      }
    } else {
      // Refused: annotate the holder so the operator sees who else wants it,
      // and write only when the annotation actually changes (an unchanged
      // list re-written every tick would bump `rev` forever).
      if (!contested.includes(tag)) {
        db.run("UPDATE roadmap_items SET lock_contested_by = ? WHERE id = ?", [
          JSON.stringify([...contested, tag]),
          body.id,
        ]);
      }
      return { ok: false, contested: { scope: "contested", item: rowToSyncRow(getRoadmapRow(body.id)!) } };
    }
    return { ok: true, claim: { scope: "global", item: rowToSyncRow(getRoadmapRow(body.id)!) } };
  }

  if (heldByThisRelay) {
    db.run(
      `UPDATE roadmap_items SET
         locked = 0, locked_by = NULL, locked_group = NULL, locked_by_token = NULL,
         locked_at = NULL, lock_relay = NULL, lock_relay_seen = NULL, lock_contested_by = ?
       WHERE id = ?`,
      [JSON.stringify(withoutOwner), body.id]
    );
    return { ok: true, release: { released: true, item: rowToSyncRow(getRoadmapRow(body.id)!) } };
  }
  // Not ours to release: the only thing this owner can withdraw is its own
  // contested claim.
  if (withoutOwner.length !== contested.length) {
    db.run("UPDATE roadmap_items SET lock_contested_by = ? WHERE id = ?", [
      JSON.stringify(withoutOwner),
      body.id,
    ]);
  }
  return { ok: true, release: { released: false, item: rowToSyncRow(getRoadmapRow(body.id)!) } };
}

/**
 * Answers in every mode, so one Deck poll can tell a replica from a broker
 * that has no replication state at all. 'upstream' is the mode of a broker
 * configured to defer to a remote one: its clients talk to that remote broker
 * directly, so it holds no cursor and no conflicts of its own.
 */
function handleRoadmapSyncStatus(): RoadmapSyncStatus {
  if (BROKER_MODE === "local") return { mode: "local" };
  if (BROKER_MODE === "remote") return { mode: "upstream" };
  const conflicts = (
    db.query("SELECT COUNT(*) AS n FROM roadmap_items WHERE sync_state = 'conflict'").get() as {
      n: number;
    }
  ).n;
  const pendingPush = (
    db.query(`SELECT COUNT(*) AS n FROM roadmap_items WHERE ${SYNC_PENDING_PUSH_WHERE}`).get() as {
      n: number;
    }
  ).n;
  const scopeRows = db
    .query(
      "SELECT lock_scope AS scope, COUNT(*) AS n FROM roadmap_items WHERE lock_scope IS NOT NULL GROUP BY lock_scope"
    )
    .all() as { scope: string; n: number }[];
  const locks = { local: 0, global: 0, contested: 0, remote: 0 };
  for (const r of scopeRows) {
    if (r.scope === "local" || r.scope === "global" || r.scope === "contested" || r.scope === "remote") {
      locks[r.scope] = r.n;
    }
  }
  return {
    mode: "replica",
    upstream_url: UPSTREAM_URL ?? "",
    online: syncOnlineState === "online",
    since: syncStateSince,
    last_error: syncLastError,
    last_sync_at: syncLastSyncAt,
    cursor: parseInt(syncMetaGet("upstream_cursor") ?? "0", 10),
    conflicts,
    pending_push: pendingPush,
    locks,
  };
}

/**
 * Rebuilds the operator's arbitration material: what this broker holds, what
 * the upstream held when the two diverged, and the content both derive from.
 * A row whose stored upstream snapshot cannot be read is reported in the log
 * and left out -- presenting a conflict with no remote side would offer a
 * choice that cannot be applied.
 */
function handleRoadmapSyncConflicts(
  body: RoadmapSyncConflictsRequest
): RoadmapSyncConflictsResponse | { error: string; status: number } {
  const refused = requireReplica("/roadmap/sync/conflicts");
  if (refused) return refused;
  const projectKey = typeof body.project_key === "string" ? body.project_key : "";
  if (!projectKey) return { error: "project_key is required", status: 400 };
  const rows = db
    .query("SELECT * FROM roadmap_items WHERE project_key = ? AND sync_state = 'conflict' ORDER BY updated_at DESC")
    .all(projectKey) as RoadmapRow[];
  const items: RoadmapSyncConflict[] = [];
  for (const row of rows) {
    const remote = parseSyncRemote(row.id, row.sync_remote);
    if (!remote) continue;
    items.push({
      local: rowToRoadmapItem(row),
      remote,
      base: readSyncBase(row.id, row.sync_base),
    });
  }
  return { items };
}

/**
 * The upstream row stored at conflict time. Validated on the two fields the
 * resolution actually needs (`content_rev` becomes the new merge base, the
 * content decides what is applied), never trusted on shape alone.
 */
function parseSyncRemote(id: string, raw: string | null): RoadmapSyncRow | null {
  if (!raw) {
    log.error(`roadmap sync: card ${id} is flagged conflict with no stored upstream row`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.error(`roadmap sync: card ${id} has an unreadable stored upstream row`, e);
    return null;
  }
  const candidate = parsed as Partial<RoadmapSyncRow> | null;
  if (!candidate || typeof candidate.content_rev !== "number" || typeof candidate.id !== "string") {
    log.error(`roadmap sync: card ${id} has a stored upstream row without id/content_rev`);
    return null;
  }
  if (!parseSyncContent(raw)) {
    log.error(`roadmap sync: card ${id} has a stored upstream row missing content fields`);
    return null;
  }
  return candidate as RoadmapSyncRow;
}

/**
 * The stored common ancestor. A null column is the ordinary "this card was
 * never synced" case; a column that is present but unreadable is not, and is
 * traced -- the merge would otherwise silently treat every field as locally
 * changed, which looks exactly like a successful merge.
 */
function readSyncBase(id: string, raw: string | null): RoadmapSyncContent | null {
  const parsed = parseSyncContent(raw);
  if (raw !== null && parsed === null) {
    log.warn(`roadmap sync: card ${id} has an unreadable merge base, merging as if it had none`);
  }
  return parsed;
}

function handleRoadmapSyncResolve(
  body: RoadmapSyncResolveRequest
): RoadmapSyncResolveResponse | { error: string; status: number } {
  // Same author proof as /roadmap/upsert -- this is a Deck write, and 'deck'
  // names the operator -- resolved BEFORE the mode check so an unprovable
  // author is refused identically on every deployment.
  const author = resolveRoadmapAuthor(body, "/roadmap/sync/resolve");
  if ("error" in author) return author;
  const refused = requireReplica("/roadmap/sync/resolve");
  if (refused) return refused;
  if (typeof body.id !== "string" || !body.id) return { error: "id is required", status: 400 };
  if (body.choice !== "remote" && body.choice !== "local" && body.choice !== "merge_reopen") {
    return { error: "choice must be 'remote', 'local' or 'merge_reopen'", status: 400 };
  }
  const row = getRoadmapRow(body.id);
  if (!row) return { error: "unknown roadmap item", status: 404 };
  if (readSyncState(row.sync_state) !== "conflict") {
    return { error: "item is not in conflict", status: 409 };
  }
  const remote = parseSyncRemote(row.id, row.sync_remote);
  if (!remote) return { error: "the stored upstream row is unreadable, cannot resolve", status: 409 };
  const remoteContent = pickSyncContent(remote);
  const localContent = pickSyncContent(rowToRoadmapItem(row));
  const base = readSyncBase(row.id, row.sync_base);

  const applied =
    body.choice === "remote"
      ? remoteContent
      : body.choice === "merge_reopen"
        ? mergeReopen(base, localContent, remoteContent)
        : null;
  // 'local' keeps the local content and stays dirty, so it is pushed on the
  // next pass; 'remote' adopts the upstream content and is clean; a merge is a
  // local content of its own, hence dirty like 'local'.
  const dirty = body.choice !== "remote";

  withApplying(() => {
    if (applied !== null && !contentEquals(applied, localContent)) {
      writeSyncContent(row.id, applied, author.by, new Date().toISOString());
    }
    db.run(
      `UPDATE roadmap_items SET
         sync_base_rev = ?, sync_base = ?, sync_dirty = ?, sync_state = 'clean', sync_remote = NULL
       WHERE id = ?`,
      [remote.content_rev, JSON.stringify(remoteContent), dirty ? 1 : 0, row.id]
    );
  });
  log.info(`roadmap sync: conflict on card ${row.id} resolved '${body.choice}' by '${author.by}'`);
  return { item: getRoadmapItem(row.id)! };
}

/** The one statement that writes replicated content onto a local card. */
function writeSyncContent(
  id: string,
  content: RoadmapSyncContent,
  updatedBy: string,
  updatedAt: string
): void {
  db.run(
    `UPDATE roadmap_items SET
       kind = ?, title = ?, description = ?, rationale = ?, context = ?, priority = ?,
       value = ?, effort = ?, status = ?, tags = ?, depends_on = ?, deleted_at = ?,
       directive = ?, target_peer_ids = ?, inactive = ?,
       updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      content.kind, content.title, content.description, content.rationale, content.context,
      content.priority, content.value, content.effort, content.status,
      JSON.stringify(content.tags), JSON.stringify(content.depends_on), content.deleted_at,
      content.directive, JSON.stringify(content.target_peer_ids), content.inactive ? 1 : 0,
      updatedBy, updatedAt, id,
    ]
  );
}

// --- Roadmap replication: the pass a replica runs against its upstream (§8) ---

type SyncOnlineState = "unknown" | "online" | "offline";

let syncOnlineState: SyncOnlineState = "unknown";
let syncStateSince = new Date().toISOString();
let syncLastError: string | null = null;
let syncLastSyncAt: string | null = null;
let syncInFlight = false;
let syncFailures = 0;
let syncBackoffMs = SYNC_TICK_MS;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Every replication write runs inside this: the `applying` flag tells the
 * content trigger not to mark the card dirty (the change came FROM the
 * upstream, it is not a local edit) and the lock triggers not to read a
 * mirrored lock as a local claim. Set and cleared inside one transaction with
 * a finally, so a throw can never leave the flag stuck -- and the rollback
 * would clear it a second time anyway.
 */
function withApplying<T>(fn: () => T): T {
  const tx = db.transaction(() => {
    syncMetaSet("applying", "1");
    try {
      return fn();
    } finally {
      syncMetaSet("applying", "0");
    }
  });
  return tx() as T;
}

/** The replica's own identity upstream: persisted, so a restart keeps its relays. */
function ensureReplicaId(): string {
  const stored = syncMetaGet("replica_id");
  if (stored && REPLICA_ID_REGEX.test(stored)) return stored;
  const minted = randomUUID();
  syncMetaSet("replica_id", minted);
  log.info(`roadmap sync: this replica is ${minted}`);
  return minted;
}

function upstreamErrorText(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return "no error field";
}

async function upstreamPost<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Same Bearer the other clients of this upstream present; absent when the
  // upstream runs unauthenticated.
  if (BROKER_TOKEN) headers.authorization = `Bearer ${BROKER_TOKEN}`;
  const res = await fetch(`${UPSTREAM_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SYNC_HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!text) return { status: res.status, body: null as T };
  try {
    return { status: res.status, body: JSON.parse(text) as T };
  } catch (e) {
    throw new Error(
      `${path} answered ${res.status} with a body that is not JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Applies one pulled row. Returns true when a local queue position was
 * replaced, so the pass can report how much local ordering the upstream order
 * overwrote (§4: the queue is never pushed, and losing a local order must not
 * be silent).
 */
function applyPulledRow(remote: RoadmapSyncRow): boolean {
  const local = getRoadmapRow(remote.id);
  const content = pickSyncContent(remote);
  const contentJson = JSON.stringify(content);
  if (!local) {
    const lockedRemotely = remote.locked && remote.locked_by !== null;
    db.run(
      `INSERT INTO roadmap_items
         (id, project_key, kind, title, description, rationale, context, priority, value,
          effort, status, tags, depends_on, created_by, updated_by, created_at, updated_at,
          deleted_at, queue, directive, target_peer_ids, inactive,
          locked, locked_by, locked_group, locked_at, lock_scope,
          sync_base_rev, sync_base, sync_dirty, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, 0, 'clean')`,
      [
        remote.id, remote.project_key, content.kind, content.title, content.description,
        content.rationale, content.context, content.priority, content.value, content.effort,
        content.status, JSON.stringify(content.tags), JSON.stringify(content.depends_on),
        remote.created_by, remote.updated_by, remote.created_at, remote.updated_at,
        content.deleted_at, remote.queue, content.directive,
        JSON.stringify(content.target_peer_ids), content.inactive ? 1 : 0,
        lockedRemotely ? 1 : 0, lockedRemotely ? remote.locked_by : null,
        lockedRemotely ? remote.locked_group : null, lockedRemotely ? remote.locked_at : null,
        lockedRemotely ? "remote" : null,
        remote.content_rev, contentJson,
      ]
    );
    return false;
  }

  const queueReplaced = local.queue !== null && local.queue !== remote.queue;
  const dirty = local.sync_dirty === 1;
  if (readSyncState(local.sync_state) === "conflict") {
    // Already waiting on the operator: keep the arbitration material current.
    db.run("UPDATE roadmap_items SET sync_remote = ? WHERE id = ?", [
      JSON.stringify(remote),
      remote.id,
    ]);
  } else if (!dirty) {
    writeSyncContent(remote.id, content, remote.updated_by, remote.updated_at);
    db.run(
      `UPDATE roadmap_items SET sync_base_rev = ?, sync_base = ?, sync_dirty = 0,
         sync_state = 'clean', sync_remote = NULL WHERE id = ?`,
      [remote.content_rev, contentJson, remote.id]
    );
  } else if (local.sync_base_rev !== null && local.sync_base_rev === remote.content_rev) {
    // Dirty here, untouched there: the local edit stands and will be pushed.
  } else if (remote.updated_by === "lock-sweep") {
    // §3.5: the upstream change is the stale-lock sweep reclaiming a card this
    // replica is still working on. Resolved as 'local' with no operator
    // arbitration, or every in-progress card would come back conflicted after
    // each disconnection.
    db.run(
      `UPDATE roadmap_items SET sync_base_rev = ?, sync_base = ? WHERE id = ?`,
      [remote.content_rev, JSON.stringify(pickSyncContent(remote)), remote.id]
    );
    log.info(
      `roadmap sync: card ${remote.id} kept local, the upstream change came from the lock sweep`
    );
  } else {
    db.run("UPDATE roadmap_items SET sync_state = 'conflict', sync_remote = ? WHERE id = ?", [
      JSON.stringify(remote),
      remote.id,
    ]);
    log.info(`roadmap sync: card ${remote.id} diverged from the upstream, operator arbitration needed`);
  }

  // Queue and locks travel outside the content protocol and are applied on
  // every branch, conflict included.
  const localScope = readLockScope(local.lock_scope);
  const heldLocally =
    local.locked === 1 &&
    (localScope === "local" ||
      localScope === "global" ||
      localScope === "contested" ||
      localScope === "release_pending");
  if (heldLocally) {
    db.run("UPDATE roadmap_items SET queue = ? WHERE id = ?", [remote.queue, remote.id]);
  } else if (remote.locked && remote.locked_by !== null) {
    db.run(
      `UPDATE roadmap_items SET queue = ?, locked = 1, locked_by = ?, locked_group = ?,
         locked_by_token = NULL, locked_at = ?, lock_scope = 'remote' WHERE id = ?`,
      [remote.queue, remote.locked_by, remote.locked_group, remote.locked_at, remote.id]
    );
  } else if (localScope === "remote") {
    db.run(
      `UPDATE roadmap_items SET queue = ?, locked = 0, locked_by = NULL, locked_group = NULL,
         locked_by_token = NULL, locked_at = NULL, lock_scope = NULL WHERE id = ?`,
      [remote.queue, remote.id]
    );
  } else {
    db.run("UPDATE roadmap_items SET queue = ? WHERE id = ?", [remote.queue, remote.id]);
  }
  return queueReplaced;
}

function applyPulledPage(items: RoadmapSyncRow[], nextRev: number): void {
  withApplying(() => {
    let queueReplaced = 0;
    for (const remote of items) {
      if (applyPulledRow(remote)) queueReplaced += 1;
    }
    // The cursor advances in the same transaction as the rows it covers: a
    // crash between the two would otherwise skip a page for good.
    syncMetaSet("upstream_cursor", String(nextRev));
    if (queueReplaced > 0) {
      log.info(
        `roadmap sync: ${queueReplaced} local queue position(s) replaced by the upstream order`
      );
    }
  });
}

async function syncPullPass(): Promise<void> {
  // Bounded so one pass cannot loop forever on a broker whose cursor never
  // advances; the next pass simply continues where this one stopped.
  for (let page = 0; page < 100; page++) {
    const since = parseInt(syncMetaGet("upstream_cursor") ?? "0", 10);
    const res = await upstreamPost<RoadmapSyncPullResponse>("/roadmap/sync/pull", {
      replica_id: REPLICA_ID,
      since_rev: Number.isFinite(since) ? since : 0,
      limit: SYNC_PULL_LIMIT_MAX,
    });
    if (res.status !== 200 || !res.body || !Array.isArray(res.body.items)) {
      throw new Error(`pull refused (${res.status}): ${upstreamErrorText(res.body)}`);
    }
    const nextRev = typeof res.body.next_rev === "number" ? res.body.next_rev : since;
    applyPulledPage(res.body.items, nextRev);
    if (res.body.items.length < SYNC_PULL_LIMIT_MAX) return;
  }
  log.warn("roadmap sync: pull stopped at the page cap, continuing on the next pass");
}

async function syncPushPass(): Promise<void> {
  const rows = db
    .query(
      `SELECT * FROM roadmap_items WHERE ${SYNC_PENDING_PUSH_WHERE} ORDER BY content_rev LIMIT ?`
    )
    .all(SYNC_PUSH_BATCH) as RoadmapRow[];
  for (const row of rows) {
    const content = pickSyncContent(rowToRoadmapItem(row));
    // Read BEFORE the round-trip: a local edit landing while the request is in
    // flight must leave the card dirty, so it departs again on the next pass.
    const sentContentRev = row.content_rev;
    const item: RoadmapSyncPushItem = {
      id: row.id,
      project_key: row.project_key,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      // Spread of a pick-list result, whose type is exactly the fifteen
      // content fields -- no table column can ride along.
      ...content,
    };
    const res = await upstreamPost<RoadmapSyncPushResponse | RoadmapSyncPushConflict>(
      "/roadmap/sync/push",
      { replica_id: REPLICA_ID, item, expected_content_rev: row.sync_base_rev }
    );
    if (res.status === 200) {
      const accepted = res.body as RoadmapSyncPushResponse;
      withApplying(() => {
        db.run(
          `UPDATE roadmap_items SET sync_base_rev = ?, sync_base = ?,
             sync_dirty = CASE WHEN content_rev = ? THEN 0 ELSE sync_dirty END
           WHERE id = ?`,
          [accepted.content_rev, JSON.stringify(content), sentContentRev, row.id]
        );
      });
      continue;
    }
    if (res.status === 409) {
      recordPushDivergence(row, (res.body as RoadmapSyncPushConflict).item ?? null);
      continue;
    }
    throw new Error(`push refused (${res.status}) for card ${row.id}: ${upstreamErrorText(res.body)}`);
  }
}

/**
 * A refused push. `item: null` means the upstream no longer has the row this
 * copy derives from: the base is dropped so the next pass offers the card as
 * a new one rather than retrying a fast-forward that can never succeed.
 */
function recordPushDivergence(row: RoadmapRow, remote: RoadmapSyncRow | null): void {
  if (!remote) {
    log.warn(
      `roadmap sync: the upstream no longer has card ${row.id}, it will be pushed again as a new card`
    );
    withApplying(() => {
      db.run("UPDATE roadmap_items SET sync_base_rev = NULL, sync_base = NULL WHERE id = ?", [row.id]);
    });
    return;
  }
  if (remote.updated_by === "lock-sweep") {
    withApplying(() => {
      db.run("UPDATE roadmap_items SET sync_base_rev = ?, sync_base = ? WHERE id = ?", [
        remote.content_rev,
        JSON.stringify(pickSyncContent(remote)),
        row.id,
      ]);
    });
    log.info(`roadmap sync: card ${row.id} kept local, the upstream change came from the lock sweep`);
    return;
  }
  withApplying(() => {
    db.run("UPDATE roadmap_items SET sync_state = 'conflict', sync_remote = ? WHERE id = ?", [
      JSON.stringify(remote),
      row.id,
    ]);
  });
  log.info(`roadmap sync: card ${row.id} was refused by the upstream, operator arbitration needed`);
}

function setLockScope(id: string, scope: RoadmapLockScope | null): void {
  withApplying(() => {
    db.run("UPDATE roadmap_items SET lock_scope = ?, lock_release_owner = NULL WHERE id = ?", [
      scope,
      id,
    ]);
  });
}

async function syncLockPass(): Promise<void> {
  const claims = db
    .query(
      `SELECT id, locked_by, locked_group FROM roadmap_items
        WHERE locked = 1 AND lock_scope IN ('local', 'global', 'contested')`
    )
    .all() as { id: string; locked_by: string | null; locked_group: string | null }[];
  for (const claim of claims) {
    if (!claim.locked_by) {
      log.warn(`roadmap sync: card ${claim.id} is locked with no owner, no upstream claim sent`);
      continue;
    }
    const res = await upstreamPost<RoadmapSyncLockClaimResponse>("/roadmap/sync/lock", {
      replica_id: REPLICA_ID,
      id: claim.id,
      action: "claim",
      owner: { peer_id: claim.locked_by, group_id: claim.locked_group },
    });
    if (res.status === 200) {
      setLockScope(claim.id, "global");
    } else if (res.status === 409) {
      setLockScope(claim.id, "contested");
    } else if (res.status === 404) {
      // The card has not reached the upstream yet (it is pushed by the step
      // above only once it is dirty): claim it on a later pass.
      log.warn(`roadmap sync: the upstream does not know card ${claim.id} yet, lock claim deferred`);
    } else {
      throw new Error(
        `lock claim refused (${res.status}) for card ${claim.id}: ${upstreamErrorText(res.body)}`
      );
    }
  }

  const releases = db
    .query("SELECT id, lock_release_owner FROM roadmap_items WHERE lock_scope = 'release_pending'")
    .all() as { id: string; lock_release_owner: string | null }[];
  for (const pending of releases) {
    if (!pending.lock_release_owner) {
      // Nothing to name upstream, so nothing it would accept: clear the local
      // marker rather than retry an unaddressable release every pass.
      log.warn(
        `roadmap sync: card ${pending.id} awaits an upstream release with no recorded owner, cleared locally`
      );
      setLockScope(pending.id, null);
      continue;
    }
    const res = await upstreamPost<RoadmapSyncLockReleaseResponse>("/roadmap/sync/lock", {
      replica_id: REPLICA_ID,
      id: pending.id,
      action: "release",
      owner: { peer_id: pending.lock_release_owner, group_id: null },
    });
    if (res.status === 200 || res.status === 404) {
      setLockScope(pending.id, null);
    } else {
      throw new Error(
        `lock release refused (${res.status}) for card ${pending.id}: ${upstreamErrorText(res.body)}`
      );
    }
  }
}

async function runSyncPass(): Promise<void> {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    await syncPullPass();
    await syncPushPass();
    await syncLockPass();
    syncLastSyncAt = new Date().toISOString();
    syncLastError = null;
    syncFailures = 0;
    syncBackoffMs = SYNC_TICK_MS;
    if (syncOnlineState !== "online") {
      syncOnlineState = "online";
      syncStateSince = new Date().toISOString();
      log.info(`roadmap sync: upstream ${UPSTREAM_URL} reachable, replication running`);
    }
  } catch (e) {
    syncLastError = e instanceof Error ? e.message : String(e);
    syncFailures += 1;
    syncBackoffMs = Math.min(SYNC_BACKOFF_MAX_MS, syncBackoffMs * 2);
    // Hysteresis: one lost round-trip is not a disconnection, and the
    // transition is logged ONCE -- a line per failed pass would fill the log
    // for as long as the operator works offline, which is the point of the
    // mode.
    if (syncFailures >= SYNC_OFFLINE_AFTER_FAILURES && syncOnlineState !== "offline") {
      syncOnlineState = "offline";
      syncStateSince = new Date().toISOString();
      log.error(`roadmap sync: upstream ${UPSTREAM_URL} unreachable, working offline`, e);
    }
  } finally {
    syncInFlight = false;
    armSyncTimer(syncOnlineState === "offline" ? syncBackoffMs : SYNC_TICK_MS);
  }
}

/**
 * setTimeout re-armed at the END of each pass, never setInterval: a pass
 * slower than the cadence must not overlap the next one.
 */
function armSyncTimer(delayMs: number): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void runSyncPass();
  }, delayMs);
}

const REPLICA_ID = BROKER_MODE === "replica" ? ensureReplicaId() : "";
if (BROKER_MODE === "replica") {
  // First pass right away rather than one cadence later: on a Deck start the
  // operator expects the roadmap to be current, not current in five seconds.
  armSyncTimer(Math.min(SYNC_TICK_MS, 100));
}

/**
 * session_id branches the read: absent, or empty/non-string and treated as
 * absent rather than a 400 or used as-is, takes the legacy byte-identical path;
 * a real value takes a non-destructive cursor path scoped to that session.
 * A hard 400 would break a legacy caller, and using an empty value as-is would
 * collide every such caller onto one cursor row.
 * delivered is still set on every row either path reads: it now means 'at least
 * one session has seen it', not 'visible', but it must stay set so the
 * undelivered-message TTL sweep doesn't claim rows nobody asked it to purge.
 */
function handleOperatorInbox(
  body: OperatorInboxRequest
): OperatorInboxResponse | { error: string; status: number } {
  const groupId = body.group_id;
  if (!groupId) return { error: "group_id is required", status: 400 };
  // Card 37a2b8c7 volet 1: the DRAIN half. A TOFU-exempt group skips the secret
  // check below by design, so draining it would hand the human operator's
  // undelivered messages -- and MARK THEM DELIVERED, hiding them from the real
  // Deck -- to any BROKER_TOKEN holder. Refused rather than authenticated (see
  // groupMayCarryOperatorInbox); the deposit half is refused in
  // handleSendMessage.
  if (!groupMayCarryOperatorInbox(groupId)) {
    log.warn(`operator-inbox: refused drain of a secret-less group`, { group_id: groupId });
    return {
      // Review MINOR-2: interpolated for the same reason as the deposit half --
      // the guard is derived, so the message must name the group it refused.
      error: `The operator inbox does not exist in the '${groupId}' group: it pins no secret`,
      status: 403,
    };
  }
  // Card 37a2b8c7 volet 4: shared checkGroupSecret, was its own copy of the
  // TOFU check.
  const inboxSecretError = checkGroupSecret(groupId, body.group_secret_hash ?? null);
  if (inboxSecretError) return inboxSecretError;

  // Card 1e81ee7b MAJOR 4: absent/'' stays the legacy drain (assumed,
  // documented retro-compat for an old Deck or a bare send_message caller);
  // any OTHER type is refused rather than silently falling back to legacy --
  // a Deck that serialised session_id as a number would otherwise recover
  // the destructive drain this lot exists to replace, with no error at all.
  if (
    body.session_id !== undefined &&
    body.session_id !== null &&
    typeof body.session_id !== "string"
  ) {
    return { error: "session_id must be a string", status: 400 };
  }
  const sessionId = typeof body.session_id === "string" && body.session_id.length > 0
    ? body.session_id
    : null;

  if (!sessionId) {
    // Legacy path, unchanged.
    const rows = db.query(
      `SELECT m.id, m.text, m.sent_at, COALESCE(p.peer_id, '<gone>') AS from_peer_id
       FROM messages m LEFT JOIN peers p ON p.instance_token = m.from_token
       WHERE m.to_token = ? AND m.group_id = ? AND m.delivered = 0
       ORDER BY m.id`
    ).all(OPERATOR_INSTANCE_TOKEN, groupId) as OperatorInboxMessage[];
    for (const row of rows) markDelivered.run(row.id);
    return { messages: rows };
  }

  // Card 1e81ee7b MAJOR 5 / part 4: the cursor path below INSERTs a row
  // carrying the caller-supplied group_id -- checkGroupSecret above does not
  // attest this group has ever registered (see groupExists doc comment), so
  // an unauthenticated caller naming a fictitious group_id could otherwise
  // grow this table without bound. Refused BEFORE the upsert, not after.
  if (!groupExists(groupId)) {
    log.warn(`operator-inbox: refused cursor session for a never-registered group`, {
      group_id: groupId,
    });
    return {
      error: `The '${groupId}' group has never registered a session`,
      status: 403,
    };
  }

  const now = new Date().toISOString();
  // ON CONFLICT branch only refreshes last_seen_at (keeps the session alive
  // against the purge GC) -- an UNKNOWN session_id (first sight, OR one the
  // purge GC just reaped for being stale) seeds last_id at the box's current
  // MAX(id), so it starts with an EMPTY Courrier per the design doc's rule,
  // rather than replaying everything sent before this Deck ever attached.
  upsertOperatorInboxSession.run(sessionId, groupId, OPERATOR_INSTANCE_TOKEN, groupId, now, now);
  const sessionRow = selectOperatorInboxSession.get(sessionId, groupId) as { last_id: number } | null;
  const lastId = sessionRow?.last_id ?? 0;
  const rows = selectOperatorInboxByCursor.all(
    OPERATOR_INSTANCE_TOKEN,
    groupId,
    lastId
  ) as OperatorInboxMessage[];
  for (const row of rows) markDelivered.run(row.id);
  if (rows.length > 0) {
    // ORDER BY m.id ASC in the statement above guarantees the last row is the
    // batch's MAX(id).
    advanceOperatorInboxCursor.run(rows[rows.length - 1]!.id, sessionId, groupId);
  }
  return { messages: rows };
}

/**
 * scope='session': this session's own cursor first jumps to the box's latest
 * id, then rows at or below the lowest cursor across the group's live sessions
 * are deleted -- dead sessions are garbage-collected first, or one that stopped
 * polling would pin the floor forever and nothing would ever be deleted.
 * scope='ids': an immediate global delete of the named ids, ANDed with group_id
 * so a caller cannot name an id belonging to a different group.
 */
function handleOperatorInboxPurge(
  body: OperatorInboxPurgeRequest
): OperatorInboxPurgeResponse | { error: string; status: number } {
  const groupId = body.group_id;
  if (!groupId) return { error: "group_id is required", status: 400 };
  if (typeof body.session_id !== "string" || body.session_id.length === 0) {
    return { error: "session_id is required", status: 400 };
  }
  if (!groupMayCarryOperatorInbox(groupId)) {
    log.warn(`operator-inbox/purge: refused purge of a secret-less group`, { group_id: groupId });
    return {
      error: `The operator inbox does not exist in the '${groupId}' group: it pins no secret`,
      status: 403,
    };
  }
  const secretError = checkGroupSecret(groupId, body.group_secret_hash ?? null);
  if (secretError) return secretError;

  // Card 1e81ee7b BLOCKER 2 / MAJOR 5 part 4: checkGroupSecret above does not
  // attest this group has ever registered (see groupExists doc comment).
  // Reachable UNAUTHENTICATED, since a never-seen group has no secret to
  // check against (TOFU accepts the unknown) -- refused here, before either
  // scope branch below can write.
  if (!groupExists(groupId)) {
    log.warn(`operator-inbox/purge: refused purge for a never-registered group`, {
      group_id: groupId,
    });
    return {
      error: `The '${groupId}' group has never registered a session`,
      status: 403,
    };
  }

  if (body.scope === "ids") {
    const rawIds = body.ids ?? [];
    const ids = rawIds.filter((id) => Number.isInteger(id));
    // Card 1e81ee7b MINOR: a caller whose ids serialised as strings ("1") or
    // floats (1.5) got a silent 200 {"deleted":0} -- indistinguishable from
    // "already gone". Non-empty input with nothing usable is now a 400
    // instead of a no-op that looks like success.
    if (rawIds.length > 0 && ids.length === 0) {
      return { error: "ids must contain at least one integer", status: 400 };
    }
    if (ids.length === 0) return { deleted: 0 };
    const result = purgeOperatorInboxByIds(ids).run(OPERATOR_INSTANCE_TOKEN, groupId, ...ids);
    return { deleted: result.changes };
  }

  if (body.scope !== "session") {
    return { error: `unknown scope '${body.scope}'`, status: 400 };
  }

  // GC dead sessions BEFORE computing the floor, so a session that stopped
  // polling cannot pin it forever. Scoped to THIS group (card 1e81ee7b
  // BLOCKER 2): the statement itself now carries `group_id = ?`, and
  // groupExists above additionally guarantees this group is real.
  gcDeadOperatorInboxSessions.run(groupId, `-${OPERATOR_INBOX_SESSION_TTL_MIN} minutes`);

  // Bump the caller's own cursor to MAX(id) first: "purge my session" means
  // "I've seen everything up to now, including what this call deletes". If
  // the session_id is unknown (never drained, or reaped by the GC line
  // above), this bump is a harmless no-op (0 rows affected) rather than an
  // error -- the MIN() below simply does not include it.
  bumpOperatorInboxCursorToMax.run(OPERATOR_INSTANCE_TOKEN, groupId, body.session_id, groupId);

  const floorRow = minLiveOperatorInboxCursor.get(groupId) as { floor: number | null } | null;
  const floor = floorRow?.floor;
  // No live session at all (including the caller's, if it was never
  // registered by a prior drain): nothing is provably read by anyone, so
  // there is no safe floor to delete up to. Decided as a no-op, not an error.
  if (floor === null || floor === undefined) return { deleted: 0 };

  const result = purgeOperatorInboxUpToId.run(OPERATOR_INSTANCE_TOKEN, groupId, floor);
  return { deleted: result.changes };
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

// --- Dispatch requests (card bf76d37f) ---

type DispatchRequestRow = {
  id: string;
  project_key: string;
  from_peer: string;
  status: DispatchRequestStatus;
  created_at: string;
  resolved_at: string | null;
  /** JSON of a DispatchRequestOutcome, or NULL while pending. */
  outcome: string | null;
};

/** How long /dispatch-request/add may hold its response open. */
const DISPATCH_WAIT_MAX_SEC = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_DISPATCH_WAIT_MAX_SEC ?? "60", 10)
);
/** Bounds on a Deck-supplied outcome, so a report cannot flood an agent's context. */
const DISPATCH_OUTCOME_MAX_CARDS = 50;
const DISPATCH_OUTCOME_MAX_TARGETS = 50;
const DISPATCH_OUTCOME_MAX_TEXT = 400;

function rowToDispatchRequest(row: DispatchRequestRow): DispatchRequest {
  let outcome: DispatchRequestOutcome | null = null;
  if (row.outcome) {
    try {
      outcome = JSON.parse(row.outcome) as DispatchRequestOutcome;
    } catch (err) {
      // Only reachable if the column was written outside this broker: the
      // insert path serialises a value this module itself validated. Report
      // rather than swallow (CLAUDE.md "no silent errors"), and hand back a
      // request the caller can still read as "resolved, report unreadable"
      // instead of a 500 that loses the row entirely.
      log.error("dispatch-request: stored outcome is not valid JSON", { id: row.id, err });
      outcome = { cards: [], note: "the stored outcome could not be read back" };
    }
  }
  return {
    id: row.id,
    project_key: row.project_key,
    from_peer: row.from_peer,
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    outcome,
  };
}

function cleanDispatchText(v: unknown, max: number): string {
  return truncate(stripControl(typeof v === "string" ? v : ""), max);
}

function cleanDispatchTargets(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, DISPATCH_OUTCOME_MAX_TARGETS)
    .map((t) => cleanDispatchText(t, DISPATCH_OUTCOME_MAX_TEXT))
    .filter((t) => t.length > 0);
}

/**
 * Flatten a Deck-supplied outcome before it can be parked and read back by an
 * agent. Hostile-input class 2 (CLAUDE.md): this crosses the broker HTTP
 * boundary in BOTH directions, so nothing here may keep a control byte, an
 * ANSI sequence or an unbounded length. Total, not partial: every field the
 * wire type declares is rebuilt from scratch, so an unknown extra property in
 * the request body is dropped rather than projected onward.
 */
function sanitizeDispatchOutcome(v: unknown): DispatchRequestOutcome {
  const src = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const rawCards = Array.isArray(src.cards) ? src.cards.slice(0, DISPATCH_OUTCOME_MAX_CARDS) : [];
  const cards: DispatchedCard[] = rawCards.map((c) => {
    const card = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    return {
      id: cleanDispatchText(card.id, DISPATCH_OUTCOME_MAX_TEXT),
      title: cleanDispatchText(card.title, DISPATCH_OUTCOME_MAX_TEXT),
      kind: cleanDispatchText(card.kind, DISPATCH_OUTCOME_MAX_TEXT),
      matched: cleanDispatchTargets(card.matched),
      missing: cleanDispatchTargets(card.missing),
      ambiguous: cleanDispatchTargets(card.ambiguous),
    };
  });
  return { cards, note: cleanDispatchText(src.note, DISPATCH_OUTCOME_MAX_TEXT) };
}

// Long-poll registry: /dispatch-request/add parks here until /dispatch-request
// /resolve settles the row. Keyed by REQUEST id, never by project_key: two
// leads triggering on one project are two rows, and each wakes only its own.
const dispatchRequestWaiters = new Map<string, Set<(r: DispatchRequest) => void>>();

function resolveDispatchRequestWaiters(request: DispatchRequest): void {
  const set = dispatchRequestWaiters.get(request.id);
  if (!set) return;
  dispatchRequestWaiters.delete(request.id);
  for (const fn of set) {
    try {
      fn(request);
    } catch (err) {
      log.error("dispatch-request: waiter callback threw", { id: request.id, err });
    }
  }
}

// --- Remote approvals (PLAN-notifications-mobiles N1) ---

// Notification lifetime. Only the NOTIFICATION expires: the session stays
// blocked and the Deck can still settle an expired_notif approval.
const APPROVAL_NOTIF_TTL_HOURS = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_APPROVAL_NOTIF_TTL_HOURS ?? "24", 10)
);
// Retention of SETTLED rows. Pending ones are never purged (they wait for a
// human, however long) — same rule as pending graph drafts.
const APPROVAL_TTL_DAYS = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_APPROVAL_TTL_DAYS ?? "30", 10)
);
// Anti-flood bound. A compromised sandboxed agent holding a session token can
// only spam its own operator (PLAN §6.8); this caps even that nuisance, and
// bounds unbounded DB growth from any producer.
const APPROVAL_MAX_PENDING = Math.max(
  1,
  parseInt(process.env.CLAUDE_PEERS_APPROVAL_MAX_PENDING ?? "200", 10)
);

type ApprovalRow = {
  id: string;
  operator_id: string;
  origin_host: string;
  origin_user: string;
  project_key: string;
  group_id: string;
  from_peer: string;
  session_ref: string;
  tile_ref: string;
  reply_route: string;
  reply_token: string;
  reply_group: string;
  kind: string;
  title: string;
  question: string;
  options_json: string;
  status: string;
  answered_via: string | null;
  answer_kind: string | null;
  answer_text: string | null;
  created_at: string;
  notif_expires_at: string;
  answered_at: string | null;
  delivered_at: string | null;
};

/**
 * Public projection (hostile input #2): the wire shape carries no
 * instance_token, no from_token and no pid — only what an operator UI or a
 * notification channel legitimately needs.
 */
function rowToApproval(row: ApprovalRow): Approval {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(row.options_json);
    if (Array.isArray(parsed)) options = parsed.filter((o): o is string => typeof o === "string");
  } catch (err) {
    // A malformed options blob must degrade to "no options", never 500 the
    // route -- but it is a real anomaly, so it is traced (no-silent-errors).
    log.error(`approval ${row.id}: unreadable options_json`, err);
  }
  return {
    id: row.id,
    operator_id: row.operator_id,
    origin: {
      host: row.origin_host,
      os_user_hash: row.origin_user,
      project_key: row.project_key,
      group_id: row.group_id,
      from_peer: row.from_peer,
      session_ref: row.session_ref,
      tile_ref: row.tile_ref ?? "",
    },
    // The ROUTE is public (the Deck must know whether to type); the routing
    // TOKEN never is -- same family as instance_token/from_token.
    reply_route: (row.reply_route === "channel" ? "channel" : "pty") as ApprovalReplyRoute,
    kind: row.kind as Approval["kind"],
    title: row.title,
    question: row.question,
    options,
    status: row.status as ApprovalStatus,
    answered_via: (row.answered_via as ApprovalVia | null) ?? null,
    answer_kind: (row.answer_kind as Approval["answer_kind"]) ?? null,
    answer_text: row.answer_text,
    created_at: row.created_at,
    notif_expires_at: row.notif_expires_at,
    answered_at: row.answered_at,
    delivered_at: row.delivered_at,
  };
}

// Bounded nonce cache: a signed proof is single-use, so replaying a captured
// one inside the skew window is refused. Closes backlog B8 for this family.
const approvalNonces = new Map<string, number>();
const APPROVAL_NONCE_MAX = 10_000;

function rememberNonce(nonce: string, nowSec: number): boolean {
  if (approvalNonces.has(nonce)) return false;
  if (approvalNonces.size >= APPROVAL_NONCE_MAX) {
    // Drop everything older than twice the accepted skew; if that frees
    // nothing (pathological burst), drop the oldest half.
    const cutoff = nowSec - 2 * 120;
    for (const [k, ts] of approvalNonces) if (ts < cutoff) approvalNonces.delete(k);
    if (approvalNonces.size >= APPROVAL_NONCE_MAX) {
      let drop = Math.floor(approvalNonces.size / 2);
      for (const k of approvalNonces.keys()) {
        approvalNonces.delete(k);
        if (--drop <= 0) break;
      }
    }
  }
  approvalNonces.set(nonce, nowSec);
  return true;
}

/**
 * The database and nonce cache are injected here so the decision logic stays
 * free of the database driver and can be unit-tested against a fake.
 * This single instance is the only authenticator in the process -- any other
 * ad-hoc auth path would silently reopen what this consolidation closes.
 */
const approvalAuth = createApprovalAuth({
  queryOne: <T,>(sql: string, params: unknown[]): T | null =>
    db.query(sql).get(...(params as never[])) as T | null,
  queryAll: <T,>(sql: string, params: unknown[]): T[] =>
    db.query(sql).all(...(params as never[])) as T[],
  run: (sql: string, params: unknown[]): void => {
    db.run(sql, params as never[]);
  },
  rememberNonce,
});

// Long-poll registry: /approval/wait parks here until a claim resolves it.
const approvalWaiters = new Map<string, Set<(a: Approval) => void>>();

function resolveApprovalWaiters(approval: Approval): void {
  const set = approvalWaiters.get(approval.id);
  if (!set) return;
  approvalWaiters.delete(approval.id);
  for (const fn of set) {
    try {
      fn(approval);
    } catch (err) {
      log.error(`approval waiter for ${approval.id} threw`, err);
    }
  }
}

/**
 * Resolve where the answer should be delivered (C-9).
 *
 * `channel` needs a live peer to push to. Only a peer_id crosses the wire; the
 * instance_token is looked up here and never leaves the broker. If the peer is
 * unknown or gone, we DOWNGRADE to 'pty' rather than silently accept a route
 * that can never deliver — the Deck's keystrokes then remain the fallback.
 */
function resolveReplyRoute(
  requested: string | undefined,
  replyPeerId: string | undefined,
  groupId: string
): { route: ApprovalReplyRoute; token: string; group: string } {
  if (requested !== "channel") return { route: "pty", token: "", group: "" };
  if (!replyPeerId || !groupId) return { route: "pty", token: "", group: "" };
  const peer = db
    .query(
      "SELECT instance_token FROM peers WHERE peer_id = ? AND group_id = ? AND status = 'active'"
    )
    .get(replyPeerId, groupId) as { instance_token: InstanceToken } | null;
  if (!peer) {
    log.info(`approval: peer '${replyPeerId}' not active in ${groupId} — falling back to pty`);
    return { route: "pty", token: "", group: "" };
  }
  return { route: "channel", token: peer.instance_token, group: groupId };
}

/**
 * Deliver a settled answer to the agent as a claude-peers message, sent from
 * the reserved `operator` sentinel.
 *
 * Reuses the ordinary message path wholesale (insert + WS push + poll
 * fallback): nothing new is invented, and `resolveSenderMeta` already maps the
 * sentinel to the `operator` peer_id on every receive path. server.ts renders
 * it with its own framing so the agent ACTS on it instead of acknowledging it.
 */
function deliverApprovalAnswer(row: ApprovalRow): void {
  if (row.reply_route !== "channel" || !row.reply_token) return;
  const answer =
    row.answer_kind === "text"
      ? (row.answer_text ?? "")
      : row.answer_kind === "allow"
        ? "Approved."
        : "Rejected.";
  const text = [
    `[approval ${row.id}] ${row.title}`,
    "",
    answer,
  ].join("\n");
  const sentAt = new Date().toISOString();
  try {
    const messageId = recordMessageTx(
      OPERATOR_INSTANCE_TOKEN,
      row.reply_token as InstanceToken,
      row.reply_group as GroupId,
      text,
      sentAt
    );
    const ws = wsPool.get(row.reply_token as InstanceToken);
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: "message",
          id: messageId,
          from_peer_id: OPERATOR_PEER_ID,
          from_summary: "",
          from_host: "",
          from_cwd: "",
          text,
          sent_at: sentAt,
        })
      );
    }
    // No markDelivered: same fire-and-forget contract as every other push.
  } catch (e) {
    // The answer is still recorded on the approval; losing the push must not
    // fail the claim (the operator's answer is not undone by a delivery hiccup).
    log.error(`approval ${row.id}: answer delivery failed`, e);
  }
}

function handleApprovalAdd(
  body: ApprovalAddRequest & Record<string, unknown>
): ApprovalAddResponse | { error: string; status: number } {
  // authorizeCreate returns a scope (for reads) and a stamp (for the insert);
  // neither is exposed to this handler, so it cannot choose what project_key
  // the new row carries.
  // That closes the path where a sandboxed agent reads project_key from the
  // request body to file under another project.
  const authorized = approvalAuth.authorizeCreate(body);
  if (isAuthError(authorized)) return authorized;
  const { scope, stamp } = authorized;

  const draft = validateApprovalDraft(body);
  if (!draft.ok) return { error: draft.error, status: 400 };

  // A session credential is pinned to its own session_ref: it can neither
  // impersonate another tile nor emit "anonymously". The comparison happens
  // inside the module (see assertStampSessionRef) so that this handler never
  // holds the credential's session_ref either -- only the verdict comes back.
  // The DRAFT's value is passed, not the raw body's: the validator strips
  // control bytes and trims, and comparing the raw form would refuse a caller
  // whose only sin was a trailing space.
  const pinned = assertStampSessionRef(stamp, draft.value.session_ref);
  if (pinned) return pinned;

  // De-duplication: a tile can only be waiting on ONE thing at a time, so a
  // second NOTIFICATION for the same tile is a double-raise, merged into one
  // (commit 4c2b2cf). A GUARDED REQUEST (`merge: 'never'`) neither searches
  // for a row to reuse nor is ever found by one: its verdict is re-read by a
  // caller gating an action (chantier 3189b002+874e9053).
  // The pending-count check keeps the session-pinned `approvalWhere` (a flood
  // cap is about THIS credential). The dedup SELECT uses `approvalTileWhere`
  // instead, deliberately wider (no session_ref), so the hook's session
  // credential and the Deck fallback's operator credential see the SAME
  // candidate rows regardless of arrival order (874e9053's asymmetry).
  const where = approvalWhere(scope);
  if (draft.value.tile_ref && draft.value.merge === "tile") {
    const tileWhere = approvalTileWhere(scope);
    const existing = db
      .query(
        `SELECT id, status FROM pending_approvals
          WHERE ${tileWhere.sql} AND tile_ref = ? AND mergeable = 1 AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(...(tileWhere.params as never[]), draft.value.tile_ref) as { id: string; status: string } | null;
    if (existing) {
      log.info(`approval: duplicate raise for tile ${draft.value.tile_ref} — reusing ${existing.id}`);
      // Only id + status: this branch can now match a row from a DIFFERENT
      // credential kind, so the caller must not read another producer's
      // title/question off it.
      return { approval: { id: existing.id, status: existing.status as ApprovalStatus } };
    }
  }

  const pending = db
    .query(`SELECT COUNT(*) AS n FROM pending_approvals WHERE ${where.sql} AND status = 'pending'`)
    .get(...(where.params as never[])) as { n: number };
  if (pending.n >= APPROVAL_MAX_PENDING) {
    return { error: "too many pending approvals", status: 429 };
  }

  const origin = (body.origin ?? {}) as Record<string, unknown>;
  const pick = (k: string): string => (typeof origin[k] === "string" ? (origin[k] as string) : "");
  const reply = resolveReplyRoute(
    typeof body.reply_route === "string" ? body.reply_route : undefined,
    typeof body.reply_peer_id === "string" ? body.reply_peer_id : undefined,
    pick("group_id")
  );
  const now = new Date();
  const ttlHours = Math.max(
    1,
    Math.min(24 * 30, Number.isFinite(body.ttl_hours) ? Number(body.ttl_hours) : APPROVAL_NOTIF_TTL_HOURS)
  );
  // The three credential-derived columns come from the STAMP, as columns and
  // values this handler splices without ever reading. `operator_id`,
  // `project_key` and `session_ref` therefore cannot be chosen here, and the
  // absence of `pick("project_key")` below is the fix card 1def56da exists for.
  //
  // `tile_ref` stays OUT of the stamp on purpose, and is not hardened by
  // symmetry: the code already declares it an untrusted routing hint that the
  // Deck re-validates against its own live tiles. Widening the credential to
  // cover it would be scope creep with no threat behind it.
  const stamped = stampInsert(stamp);
  const id = randomUUID();
  const createdAt = now.toISOString();
  const notifExpiresAt = new Date(now.getTime() + ttlHours * 3600_000).toISOString();

  db.run(
    `INSERT INTO pending_approvals
       (id, ${stamped.columns.join(", ")}, origin_host, origin_user, group_id, from_peer,
        tile_ref, mergeable, reply_route, reply_token, reply_group,
        kind, title, question, options_json, status, created_at, notif_expires_at)
     VALUES (?, ${stamped.columns.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      ...stamped.values,
      pick("host").slice(0, 128),
      pick("os_user_hash").slice(0, 64),
      pick("group_id").slice(0, 64),
      pick("from_peer").slice(0, 128),
      draft.value.tile_ref,
      draft.value.merge === "tile" ? 1 : 0,
      reply.route,
      reply.token,
      reply.group,
      draft.value.kind,
      draft.value.title,
      draft.value.question,
      JSON.stringify(draft.value.options),
      createdAt,
      notifExpiresAt,
    ]
  );

  // Read the row back UNDER SCOPE rather than assembling the response from the
  // values that were just written. Two reasons, and the second is the one that
  // matters: the response has to carry `operator_id` and `origin.project_key`,
  // and building it by hand would mean holding those values in this handler
  // again -- the exact thing the stamp exists to prevent. Coming back through
  // the row makes the response a READ of what was stored, which is also what a
  // caller actually wants to be told.
  const row = db
    .query(`SELECT * FROM pending_approvals WHERE id = ? AND ${where.sql}`)
    .get(id, ...(where.params as never[])) as ApprovalRow | null;
  // Unreachable barring a concurrent DELETE between the two statements: the
  // INSERT above used this very scope's values, so the row matches it by
  // construction. Loud rather than a silent 500 from a null dereference.
  if (!row) {
    log.error(`approval ${id} vanished between insert and read-back`);
    return { error: "approval could not be stored", status: 500 };
  }
  const approval = rowToApproval(row);
  // The duplicate-raise branch above already logs its own reuse; this is the
  // nominal path's own line, and its absence was exactly what made two
  // reported occurrences of an unattributed blocking question untraceable
  // (card 55c5470e) -- a route that only journals its exceptional branch is
  // blind precisely when someone needs to find an ordinary one by timestamp.
  log.info(`approval: new ${approval.kind} raised (${approval.id}) tile=${approval.origin.tile_ref || "-"}`);
  // Ring the operator's channels. Fire-and-forget: the approval is already
  // durable, and a dead transport must never fail the producer's call.
  void notifyRegistry.fanOut(approval).catch((e) => log.error("notify: fan-out failed", e));
  return { approval };
}

/**
 * Settle an approval. THE arbiter of the whole feature: a conditional UPDATE
 * means exactly one caller wins and everyone else gets 409 — which is what
 * makes "answered in the Deck" and "answered on the phone" mutually
 * exclusive.
 *
 * `via='deck'` may also settle an expired_notif approval: the notification
 * expired, the session did not (C-4).
 */
function settleApproval(
  id: string,
  // Card 1def56da: was `operatorId: string`. THE point of the change is that
  // the arity stops growing with the dimensions -- adding `deck_session_id`
  // tomorrow changes shared/approval-scope.ts and nothing here, whereas the
  // scalar form would have needed a parameter, a placeholder and a call-site
  // edit in every caller, each of which can be forgotten independently.
  scope: ApprovalScope,
  via: ApprovalVia,
  answerKind: Approval["answer_kind"],
  answerText: string | null
): { approval: Approval } | { error: string; status: number } {
  const allowed = via === "deck" ? "('pending','expired_notif')" : "('pending')";
  const now = new Date().toISOString();
  const where = approvalWhere(scope);
  const res = db.run(
    `UPDATE pending_approvals
        SET status = 'answered', answered_via = ?, answer_kind = ?, answer_text = ?, answered_at = ?
      WHERE id = ? AND ${where.sql} AND status IN ${allowed}`,
    [via, answerKind, answerText, now, id, ...(where.params as never[])]
  );
  if (res.changes === 0) {
    // The existence probe is scoped TOO. Unscoped it would answer 409 for a row
    // belonging to another project, which both leaks its existence and tells
    // the caller a lie: from where it stands, that approval is not settled, it
    // is not theirs.
    const exists = db
      .query(`SELECT id FROM pending_approvals WHERE id = ? AND ${where.sql}`)
      .get(id, ...(where.params as never[]));
    return exists
      ? { error: "already-settled", status: 409 }
      : { error: "unknown approval", status: 404 };
  }
  // Scoped as well, though the UPDATE above has just proved ownership: an
  // unscoped read here was safe only BECAUSE of what ran before it, which is
  // exactly the pattern that lets a later reorder become a leak with no diff to
  // point at (docs/DESIGN-APPROVAL-SCOPE.md §1.1).
  const row = db
    .query(`SELECT * FROM pending_approvals WHERE id = ? AND ${where.sql}`)
    .get(id, ...(where.params as never[])) as ApprovalRow;
  const approval = rowToApproval(row);
  // C-9: when the agent is at its prompt, the broker itself hands the answer
  // over as a peer message -- no keystrokes, and it works for sessions the
  // Deck does not own (a plain `claude` in a terminal, or another machine).
  deliverApprovalAnswer(row);
  resolveApprovalWaiters(approval);
  return { approval };
}

function handleApprovalClaim(
  body: ApprovalClaimRequest & Record<string, unknown>
): ApprovalClaimResponse | { error: string; status: number } {
  const id = typeof body.id === "string" ? body.id : "";
  // Card 1def56da: the id is read BEFORE authorization because authorizeTarget
  // resolves the object first and answers about THAT object, which is the whole
  // reason the targeted family gets its own function. An empty id still has to
  // be refused as a 400 rather than silently resolving nothing.
  const authorized = approvalAuth.authorizeTarget<ApprovalRow>(body, "claim", id ? [id] : []);
  if (isAuthError(authorized)) return authorized;
  const { scope } = authorized;
  if (!id) return { error: "id is required", status: 400 };
  const via = (body.via ?? "deck") as ApprovalVia;
  if (!APPROVAL_VIAS.includes(via)) return { error: "unknown via", status: 400 };
  const answerKind = body.answer_kind;
  if (!answerKind || !APPROVAL_ANSWER_KINDS.includes(answerKind)) {
    return { error: "answer_kind must be allow|deny|text", status: 400 };
  }

  let answerText: string | null = null;
  if (typeof body.answer_text === "string" && body.answer_text.length > 0) {
    // The answer is remote input that will be typed into a PTY: flatten it
    // here so no consumer can forget (hostile input, PLAN §6.3).
    const clean = sanitizeAnswerForPty(body.answer_text);
    if (!clean.ok) return { error: `answer_text: ${clean.error}`, status: 400 };
    answerText = clean.value;
  }
  if (answerKind === "text" && !answerText) {
    return { error: "answer_text is required for a text answer", status: 400 };
  }

  const settled = settleApproval(id, scope, via, answerKind, answerText);
  if (!("error" in settled)) {
    // Answered in the Deck: every phone copy must stop looking actionable.
    void notifyRegistry.settle(settled.approval, via).catch((e) =>
      log.error("notify: settle failed", e)
    );
  }
  return settled;
}

async function handleApprovalWait(
  body: ApprovalWaitRequest & Record<string, unknown>
): Promise<ApprovalWaitResponse | { error: string; status: number }> {
  const id = typeof body.id === "string" ? body.id : "";
  // authorizeTarget resolves the row under scope and returns it in one round
  // trip, combining what would otherwise be a separate id + operator_id lookup.
  // The session pin lives inside scope-building, so a handler needing it cannot
  // skip it.
  const authorized = approvalAuth.authorizeTarget<ApprovalRow>(body, "wait", id ? [id] : []);
  if (isAuthError(authorized)) return authorized;
  if (!id) return { error: "id is required", status: 400 };

  const row = authorized.rows[0] ?? null;
  // Same 404 whether it never existed or falls outside the caller's scope:
  // never confirm the existence of another operator's -- or another project's
  // -- approval. The scoping preserves that indistinguishability by
  // construction, since an out-of-scope row simply does not come back.
  if (!row) return { error: "unknown approval", status: 404 };
  if (row.status !== "pending") return { approval: rowToApproval(row) };

  const timeoutSec = Math.max(
    1,
    Math.min(APPROVAL_WAIT_MAX_SEC, Number.isFinite(body.timeout_sec) ? Number(body.timeout_sec) : 30)
  );

  return await new Promise<ApprovalWaitResponse>((resolve) => {
    let done = false;
    const settle = (value: ApprovalWaitResponse): void => {
      if (done) return;
      done = true;
      const set = approvalWaiters.get(id);
      if (set) {
        set.delete(onClaim);
        if (set.size === 0) approvalWaiters.delete(id);
      }
      clearTimeout(timer);
      resolve(value);
    };
    const onClaim = (approval: Approval): void => settle({ approval });
    const timer = setTimeout(() => settle({ pending: true }), timeoutSec * 1000);
    // A long poll must never keep the process alive on its own.
    timer.unref?.();
    let set = approvalWaiters.get(id);
    if (!set) {
      set = new Set();
      approvalWaiters.set(id, set);
    }
    set.add(onClaim);
  });
}

function handleApprovalList(
  body: ApprovalListRequest & Record<string, unknown>
): ApprovalListResponse | { error: string; status: number } {
  // Card 1def56da: `authorizeQuery`, because this handler resolves no object --
  // it IS the query. The mandatory-project_key refusal that card 4df14b5b
  // shipped here has moved INTO the module (resolveProjectKey), where it now
  // covers all four handlers instead of this one. Its reason is unchanged and
  // worth keeping in sight: two Deck windows on two different repos share one
  // operator_id, so operator_id alone lets one window's blocking questions leak
  // into the other's Courrier, and an omitted project_key used to mean "see
  // everything" -- which is the leak itself.
  const authorized = approvalAuth.authorizeQuery(body, "list");
  if (isAuthError(authorized)) return authorized;

  const where = approvalWhere(authorized.scope);
  // The identity clause is interpolated first and literally, not pushed into
  // the filters array, so a reader -- and an automated discipline check -- can
  // see the scope in the statement itself rather than trusting that whatever
  // later populated the array still includes it.
  const filters: string[] = [];
  const params: unknown[] = [...where.params];
  if (typeof body.status === "string" && body.status) {
    filters.push("status = ?");
    params.push(body.status);
  }
  if (body.undelivered_only) filters.push("status = 'answered' AND delivered_at IS NULL");
  const rows = db
    .query(
      `SELECT * FROM pending_approvals WHERE ${where.sql}` +
        filters.map((c) => ` AND ${c}`).join("") +
        ` ORDER BY created_at DESC LIMIT 500`
    )
    // The scope fields are always strings at runtime; the opaque array type is
    // just the module's deliberately loose return type. The cast here satisfies
    // the driver's tuple-length overloads without claiming anything false about
    // the actual values.
    .all(...(params as never[])) as ApprovalRow[];
  return { approvals: rows.map(rowToApproval) };
}

function handleApprovalDelivered(
  body: ApprovalDeliveredRequest & Record<string, unknown>
): ApprovalDeliveredResponse | { error: string; status: number } {
  const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [];
  // Card 1def56da. A BATCH: every id must be scoped, not just the first. The
  // loop below composes the same clause for each, so a caller cannot slip one
  // foreign id into an otherwise legitimate batch and have it marked delivered.
  const authorized = approvalAuth.authorizeTarget<ApprovalRow>(body, "list", ids.slice(0, 200));
  if (isAuthError(authorized)) return authorized;
  if (ids.length === 0) return { marked: 0 };
  const where = approvalWhere(authorized.scope);
  const now = new Date().toISOString();
  let marked = 0;
  const tx = db.transaction(() => {
    for (const id of ids.slice(0, 200)) {
      marked += db.run(
        `UPDATE pending_approvals SET delivered_at = ?
          WHERE id = ? AND ${where.sql} AND delivered_at IS NULL`,
        [now, id, ...(where.params as never[])]
      ).changes;
    }
  });
  tx();
  return { marked };
}

/**
 * Connect a channel: the Deck hands over the channel's secret (operator-signed),
 * the broker seals it and starts the gateway. This is why the operator never
 * needs shell access to the broker host.
 *
 * Telegram and Discord are enrolled with a BOT TOKEN. ntfy has no bot: what is
 * sealed there is a small config object — the server plus the two topics the
 * broker mints — and the phone is enrolled by scanning it (`mobile_payload`).
 */
async function handleChannelConnect(
  body: Record<string, unknown>
): Promise<
  | {
      kind: string;
      label: string;
      hint: string;
      pairing_code: string;
      deep_link: string;
      invite_url: string;
      mobile_payload: string;
    }
  | { error: string; status: number }
> {
  // Card 1def56da: `authenticateOperator`, not one of the `authorize*` family.
  // A notification channel BELONGS to an operator, so `operator_id` here is the
  // business key and not a scope this handler could delegate. What the split
  // buys is the other direction: holding an identity, this handler cannot build
  // a clause on `pending_approvals` -- `approvalWhere` takes a scope, and no
  // exported function turns an identity into one.
  const auth = approvalAuth.authenticateOperator(body, "channels");
  if (isAuthError(auth)) return auth;

  const kind = typeof body.kind === "string" ? (body.kind as ChannelKind) : ("" as ChannelKind);
  if (kind !== "telegram" && kind !== "discord" && kind !== "ntfy") {
    return { error: "kind must be telegram|discord|ntfy", status: 400 };
  }

  let sealed: string;
  let hint: string;
  /** The candidate secret in the clear, so it can be vetted before storing. */
  let plain: string;
  let ntfyConfig: NtfyConfig | null = null;
  if (kind === "ntfy") {
    const server = normalizeNtfyServer(typeof body.server === "string" ? body.server : "");
    if (!server.ok) return { error: server.error, status: 400 };
    // The topics ARE the secret: ntfy has no per-topic identity, so an
    // unguessable name plus (optionally) an access token is the whole lock.
    // Reusing the previous ones on a reconnect would keep a revoked phone
    // subscribed, so a reconnect always mints fresh ones.
    ntfyConfig = {
      server: server.value,
      topic_notif: randomBytes(NTFY_TOPIC_HEX_LEN / 2).toString("hex"),
      topic_replies: randomBytes(NTFY_TOPIC_HEX_LEN / 2).toString("hex"),
      token: typeof body.token === "string" ? body.token.trim().slice(0, 256) : "",
    };
    plain = JSON.stringify(ntfyConfig);
    sealed = sealSecret(secretKey, plain);
    // Not a token fragment here: the server is what the operator needs to
    // recognise the row, and it is not a secret.
    hint = new URL(ntfyConfig.server).host.slice(0, 64);
  } else {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return { error: "token is required", status: 400 };
    plain = token;
    sealed = sealSecret(secretKey, token);
    hint = secretHint(token);
  }

  // VET FIRST, PERSIST SECOND. Writing the new secret up front and deleting it
  // again on failure destroyed a working, paired channel whenever the operator
  // hit Connect with the relay briefly unreachable or an address mistyped: the
  // old sealed config was already overwritten and its gateway already stopped.
  // `startChannel` with a candidate touches nothing until the provider accepts.
  const me = await startChannel(auth.operator_id, kind, plain);
  if (!me) {
    return {
      error: kind === "ntfy" ? "the ntfy server refused these settings" : "the provider refused this token",
      status: 400,
    };
  }

  db.run(
    `INSERT INTO approval_channel_secrets (operator_id, kind, secret_enc, hint, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(operator_id, kind) DO UPDATE SET
       secret_enc = excluded.secret_enc, hint = excluded.hint,
       label = excluded.label, created_at = excluded.created_at`,
    [auth.operator_id, kind, sealed, hint, me.label, new Date().toISOString()]
  );

  // ntfy only: the topics just changed, so a binding pointing at the old one
  // addresses a topic nobody publishes to any more. Telegram and Discord keep
  // theirs — an address there is a chat id, which a new token does not move.
  if (kind === "ntfy") {
    db.run("DELETE FROM approval_channels WHERE operator_id = ? AND kind = 'ntfy'", [auth.operator_id]);
  }

  // One-shot pairing code: the operator sends it to the bot (or scans it into
  // the app), which binds their address. Short-lived on purpose, and 96 bits
  // rather than 32 — it is a primary key with no conflict handling, so a
  // birthday collision would throw after the topics had already been minted.
  const code = randomBytes(12).toString("base64url");
  db.run(
    `INSERT INTO approval_pairing_codes (code, operator_id, kind, expires_at) VALUES (?, ?, ?, ?)`,
    [code, auth.operator_id, kind, new Date(Date.now() + 30 * 60_000).toISOString()]
  );
  // Everything the operator still has to do, handed over ready to use: a deep
  // link they can scan for Telegram, an invite URL for Discord (the bot must
  // share a server with them before it may DM — error 50278 otherwise), and for
  // ntfy the QR payload the app scans.
  return {
    kind,
    label: me.label,
    hint,
    pairing_code: code,
    deep_link: kind === "telegram" ? `https://t.me/${me.label}?start=${code}` : "",
    invite_url:
      kind === "discord" && me.appId
        ? `https://discord.com/oauth2/authorize?client_id=${me.appId}&scope=bot&permissions=0`
        : "",
    // CREDENTIAL, not a link: it carries the topics and the access token.
    mobile_payload: ntfyConfig ? encodePairingPayload({ ...ntfyConfig, code }) : "",
  };
}

async function handleChannelDisconnect(
  body: Record<string, unknown>
): Promise<{ removed: number } | { error: string; status: number }> {
  // Card 1def56da: `authenticateOperator`, not one of the `authorize*` family.
  // A notification channel BELONGS to an operator, so `operator_id` here is the
  // business key and not a scope this handler could delegate. What the split
  // buys is the other direction: holding an identity, this handler cannot build
  // a clause on `pending_approvals` -- `approvalWhere` takes a scope, and no
  // exported function turns an identity into one.
  const auth = approvalAuth.authenticateOperator(body, "channels");
  if (isAuthError(auth)) return auth;
  const kind = typeof body.kind === "string" ? (body.kind as ChannelKind) : ("" as ChannelKind);
  if (!kind) return { error: "kind is required", status: 400 };

  await releaseChannel(auth.operator_id, kind);
  db.run("DELETE FROM approval_channel_secrets WHERE operator_id = ? AND kind = ?", [
    auth.operator_id,
    kind,
  ]);
  const removed = db.run("DELETE FROM approval_channels WHERE operator_id = ? AND kind = ?", [
    auth.operator_id,
    kind,
  ]).changes;
  db.run("DELETE FROM approval_pairing_codes WHERE operator_id = ? AND kind = ?", [
    auth.operator_id,
    kind,
  ]);
  return { removed };
}

function handleChannelList(
  body: Record<string, unknown>
): { channels: Array<Record<string, unknown>> } | { error: string; status: number } {
  // Card 1def56da: `authenticateOperator`, not one of the `authorize*` family.
  // A notification channel BELONGS to an operator, so `operator_id` here is the
  // business key and not a scope this handler could delegate. What the split
  // buys is the other direction: holding an identity, this handler cannot build
  // a clause on `pending_approvals` -- `approvalWhere` takes a scope, and no
  // exported function turns an identity into one.
  const auth = approvalAuth.authenticateOperator(body, "channels");
  if (isAuthError(auth)) return auth;
  const secrets = db
    .query("SELECT kind, hint, label FROM approval_channel_secrets WHERE operator_id = ?")
    .all(auth.operator_id) as Array<{ kind: string; hint: string; label: string }>;
  const bindings = db
    .query("SELECT kind, address, label FROM approval_channels WHERE operator_id = ? AND enabled = 1")
    .all(auth.operator_id) as Array<{ kind: string; address: string; label: string }>;
  const ready = new Set(notifyRegistry.readyKinds(auth.operator_id));
  // The token NEVER comes back -- only a 4-character hint of it.
  return {
    channels: (["telegram", "discord", "ntfy"] as ChannelKind[]).map((kind) => {
      const secret = secrets.find((x) => x.kind === kind);
      const bound = bindings.filter((b) => b.kind === kind);
      return {
        kind,
        configured: !!secret,
        connected: !!secret && ready.has(kind),
        bot_label: secret?.label ?? "",
        token_hint: secret?.hint ?? "",
        paired: bound.length,
        // Addresses are the operator's own account ids; the labels are enough
        // for the UI and keep the ids out of the renderer.
        paired_labels: bound.map((b) => b.label).filter(Boolean),
      };
    }),
  };
}

function handleApprovalTokenMint(
  body: ApprovalTokenMintRequest & Record<string, unknown>
): ApprovalTokenMintResponse | { error: string; status: number } {
  // Card 1def56da: identity, not scope. A session token belongs to an operator
  // and this handler writes `approval_session_tokens`, a different table that
  // `approvalWhere` deliberately does not cover.
  const auth = approvalAuth.authenticateOperator(body, "mint-token");
  if (isAuthError(auth)) return auth;

  const sessionPublicKey = typeof body.session_public_key === "string" ? body.session_public_key : "";
  const sessionRef = typeof body.session_ref === "string" ? body.session_ref.trim().slice(0, 128) : "";
  if (!sessionPublicKey) return { error: "session_public_key is required", status: 400 };
  if (!sessionRef) return { error: "session_ref is required", status: 400 };

  const ttlHours = Math.max(
    1,
    Math.min(24 * 30, Number.isFinite(body.ttl_hours) ? Number(body.ttl_hours) : 24)
  );
  // Card 1def56da: the project the Deck window minting this credential works
  // on. It is pinned HERE, once, by the operator, so that the agent holding the
  // token can never choose it later -- the same discipline `session_ref` has
  // always had. Required: a mint without it would produce a credential that
  // every `add` then refuses, which is a worse failure than refusing the mint.
  const rawProjectKey = typeof body.project_key === "string" ? body.project_key : "";
  if (!rawProjectKey) return { error: "project_key is required", status: 400 };
  // A refusal, not a truncation: silently truncating an oversized project_key
  // would mint a second, colliding key for the same project instead of
  // surfacing the malformed input.
  const projectKeyCheck = validateProjectKey(rawProjectKey);
  if (!projectKeyCheck.ok) {
    return { error: `project_key is invalid (${projectKeyCheck.reason})`, status: 400 };
  }
  const projectKey = rawProjectKey;
  const tokenId = deriveTokenId(sessionPublicKey);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000).toISOString();
  db.run(
    `INSERT INTO approval_session_tokens
       (token_id, operator_id, public_key, session_ref, project_key, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(token_id) DO UPDATE SET
       expires_at = excluded.expires_at, revoked_at = NULL,
       -- Re-minting must REFRESH the project: a tile reused for another repo
       -- keeps its token_id (derived from the key) but must not keep the old
       -- project, or the scope would silently lag one window behind.
       project_key = excluded.project_key`,
    [tokenId, auth.operator_id, sessionPublicKey, sessionRef, projectKey, now.toISOString(), expiresAt]
  );
  return { token_id: tokenId, expires_at: expiresAt };
}

function handleApprovalTokenRevoke(
  body: ApprovalTokenRevokeRequest & Record<string, unknown>
): ApprovalTokenRevokeResponse | { error: string; status: number } {
  // Card 1def56da: identity, not scope. A session token belongs to an operator
  // and this handler writes `approval_session_tokens`, a different table that
  // `approvalWhere` deliberately does not cover.
  const auth = approvalAuth.authenticateOperator(body, "mint-token");
  if (isAuthError(auth)) return auth;
  const now = new Date().toISOString();
  if (typeof body.token_id === "string" && body.token_id) {
    const r = db.run(
      "UPDATE approval_session_tokens SET revoked_at = ? WHERE token_id = ? AND operator_id = ? AND revoked_at IS NULL",
      [now, body.token_id, auth.operator_id]
    );
    return { revoked: r.changes };
  }
  if (typeof body.session_ref === "string" && body.session_ref) {
    const r = db.run(
      "UPDATE approval_session_tokens SET revoked_at = ? WHERE session_ref = ? AND operator_id = ? AND revoked_at IS NULL",
      [now, body.session_ref, auth.operator_id]
    );
    return { revoked: r.changes };
  }
  return { error: "token_id or session_ref is required", status: 400 };
}

/**
 * Expire the NOTIFICATION of overdue pending approvals, and purge settled ones
 * past the retention window. Pending rows are never deleted.
 */
function sweepApprovals(): { expired: number; purged: number } {
  const expired = db.run(
    `UPDATE pending_approvals SET status = 'expired_notif'
      WHERE status = 'pending' AND notif_expires_at < ?`,
    [new Date().toISOString()]
  ).changes;
  const purged = db.run(
    `DELETE FROM pending_approvals
      WHERE status IN ('answered','abandoned') AND created_at < datetime('now', ?)`,
    [`-${APPROVAL_TTL_DAYS} days`]
  ).changes;
  // Pairing codes were only ever deleted when someone tried to redeem one, so
  // an operator who clicks Connect and never scans left a row behind for good.
  db.run("DELETE FROM approval_pairing_codes WHERE expires_at < ?", [new Date().toISOString()]);
  if (expired > 0) log.info(`approval notifications expired: ${expired}`);
  return { expired, purged };
}

// --- Notification gateways (PLAN N3/N4) ---

const secretKey = loadOrCreateSecretKey(join(dirname(DB_PATH), "notify.key"));

/** Bindings, pairing codes and posted copies, backed by SQLite. */
const registryStore: RegistryStore = {
  bindingsFor(operatorId) {
    const rows = db
      .query(
        `SELECT id, operator_id, kind, address, label, enabled
           FROM approval_channels WHERE operator_id = ? AND enabled = 1`
      )
      .all(operatorId) as Array<{
      id: string;
      operator_id: string;
      kind: string;
      address: string;
      label: string;
      enabled: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      operator_id: r.operator_id,
      kind: r.kind as ChannelKind,
      address: r.address,
      label: r.label,
      enabled: r.enabled === 1,
    }));
  },
  binding(bindingId) {
    const r = db
      .query(`SELECT id, operator_id, kind, address, label, enabled FROM approval_channels WHERE id = ?`)
      .get(bindingId) as
      | { id: string; operator_id: string; kind: string; address: string; label: string; enabled: number }
      | null;
    return r
      ? {
          id: r.id,
          operator_id: r.operator_id,
          kind: r.kind as ChannelKind,
          address: r.address,
          label: r.label,
          enabled: r.enabled === 1,
        }
      : null;
  },
  recordPost(rec) {
    db.run(
      `INSERT OR REPLACE INTO approval_posts (approval_id, kind, binding_id, external_ref)
       VALUES (?, ?, ?, ?)`,
      [rec.approvalId, rec.kind, rec.bindingId, rec.externalRef]
    );
  },
  postsFor(approvalId) {
    const rows = db
      .query("SELECT approval_id, kind, binding_id, external_ref FROM approval_posts WHERE approval_id = ?")
      .all(approvalId) as Array<{
      approval_id: string;
      kind: string;
      binding_id: string;
      external_ref: string;
    }>;
    return rows.map((r) => ({
      approvalId: r.approval_id,
      kind: r.kind as ChannelKind,
      bindingId: r.binding_id,
      externalRef: r.external_ref,
    }));
  },
  clearPosts(approvalId) {
    db.run("DELETE FROM approval_posts WHERE approval_id = ?", [approvalId]);
  },
};

const notifyRegistry = new NotificationRegistry(registryStore, {
  info: (m) => log.info(m),
  error: (m, e) => log.error(m, e),
});

/**
 * Is this address paired at all? A PRE-FILTER, not the gate.
 *
 * Adapters call it to drop a stranger before touching anything — a bot's
 * username is public, so strangers WILL message it. It deliberately does not
 * answer "whose address is this", because one address can belong to SEVERAL
 * operators: one person with two OS accounts, one bot and one chat account
 * ends up with two bindings on the same chat id. The real authorisation is
 * `bindingFor(kind, address, operatorId)` below, keyed on the approval's owner.
 */
function isPairedAddress(kind: ChannelKind, address: string): ChannelBinding | null {
  const r = db
    .query(
      `SELECT id, operator_id, kind, address, label, enabled
         FROM approval_channels WHERE kind = ? AND address = ? AND enabled = 1`
    )
    .get(kind, address) as
    | { id: string; operator_id: string; kind: string; address: string; label: string; enabled: number }
    | null;
  return r ? toBinding(r) : null;
}

/**
 * The authorisation check: is this address paired FOR THIS OPERATOR?
 *
 * Asking the question in this direction is what lets one chat serve two
 * operator identities. The other direction — resolve the address to "its"
 * operator, then compare — silently picked one of the two rows, so roughly
 * half the answers were refused as "already handled" with the operator
 * looking at a perfectly valid request.
 */
function bindingFor(kind: ChannelKind, address: string, operatorId: string): ChannelBinding | null {
  const r = db
    .query(
      `SELECT id, operator_id, kind, address, label, enabled
         FROM approval_channels
        WHERE kind = ? AND address = ? AND operator_id = ? AND enabled = 1`
    )
    .get(kind, address, operatorId) as
    | { id: string; operator_id: string; kind: string; address: string; label: string; enabled: number }
    | null;
  return r ? toBinding(r) : null;
}

function toBinding(r: {
  id: string;
  operator_id: string;
  kind: string;
  address: string;
  label: string;
}): ChannelBinding {
  return {
    id: r.id,
    operator_id: r.operator_id,
    kind: r.kind as ChannelKind,
    address: r.address,
    label: r.label,
    enabled: true,
  };
}

/**
 * What a gateway calls when a channel produces an answer or a pairing attempt.
 * Arbitration stays HERE, never in an adapter (C-1).
 */
const channelHost: ChannelHost = {
  async onAnswer(kind, answer) {
    // Resolves the approval first (a read by id, nothing written), then checks
    // whether the sender is paired for that approval's own owner -- resolving
    // the address to an operator and comparing was only equivalent while an
    // address belonged to exactly one operator, which stops holding once one
    // person runs two OS accounts against one bot.
    // The row and its scope come back together from one call, so the scope can
    // never be assembled from anything the sender supplied -- only an id
    // crosses in.
    const resolved = approvalAuth.scopeForAnsweredRow<ApprovalRow>(answer.approvalId);
    if (!resolved) return null;
    const row = resolved.row;
    const binding = bindingFor(kind, answer.fromAddress, row.operator_id);
    // Not paired for this owner — a stranger, or the operator's own other
    // account. Nothing is written, and the sender is told no more than
    // "already handled": never that the id exists but is somebody else's.
    if (!binding) return null;

    let answerText: string | null = null;
    if (answer.answerText) {
      const clean = sanitizeAnswerForPty(answer.answerText);
      if (!clean.ok) return null;
      answerText = clean.value;
    }
    // Card 1def56da. The TWELFTH authorization path, and the only one with no
    // credential: the sender proved nothing by signature, the PAIRING above is
    // what proves ownership. The scope was minted by the module from the row it
    // read, so it matches that one row and can widen nothing. Nothing here
    // chooses it: review measured that when this call passed a scope BUILT from
    // local values, swapping `binding.operator_id` for `answer.fromAddress`
    // left every suite green.
    const settled = settleApproval(
      answer.approvalId,
      resolved.scope,
      kind,
      answer.answerKind,
      answerText
    );
    if ("error" in settled) return null;
    // Rewrite the copies on the OTHER channels; the winning one has already
    // acknowledged its own user.
    void notifyRegistry.settle(settled.approval, kind, kind);
    return settled.approval;
  },

  async onPair(kind, code, address, label) {
    const row = db
      .query("SELECT operator_id, kind, expires_at FROM approval_pairing_codes WHERE code = ?")
      .get(code) as { operator_id: string; kind: string; expires_at: string } | null;
    if (!row || row.kind !== kind) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      db.run("DELETE FROM approval_pairing_codes WHERE code = ?", [code]);
      return null;
    }
    // For ntfy the ADDRESS is a topic WE minted, so it must be this operator's
    // own. Without the check, a pairing code published on somebody else's
    // replies topic would bind this operator to that topic — and an answer
    // arriving there would then pass the authorisation check for this
    // operator's approvals. Telegram and Discord have no equivalent invariant:
    // there the address is a chat id the provider supplies, and any chat may
    // legitimately pair.
    if (kind === "ntfy" && !ntfyAddressBelongsTo(row.operator_id, address)) {
      log.error(`notify: ntfy pairing refused — the code was presented on a foreign topic`);
      return null;
    }
    // One-shot: consumed on first use, like the companion's QR token.
    db.run("DELETE FROM approval_pairing_codes WHERE code = ?", [code]);
    const id = randomUUID();
    db.run(
      `INSERT INTO approval_channels (id, operator_id, kind, address, label, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(operator_id, kind, address) DO UPDATE SET enabled = 1, label = excluded.label`,
      [id, row.operator_id, kind, address, label.slice(0, 64), new Date().toISOString()]
    );
    log.info(`notify: ${kind} paired for operator ${row.operator_id}`);
    return bindingFor(kind, address, row.operator_id);
  },

  log: { info: (m) => log.info(m), error: (m, e) => log.error(m, e) },
};

/** Is this ntfy notification topic the one sealed in that operator's config? */
function ntfyAddressBelongsTo(operatorId: string, address: string): boolean {
  const row = db
    .query("SELECT secret_enc FROM approval_channel_secrets WHERE operator_id = ? AND kind = 'ntfy'")
    .get(operatorId) as { secret_enc: string } | null;
  if (!row) return false;
  const plain = openSecret(secretKey, row.secret_enc);
  if (!plain) return false;
  const config = parseNtfyConfig(plain);
  return !!config && config.topic_notif === address;
}

/**
 * Approval a Telegram reply-to refers to.
 *
 * Joined on the ADDRESS rather than on one resolved binding id: with two
 * operators sharing a chat, the copy was recorded under whichever of them owns
 * the request, and pinning a single binding would have found only half of them.
 * This only says which approval the message is about — whether the sender may
 * answer it is decided by `onAnswer`.
 */
function approvalForPostedMessage(kind: ChannelKind, address: string, externalRef: string): string | null {
  const row = db
    .query(
      `SELECT p.approval_id FROM approval_posts p
         JOIN approval_channels c ON c.id = p.binding_id
        WHERE p.kind = ? AND p.external_ref = ? AND c.address = ? AND c.enabled = 1`
    )
    .get(kind, externalRef, address) as { approval_id: string } | null;
  return row?.approval_id ?? null;
}

/**
 * Keyed by transport, not operator: two operators may legitimately share one
 * bot token, and some transports allow only one live consumer per token, so
 * identical configuration means one gateway instance registered under both
 * operators' slots.
 * The key is a digest of the sealed secret's plaintext, never the plaintext
 * itself -- for a config-keyed transport that's the whole config, so two
 * operators sharing an account still get their own gateway for their own
 * topics.
 */
interface LiveGateway {
  channel: NotificationChannel;
  /** Bot username / relay host, as `describe()` reported it. */
  label: string;
  appId?: string;
}
const liveGateways = new Map<string, LiveGateway>();

function gatewayKey(kind: ChannelKind, secretPlain: string): string {
  return `${kind}:${createHash("sha256").update(secretPlain).digest("hex")}`;
}

/** Forget the gateway table entry, if this instance is the one recorded. */
function dropGateway(channel: NotificationChannel): void {
  for (const [key, live] of liveGateways) {
    if (live.channel === channel) liveGateways.delete(key);
  }
}

/**
 * Release one operator's claim on a gateway, stopping it only when nobody else
 * holds it. Disconnecting one operator must not cut another operator's bot.
 */
async function releaseChannel(operatorId: string, kind: ChannelKind): Promise<void> {
  const { channel, orphaned } = notifyRegistry.unregister(operatorId, kind);
  if (!channel || !orphaned) return;
  dropGateway(channel);
  await channel.stop();
}

/** A gateway built and vetted, but not yet published to anyone. */
interface BuiltGateway {
  channel: NotificationChannel;
  label: string;
  appId?: string;
}

/**
 * Construct a gateway and ask the provider who we are.
 *
 * NO SIDE EFFECT ON FAILURE, and that is the point: the caller can vet a
 * candidate token while the operator's CURRENT channel keeps running, and only
 * swap once the new one is known good. Doing it the other way round meant a
 * typo'd address or a relay that happened to be down destroyed a working,
 * paired configuration.
 */
async function buildGateway(kind: ChannelKind, token: string): Promise<BuiltGateway | null> {
  if (kind === "telegram") {
    const channel = new TelegramChannel({
      token,
      host: channelHost,
      bindingFor: (address) => isPairedAddress("telegram", address),
      approvalForMessage: (address, ref) => approvalForPostedMessage("telegram", address, ref),
    });
    const me = await channel.describe();
    return me ? { channel, label: me.username } : null;
  }
  if (kind === "discord") {
    const channel = new DiscordChannel({
      token,
      host: channelHost,
      bindingFor: (address) => isPairedAddress("discord", address),
    });
    const me = await channel.describe();
    return me ? { channel, label: me.username, appId: me.id } : null;
  }
  if (kind === "ntfy") {
    const config = parseNtfyConfig(token);
    if (!config) {
      log.error("notify: ntfy config is unreadable — reconnect the channel");
      return null;
    }
    const channel = new NtfyChannel({
      config,
      host: channelHost,
      bindingFor: (address) => isPairedAddress("ntfy", address),
    });
    const me = await channel.describe();
    return me ? { channel, label: me.label } : null;
  }
  return null;
}

/**
 * Bring a gateway up for one operator and return the provider identity.
 *
 * `candidate` lets the enrolment route vet a token it has NOT yet persisted.
 * Without it the secret is read from the store, which is the boot path.
 *
 * Nothing the operator already has is touched until the new transport is
 * known good: the old gateway is released only after `buildGateway` succeeds.
 */
async function startChannel(
  operatorId: string,
  kind: ChannelKind,
  candidate?: string
): Promise<{ label: string; appId?: string } | null> {
  let token = candidate ?? "";
  if (!token) {
    const row = db
      .query("SELECT secret_enc FROM approval_channel_secrets WHERE operator_id = ? AND kind = ?")
      .get(operatorId, kind) as { secret_enc: string } | null;
    if (!row) return null;
    token = openSecret(secretKey, row.secret_enc) ?? "";
    if (!token) {
      log.error(`notify: ${kind} secret could not be decrypted — reconnect the channel`);
      return null;
    }
  }

  const key = gatewayKey(kind, token);
  const shared = liveGateways.get(key);
  // Presence in the table is the test, NOT `isReady()`. A Discord gateway
  // reports itself ready only once its socket reaches OPEN, and `start()`
  // merely kicks off the connect — so gating on readiness opened a SECOND
  // consumer on the same bot token whenever the first was still connecting or
  // inside its reconnect backoff, and the new one then overwrote the table
  // entry, leaving the first unreachable. The entry is removed exactly when the
  // gateway is stopped (`dropGateway`), which is the invariant that holds.
  if (shared) {
    // Already this operator's own gateway (a reconnect with an unchanged
    // token): releasing it here would stop the very thing we are about to
    // register, since they are its last holder.
    if (notifyRegistry.get(operatorId, kind) !== shared.channel) {
      await releaseChannel(operatorId, kind);
      notifyRegistry.register(operatorId, shared.channel);
      log.info(`notify: ${kind} gateway shared with another operator`);
    }
    return shared.appId ? { label: shared.label, appId: shared.appId } : { label: shared.label };
  }

  const built = await buildGateway(kind, token);
  if (!built) return null;

  // Only now is it safe to drop what the operator had: the replacement exists
  // and the provider has accepted it.
  await releaseChannel(operatorId, kind);
  built.channel.start();
  liveGateways.set(key, built);
  notifyRegistry.register(operatorId, built.channel);
  return built.appId ? { label: built.label, appId: built.appId } : { label: built.label };
}

/**
 * Re-read a sealed ntfy config. Validated rather than trusted: a config that
 * survived a schema change or a partial write must fail the channel, not build
 * a gateway that publishes to a topic named "undefined".
 */
function parseNtfyConfig(plain: string): NtfyConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as Record<string, unknown>;
  const server = normalizeNtfyServer(typeof c.server === "string" ? c.server : "");
  if (!server.ok) return null;
  const notif = String(c.topic_notif ?? "");
  const replies = String(c.topic_replies ?? "");
  if (!isValidTopic(notif) || !isValidTopic(replies) || notif === replies) return null;
  return {
    server: server.value,
    topic_notif: notif,
    topic_replies: replies,
    token: typeof c.token === "string" ? c.token : "",
  };
}

/** Bring back every configured gateway at boot. */
async function startConfiguredChannels(): Promise<void> {
  const rows = db
    .query("SELECT operator_id, kind FROM approval_channel_secrets")
    .all() as Array<{ operator_id: string; kind: string }>;
  for (const r of rows) {
    try {
      const me = await startChannel(r.operator_id, r.kind as ChannelKind);
      log.info(`notify: ${r.kind} ${me ? `started (@${me.label})` : "could not start"}`);
    } catch (e) {
      log.error(`notify: ${r.kind} failed to start`, e);
    }
  }
}
void startConfiguredChannels();

// Own timer rather than a call from purgeOldMessages(): that function is
// invoked at module load, BEFORE the const tunables above exist (temporal dead
// zone), so folding the sweep into it would crash the daemon at boot.
sweepApprovals();
guardedInterval("sweepApprovals", sweepApprovals, PURGE_INTERVAL_SEC * 1000);

/**
 * Deliberately not routed through the roadmap author resolver: that helper
 * answers 'who is the author', which legitimately includes a signed reserved
 * identity with no peers row and no project_key.
 * This handler needs a narrower answer -- which registered peer presents this
 * instance_token, and what is its own project_key -- and a signed-but-tokenless
 * caller has no answer to that by construction, so reusing the roadmap resolver
 * would either wrongly refuse every signed write or wrongly accept one with no
 * verifiable project.
 */
const graphDraftScopeDeps: GraphDraftScopeDeps = {
  findPeerByInstanceToken(token: string) {
    return db
      .query("SELECT peer_id, project_key FROM peers WHERE instance_token = ?")
      .get(token) as GraphDraftPeerRow | null;
  },
};

// Card 3781b033: closes the ROUTE, not the FAMILY. handleGraphDraftList,
// handleGraphDraftOpen and handleRoadmapList still trust their body's claims
// unproven -- see card c92614ed for the type-level closure across the
// family. This handler alone now derives project_key and from_peer from a
// proven instance_token via resolveProvenGraphDraftPeer (shared/graph-draft-
// scope.ts), instead of trusting the request body.
function handleGraphDraftAdd(
  body: GraphDraftAddRequest
): GraphDraftAddResponse | { error: string; status: number } {
  const peer = resolveProvenGraphDraftPeer(
    graphDraftScopeDeps,
    body,
    "/graph-draft/add",
    (message, meta) => log.warn(message, meta)
  );
  if (isGraphDraftAuthError(peer)) return peer;
  if (!peer.projectKey) {
    return {
      error: "this peer has no project_key on record; re-register with one before filing a graph draft",
      status: 401,
    };
  }
  const payload = validateDraftPayload(body);
  if ("error" in payload) return { error: payload.error, status: 400 };
  const draft: GraphDraft = {
    id: randomUUID(),
    project_key: peer.projectKey,
    from_peer: peer.peerId,
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

/**
 * Reuses the same peer resolver used elsewhere for identity, since project_key
 * and from_peer must come from the peers row, never the body, or a caller could
 * park a request against another project's queue.
 * Authorization is deliberately not widened: who may trigger a wave that
 * contains cards it didn't write is closed by visibility, not permission -- the
 * response names the cards dispatched and tiles hit, so a caller triggering
 * someone else's wave sees exactly that in its own reply.
 */
async function handleDispatchRequestAdd(
  body: DispatchRequestAddRequest
): Promise<DispatchRequestAddResponse | { error: string; status: number }> {
  const peer = resolveProvenGraphDraftPeer(
    graphDraftScopeDeps,
    body,
    "/dispatch-request/add",
    (message, meta) => log.warn(message, meta)
  );
  if (isGraphDraftAuthError(peer)) return peer;
  if (!peer.projectKey) {
    return {
      error: "this peer has no project_key on record; re-register with one before requesting a dispatch",
      status: 401,
    };
  }

  const row: DispatchRequestRow = {
    id: randomUUID(),
    project_key: peer.projectKey,
    from_peer: peer.peerId,
    status: "pending",
    created_at: new Date().toISOString(),
    resolved_at: null,
    outcome: null,
  };
  db.run(
    `INSERT INTO dispatch_requests (id, project_key, from_peer, status, created_at, resolved_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.project_key, row.from_peer, row.status, row.created_at, row.resolved_at, row.outcome]
  );

  const waitSec = Math.max(
    0,
    Math.min(DISPATCH_WAIT_MAX_SEC, Number.isFinite(body.wait_sec) ? Number(body.wait_sec) : 25)
  );
  if (waitSec === 0) return { request: rowToDispatchRequest(row) };

  return await new Promise<DispatchRequestAddResponse>((resolve) => {
    let done = false;
    const settle = (request: DispatchRequest): void => {
      if (done) return;
      done = true;
      const set = dispatchRequestWaiters.get(row.id);
      if (set) {
        set.delete(onResolved);
        if (set.size === 0) dispatchRequestWaiters.delete(row.id);
      }
      clearTimeout(timer);
      resolve({ request });
    };
    const onResolved = (request: DispatchRequest): void => settle(request);
    const timer = setTimeout(() => {
      // Re-read rather than settle on the in-memory `row`, which is a snapshot
      // taken at INSERT time and says "pending" forever. Today no resolve can
      // slip past us -- the INSERT, this executor and the set.add below all run
      // in ONE synchronous tick, so a waiter is always registered before the
      // event loop can serve /dispatch-request/resolve -- but that invariant is
      // a property of this function's current shape, not of the feature: a
      // future path that flips the row WITHOUT going through
      // resolveDispatchRequestWaiters would make the snapshot a lie. Reading
      // the durable row costs one query on the timeout path only, and makes the
      // answer correct by construction instead of by that invariant holding.
      const fresh = db
        .query("SELECT * FROM dispatch_requests WHERE id = ?")
        .get(row.id) as DispatchRequestRow | null;
      settle(rowToDispatchRequest(fresh ?? row));
    }, waitSec * 1000);
    // A long poll must never keep the process alive on its own.
    timer.unref?.();
    let set = dispatchRequestWaiters.get(row.id);
    if (!set) {
      set = new Set();
      dispatchRequestWaiters.set(row.id, set);
    }
    set.add(onResolved);
  });
}

/** The Deck's read: what is parked and waiting for it on this project. */
function handleDispatchRequestList(
  body: DispatchRequestListRequest
): DispatchRequestListResponse | { error: string; status: number } {
  if (!body.project_key || typeof body.project_key !== "string") {
    return { error: "project_key is required", status: 400 };
  }
  let sql = "SELECT * FROM dispatch_requests WHERE project_key = ?";
  if (!body.include_done) sql += " AND status = 'pending'";
  sql += " ORDER BY created_at, id";
  const rows = db.query(sql).all(body.project_key) as DispatchRequestRow[];
  return { requests: rows.map(rowToDispatchRequest) };
}

/**
 * Idempotent on an already-resolved row: the stored outcome is returned
 * unchanged rather than overwritten, so a retry after a lost response can't
 * replace a report the caller may already have read.
 * This route carries no per-caller proof -- any holder of the broker token can
 * post an outcome -- but that's bounded to lying to the requester: nothing here
 * dispatches anything, and the row's project_key/from_peer were fixed at
 * add-time from a proven peers row.
 */
function handleDispatchRequestResolve(
  body: DispatchRequestResolveRequest
): DispatchRequestResolveResponse | { error: string; status: number } {
  if (!body.id || typeof body.id !== "string") {
    return { error: "id is required", status: 400 };
  }
  const row = db
    .query("SELECT * FROM dispatch_requests WHERE id = ?")
    .get(body.id) as DispatchRequestRow | null;
  if (!row) return { error: "unknown dispatch request", status: 404 };
  if (row.status === "done") return { request: rowToDispatchRequest(row) };

  const outcome = sanitizeDispatchOutcome(body.outcome);
  const resolvedAt = new Date().toISOString();
  db.run("UPDATE dispatch_requests SET status = 'done', resolved_at = ?, outcome = ? WHERE id = ?", [
    resolvedAt,
    JSON.stringify(outcome),
    row.id,
  ]);
  const request = rowToDispatchRequest({
    ...row,
    status: "done",
    resolved_at: resolvedAt,
    outcome: JSON.stringify(outcome),
  });
  resolveDispatchRequestWaiters(request);
  return { request };
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
// The token is compared in constant time (M-SEC-1) to deny a timing oracle in HTTP mode.
function unauthorizedIfToken(req: Request): Response | null {
  if (!BROKER_TOKEN) return null;
  const auth = req.headers.get("Authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (safeEqual(provided, BROKER_TOKEN)) return null;
  return new Response("Unauthorized", { status: 401 });
}

// B2: reject cross-origin browser requests (CSRF / DNS-rebinding defense). Native
// clients (server.ts, the CLI) never send an `Origin` header, so this is
// transparent to them; a browser page always attaches Origin on a cross-origin
// call, so any request that carries one is refused unless it is an explicit
// loopback origin. This blocks a malicious web page from driving the broker
// (announce/admin/roadmap) without needing a Host allow-list that a 0.0.0.0 LAN
// bind cannot enumerate. Returns a 403 Response when the Origin is disallowed.
function forbiddenByOrigin(req: Request): Response | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null; // non-browser client (server.ts / CLI): no Origin
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return new Response("Forbidden origin", { status: 403 });
  }
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  return loopback ? null : new Response("Forbidden origin", { status: 403 });
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
      try { frame = JSON.parse(text); } catch {
        log.warn(`ws-auth: closed for an invalid (non-JSON) frame`);
        ws.close(1003, "invalid frame");
        return;
      }
      if (frame.type !== "auth" || !frame.instance_token) {
        log.warn(`ws-auth: closed for a missing or malformed auth frame`, { type: frame.type });
        ws.close(1008, "expected auth frame");
        return;
      }
      // Reuses the same predicate the HTTP routes already apply, rather than a
      // parallel WS-specific guard.
      // Client-visible outcome is identical to the unknown-token branch below
      // -- same close code, no differentiation -- only the server-side log
      // tells the two apart.
      // Compared against a strict not-null check, not truthiness: the helper's
      // contract is string-or-null, and this must keep refusing even if a
      // future refactor returns an empty string.
      if (refuseSentinelInstanceToken("ws-auth", frame.instance_token) !== null) {
        ws.close(1008, "unknown or inactive instance_token");
        return;
      }
      const ok = db.query(
        "SELECT group_id FROM peers WHERE instance_token = ? AND status = 'active'"
      ).get(frame.instance_token) as { group_id: string } | null;
      if (!ok) {
        log.warn(`ws-auth: closed for an unknown or inactive instance_token`, {
          instance_token: frame.instance_token.slice(0, 64),
        });
        ws.close(1008, "unknown or inactive instance_token");
        return;
      }
      ws.data.instance_token = frame.instance_token;
      wsPool.set(frame.instance_token, ws);
      flushPendingForToken(frame.instance_token, ok.group_id);
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
      const forbidden = forbiddenByOrigin(req);
      if (forbidden) return forbidden;
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
        return Response.json({
          status: "ok",
          peers: total,
          ws_clients: wsPool.size,
          mode: BROKER_MODE,
          // Only a replica has an upstream to be online against; on the other
          // modes the field is absent rather than a misleading `true`.
          ...(BROKER_MODE === "replica" ? { upstream_online: syncOnlineState === "online" } : {}),
        });
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
        // B1: even the admin dump never exposes routing tokens / PIDs.
        return Response.json(rows.map(toPublicPeer));
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
        const approvals = sweepApprovals();
        return Response.json({
          purged: result.messages,
          purged_drafts: result.drafts,
          expired_approvals: approvals.expired,
          purged_approvals: approvals.purged,
          cutoff_days: MESSAGE_TTL_DAYS,
          draft_cutoff_days: GRAPH_DRAFT_TTL_DAYS,
          approval_cutoff_days: APPROVAL_TTL_DAYS,
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
        case "/heartbeat": {
          const result = handleHeartbeat(body as HeartbeatRequest);
          if (result && "error" in result) return Response.json({ ok: false, error: result.error });
          return Response.json({ ok: true });
        }
        case "/set-summary": {
          const result = handleSetSummary(body as SetSummaryRequest);
          if (result && "error" in result) return Response.json({ ok: false, error: result.error });
          return Response.json({ ok: true });
        }
        case "/disconnect": {
          const result = handleDisconnect(body as DisconnectRequest);
          if (result && "error" in result) return Response.json({ ok: false, error: result.error });
          return Response.json({ ok: true });
        }
        case "/unregister": {
          const result = handleUnregister(body as UnregisterRequest);
          if (result && "error" in result) return Response.json({ ok: false, error: result.error });
          return Response.json({ ok: true });
        }
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
        case "/operator-inbox/purge": {
          const result = handleOperatorInboxPurge(body as OperatorInboxPurgeRequest);
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
          const result = handleRoadmapImport(
            body as { project_key?: string; items?: unknown; by?: unknown; instance_token?: unknown; force?: unknown }
          );
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
        case "/roadmap/lock-park": {
          const result = handleRoadmapLockPark(body as RoadmapLockParkRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/lock-release": {
          const result = handleRoadmapLockRelease(body as RoadmapLockReleaseRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/append-context": {
          const result = handleRoadmapContextAppend(body as RoadmapContextAppendRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/reorder": {
          const result = handleRoadmapReorder(body as RoadmapReorderRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/sync/pull": {
          const result = handleRoadmapSyncPull(body as RoadmapSyncPullRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/sync/push": {
          const result = handleRoadmapSyncPush(body as RoadmapSyncPushRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          // A refused push is not a request error: the body carries the
          // upstream row the replica needs to arbitrate against.
          if (!result.ok) return Response.json(result.conflict, { status: 409 });
          return Response.json(result.response);
        }
        case "/roadmap/sync/lock": {
          const result = handleRoadmapSyncLock(body as RoadmapSyncLockRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          if (!result.ok) return Response.json(result.contested, { status: 409 });
          return Response.json("claim" in result ? result.claim : result.release);
        }
        case "/roadmap/sync/status":
          return Response.json(handleRoadmapSyncStatus());
        case "/roadmap/sync/conflicts": {
          const result = handleRoadmapSyncConflicts(body as RoadmapSyncConflictsRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/roadmap/sync/resolve": {
          const result = handleRoadmapSyncResolve(body as RoadmapSyncResolveRequest);
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
        case "/approval/add": {
          const result = handleApprovalAdd(body as ApprovalAddRequest & Record<string, unknown>);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/wait": {
          const result = await handleApprovalWait(body as ApprovalWaitRequest & Record<string, unknown>);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/claim": {
          const result = handleApprovalClaim(body as ApprovalClaimRequest & Record<string, unknown>);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/list": {
          const result = handleApprovalList(body as ApprovalListRequest & Record<string, unknown>);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/delivered": {
          const result = handleApprovalDelivered(body as ApprovalDeliveredRequest & Record<string, unknown>);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/channel-connect": {
          const result = await handleChannelConnect(body as Record<string, unknown>);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/channel-disconnect": {
          const result = await handleChannelDisconnect(body as Record<string, unknown>);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/channel-list": {
          const result = handleChannelList(body as Record<string, unknown>);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/token-mint": {
          const result = handleApprovalTokenMint(body as ApprovalTokenMintRequest & Record<string, unknown>);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/token-revoke": {
          const result = handleApprovalTokenRevoke(body as ApprovalTokenRevokeRequest & Record<string, unknown>);
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
        case "/dispatch-request/add": {
          const result = await handleDispatchRequestAdd(body as DispatchRequestAddRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/dispatch-request/list": {
          const result = handleDispatchRequestList(body as DispatchRequestListRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/dispatch-request/resolve": {
          const result = handleDispatchRequestResolve(body as DispatchRequestResolveRequest);
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
  `mode=${BROKER_MODE}` +
  (BROKER_MODE === "replica" ? `, upstream=${UPSTREAM_URL}, sync_tick=${SYNC_TICK_MS}ms` : "") +
  `, auth=${BROKER_TOKEN ? "token" : "none"})`
);
