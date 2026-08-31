// Types shared across the main, preload and renderer processes.

export type SessionStatus = 'starting' | 'running' | 'exited'

/** Tile layout mode. '1x1' is a horizontal carousel; the rest are cols x rows grids. */
export type DisplayMode = '1x1' | '1x2' | '2x2' | 'custom'

/** Persisted definition of a peer session. PTY scrollback is NOT persisted. */
export interface SessionDef {
  id: string
  name: string
  /** Working directory the peer terminal is launched in. */
  cwd: string
  /** Base command override; empty => the resolved launchCommand (launch-config). */
  command: string
  /** Extra launch args appended after --session-id on a fresh launch. */
  args: string
  /** Current claude --session-id. Changes on every fork-resume. Empty until first spawn. */
  sessionId: string
  /** Display colour (hex) framing the tile + sidebar swatch. Auto-assigned, overridable. */
  color: string
  /**
   * Reasoning effort level (`--effort`), e.g. 'low' | 'medium' | 'high' |
   * 'xhigh' | 'max'. Empty/undefined => not specified (Claude's default). Stored
   * here (not folded into `args`) so it can be re-passed on every fork-resume,
   * since --effort is not auto-restored the way --agent/--model are.
   */
  effort?: string
  /**
   * What this agent DOES (card a2f61172), e.g. 'developer' | 'reviewer' |
   * 'team-lead'. Kebab, `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`; empty/undefined
   * => no role. Its OWN field (not folded into `args`) for the same reason as
   * `effort` above: it must be re-emitted on every spawn, fresh AND fork-resume
   * -- spawnSession() exports it as CLAUDE_PEERS_ROLE on both paths.
   *
   * TEMPLATE capture (card 0b9e0b07): captured by `toTemplate`/`templateToInputs`
   * (`shared/template.ts`) in BOTH the operator-global and repo-local scope, no
   * strip, no approval branch beyond the existing shell-fields gate. Operator
   * arbitration 2026-08-27: a role opens no capability on Kory today -- it is a
   * label a session is spawned under, re-normalised through the single
   * production sink (`session-service.ts`'s `sanitizeRole(input.role ?? '') ||
   * ''`) regardless of which scope the template came from. TEMPORAL RESERVE,
   * not a security objection to this lot: the day an authorization decision is
   * keyed on role (card 7defe381), this premise stops holding and a local
   * template becomes hostile input #1 able to plant that role -- that
   * arbitration must be REOPENED before shipping such a guard, not after.
   *
   * WORKSPACE capture (`toWorkspaceSessions`) is a SEPARATE, narrower decision,
   * unchanged by the above: role stays deliberately absent there (a workspace
   * file lives in `<projectDir>/.claude/claude-peers/workspaces/`, i.e. hostile
   * input #1, and this exclusion was never reopened -- see card b313f0c3). COST
   * OF THAT EXCLUSION, accepted knowingly: `toWorkspaceSessions` is a 6-field
   * pick-list, so restoring a workspace respawns every tile with no role, and
   * since an empty CLAUDE_PEERS_ROLE is now a DECLARATION of absence, that
   * restore ERASES the role broker-side -- where `model`/`effort`/`agent` are
   * merely forgotten.
   */
  role?: string
  /**
   * Per-session override for quota auto-resume (PLAN C1). undefined = follow
   * the global `AppConfig.autoResumeQuota`; true/false forces it for this tile.
   */
  autoResume?: boolean
  /**
   * Initial prompt submitted as Claude's positional argument on a FRESH launch
   * (PLAN C2). Never re-played on resume (--resume restores the conversation);
   * kept in the def so an expired-never-used session restarts with it.
   */
  prompt?: string
  /**
   * Deck-created worktree this session runs in (PLAN C4): its absolute path
   * and branch. undefined = normal session in the shared working dir. Drives
   * the sidebar branch badge and the "also remove the worktree?" close flow.
   */
  worktree?: { path: string; branch: string }
  /**
   * The Home-rail SUPERVISOR session (PLAN C5): hidden from the Agents view,
   * excluded from workspace/template capture, and the only session launched
   * with the deck-control MCP (via mcpConfig below).
   */
  supervisor?: boolean
  /**
   * The window's TEAM-LEAD (PLAN C10): the peer targeted announces (dispatch,
   * integration notices) go to. Explicit flag, single per window (the service
   * enforces uniqueness); captured in workspaces and templates. 👑 badge.
   */
  lead?: boolean
  /**
   * Path of a generated .mcp config file passed as `--mcp-config` on BOTH
   * fresh and resume spawns (like --effort, it is not restored by
   * --fork-session). Set only for the supervisor (deck-control bridge).
   */
  mcpConfig?: string
  /**
   * Path of a generated system-prompt extension passed as
   * `--append-system-prompt-file` on BOTH fresh and resume. Set only for the
   * supervisor: its role anchor, regenerated from a CODE CONSTANT at every
   * spawn (never operator/repo-configurable -- PLAN C8 security decision).
   */
  appendSystemPromptFile?: string
  createdAt: number
}

/** Live runtime view of a session, sent to the renderer. */
export interface SessionRuntime extends SessionDef {
  status: SessionStatus
  exitCode: number | null
  pid: number | null
  /** Display peer_id resolved from the claude-peers status-line cache, if any. */
  peerId: string | null
  /**
   * FREQUENCY-based activity predicate (card f8082208 / docs/
   * DESIGN-ACTIVITY-PREDICATE.md), ternary and never a boolean: 'unknown'
   * is the honest default for an agent-kind whose OSC 0 emission is
   * unmeasured (codex, gemini, a bare shell, sandbox) rather than a
   * silent 'idle'. See desktop/src/main/detect/activity.ts.
   */
  activity: 'working' | 'idle' | 'unknown'
  /**
   * Restore-time flag: the persisted claude session id has no transcript on disk
   * (expired / pruned), so it was not resumed. The tile shows a "start new"
   * overlay instead of a dead terminal. Always false for live/fresh sessions.
   */
  expired: boolean
  /** True while the session sits at a usage-limit (quota) screen (quota.ts). */
  rateLimited: boolean
  /** Epoch ms of the announced quota reset, or null when unknown/not limited. */
  resumeAt: number | null
  /** True while the session waits for the operator (permission/question, C11). */
  needsAttention: boolean
  /**
   * True when this session runs the Claude Code CLI itself (session-kind.ts,
   * card fd1914cc). FROZEN AT SPAWN (main's RuntimeState.claudeLaunch, set
   * by startPty from the command actually used for that spawn) -- never
   * recomputed afterward, so it cannot flip out from under an already-live
   * session if the global launch command changes while it runs. Claude Code
   * 2.1.235+ owns its own quota resume by default, but that is not provable
   * active from here, so the Deck's detector only stays off for such a
   * session while it follows the global default (`autoResume === undefined`
   * -- see `quotaGateActive` in session-service.ts); an explicit per-session
   * override always wins and restores normal detection+injection. Never
   * persisted.
   */
  claudeLaunch: boolean
}

/** Lightweight workspace row for the restore picker (no sessions payload). */
export interface WorkspaceSummary {
  id: string
  name: string
  pinned: boolean
  scopeName: string
  sessionCount: number
  updatedAt: number
  /** True if another live owner currently holds this workspace's lock. */
  locked: boolean
  /** True if this is the workspace the running app currently owns. */
  current: boolean
}

/** A discovered team template (global or project-local). `path` is its id. */
export interface TemplateSummary {
  path: string
  name: string
  source: 'global' | 'local'
  sessionCount: number
}

/**
 * A discovered reusable prompt (PLAN C22), global or project-local; `path` is
 * its id. Carries the full text: snippets are short by contract (the store
 * skips files over its size cap) and the tile menu inserts them directly.
 */
export interface SnippetSummary {
  path: string
  name: string
  source: 'global' | 'local'
  text: string
}

/**
 * Trust mode for supervisor-initiated spawns (PLAN TS4): 'hands-free' spawns
 * without app-level confirmation (the consent rule lives in the supervisor's
 * system prompt), 'team-review' shows ONE recap dialog per plan (all-or-
 * nothing), 'full-control' confirms each agent individually.
 */
export type SupervisorSpawnMode = 'hands-free' | 'team-review' | 'full-control'

export const SUPERVISOR_SPAWN_MODES: SupervisorSpawnMode[] = [
  'hands-free',
  'team-review',
  'full-control'
]

/**
 * Gate for the peer-JOIN announcement ONLY (broadcast fired from
 * service.on('peer-resolved') in main/index.ts): 'off' suppresses it
 * entirely, 'lead' targets only the active team-lead/supervisor session(s)
 * (silent if none, never a broadcast fallback), 'all' keeps the historical
 * broadcast-to-everyone behaviour. Does not affect any other announce path
 * (roadmap-stop, operator megaphone, spawn-ack).
 */
export type JoinAnnounceLevel = 'off' | 'lead' | 'all'

export const JOIN_ANNOUNCE_LEVELS: JoinAnnounceLevel[] = ['off', 'lead', 'all']

/**
 * Hand-kept mirror of TWO interfaces declared in repo-root shared/types.ts
 * (NOT this file): `Approval` and `ApprovalOrigin`. Verify by reading
 * `export interface Approval` and `export interface ApprovalOrigin` there —
 * repo-root shared/approval.ts imports both from that same file and
 * re-exports them for the main process (see approval-auth.ts). NOT an
 * import here: MEASURED, not assumed (team-lead's own review round, ask_operator
 * lot, 2026-08-13) — `import type { Approval } from '../../../shared/approval'`
 * in this file makes `npm run typecheck:web` fail with:
 *   src/shared/types.ts(N,M): error TS6307: File '.../shared/approval.ts' is
 *   not listed within the file list of project '.../desktop/tsconfig.web.json'.
 *   Projects must list all files or use an 'include' pattern.
 * (cascades into shared/approval.ts's own imports of shared/text.ts and
 * shared/types.ts, same TS6307). `npm run typecheck:node` passes with the
 * SAME import — this is a web-project-only `include` boundary, not a
 * cross-desktop-wide constraint. If tsconfig.web.json's `include`/`files`
 * setup changes, retry the import — see the file/commit that closes this
 * comment's premise before assuming it still holds. Until then: keep the
 * fields in sync by hand if the broker's shape moves; nothing enforces that
 * automatically.
 */
export type ApprovalStatus = 'pending' | 'answered' | 'expired_notif' | 'abandoned'
export type ApprovalKind = 'permission' | 'question' | 'plan'
export type ApprovalVia = 'deck' | 'telegram' | 'discord' | 'ntfy'
export type ApprovalReplyRoute = 'channel' | 'pty'
export type ApprovalAnswerKind = 'allow' | 'deny' | 'text'

