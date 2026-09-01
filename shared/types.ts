// --- Identity primitives (v0.3) ---

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

// --- Deck system sender (v0.3.4) ---
// The desktop Deck broadcasts outbound, fire-and-forget announcements via
// POST /announce. They are stored with a reserved, non-routable sender so peers
// can never reply to the Deck (send_message to 'deck' fails: the reserved row is
// dormant, and active-target resolution misses it). The sentinel from_peer_id is
// also the server-side suppression key that renders these as "do not reply".

/**
 * Card 37a2b8c7 volet 3: single source of truth for every reserved sentinel
 * identity. isSentinelInstanceToken (below) covers the REFUSAL direction --
 * catching an unlisted future sentinel at the network edge by shape, so
 * nobody needs to remember to add it anywhere. This array covers the
 * opposite, PROCESSING direction, which a shape predicate cannot: the sites
 * that must know each sentinel individually to act on it one by one (seed a
 * dormant DB row for it, exempt it from the dormant-TTL purge, map it to a
 * from_peer_id, refuse it as a set_id target) can only derive from an
 * enumerable list. Adding a sentinel means adding an entry HERE -- the
 * *_INSTANCE_TOKEN / *_PEER_ID constants below are meant to be DERIVED FROM
 * this array (not the reverse), via sentinelToken(peerId) below. That
 * convention is not self-enforcing: a future constant written as a hardcoded
 * literal instead of a sentinelToken()/RESERVED_PEER_IDS derivation would
 * bypass it silently (review finding, card 37a2b8c7). findUnbackedInstance
 * TokenExports/findUnbackedPeerIdExports (below) make the reciprocity
 * CHECKABLE, and tests/broker-sentinel-processing.test.ts asserts it holds
 * over the real module namespace (must be empty) -- so a constant added
 * without backing it here goes red, instead of only failing open at runtime,
 * PROVIDED it is declared in THIS module (the check only ever receives this
 * file's own namespace) and its export name ends in `_INSTANCE_TOKEN` or
 * `_PEER_ID` (that is how both this check and the pre-existing shape test
 * discover candidates; a same-purpose constant declared elsewhere, or named
 * without the conforming suffix, escapes both -- review pass 2, MINOR-1).
 * The same test file also iterates this array (not a hand-copied list) to
 * assert every entry is seeded, TTL-exempt, mapped, and set_id-reserved --
 * so a third entry added here is covered automatically on all four axes.
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
 * Reserved OPERATOR inbox sentinel (v0.6, PLAN C12): the human in front of the
 * Deck. Agents `send_message` to 'operator'; the Deck polls /operator-inbox.
 * Like the deck row: permanently dormant, never listed, never purged.
 */
export const OPERATOR_INSTANCE_TOKEN: InstanceToken = sentinelToken("operator");
export const OPERATOR_PEER_ID: PeerId = "operator";
/**
 * Reserved display ids set_id must refuse. Derived from SENTINEL_DEFINITIONS
 * plus the literal "system" (system has no instance_token sentinel row, only
 * a reserved display name) -- previously a hand-written array disjoint from
 * the *_INSTANCE_TOKEN constants, so a sentinel added to one set silently
 * never reached the other.
 */
export const RESERVED_PEER_IDS: readonly PeerId[] = [
  ...SENTINEL_DEFINITIONS.map((d) => d.peerId),
  "system",
];

