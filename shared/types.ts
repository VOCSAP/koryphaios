// Display name for a peer, mutable via set_id, unique per (peer_id, group_id).
export type PeerId = string;

// UUID v4 routing token, immutable for the lifetime of a peer row.
// Used as primary key, foreign key in messages, key in wsPool, key in peer_sessions.
export type InstanceToken = string;

// 32-hex-char identifier derived from sha256(group_secret).slice(0, 32),
// or the literal sentinel 'default' when no secret is configured.
export type GroupId = string;

// --- Domain entities ---

export interface Peer {
  instance_token: InstanceToken;
  peer_id: PeerId;
  group_id: GroupId;
  pid: number; // PID of the bun server.ts process (always local to the broker host)
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  host: string; // Client hostname (from handshake)
  client_pid: number; // Client-side PID (Claude Code)
  project_key: string | null; // Normalized git remote URL
  status: PeerStatus;
  last_activity_at: string | null; // ISO timestamp of last message sent or received
  activity_status: ActivityStatus;  // computed by broker, not stored
  // A LAUNCH property, not persisted identity: the transport (CLAUDE_PEERS_ROLE,
  // process env set by the Deck at spawn) wins on every /register, dormant
  // resume included -- an empty/absent transport is a declaration of "no
  // role" and overwrites whatever was stored (broker.ts handleRegister,
  // normalized via trim/lowercase/ROLE_REGEX, NULL when absent or malformed).
  // Read-only to the agent: reserved by role, not resistant to a deliberately
  // hostile agent -- never call this "secure".
  role: string | null;
}

export type PeerStatus = "active" | "dormant";
export type ActivityStatus = "active" | "sleep" | "closed";

/**
 * The peer shape crossing the broker's HTTP boundary (B1). The routing token
 * (instance_token) and the local PIDs are the impersonation capability and are
 * NEVER serialized to a client — only these public columns are. list-peers and
 * admin/peers both project to this shape.
 */
export type PublicPeer = Omit<Peer, "instance_token" | "pid" | "client_pid">;