export interface ApprovalOrigin {
  host: string
  os_user_hash: string
  project_key: string
  group_id: string
  from_peer: string
  session_ref: string
  tile_ref: string
}

export interface Approval {
  id: string
  operator_id: string
  origin: ApprovalOrigin
  kind: ApprovalKind
  title: string
  question: string
  options: string[]
  status: ApprovalStatus
  reply_route: ApprovalReplyRoute
  answered_via: ApprovalVia | null
  answer_kind: ApprovalAnswerKind | null
  answer_text: string | null
  created_at: string
  notif_expires_at: string
  answered_at: string | null
  delivered_at: string | null
}

/** One notification channel as the Settings screen sees it. */
export interface ApprovalChannelStatus {
  kind: 'telegram' | 'discord' | 'ntfy'
  configured: boolean
  connected: boolean
  bot_label: string
  /** Last 4 characters of the token — never the token itself. */
  token_hint: string
  paired: number
  paired_labels: string[]
}

export interface ApprovalEnrolmentPayload {
  v: 1
  privateKey: string
  publicKey: string
  userSalt: string
}

export interface AppConfig {
  /** Default working directory used as the base for new sessions. */
  projectDir: string
  /** Command launched inside each peer terminal (e.g. the `claudepeers` alias). */
  peerCommand: string
  /** Shell used to wrap the command so login/interactive aliases resolve. Empty = auto. */
  shell: string
  /** Load the interactive shell / profile (alias resolution) with start-marker stripping. */
  interactiveShell: boolean
  /** Number of columns in the tile grid (legacy; custom mode uses gridCols/gridRows). */
  columns: number
  /** Tile layout mode. */
  displayMode: DisplayMode
  /** Columns for the custom display mode (>= 1). */
  gridCols: number
  /** Rows for the custom display mode (>= 1). */
  gridRows: number
  /** Sidebar width in px (resizable, persisted). */
  sidebarWidth: number
  /** Agents sidebar collapsed to its narrow rail. Persisted on the same channel
   *  as `sidebarWidth`: both describe the SAME geometry, so splitting their
   *  lifecycle (width remembered, fold forgotten) would reopen the panel the
   *  operator had folded. */
  sidebarCollapsed: boolean
  /** Roadmap filter panel folded to its rail (card 7a2e76c6). Persisted for the
   *  same reason as `sidebarCollapsed`: a fold that forgets itself at every
   *  launch re-opens the panel the operator had deliberately closed. */
  roadmapFiltersCollapsed: boolean
  /** Graph chats panel folded to its rail (card 67c21dd5). Same lifecycle as
   *  `roadmapFiltersCollapsed`: a fold that resets at every launch is the
   *  defect this field exists to avoid. */
  graphListCollapsed: boolean
  /** Workflow-lane canvas height in px (resizable via its top-edge handle, persisted). */
  wfLaneHeight: number
  theme: 'dark' | 'light'
  fontSize: number
  /** UI language: '' = auto (OS), 'en' or 'fr'. Resolved by main/i18n.ts. */
  locale: string
  /** Rotating palette (hex) for auto-assigned session colours; editable in Settings (D12). */
  palette: string[]
  /** Attention-glow colour (hex) of the rail glyphs; '' = theme default (gold). */
  glowColor: string
  /** Remember custom (shared) scope secrets on this machine, encrypted (D8). */
  rememberScopeSecrets: boolean
  /**
   * Auto-resume sessions stopped by the usage limit: when a tile shows the
   * rate-limit screen, inject "continue" once the printed reset time passes
   * (quota.ts). Global default, overridable per session (SessionDef.autoResume).
   */
  autoResumeQuota: boolean
  /**
   * Case-insensitive substring suggesting the team-lead at spawn (PLAN C10):
   * when the agent/session name matches AND no lead exists, the create menu
   * pre-checks the team-lead box. Suggestion only -- the flag stays explicit.
   */
  leadPattern: string
  /** System notification when a session waits for the operator (PLAN C11). */
  notifyAttention: boolean
  /** Remote approvals: notify a phone when a session blocks, and accept the
   * answer back. Opt-in; a project can only restrict it, never enable it. */
  mobileApprovals: boolean
  /** Confirmation level for supervisor-initiated spawns (PLAN TS4). */
  supervisorSpawnMode: SupervisorSpawnMode
  /** Gate for the peer-join announcement broadcast; default 'off'. */
  joinAnnounceLevel: JoinAnnounceLevel
  /** Show the floating "?" help-assistant button (PLAN C9). */
  helpButton: boolean
  /**
   * Inference target of the help assistant AND the resume digest (lot A):
   * any provider of the unified catalog (frontier CLI or local endpoint).
   * Default: claude/haiku (cheap + fast).
   */
  helpTarget: import('./graph').ModelTarget
  /** Inference target of the roadmap context wand (was pinned haiku, C21). */
  wandTarget: import('./graph').ModelTarget
  /**
   * Inference target of the REC scripted-scenario driver (claude CLI only —
   * the demo browser bridge is injected via --mcp-config). Remembered from
   * the REC modal's picker; default claude/sonnet.
   */
  demoTarget: import('./graph').ModelTarget
  /** Last URL loaded in the embedded browser view (PLAN D1); restored on open. */
  browserUrl: string
  /**
   * Pinned models of the unified pickers (C29), as `providerId:modelId` keys
   * in pin order. Favorites of vanished providers are kept (they come back).
   */
  modelFavorites: string[]
  /**
   * Roles the operator added through the create menu's "Other…" entry (card
   * a2f61172), on top of the app's built-in list (shared/role.ts). Lives in the
   * operator-GLOBAL config, never in a project file: a role is an operator
   * gesture, and a cloned repo must not be able to suggest one.
   */
  roleChoices: string[]
  /** OpenAI-compatible local endpoints (Ollama, LiteLLM…) added in Settings (C29). */
  localProviders: import('./models').LocalProviderConfig[]
}

/** A selectable language for the settings picker: stable code + native label. */
export interface LocaleOption {
  /** Locale tag ('en', 'fr', …). */
  code: string
  /** Native display name (endonym), e.g. 'English', 'Français'. */
  label: string
}

/** Active locale + flattened translation dict, sent to the renderer. */
export interface I18nPayload {
  locale: string
  dict: Record<string, string>
  /** Languages offered in Settings, derived from the present locale files. */
  available: LocaleOption[]
}

/**
 * Launch config shapes for the IPC contract. Structurally identical to the ones
 * in main/launch-config.ts (kept separate so that module stays import-free for
 * its bun unit tests). Keep the two in sync.
 */
export interface LaunchPreset {
  label: string
  args: string
  prompt?: string
}

/** One selectable Anthropic model for the create dropdown. `id` feeds `--model`. */
export interface ModelOption {
  /** Value passed to `--model` (alias like 'opus' or a full model id). */
  id: string
  /** Human label shown in the dropdown. */
  label: string
}

export interface LaunchConfig {
  launchCommand: string
  presets: LaunchPreset[]
  /** Selectable models for the create dropdown (local config + built-in default). */
  models: ModelOption[]
  /** Command run in the background inside a fresh worktree (PLAN C4), e.g. "bun install". */
  worktreeInit?: string
}

export interface CreateSessionInput {
  name?: string
  cwd?: string
  /** Base command override; empty => the resolved launchCommand. */
  command?: string
  /** Chosen subagent (becomes `--agent <name>` and seeds the default name). */
  agent?: string
  /** Chosen model (becomes `--model <id>`). */
  model?: string
  /** Reasoning effort (`--effort <level>`); empty => unspecified. */
  effort?: string
  /** Operator-chosen role (SessionDef.role); empty/undefined => no role. */
  role?: string
  /** Extra free-form launch args appended verbatim. */
  args?: string
  /** Initial prompt submitted on the fresh launch (positional arg, PLAN C2). */
  prompt?: string
  /**
   * Branch name: create a fresh worktree under <projectDir>/.worktrees and run
   * the session in it (PLAN C4). Empty/undefined = normal session. The ipc
   * layer creates the worktree and fills `worktree` before the service spawns.
   */
  worktreeBranch?: string
  /** Filled by the MAIN process after worktree creation; not a renderer input. */
  worktree?: { path: string; branch: string }
  /** MAIN-only (PLAN C5): mark the created session as the supervisor. */
  supervisor?: boolean
  /** Designate the created session as the window's team-lead (PLAN C10). */
  lead?: boolean
  /** MAIN-only (PLAN C5): --mcp-config path re-passed on every spawn. */
  mcpConfig?: string
  /** MAIN-only (PLAN C8): --append-system-prompt-file path (supervisor anchor). */
  appendSystemPromptFile?: string
  /** Optional explicit colour (hex); falls back to the rotating palette. */
  color?: string
  /**
   * Operator-authored join-announce note (advanced create), broadcast to the
   * group once this session's peer_id resolves. Empty/undefined => the default
   * agent/model/effort summary is composed instead.
   */
  announce?: string
}

// ----- Roadmap (PLAN C3) -----
// Mirror of the core shared/types.ts roadmap entities (the desktop tree cannot
// import repo-root shared/, same convention as broker-client.ts). Keep in sync.

// 'directive' (CT1): a control card the Deck executes by injecting its
// `directive` command into `target_peer_ids`' terminals when it reaches the
// head of the dispatch queue. Not a work item; agents never run directives.
export type RoadmapKind = 'feature' | 'bug' | 'debt' | 'idea' | 'chore' | 'directive'
export type RoadmapPriority = 'must' | 'should' | 'could' | 'wont'
export type RoadmapLevel = 'low' | 'medium' | 'high'
export type RoadmapStatus = 'idea' | 'planned' | 'in_progress' | 'done' | 'archived'
/** The context/token-economy command a `directive` card runs (CT1, mirror of core). */
export type RoadmapDirective = 'clear' | 'compact' | 'magic_compact'

