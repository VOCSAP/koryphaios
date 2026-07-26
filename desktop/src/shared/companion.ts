// Companion bridge protocol (PLAN MB1): the DeckApi surface described as DATA
// so the preload (Electron IPC) and the remote WebSocket shim stay in lockstep.
// Pure module — no electron/node imports — so bun tests can verify coverage,
// channel uniqueness and the remote-security tables (EXPLORATION-mobile-lan
// §5.4: sensitivity is DECLARED, never detected at runtime).

import type { CompanionDevice, DeckApi } from './types'

export type CompanionMethodKind = 'invoke' | 'send' | 'event'

export interface CompanionMethodSpec {
  kind: CompanionMethodKind
  channel: string
}

/**
 * Every DeckApi method with its transport kind and channel. The `satisfies`
 * clause makes a missing or extra method a COMPILE error the moment DeckApi
 * moves — the shim and the bridge can then never drift silently.
 */
export const COMPANION_MANIFEST = {
  // sessions
  listSessions: { kind: 'invoke', channel: 'sessions:list' },
  createSession: { kind: 'invoke', channel: 'sessions:create' },
  removeSession: { kind: 'invoke', channel: 'sessions:remove' },
  renameSession: { kind: 'invoke', channel: 'sessions:rename' },
  setSessionColor: { kind: 'invoke', channel: 'sessions:set-color' },
  restartSession: { kind: 'invoke', channel: 'sessions:restart' },
  setSessionAutoResume: { kind: 'invoke', channel: 'sessions:set-auto-resume' },
  setLead: { kind: 'invoke', channel: 'sessions:set-lead' },
  peekNextColor: { kind: 'invoke', channel: 'sessions:peek-next-color' },
  reorderSessions: { kind: 'invoke', channel: 'sessions:reorder' },
  newClear: { kind: 'invoke', channel: 'app:new-clear' },

  // pty io (fire-and-forget)
  ptyInput: { kind: 'send', channel: 'pty:input' },
  ptyResize: { kind: 'send', channel: 'pty:resize' },

  // error reporting (fire-and-forget)
  reportError: { kind: 'send', channel: 'app:report-error' },

  // config / i18n
  getConfig: { kind: 'invoke', channel: 'config:get' },
  setConfig: { kind: 'invoke', channel: 'config:set' },
  pickDirectory: { kind: 'invoke', channel: 'dialog:pickDirectory' },
  getI18n: { kind: 'invoke', channel: 'i18n:get' },

  // workspaces
  listWorkspaces: { kind: 'invoke', channel: 'workspace:list' },
  saveWorkspace: { kind: 'invoke', channel: 'workspace:save' },
  restoreWorkspace: { kind: 'invoke', channel: 'workspace:restore' },
  deleteWorkspace: { kind: 'invoke', channel: 'workspace:delete' },
  currentWorkspace: { kind: 'invoke', channel: 'workspace:current' },

  // create-menu data
  listAgents: { kind: 'invoke', channel: 'agents:list' },
  getLaunchConfig: { kind: 'invoke', channel: 'launch:get' },
  saveLaunchConfig: { kind: 'invoke', channel: 'launch:set-global' },

  // announce
  announce: { kind: 'invoke', channel: 'announce:send' },

  // roadmap
  roadmapList: { kind: 'invoke', channel: 'roadmap:list' },
  roadmapUpsert: { kind: 'invoke', channel: 'roadmap:upsert' },
  roadmapArchive: { kind: 'invoke', channel: 'roadmap:archive' },
  roadmapReorder: { kind: 'invoke', channel: 'roadmap:reorder' },
  roadmapDispatch: { kind: 'invoke', channel: 'roadmap:dispatch' },
  roadmapWand: { kind: 'invoke', channel: 'roadmap:wand' },
  roadmapStop: { kind: 'invoke', channel: 'roadmap:stop' },
  roadmapAssign: { kind: 'invoke', channel: 'roadmap:assign' },
  importPlan: { kind: 'invoke', channel: 'roadmap:import-plan' },

  // worktrees
  removeWorktree: { kind: 'invoke', channel: 'worktree:remove' },
  listWorktrees: { kind: 'invoke', channel: 'worktree:list' },
  createWorktree: { kind: 'invoke', channel: 'worktree:create' },

  // journal
  journalList: { kind: 'invoke', channel: 'journal:list' },
  journalExport: { kind: 'invoke', channel: 'journal:export' },

  // broker reachability
  getBrokerStatus: { kind: 'invoke', channel: 'broker:status' },
  retryBroker: { kind: 'invoke', channel: 'broker:retry' },

  // diff / review
  collectDiff: { kind: 'invoke', channel: 'diff:collect' },
  collectFileDiff: { kind: 'invoke', channel: 'diff:collect-file' },
  reviewDiff: { kind: 'invoke', channel: 'diff:review' },

  // file explorer (read-only, roots re-validated main-side)
  explorerRoots: { kind: 'invoke', channel: 'explorer:roots' },
  explorerList: { kind: 'invoke', channel: 'explorer:list' },
  explorerRead: { kind: 'invoke', channel: 'explorer:read' },

  // embedded browser + window mirror (desktop-only feature, blocked remotely)
  getBrowserPreloadPath: { kind: 'invoke', channel: 'browser:preload-path' },
  captureBrowser: { kind: 'invoke', channel: 'browser:capture' },
  saveAnnotation: { kind: 'invoke', channel: 'browser:save-annotation' },
  saveRecording: { kind: 'invoke', channel: 'browser:save-recording' },
  runDemoScenario: { kind: 'invoke', channel: 'browser:demo-run' },
  cancelDemoScenario: { kind: 'invoke', channel: 'browser:demo-cancel' },
  listCaptureWindows: { kind: 'invoke', channel: 'design:list-windows' },
  captureWindow: { kind: 'invoke', channel: 'design:capture-window' },

  // supervisor / help / digest
  ensureSupervisor: { kind: 'invoke', channel: 'supervisor:ensure' },
  askHelp: { kind: 'invoke', channel: 'help:ask' },
  askDigest: { kind: 'invoke', channel: 'help:digest' },

  // templates
  listTemplates: { kind: 'invoke', channel: 'template:list' },
  readTemplateFile: { kind: 'invoke', channel: 'template:read' },
  writeTemplateFile: { kind: 'invoke', channel: 'template:write' },
  exportTemplate: { kind: 'invoke', channel: 'template:export' },
  applyTemplate: { kind: 'invoke', channel: 'template:apply' },
  deleteTemplate: { kind: 'invoke', channel: 'template:delete' },

  // snippets
  listSnippets: { kind: 'invoke', channel: 'snippet:list' },
  saveSnippet: { kind: 'invoke', channel: 'snippet:save' },
  deleteSnippet: { kind: 'invoke', channel: 'snippet:delete' },

  // graph chat
  graphList: { kind: 'invoke', channel: 'graph:list' },
  graphCreate: { kind: 'invoke', channel: 'graph:create' },
  graphDelete: { kind: 'invoke', channel: 'graph:delete' },
  graphSave: { kind: 'invoke', channel: 'graph:save' },
  graphCompile: { kind: 'invoke', channel: 'graph:compile' },
  modelCatalogs: { kind: 'invoke', channel: 'models:catalog' },
  usageRead: { kind: 'invoke', channel: 'usage:read' },
  graphInfer: { kind: 'invoke', channel: 'graph:infer' },
  graphDraftOpen: { kind: 'invoke', channel: 'graphDraft:open' },
  inboxHistory: { kind: 'invoke', channel: 'inbox:history' },

  // companion control (desktop window only — a remote must never manage its
  // own bridge: starting/stopping the server is a physical-presence action)
  companionStart: { kind: 'invoke', channel: 'companion:start' },
  companionStop: { kind: 'invoke', channel: 'companion:stop' },
  companionStatus: { kind: 'invoke', channel: 'companion:status' },
  companionDevices: { kind: 'invoke', channel: 'companion:devices' },
  companionRevoke: { kind: 'invoke', channel: 'companion:revoke' },
  companionRevokeAll: { kind: 'invoke', channel: 'companion:revoke-all' },

  // sandbox mode (PLAN-SANDBOX SBX2–SBX5, M2/M3)
  sandboxStatus: { kind: 'invoke', channel: 'sandbox:status' },
  sandboxPatchSettings: { kind: 'invoke', channel: 'sandbox:patch-settings' },
  sandboxSetImage: { kind: 'invoke', channel: 'sandbox:set-image' },
  sandboxEnsure: { kind: 'invoke', channel: 'sandbox:ensure' },
  sandboxImageBuild: { kind: 'invoke', channel: 'sandbox:image-build' },
  sandboxBuildStop: { kind: 'invoke', channel: 'sandbox:build-stop' },
  sandboxAuthPurge: { kind: 'invoke', channel: 'sandbox:auth-purge' },
  sandboxResetCopy: { kind: 'invoke', channel: 'sandbox:reset-copy' },
  sandboxProbeBridge: { kind: 'invoke', channel: 'sandbox:probe-bridge' },
  sandboxList: { kind: 'invoke', channel: 'sandbox:list' },
  sandboxContainerAction: { kind: 'invoke', channel: 'sandbox:container-action' },
  sandboxAuthStart: { kind: 'invoke', channel: 'sandbox:auth-start' },
  sandboxAuthStop: { kind: 'invoke', channel: 'sandbox:auth-stop' },
  sandboxAuthProbe: { kind: 'invoke', channel: 'sandbox:auth-probe' },
  onCompanionChanged: { kind: 'event', channel: 'companion:changed' },
  onCompanionDeviceConnected: { kind: 'event', channel: 'companion:device-connected' },

  // events
  onPtyData: { kind: 'event', channel: 'pty:data' },
  onSandboxChanged: { kind: 'event', channel: 'sandbox:changed' },
  onPtyExit: { kind: 'event', channel: 'pty:exit' },
  onSessionsChanged: { kind: 'event', channel: 'sessions:changed' },
  onSessionThinking: { kind: 'event', channel: 'session:thinking' },
  onSessionQuota: { kind: 'event', channel: 'session:quota' },
  onSessionAttention: { kind: 'event', channel: 'session:attention' },
  onInboxMessages: { kind: 'event', channel: 'inbox:new' },
  onGraphDrafts: { kind: 'event', channel: 'graphDrafts:update' },
  onInboxOpen: { kind: 'event', channel: 'inbox:open' },
  onFocusSession: { kind: 'event', channel: 'session:focus' },
  onDesignPick: { kind: 'event', channel: 'design:pick' },
  onConfigChanged: { kind: 'event', channel: 'config:changed' },
  onMenuSettings: { kind: 'event', channel: 'menu:settings' },
  onMenuNewClear: { kind: 'event', channel: 'menu:new-clear' },
  onMenuSave: { kind: 'event', channel: 'menu:save' },
  onMenuSaveAs: { kind: 'event', channel: 'menu:save-as' },
  onMenuRestore: { kind: 'event', channel: 'menu:restore' },
  onMenuListWorkspaces: { kind: 'event', channel: 'menu:list' },
  onMenuExportTemplate: { kind: 'event', channel: 'menu:export-template' },
  onMenuImportTemplate: { kind: 'event', channel: 'menu:import-template' },
  onWorkspaceCurrent: { kind: 'event', channel: 'workspace:current' },
  onBrokerStatus: { kind: 'event', channel: 'broker:status' },
  approvalChannels: { kind: 'invoke', channel: 'approvals:channels' },
  approvalConnect: { kind: 'invoke', channel: 'approvals:connect' },
  approvalDisconnect: { kind: 'invoke', channel: 'approvals:disconnect' },
  approvalEnrolmentExport: { kind: 'invoke', channel: 'approvals:enrolment-export' },
  approvalEnrolmentApply: { kind: 'invoke', channel: 'approvals:enrolment-apply' }
} as const satisfies Record<keyof DeckApi, CompanionMethodSpec>

