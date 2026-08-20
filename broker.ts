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
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./shared/config.ts";
import { createLogger, coreLogDir } from "./shared/logger.ts";
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
import { planRoadmapAppendText, ROADMAP_APPEND_RESULT_MAX_CHARS } from "./shared/roadmap-append.ts";
import {
  resolveRoadmapLock,
  refusesInactiveClaim,
  refusesInactiveToggle,
  refusesParkedArchive,
  isParked,
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
  stampInsert,
  assertStampSessionRef,
  isAuthError,
  type ApprovalScope,
} from "./shared/approval-scope.ts";
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
} from "./shared/types.ts";
import {
  DECK_INSTANCE_TOKEN,
  DECK_PEER_ID,
  OPERATOR_INSTANCE_TOKEN,
  OPERATOR_PEER_ID,
  RESERVED_PEER_IDS,
  ROADMAP_IMPORT_COLUMNS,
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

// Card 37a2b8c7 volet 4: single place deciding whether a group is exempt from
// the TOFU secret check. Previously this literal `groupId !== "default"` was
// copy-pasted in handleRegister, handleAnnounce and handleOperatorInbox --
// three independent editable copies of the SAME assumption ("'default'
// carries nothing confidential"). shared/config.ts only reflects that
// assumption on WELL-BEHAVED clients (it's client-side code the broker never
// runs); the broker itself imposes nothing, so a hostile POST can still
// declare group_id "default" with any hash it likes. isTofuExemptGroup's
// unconditional exemption is a deliberate broker-side choice, not something
// shared/config.ts enforces. This predicate is a pure extraction, not a
// behavior change: whichever of the three call sites needs a DIFFERENT rule
// changes THIS ONE FUNCTION, not three call sites. The arbitration it was
// waiting for (card 37a2b8c7 volet 1, the operator-inbox exposure) is SETTLED:
// the inbox is refused in an exempt group rather than authenticated there --
// see groupMayCarryOperatorInbox below, which derives from this predicate.
function isTofuExemptGroup(groupId: string): boolean {
  return groupId === "default";
}

/**
 * Card 37a2b8c7 volet 1 (operator arbitration of 2026-08-05, option d).
 *
 * A TOFU-exempt group pins no secret, so ANY holder of the shared BROKER_TOKEN
 * can name it and drain it. The operator inbox is the only CONFIDENTIAL payload
 * such a group can carry, and it cannot be authenticated without pinning a
 * secret -- which would destroy the zero-config rendezvous that makes the group
 * exempt in the first place. Exposure and feature are the SAME property here,
 * so the inbox is refused there instead of being authenticated: the assumption
 * "an exempt group carries nothing confidential" becomes TRUE BY CONSTRUCTION,
 * which is what makes handleRegister's and handleAnnounce's exemptions
 * legitimate rather than copies of a doubtful rule.
 *
 * COVERAGE. Both ends are refused (drain in handleOperatorInbox, deposit in
 * handleSendMessage): refusing only the drain would keep accepting a write
 * nobody will ever read -- a lying success. The predicate is DERIVED from
 * isTofuExemptGroup rather than re-testing "default", so a second exempt group
 * added later inherits both refusals instead of silently re-opening the hole;
 * the degradation that yields a subset (someone re-typing the literal at one of
 * the two sites) is what tests/broker-operator-inbox.test.ts pins.
 *
 * COST, deliberate: a bare-mode claude-peers user with no group secret loses a
 * documented capability (send_message to 'operator'). It was already inert
 * there -- the core ships no consumer for that inbox, so the message sat
 * delivered=0 forever. The refusal makes the existing silence explicit.
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
 * Whether `groupId` has ever registered (a row in `groups`, pinned by the
 * `INSERT INTO groups` in the /register handler on first sight).
 * checkGroupSecret authorises an ACTION inside a group;
 * it never attests the group EXISTS -- for a never-seen group `existing` is
 * null above, so there is nothing to compare and TOFU accepts the unknown.
 *
 * Every older caller of checkGroupSecret (/announce, /operator-inbox's
 * legacy drain) got away without this because their writes/reads sit behind
 * `WHERE group_id = ?` on `peers` or `messages` -- tables an unknown group
 * can never have populated, so it is always the empty set there. Courrier's
 * operator_inbox_sessions is the first table where a caller-supplied
 * group_id is the write's ONLY anchor (INSERT on /operator-inbox's cursor
 * path, DELETE with no other scoping column on /operator-inbox/purge's GC).
 * Any route in that shape must call this BEFORE writing (card 1e81ee7b
 * MAJOR 5 / part 4) -- see its two call sites in handleOperatorInbox and
 * handleOperatorInboxPurge, which are what actually enforce this.
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
    FOREIGN KEY (instance_token) REFERENCES peers(instance_token)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON peer_sessions(group_id, host, cwd)`);

// Courrier lot 1A (desktop/docs/design-courrier-lot1.md section 6.1, card
// 54b1c71a). One row per Deck LAUNCH, minted in-memory and never persisted
// Deck-side (that's the whole point: the cursor's lifetime IS the session's
// lifetime). Keyed by session_id, NOT group_id or operator_id -- see the
// design doc section 3 for why those two are the wrong axis (operator_id is
// deliberately copied across a person's machines, so it would let two Decks
// of the same human steal each other's Courrier, exactly the bug this closes).
// Composite PK (session_id, group_id): a session_id that later polls under a
// DIFFERENT group_id gets its OWN row instead of silently keeping the
// original group on an ON CONFLICT update (card 1e81ee7b MAJOR 1). This
// removes the "group changed" case rather than tracking it -- there is no
// branch left that needs one. It does NOT by itself scope reads/writes to
// the CALLER's group: every statement below still carries its own explicit
// `group_id = ?`, which is what actually stops a cross-group cursor bump or
// GC (see the blockers this table's statements fix, further down).
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
    queue INTEGER,
    directive TEXT,
    target_peer_ids TEXT NOT NULL DEFAULT '[]'
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

// --- Remote approvals (PLAN-notifications-mobiles N1) ---
// An agent hits a blocking question; it is parked here until SOMEONE answers:
// the Deck, or a notification channel on the operator's phone. Durability is
// the graph_drafts model (no FK, plain-text snapshots, status flips, listing
// non-destructive) — a broker or Deck restart never loses a pending approval.
//
// IDENTITY: `operator_id` is a NEW axis, orthogonal to peers/groups. It names a
// PERSON, which `host` cannot: two OS accounts on one machine share a hostname
// but must never see each other's approvals.
//
// Only PUBLIC keys are stored. `operator_id` is a digest of the public key, so
// the binding is self-certifying: presenting a different key for a known id
// would require a hash collision, and reading this database grants no ability
// to impersonate anyone.
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

// Card 1def56da, and this migration is a DECISION rather than a cleanup.
//
// `project_key` is `NOT NULL DEFAULT ''`, so every row written before card
// 4df14b5b carries the empty string. Once the scope clause becomes mandatory on
// all four handlers, '' compares as an ORDINARY VALUE -- never as a wildcard,
// because a wildcard would be the cross-project leak written by our own hand.
// The consequence is that those rows become addressable by nobody: no live
// caller can present '' as its project, so they could never again be answered
// nor marked delivered, and they would sit `pending` forever with nothing
// saying why.
//
// `abandoned` is the honest status for them, and it is the status's own
// definition (shared/types.ts: "the producer gave up, session closed, host
// gone"): a question raised before project scoping has no living producer that
// can claim its project. Both reader sides were VERIFIED rather than assumed,
// because this is the FIRST producer of `abandoned` in the codebase -- the Deck
// asks /approval/list for `pending` and `expired_notif` by name
// (desktop/src/main/approval-service.ts, fetchPendingApprovals), so these rows
// stop being offered; and `sweepApprovals` below already collects `abandoned`
// alongside `answered` after APPROVAL_TTL_DAYS, so they are reclaimed rather
// than accumulating.
//
// Idempotent by its own WHERE: rows already moved no longer match `pending`.
// Measured on the machine this shipped from: 0 rows in `pending_approvals`
// total, so this migration is a no-op here and its proof lives in a seeded
// fixture, not in the live database.
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
  // Card aaf4537d: `lock_parked_at`/`lock_parked_by` are nulled
  // unconditionally by every clause below -- harmless on clauses 1/2 (they
  // only ever match a row where `lock_parked_at IS NULL` to begin with, see
  // their prefix) and required on clause 3 (the sweep that actually clears
  // an expired park). One SET list shared by all three keeps that in sync.
  const release = (where: string, params: string[]): void => {
    db.run(
      `UPDATE roadmap_items SET
         locked = 0, locked_by = NULL, locked_at = NULL, operator_id = NULL,
         lock_parked_at = NULL, lock_parked_by = NULL,
         status = CASE WHEN status = 'in_progress' THEN 'planned' ELSE status END,
         updated_by = 'lock-sweep', updated_at = datetime('now')
       WHERE locked = 1 AND ${where}`,
      params
    );
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
  // Owner gone: no peer for this locked_by/project_key has been seen (an
  // active row, OR a dormant row whose `peers.last_seen` is still within
  // LOCK_GRACE_SEC) for this project. Card 399aa31a (team-lead arbitration,
  // 2026-08-12): grace is anchored on `peers.last_seen` -- the owner's last
  // real heartbeat/activity -- not on `locked_at` (when the lock was TAKEN).
  // The old anchor gave zero effective grace to any lock held longer than
  // LOCK_GRACE_SEC (the common case): the instant the owner's row left
  // 'active', the very next sweep stripped it. `sweepInactivePeers` only
  // ever rewrites `status`, never `last_seen`, so this anchor can only ever
  // ADD grace versus wall-clock disconnect time (bounded by
  // ACTIVE_STALE_SEC + the sweep's own cadence), never subtract it -- the
  // safe failure direction for a mechanism that strips work from an agent.
  // Operator ruling (Card fc444eda, 2026-08-11): project_key alone scopes
  // liveness (group_id stays out by design, decision of e7b364dc), and a
  // NULL project_key is a value in its own right, not a wildcard -- a
  // project-less peer is only "live" for project-less cards. `IS` is
  // SQLite's NULL-safe equality (column-to-column too): `NULL IS NULL` is
  // true, unlike `=` where `NULL = NULL` is NULL/false, which would have
  // stripped a project-less peer of even its own project-less locks.
  // Card aaf4537d: same park-immunity prefix as clause 1 -- a paused agent's
  // peer legitimately going inactive (or its session exiting) must not
  // strip a park the operator deliberately granted.
  release(
    `lock_parked_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM peers p
       WHERE p.peer_id = roadmap_items.locked_by
         AND p.project_key IS roadmap_items.project_key
         AND (p.status = 'active' OR datetime(p.last_seen) >= datetime('now', ?))
     )`,
    [`-${LOCK_GRACE_SEC} seconds`]
  );
  // Card aaf4537d, clause 3 (team-lead correction, 2026-08-12): the park
  // itself expires -- a card parked more than LOCK_PARK_TTL_SEC ago is swept
  // like any other stale lock, even if its `updated_at` was refreshed by a
  // permitted ordinary edit in the meantime and its owner peer is still
  // alive (neither clause 1 nor clause 2 above would ever catch that row on
  // their own; this is the exact hole the arbitration exists to close).
  release(`lock_parked_at IS NOT NULL AND datetime(lock_parked_at) < datetime('now', ?)`, [
    `-${LOCK_PARK_TTL_SEC} seconds`,
  ]);
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

// Ordered by id, not sent_at: same latent bug class as ackPriorMessagesForSender
// below (sent_at is millisecond-resolution and two sends on a fast local
// broker regularly tie within the same millisecond). ORDER BY sent_at, id
// (not id alone): sent_at stays the PRIMARY key so the intended chronological
// order is preserved -- id only breaks a genuine sent_at TIE. In real traffic
// the two are always monotonically correlated (recordMessageTx assigns both
// in the same transaction), so this composite key changes nothing there; it
// matters for tests that seed historical sent_at values directly (e.g.
// tests/broker-flush-cap.test.ts's insertMessageAt helper inserts rows with
// sent_at older than their id to simulate a time window), where a plain
// ORDER BY id would silently invert the intended recency order. Kleos:
// koryphaios card 82e3d293, follow-up to cf4af14d/commit 53526ca.
const selectUndelivered = db.prepare(
  `SELECT * FROM messages WHERE to_token = ? AND delivered = 0 ORDER BY sent_at ASC, id ASC`
);

// Capped variant used only by flushPendingForToken to avoid replaying the entire
// backlog at every WS reconnect. /poll-messages and /peek-messages keep using the
// uncapped selectUndelivered so an explicit check_messages still returns everything.
// The sent_at > datetime('now', ?) filter is a coarse time WINDOW (like the TTL
// purge below), not a same-millisecond comparison, so it stays on sent_at --
// only the ORDER BY clauses gain the id tiebreaker, same reasoning as above.
//
// Card 1d9f25e5: takes group_id, unlike selectUndelivered above. Both queries
// answer the same "pending messages for a to_token" question handleOperatorInbox
// answers too, and that handler filters `m.group_id = ?` -- this one did not,
// which is the defect this card fixes. Today the gap is inert (to_token
// references peers.instance_token, which IS the PRIMARY KEY there, and
// ordinary tokens are randomUUID(), so no ordinary token is ever shared
// across two groups; the only shared to_token values are
// the sentinel constants, and card 78bf378d already refuses a sentinel-shaped
// token at the ws-auth handshake before flushPendingForToken ever runs) -- but
// that is a precondition of DB state and WS-auth code elsewhere, not a rule
// this query itself enforces, so it stays a defense-in-depth fix rather than a
// "leave it, it's unreachable" no-op. selectUndelivered above is NOT given the
// same treatment: its two callers (handlePollMessages, handlePeekMessages)
// already refuse a sentinel-shaped instance_token by shape (card 37a2b8c7)
// before the query runs, which closes the same gap the same way, so adding an
// unused parameter there would be scope creep with nothing left to guard.
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

// Heuristic ack: when a peer sends a message in a group, it has necessarily
// processed the messages addressed to it in that same group before sent_at.
// Promoting those to delivered=1 prevents the flushPendingForToken avalanche
// at the next WS reconnect for bidirectional conversations.
// Ordered by the AUTOINCREMENT row id, not sent_at: sent_at is a millisecond-
// resolution ISO string, and two sends on a fast local broker can complete
// within the same millisecond, tying (or even inverting) their sent_at
// values -- a strict 'sent_at < ?' then misses a message that was in fact
// inserted earlier. The row id is assigned strictly in insertion order
// within the same db.transaction, so it stays a correct ordering key
// regardless of clock resolution.
// id ALONE here, not the "sent_at, id" composite used by selectUndelivered /
// selectUndeliveredCapped above: this is a deliberate asymmetry, not a missed
// harmonization -- do not "fix" it to match. The two queries answer different
// questions. This one is a CUTOFF on a happens-before/insertion relation
// ("what was inserted before this message"), which needs a total, tie-free
// order -- id is exactly that; adding sent_at here would reintroduce this
// same flaky-ack bug. selectUndelivered is an ORDER BY / recency WINDOW on
// content time ("present in what order, and which N are most recent"), where
// sent_at is the business-meaningful key and id only breaks a genuine tie;
// using plain id there breaks tests/broker-flush-cap.test.ts's recency-cap
// semantics (its fixture seeds sent_at out of step with id). Kleos: koryphaios
// card 82e3d293, commit 31fe49b.
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

// --- Roadmap handlers (v0.4, PLAN C3) ---

const ROADMAP_KINDS: readonly RoadmapKind[] = ["feature", "bug", "debt", "idea", "chore", "directive"];
const DIRECTIVE_COMMANDS: readonly RoadmapDirective[] = ["clear", "compact", "magic_compact"];
const MAX_DIRECTIVE_TARGETS = 16;
// Round-3 mutation review (card aaf4537d): lock-park/lock-release must not
// share MAX_DIRECTIVE_TARGETS -- their batch is Hard Stop's "every live tile
// in this Deck", a materially different population from a directive card's
// hand-picked target list, and cleanPeerIds's own truncation silently
// dropped the tail with no signal (measured: 20 peer_ids in, 16 parked, 0
// failed, the remaining 4 read by the caller as "nothing to do"). Sized
// against a MEASURED real fleet, not guessed: this exact broker, right now,
// carries 12 concurrently-registered peers in the koryphaios group alone
// (`bun cli.ts peers`, one operator's own heavy multi-session dev workflow)
// and 24 total across every group it serves -- a single Deck's tile count is
// bounded further still by one PTY + one webContents per tile, so 64 stays
// generous above any observed real batch while remaining a real, enforced
// ceiling rather than no bound at all.
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
  "tags" | "depends_on" | "locked" | "target_peer_ids" | "operator_id" | "inactive"
> & {
  tags: string;
  depends_on: string;
  locked: number;
  target_peer_ids: string;
  // NULLable column (no DEFAULT), unlike RoadmapItem.operator_id?: string --
  // bun:sqlite hands back NULL as null, not undefined.
  operator_id: string | null;
  inactive: number;
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
    directive: row.directive ?? null,
    // Legacy rows created before the migration have NULL here; default to [].
    target_peer_ids: row.target_peer_ids ? parseList(row.target_peer_ids) : [],
    // string|null (SQLite) -> string|undefined (RoadmapItem's optional field).
    operator_id: row.operator_id ?? undefined,
    inactive: row.inactive === 1,
  };
}

/** Sanitize an optional string[] payload into a JSON-storable list. */
function cleanList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

/**
 * Sanitize a directive card's target_peer_ids (CT1): keep only well-formed,
 * non-reserved peer_ids (same charset as set_id), deduped and capped. A field
 * crossing the broker HTTP boundary is never trusted verbatim -- the Deck
 * re-validates it again before it ever reaches a PTY (three-hostile-inputs #2).
 */
/**
 * Card 8c1effca: resolve ONE text column of an imported item.
 *
 * `undefined` means the file never mentioned the column, so the existing row
 * wins (or "" for a brand-new card). Anything else means the file DID mention
 * it: a string is taken as-is, and an explicit null (or any non-string) clears
 * the column, because a self-export must still be able to blank a field.
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
  const row = db.query("SELECT * FROM roadmap_items WHERE id = ?").get(id) as RoadmapRow | null;
  return row ? rowToRoadmapItem(row) : null;
}

/**
 * Roadmap card 39c40571, layer 1: resolve WHO is writing, instead of believing
 * the `by` string the body happens to carry.
 *
 * Before this, `by` was free text recouped against nothing, while every agent
 * holds the shared broker token -- so any of them could write under another
 * peer's identity, or claim the operator's 'deck' author to walk through the
 * work-lock guard.
 *
 * The rule resolves the OBJECT (the claimed author) before asking whether the
 * caller may act as it:
 *  - a presented instance_token WINS over `by`, so the recorded author is the
 *    peer the token actually belongs to;
 *  - a SENTINEL token is refused: those values are public constants, so
 *    presenting one is an escalation attempt, not a credential;
 *  - with no token, the write may only claim a name that belongs to NO real
 *    peer -- cli.ts, test fixtures, and 'deck' (whose row carries a sentinel
 *    token, hence is not a real peer). Closing that last case means making the
 *    Deck sign with the operator credential, which is layer 2.
 *
 * `proven` is what a caller-sensitive rule keys on (currently `force`).
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
}

/**
 * Card ad6aa6ed: shared lowercase+charset normalization for any author-
 * identity FIELD, not just the `by` claim resolveRoadmapAuthor validates
 * below -- also used for `locked_by` on /roadmap/import
 * (handleRoadmapImport), the one other place a caller-supplied string
 * becomes an author-identity column without passing through
 * resolveRoadmapAuthor itself. Extracted so the two call sites cannot drift:
 * the [a-z0-9:_-] charset the long comment below justifies (case/homoglyph/
 * invisible-character/header-forgery closure, measured against live data)
 * applies here without restating the justification a second time and
 * risking the two going out of sync.
 *
 * Returns the offending CHARACTER on failure, never the value: the caller
 * already knows what it sent, and the error text a caller receives (via
 * resolveRoadmapAuthor, and via handleRoadmapImport's per-item validation)
 * can end up in an LLM-facing tool-error context through roadmapToolError,
 * where replaying a hostile string back gains nothing (reviewer NIT, card
 * ad6aa6ed). Server-side logging at each call site keeps the full raw value
 * for operator audit -- that sink is not LLM-facing.
 *
 * REFUSES THE EMPTY STRING (review delta, card ad6aa6ed): the old inline
 * regex this replaced was `/^[a-z0-9:_-]+$/`, whose `+` already rejected "".
 * A version that only searches for a DISALLOWED character has none to find
 * in an empty string and would silently return ok:true, value:"" --
 * unreachable on the `by` path (empty already refused earlier in
 * resolveRoadmapAuthor) but real on the `locked_by` import path, where an
 * empty lock owner would land and then never equal any real `by`, defeating
 * the `by !== existing.locked_by` lock-owner comparison for that row
 * permanently. Written here explicitly so a THIRD future call site does not
 * have to rediscover this the same way.
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

  // Card ad6aa6ed: normalize BEFORE any comparison, not just at the reserved-
  // name check. `by` is free text by design (any agent may claim any
  // peer_id, proven or not) so it never traversed PEER_ID_REGEX/sanitize()
  // the way a real peer_id does -- measured to be the ONLY one of
  // RESERVED_PEER_IDS' five runtime consumers without that shared format
  // gate (deriveDefaultId, handleSetId, cleanPeerIds and the resolved-
  // instance_token branch below all inherit lowercase-only as a SIDE EFFECT
  // of it; this claimed-name branch inherited nothing). A by:'Deck' therefore
  // fell through the reserved check below as an ordinary unproven author.
  //
  // A bare .toLowerCase() would close that CASE bypass and stop there, which
  // is not enough: measured that sanitize() does far more than fold case
  // (collapses every char outside [a-z0-9-] to a hyphen), and a fix that
  // only touched case would still let a homoglyph ('dеck', Cyrillic е) or an
  // invisible character ('deck​') through, DISPLAYED as 'deck' to the
  // operator -- the exact attribution-forgery this exists to close. So this
  // rejects on SHAPE, not just case: lowercase, then anything outside
  // [a-z0-9:_-] is refused closed (400), never silently stripped.
  //
  // Applied to what gets STORED, not only what gets compared here: closes
  // the unproven-claim registered-peer lookup a few lines below in this same
  // function (was case-sensitive against the same raw value). The sibling
  // `by !== existing.locked_by` lock-owner comparison in handleRoadmapUpsert
  // is closed too, but NOT by this function alone: `locked_by` also reaches
  // storage through handleRoadmapImport, which normalizes it separately with
  // the SAME normalizeAuthorIdentity() helper this function calls (review
  // finding, card ad6aa6ed: `created_by`/`updated_by` went through this
  // resolver on that route, `locked_by` did not, and it is a field the
  // rendered `locked: by X since ...` line in roadmap_get DISPLAYS verbatim
  // -- same forgery class as the header attack below, on a different field).
  //
  // Guarantee overall is scoped to authors CLAIMED BY A CALLER, normalized
  // through normalizeAuthorIdentity() at one of ITS call sites -- 'lock-sweep'
  // (broker.ts, the lock-expiry sweep) writes `updated_by` directly in SQL, a
  // hardcoded constant that never reaches either call site; harmless (never
  // externally influenced) but outside what this validation can promise.
  // Also NOT covered: handleGraphDraftAdd's `from_peer: body.by.slice(0,128)`
  // (broker.ts, a different table) -- same class of unvalidated author
  // identity, named here rather than fixed, out of this card's scope.
  //
  // Charset picked from live data, not invented: `bun cli.ts roadmap-export`
  // on this project's roadmap (107 items, 15 distinct created_by/updated_by/
  // locked_by values -- 'deck', bare peer_ids, and three 'cli:<peer_id>'
  // forms) shows zero values outside [a-z0-9:_-] today, so nothing legitimate
  // in THIS project's corpus is rejected. Scoped measurement, not a global
  // one: a legitimate author on a DIFFERENT project_key carrying a character
  // outside this set would now be refused -- fails closed, visible the same
  // day, remedy is widening the allowlist, but the next reader should not
  // read "zero legitimate author falls" as verified beyond this one project.
  //
  // Also forecloses, by construction, a forgery class for card 562fd9b5
  // (append-mode context blocks, route not yet written): an append header
  // built from this same `by` could otherwise embed
  // "x >>>\n\ntext\n\n<<< append 2020-01-01T00:00:00Z by deck" and fabricate a
  // complete fake block inside a real one, attributed to the operator, which
  // a future parser would render as a legitimate entry. Space, '>' and
  // newline are all outside the allowlist, so that payload is refused before
  // the append route exists to build it -- and because the check lives
  // INSIDE this resolver rather than at each call site, that future handler
  // cannot construct an unvalidated header without explicitly bypassing this
  // function (CLAUDE.md: a new validator needs every call path enumerated --
  // the path that does not exist yet is the one a call-site check would have
  // missed).
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

  // Card 39c40571 LAYER 2: the one author layer 1 still took on faith.
  //
  // 'deck' names the OPERATOR, and `proven` is what walks the work-lock guard,
  // so an unproven claim to it edits the backlog as the human and takes locks
  // held by agents. The Deck now SIGNS with the operator credential (Ed25519,
  // operator_id = digest of the public key, so it is self-certifying).
  //
  // FIRST, and that ORDER is the guard, not a style choice. Shipped once with
  // this block placed after the instance_token branch below, and it was
  // bypassable in three requests with no signature at all: /register with
  // host:'deck' mints a peer literally named 'deck' holding a REAL token, the
  // token branch resolves it to {by:'deck', proven:true} and returns before
  // this block is ever consulted. The name decides which rule applies, so the
  // name must be tested before any credential is honoured. The Deck itself is
  // unaffected: it sends a signature and no token at all (no instance_token
  // anywhere in desktop/src/main/roadmap-service.ts).
  //
  // Routed through resolveApprovalAuth rather than verified here, so this path
  // inherits the signature check, the nonce REPLAY guard and the operation
  // table in one move. 'roadmap-write' is deliberately absent from
  // SESSION_ALLOWED: a sandboxed agent holding a session token gets 403 from
  // that table, not from a rule re-typed here.
  // Review follow-up: the branch is keyed on the reserved SET, not on the one
  // literal that happened to be exploitable. Measured before widening:
  // `by:'operator'` and `by:'system'` were accepted unsigned, 200, and the card
  // then displayed `created_by: "operator"`. No privilege rode on them today
  // (the lock exemption tests `by !== "deck"` and `proven` stayed false), so the
  // cost was attribution theft rather than escalation -- but all three names
  // designate the human, so all three now demand the operator signature. Keying
  // on the set also means a fourth reserved name inherits this without anyone
  // remembering to come back here.
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
    const owner = db
      .query("SELECT peer_id FROM peers WHERE instance_token = ?")
      .get(token) as { peer_id: string } | null;
    if (!owner) {
      log.warn(`${route}: refused an unknown instance_token`, { claimed_by: by });
      return { error: "unknown instance_token", status: 401 };
    }
    // The RESOLVED name is checked too, not just the claimed one. A row named
    // after a reserved identity can no longer be minted (deriveDefaultId now
    // consults RESERVED_PEER_IDS), but rows created BEFORE that fix still exist
    // in live databases, and this branch would hand one of them a proven
    // 'deck' authorship on the strength of its own token. Migration case: the
    // mint-time refusal cannot reach backwards, this can.
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
    return { by: owner.peer_id, proven: true };
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
 * Dynamic values (unlike the fixed kind/status/priority/effort/value enums):
 * the tags that actually occur ANYWHERE in this project, archived cards
 * included -- unconditionally, no `includeArchived` parameter, on purpose
 * (review round 2, point 3). This backs ONLY the "unknown tag" 400 error's
 * actionable listing (the tags facet's own counts are computed separately in
 * computeRoadmapFacets, which does respect `include_archived` since a facet
 * count is meant to describe the current view). Validation must not: a tag
 * that survives only on cards archived in a later pass would otherwise 400
 * for a caller whose `include_archived` happens to be false that request --
 * a routine occurrence, not a rare edge case, the moment `done` cards get
 * archived en masse and take their only tags with them.
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

  // Unknown filter value = error, never zero results (decision 6): a typo in
  // a free-form tag must not read back as "no such card", a silent false
  // negative. Enums are validated above against a fixed list; tags are
  // dynamic, so the actionable list in the error is computed here.
  //
  // Review round 2 (2026-08-10), MAJOR (point 3): the reference set here is
  // ALWAYS the full project, archived included, independent of this
  // request's own `include_archived` -- validating against the (possibly
  // narrower) filtered reference set turned a tag that only survives on
  // archived cards into a false-positive 400 the moment `include_archived`
  // was false, and this goes from a rare edge case to routine the moment a
  // pass of `done` cards gets archived and takes their only tags with them.
  // Team-lead's explicit call: legacy singular `tag` gets the same 400 as
  // plural `tags` (one engine, one semantics, no external users pre-1.0) --
  // this fix is about WHICH reference set validates both, not about
  // softening either.
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

  // Review round 2 (2026-08-10), MAJOR (point A1): the card's short id (shown
  // on every board tile, RoadmapItemId) is in NO FTS column -- title,
  // description, tags, rationale, context. Typing it into the search box
  // (the operator's obvious move, since that id is what the screen shows)
  // measured a false positive: the query rewards a card that merely MENTIONS
  // the id in its text over the card whose id it actually IS, because only
  // the mention lives in an indexed column. Do NOT index `id` into
  // roadmap_fts either -- FTS5's tokenizer would split a hex/uuid string into
  // fragments and return unrelated partial matches, an even worse failure
  // mode. Instead: an exact, bounded `id LIKE '<prefix>%'` predicate, ORed
  // with the FTS branch so neither can mask the other's hit. Threshold >= 4
  // hex characters (team-lead's call) -- short enough to catch the 8-char
  // short id, long enough that an ordinary word rarely qualifies by accident,
  // and a false-positive OR only ever ADDS a row, never hides one.
  const qTrimmed = body.q?.trim();
  const idPrefix = qTrimmed && /^[0-9a-f]{4,}$/i.test(qTrimmed) ? qTrimmed : null;

  // Guard #3b: every FTS-joined query re-asserts project_key itself -- the
  // roadmap_fts table has no project scoping of its own (one row per card
  // across ALL projects), so a MATCH without this join+filter leaks cards
  // from other projects (measured, see tests/broker-roadmap-search.test.ts).
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
    // `author.operator_id !== undefined` (mirrored at the create/import call
    // sites below) is deliberately NOT `by === "deck"`: today the two are
    // equivalent in practice (operator_id is only ever produced by the
    // reserved-peer-name branch of resolveRoadmapAuthor, and an unsigned
    // `by: "deck"` is refused 401 upstream, so no test currently
    // distinguishes them -- confirmed by mutation, 2026-08-12). The
    // `operator_id` form is the one that stays correct if a future
    // deck-signed path is ever added that does NOT populate operator_id: the
    // `by === "deck"` form would silently start accepting an unsigned toggle
    // that day, with nothing here turning red to say so.
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
      // Card e7b364dc Part B: this used to be an enumerated OR-list of body
      // FIELD NAMES (`body.status !== undefined || body.locked !== undefined`)
      // -- structurally fail-open, since any future RoadmapUpsertRequest field
      // that also moves the lock would need manual addition here or slip
      // through unguarded (the exact defect family that produced this card's
      // original bug: the guard checked `body.locked === true` while the
      // resolution below honoured `body.locked !== undefined`, two readings of
      // the same body drifting apart). Replaced by an EFFECT check: does the
      // already-resolved lock outcome actually differ from `existing`? Plus
      // `body.status !== undefined` MUST survive on its own -- a same-status
      // in_progress write from an intruder resolves to zero delta (the lock
      // was already theirs to keep) yet is still an attempted claim and must
      // still 409.
      (body.status !== undefined ||
        resolvedLock.locked !== existing.locked ||
        resolvedLock.lockedBy !== existing.locked_by) &&
      by !== existing.locked_by &&
      by !== "deck" &&
      // Card 39c40571 layer 1: `force` is a claim of certainty, so it is only
      // honoured for a caller that PROVED who it is -- an anonymous body could
      // otherwise steal any locked item by adding one field. This closes the
      // `force` route only: the `by !== "deck"` clause four lines up still lets
      // an unproven body walk this guard by simply claiming `by: 'deck'`, since
      // the Deck's row carries a sentinel token and `resolveRoadmapAuthor` lets
      // any name through that belongs to no real peer. Closing THAT is layer 2
      // (the Deck signing with the operator credential).
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

    // resolvedLock was already computed above, before the guard -- this write
    // consumes that SAME object rather than resolving the lock a second time
    // (the two-readings-of-the-body drift is exactly what produced card
    // e7b364dc's original bug). A same-owner re-claim keeps locked_at.
    const isSameOwnerReclaim =
      resolvedLock.locked && existing.locked && existing.locked_by === resolvedLock.lockedBy;
    const keptLockedAt = isSameOwnerReclaim ? existing.locked_at : null;
    // Card aaf4537d, DELTA (round-3 mutation review): the park is scoped to
    // the OPERATOR who parked it, never to the peer-lock reclaim question
    // above (isSameOwnerReclaim compares locked_by, a different actor
    // entirely). Conflating the two was the two-upsert service door: a
    // foreign, non-archiving write (nextStatus !== 'in_progress', so
    // isSameOwnerReclaim is false) silently nulled the park, and a SECOND
    // upsert with status='archived' then sailed through refusesParkedArchive
    // -- that guard only ever sees THIS call's own row state, it has no
    // memory of a park a prior write already erased. The park now survives
    // every write except two: the SAME operator who parked it touching the
    // card again (their own decision to reverse, same as a self-archive), or
    // a park that has already expired past LOCK_PARK_TTL_SEC (this only has
    // to agree with isParked's verdict for a row a write happens to touch;
    // releaseStaleLocks's SQL sweep is what clears an expired park on a row
    // nothing ever touches again).
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
         locked = ?, locked_by = ?,
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

  const id = randomUUID();
  db.run(
    `INSERT INTO roadmap_items
       (id, project_key, kind, title, description, rationale, context, priority, value,
        effort, status, tags, depends_on, created_by, updated_by,
        created_at, updated_at, deleted_at, queue, directive, target_peer_ids, locked, locked_by, locked_at,
        operator_id, inactive, lock_parked_at, lock_parked_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL, ?, ?, ?, ?, ?,
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

  // Same lock guard as upsert (PLAN K2): archiving is a status change.
  if (existing.locked && by !== existing.locked_by && by !== "deck") {
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
       locked = 0, locked_by = NULL, locked_at = NULL,
       operator_id = COALESCE(?, operator_id),
       lock_parked_at = NULL, lock_parked_by = NULL,
       updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [author.operator_id ?? null, by, body.id]
  );
  return { item: getRoadmapItem(body.id)! };
}

/**
 * Card aaf4537d, lot 1: parks the work-lock(s) currently held by each of
 * `peer_ids` under `project_key` -- the broker-side counterpart of the
 * desktop's Pause stop (`lockPark` in desktop/src/main/roadmap-service.ts,
 * wired ahead of this route landing). Operator-gated UNCONDITIONALLY, not
 * just when `by` happens to be a reserved name: this route acts on OTHER
 * agents' locks by construction (a peer never parks its own lock; the
 * operator does it on their behalf while pausing that agent's tile), so an
 * ordinary unproven agent write must be refused even though most other
 * roadmap routes would accept one. `lock_parked_by` is stamped with the
 * OPERATOR's `operator_id` (never `by`, never the target peer_id) -- see
 * `refusesParkedArchive`'s doc comment in shared/roadmap-lock.ts for why
 * that distinction matters.
 *
 * A peer_id with no currently-locked card under this project is a silent
 * no-op (absent from both `parked` and `failed`) -- team-lead arbitration:
 * `failed` is reserved for a genuine per-row write exception, since most
 * pause targets simply hold no lock and that must not read as an error.
 */
// Card c33a5968: no inactive guard here, deliberately -- this handler only
// ever writes lock_parked_at/lock_parked_by, never status or locked, so it
// structurally cannot claim a card toward in_progress/locked.
function handleRoadmapLockPark(
  body: RoadmapLockParkRequest
): RoadmapLockParkResponse | { error: string; status: number } {
  const author = resolveRoadmapAuthor(body, "/roadmap/lock-park");
  if ("error" in author) return author;
  if (author.operator_id === undefined) {
    return { error: "lock-park requires an operator-signed write", status: 403 };
  }
  const projectKey =
    typeof body.project_key === "string" && body.project_key.trim() ? body.project_key.trim() : "";
  if (!projectKey) return { error: "project_key is required", status: 400 };
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
      // Round-4 mutation review (card aaf4537d): a row already parked by a
      // DIFFERENT operator must land in `failed`, not be silently overwritten
      // -- the exact mirror of lock-release's own foreign-park refusal a few
      // lines down this file. Without this SELECT, an unconditional WHERE
      // (locked = 1 AND project_key = ? AND locked_by = ?) let operator B
      // re-park a card operator A already parked: `lock_parked_by` flips to
      // B, and B can then archive straight through refusesParkedArchive,
      // which only ever compares against the CURRENT `lock_parked_by` -- the
      // same two-upsert-shaped bypass item 1 closed on the upsert side,
      // reopened here on the park route itself. Read FIRST, same reasoning
      // as lock-release: `changes === 0` alone can't distinguish "nothing to
      // park" from "refused, foreign park" and this route's contract (like
      // release's) requires telling them apart.
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
 * Card aaf4537d, lot 2: Hard Stop's counterpart of lock-park. Releases the
 * work-lock(s) held by each of `peer_ids` under `project_key` OUTRIGHT --
 * same end state as `releaseStaleLocks`'s sweep (locked cleared, park
 * cleared, `in_progress` reverts to `planned`), not merely a de-park. Hard
 * Stop's promise to the operator is that the agent's cards come back to the
 * board free for someone else to pick up; a lock-release that only cleared
 * `lock_parked_at`/`lock_parked_by` and left `locked`/`locked_by` standing
 * would silently break that promise (the card would stay claimed by an
 * agent Hard Stop just killed). Same unconditional operator gate as
 * lock-park, same peer_id-with-nothing-to-release-is-not-a-failure rule.
 *
 * Team-lead arbitration (aaf4537d, after bc0ccb17 landed): a row parked by a
 * DIFFERENT operator is refused, landing in `failed`, never released -- an
 * unrestricted release would otherwise be a service door around
 * refusesParkedArchive: operator B releases operator A's park (clearing
 * lock_parked_by), and the card is no longer parked at all by the time B's
 * upsert tries to archive it, so bc0ccb17's guard never engages. The
 * restriction is scoped to PARKED rows ONLY (`lock_parked_by` non-NULL and
 * different from `author.operator_id`) -- a row that is merely locked, never
 * parked, stays releasable by any operator-proven write, Hard Stop keeps its
 * admin-wide reach there. A row parked by the SAME operator releasing it, or
 * not parked at all, still releases normally. One peer_id's foreign-park
 * refusal never fails the whole request: each peer_id is independent, same
 * `released`/`failed` partial-result contract as lock-park.
 */