export interface RoadmapItem {
  id: string
  project_key: string
  kind: RoadmapKind
  title: string
  description: string
  rationale: string
  /** Implementation briefing for the agent picking the item up later (PLAN C20). */
  context: string
  priority: RoadmapPriority
  value: RoadmapLevel
  effort: RoadmapLevel
  status: RoadmapStatus
  tags: string[]
  depends_on: string[]
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  /** Dispatch-queue position (PLAN C15), 1-based; null = not queued. */
  queue: number | null
  /** Agent work-lock (PLAN K2): an agent is ACTIVELY working on the item. */
  locked: boolean
  /** peer_id snapshot of the lock owner; null when unlocked. */
  locked_by: string | null
  /** ISO timestamp of the lock; null when unlocked. */
  locked_at: string | null
  /**
   * Card e344fa79 lineage: the lock owner's OWN group_id -- `locked_by` alone
   * is only unique PER GROUP (peers.UNIQUE(peer_id, group_id)), so a
   * legitimate homonym peer_id registered in a different group can satisfy a
   * bare `locked_by` comparison. Mirrors root shared/types.ts's field of the
   * same name (broker.ts's rowToRoadmapItem pick-list). null when unlocked,
   * or when the row predates this column (fail-open migration state on the
   * broker's own sweep -- see matchesLockOwner in shared/roadmap-lock.ts).
   * The Deck-side consumer is desktop/src/main/idle-lock.ts's ownsIdleLock,
   * which -- unlike the broker -- fails CLOSED on null: never auto-releases
   * a lock it cannot positively attribute to its own group.
   */
  locked_group: string | null
  /** kind 'directive' (CT1): the app-executed command; null otherwise. */
  directive: RoadmapDirective | null
  /** kind 'directive' (CT1): peer_ids the command is injected into; [] otherwise. */
  target_peer_ids: string[]
  /**
   * Card edefff05: the last OPERATOR (human, via the Ed25519 credential) who
   * SIGNED a write on this card. Attribution, NOT ownership -- ownership of
   * an active work-lock stays `locked_by`/`locked_at` above. Undefined until
   * an operator signs a write on this card, and again after a stale-lock
   * sweep (releaseStaleLocks), which resets this column to NULL the same way
   * it resets locked_by. An ordinary agent's write PRESERVES the existing
   * value. A signed reorder does not stamp it (queue write, not an
   * authorship event on the card -- see handleRoadmapReorder).
   */
  operator_id?: string
  /**
   * Card c33a5968: operator-only "park" flag. Stays visible on the board;
   * every write path that would move the card toward status='in_progress' or
   * locked=true is refused broker-side while this is true. Toggling it
   * requires a signed operator write (broker-enforced) -- no Deck UI action
   * to set/clear it exists yet, this is the read-direction field only.
   */
  inactive: boolean
}

export interface RoadmapListFilters {
  kind?: RoadmapKind
  status?: RoadmapStatus
  priority?: RoadmapPriority
  tag?: string
  include_archived?: boolean
}

/** Create (no id) or partial patch (id set); the main process stamps by='deck'. */
export interface RoadmapUpsertFields {
  id?: string
  kind?: RoadmapKind
  title?: string
  description?: string
  rationale?: string
  context?: string
  priority?: RoadmapPriority
  value?: RoadmapLevel
  effort?: RoadmapLevel
  status?: RoadmapStatus
  tags?: string[]
  depends_on?: string[]
  /** kind 'directive' (CT1): the command to inject (required when kind='directive'). */
  directive?: RoadmapDirective | null
  /** kind 'directive' (CT1): the peer_ids to target. */
  target_peer_ids?: string[]
  /** Queue position (C15): positive integer to queue, null to unqueue. */
  queue?: number | null
  /** Explicit lock control (K2): false releases, true claims for the author. */
  locked?: boolean
  /** Bypass the broker's lock guard (K2); 'deck' writes never need it. */
  force?: boolean
  /**
   * Card 442084b7: operator-only park flag (see RoadmapItem.inactive's own
   * doc comment). Deliberately absent from the MCP-facing roadmap_update
   * tool schema (server.ts) -- only this Deck-signed relay carries it. The
   * `by: DECK_AUTHOR` stamp alone is not what satisfies the broker's
   * refusesInactiveToggle operator-proof requirement -- an unsigned
   * `by: 'deck'` is refused 401 upstream of that guard (broker.ts's
   * resolveRoadmapAuthor, reserved-name branch). The actual proof carrier is
   * `signedAsOperator()` (desktop/src/main/roadmap-service.ts), which
   * `upsertRoadmap` runs the whole body through before every POST -- without
   * that signer this field would 401, not silently write unsigned.
   */
  inactive?: boolean
}

/**
 * Editor-side item draft the context wand grounds its briefing on (PLAN C21).
 * Plain strings from the form -- never a saved item (the wand result itself
 * only fills the textarea; saving stays an explicit operator action).
 */
export interface RoadmapWandDraft {
  title: string
  kind: string
  description: string
  rationale: string
  /** Current content of the context textarea ('' when starting fresh). */
  context: string
}

/** Result of a queue dispatch to the team-lead (PLAN C15). */
export interface DispatchResult {
  sent: boolean
  /** Title of the dispatched item when sent (single-item dispatch). */
  title?: string
  /**
   * Wave dispatch (roadmap card 5852c074): when the sent wave had more than
   * one non-directive member, `count` is the member count and `titles` its
   * item titles in wave order. Absent (or count === 1) for the ordinary
   * single-item dispatch, so existing single-item UI reads stay unchanged.
   */
  count?: number
  titles?: string[]
  /** Failure reason when not sent: 'empty-queue' | 'no-lead' | 'error'. */
  reason?: string
}

/** Result of a direct assignment to one chosen peer (PLAN K6). */
export interface AssignResult {
  /** The targeted announce reached the peer and the item moved to in_progress. */
  sent: boolean
}

/** Result of an operator stop on an in_progress item (PLAN K3). */
export interface StopResult {
  /** The item was unlocked and moved back to planned. */
  stopped: boolean
  /** How the stop notice went out: coordinated by the supervisor, broadcast to the group, or not delivered (no active peer). */
  via: 'supervisor' | 'broadcast' | 'none'
}

// ----- multi-tile stop broadcast (card aaf4537d, lot 3) -----
// Wire contract shared with agent-stop.ts (main) and AgentStopControls.tsx
// (renderer, lot 4) BY VALUE -- duplicated here rather than imported from
// main/agent-stop.ts, same convention as the rest of this file (shared/
// stays free of a dependency on main/, see BUN.md "pure module" rule).
// Renaming a field here means checking both those files too.

/** pause/hard: bare ESC on the process, not idle-gated. soft: idle-gated conversation-turn injection. */
export type StopMode = 'pause' | 'soft' | 'hard'

export interface StopOutcome {
  /** Tile id. Always present -- unlike peerId, which is null until the peer registers. */
  id: string
  peerId: string | null
  /**
   * 'written' guarantees only that the pty write succeeded -- not that the
   * terminal submitted it, that the agent received it, or that it will act
   * on it (measured false at least once: card 6168b7f4). Soft stop is a
   * request, not a guarantee (only pause/hard are); this value is why.
   *
   * 'refused-modal' (Vague 10 A2-1/A2-2 follow-up, cards 5dbf3255/63ca372f;
   * card 120148eb added the second source below): the tile's own
   * screen-state guard refused to write anything at all. Reachable in
   * TWO modes, from two different guards: 'soft' (SessionService.
   * injectCommand's own guard) and 'pause' (SessionService.interrupt's
   * own gate on the same union, added by 120148eb -- interrupt() is no
   * longer unconditional for 'pause'). 'hard' is deliberately left
   * ungated (interrupt() skips the check for that mode), so 'hard' never
   * produces this value. Mirrors DirectiveOutcome
   * (session-service.ts) and InjectOutcome (agent-stop.ts); this is the
   * THIRD hand-maintained mirror of the same union with no compile-time
   * link between them -- adding a member here does not fail the other two's
   * build, which is exactly how this value went missing the first time
   * (roadmap debt card filed for the duplication itself, not fixed here).
   */
  result: 'interrupted' | 'written' | 'busy-timeout' | 'no-terminal' | 'error' | 'refused-modal'
}

export interface StopReport {
  mode: StopMode
  outcomes: StopOutcome[]
  /** Requested peerIds with no live, peer-resolved tile to stop. Omitted when empty. */
  missing?: string[]
  /** Absent/partial in 'soft' mode: a soft stop asks, it does not touch the lock table. */
  locks: { parked?: number; released?: number; error?: string }
}

export interface StopState {
  live: number
  busy: number
  /**
   * Live tiles whose activity is 'unknown' (card f8082208): counted
   * separately from both `busy` and idle, never folded into either -- see
   * docs/DESIGN-ACTIVITY-PREDICATE.md section 5.
   */
  unknown: number
  paused: number
  parkedCards: number
}

export interface RoadmapListResponse {
  items: RoadmapItem[]
  /**
   * Present iff the request set `with_facets: true` (card 3b0fda5f). Raw,
   * unsanitized wire shape -- only searchRoadmap()'s sanitizeFacets() reads
   * this; listRoadmap() never sets with_facets so this stays undefined there.
   */
  facets?: unknown
}

/**
 * Mirror of the core shared/types.ts RoadmapListRequest (card 3b0fda5f).
 * Keep in sync. `project_key` is stamped by the main process, not sent by
 * the renderer -- same convention as RoadmapListFilters above.
 */
export interface RoadmapQuery {
  kind?: RoadmapKind
  status?: RoadmapStatus
  priority?: RoadmapPriority
  tag?: string
  include_archived?: boolean
  kinds?: RoadmapKind[]
  statuses?: RoadmapStatus[]
  priorities?: RoadmapPriority[]
  efforts?: RoadmapLevel[]
  values?: RoadmapLevel[]
  tags?: string[]
  q?: string
  q_deep?: boolean
  with_facets?: boolean
}

/** One value of a facet dimension and how many reference-set items carry it. */
export interface RoadmapFacetBucket {
  value: string
  count: number
}

/**
 * Mirror of the core shared/types.ts RoadmapFacets. Keep in sync. Sanitized
 * main-side (roadmap-service.ts's sanitizeFacets) as a pick-list, never a
 * spread -- see RoadmapSearchResult's `facets: RoadmapFacets | null` for why
 * this can never be optional on the wire the Deck actually consumes.
 */
export interface RoadmapFacets {
  kind: RoadmapFacetBucket[]
  priority: RoadmapFacetBucket[]
  effort: RoadmapFacetBucket[]
  value: RoadmapFacetBucket[]
  status: RoadmapFacetBucket[]
  tags: RoadmapFacetBucket[]
  reference_total: number
}

/**
 * `facets` is `RoadmapFacets | null`, deliberately never optional/undefined:
 * a newer Deck talking to an older, not-yet-upgraded broker on a shared
 * deployment is a real scenario, and the filter panel must be able to tell
 * "0 cards match" (a real zero-count bucket) apart from "the broker didn't
 * send counters at all" (render without a counter, never a false "(0)").
 */
export interface RoadmapSearchResult {
  items: RoadmapItem[]
  facets: RoadmapFacets | null
}
export interface RoadmapUpsertResponse {
  item: RoadmapItem
}
export interface RoadmapArchiveResponse {
  item: RoadmapItem
}
/** Atomic queue rewrite (Workflow lane): the queued items after, in order. */
export interface RoadmapReorderResponse {
  items: RoadmapItem[]
}

