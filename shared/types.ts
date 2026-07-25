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
}

export interface RegisterResponse {
  peer_id: PeerId;
  instance_token: InstanceToken;
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

export const DECK_INSTANCE_TOKEN: InstanceToken = "__deck__";
export const DECK_PEER_ID: PeerId = "deck";
/**
 * Reserved OPERATOR inbox sentinel (v0.6, PLAN C12): the human in front of the
 * Deck. Agents `send_message` to 'operator'; the Deck polls /operator-inbox.
 * Like the deck row: permanently dormant, never listed, never purged.
 */
export const OPERATOR_INSTANCE_TOKEN: InstanceToken = "__operator__";
export const OPERATOR_PEER_ID: PeerId = "operator";
/** Reserved display ids set_id must refuse, to keep the sentinels unambiguous. */
export const RESERVED_PEER_IDS: readonly PeerId[] = ["deck", "system", "operator"];

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
   * kind 'directive' (CT1): the app-executed command; null for every other
   * kind. Persisted so the card survives broker restarts like any roadmap row.
   */
  directive: RoadmapDirective | null;
  /**
   * kind 'directive' (CT1): peer_id snapshots the command is injected into
   * (plain text, no FK -- like created_by). [] for non-directive items.
   */
  target_peer_ids: string[];
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
}

export interface RoadmapListResponse {
  items: RoadmapItem[];
}

/** Create (no id) or partially patch (id set) an item. Omitted fields keep. */
export interface RoadmapUpsertRequest {
  id?: string;
  /** Required on create; ignored on patch (an item never changes project). */
  project_key?: string;
  /** Author of the write: peer_id or 'deck'. */
  by: string;
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
}

export interface RoadmapUpsertResponse {
  item: RoadmapItem;
}

export interface RoadmapArchiveRequest {
  id: string;
  by: string;
}

export interface RoadmapArchiveResponse {
  item: RoadmapItem;
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
  /** The complete new queue, in dispatch order. Empty clears the queue. */
  ids: string[];
}

export interface RoadmapReorderResponse {
  /** The queued items after the rewrite, in queue order. */
  items: RoadmapItem[];
}

// --- Operator inbox (PLAN C12) ---

export interface OperatorInboxRequest {
  group_id: GroupId;
  group_secret_hash: string | null;
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