// Card c33a5968: no inactive guard here, deliberately -- this handler only
// ever DECREASES a claim (locked -> 0, in_progress -> planned), so it
// structurally never moves a card toward in_progress/locked; releasing a
// lock on an inactive card is a legitimate operation, not a claim.
function handleRoadmapLockRelease(
  body: RoadmapLockReleaseRequest
): RoadmapLockReleaseResponse | { error: string; status: number } {
  const author = resolveRoadmapAuthor(body, "/roadmap/lock-release");
  if ("error" in author) return author;
  if (author.operator_id === undefined) {
    return { error: "lock-release requires an operator-signed write", status: 403 };
  }
  const projectKey =
    typeof body.project_key === "string" && body.project_key.trim() ? body.project_key.trim() : "";
  if (!projectKey) return { error: "project_key is required", status: 400 };
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
      // The UPDATE's WHERE repeats the same park-owner condition as the
      // SELECT above (now including the same expiration threshold, via
      // LOCK_PARK_TTL_SEC's cutoff expressed in SQL -- releaseStaleLocks's
      // clause 3 already needed the identical cutoff for its own sweep, so
      // this reuses that shape rather than inventing a second one). Round-3
      // mutation review (card aaf4537d, item 5): this used to be documented
      // as "defense in depth against a park landing between the SELECT above
      // and this write" -- MEASURED that this race window does not
      // currently exist. `handleRoadmapLockRelease` is a synchronous
      // function (no `await` anywhere in its body; bun:sqlite's
      // `db.query`/`db.run` are synchronous bindings, confirmed by grepping
      // the whole file for `await db.` -- zero matches), so once this loop
      // starts running for a request, JS run-to-completion guarantees
      // nothing else -- not a concurrent lock-park call, not another
      // request's own write -- can execute between this SELECT and this
      // UPDATE, for any peer_id in the batch. The repeated predicate is
      // therefore currently REDUNDANT with the SELECT-based check above, not
      // a live defense: kept as a guard against a FUTURE regression (an
      // `await` introduced into this loop -- a slower store, an added
      // network call -- would reopen exactly this window), not something a
      // test can pin today. There is no way to land a foreign park inside a
      // gap that does not exist without mocking bun:sqlite's own
      // synchronicity, which would test the mock, not this code.
      const res = db.run(
        `UPDATE roadmap_items SET
           locked = 0, locked_by = NULL, locked_at = NULL, operator_id = NULL,
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
 * Card 562fd9b5: append-only edit to `context`. The write is a SINGLE SQL
 * statement -- no SELECT-then-UPDATE. That is the card's central decision,
 * not an optimization: a prior SELECT would reintroduce the destructive
 * read-modify-write this route exists to remove, AND would break atomicity
 * between two concurrent appenders (both would read the same starting
 * context, both would compute a result including only their own text, the
 * second UPDATE would silently overwrite the first's block). One statement,
 * the result cap enforced in its own WHERE clause, `db.changes` distinguishes
 * success (1) from a refused-by-cap write (0) -- ambiguous against "id does
 * not exist" (also 0 changes), so a SELECT-for-EXISTENCE runs AFTER a 0
 * result to tell the two apart with the right status code. That SELECT is
 * not part of the write path and does not reintroduce the race: it never
 * informs what gets written.
 *
 * COALESCE(context,'') is not cosmetic: SQLite's `NULL || text` evaluates to
 * `NULL`, so without it a NULL context would be silently WIPED by an append
 * instead of appended to. MEASURED: `roadmap_items.context` is declared
 * `TEXT NOT NULL DEFAULT ''` (both the CREATE TABLE and the ADD COLUMN
 * migration), and SQLite enforces that unconditionally -- a direct
 * `UPDATE roadmap_items SET context = NULL` against a scratch table with the
 * same constraint fails closed with `NOT NULL constraint failed`. So NULL is
 * NOT reachable through this column today; COALESCE stays as defense in
 * depth against a future migration or an external tool that relaxes that
 * constraint, not against a live risk. See tests/broker-roadmap-append.test.ts
 * for how that is probed given the real column cannot be made NULL to order.
 *
 * `length()` on the SQL side counts CHARACTERS (SQLite default for TEXT),
 * matching ROADMAP_APPEND_RESULT_MAX_CHARS's own unit -- both the existing
 * context and the new chunk are measured via SQL's own `length(?)`, not a JS
 * `.length`, so the two never disagree on what a "character" is (JS
 * UTF-16 code units can diverge from SQLite's count on astral-plane text).
 *
 * TWO GUARDS /roadmap/upsert enforces are DELIBERATELY not enforced here:
 *  - the work-lock does not apply. An append is a single atomic statement,
 *    so it cannot race the lock holder's own write, and the entire point of
 *    this tool is to leave a note on ANOTHER agent's card while it works.
 *    Bound: this route touches ONLY `context` and `operator_id` -- never
 *    `status`, `locked`, or any other arbitration field, all of which remain
 *    fully guarded by /roadmap/upsert's lock check. There is no code path
 *    here that could even attempt to set them (RoadmapContextAppendRequest
 *    carries none). `operator_id` (card edefff05) is not an arbitration
 *    field itself -- nothing gates on it, `releaseStaleLocks` keys its TTL
 *    off `updated_at` alone -- so writing it here does not reopen the
 *    lock-TTL hazard the next bullet describes for `updated_at`.
 *  - `deleted_at` is not checked. Appending to an ARCHIVED card is
 *    intentional -- it is how a post-mortem note gets written.
 *
 * `updated_by`/`updated_at` are ALSO deliberately not touched by the SET
 * clause -- review delta on this card: `updated_at` is itself an arbitration
 * field, not a neutral timestamp. `releaseStaleLocks` frees a stale lock on
 * `datetime(updated_at) < datetime('now', -LOCK_TTL_SEC)`, so if this route
 * refreshed it, a THIRD PARTY appending a note to another agent's locked
 * card would silently extend THAT agent's lock TTL -- exactly the conflict
 * the lock-exemption bullet above claims cannot happen ("an append is
 * atomic and cannot conflict with the lock holder"). It can, through
 * `updated_at`, if this route touches it. Nothing is lost by not touching
 * it: the append header already carries WHO and WHEN inside `context`
 * itself -- the recency information just lives in a different place than
 * the column, not nowhere.
 */
// Card c33a5968: no inactive guard here, deliberately -- this handler touches
// only `context` and `operator_id`, never `status`/`locked`, so it cannot
// claim a card regardless of its `inactive` value.
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
 * Atomic queue rewrite (Workflow lane): `ids` becomes the whole dispatch
 * queue (queue = 1..N in order), every other queued item of the project is
 * unqueued. One transaction, so the operator's insert-in-the-middle never
 * interleaves with an agent's writes half-applied.
 */
// Card c33a5968: no inactive guard here, deliberately -- this handler writes
// `queue`/`updated_by`/`updated_at`, never `status`/`locked`, so it cannot
// claim a card either.
function handleRoadmapReorder(
  body: RoadmapReorderRequest
): RoadmapReorderResponse | { error: string; status: number } {
  const author = resolveRoadmapAuthor(body, "/roadmap/reorder");
  if ("error" in author) return author;
  const by = author.by;
  const projectKey =
    typeof body.project_key === "string" && body.project_key.trim() ? body.project_key.trim() : "";
  if (!projectKey) return { error: "project_key is required", status: 400 };
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
  const projectKey =
    typeof body.project_key === "string" && body.project_key.trim() ? body.project_key.trim() : "";
  if (!projectKey) return { error: "project_key is required", status: 400 };
  if (!Array.isArray(body.items)) return { error: "items must be an array", status: 400 };

  // Card 40ddf1f5: same identity discipline as upsert/archive/reorder --
  // resolveRoadmapAuthor refuses a `by` that impersonates a real registered
  // peer without proof, and binds created_by/updated_by below to something
  // other than raw, untrusted file content.
  const author = resolveRoadmapAuthor(body, "/roadmap/import");
  if ("error" in author) return author;
  const by = author.by;
  // The CLI's roadmap-import is the only non-test caller (arbitration: exempt
  // from card 39c40571's future operator-signature proof, since it already
  // runs on the broker's own host holding the bearer token -- it IS the local
  // operator's own gesture). But that means `by` on THIS route is a DECLARED
  // string, never a proven one (no instance_token flows through the CLI's
  // bearer-only auth) -- so it must never be compared against a card's
  // locked_by to decide ownership: an attacker (or a compromised script using
  // the broker token) could simply declare by:'<lock owner>' or by:'deck' and
  // walk straight through an ownership check, having the guard politely ask
  // the attacker if it owns the card. Every locked card is skipped
  // unconditionally instead -- no author comparison on a path with no proven
  // author -- with an explicit, hand-typed `force:true` escape hatch for an
  // operator who is certain (skip-policy (b)+(c): import proceeds for
  // everything else, skipped cards are counted and named, force overrides
  // deliberately rather than by accident or by a remote declaration).
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

  // Card aad5e954: both the column list and the placeholders are GENERATED from
  // the single ROADMAP_IMPORT_COLUMNS constant, and the values below are bound
  // by mapping that same constant over a record keyed by its union -- so the
  // count and the ORDER cannot drift apart, which is the failure this handler
  // was one hand-edit away from.
  //
  // What that does NOT buy, measured rather than assumed, so nobody trusts a
  // net that is not there: a key MISSING from the record binds `undefined`,
  // and bun:sqlite accepts it as NULL. It throws only for the five columns
  // that are NOT NULL with no DEFAULT (project_key, kind, title, created_at,
  // updated_at); on every DEFAULTED column it silently stores the DEFAULT --
  // exactly the silent reset this card exists to prevent. The Record type is
  // what requires each key, and this repo has NO gate enforcing it: the root
  // package.json has no typecheck script (broker/server/test only) and CI
  // typechecks desktop/ alone, while `bun test` and `bun build` erase types
  // without checking them. So the type is checked by an editor or a manual
  // tsc, NOT by a guard, and the real runtime net is the import test suite
  // asserting that real values survive.
  //
  // And the constant cannot notice a column added to the TABLE and forgotten
  // in the list; that is what the PRAGMA comparison in the tests is for.
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
      const existing = getRoadmapItem(id);
      // Card 40ddf1f5 (defect 1): unconditional skip, no author comparison --
      // see the note above resolveRoadmapAuthor for why comparing `by`
      // against locked_by would be a self-declared bypass on this route.
      //
      // Card bc0ccb17: this is also this route's ENTIRE answer to
      // refusesParkedArchive -- a parked card is, by construction, a locked
      // one (parking only ever happens to a card an agent already holds
      // in_progress), so this same skip already refuses an import row that
      // would otherwise archive-in-place a parked card. handleRoadmapImport
      // deliberately does NOT call refusesParkedArchive itself: doing so
      // would leave `force:true` as the one path that still bypasses it,
      // silently reintroducing the hole this skip closes for every other
      // row. `force` is a CONSCIOUS exemption instead (restoring a self-
      // export, an operator's own gesture), tracked by card 40ddf1f5, not a
      // silent gap.
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
      // Card c33a5968: inactive follows the SAME file-wins/existing-wins
      // discipline as the ordinary content fields below (state restoration is
      // a legitimate reason for a file to carry inactive, UNLIKE operator_id
      // further below, which never trusts the file). Guards mirror the upsert
      // path's predicates, but skip THIS ROW (not the whole batch) on refusal,
      // same granularity as the existing locked-and-!force skip above.
      //
      // `existingStatusVal`/`existingLockedVal` (team-lead review 2026-08-12,
      // delta form -- see refusesInactiveClaim's doc comment): a force-import
      // that faithfully re-carries an inactive-and-in_progress row's OWN stored
      // status/lock must not be refused by comparing against itself. Reading
      // the pre-write row here, deliberately NOT `nextStatusVal`/`lockedVal`,
      // is what makes that round-trip possible while still refusing an actual
      // upward claim (existingStatus not already in_progress, or not already
      // locked) in the same call.
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
      // Card 8c1effca: the columns below follow the SAME discipline the three
      // lock columns already had -- a key PRESENT in the file wins (including an
      // explicit null, which is a genuine clear in a self-export), a key truly
      // ABSENT falls back to the EXISTING row, and only a brand-new row falls
      // back to the table default. Before this, everything but the lock columns
      // fell back to a literal, so a partial file (the exact gesture an operator
      // makes to fix one field by hand) silently erased description, rationale,
      // context, tags, depends_on, queue and deleted_at.
      //
      // TWO EXCEPTIONS, and they are safe only by someone else's rule.
      // `directive` and `target_peer_ids` do NOT fall back to the existing row:
      // a partial import of a directive card would blank its command and its
      // targets, i.e. this very defect surviving in two columns. It cannot
      // happen TODAY because the validation ~60 lines above refuses (400) any
      // item with kind 'directive' and no valid directive, so the partial file
      // that would trigger it never reaches this INSERT. Relax that validation
      // to allow editing a directive card field by field -- a plausible
      // request -- and the erasure becomes live with nothing going red.
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
      };
      insert.run(...ROADMAP_IMPORT_COLUMNS.map((column) => values[column]));
      imported++;
    }
    // Review round 2 (2026-08-10), MINOR (point 6): `INSERT OR REPLACE` on a
    // re-imported id deletes-then-reinserts the row, but roadmap_fts's own
    // DELETE trigger only fires on a REPLACE conflict when
    // `PRAGMA recursive_triggers` is ON -- OFF by default in SQLite, and not
    // set anywhere in this codebase. Measured: the old rowid's FTS row
    // survives, orphaned; the JOIN in handleRoadmapList masks it today (no
    // false positive, since the join keys on a rowid that no longer exists
    // in roadmap_items), but the FTS index still grows by one dead row on
    // every re-import of an existing card. Fixed LOCALLY, at this one write
    // path, rather than flipping the PRAGMA globally: that would change
    // trigger semantics for every table in the database to fix a single
    // route, a wider remedy than the defect. `rebuild` re-derives the whole
    // FTS index from roadmap_items inside this same transaction, so a
    // crash/rollback mid-import cannot leave it half-rebuilt.
    if (imported > 0) {
      db.run(`INSERT INTO roadmap_fts(roadmap_fts) VALUES('rebuild')`);
    }
    return { imported, skipped };
  });
  return importAll(items);
}

/**
 * Drain the operator inbox of a group (PLAN C12): messages agents sent to the
 * reserved 'operator' sentinel. Same TOFU group auth as /announce.
 *
 * Courrail lot 1A (card 54b1c71a): `body.session_id` branches the read.
 * - Absent (or not a non-empty string -- see EDGE CASE below): LEGACY path,
 *   byte-identical to before this card -- delivered=0 selected and marked
 *   delivered, no operator_inbox_sessions row touched. Keeps an old Deck
 *   against a new broker, and a bare send_message-only caller, working.
 * - A non-empty string: NON-DESTRUCTIVE cursor path. The session's own
 *   operator_inbox_sessions row gates what IT has already read (id > last_id),
 *   so two Decks draining the same group_id each see everything and neither
 *   consumes for the other -- see design doc section 3 for why the key is the
 *   session_id and not group_id or operator_id.
 *
 * EDGE CASE (empty string / non-string session_id): treated as absent rather
 * than rejected with 400 or used as-is. Used as-is it would upsert a garbage
 * PRIMARY KEY row (e.g. every caller sharing session_id="" would collide on
 * one cursor, reintroducing the group_id-keyed bug this card fixes); a hard
 * 400 would break a legacy Deck that sends `session_id: ""` instead of
 * omitting the field. Falling back to legacy is the one option that is both
 * safe and backward-compatible.
 *
 * `markDelivered` is still called on EVERY row read by either path (see the
 * doc comment on the operator_inbox_sessions statements block above for why
 * this must not be dropped): `delivered` no longer means "visible" once any
 * session has drained by cursor -- it now means "at least one session has
 * seen it" -- but it must stay 1 so purgeOldUndeliveredStmt's 7-day TTL sweep
 * (broker.ts, "TTL purge of undelivered messages") does not silently claim
 * Courrier rows nobody asked it to purge. Visibility is now governed by each
 * session's own cursor, not by this column.
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
 * Purge the operator inbox of a group (Courrier lot 1C, card 1e81ee7b broker
 * half). Same guard order as the drain: groupMayCarryOperatorInbox THEN
 * checkGroupSecret -- the group_secret_hash proves the right to act on the
 * GROUP'S box, never resolved through "the caller's own" identity.
 *
 * scope='session': this session's cursor jumps to the box's MAX(id) (so it
 * behaves like "I've seen everything, including what I'm about to delete"),
 * then rows with id <= MIN(last_id) across the group's LIVE sessions are
 * deleted. Dead sessions are GC'd FIRST, or a session that stopped polling
 * would pin the floor forever and this purge would never delete anything.
 *
 * scope='ids': immediate, global delete of the named ids for this group --
 * an explicit human "delete this one" gesture, independent of any cursor.
 * The group_id filter is ANDed into the delete so a caller cannot name an id
 * that belongs to a different group and reach across the boundary.
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
 * Card 1def56da: `resolveApprovalAuth` USED TO LIVE HERE and is DELETED, not
 * deprecated. It returned an identity and left each of its eleven call sites to
 * finish the scoping by hand, which is why three of the four approval handlers
 * had no project dimension at all. Keeping it "for the transition" would have
 * made the whole lot pointless: a fail-closed mechanism that cohabits with its
 * fail-open predecessor IS fail-open, since the twelfth site can still call the
 * old one.
 *
 * Its replacement is shared/approval-scope.ts, whose header carries the full
 * reasoning. The single instance below is the ONLY authenticator in this
 * process; the database and the nonce cache are injected so the decision layer
 * imports no `bun:sqlite` and can be unit-tested against a fake -- which is how
 * part of this guarantee reaches CI, the four broker approval suites matching
 * none of the workflow's globs.
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
  // Card 1def56da. `authorizeCreate` returns a SCOPE (for the two reads below)
  // and a STAMP (for the INSERT). Neither is readable here, and that is the
  // point: this handler can no longer decide what `project_key` the new row
  // carries, because it cannot see the value. Before this card it read
  // `origin.project_key` out of the request body, so a sandboxed agent could
  // file its question under another project.
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
  // second pending approval for the same tile is always a double-raise -- the
  // hook's `idle_prompt` and the Deck's attention detector both fire on the
  // same screen. Returning the existing one keeps a single notification per
  // real event instead of ringing the operator's phone twice.
  // Both reads below go through `approvalWhere`, so they gained the project
  // dimension without anyone deciding to add it here -- which is the whole
  // return on the shape. The de-duplication one MATTERS: scoped on operator_id
  // alone, two Deck windows using the same tile_ref would have collapsed two
  // different projects' questions into one, and the second window would have
  // received the FIRST window's approval as its own.
  const where = approvalWhere(scope);
  if (draft.value.tile_ref) {
    const existing = db
      .query(
        `SELECT * FROM pending_approvals
          WHERE ${where.sql} AND tile_ref = ? AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(...(where.params as never[]), draft.value.tile_ref) as ApprovalRow | null;
    if (existing) {
      log.info(`approval: duplicate raise for tile ${draft.value.tile_ref} — reusing ${existing.id}`);
      return { approval: rowToApproval(existing) };
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
        tile_ref, reply_route, reply_token, reply_group,
        kind, title, question, options_json, status, created_at, notif_expires_at)
     VALUES (?, ${stamped.columns.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      ...stamped.values,
      pick("host").slice(0, 128),
      pick("os_user_hash").slice(0, 64),
      pick("group_id").slice(0, 64),
      pick("from_peer").slice(0, 128),
      draft.value.tile_ref,
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
  // Card 1def56da. `authorizeTarget` resolves the row under scope and hands it
  // back, so the separate `SELECT ... WHERE id = ? AND operator_id = ?` that
  // used to stand here is gone along with the round-trip. The session pin that
  // used to be a second `if` on `row.session_ref` is now INSIDE approvalWhere,
  // which is why it cannot be forgotten by the next handler that needs it.
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
  // The identity clause is INTERPOLATED FIRST and literally, rather than pushed
  // into the `clauses` array it used to head. The behaviour is identical; the
  // difference is that a reader -- and the discipline scan in
  // tests/desktop-approval-scope-discipline.test.ts -- can see the scope in the
  // statement itself. Hidden behind `clauses.join(...)`, a later edit that
  // seeded the array from somewhere else would have dropped the scope with
  // nothing to point at.
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
    .all(...params) as ApprovalRow[];
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
  const projectKey = typeof body.project_key === "string" ? body.project_key.slice(0, 256) : "";
  if (!projectKey) return { error: "project_key is required", status: 400 };
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
    // The approval FIRST (a read by id, nothing written), then "is the sender
    // paired for THAT approval's owner". Resolving the address to an operator
    // and comparing was equivalent only while an address belonged to exactly
    // one operator — which stops being true the moment one person runs two OS
    // accounts against one bot and one chat account.
    // Card 1def56da, review round 2. The row AND its scope come back together
    // from the module, which read the row itself. Two consequences worth the
    // line: this handler no longer performs raw SQL on the protected table at
    // all, and the scope cannot be assembled from anything the sender supplied
    // -- the only thing crossing in is an id.
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
 * Live gateways, keyed by TRANSPORT rather than by operator.
 *
 * Two operators on one broker are the normal case (two OS accounts, or a box
 * shared by a team), and they may legitimately enrol the SAME bot token — one
 * person with two OS accounts and one bot. Telegram allows exactly one
 * `getUpdates` consumer per token, so a gateway each would make them fight over
 * the updates forever. Identical configuration therefore means ONE instance,
 * registered under both operators' slots.
 *
 * The key is a digest of the sealed secret's plaintext, never the plaintext:
 * for Telegram and Discord that is the bot token (same token = same key), and
 * for ntfy it is the whole config, so two operators sharing an ntfy account
 * still get one gateway each — their topics differ, and each needs its own
 * subscription.
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
    // Named, not fixed (card ad6aa6ed review, out of that card's scope):
    // same class as the `by`/`locked_by` author-identity fields
    // normalizeAuthorIdentity() closes for the roadmap table -- this one is
    // a DIFFERENT table (graph_drafts) and goes straight from the caller's
    // claim to storage/display with no resolveRoadmapAuthor-equivalent, no
    // lowercase-fold, no charset check. `from_peer: 'deck'` claimed here
    // would render on the Deck side under that identity, unproven.
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
      // Card 78bf378d: this handshake used to trust frame.instance_token with
      // only a DB existence+status='active' check -- the only thing standing
      // between a sentinel-shaped token and wsPool.set()/flushPendingForToken
      // (whose selectUndeliveredCapped had no group_id filter at the time, so
      // an authenticated __operator__ socket would drain every group's
      // operator inbox at once -- selectUndeliveredCapped itself gained that
      // filter under card 1d9f25e5, as defense in depth, so this shape guard
      // is no longer the ONLY thing standing between them) was the sentinel
      // rows being seeded permanently 'dormant', an accident of DB state, not
      // a rule. Reuse the SAME predicate+trace the 14 HTTP routes already apply
      // (refuseSentinelInstanceToken), rather than a parallel WS-specific
      // guard. Client-visible outcome is IDENTICAL to the unknown-token
      // branch below (same close code, same reason, no differentiation) --
      // matching the established HTTP-side precedent of never confirming to
      // the caller which refusal fired (poll/peek return an empty list
      // either way). Only the server-side log (inside the helper) tells the
      // two apart. Compare against `!== null`, not truthiness: the helper's
      // contract is string-or-null, and a future refactor returning `""`
      // must still refuse here exactly like it would break all 14 HTTP call
      // sites visibly, not silently flip this one's meaning.
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
          const result = handleApprovalAdd(body as ApprovalAddRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/wait": {
          const result = await handleApprovalWait(body as ApprovalWaitRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/claim": {
          const result = handleApprovalClaim(body as ApprovalClaimRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/list": {
          const result = handleApprovalList(body as ApprovalListRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/delivered": {
          const result = handleApprovalDelivered(body as ApprovalDeliveredRequest);
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
          const result = handleApprovalTokenMint(body as ApprovalTokenMintRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/approval/token-revoke": {
          const result = handleApprovalTokenRevoke(body as ApprovalTokenRevokeRequest);
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