/** Navigation rail views: Home (C5), Agents, Browser (D1), Files (GX6), Git (GX3), Roadmap (C3), Graph (C26), Worktrees (C6), Sandbox (SBX4), Journal (C14). */
export type DeckView =
  | 'home'
  | 'agents'
  | 'browser'
  | 'files'
  | 'git'
  | 'roadmap'
  | 'graph'
  | 'worktrees'
  | 'sandbox'
  | 'journal'

// ----- Sandbox mode (PLAN-SANDBOX SBX1–SBX5) -----

/** Container engine detected on the host (docker preferred, podman fallback). */
export type SandboxEngineName = 'docker' | 'podman'
/** ok = CLI + daemon answer; daemon-down = CLI present, Desktop/VM stopped. */
export type SandboxEngineState = 'ok' | 'daemon-down' | 'missing'
/** Rail-view container actions (main re-validates name + label on every call). */
export type SandboxContainerAction = 'start' | 'stop' | 'remove' | 'rebuild'

/**
 * Where the agents' filesystem comes from. `mount` bind-mounts the real
 * project (work lands on disk directly); `copy` mounts a throwaway host-side
 * clone instead, so the real tree is untouchable and work leaves through git.
 */
export type SandboxWorkMode = 'mount' | 'copy'

/** Operator-editable per-project sandbox settings (app-state, never the repo). */
export interface SandboxSettingsPatch {
  enabled?: boolean
  mode?: SandboxWorkMode
  ports?: number[]
  copyIgnored?: string[]
}

/**
 * Minimal glob → RegExp: `**` crosses separators, `*` and `?` do not.
 * Deliberately DUPLICATED from `globToRegExp` in
 * `desktop/src/main/sandbox-copy.ts` rather than imported: that file pulls in
 * `node:fs`/`node:path` and is main-process only, while this one is bundled
 * into the renderer too (SandboxView's client-side pre-check). Keep the two
 * bodies identical — a divergence here is exactly the canonicalization-drift
 * bug that let `*.*`, `**\/**`, `?*`, `**\/*.*` and `**\\*` slip past
 * `isUnboundedGlob` while `selectCopyPaths` already treated them as whole-tree
 * matches (audit 94f8cc0c rework).
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` should also match zero segments (docs/**/x matches docs/x).
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

/**
 * Expand one operator-entered glob into the RegExp set a path is tested
 * against — same normalize (trim + backslash-to-slash, so a Windows-typed
 * `**\*` means the same thing as `**\/*`) and same slash-free-glob expansion
 * (`PLAN-*.md` also matches at any depth, like `selectCopyPaths` does) that
 * the actual copy matcher applies. Duplicated in `sandbox-copy.ts` for the
 * same cross-process-boundary reason as `globToRegExp` above; the two must
 * stay in lock-step or `isUnboundedGlob` below drifts from what
 * `selectCopyPaths` actually selects again.
 */
function expandCopyGlob(glob: string): RegExp[] {
  const g = glob.trim().replace(/\\/g, '/')
  if (!g) return []
  return (g.includes('/') ? [g] : [g, `**/${g}`]).map(globToRegExp)
}

/**
 * Ordinary-file witnesses: a root file, a nested file, a deeply-nested file.
 * A glob matching ALL of these constrains the file name not at all — it is
 * equivalent to a whole-tree match.
 */
const UNBOUNDED_WITNESS_PATHS: readonly string[] = ['README.md', 'src/app.ts', 'a/b/c/deep.txt']

/**
 * Dotfile witnesses at the same three depths. `.*` matches none of the
 * ordinary witnesses above (no ordinary file starts with a literal dot) but
 * sweeps every one of these — an unconstrained secret-shaped class of its
 * own (`.env`, `.aws/credentials`, `.ssh/id_rsa`), checked as an alternative
 * "everything" rather than folded into the ordinary set above.
 */
const UNBOUNDED_DOTFILE_WITNESS_PATHS: readonly string[] = ['.hidden', 'src/.env', 'a/b/.secret']

/**
 * Same two shapes (ordinary / dotfile) but with every FLAT (zero-nesting)
 * entry dropped. `*\/**` and `**\/*\/*` require at least one path segment of
 * nesting before they match anything, so they miss `README.md`/`.hidden`
 * above entirely and read as "bounded" against the flat sets alone --
 * despite `selectCopyPaths` pulling in every nested file in the tree under
 * them, `.secret`/`.env` included (round-2 rework, reviewer-measured against
 * a 20-file corpus: 10 matched, none named by the deny-list). Rooted globs
 * like `src/**` also require nesting but are anchored to one real directory,
 * so they correctly stay bounded against these same witnesses.
 */
const UNBOUNDED_NESTED_WITNESS_PATHS: readonly string[] = ['src/app.ts', 'a/b/c/deep.txt']
const UNBOUNDED_NESTED_DOTFILE_WITNESS_PATHS: readonly string[] = ['src/.env', 'a/b/.secret']

/**
 * True when `glob`, compiled and expanded exactly like `selectCopyPaths`
 * would, matches every witness in one of the four sets above — i.e. it does
 * not constrain the file name within whichever of those classes it targets,
 * and is equivalent to a whole-tree (or whole-dotfile-tree, or
 * whole-nested-subtree) match (audit 94f8cc0c, card 4b668844). Derived from
 * the matcher itself rather than a literal list of known-bad strings: a list
 * can only ever name the forms someone already thought of (`*`, `**`,
 * `**\/*`, `.*`), and missed `*.*`, `**\/**`, `?*`, `**\/*.*`, the backslash
 * form `**\*`, and the nesting-floor forms `*\/**`/`**\/*\/*` -- all of which
 * resolve to a whole-(sub)tree match once expanded the way the real matcher
 * expands it. RESIDUAL, written down rather than implied: this is a widening
 * list of witness DEPTHS, not a closed proof -- `*\/*\/**` (nesting floor of
 * 3) still escapes every set above, and every additional floor will need its
 * own witness rows. The real invariant this approximates is "the glob names
 * no secret it doesn't intend to," which is a different, harder question
 * than "does it match everything" -- tracked as a follow-up card rather than
 * solved here. Rejected by saneGlobs' write path ONLY (never silently
 * stripped from an already-persisted store at load time).
 */
export function isUnboundedGlob(glob: string): boolean {
  const patterns = expandCopyGlob(glob)
  if (patterns.length === 0) return false
  const matchesAll = (witnesses: readonly string[]): boolean =>
    witnesses.every((w) => patterns.some((re) => re.test(w)))
  return (
    matchesAll(UNBOUNDED_WITNESS_PATHS) ||
    matchesAll(UNBOUNDED_DOTFILE_WITNESS_PATHS) ||
    matchesAll(UNBOUNDED_NESTED_WITNESS_PATHS) ||
    matchesAll(UNBOUNDED_NESTED_DOTFILE_WITNESS_PATHS)
  )
}

/**
 * Prefix of the Error thrown by writeSandboxSettings on an unbounded glob.
 * SandboxView pre-checks with isUnboundedGlob before ever sending the patch,
 * so this rarely round-trips — but when it does (a future drift between this
 * file's copy of the matcher and sandbox-copy.ts's, or any other bypass of
 * the pre-check), it is NOT translated: patchSandbox goes through the
 * store's shared `guarded()` helper (store.ts), which reports and toasts the
 * raw `sandbox-unbounded-glob:<globs>` string before any per-field handler
 * could intercept it, unlike 'sandbox-live-sessions'/'sandbox-container-running'
 * which SandboxView's `fail()` does translate (those never go through
 * `guarded()` in the first place).
 */
export const SANDBOX_UNBOUNDED_GLOB_ERROR = 'sandbox-unbounded-glob:'

/** Result of a supervisor `deck_sandbox_exec` (output clipped main-side). */
export interface SandboxExecResponse {
  code: number
  stdout: string
  stderr: string
}

/**
 * Reserved utility-PTY id of the sandbox login terminal (SBX3). Shared so the
 * auth dialog's xterm and the main-side spawn target the same channel id;
 * never collides with session ids (those are UUIDs).
 */
export const SANDBOX_AUTH_PTY_ID = 'sandbox-auth'

/** Reserved utility-PTY id of the sandbox image build terminal (M2). */
export const SANDBOX_BUILD_PTY_ID = 'sandbox-build'

/**
 * Sandbox image tags (f29b1917) — they live here (not sandbox-command.ts,
 * which re-exports them) because the Docker view needs both to offer the
 * base <-> custom switch without duplicating the strings.
 */
export const SANDBOX_IMAGE_DEFAULT_TAG = 'koryphaios-sandbox'
export const SANDBOX_IMAGE_CUSTOM_TAG = `${SANDBOX_IMAGE_DEFAULT_TAG}-custom`

/**
 * Card 9e529177 arbitrage A10: mount-mode protection sub-policy (6e3863ef)
 * surfaced for the operator. 'not-applicable' (copy mode -- the sub-policy
 * has no meaning, workSource is an ephemeral clone) is a DISTINCT state from
 * 'applied' with `appliedCount: 0` (mount mode, nothing matched) -- modeled
 * here so the renderer can never conflate "sans objet en mode copie" with
 * "0 chemin protégé". `skipped` is operator-only (paths NOT protected): the
 * agent-facing renderProtectionNotice() text must never carry this, by
 * design (sandbox-protect.ts) -- only the human sees what was skipped.
 */
export type SandboxProtectionStatus =
  | { status: 'not-applicable' }
  | { status: 'applied'; appliedCount: number; skipped: { rel: string; reason: string }[] }