/**
 * Card 37a2b8c7 review follow-up (MAJOR-1): the derivation comment above only
 * held for the two constants that actually call sentinelToken()/derive from
 * SENTINEL_DEFINITIONS. Nothing stopped a future `export const
 * SUPERVISOR_INSTANCE_TOKEN: InstanceToken = "__supervisor__"` hardcoded
 * literal from bypassing both -- it would pass the existing shape test
 * (tests/broker-roadmap-author-auth.test.ts) yet have no seed row, no TTL
 * exemption, no resolveSenderMeta mapping, and no reserved peer_id. This pair
 * makes that reciprocity checkable: given a module namespace object, return
 * the names of any `*_INSTANCE_TOKEN`/`*_PEER_ID` export whose VALUE is not
 * present in the derived array. Both are pure functions over a passed-in
 * object (not `import.meta`/self-reflection) so a test can feed them the real
 * `shared/types.ts` namespace (expect empty) AND a synthetic
 * supervisor-shaped object (expect it caught) in the same assertion --
 * proving the check discriminates instead of being vacuously green.
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
 * Is this instance_token one of the reserved sentinels?
 *
 * The sentinel VALUES above are exported constants, so they are public and any
 * caller can type one. They are labels the broker writes on its own rows, never
 * credentials -- so a request PRESENTING one proves nothing and must be refused
 * wherever a token is used as proof of identity.
 *
 * Matching on the SHAPE rather than on an enumeration is deliberate: a third
 * sentinel added later is caught without anyone remembering to extend a list.
 * The half that the shape cannot cover -- a future sentinel written WITHOUT the
 * underscores -- is asserted by tests/broker-roadmap-author-auth.test.ts, which
 * enumerates every exported `*_INSTANCE_TOKEN` and requires it to match here.
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

// --- Roadmap (v0.4, PLAN C3): shared per-project backlog ---
//
// Items are scoped by project_key (normalized git remote), NOT by group_id:
// groups are ephemeral (Deck windows mint a fresh secret per launch) while the
// project is stable, so every session working on the same repo shares one
// roadmap regardless of its group. Items deliberately carry NO foreign key to
// peers/groups -- created_by/updated_by are plain-text snapshots of a peer_id
// (or 'deck' for the operator) -- so their lifecycle is fully independent of
// sessions: no cleanup timer ever touches them, deletion is a reversible
// archive (deleted_at), and rows survive broker restarts like any other table.

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
   * Card e344fa79: the lock owner's OWN group_id -- `locked_by` alone is
   * only unique PER GROUP (peers.UNIQUE(peer_id, group_id)), so on a broker
   * shared by several groups a legitimate homonym peer in another group can
   * satisfy a bare `locked_by` comparison. This is the missing half of that
   * composite key, not a new SCOPE column: the roadmap's scope stays
   * `project_key` alone (operator arbitration fc444eda), this column answers
   * "who holds the lock", not "which group may see this card".
   *
   * Stored RAW (team-lead arbitration, reversing an initial digest-based
   * design once bun:sqlite was measured to have no SQL scalar-function
   * registration -- a digest would have made the owner-gone sweep's
   * correlated `peers` join uncomputable in pure SQL). Leaving this
   * interface publicly exposed to every group listing the roadmap was
   * judged the smaller risk than leaving locked_group's SQL comparison
   * split across a JS pre-pass: `rowToRoadmapItem` (broker.ts) is now an
   * explicit pick-list rather than a `...row` rest-spread, which closes the
   * fail-open for every column, present and future, not just this one --
   * see `ROADMAP_IMPORT_COLUMNS`'s doc comment above for the same
   * discipline already applied to the import path.
   *
   * null when unlocked, or when the row predates this column (fail-open
   * migration state -- see `matchesLockOwner`'s doc comment in
   * shared/roadmap-lock.ts).
   */
  locked_group: string | null;
  /**
   * Card 4441e883, mecanisme B: the lock owner's `instance_token` at the
   * moment it CLAIMED the lock -- `locked_by` above stays a DISPLAY name (a
   * numbered-seat peer_id that a resumed session may not come back to, see
   * that field's doc comment); this is the stable credential a caller can
   * actually PROVE it still holds, for `formatRoadmapUpsertAck`'s "you hold
   * this card" trailer.
   *
   * NEVER GUESSED OR BACKFILLED: NULL on every pre-existing row (fail-open
   * migration state, same as `locked_group`), and NULL is also the
   * PERMANENT, correct value for a claim `resolveRoadmapAuthor` could not
   * prove via a real `instance_token` (an unproven claim, or an
   * operator/deck-signed write, which authenticates a human, not a peer
   * row) -- a resolver that fell back to naming the display peer_id here
   * would defeat the entire point of adding this column (Card 4441e883,
   * "LE BACKFILL NE DEVINE JAMAIS"). NULL reads "owner not proven": no
   * gesture that depends on holding the lock may proceed on the strength of
   * this column alone while it is NULL.
   *
   * Stamped only when `resolveRoadmapLock`'s own `claimed` is true (same
   * discipline as `resolveLockedGroup`/`resolveKeptLockedAt` -- an ordinary
   * third-party write to an already-locked row must not overwrite the real
   * owner's proven token with its own, or with NULL if it has none itself),
   * cleared to null everywhere `locked_by` itself is cleared.
   *
   * DOES NOT MAKE A LOCK SURVIVE A RESTART for most callers on this shared
   * checkout: a peer that re-registers into an active `session_key`
   * collision mints a brand-new `instance_token` (broker.ts's /register
   * collision branch), so most sessions here do not carry the same token
   * across a reconnect. This column trades "the lock outlives a restart"
   * (mostly false in practice) for "an unproven claim never gets the trailer
   * meant for a proven owner" (true by construction) -- an OPEN failure
   * (legitimate owner returns under a fresh token, gets no trailer, same UX
   * as today) traded for a CLOSED one (an agent that merely inherited a
   * freed display name never gets told it holds a card it never claimed).
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
   * Card edefff05: the last OPERATOR (human, via the Ed25519 credential --
   * see resolveApprovalAuth) who SIGNED a write on this card. Set only when
   * that write's `by` was a reserved name (RESERVED_PEER_IDS) proven by that
   * signature. Undefined until an operator signs a write on this card, and
   * again after a stale-lock sweep (releaseStaleLocks), which resets this
   * column to NULL the same way it resets locked_by. An ordinary agent's
   * write PRESERVES the existing value. A signed reorder does not stamp it
   * (queue write, not an authorship event on the card -- see
   * handleRoadmapReorder).
   *
   * This is attribution, NOT ownership -- ownership of an active work-lock
   * stays `locked_by`/`locked_at` on this same interface. A future "reserve
   * this object to one operator" feature belongs on the OBJECT the operator
   * is reserving, not on this card.
   */
  operator_id?: string;
  /**
   * Card c33a5968: operator-only "inactive" flag. An inactive card stays
   * VISIBLE and ordinary edits (retitle, tags, description, context) stay
   * permitted, but every write path that would move it toward status='in_progress' or
   * locked=true is refused (403) while this is true -- see
   * `refusesInactiveClaim`/`refusesInactiveToggle` in `shared/roadmap-lock.ts`.
   * Never a `RoadmapStatus` enum value: status feeds the MCP tool schema,
   * board filters and the stale-lock sweep, and this flag must stay
   * orthogonal to (and distinct from) `wont`. Toggling it requires
   * `author.operator_id` (resolveRoadmapAuthor's cryptographically-resolved
   * field, never client-declared) -- deliberately absent from the
   * roadmap_update MCP tool schema so an ordinary agent cannot self-unblock.
   */
  inactive: boolean;
  /**
   * Card aaf4537d (Pause stop): set when an operator PAUSES the agent that
   * holds this card's work-lock, instead of hard-stopping it -- the lock
   * itself (`locked`/`locked_by`/`locked_at`) is left untouched, this column
   * only makes the card immune to `releaseStaleLocks`'s ordinary TTL/owner-
   * gone sweep for `LOCK_PARK_TTL_SEC` (default 24h; see
   * `shared/roadmap-lock.ts`'s `isParked`). Nullity IS the state -- no
   * separate boolean, so the two can never desync. Cleared (both this and
   * `lock_parked_by`) the moment the lock itself is cleared, by any of: the
   * park's own TTL expiring (sweep clause 3), a hard-release
   * (`/roadmap/lock-release`), or an ordinary write moving the card out of
   * `in_progress`.
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
}

/**
 * Card aad5e954: the column list /roadmap/import writes, as NAMED DATA.
 *
 * `INSERT OR REPLACE` deletes the row before reinserting it, so any column of
 * roadmap_items missing from this list is silently reset to its table DEFAULT
 * on every import. Card 40ddf1f5 paid that once (locked/locked_by/locked_at
 * were absent, so an unrelated import erased another card's lock); this
 * constant exists so the failure mode cannot come back as a NEW column.
 *
 * Two properties earn their keep here, and both are the reason this is an
 * array rather than a hand-written SQL string:
 *  - the statement text AND the bound values are generated from it in
 *    broker.ts, so they cannot drift apart positionally, and a column added
 *    here without a value is a TYPE error rather than a runtime surprise;
 *  - it is directly comparable to the live schema. tests/broker-roadmap-import
 *    reads PRAGMA table_info on a broker-spawned database and compares it to
 *    this list, so a column added to the table and forgotten here fails CLOSED.
 *    Deliberately NOT extracted from the SQL by regex: that would make the
 *    regex a link in the guard, and a regex that silently returns a SUBSET
 *    turns the comparison green exactly when it should scream (measured
 *    precedent in this repo on 2026-08-04, a comment scanner that desynced on
 *    a quoted literal and went from 3 findings to 54).
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
 * Card 4dcd4f04: fields the roadmap_add/roadmap_update MCP tools may report in
 * their compact upsert ack (server.ts formatRoadmapUpsertAck -- never the full
 * item, nobody consumes that echo and it can carry kilobytes of `context`).
 *
 * Reviewer FAIL on the first cut (same card): the ack was built from the
 * CALLER'S RAW ARGS, so it lied on 5 fields the broker silently changes --
 * `title` (trimmed), `tags`/`depends_on` (cleanList drops non-string/blank
 * entries), `target_peer_ids` (cleanPeerIds drops malformed/reserved/dupe
 * entries, and the broker forces [] outside kind='directive'), and `locked`
 * (roadmap_add never forwards it to the broker at all -- the field is outside
 * that path's domain, not merely unreported). Every `landed` extractor below
 * reads off the RoadmapItem the broker actually returned, never off the
 * caller's args; args only decide WHICH fields were requested.
 *
 * Three report shapes:
 *  - "long": free text, potentially large (title/description/rationale/
 *    context). The ack reports character counts only -- REQUESTED (the
 *    caller's raw arg length) AND LANDED (the persisted length) -- never the
 *    content, and never just one of the two: a requested field the broker
 *    silently drops must say so (0 landed chars), not vanish from the ack.
 *  - "short": an enum/scalar. The ack reports the LANDED value only.
 *  - "list": an array. The ack reports the LANDED item count only.
 *
 * `ROADMAP_UPSERT_ACK_FIELDS` is a `Record` total over the union, so a field
 * added to `RoadmapItem`/`RoadmapUpsertRequest` without a matching entry here
 * is a COMPILE error, never a silently-omitted line in the ack (CLAUDE.md
 * coverage rule, same discipline as `findUncoveredRoadmapColumns` below).
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
 * Compare a tool's LIVE MCP inputSchema property names (minus plumbing the
 * ack never reports: `id`) against its ack field domain above. Same shape as
 * `findUncoveredRoadmapColumns` (card aad5e954): `missing` is a schema field
 * the domain forgot (would silently vanish from the ack forever the day it is
 * added), `extra` is a stale domain entry the schema no longer declares.
 * Call once per tool, never on a union of both tools' schemas -- the
 * roadmap_add/roadmap_update asymmetry (`locked`) is exactly what a unioned
 * comparison would hide.
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
   * Roadmap card 39c40571, layer 1: PROOF that the caller really is `by`.
   *
   * Optional over the wire because two legitimate callers have no peer row and
   * therefore no token -- cli.ts (runs on the broker host and already holds the
   * broker token) and the Deck (writes as 'deck'). It stops being optional the
   * moment `by` names an EXISTING peer: the broker then demands the matching
   * token and refuses the write otherwise, so one agent can no longer write
   * under another's identity. When present it OVERRIDES `by`.
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
}

export interface ApprovalAddResponse {
  approval: Approval;
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
