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
  theme: 'dark' | 'light'
  fontSize: number
  /** Re-spawn persisted sessions on launch. */
  restoreSessions: boolean
  /** UI language: '' = auto (OS), 'en' or 'fr'. Resolved by main/i18n.ts. */
  locale: string
  /** Rotating palette (hex) for auto-assigned session colours; editable in Settings (D12). */
  palette: string[]
  /** Remember custom (shared) scope secrets on this machine, encrypted (D8). */
  rememberScopeSecrets: boolean
  /**
   * Auto-resume sessions stopped by the usage limit: when a tile shows the
   * rate-limit screen, inject "continue" once the printed reset time passes
   * (quota.ts). Global default, overridable per session (SessionDef.autoResume).
   */
  autoResumeQuota: boolean
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
  /** Optional explicit colour (hex); falls back to the rotating palette. */
  color?: string
  /**
   * Operator-authored join-announce note (advanced create), broadcast to the
   * group once this session's peer_id resolves. Empty/undefined => the default
   * agent/model/effort summary is composed instead.
   */
  announce?: string
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

  // templates (portable team recipes)
  listTemplates(): Promise<TemplateSummary[]>
  /** Export the current sessions as a template; `local` => project dir, else global. Returns the written path. */
  exportTemplate(name: string, local: boolean): Promise<string | null>
  /** Instantiate a template by path: 'append' adds to current sessions, 'replace' clears first. Returns count. */
  applyTemplate(path: string, mode: 'append' | 'replace'): Promise<number>
  /** Delete a template file by path. Returns true if a file was removed. */
  deleteTemplate(path: string): Promise<boolean>

  // events (return an unsubscribe fn)
  onPtyData(cb: (e: PtyDataEvent) => void): () => void
  onPtyExit(cb: (e: PtyExitEvent) => void): () => void
  onSessionsChanged(cb: (sessions: SessionRuntime[]) => void): () => void
  onSessionThinking(cb: (e: SessionThinkingEvent) => void): () => void
  onSessionQuota(cb: (e: SessionQuotaEvent) => void): () => void
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