/** Full sandbox state of THIS window's project (Docker rail view + gates). */
export interface SandboxStatus {
  engine: SandboxEngineName | null
  engineState: SandboxEngineState
  engineVersion: string | null
  /** Operator toggle for this project (sandbox.json, never a repo file). */
  enabled: boolean
  /** Bind-mount the real project, or mount an ephemeral clone (M3). */
  mode: SandboxWorkMode
  /** Deterministic kory-sbx-<hash12> container of this project. */
  containerName: string
  containerState: 'running' | 'stopped' | 'missing'
  /** Credentials present in the shared auth volume; null = cannot probe. */
  authed: boolean | null
  image: string
  /** Image found locally; null = not probed yet (engine down). */
  imagePresent: boolean | null
  /** Ports published at create (127.0.0.1 only); rebuild to apply changes. */
  ports: number[]
  /**
   * Globs selecting extra files duplicated into the clone on top of the
   * tracked ones (copy mode) -- matches any file under the project root,
   * not only ones actually gitignored.
   */
  copyIgnored: string[]
  /** Host path of the ephemeral clone, or null outside copy mode. */
  copyDir: string | null
  /** Configured globs that matched no file (typo surfacing). */
  copyUnmatched: string[]
  /**
   * Matched files (or, for a glob whose whole target is a walk-skipped bulk
   * dir, the glob text itself) blocked by the copy deny-list -- distinct
   * from copyUnmatched: a refusal, not a typo. Render as a count, not a raw
   * dump: an unbounded glob can list a very large number of entries.
   */
  denied: string[]
  /** Operator-config entries projected into the container, or null. */
  projection: string | null
  /**
   * False after the operator's "Remove" in the projection card: the global
   * config is scrubbed from the container and no longer copied at start.
   * Generate re-enables.
   */
  projectionEnabled: boolean
  /**
   * Entry names present in ~/.claude/sandbox-overrides (the overlay wins over
   * the host copy at projection time). Host-side state, live even with no
   * container: this is what tells the Docker view "Generate" actually wrote
   * something -- `projection` above only changes at the NEXT container start.
   */
  overlay: string[]
  /** Projected hooks that cannot run in the Linux container + stray overrides. */
  hookWarnings: string[]
  /** Broker reachable FROM the container (real curl probe); null = unknown. */
  brokerBridge: boolean | null
  /** Days between this container's creation and a NEWER image, else null. */
  driftDays: number | null
  busy: boolean
  /** Card 9e529177: mount-mode protection sub-policy state, see SandboxProtectionStatus. */
  protection: SandboxProtectionStatus
  /**
   * Card e35b2791 round 2: a CLOSED, CUMULABLE set of reasons this
   * RUNNING/STOPPED container needs a rebuild to pick up a security fix.
   * Deliberately NOT a single boolean or a free-form string: an operator
   * reading one generic "rebuild needed" message during an actual
   * cross-project run-dir sharing incident would read a FALSE cause off a
   * message written for a different reason (missing `:ro` protection
   * binds) -- worse than no signal, because it reads as low-urgency comfort
   * text instead of the security incident it actually is. Both reasons can
   * be true at once on the same old container; SandboxView.tsx renders one
   * line per reason present, each with its own i18n key. Empty array = no
   * rebuild needed. Always empty when no container exists yet.
   */
  rebuildReasons: SandboxRebuildReason[]
  /** Last lifecycle error, operator-readable, or null. */
  error: string | null
}

/**
 * Card e35b2791 round 2: 'missing-protection-binds' = the mount-mode `:ro`
 * protection plan (card 9e529177) has paths the container's Mounts don't
 * carry read-only yet. 'shared-run-dir' = the container's `/kory-run` mount
 * still points at the pre-e35b2791 directory shared read-write by every
 * sandboxed project on the machine (card e35b2791's own fix). A closed union
 * on purpose -- a free-form string would end up constructed at one call site
 * and read/compared at another, drifting silently.
 */
export type SandboxRebuildReason = 'missing-protection-binds' | 'shared-run-dir'

/** One kory-sbx container in the cross-project rail listing. */
export interface SandboxContainerInfo {
  name: string
  /** Raw engine state (running / exited / created…). */
  state: string
  image: string
  /** Engine-reported age ("2 days ago"), display only. */
  age: string
  /** Host project dir from the kory.project label. */
  project: string
  /** True for THIS window's project container. */
  current: boolean
}

// ----- Embedded browser (PLAN D1, experimental) -----

/**
 * One candidate CSS selector for a picked element, best-first. `qa` = test
 * attribute ([data-testid=…] and friends), `id` = #id, `css` = structural path.
 */
export interface ElementSelector {
  type: 'qa' | 'attr' | 'id' | 'css'
  value: string
}

/**
 * Payload sent by the webview guest preload (browser-inspect.ts) over
 * `ipcRenderer.sendToHost('deck:element-selected', …)` when the operator picks
 * a DOM element in inspect mode. Composed into a prompt for the paired agent.
 * The same shape travels over the design endpoint (D2b) when the pick comes
 * from an EXTERNAL app running the deck-design client script.
 */
export interface ElementPick {
  tagName: string
  id: string
  classes: string[]
  /** Trimmed innerText, capped (guest side) to keep prompts small. */
  text: string
  /** Candidate selectors, best-first; [0] feeds the prompt. */
  selectors: ElementSelector[]
  /** Rendered size in CSS px at pick time. */
  width: number
  height: number
  pageUrl: string
  // ----- Enriched context (Chantier OD1, DESIGN-ORCA-DOOP-ADOPTION.md §3.1).
  // All OPTIONAL: an older external deck-design.js bundle (pre-OD1) posts a
  // pick without these, and both consumers (BrowserView/App prompt
  // composition, design-endpoint's sanitizePick) must keep working on their
  // absence -- never defaulted to an empty object/array, stays undefined.
  /** Viewport CSS px at pick time, rounded. */
  x?: number
  y?: number
  /** True when `position: fixed|sticky` anywhere in the element's ancestry. */
  isFixed?: boolean
  /** Explicit `role` attribute; omitted (not '') when absent. */
  role?: string
  /** aria-label > aria-labelledby (resolved) > alt > title, first non-empty, trimmed, capped. */
  accessibleName?: string
  /** Allowlisted attributes only (PICK_ATTRIBUTE_ALLOWLIST + aria-*), values capped/redacted. */
  attributes?: Record<string, string>
  /** Computed styles, filtered of their default values -- signal only. */
  styles?: Record<string, string>
  /** outerHTML, capped; omitted entirely (not truncated) when it contains a secret. */
  html?: string
  /** Trimmed text of nearby sibling elements. */
  nearbyText?: string[]
  /** Readable ancestor labels, outermost first. */
  ancestors?: string[]
  // ----- React context (Chantier OD3, DESIGN-ORCA-DOOP-ADOPTION.md §3.2).
  // Both OPTIONAL for the same reasons as the OD1 block above, plus a THIRD:
  // React's dev-only fiber debug metadata (`_debugSource`) was removed in
  // React 19, so even a DEV build of a React-19+ app yields neither field.
  // Absent outside React, in a PRODUCTION build, or on React 19+ -- never an
  // error, this is the expected common case.
  /** Surrounding component stack, outermost first, e.g. `<App> > <ProductCard>`. */
  reactComponents?: string
  /** `path/to/Component.tsx:42:7`, from React's dev-only debug source metadata. */
  sourceFile?: string
}

/** An external-app pick forwarded by the design endpoint (PLAN D2b). */
export interface DesignPickEvent {
  /** Free-text app label sent by the client script ('' when omitted). */
  source: string
  pick: ElementPick
}

// ----- Annotate review (Chantier OD5, DESIGN-ORCA-DOOP-ADOPTION.md §3.5) -----
// One pick = one prompt, generalized to a REVIEW: the operator pins up to
// PICK_BUDGET.annotationsMaxPerPage elements, each with its own comment +
// intent + priority, then sends ONE structured Design Feedback message
// (shared/pick-prompt.ts's formatAnnotationsReport). Mirror of orca's
// BrowserAnnotationIntent/Priority (MIT, shared/browser-grab-types.ts) --
// values travel in the report text verbatim (agent-facing), only their UI
// labels go through i18n.

/** What the operator wants done with the pinned element. */
export type PickAnnotationIntent = 'fix' | 'change' | 'question' | 'approve'

/** How urgent the annotation is. */
export type PickAnnotationPriority = 'blocking' | 'important' | 'suggestion'

/** One pinned element of an in-progress design review, editable in the panel until sent or discarded. */
export interface PickAnnotation {
  id: string
  comment: string
  intent: PickAnnotationIntent
  priority: PickAnnotationPriority
  pick: ElementPick
  /** Best-effort auto screenshot path (captureElementShot, same as the single-pick flow); absent on failure. */
  screenshotPath?: string
}

/** One capturable OS window/screen for the browser view's Window mode (D2a). */
export interface WindowSource {
  id: string
  name: string
  /** Small preview (PNG data URL) for the picker. */
  thumbnail: string
}

// ----- Broker reachability (PLAN O5) -----
// Mirror of main/broker-client.ts BrokerStatusEvent (kept import-free).

export interface BrokerStatusEvent {
  up: boolean
  /** Epoch ms of the last up/down transition. */
  since: number
  /** Message of the failure that opened the outage (null while up). */
  lastError: string | null
}

// ----- Activity journal (PLAN C14) -----
// Mirror of main/journal.ts shapes (kept import-free for bun tests).

export type JournalKind =
  | 'session'
  | 'quota'
  | 'attention'
  | 'worktree'
  | 'announce'
  | 'dispatch'
  | 'review'
  | 'checkpoint'
  | 'graph'
  | 'error'

export interface JournalEntry {
  id: number
  /** Epoch ms. */
  at: number
  kind: JournalKind
  text: string
}

/** One row of the Worktrees view (PLAN C6): git state + attached session. */
export interface WorktreeRow {
  path: string
  branch: string | null
  /** The repo's main working tree (never removable from the Deck). */
  main: boolean
  /** Uncommitted changes count. */
  dirty: number
  /** Last commit "subject (relative date)", or null. */
  lastCommit: string | null
  /** Live Deck session running in this worktree, if any (orphan otherwise). */
  sessionId: string | null
  sessionName: string | null
}

// ----- Diff / review (PLAN C13) -----
// Mirror of main/diff-service.ts shapes (that module stays import-free for its
// bun unit tests). Keep in sync.

export interface DiffFile {
  path: string
  /** Added lines; null for binary and untracked files. */
  additions: number | null
  deletions: number | null
  untracked: boolean
}

export interface SessionDiff {
  /** Working tree vs HEAD + untracked files. */
  uncommitted: DiffFile[]
  /** Commits of the branch vs `base` (merge-base); null when no base. */
  branch: DiffFile[] | null
  base: string | null
  /** Raw unified diff, capped (see truncated). */
  text: string
  truncated: boolean
}

/** Unified diff of a single file (PLAN GX1). */
export interface FileDiff {
  path: string
  text: string
  truncated: boolean
}

// ----- File explorer (PLAN GX4/GX5) -----
// Mirror of main/explorer-service.ts shapes (that module stays import-free
// for its bun unit tests). Keep in sync.

/** One browsable root of the 📁 view (project dir, worktree or session cwd). */
export interface ExplorerRoot {
  path: string
  label: string
  main: boolean
}

export interface ExplorerEntry {
  name: string
  dir: boolean
  /** Byte size (0 for directories). */
  size: number
}

export interface ExplorerFile {
  /** UTF-8 content, '' for binary files, capped main-side. */
  content: string
  truncated: boolean
  binary: boolean
  size: number
}