export type CompanionMethodName = keyof typeof COMPANION_MANIFEST

/**
 * Invoke channels a REMOTE client may never call (EXPLORATION §3/§5.4):
 * native dialogs open on the PC screen, browser/design captures are a desktop
 * workflow, and companion control requires physical presence at the host.
 * Enforced server-side (defense) AND stubbed shim-side (clean errors).
 */
export const REMOTE_BLOCKED_CHANNELS: ReadonlySet<string> = new Set([
  'dialog:pickDirectory',
  'journal:export',
  'roadmap:import-plan',
  'browser:preload-path',
  'browser:capture',
  'browser:save-annotation',
  'browser:save-recording',
  'browser:demo-run',
  'browser:demo-cancel',
  'design:list-windows',
  'design:capture-window',
  // Remote approvals: enrolling a channel means pasting a BOT TOKEN, and
  // exporting an enrolment hands over the operator's PRIVATE KEY. A paired
  // phone must never be able to pull either over the LAN socket -- that would
  // turn one companion pairing into a permanent identity theft. Physical
  // presence at the host, like companion control itself.
  'approvals:connect',
  'approvals:disconnect',
  'approvals:enrolment-export',
  'approvals:enrolment-apply',
  'companion:start',
  'companion:stop',
  'companion:status',
  // Lot 2: device management is a host-only, trust-changing action — a paired
  // device must never be able to list or revoke devices (incl. itself/others).
  'companion:devices',
  'companion:revoke',
  'companion:revoke-all',
  // Sandbox trust flips, container lifecycle and the login terminal are
  // host-presence actions (the OAuth URL opens on the PC's browser anyway).
  'sandbox:patch-settings',
  'sandbox:set-image',
  'sandbox:container-action',
  'sandbox:auth-start',
  'sandbox:auth-stop',
  'sandbox:auth-purge',
  'sandbox:image-build',
  'sandbox:build-stop',
  'sandbox:reset-copy'
])