export interface Message {
  id: number;
  from_token: InstanceToken;
  to_token: InstanceToken;
  group_id: GroupId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// Broker-internal row representations (used by SQL queries, not the public API).

export interface GroupRow {
  group_id: GroupId;
  secret_hash: string | null; // NULL for the 'default' group (no auth)
  name: string | null;
  created_at: string;
}

export interface PeerSessionRow {
  session_key: string; // sha256(host || \0 || cwd || \0 || group_id)
  instance_token: InstanceToken;
  group_id: GroupId;
  host: string;
  cwd: string;
  last_active_at: string;
}

// --- Broker API: requests ---

export interface RegisterRequest {
  pid: number; // pid of the bun server.ts process (local to broker)
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  host: string;
  client_pid: number;
  project_key: string | null;
  group_id: GroupId;
  group_secret_hash: string | null;
  claude_cli_pid?: number; // PID of the Claude Code CLI process (process.ppid of server.ts)
  // From CLAUDE_PEERS_ROLE env var, a launch property -- wins on every
  // /register, dormant resume included (see Peer.role). Normalized
  // broker-side. Never trust this field as authorization proof.
  role?: string;
  /**
   * Card 3d121a74 lot L3-a. The Deck's per-tile token
   * (CLAUDE_PEERS_DESK_SESSION), part of the broker's identity KEY: it decides
   * WHICH peer_sessions row, so N agents sharing one directory each own one
   * instead of fighting over a single row. A randomUUID stable across /clear,
   * compact and restart. Optional: a non-Deck CLI omits it and the broker
   * delegates to the legacy (host, cwd, group_id) key, unchanged.
   * Never trust this field as authorization proof -- it is a capability the
   * caller DECLARES, not one it proves; an agent able to read another tile's
   * environment can present it. It raises the bar, it does not fence.
   */
  desk_session?: string;
  /**
   * Card 3d121a74 lot L3-a. The CURRENT Claude Code session id
   * (CLAUDE_CODE_SESSION_ID). Deliberately NOT part of the key -- it rotates
   * on /clear, which would move the key under a living tile -- it is STORED in
   * the row and only decides whether an existing row may be reclaimed after
   * the tile token itself changed (the Restore gesture mints a new tile id and
   * keeps the CC session). Optional, and same caveat as desk_session: declared
   * by the caller, never an authorization proof.
   */
  cc_session_id?: string;
}

export interface RegisterResponse {
  peer_id: PeerId;
  instance_token: InstanceToken;
  // Always normalizeRole(body.role) -- the transport wins unconditionally,
  // so this only ever differs from the request body by NORMALIZATION (trim/
  // lowercase/ROLE_REGEX validation), never by a stored value winning over
  // it. This is what whoami surfaces as "my own role".
  role: string | null;
}

export interface HeartbeatRequest {
  instance_token: InstanceToken;
}

export interface SetSummaryRequest {
  instance_token: InstanceToken;
  summary: string;
}

export interface DisconnectRequest {
  instance_token: InstanceToken;
}

export interface UnregisterRequest {
  instance_token: InstanceToken;
}

export interface SetIdRequest {
  instance_token: InstanceToken;
  new_peer_id: PeerId;
}

export interface SetIdResponse {
  peer_id: PeerId;
  previous: PeerId;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's identity. group_id is resolved server-side from instance_token.
  instance_token: InstanceToken;
  cwd: string;
  git_root: string | null;
  project_key?: string | null;
}

export interface SendMessageRequest {
  from_token: InstanceToken;
  to_peer_id: PeerId; // resolved against the sender's group_id by the broker
  text: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
}

export interface PollMessagesRequest {
  instance_token: InstanceToken;
}

/**
 * A message as delivered to a client (B1/NF-A). The broker resolves the sender
 * server-side and NEVER exposes the routing tokens (from_token/to_token): the
 * client receives the already-resolved from_peer_id (+ sender meta), exactly
 * like the WebSocket push frame. Reserved senders resolve to their sentinel
 * peer_id ("deck"/"operator"); an unresolvable (gone) sender yields "".
 */
export interface DeliveredMessage {
  id: number;
  from_peer_id: PeerId;
  from_summary: string;
  from_host: string;
  from_cwd: string;
  group_id: GroupId;
  text: string;
  sent_at: string;
  delivered: boolean;
}

export interface PollMessagesResponse {
  messages: DeliveredMessage[];
}

// The Deck broadcasts outbound, fire-and-forget announcements via POST
// /announce, stored under a reserved, non-routable sender so peers cannot reply
// -- send_message to 'deck' fails since the reserved row stays dormant and
// active-target resolution misses it.

/**
 * Single source of truth for every reserved sentinel identity: adding one means
 * adding an entry here, since the sites that process each sentinel individually
 * (seed a dormant row, exempt it from TTL purge, map it to a from_peer_id,
 * refuse it as a set_id target) can only derive from an enumerable list.
 * Every *_INSTANCE_TOKEN/*_PEER_ID constant must be derived from this array via
 * sentinelToken(), never a hardcoded literal --
 * findUnbackedInstanceTokenExports/findUnbackedPeerIdExports make that
 * reciprocity checkable, but only for a constant declared in this module whose
 * export name ends in _INSTANCE_TOKEN or _PEER_ID.
 */
export interface SentinelDefinition {
  readonly instanceToken: InstanceToken;
  readonly peerId: PeerId;
}

export const SENTINEL_DEFINITIONS: readonly SentinelDefinition[] = [
  { instanceToken: "__deck__", peerId: "deck" },
  { instanceToken: "__operator__", peerId: "operator" },
];

export const SENTINEL_INSTANCE_TOKENS: readonly InstanceToken[] = SENTINEL_DEFINITIONS.map(
  (d) => d.instanceToken
);

function sentinelToken(peerId: PeerId): InstanceToken {
  const found = SENTINEL_DEFINITIONS.find((d) => d.peerId === peerId);
  if (!found) throw new Error(`shared/types.ts: no SENTINEL_DEFINITIONS entry for peerId '${peerId}'`);
  return found.instanceToken;
}

export const DECK_INSTANCE_TOKEN: InstanceToken = sentinelToken("deck");
export const DECK_PEER_ID: PeerId = "deck";
/**
 * Reserved operator inbox sentinel: agents send_message to 'operator', the Deck
 * polls /operator-inbox. Permanently dormant like the deck row -- never listed,
 * never purged.
 */
export const OPERATOR_INSTANCE_TOKEN: InstanceToken = sentinelToken("operator");
export const OPERATOR_PEER_ID: PeerId = "operator";
/**
 * Derived from SENTINEL_DEFINITIONS plus the literal "system" -- system has no
 * instance_token sentinel row, only a reserved display name.
 */
export const RESERVED_PEER_IDS: readonly PeerId[] = [
  ...SENTINEL_DEFINITIONS.map((d) => d.peerId),
  "system",
];

/**
 * Checks whether the derivation above actually held: given a module namespace,
 * returns the names of any *_INSTANCE_TOKEN/*_PEER_ID export whose value is not
 * present in the derived array -- a hardcoded literal bypassing
 * sentinelToken()/SENTINEL_DEFINITIONS would otherwise pass silently.
 * Pure over a passed-in object, not self-reflection, so a test can feed both
 * the real namespace and a synthetic bad one in the same assertion.
 */
export function findUnbackedInstanceTokenExports(
  moduleExports: Record<string, unknown>
): string[] {
  return Object.keys(moduleExports)
    .filter((k) => k.endsWith("_INSTANCE_TOKEN"))
    .filter((k) => !SENTINEL_INSTANCE_TOKENS.includes(moduleExports[k] as InstanceToken));
}

export function findUnbackedPeerIdExports(moduleExports: Record<string, unknown>): string[] {
  return Object.keys(moduleExports)
    .filter((k) => k.endsWith("_PEER_ID"))
    .filter((k) => !RESERVED_PEER_IDS.includes(moduleExports[k] as PeerId));
}

/**
 * Sentinel values are public labels the broker writes on its own rows, never
 * credentials -- a request presenting one proves nothing and must be refused
 * wherever a token is used as proof of identity.
 * Matches on shape (__..__) rather than enumeration, so a future sentinel is
 * caught without extending a list.
 */
export function isSentinelInstanceToken(token: string): boolean {
  return /^__.+__$/.test(token);
}

export interface AnnounceRequest {
  group_id: GroupId;
  group_secret_hash: string | null;
  text: string;
  /** Optional peer_id to exclude from the broadcast (e.g. the just-joined peer). */
  exclude_peer_id?: PeerId | null;
  /**
   * Targeted announce (PLAN C10): deliver to this ONE active peer of the group
   * instead of broadcasting (used to notify the team-lead). Same reserved
   * `deck` sender and no-reply semantics. 404 when the peer is not active.
   */
  to_peer_id?: PeerId | null;
}

export interface AnnounceResponse {
  sent: number;
}

// Items are scoped by project_key, not group_id: groups are ephemeral (a fresh
// secret per Deck launch) while the project is stable, so every session on the
// same repo shares one roadmap regardless of group.
// No foreign key to peers/groups -- created_by/updated_by are plain-text
// snapshots -- so the lifecycle is independent of sessions: no cleanup timer,
// deletion is a reversible archive.

// 'directive' (CT1) is a control card, not a work item: it carries a `directive`
// command the Deck app INJECTS into the terminals of `target_peer_ids` when the
// card reaches the head of the dispatch queue. Agents never execute directives.
export type RoadmapKind = "feature" | "bug" | "debt" | "idea" | "chore" | "directive";
export type RoadmapPriority = "must" | "should" | "could" | "wont"; // MoSCoW
export type RoadmapLevel = "low" | "medium" | "high";
export type RoadmapStatus = "idea" | "planned" | "in_progress" | "done" | "archived";
/**
 * The context/token-economy command a `directive` card runs (CT1). The Deck
 * maps each to a CODE-CONSTANT keystroke sequence typed into a target session's
 * PTY -- never free text. `magic_compact` prefers the Magic Compact plugin and
 * falls back to `compact` when it is absent (CT4).
 */
export type RoadmapDirective = "clear" | "compact" | "magic_compact";

export interface RoadmapItem {
  /** uuid, immutable. */
  id: string;
  project_key: string;
  kind: RoadmapKind;
  title: string;
  /** Free markdown. */
  description: string;
  /** Why it matters (business value, in words). */
  rationale: string;
  /**
   * Implementation briefing for the agent that will pick the item up later
   * (PLAN C20): objective, constraints/scope boundaries, pointers to relevant
   * files, acceptance criteria, decisions already made. Description = what,
   * rationale = why, context = how/where. Free markdown, '' when absent.
   */
  context: string;
  priority: RoadmapPriority;
  /** Impact ("value" badge). */
  value: RoadmapLevel;
  /** Complexity ("effort" badge). */
  effort: RoadmapLevel;
  status: RoadmapStatus;
  tags: string[];
  /** ids of items this one depends on. */
  depends_on: string[];
  /** peer_id or 'deck' snapshot at creation -- attribution only, no FK. */
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  /** Set when archived (soft delete, reversible); null otherwise. */
  deleted_at: string | null;
  /**
   * Dispatch-queue position (PLAN C15): 1-based order of the operator's
   * "send to the team-lead next" queue; null = not queued. Managed by the
   * Deck; agents normally leave it alone.
   */
  queue: number | null;
  /**
   * Agent work-lock (PLAN K2): true while an agent is ACTIVELY working on the
   * item, distinguishing "really in progress" from "in_progress but waiting".
   * Set automatically by the broker when a non-'deck' author moves the item to
   * in_progress; cleared when the item leaves in_progress, on explicit unlock,
   * or by the stale-lock sweep (owner peer gone / TTL).
   */
  locked: boolean;
  /**
   * peer_id snapshot of the lock owner (the author of the write that locked
   * the item -- rides the existing `by` field, no registration protocol and no
   * FK, like created_by). null when unlocked.
   */
  locked_by: string | null;
  /** ISO timestamp of the lock, for the TTL sweep. null when unlocked. */
  locked_at: string | null;
  /**
   * locked_by alone is unique only per group; this is the group_id half of that
   * composite key -- it answers who holds the lock, not which group may see the
   * card (the roadmap's own scope stays project_key).
   * null when unlocked, or when the row predates this column (fail-open
   * migration state).
   */
  locked_group: string | null;
  /**
   * Never guessed or backfilled: null on every pre-existing row, and null is
   * also the permanent, correct value for a claim that could not be proven via
   * a real instance_token -- falling back to the display peer_id here would
   * defeat the point of this column.
   * Stamped only when the write actually claims the lock, never overwritten by
   * an ordinary third-party write.
   * Does not make a lock survive a restart for most callers: re-registering
   * into a session_key collision mints a fresh instance_token, so most sessions
   * do not carry the same token across a reconnect.
   */
  locked_by_token: string | null;
  /**
   * kind 'directive' (CT1): the app-executed command; null for every other
   * kind. Persisted so the card survives broker restarts like any roadmap row.
   */
  directive: RoadmapDirective | null;
  /**
   * kind 'directive' (CT1): peer_id snapshots the command is injected into
   * (plain text, no FK -- like created_by). [] for non-directive items.
   */
  target_peer_ids: string[];
  /**
   * Set only when the write's by is a reserved name proven by an Ed25519-signed
   * operator credential. An ordinary agent's write preserves the existing
   * value; a stale-lock sweep resets it to null the same way it resets
   * locked_by; a signed reorder does not stamp it (a queue write, not an
   * authorship event on the card).
   * Attribution, not ownership -- ownership of an active work-lock stays
   * locked_by/locked_at.
   */
  operator_id?: string;
  /**
   * An inactive card stays visible and ordinary edits (retitle, tags,
   * description, context) stay permitted, but any write moving it toward
   * status=in_progress or locked=true is refused while this is true.
   * Never a RoadmapStatus value -- stays orthogonal to (and distinct from)
   * wont. Toggling requires author.operator_id, deliberately absent from the
   * roadmap_update MCP tool schema so an ordinary agent cannot self-unblock.
   */
  inactive: boolean;
  /**
   * Set when an operator pauses the agent holding this card's lock instead of
   * hard-stopping it -- the lock itself is left untouched, this only exempts
   * the card from the TTL/owner-gone sweep for LOCK_PARK_TTL_SEC.
   * Nullity is the state, no separate boolean. Cleared together with
   * lock_parked_by whenever the lock itself is cleared.
   */
  lock_parked_at: string | null;
  /**
   * Card aaf4537d: the `operator_id` (never a client-declared `by`) of the
   * operator who parked this card -- distinct from `operator_id` above,
   * which means "last operator to sign ANY write on this card" and gets
   * overwritten by any subsequent signed write, and distinct from
   * `locked_by`, which is the AGENT holding the work-lock, not the operator
   * who paused it. A dedicated field, not a reuse of either: two different
   * operators on a shared broker could each sign a write as `by='deck'`, and
   * without this field a later unrelated signed write from operator B would
   * silently steal operator A's park in `refusesParkedArchive`'s comparison.
   * null when unparked.
   */
  lock_parked_by: string | null;
  /**
   * Replica-side reconciliation state of this card against the upstream
   * broker: 'conflict' when both sides changed the content since the common
   * base and the operator has not chosen yet. Always 'clean' on a broker that
   * is not a replica.
   */
  sync_state: RoadmapSyncState;
  /**
   * Replica-side scope of the work-lock: 'local' (taken while the upstream
   * was unreachable, not yet asserted), 'global' (held on the upstream through
   * this replica's relay), 'contested' (refused upstream because another
   * holder has it), 'remote' (mirrors a lock held upstream by a third party,
   * refreshed by the pull), 'release_pending' (released locally, release not
   * yet sent). null when unlocked or on a non-replica broker.
   */
  lock_scope: RoadmapLockScope | null;
  /**
   * Upstream-side list of `"<peer_id>@<replica_id>"` holders who hold this
   * card locally while it is locked here by someone else. Visibility only;
   * never a lock guard input.
   */
  lock_contested_by: string[];
}

// --- Roadmap replication (DESIGN-OFFLINE-REPLICA) ---

export type RoadmapSyncState = "clean" | "conflict";

export type RoadmapLockScope = "local" | "global" | "contested" | "remote" | "release_pending";

/**
 * The fifteen columns whose divergence between a replica and its upstream IS
 * a conflict. `queue` (upstream wins), the lock columns (own protocol),
 * `updated_by`/`updated_at`/`created_*` (ride along, never decide) and
 * `operator_id` (never crosses) are deliberately absent.
 */
export const ROADMAP_SYNC_CONTENT_FIELDS = [
  "kind",
  "title",
  "description",
  "rationale",
  "context",
  "priority",
  "value",
  "effort",
  "status",
  "tags",
  "depends_on",
  "deleted_at",
  "directive",
  "target_peer_ids",
  "inactive",
] as const;

export type RoadmapSyncContentField = (typeof ROADMAP_SYNC_CONTENT_FIELDS)[number];

/** The content snapshot stored as `sync_base` / `sync_remote` and merged three-way. */
export type RoadmapSyncContent = Pick<RoadmapItem, RoadmapSyncContentField>;

/**
 * One row served by /roadmap/sync/pull: the public item plus the two upstream
 * revision counters. Built by a pick-list, so `locked_by_token` and
 * `operator_id` can never ride along.
 */
export type RoadmapSyncRow = Omit<RoadmapItem, "locked_by_token" | "operator_id"> & {
  rev: number;
  content_rev: number;
};

export interface RoadmapSyncPullRequest {
  replica_id: string;
  /** Exclusive lower bound on `rev`; 0 on first sync. */
  since_rev: number;
  /** Page size, capped at 500 server-side. */
  limit?: number;
}

export interface RoadmapSyncPullResponse {
  items: RoadmapSyncRow[];
  /** Greatest `rev` returned, or `since_rev` when the page is empty. */
  next_rev: number;
}

/** What a replica pushes: content plus the attribution/timestamp columns that ride along. */
export type RoadmapSyncPushItem = RoadmapSyncContent &
  Pick<RoadmapItem, "id" | "project_key" | "created_by" | "updated_by" | "created_at" | "updated_at">;

export interface RoadmapSyncPushRequest {
  replica_id: string;
  item: RoadmapSyncPushItem;
  /** Upstream `content_rev` the replica's copy derives from; null for a card the upstream has never seen. */
  expected_content_rev: number | null;
}

export interface RoadmapSyncPushResponse {
  /**
   * The upstream row as the replica may see it -- same pick-list projection as
   * /roadmap/sync/pull, so an accepted push cannot hand back the
   * `locked_by_token` of whoever holds the card upstream.
   */
  item: RoadmapSyncRow;
  rev: number;
  content_rev: number;
}

/**
 * 409 body of /roadmap/sync/push. `reason`: 'content' when the upstream
 * content_rev moved past the replica's base, 'locked_upstream' when the card is
 * work-locked upstream by a holder this replica does not relay (the push is
 * refused whatever the revisions, exactly as a direct upsert would be), 'missing'
 * when the replica derives from a row the upstream no longer has (`item` null).
 */
export interface RoadmapSyncPushConflict {
  error: "conflict";
  reason: "content" | "locked_upstream" | "missing";
  item: RoadmapSyncRow | null;
}

export type RoadmapSyncLockAction = "claim" | "release";

export interface RoadmapSyncLockRequest {
  replica_id: string;
  id: string;
  action: RoadmapSyncLockAction;
  owner: { peer_id: string; group_id: string | null };
}

export interface RoadmapSyncLockClaimResponse {
  /** 'global' on 200, 'contested' on 409. */
  scope: "global" | "contested";
  item: RoadmapSyncRow;
}

/**
 * 409 body of a /roadmap/sync/lock claim on a card the operator set aside
 * upstream. Same status as a contested claim and a different shape on purpose:
 * `scope` is absent, so a replica reading `error` -- or the missing scope --
 * never records a lock conflict where there is no other holder. The card is
 * simply not claimable until `inactive` is cleared.
 */
export interface RoadmapSyncLockInactiveResponse {
  error: "inactive";
  item: RoadmapSyncRow;
}

export interface RoadmapSyncLockReleaseResponse {
  released: boolean;
  item: RoadmapSyncRow | null;
}

export type RoadmapSyncMode = "local" | "upstream" | "replica";

export interface RoadmapSyncStatus {
  mode: RoadmapSyncMode;
  /** Set only when mode === 'replica'. */
  upstream_url?: string;
  online?: boolean;
  /** ISO timestamp of the last online/offline transition. */
  since?: string;
  last_error?: string | null;
  last_sync_at?: string | null;
  cursor?: number;
  /** Cards in sync_state 'conflict', every project. */
  conflicts?: number;
  /** Cards dirty and clean, i.e. waiting to be pushed. */
  pending_push?: number;
  /**
   * Cards whose last push the upstream refused with a 4xx other than 409
   * (a validation error, never a network failure): retried every pass, never
   * a reason to report the upstream offline. `last_error` names the latest.
   */
  refused?: number;
  /** Lock claims/releases the upstream refused with a 4xx other than a contested 409, published with the same pass snapshot. */
  refused_locks?: number;
  /**
   * Local dispatch-queue positions overwritten by the upstream order since this
   * broker started (the queue is never pushed; a reorder made offline is lost
   * at reconnection). Cumulative and monotonic so a poller can toast the delta.
   */
  queue_replaced?: number;
  locks?: { local: number; global: number; contested: number; remote: number };
}

export interface RoadmapSyncConflict {
  /**
   * The replica's own copy, projected through the SAME pick-list as the
   * upstream side: `locked_by_token` and `operator_id` cross no boundary,
   * the operator's dialog included. Carries `rev`/`content_rev` as a
   * consequence of that shared projection; the arbitration reads neither.
   */
  local: RoadmapSyncRow;
  remote: RoadmapSyncRow;
  /** Content the two sides diverged from; null when the card had never been synced. */
  base: RoadmapSyncContent | null;
}

export interface RoadmapSyncConflictsRequest {
  project_key: string;
}

export interface RoadmapSyncConflictsResponse {
  items: RoadmapSyncConflict[];
}

export type RoadmapSyncResolution = "remote" | "local" | "merge_reopen";

export interface RoadmapSyncResolveRequest {
  id: string;
  choice: RoadmapSyncResolution;
  /** Author of the resolution: 'deck', signed like every Deck roadmap write. */
  by: string;
  instance_token?: string;
}

export interface RoadmapSyncResolveResponse {
  item: RoadmapItem;
}

/**
 * The column list /roadmap/import writes, as data rather than a hand-written
 * SQL string: INSERT OR REPLACE deletes the row first, so any roadmap_items
 * column missing from this list is silently reset to its table DEFAULT on
 * import.
 * Statement text and bound values are generated from this array so they cannot
 * drift positionally, and it is compared directly against the live schema so a
 * forgotten column fails closed.
 * Deliberately not derived from the SQL by regex: a regex that silently returns
 * a subset would make that comparison pass exactly when it should fail.
 */
export const ROADMAP_IMPORT_COLUMNS = [
  "id",
  "project_key",
  "kind",
  "title",
  "description",
  "rationale",
  "context",
  "priority",
  "value",
  "effort",
  "status",
  "tags",
  "depends_on",
  "created_by",
  "updated_by",
  "created_at",
  "updated_at",
  "deleted_at",
  "queue",
  "directive",
  "target_peer_ids",
  "locked",
  "locked_by",
  "locked_at",
  "locked_group",
  "locked_by_token",
  "operator_id",
  "inactive",
  "lock_parked_at",
  "lock_parked_by",
  "rev",
  "content_rev",
  "sync_base_rev",
  "sync_base",
  "sync_dirty",
  "sync_state",
  "sync_remote",
  "lock_scope",
  "lock_relay",
  "lock_relay_seen",
  "lock_contested_by",
  "lock_release_owner",
] as const;

export type RoadmapImportColumn = (typeof ROADMAP_IMPORT_COLUMNS)[number];

/**
 * Compare the LIVE schema of roadmap_items against ROADMAP_IMPORT_COLUMNS.
 *
 * `missing` is the answer that matters: a column the table has and the import
 * does not write, i.e. a column every import silently resets. `extra` catches
 * the mirror mistake (a column removed from the table but still written, which
 * would make the statement throw at runtime).
 *
 * Pure and exported so it can be falsified on synthetic input: the integration
 * halves of this check agree by construction whenever both sides are correct,
 * so the only way to prove the comparison can NAME a defect is to hand it one.
 */
export function findUncoveredRoadmapColumns(
  schemaColumns: readonly string[],
  listedColumns: readonly string[]
): { missing: string[]; extra: string[] } {
  const listed = new Set(listedColumns);
  const schema = new Set(schemaColumns);
  return {
    missing: schemaColumns.filter((c) => !listed.has(c)),
    extra: listedColumns.filter((c) => !schema.has(c)),
  };
}

/**
 * Every `landed` extractor reads off the RoadmapItem the broker actually
 * returned, never the caller's raw args -- the broker silently changes fields
 * (trims title, cleans tags/target_peer_ids, drops locked on roadmap_add), so
 * args only decide which fields were requested.
 * Three report shapes: "long" text fields report requested and landed character
 * counts, never content; "short" scalars report the landed value only; "list"
 * arrays report the landed item count only.
 * A Record total over the union, so a field added to
 * RoadmapItem/RoadmapUpsertRequest without a matching entry here is a compile
 * error, never a silently-omitted ack line.
 */
export type RoadmapUpsertAckField =
  | "title"
  | "description"
  | "rationale"
  | "context"
  | "kind"
  | "priority"
  | "value"
  | "effort"
  | "status"
  | "directive"
  | "locked"
  | "queue"
  | "tags"
  | "depends_on"
  | "target_peer_ids";

export interface RoadmapUpsertAckFieldSpec {
  category: "long" | "short" | "list";
  /** Reads the LANDED value off the item the broker actually wrote. */
  landed: (item: RoadmapItem) => unknown;
}

export const ROADMAP_UPSERT_ACK_FIELDS: Record<RoadmapUpsertAckField, RoadmapUpsertAckFieldSpec> = {
  title: { category: "long", landed: (i) => i.title },
  description: { category: "long", landed: (i) => i.description },
  rationale: { category: "long", landed: (i) => i.rationale },
  context: { category: "long", landed: (i) => i.context },
  kind: { category: "short", landed: (i) => i.kind },
  priority: { category: "short", landed: (i) => i.priority },
  value: { category: "short", landed: (i) => i.value },
  effort: { category: "short", landed: (i) => i.effort },
  status: { category: "short", landed: (i) => i.status },
  directive: { category: "short", landed: (i) => i.directive },
  locked: { category: "short", landed: (i) => i.locked },
  queue: { category: "short", landed: (i) => i.queue },
  tags: { category: "list", landed: (i) => i.tags },
  depends_on: { category: "list", landed: (i) => i.depends_on },
  target_peer_ids: { category: "list", landed: (i) => i.target_peer_ids },
};

/**
 * Per-tool DOMAIN of the ack: exactly the fields THAT case block forwards to
 * the broker. Never a union of the two -- roadmap_add does not forward
 * `locked` (not in its inputSchema; creating an already-locked card has no
 * business meaning; and the broker would force it false outside in_progress
 * anyway), so it is excluded from its domain here, not merely left unreported
 * downstream. The asymmetry IS the fix for the `locked`-on-create defect.
 */
export const ROADMAP_ADD_ACK_FIELDS: readonly RoadmapUpsertAckField[] = [
  "title",
  "description",
  "rationale",
  "context",
  "kind",
  "priority",
  "value",
  "effort",
  "status",
  "directive",
  "tags",
  "depends_on",
  "target_peer_ids",
] as const;

export const ROADMAP_UPDATE_ACK_FIELDS: readonly RoadmapUpsertAckField[] = [
  ...ROADMAP_ADD_ACK_FIELDS,
  "locked",
  "queue",
] as const;

/**
 * Compares a tool's live MCP inputSchema property names against its ack field
 * domain: missing is a schema field the domain forgot, extra is a stale domain
 * entry.
 * Call once per tool, never on a union of both tools' schemas -- the
 * roadmap_add/roadmap_update asymmetry is exactly what a unioned comparison
 * would hide.
 */
export function findUncoveredAckFields(
  schemaFields: readonly string[],
  domainFields: readonly string[]
): { missing: string[]; extra: string[] } {
  const domain = new Set(domainFields);
  const schema = new Set(schemaFields);
  return {
    missing: schemaFields.filter((f) => !domain.has(f)),
    extra: domainFields.filter((f) => !schema.has(f)),
  };
}

export interface RoadmapListRequest {
  project_key: string;
  kind?: RoadmapKind;
  status?: RoadmapStatus;
  priority?: RoadmapPriority;
  /** Keep only items whose tags include this value. */
  tag?: string;
  /** Include archived items (excluded by default). */
  include_archived?: boolean;
  /**
   * Card 15952e09. Plural counterparts of `kind`/`status`/`priority`/`tag`,
   * coexisting rather than replacing them: the broker takes the UNION of the
   * singular field (if set) and this array. An empty or absent array is no
   * constraint. Within one dimension the semantics are OR (any listed value
   * matches); across dimensions they are AND.
   */
  kinds?: RoadmapKind[];
  statuses?: RoadmapStatus[];
  priorities?: RoadmapPriority[];
  /** No singular counterpart -- roadmap_list never had one for effort/value. */
  efforts?: RoadmapLevel[];
  values?: RoadmapLevel[];
  tags?: string[];
  /**
   * Free-text search over title+description+tags (and, when `q_deep` is
   * true, also rationale+context). FTS5-backed; blank/whitespace-only is
   * treated as "no search text", not an error and not a zero-result MATCH.
   */
  q?: string;
  /** Widen `q` to also search rationale+context. Ignored when `q` is absent. */
  q_deep?: boolean;
  /**
   * Also compute `RoadmapFacets` over the project's reference set (this
   * project's items after `include_archived` alone -- no other filter
   * applied). Not exposed on the `roadmap_list` MCP tool in v1.
   */
  with_facets?: boolean;
}

/** One value of a facet dimension and how many reference-set items carry it. */
export interface RoadmapFacetBucket {
  value: string;
  count: number;
}

/**
 * Flat (non drill-down) counts over the project's reference set: this
 * project's items after `include_archived` alone, nothing else. Fixed-enum
 * dimensions (kind/priority/effort/value/status) always list every enum
 * value, zero-count buckets included; `tags` is dynamic and lists only tags
 * that occur at least once.
 */
export interface RoadmapFacets {
  kind: RoadmapFacetBucket[];
  priority: RoadmapFacetBucket[];
  effort: RoadmapFacetBucket[];
  value: RoadmapFacetBucket[];
  status: RoadmapFacetBucket[];
  tags: RoadmapFacetBucket[];
  /** Size of the reference set the counts above were computed over. */
  reference_total: number;
}

export interface RoadmapListResponse {
  items: RoadmapItem[];
  /** Present iff the request set `with_facets: true`. */
  facets?: RoadmapFacets;
}

/** Create (no id) or partially patch (id set) an item. Omitted fields keep. */
export interface RoadmapUpsertRequest {
  id?: string;
  /** Required on create; ignored on patch (an item never changes project). */
  project_key?: string;
  /** Author of the write: peer_id or 'deck'. */
  by: string;
  /**
   * Optional over the wire because two legitimate callers have no peer row and
   * no token -- cli.ts (already holds the broker token) and the Deck (writes as
   * 'deck').
   * It stops being optional the moment by names an existing peer: the broker
   * then demands the matching token and refuses otherwise. When present it
   * overrides by.
   */
  instance_token?: string;
  kind?: RoadmapKind;
  title?: string;
  description?: string;
  rationale?: string;
  context?: string;
  priority?: RoadmapPriority;
  value?: RoadmapLevel;
  effort?: RoadmapLevel;
  status?: RoadmapStatus;
  tags?: string[];
  depends_on?: string[];
  /**
   * kind 'directive' (CT1): the command to inject. Required when kind is
   * 'directive'; rejected (must stay null) for every other kind.
   */
  directive?: RoadmapDirective | null;
  /** kind 'directive' (CT1): the peer_ids to target. */
  target_peer_ids?: string[];
  /** Queue position (C15): a positive integer to queue, null to unqueue. */
  queue?: number | null;
  /**
   * Explicit lock control (PLAN K2). true claims the lock for `by`; false
   * releases it. Usually implicit: moving to in_progress locks (non-'deck'
   * authors), leaving in_progress unlocks.
   */
  locked?: boolean;
  /**
   * Bypass the lock guard (PLAN K2): allows a status write on an item locked
   * by someone else. 'deck' never needs it (the operator always bypasses).
   */
  force?: boolean;
  /**
   * Card c33a5968: set/clear the operator-only "inactive" flag. Requires
   * `author.operator_id` (resolved from `instance_token`, never trusted from
   * this field) -- refused 403 otherwise. See `RoadmapItem.inactive`.
   */
  inactive?: boolean;
}

export interface RoadmapUpsertResponse {
  item: RoadmapItem;
}

/**
 * Card 562fd9b5: append-only edit to `context`, distinct from RoadmapUpsertRequest
 * (which REPLACES the field wholesale). `text` is the raw payload the caller wants
 * appended -- the timestamped attribution header is built server-side (and
 * pre-validated client-side against the same numbers, see shared/roadmap-append.ts)
 * from `by`/`instance_token`, never supplied directly by the caller.
 *
 * No broker route or MCP tool sends this shape yet -- both are the rest of
 * card 562fd9b5, not yet written.
 */
export interface RoadmapContextAppendRequest {
  id: string;
  /** Author of the append: peer_id or 'deck'. See RoadmapUpsertRequest.by. */
  by: string;
  /** Proof of authorship -- see RoadmapUpsertRequest.instance_token. */
  instance_token?: string;
  text: string;
}

export interface RoadmapContextAppendResponse {
  item: RoadmapItem;
}

export interface RoadmapArchiveRequest {
  id: string;
  by: string;
  /** Proof of authorship -- see RoadmapUpsertRequest.instance_token. */
  instance_token?: string;
}

export interface RoadmapArchiveResponse {
  item: RoadmapItem;
}

/**
 * Card aaf4537d, lots 1+2: shared request shape for /roadmap/lock-park and
 * /roadmap/lock-release. Wire contract pinned by the desktop-side caller
 * (desktop/src/main/roadmap-service.ts's `roadmapLockPeers`, ahead of this
 * landing) -- do not rename a field here without checking that file. Both
 * routes are operator-gated (resolveRoadmapAuthor's `operator_id` required),
 * so `by`/`instance_token` follow the same proof discipline as every other
 * signed roadmap write.
 */
export interface RoadmapLockPeersRequest {
  project_key: string;
  by: string;
  /** Proof of authorship -- see RoadmapUpsertRequest.instance_token. */
  instance_token?: string;
  /** Never empty -- an empty array is refused (400), never treated as "every peer". */
  peer_ids: string[];
}

export type RoadmapLockParkRequest = RoadmapLockPeersRequest;
export type RoadmapLockReleaseRequest = RoadmapLockPeersRequest;

/**
 * A peer_id absent from BOTH arrays is a silent no-op: it held no
 * currently-locked card under `project_key`, the ordinary case for most
 * pause/hard-stop targets. `failed` is reserved for a genuine per-row write
 * exception, never for "nothing to do" -- the desktop caller surfaces a
 * non-empty `failed` as an operator-visible error string, so an over-
 * inclusive definition would spam the operator on every ordinary stop.
 */
export interface RoadmapLockParkResponse {
  parked: string[];
  failed: string[];
}

export interface RoadmapLockReleaseResponse {
  released: string[];
  failed: string[];
}

/**
 * Atomic rewrite of a project's dispatch queue (Workflow lane): `ids` becomes
 * the full queue in order (queue = 1..N); every other queued item of the
 * project is unqueued. Replaces N racy per-item upserts when the operator
 * inserts or reorders in the middle of the queue.
 */
export interface RoadmapReorderRequest {
  project_key: string;
  /** Author of the write: peer_id or 'deck'. */
  by: string;
  /** Proof of authorship -- see RoadmapUpsertRequest.instance_token. */
  instance_token?: string;
  /** The complete new queue, in dispatch order. Empty clears the queue. */
  ids: string[];
  /**
   * Additive (roadmap card 42edc88b phase 1): optional grouping of `ids`
   * into queue-tie "waves" -- items in the same wave share one queue
   * position (parallel, no forced order between them). `ids` stays required
   * and authoritative so an old Deck (never sends waves) or an old broker
   * (ignores an unknown field) both keep working across a version-skew.
   * When present, flat(waves) in order must equal `ids` exactly.
   */
  waves?: string[][];
}

export interface RoadmapReorderResponse {
  /** The queued items after the rewrite, in queue order. */
  items: RoadmapItem[];
}

// --- Operator inbox (PLAN C12) ---

export interface OperatorInboxRequest {
  group_id: GroupId;
  group_secret_hash: string | null;
  /**
   * Courrier lot 1A (card 54b1c71a). Minted in-memory by the Deck process at
   * launch, never persisted -- absent means the LEGACY drain (delivered=0 +
   * markDelivered, byte-identical to pre-lot-1A behavior, for an old Deck
   * against a new broker or a bare send_message caller). Present means the
   * NON-DESTRUCTIVE cursor read: this session's own operator_inbox_sessions
   * row gates what it has already seen, so two Decks on the same group_id
   * each see everything and neither one consumes for the other.
   */
  session_id?: string;
}

export interface OperatorInboxMessage {
  id: number;
  from_peer_id: PeerId;
  text: string;
  sent_at: string;
}

export interface OperatorInboxResponse {
  messages: OperatorInboxMessage[];
}

// --- Operator inbox purge (Courrier lot 1C, card 1e81ee7b broker half) ---

export interface OperatorInboxPurgeRequest {
  group_id: GroupId;
  group_secret_hash: string | null;
  session_id: string;
  /**
   * 'session': this session's cursor jumps to the box's MAX(id), then rows
   * with id <= MIN(last_id) across the group's LIVE sessions are deleted --
   * bounded by the slowest other session, never eats another Deck's unread.
   * 'ids': immediate, global delete of the named ids (explicit human gesture
   * on a shared object), independent of any session cursor.
   */
  scope: "session" | "ids";
  ids?: number[];
}

export interface OperatorInboxPurgeResponse {
  deleted: number;
}

// --- Broker API: groups and identity introspection ---

export interface GroupStatsRow {
  group_id: GroupId;
  active_peers: number;
}

export interface GroupStatsResponse {
  groups: GroupStatsRow[];
}

export interface WhoamiResponse {
  peer_id: PeerId;
  host: string;
  client_pid: number;
  cwd: string;
  git_root: string | null;
  project_key: string | null;
  group_name: string;
  summary: string;
  registered_at: string;
  ws_connected: boolean;
  role: string | null;
}

export interface ListGroupsEntry {
  name: string;
  active_peers: number;
}

export interface ListGroupsResponse {
  current: string;
  available: ListGroupsEntry[];
}

// --- WebSocket frames (loopback ws://127.0.0.1:<port>/ws) ---

export interface WsMessageFrame {
  type: "message";
  id: number;
  from_peer_id: PeerId;
  from_summary: string;
  from_host: string;
  from_cwd: string;
  text: string;
  sent_at: string;
}

export type WsFrame = WsMessageFrame;

// --- Graph drafts (agent-escalated questions opened in the Deck's graph view) ---
// An agent (invited by the operator) prepares a graph-chat prompt draft; the
// broker parks it durably here (roadmap_items spirit: no FK, no destructive
// drain) until the operator opens it in the Deck. Scoped by project_key.

export type GraphDraftStatus = "pending" | "opened";

export interface GraphDraft {
  id: string;
  project_key: string;
  /** Sender peer_id snapshot (plain text, survives the peer row). */
  from_peer: string;
  /** Short title (becomes the graph doc name). */
  title: string;
  /** Full pre-filled prompt (markdown: question + curated context + refs). */
  prompt: string;
  status: GraphDraftStatus;
  created_at: string; // ISO timestamp
  opened_at: string | null; // ISO timestamp
}

export interface GraphDraftAddRequest {
  project_key?: string;
  by?: string;
  title?: string;
  prompt?: string;
  /**
   * Card 3781b033: proof accompanying `by`, spread in by server.ts's
   * roadmapProof() -- resolveProvenGraphDraftPeer (shared/graph-draft-
   * scope.ts) requires it and refuses 401 without it. Declared here (was
   * missing) to document what the wire already carries, not to widen it.
   */
  instance_token?: unknown;
}

export interface GraphDraftAddResponse {
  draft: GraphDraft;
}

export interface GraphDraftListRequest {
  project_key?: string;
  include_opened?: boolean;
}

export interface GraphDraftListResponse {
  drafts: GraphDraft[];
}

export interface GraphDraftOpenRequest {
  id?: string;
}

export interface GraphDraftOpenResponse {
  draft: GraphDraft;
}

// The broker only parks the dispatch request; nothing broker-side triggers the
// wave -- the Deck polls it, runs its own dispatch, and posts the outcome back
// on the same row.
// The outcome matters because status alone proves nothing: a card is marked
// done before it is executed, so what comes back must name the cards actually
// dispatched and the tiles actually hit.

export type DispatchRequestStatus = "pending" | "done";

/** One card the wave dispatched, and where it landed. */
export interface DispatchedCard {
  /** Roadmap item id (full uuid). */
  id: string;
  title: string;
  /** Roadmap kind ('directive', 'feature', ...): a lead reads the wave by it. */
  kind: string;
  /**
   * peer_ids whose live tile was resolved AND hit. The three buckets below
   * mirror resolveDirectiveTargets (desktop/src/main/directive.ts) exactly:
   * `ambiguous` is a SUBSET of `missing`, never of `matched` — since commit
   * 73b5e67 an id carried by several live tiles is refused rather than routed
   * to the first one found. Reporting it separately is what tells the caller
   * WHY a target was not hit, instead of leaving it indistinguishable from an
   * unreachable one.
   */
  matched: string[];
  /** Requested peer_ids no live tile answered for (includes every `ambiguous`). */
  missing: string[];
  /** Refused for collision: several live tiles carry this peer_id. */
  ambiguous: string[];
}

export interface DispatchRequestOutcome {
  /** Cards the wave dispatched, in wave order. Empty = the queue had nothing. */
  cards: DispatchedCard[];
  /** One line readable as-is, notably when `cards` is empty. */
  note: string;
}

export interface DispatchRequest {
  id: string;
  project_key: string;
  /** Requester peer_id snapshot (plain text, survives the peer row). */
  from_peer: string;
  status: DispatchRequestStatus;
  created_at: string; // ISO timestamp
  resolved_at: string | null; // ISO timestamp
  /** Null until the Deck resolves it — never an empty success. */
  outcome: DispatchRequestOutcome | null;
}

export interface DispatchRequestAddRequest {
  project_key?: string;
  by?: string;
  /**
   * Proof of identity, spread in by server.ts's roadmapProof(). project_key
   * and from_peer are derived from the PROVEN peers row, never from the two
   * fields above — those are declared only to document what the wire carries.
   */
  instance_token?: unknown;
  /** Seconds to hold the response open waiting for the outcome. */
  wait_sec?: number;
}

export interface DispatchRequestAddResponse {
  request: DispatchRequest;
}

export interface DispatchRequestListRequest {
  project_key?: string;
  include_done?: boolean;
}

export interface DispatchRequestListResponse {
  requests: DispatchRequest[];
}

export interface DispatchRequestResolveRequest {
  id?: string;
  outcome?: DispatchRequestOutcome;
}

export interface DispatchRequestResolveResponse {
  request: DispatchRequest;
}

// --- Remote approvals (PLAN-notifications-mobiles N0/N1) ---
// An agent hits a blocking question; the broker parks it here until SOMEONE
// answers — the Deck, or a notification channel on the operator's phone. Same
// durability philosophy as graph_drafts (no FK to peers, plain-text author
// snapshot, status flips, listing is non-destructive): a broker or Deck
// restart never loses a pending approval.
//
// The arbiter contract: exactly one `claim` wins (409 for everyone else), so
// answering in the Deck invalidates the phone notification and vice versa.

/** What kind of blocking situation produced this approval. */
export type ApprovalKind = "permission" | "question" | "plan";

/**
 * pending        -> waiting for an answer, notification live
 * answered       -> settled; `answered_via` says which channel won the race
 * expired_notif  -> the NOTIFICATION expired (default 24h). The session is
 *                   still blocked and the Deck may still claim it.
 * abandoned      -> the producer gave up (session closed, host gone)
 */
export type ApprovalStatus = "pending" | "answered" | "expired_notif" | "abandoned";

/** Shape of the answer. `text` carries a free-form operator prompt. */
export type ApprovalAnswerKind = "allow" | "deny" | "text";

/** Which channel settled the approval. */
export type ApprovalVia = "deck" | "telegram" | "discord" | "ntfy";

/**
 * How the answer gets back to the agent (C-9).
 *
 * `channel` — the broker delivers it as a claude-peers message. Only valid
 *   when the agent is at its prompt: a modal permission dialog is NOT closed
 *   by an incoming message (the UI loop is blocked on a keypress), so the
 *   message would simply queue behind it.
 * `pty` — the Deck types the answer into the tile. Required for permission
 *   dialogs, and for CLIs that have no push channel at all (codex, gemini).
 */
export type ApprovalReplyRoute = "channel" | "pty";

/**
 * Whether a row may merge with another pending row on the same tile.
 * `tile`  — a NOTIFICATION: the verdict applies to the SCREEN, so a different
 *   text for the same screen still merges (commit 4c2b2cf's guarantee).
 * `never` — a GUARDED REQUEST: the verdict is re-read by a caller gating an
 *   action, so it may never be satisfied by someone else's row.
 */
export type ApprovalMerge = "tile" | "never";

/** Which credential class signed a request (see shared/approval.ts header). */
export type ApprovalAuthKind = "operator" | "session";

export interface ApprovalAuthProof {
  kind: ApprovalAuthKind;
  /** operator_id for both kinds — a session token is always bound to one. */
  operator_id: string;
  /** Session token id (sha256 prefix). Absent for an operator proof. */
  token_id?: string;
  nonce: string;
  /** Unix seconds. */
  ts: number;
  /** base64 Ed25519 signature over canonicalize(payload)\n nonce \n ts. */
  sig: string;
}

/** Origin metadata: display + audit only, NEVER an authorisation input. */
export interface ApprovalOrigin {
  /** Machine hostname. NOT an identity: two OS accounts share it. */
  host: string;
  /** Salted hash of the OS username — the login never leaves the machine. */
  os_user_hash: string;
  project_key: string;
  group_id: string;
  /** Peer display id snapshot (plain text, survives the peer row). */
  from_peer: string;
  /** Session handle the CREDENTIAL is pinned to (authenticated). */
  session_ref: string;
  /**
   * Tile the answer should be applied to. UNTRUSTED routing metadata: it is
   * declared by the producer, not authenticated, so the Deck re-validates it
   * against its own live tiles (and their waiting state) before typing
   * anything — a declaration, never an access gate.
   */
  tile_ref: string;
}

export interface Approval {
  id: string;
  operator_id: string;
  origin: ApprovalOrigin;
  kind: ApprovalKind;
  title: string;
  question: string;
  options: string[];
  status: ApprovalStatus;
  /** Where the answer will be delivered. The routing TOKEN is never exposed. */
  reply_route: ApprovalReplyRoute;
  answered_via: ApprovalVia | null;
  answer_kind: ApprovalAnswerKind | null;
  answer_text: string | null;
  created_at: string; // ISO timestamp
  notif_expires_at: string; // ISO timestamp
  answered_at: string | null;
  delivered_at: string | null;
}

export interface ApprovalAddRequest {
  auth?: ApprovalAuthProof;
  origin?: Partial<ApprovalOrigin>;
  kind?: ApprovalKind;
  title?: string;
  question?: string;
  options?: string[];
  session_ref?: string;
  tile_ref?: string;
  /** Defaults to 'pty'. 'channel' additionally needs reply_peer_id. */
  reply_route?: ApprovalReplyRoute;
  /**
   * Peer to deliver the answer to, resolved broker-side against the group in
   * `origin.group_id`. Only a peer_id travels — never an instance_token.
   */
  reply_peer_id?: string;
  ttl_hours?: number;
  /** Absent, null or unrecognised normalises to 'tile' broker-side. */
  merge?: ApprovalMerge;
}

export interface ApprovalAddResponse {
  /**
   * The de-duplication branch returns only the fields a producer actually
   * reads (every current one reads just `id`), not the full row: widening
   * the dedup match to a differently-scoped row (card 874e9053) must not
   * also widen what a caller can read off SOMEONE ELSE's approval.
   */
  approval: Approval | Pick<Approval, "id" | "status">;
}

export interface ApprovalWaitRequest {
  auth?: ApprovalAuthProof;
  id?: string;
  timeout_sec?: number;
}

/** Either the settled approval, or `pending: true` when the long poll expired. */
export interface ApprovalWaitResponse {
  approval?: Approval;
  pending?: boolean;
}

export interface ApprovalClaimRequest {
  auth?: ApprovalAuthProof;
  id?: string;
  via?: ApprovalVia;
  answer_kind?: ApprovalAnswerKind;
  answer_text?: string;
}

export interface ApprovalClaimResponse {
  approval: Approval;
}

export interface ApprovalListRequest {
  auth?: ApprovalAuthProof;
  project_key?: string;
  status?: ApprovalStatus;
  /** Only approvals answered but not yet applied by the producer. */
  undelivered_only?: boolean;
}

export interface ApprovalListResponse {
  approvals: Approval[];
}

export interface ApprovalDeliveredRequest {
  auth?: ApprovalAuthProof;
  ids?: string[];
}

export interface ApprovalDeliveredResponse {
  marked: number;
}

/** Deck mints a restricted per-session token (never the operator key). */
export interface ApprovalTokenMintRequest {
  auth?: ApprovalAuthProof;
  session_ref?: string;
  /**
   * Card 1def56da: the project the minting Deck window works on, PINNED into
   * the credential. Required. It is what lets `handleApprovalAdd` stop reading
   * `origin.project_key` out of the agent's own request body -- a session
   * credential must no more choose its project than it may choose its
   * `session_ref`. A token minted without it is refused at mint time rather
   * than silently issued and refused at every later `add`.
   */
  project_key?: string;
  token?: string;
  ttl_hours?: number;
}

export interface ApprovalTokenMintResponse {
  token_id: string;
  expires_at: string;
}

export interface ApprovalTokenRevokeRequest {
  auth?: ApprovalAuthProof;
  session_ref?: string;
  token_id?: string;
}

export interface ApprovalTokenRevokeResponse {
  revoked: number;
}