/** One question/answer pair of the help popup (replayed for continuity, C9). */
export interface HelpExchange {
  question: string
  answer: string
}

/**
 * Code selection attached to a help question or a roadmap draft (PLAN GX7):
 * what the operator selected in the Files viewer. Travels to the assistant
 * through the SYSTEM side (context file), never the command line.
 */
export interface HelpSelection {
  /** Root-relative path of the viewed file. */
  file: string
  startLine: number
  endLine: number
  text: string
}

/**
 * One message an agent sent to the reserved 'operator' peer (PLAN C12), drained
 * from the broker by the main-process poll and pushed to the renderer inbox.
 */
export interface InboxMessage {
  /** Broker message id (unique, monotonic — safe as a React key). */
  id: number
  /** Sender peer_id snapshot ('<gone>' when the peer row was purged). */
  from: string
  text: string
  /** ISO timestamp (broker sent_at). */
  sentAt: string
}

/**
 * Unified Courrier entry (ask_operator lot, Etape A): the three families the
 * inbox panel renders are STRUCTURALLY distinct, not flagged by a boolean —
 * `kind` discriminates a plain peer message (repliable, uncorrelated,
 * `onInboxMessages`/'inbox:new'), a non-repliable event (no recipient, no
 * current producer yet), and a correlated blocking question whose answer
 * unblocks a waiting agent (`onPendingApprovals`/'approvals:pending'). The
 * union is a client-side (renderer) merge of two independent wire channels —
 * neither channel carries this shape itself.
 */
export type InboxEntry =
  | { kind: 'message'; message: InboxMessage }
  | { kind: 'event'; id: string; text: string; at: string }
  | { kind: 'approval'; approval: Approval }

/**
 * The subset of InboxEntry an ACK is meaningful for. Acknowledging a
 * blocking question would leave its agent waiting forever without ever
 * answering it, so `inboxAck` is typed to make that call SITE unrepresentable
 * (a TS error, not a runtime guard) rather than merely absent from the UI.
 */
export type AckableInboxEntry = Extract<InboxEntry, { kind: 'message' | 'event' }>

/**
 * The three Courrier read-states (card 8fdac3dd: "trois etats, a ne surtout
 * pas fondre en deux"). All three are durable across a Deck restart: an
 * entry absent from `inboxAckState()`'s map is 'unread' by construction (no
 * explicit 'unread' key is ever written), 'seen' means opened but not yet
 * resolved, 'acked' means dismissed. Never valid for a family-3 entry — see
 * `AckableInboxEntry`.
 */
export type InboxAckStatus = 'seen' | 'acked'

/**
 * THE single producer of the ack-state storage key (main's ipc.ts and
 * inbox-store.ts, and the renderer reading `inboxAckState()`'s map, must all
 * call this — not reimplement it). Widened past the bare broker id on
 * review: `InboxMessage.id` is an integer minted by the BROKER's own DB,
 * which can be wiped/reinstalled/swapped independently of this Deck's local
 * ack file. A key of just the id would then silently let a stale ack mask a
 * brand new message reusing a low id after a reset. `sentAt` is the
 * broker's own timestamp and is not reissued on a DB reset, so it
 * disambiguates a replayed id.
 */
export function inboxEntryKey(entry: AckableInboxEntry): string {
  // Runtime-validated, not just TS-narrowed: IPC's structured clone has no
  // type system of its own, so a hand-built payload bypassing the compiler
  // could still arrive shaped like an approval. Reject rather than fall
  // through to a garbage `evt:undefined:undefined` key.
  if (entry && entry.kind === 'message' && typeof entry.message?.id === 'number') {
    return `msg:${entry.message.sentAt}:${entry.message.id}`
  }
  if (entry && entry.kind === 'event' && typeof entry.id === 'string') {
    return `evt:${entry.at}:${entry.id}`
  }
  throw new Error('inboxEntryKey: unrecognized entry shape')
}

/**
 * One pending graph draft: an agent-escalated question parked durably on the
 * broker, waiting for the operator to open it in the graph view. Unlike the
 * inbox drain, the poll is non-destructive — a Deck restart loses nothing.
 */
export interface DeckGraphDraft {
  id: string
  from: string
  title: string
  prompt: string
  /** ISO timestamp (broker created_at). */
  createdAt: string
}

/** Result of opening a draft: the created graph doc + its pre-filled node. */
export interface GraphDraftOpenResult {
  docId: string
  nodeId: string
}

// ----- IPC channel payloads -----

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  exitCode: number
}

export interface SessionThinkingEvent {
  id: string
  /** Ternary activity state (card f8082208) -- see SessionRuntime.activity. */
  state: 'working' | 'idle' | 'unknown'
}

export interface SessionAttentionEvent {
  id: string
  waiting: boolean
  /**
   * Set when the operator dismissed the flag by hand rather than answering
   * the prompt. Consumers must NOT read `waiting: false` as "the operator
   * responded" when this is true: the remote approval, if any, is still
   * open. Mirrors AttentionEvent in main/attention.ts, which is the producer
   * side; ipc.ts rebroadcasts that same object on `session:attention`, so
   * this declaration is what carries the distinction to the renderer and to
   * the companion app.
   */
  manual?: boolean
}

export interface SessionQuotaEvent {
  id: string
  /** True while at the limit screen; false when the episode ends. */
  limited: boolean
  /** Epoch ms of the announced reset, or null when unknown/cleared. */
  resetAt: number | null
  /** Set on the event fired right after the auto-continue was injected. */
  resumed?: boolean
}

/** The typed surface exposed on `window.api` by the preload script. */
/** Companion LAN bridge status (PLAN MB1/MB2), main ⇄ renderer. */
export interface CompanionInfo {
  running: boolean
  /** https URL of the served UI (no token — the QR appends `#t=`). */
  url: string | null
  /** Pairing token to embed in the QR; null once consumed or stopped. */
  pairingToken: string | null
  /**
   * SHA-256 of the served certificate, lowercase hex — travels in the QR as
   * `&f=` so the Android shell can PIN this host (MB6). Not a secret: it is
   * the public cert's digest, and the cert is presented to every visitor.
   */
  certFingerprint: string
  clients: number
}

/** Non-secret metadata for a paired companion device (Lot 2: list + revoke). */
export interface CompanionDevice {
  /** Stable, non-secret id for this run — safe to show / pass to revoke. */
  id: string
  /** Last address the device connected from. */
  addr: string
  /** When the device first paired this run (ms epoch). */
  pairedAt: number
  /** Last hello (pair or resume) from this device (ms epoch). */
  lastSeenAt: number
}

// ----- Usage limits (usage modal) -----

/** Frontier CLIs whose subscription quota gauges the usage modal can show. */
export type UsageProviderId = 'claude' | 'codex' | 'antigravity'

/**
 * One quota window gauge. `key` picks the i18n label family; `label` carries
 * provider-supplied detail (model or pool name) appended to it when present.
 */
export interface UsageWindow {
  key: 'session' | 'week' | 'week-model'
  label: string | null
  /** 0–100, already clamped main-side. */
  usedPercent: number
  /** Epoch ms of the window reset, or null when the provider omitted it. */
  resetsAt: number | null
}

/** Claude extra-usage credit block (null members = not exposed by the plan). */
export interface UsageCredits {
  enabled: boolean
  used: number | null
  limit: number | null
  utilization: number | null
}

export interface UsageProviderReport {
  provider: UsageProviderId
  /**
   * 'ok' = gauges present · 'not-connected' = CLI installed but no usable
   * credentials · 'error' = fetch failed (detail in `error`). Providers whose
   * CLI is not installed are simply absent from the snapshot.
   */
  status: 'ok' | 'not-connected' | 'error'
  plan: string | null
  windows: UsageWindow[]
  credits: UsageCredits | null
  /** True when values come from a local fallback snapshot (may be stale). */
  stale: boolean
  /** Raw detail for the 'error' status (already user-safe, no tokens). */
  error: string | null
}

export interface UsageSnapshot {
  fetchedAt: number
  providers: UsageProviderReport[]
  /**
   * Providers this app run actually drew down (live tiles + inference
   * targets) — the amphora gauge averages ITS remaining session quota over
   * these (falling back to every reporting provider when empty).
   */
  usedProviders: UsageProviderId[]
}

export interface DeckApi {
  // sessions
  listSessions(): Promise<SessionRuntime[]>
  createSession(input: CreateSessionInput): Promise<SessionRuntime>
  removeSession(id: string): Promise<void>
  renameSession(id: string, name: string): Promise<void>
  setSessionColor(id: string, color: string): Promise<void>
  restartSession(id: string): Promise<SessionRuntime>
  /** Per-session quota auto-resume override (true/false); see SessionDef.autoResume. */
  setSessionAutoResume(id: string, enabled: boolean): Promise<void>
  /**
   * Manual escape hatch for a stuck "needs you" flag (attention.ts, card
   * 4f0143ff): clears SessionRuntime.needsAttention and the detector's
   * per-session buffer. No-op if the session is not currently flagged.
   */
  clearAttention(id: string): Promise<void>
  /** Designate a session as the window's team-lead (unique, PLAN C10). */
  setLead(id: string): Promise<void>
  /** The colour the next auto-assigned session would receive (create preview). */
  peekNextColor(): Promise<string>
  /** Reorder the session list (sidebar drag-and-drop); drives sidebar + tiles. */
  reorderSessions(ids: string[]): Promise<void>
  /** "New (clear)": close all sessions and return the window to the empty state. */
  newClear(): Promise<void>