/**
 * Declarative sensitivity tiers (EXPLORATION §5.4) — 0 read, 1 interact,
 * 2 execute/structure, 3 trust-changing. Informational in the ephemeral
 * operator-profile mode (full access), but the table is the code-constant
 * ground truth for a future restricted "companion" profile, and the tests
 * force every invoke/send channel to carry a tier.
 */
export const CHANNEL_TIERS: Readonly<Record<string, 0 | 1 | 2 | 3>> = {
  'sessions:list': 0,
  'sessions:peek-next-color': 0,
  'config:get': 0,
  'i18n:get': 0,
  'workspace:list': 0,
  'workspace:current': 0,
  'agents:list': 0,
  'launch:get': 0,
  'roadmap:list': 0,
  'worktree:list': 0,
  'journal:list': 0,
  'broker:status': 0,
  'diff:collect': 0,
  'diff:collect-file': 0,
  'explorer:roots': 0,
  'explorer:list': 0,
  'explorer:read': 0,
  'template:list': 0,
  'template:read': 0,
  'snippet:list': 0,
  'graph:list': 0,
  'graph:compile': 0,
  'models:catalog': 0,
  'usage:read': 0,
  'inbox:history': 0,
  'companion:status': 0,
  // Remote approvals. Reading the channel list is tier 0; everything else is
  // trust-changing: a bot token grants control of the operator's notification
  // channel, and an enrolment payload IS the operator identity.
  'approvals:channels': 0,
  'approvals:connect': 3,
  'approvals:disconnect': 3,
  'approvals:enrolment-export': 3,
  'approvals:enrolment-apply': 3,

  'pty:input': 1,
  'pty:resize': 1,
  'app:report-error': 1,
  'sessions:rename': 1,
  'sessions:set-color': 1,
  'sessions:set-auto-resume': 1,
  'sessions:set-lead': 1,
  'sessions:reorder': 1,
  'broker:retry': 1,
  'announce:send': 1,
  'roadmap:upsert': 1,
  'roadmap:archive': 1,
  'roadmap:reorder': 1,
  'roadmap:wand': 1,
  'roadmap:stop': 1,
  'graph:create': 1,
  'graph:delete': 1,
  'graph:save': 1,
  'graphDraft:open': 1,
  'snippet:save': 1,
  'snippet:delete': 1,

  'sessions:create': 2,
  'sessions:remove': 2,
  'sessions:restart': 2,
  'app:new-clear': 2,
  'workspace:save': 2,
  'workspace:restore': 2,
  'workspace:delete': 2,
  'roadmap:dispatch': 2,
  'roadmap:assign': 2,
  'roadmap:import-plan': 2,
  'worktree:remove': 2,
  'worktree:create': 2,
  'diff:review': 2,
  'supervisor:ensure': 2,
  'help:ask': 2,
  'help:digest': 2,
  'template:write': 2,
  'template:export': 2,
  'template:apply': 2,
  'template:delete': 2,
  'graph:infer': 2,
  'journal:export': 2,
  'dialog:pickDirectory': 2,
  'browser:preload-path': 2,
  'browser:capture': 2,
  'browser:save-annotation': 2,
  'browser:save-recording': 2,
  'browser:demo-run': 2,
  'browser:demo-cancel': 2,
  'design:list-windows': 2,
  'design:capture-window': 2,

  'sandbox:status': 0,
  'sandbox:list': 0,
  'sandbox:auth-probe': 0,
  'sandbox:probe-bridge': 0,
  'sandbox:ensure': 2,
  'sandbox:container-action': 2,
  'sandbox:auth-start': 2,
  'sandbox:auth-stop': 2,
  'sandbox:image-build': 2,
  'sandbox:build-stop': 2,
  'sandbox:reset-copy': 2,

  'config:set': 3,
  'launch:set-global': 3,
  // Trust-changing: these decide WHERE agents execute, which image they run
  // and which gitignored files get duplicated next to them.
  'sandbox:patch-settings': 3,
  'sandbox:set-image': 3,
  'sandbox:auth-purge': 3,
  'companion:start': 3,
  'companion:stop': 3,
  'companion:devices': 3,
  'companion:revoke': 3,
  'companion:revoke-all': 3
}

