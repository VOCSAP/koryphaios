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
  /** Heuristic busy/idle state (placeholder detector, see thinking.ts). */
  thinking: boolean
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
  /** Workflow-lane canvas height in px (resizable via its top-edge handle, persisted). */
  wfLaneHeight: number
  theme: 'dark' | 'light'
  fontSize: number
  /** Re-spawn persisted sessions on launch. */
  restoreSessions: boolean
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
  /** kind 'directive' (CT1): the app-executed command; null otherwise. */
  directive: RoadmapDirective | null
  /** kind 'directive' (CT1): peer_ids the command is injected into; [] otherwise. */
  target_peer_ids: string[]
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
  /** Title of the dispatched item when sent. */
  title?: string
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

export interface RoadmapListResponse {
  items: RoadmapItem[]
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
  /** Globs of gitignored files duplicated into the clone (copy mode). */
  copyIgnored: string[]
  /** Host path of the ephemeral clone, or null outside copy mode. */
  copyDir: string | null
  /** Configured globs that matched no file (typo surfacing). */
  copyUnmatched: string[]
  /** Operator-config entries projected into the container, or null. */
  projection: string | null
  /** Projected hooks that cannot run in the Linux container + stray overrides. */
  hookWarnings: string[]
  /** Broker reachable FROM the container (real curl probe); null = unknown. */
  brokerBridge: boolean | null
  /** Days between this container's creation and a NEWER image, else null. */
  driftDays: number | null
  busy: boolean
  /** Last lifecycle error, operator-readable, or null. */
  error: string | null
}

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
}

/** An external-app pick forwarded by the design endpoint (PLAN D2b). */
export interface DesignPickEvent {
  /** Free-text app label sent by the client script ('' when omitted). */
  source: string
  pick: ElementPick
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
  busy: boolean
}

export interface SessionAttentionEvent {
  id: string
  waiting: boolean
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
  saveWorkspace(name?: string): Promise<WorkspaceSummary>
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
  roadmapUpsert(fields: RoadmapUpsertFields): Promise<RoadmapItem>
  roadmapArchive(id: string): Promise<RoadmapItem>
  /** Workflow lane: atomically rewrite the dispatch queue to this id order. */
  roadmapReorder(ids: string[]): Promise<RoadmapItem[]>
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
   * gitignored globs). Rejected main-side while any session is live — the
   * whole set decides WHERE agents run and what travels with them.
   */
  sandboxPatchSettings(patch: SandboxSettingsPatch): Promise<SandboxStatus>
  /** Change the image every sandbox container is created from. */
  sandboxSetImage(image: string): Promise<SandboxStatus>
  /** Create/start the project container (idempotent; never removes anything). */
  sandboxEnsure(): Promise<SandboxStatus>
  /** Build the shipped Dockerfile in a utility terminal; returns its PTY id. */
  sandboxImageBuild(): Promise<string>
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
  onMenuImportTemplate(cb: () => void): () => void
  /** Current workspace summary (or null after New clear) for the window title. */
  onWorkspaceCurrent(cb: (ws: WorkspaceSummary | null) => void): () => void
}