  // pty io
  ptyInput(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void

  // config
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  pickDirectory(): Promise<string | null>

  // i18n
  getI18n(): Promise<I18nPayload>

  // workspaces (persistence / restore)
  listWorkspaces(): Promise<WorkspaceSummary[]>
  saveWorkspace(name?: string): Promise<WorkspaceSummary | null>
  restoreWorkspace(id: string): Promise<boolean>
  deleteWorkspace(id: string): Promise<void>
  currentWorkspace(): Promise<string | null>

  // create-menu data
  listAgents(): Promise<string[]>
  getLaunchConfig(): Promise<LaunchConfig>
  saveLaunchConfig(cfg: LaunchConfig): Promise<void>

  // announce (outbound megaphone): broadcast a free-text operator message to all
  // peers in the active group. Returns the number of peers it reached.
  announce(text: string): Promise<number>

  // roadmap (shared per-project backlog, PLAN C3)
  roadmapList(filters: RoadmapListFilters): Promise<RoadmapItem[]>
  /**
   * Card 3b0fda5f: the filter/search UI's plural+FTS5+facets query. Distinct
   * from roadmapList (never touched by this card -- helpSnapshot() keeps
   * calling roadmapList with an empty filter, unaffected by this addition).
   */
  roadmapSearch(query: RoadmapQuery): Promise<RoadmapSearchResult>
  roadmapUpsert(fields: RoadmapUpsertFields): Promise<RoadmapItem>
  roadmapArchive(id: string): Promise<RoadmapItem>
  /**
   * Workflow lane: atomically rewrite the dispatch queue to this id order.
   * `waves` (roadmap card 42edc88b phase 1) is optional and additive: groups
   * of `ids` sharing a queue position (a tie). Omitted by every current
   * caller -- the lane UI still derives a flat order.
   */
  roadmapReorder(ids: string[], waves?: string[][]): Promise<RoadmapItem[]>
  /** Send the first queued item to the team-lead (PLAN C15). */
  roadmapDispatch(): Promise<DispatchResult>
  /** Context wand (PLAN C21): read-only haiku pass drafting the context field. */
  roadmapWand(draft: RoadmapWandDraft): Promise<string>
  /** Operator stop on an in_progress item (PLAN K3): notify agents + unlock. */
  roadmapStop(id: string): Promise<StopResult>
  /** Assign an item to one live peer via a targeted announce (PLAN K6). */
  roadmapAssign(id: string, peerId: string): Promise<AssignResult>
  /** Pick a plan file and spawn a one-shot import agent (PLAN C7). */
  importPlan(): Promise<boolean>
  /**
   * Fleet-wide stop broadcast (card aaf4537d lot 3): pause/soft/hard every
   * live tile at once. Companion-tier 3 (trust-changing, remote-blocked).
   *
   * `peerIds` absent targets every live tile (header button); present and
   * non-empty targets only those peers (e.g. escalating soft-stop
   * stragglers to hard without also releasing cards of agents who already
   * complied); present-and-empty is refused main-side, never "everyone".
   */
  agentsStop(mode: StopMode, peerIds?: string[]): Promise<StopReport>
  /** Live/busy/paused tile counts (card aaf4537d lot 3). Companion-tier 0. */
  agentsStopState(): Promise<StopState>

  // worktrees (PLAN C4/C6)
  /** Remove a worktree dir (branch is kept; git refuses dirty trees). */
  removeWorktree(path: string): Promise<void>
  /** All worktrees of the project with git status + attached session. */
  listWorktrees(): Promise<WorktreeRow[]>
  /** Create a fresh worktree on a NEW branch (init hook runs in background). */
  createWorktree(branch: string): Promise<void>

  // activity journal (PLAN C14)
  /** Entries oldest-first; pass a kind to filter, null/undefined for all. */
  journalList(kind?: JournalKind | null): Promise<JournalEntry[]>
  /** Save the journal as plain text (save dialog); returns the path or null. */
  journalExport(): Promise<string | null>

  // error reporting (PLAN O4): renderer failures land in main.log + journal.
  reportError(scope: string, message: string): void

  // broker reachability (PLAN O5): drives the red banner.
  getBrokerStatus(): Promise<BrokerStatusEvent>
  /** Force an immediate broker poll (banner Retry button). */
  retryBroker(): Promise<void>
  onBrokerStatus(cb: (status: BrokerStatusEvent) => void): () => void

  // diff / review (PLAN C13)
  /** Full diff picture of a dir (uncommitted + branch-vs-main for worktrees). */
  collectDiff(dir: string): Promise<SessionDiff>
  /** Diff of ONE repo-relative file of the dir (Git rail view, PLAN GX2). */
  collectFileDiff(dir: string, path: string): Promise<FileDiff>
  /** Spawn a one-shot review agent on the dir's diff (reports to the lead). */
  reviewDiff(dir: string): Promise<boolean>

  // file explorer (PLAN GX5): READ-ONLY, roots re-validated main-side.
  /** Browsable roots: project dir + worktrees + live session cwds. */
  explorerRoots(): Promise<ExplorerRoot[]>
  /** Entries of one directory (lazy tree; `rel` is root-relative). */
  explorerList(root: string, rel: string): Promise<ExplorerEntry[]>
  /** Read one file (capped, binary-sniffed). */
  explorerRead(root: string, rel: string): Promise<ExplorerFile>

  // embedded browser (PLAN D1): absolute path of the webview guest preload.
  getBrowserPreloadPath(): Promise<string>
  /** Screenshot of the browser webview (by webContents id) as a PNG data URL. */
  captureBrowser(webContentsId: number): Promise<string | null>
  /** Persist an annotated screenshot; returns the absolute file path. */
  saveAnnotation(dataUrl: string): Promise<string | null>
  /** Persist a finished REC screen recording; returns the absolute file path. */
  saveRecording(data: Uint8Array, ext: 'mp4' | 'webm'): Promise<string | null>
  /**
   * Run a REC scripted scenario: a one-shot demo-driver agent (target.cli
   * 'claude' only) drives the embedded webview while the renderer records.
   * Resolves with the agent's closing summary when the scenario ends.
   */
  runDemoScenario(
    webviewId: number,
    scenario: string,
    target: import('./graph').ModelTarget
  ): Promise<string>
  /** Cancel the running demo scenario (REC stop while a scenario runs). */
  cancelDemoScenario(): Promise<boolean>
  /** Capturable OS windows/screens for the Window mirror mode (D2a). */
  listCaptureWindows(): Promise<WindowSource[]>
  /** Full-size still of one window/screen; null when gone. */
  captureWindow(id: string): Promise<{ dataUrl: string; title: string } | null>

  // supervisor (PLAN C5): spawn (or return) the Home supervisor session.
  ensureSupervisor(): Promise<SessionRuntime>

  // help assistant (PLAN C9): one throwaway `claude -p` question, view-aware.
  // `selection` (PLAN GX7): optional Files-view snippet, injected into the
  // app-composed snapshot (system side).
  askHelp(
    question: string,
    view: DeckView,
    transcript: HelpExchange[],
    selection?: HelpSelection
  ): Promise<string>
  /** Resume digest (PLAN C17): fixed prompt + globally-configured sources. */
  askDigest(): Promise<string>

  // templates (portable team recipes)
  listTemplates(): Promise<TemplateSummary[]>
  /** Full template content for the composer (PLAN C18); null when unreadable. */
  readTemplateFile(path: string): Promise<import('./template').SessionTemplate | null>
  /** Validate + write a composer-authored template; returns the path. */
  writeTemplateFile(
    name: string,
    local: boolean,
    tpl: import('./template').SessionTemplate
  ): Promise<string>
  /** Export the current sessions as a template; `local` => project dir, else global. Returns the written path. */
  exportTemplate(name: string, local: boolean): Promise<string | null>
  /** Instantiate a template by path: 'append' adds to current sessions, 'replace' clears first. Returns count. */
  applyTemplate(path: string, mode: 'append' | 'replace'): Promise<number>
  /** Delete a template file by path. Returns true if a file was removed. */
  deleteTemplate(path: string): Promise<boolean>

  // snippets (reusable prompts, PLAN C22): project scope shadows global.
  listSnippets(): Promise<SnippetSummary[]>
  /** Write a snippet (`local` => project dir, else global). Returns the path. */
  saveSnippet(name: string, local: boolean, text: string): Promise<string>
  /** Delete a snippet file by path. Returns true if a file was removed. */
  deleteSnippet(path: string): Promise<boolean>

  // graph chat (EXPLORATION-graph-chat C23-C27), per-project, desktop-local.
  /** All graph docs of the current project, newest first. */
  graphList(): Promise<import('./graph').GraphDoc[]>
  /** Create an empty graph; returns the persisted doc. */
  graphCreate(name: string): Promise<import('./graph').GraphDoc>
  /** Delete a graph by id. Returns true if one was removed. */
  graphDelete(id: string): Promise<boolean>
  /** Validate + persist a whole doc (renderer-side edits). Returns the stamped doc. */
  graphSave(doc: import('./graph').GraphDoc): Promise<import('./graph').GraphDoc | null>
  /** Context inspector: the exact compiled context of a node. */
  graphCompile(
    graphId: string,
    nodeId: string
  ): Promise<{ system: string; prompt: string; merge: boolean }>
  /**
   * Provider catalogs for the model pickers (C29): frontier providers gated
   * on CLI detection, local providers with dynamically discovered models.
   * `refresh` re-probes the CLIs and endpoints.
   */
  modelCatalogs(refresh?: boolean): Promise<import('./models').ProviderCatalog[]>
  /**
   * Subscription usage gauges of the installed frontier CLIs (usage modal):
   * detected providers only, cached main-side; `refresh` bypasses the cache
   * and re-probes the binaries.
   */
  usageRead(refresh?: boolean): Promise<UsageSnapshot>
  /** Run inference on a user node (fan-out targets + optional battle judge). */
  graphInfer(
    graphId: string,
    req: {
      nodeId: string
      targets: import('./graph').ModelTarget[]
      battle: boolean
      judge?: import('./graph').ModelTarget
    }
  ): Promise<import('./graph').GraphDoc>
  /**
   * Open a pending graph draft: marks it opened broker-side, creates a graph
   * doc with the pre-filled (unsubmitted) prompt node, returns both ids for
   * navigation. Inference stays a manual operator action.
   */
  graphDraftOpen(draft: DeckGraphDraft): Promise<GraphDraftOpenResult>
  /** Persisted operator-inbox history (oldest first) for startup hydration. */
  inboxHistory(): Promise<InboxMessage[]>
  /**
   * Answer a pending/expired_notif blocking question as the operator (family
   * 3): claims it broker-side and delivers to the waiting agent. `false`
   * means another channel (phone/telegram/discord) won the race, not a
   * failure — mirrors the existing local-claim semantics in index.ts.
   */
  approvalReply(id: string, text: string): Promise<boolean>
  /**
   * Decline a pending/expired_notif blocking question. This IS an answer
   * (settles the ticket, unblocks the agent with a refusal) — never an ack,
   * which would leave the agent waiting indefinitely.
   */
  approvalDecline(id: string): Promise<boolean>
  /**
   * Allow a pending/expired_notif 'permission' approval: mirrors
   * approvalDecline exactly (card c7df3781), the other verdict. Distinct
   * from approvalReply — the CLI's Ink chooser at a permission prompt does
   * not accept free text, so the answer must be `answerKind: 'allow'`
   * (a bare Enter, see buildKeystrokes), never the option's label text.
   */
  approvalAllow(id: string): Promise<boolean>
  /**
   * Reply to an ordinary (family 1) inbox message: not correlated, not a
   * resolution — a plain targeted announce. Resolves to the recipient
   * count from the underlying /announce call (0 or 1 for a single named
   * peer in practice), not a boolean: "sent to nobody" (the peer went
   * offline between the list refresh and the reply) is real information a
   * boolean would destroy.
   */
  inboxReply(toPeerId: string, text: string): Promise<number>
  /**
   * Persisted local state of every family 1/2 Courrier entry, keyed by the
   * same synthetic key `inboxMarkSeen`/`inboxAck` derive (see
   * `InboxAckStatus`). Read once at startup; an absent key means unread. The
   * THIRD state (seen-but-not-acked) is durable on purpose — the acceptance
   * criterion is "survives a Deck restart", not just "survives a re-render".
   */
  inboxAckState(): Promise<Record<string, InboxAckStatus>>
  /**
   * Mark a family 1/2 Courrier entry seen (viewed, still pending an ack).
   * Never downgrades an already-acked entry back to seen.
   */
  inboxMarkSeen(entry: AckableInboxEntry): Promise<void>
  /**
   * Acknowledge a family 1/2 Courrier entry. Typed to `AckableInboxEntry` so
   * a family-3 (blocking question) entry cannot even be PASSED here — see
   * that type's doc comment.
   */
  inboxAck(entry: AckableInboxEntry): Promise<void>
  /**
   * Manual "delete this one" gesture (Courrier lot 1E, card 1e81ee7b): a
   * THIRD state distinct from Close (inboxMarkSeen/inboxAck's local
   * read-state) and Ack — never a reinterpretation of either. Deletes
   * broker-side (global: every Deck attached to the group sees it gone, not
   * just this window) and from the local journal. Returns the broker's
   * reported deleted count; an empty or unknown-id `ids` is a 0-effect
   * no-op, never an error. Fires `onInboxCleared` so every subscriber
   * (including this window) re-hydrates from `inboxHistory()`.
   */
  inboxDelete(ids: number[]): Promise<number>

  // companion LAN bridge (PLAN MB1/MB2) — desktop window only; a remote
  // client gets 'remote-blocked' on all three (physical-presence actions).
  companionStart(): Promise<CompanionInfo>
  companionStop(): Promise<CompanionInfo>
  companionStatus(): Promise<CompanionInfo>
  /** Remote-approval channels (PLAN N3/N4) and their live state. */
  approvalChannels(): Promise<ApprovalChannelStatus[]>
  /**
   * Enrol a channel with the broker; returns what the operator still has to do.
   *
   * Telegram and Discord are enrolled with a bot token. ntfy has no bot: it
   * takes the relay's address (`server`) and an optional access token, and the
   * broker mints the topics — hence one call shape covering both (PLAN N5).
   */
  approvalConnect(
    kind: 'telegram' | 'discord' | 'ntfy',
    args: { token?: string; server?: string }
  ): Promise<{
    kind: string
    label: string
    hint: string
    pairing_code: string
    /** Telegram deep link (t.me/<bot>?start=<code>) — rendered as a QR. */
    deep_link: string
    /** Discord OAuth2 invite URL: the bot must share a server to DM you. */
    invite_url: string
    /**
     * ntfy only: the QR payload the Koryphaios app scans. A CREDENTIAL — it
     * carries the two topics and the access token — so the renderer shows it
     * on demand and drops it, exactly like the multi-PC link code.
     */
    mobile_payload: string
  }>
  approvalDisconnect(kind: 'telegram' | 'discord' | 'ntfy'): Promise<{ removed: number }>
  /** One-shot payload for linking another PC to this operator identity. */
  approvalEnrolmentExport(): Promise<ApprovalEnrolmentPayload | null>
  approvalEnrolmentApply(payload: unknown): Promise<boolean>
  /** Paired devices (Lot 2) — desktop window only. */
  companionDevices(): Promise<CompanionDevice[]>
  /** Revoke one paired device by id (lost-phone kill switch) — desktop only. */
  companionRevoke(id: string): Promise<boolean>
  /** Revoke every paired device; returns the count — desktop only. */
  companionRevokeAll(): Promise<number>
  onCompanionChanged(cb: (info: CompanionInfo) => void): () => void
  /** A device authenticated (paired/resumed) — for an operator toast. */
  onCompanionDeviceConnected(cb: (e: { addr: string; kind: 'paired' | 'resumed' }) => void): () => void

  // sandbox mode (PLAN-SANDBOX SBX2–SBX5, M2/M3)
  /** `force` re-probes the engine (view refresh, after a Docker install). */
  sandboxStatus(force?: boolean): Promise<SandboxStatus>
  /**
   * Patch this project's sandbox settings (enable, work mode, ports, copied
   * extra-file globs). Rejected main-side while any session is live — the
   * whole set decides WHERE agents run and what travels with them.
   */
  sandboxPatchSettings(patch: SandboxSettingsPatch): Promise<SandboxStatus>
  /** Change the image every sandbox container is created from. */
  sandboxSetImage(image: string): Promise<SandboxStatus>
  /** Create/start the project container (idempotent; never removes anything). */
  sandboxEnsure(): Promise<SandboxStatus>
  /** Build the shipped Dockerfile in a utility terminal; returns its PTY id. */
  /** Build the base image, or the operator's custom image ('custom'). */
  sandboxImageBuild(variant?: 'base' | 'custom'): Promise<string>
  /** Read the operator's custom-image Dockerfile fragment ('' when unset). */
  sandboxCustomGet(): Promise<string>
  /** Persist the custom-image Dockerfile fragment (empty string clears it). */
  sandboxCustomSave(fragment: string): Promise<void>
  /**
   * Write ~/.claude/sandbox-overrides/settings.json from the host settings
   * with host-only hooks stripped. Throws 'overlay-exists' unless force.
   */
  sandboxOverlayGenerate(force: boolean): Promise<{ path: string; removed: string[] }>
  /**
   * Stop projecting the operator config and scrub it from the container
   * (persisted opt-out; Generate re-enables). Rejected while sessions are live.
   */
  sandboxProjectionRemove(): Promise<SandboxStatus>
  /**
   * Delete the image from the local engine. Refused while sessions are live;
   * refused by the engine itself while a container still references it. The
   * shared credentials volume is not affected.
   */
  sandboxImageRemove(): Promise<SandboxStatus>
  /**
   * Open a link in the operator's system browser. http(s) only -- rejected
   * main-side otherwise, because these links come from sandboxed CLIs and
   * remote pages and shell.openExternal launches any registered handler.
   */
  openExternal(url: string): Promise<void>
  /** Kill the image-build terminal (dialog closed mid-build). */
  sandboxBuildStop(): Promise<void>
  /** Wipe the credentials in the shared auth volume ("disconnect"). */
  sandboxAuthPurge(): Promise<SandboxStatus>
  /** Delete + re-create the ephemeral clone (copy mode). */
  sandboxResetCopy(): Promise<SandboxStatus>
  /** Re-run the container→host broker reachability probe. */
  sandboxProbeBridge(): Promise<boolean | null>
  /** Every kory-sbx container on the machine, current project first. */
  sandboxList(): Promise<SandboxContainerInfo[]>
  /** start/stop/remove/rebuild — guarded main-side (live sessions, name shape). */
  sandboxContainerAction(name: string, action: SandboxContainerAction): Promise<void>
  /**
   * First-run login (SBX3): ensures the container, spawns the auth terminal
   * (`claude` in the container) on a reserved utility PTY and returns its id —
   * or null when already authenticated.
   */
  sandboxAuthStart(): Promise<string | null>
  /** Kill the auth terminal (login finished or dialog cancelled). */
  sandboxAuthStop(): Promise<void>
  /** Fire-and-forget container pre-flight (create + projection) off the spawn path. */
  sandboxWarmUp(): Promise<void>
  /** Poll the credentials probe (auth dialog, every ~2 s). */
  sandboxAuthProbe(): Promise<boolean | null>
  onSandboxChanged(cb: (status: SandboxStatus) => void): () => void

  // events (return an unsubscribe fn)
  onPtyData(cb: (e: PtyDataEvent) => void): () => void
  onPtyExit(cb: (e: PtyExitEvent) => void): () => void
  onSessionsChanged(cb: (sessions: SessionRuntime[]) => void): () => void
  onSessionThinking(cb: (e: SessionThinkingEvent) => void): () => void
  onSessionQuota(cb: (e: SessionQuotaEvent) => void): () => void
  onSessionAttention(cb: (e: SessionAttentionEvent) => void): () => void
  /** Operator-inbox batch drained from the broker (PLAN C12), oldest first. */
  onInboxMessages(cb: (messages: InboxMessage[]) => void): () => void
  /**
   * The local Courrier journal was truncated or had entries removed by
   * `main` itself (Courrier lot 1D session purge on new/restore/apply-
   * replace, or lot 1E's inboxDelete) -- carries no payload, subscribers
   * re-hydrate via `inboxHistory()` rather than reconciling a diff.
   */
  onInboxCleared(cb: () => void): () => void
  /**
   * Full pending/expired_notif approval list for this operator (family 3,
   * non-destructive broker poll — same replace-whole-state contract as
   * onGraphDrafts, including an empty array being a valid full state).
   */
  onPendingApprovals(cb: (approvals: Approval[]) => void): () => void
  /** Full pending graph-draft list (non-destructive broker poll). */
  onGraphDrafts(cb: (drafts: DeckGraphDraft[]) => void): () => void
  /** Notification click on an inbox message: open the inbox panel. */
  onInboxOpen(cb: () => void): () => void
  /** Notification click: bring a session into view (agents view + selection). */
  onFocusSession(cb: (id: string) => void): () => void
  /** External-app element pick received by the design endpoint (D2b). */
  onDesignPick(cb: (event: DesignPickEvent) => void): () => void
  onConfigChanged(cb: (config: AppConfig) => void): () => void
  /** Fired when the Edit > Settings… menu item (or Ctrl/Cmd+,) is chosen. */
  onMenuSettings(cb: () => void): () => void
  /** Fired when the File > New (clear) menu item is chosen (renderer confirms). */
  onMenuNewClear(cb: () => void): () => void
  /** File menu workspace actions (renderer handles the UI/confirms). */
  onMenuSave(cb: () => void): () => void
  onMenuSaveAs(cb: () => void): () => void
  onMenuRestore(cb: () => void): () => void
  onMenuListWorkspaces(cb: () => void): () => void
  onMenuExportTemplate(cb: () => void): () => void
  /** File > New template… (card 290a14e2): opens the composer on a blank template. */
  onMenuNewTemplate(cb: () => void): () => void
  onMenuImportTemplate(cb: () => void): () => void
  /** Current workspace summary (or null after New clear) for the window title. */
  onWorkspaceCurrent(cb: (ws: WorkspaceSummary | null) => void): () => void
}