// ----- wire protocol -----

/** Client → server frames. */
export type CompanionClientFrame =
  | { t: 'hello'; token?: string; cred?: string }
  | { t: 'req'; id: number; ch: string; args: unknown[] }
  | { t: 'send'; ch: string; args: unknown[] }
  | { t: 'mode'; mode: 'full' | 'light' }

/** Server → client frames. */
export type CompanionServerFrame =
  | { t: 'welcome'; cred: string }
  | { t: 'res'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'ev'; ch: string; payload: unknown }
  | { t: 'hb' }

export function parseClientFrame(raw: unknown): CompanionClientFrame | null {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object') return null
  const f = obj as Record<string, unknown>
  switch (f.t) {
    case 'hello':
      return {
        t: 'hello',
        token: typeof f.token === 'string' ? f.token : undefined,
        cred: typeof f.cred === 'string' ? f.cred : undefined
      }
    case 'req':
      if (typeof f.id !== 'number' || typeof f.ch !== 'string' || !Array.isArray(f.args)) {
        return null
      }
      return { t: 'req', id: f.id, ch: f.ch, args: f.args }
    case 'send':
      if (typeof f.ch !== 'string' || !Array.isArray(f.args)) return null
      return { t: 'send', ch: f.ch, args: f.args }
    case 'mode':
      return f.mode === 'light' || f.mode === 'full' ? { t: 'mode', mode: f.mode } : null
    default:
      return null
  }
}

// ----- timing constants (EXPLORATION §5.5: heartbeat host-death detection) -----

/** Server sends an app-level hb frame at this cadence. */
export const COMPANION_HEARTBEAT_MS = 5_000
/** Client declares the host gone after this silence (hb, ev or res). */
export const COMPANION_CLIENT_TIMEOUT_MS = 12_000
/** Failed auth attempts per address before lockout. */
export const COMPANION_LOCKOUT_THRESHOLD = 10
/** Lockout duration once the threshold is hit. */
export const COMPANION_LOCKOUT_MS = 10 * 60_000

/** Events withheld from a client in 'light' (backgrounded) mode (MB5). */
export const LIGHT_MODE_BLOCKED_EVENTS: ReadonlySet<string> = new Set([
  'pty:data',
  'session:thinking'
])

// ----- LAN-only guard (EXPLORATION §5.1.3: static, zero-maintenance) -----

/**
 * True for addresses a companion client may connect from: loopback, RFC1918,
 * link-local, CGNAT (100.64/10 — Tailscale-style overlays present themselves
 * as this), IPv6 ULA/link-local, and their IPv4-mapped forms.
 */
export function isPrivateAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  let a = addr.trim().toLowerCase()
  if (a.startsWith('::ffff:')) a = a.slice(7)
  if (a === '::1' || a === 'localhost') return true
  // IPv6: ULA fc00::/7 and link-local fe80::/10.
  if (a.includes(':')) {
    return a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')
  }
  const parts = a.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const o1 = nums[0]!
  const o2 = nums[1]!
  if (o1 === 127) return true
  if (o1 === 10) return true
  if (o1 === 192 && o2 === 168) return true
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true
  if (o1 === 169 && o2 === 254) return true
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return true
  return false
}

// ----- pairing / credential lifecycle (pure, injectable clock for tests) -----

export interface CompanionAuthState {
  /** One-shot pairing token (QR); consumed by the first successful hello. */
  pairingToken: string | null
  /** Per-run session credentials -> device metadata (reconnects + revoke). */
  creds: Map<string, CompanionDevice>
}

export class CompanionAuth {
  private state: CompanionAuthState = { pairingToken: null, creds: new Map() }
  private failures = new Map<string, { count: number; lockedUntil: number }>()
  private seq = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Arm a new pairing token; invalidates the previous one AND all creds. */
  arm(token: string): void {
    this.state = { pairingToken: token, creds: new Map() }
  }

  /** Disarm everything (server stop). */
  disarm(): void {
    this.state = { pairingToken: null, creds: new Map() }
  }

  isLocked(addr: string): boolean {
    const f = this.failures.get(addr)
    return !!f && f.lockedUntil > this.now()
  }

  /**
   * Validate a hello frame from `addr`. On pairing success the token is
   * CONSUMED and a fresh credential (minted by the caller) is registered.
   * Returns 'paired' | 'resumed' | 'denied'.
   */
  hello(
    addr: string,
    frame: { token?: string; cred?: string },
    mintCred: () => string
  ): { result: 'paired'; cred: string } | { result: 'resumed' } | { result: 'denied' } {
    if (this.isLocked(addr)) return { result: 'denied' }
    if (frame.cred && this.state.creds.has(frame.cred)) {
      const dev = this.state.creds.get(frame.cred)!
      dev.lastSeenAt = this.now()
      dev.addr = addr
      this.failures.delete(addr)
      return { result: 'resumed' }
    }
    if (
      frame.token &&
      this.state.pairingToken &&
      timingSafeEqualStr(frame.token, this.state.pairingToken)
    ) {
      this.state.pairingToken = null // single use
      const cred = mintCred()
      const t = this.now()
      this.state.creds.set(cred, { id: `d${++this.seq}`, addr, pairedAt: t, lastSeenAt: t })
      this.failures.delete(addr)
      return { result: 'paired', cred }
    }
    const f = this.failures.get(addr) ?? { count: 0, lockedUntil: 0 }
    f.count += 1
    if (f.count >= COMPANION_LOCKOUT_THRESHOLD) {
      f.lockedUntil = this.now() + COMPANION_LOCKOUT_MS
      f.count = 0
    }
    this.failures.set(addr, f)
    return { result: 'denied' }
  }

  /** Snapshot of the currently-paired devices (non-secret), newest first. */
  listDevices(): CompanionDevice[] {
    return [...this.state.creds.values()].sort((a, b) => b.pairedAt - a.pairedAt)
  }

  /**
   * Revoke one device by its (non-secret) id. Returns the revoked credential so
   * the server can close that device's live socket, or null if unknown.
   */
  revoke(id: string): string | null {
    for (const [cred, dev] of this.state.creds) {
      if (dev.id === id) {
        this.state.creds.delete(cred)
        return cred
      }
    }
    return null
  }

  /** Revoke every device; returns all revoked credentials. */
  revokeAll(): string[] {
    const creds = [...this.state.creds.keys()]
    this.state.creds.clear()
    return creds
  }

  /** Whether a pairing token is still waiting to be consumed. */
  get pairingArmed(): boolean {
    return this.state.pairingToken !== null
  }

  get credCount(): number {
    return this.state.creds.size
  }
}

/** Constant-time-ish string compare (both operands are short random tokens). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ----- shared status shape (main ⇄ renderer) -----

export type { CompanionDevice, CompanionInfo } from './types'
