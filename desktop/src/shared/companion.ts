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
  clearAttention: { kind: 'invoke', channel: 'sessions:clear-attention' },
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
  roadmapSearch: { kind: 'invoke', channel: 'roadmap:search' },
  roadmapUpsert: { kind: 'invoke', channel: 'roadmap:upsert' },
  roadmapArchive: { kind: 'invoke', channel: 'roadmap:archive' },
  roadmapReorder: { kind: 'invoke', channel: 'roadmap:reorder' },
  roadmapDispatch: { kind: 'invoke', channel: 'roadmap:dispatch' },
  roadmapWand: { kind: 'invoke', channel: 'roadmap:wand' },
  roadmapStop: { kind: 'invoke', channel: 'roadmap:stop' },
  roadmapAssign: { kind: 'invoke', channel: 'roadmap:assign' },
  importPlan: { kind: 'invoke', channel: 'roadmap:import-plan' },

  // agent stop broadcast (aaf4537d lot 3): stopping every tile at once is
  // trust-changing (agents:stop), reading the current stop state is not.
  agentsStop: { kind: 'invoke', channel: 'agents:stop' },
  agentsStopState: { kind: 'invoke', channel: 'agents:stop-state' },

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
  loadReview: { kind: 'invoke', channel: 'browser:review-load' },
  saveReview: { kind: 'invoke', channel: 'browser:review-save' },
  clearReview: { kind: 'invoke', channel: 'browser:review-clear' },

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
  approvalReply: { kind: 'invoke', channel: 'approvals:reply' },
  approvalDecline: { kind: 'invoke', channel: 'approvals:decline' },
  approvalAllow: { kind: 'invoke', channel: 'approvals:allow' },
  inboxReply: { kind: 'invoke', channel: 'inbox:reply' },
  inboxAckState: { kind: 'invoke', channel: 'inbox:ack-state' },
  inboxMarkSeen: { kind: 'invoke', channel: 'inbox:mark-seen' },
  inboxAck: { kind: 'invoke', channel: 'inbox:ack' },
  inboxDelete: { kind: 'invoke', channel: 'inbox:delete' },

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
  sandboxImageRemove: { kind: 'invoke', channel: 'sandbox:image-remove' },
  openExternal: { kind: 'invoke', channel: 'shell:open-external' },
  sandboxBuildStop: { kind: 'invoke', channel: 'sandbox:build-stop' },
  sandboxAuthPurge: { kind: 'invoke', channel: 'sandbox:auth-purge' },
  sandboxResetCopy: { kind: 'invoke', channel: 'sandbox:reset-copy' },
  sandboxProbeBridge: { kind: 'invoke', channel: 'sandbox:probe-bridge' },
  sandboxList: { kind: 'invoke', channel: 'sandbox:list' },
  sandboxContainerAction: { kind: 'invoke', channel: 'sandbox:container-action' },
  sandboxAuthStart: { kind: 'invoke', channel: 'sandbox:auth-start' },
  sandboxAuthStop: { kind: 'invoke', channel: 'sandbox:auth-stop' },
  sandboxWarmUp: { kind: 'invoke', channel: 'sandbox:warm-up' },
  sandboxCustomGet: { kind: 'invoke', channel: 'sandbox:custom-get' },
  sandboxCustomSave: { kind: 'invoke', channel: 'sandbox:custom-save' },
  sandboxOverlayGenerate: { kind: 'invoke', channel: 'sandbox:overlay-generate' },
  sandboxProjectionRemove: { kind: 'invoke', channel: 'sandbox:projection-remove' },
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
  onInboxCleared: { kind: 'event', channel: 'inbox:cleared' },
  onPendingApprovals: { kind: 'event', channel: 'approvals:pending' },
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
  onMenuNewTemplate: { kind: 'event', channel: 'menu:new-template' },
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
 *
 * This is the manually-curated FLOOR, not the whole answer -- it also
 * carries entries below tier 3 (e.g. 'shell:open-external' is tier 2) that
 * still must never be remote-callable. The exported REMOTE_BLOCKED_CHANNELS
 * below unions this list with every tier>=3 channel, so a new trust-changing
 * channel is blocked the moment it's tiered 3, with no separate deny-list
 * edit to remember. See the completeness test in tests/desktop-companion.test.ts.
 */
const EXPLICIT_REMOTE_BLOCKED_CHANNELS: readonly string[] = [
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
  'sandbox:image-remove',
  'sandbox:build-stop',
  'sandbox:reset-copy',
  'sandbox:custom-save',
  'sandbox:overlay-generate',
  'sandbox:projection-remove',
  // Launching a browser is a HOST action: a remote device asking the PC to
  // open a link is a "make the operator's machine visit this" primitive.
  'shell:open-external',
  // ask_operator lot: these three don't relay a message, they RENDER A HUMAN
  // VERDICT. An agent is stopped, doing nothing, specifically because its
  // safety model requires a human to decide -- what comes back is consumed
  // as the operator's own decision and acted on directly. Unlike inbox:reply
  // (a message; the recipient keeps judgement) or roadmap:assign (an
  // existing accepted risk class), a remote companion answering here
  // MANUFACTURES the human consent that was the only thing stopping the
  // agent. Tier 2 alone (see CHANNEL_TIERS) does not block remote access,
  // so this floor is what actually does. approvals:allow is the same
  // verdict-rendering primitive as approvals:decline, just the other
  // outcome (card c7df3781) -- same floor, same reasoning.
  'approvals:reply',
  'approvals:decline',
  'approvals:allow'
]

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
  'roadmap:search': 0,
  // Reading whether any tile is currently paused is a read, same tier as
  // sessions:list -- a Stream Deck key needs this to render its own state.
  'agents:stop-state': 0,
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
  'inbox:ack-state': 0,
  'inbox:mark-seen': 1,
  'inbox:ack': 1,
  // Deletes SHARED broker state (any Deck attached to the group, not just
  // this window) -- worse blast radius than a local read-state flag, but it
  // is a destructive MANAGEMENT action, not a verdict an agent consumes and
  // acts on (unlike the approvals:* floor below): closer to workspace:delete
  // (2, destructive-but-not-verdict-rendering) than to approvals:decline (2 +
  // explicit remote-block). Not added to EXPLICIT_REMOTE_BLOCKED_CHANNELS.
  'inbox:delete': 2,
  // Targeted, operator-authority actions reaching one NAMED peer/agent --
  // same class as roadmap:assign (2), not announce:send's group broadcast
  // (1). 'inbox:reply' stays here (a message; the recipient keeps
  // judgement, matching roadmap:assign's already-accepted risk). The three
  // approval channels below carry a stricter risk (they render a human
  // VERDICT an agent acts on directly) and are additionally on the explicit
  // remote-block floor -- see EXPLICIT_REMOTE_BLOCKED_CHANNELS' comment.
  'inbox:reply': 2,
  'approvals:reply': 2,
  'approvals:decline': 2,
  'approvals:allow': 2,
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
  'sessions:clear-attention': 1,
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
  // Reading the pending review is a read (tier 0, like diff:collect); saving
  // or clearing it writes app state and is gated the same as its sibling
  // browser:save-annotation (tier 2, execute/structure).
  'browser:review-load': 0,
  'browser:review-save': 2,
  'browser:review-clear': 2,

  'sandbox:status': 0,
  'sandbox:list': 0,
  'sandbox:auth-probe': 0,
  'sandbox:probe-bridge': 0,
  'sandbox:ensure': 2,
  // Same act as sandbox:ensure (idempotent pre-flight, no arguments), just
  // dispatched off the spawn path.
  'sandbox:warm-up': 2,
  'sandbox:container-action': 2,
  'sandbox:auth-start': 2,
  'sandbox:auth-stop': 2,
  'sandbox:image-build': 2,
  'sandbox:image-remove': 2,
  'shell:open-external': 2,
  'sandbox:build-stop': 2,
  'sandbox:reset-copy': 2,

  'config:set': 3,
  'launch:set-global': 3,
  // Trust-changing: stops every live tile at once (pause/soft/hard), the
  // remote-companion equivalent of pulling the plug on the whole session.
  'agents:stop': 3,
  // Trust-changing: these decide WHERE agents execute, which image they run
  // and which extra files get duplicated next to them. The custom
  // Dockerfile fragment and the settings overlay both decide what CODE and
  // CONFIG every sandboxed agent runs with.
  'sandbox:patch-settings': 3,
  'sandbox:set-image': 3,
  'sandbox:auth-purge': 3,
  'sandbox:custom-get': 0,
  'sandbox:custom-save': 3,
  'sandbox:overlay-generate': 3,
  'sandbox:projection-remove': 3,
  'companion:start': 3,
  'companion:stop': 3,
  'companion:devices': 3,
  'companion:revoke': 3,
  'companion:revoke-all': 3
}

/**
 * DERIVED (aaf4537d lot 3): explicit floor above ∪ every channel whose
 * CHANNEL_TIERS entry is >= 3. Before this, CHANNEL_TIERS was purely
 * declarative/informational -- a channel could be tiered 3 and still be
 * missing from the hand-written deny-list above with nothing failing
 * (measured: 'config:set' and 'launch:set-global' were exactly that gap).
 * tests/desktop-companion.test.ts asserts every tier>=3 channel is a member.
 */
export const REMOTE_BLOCKED_CHANNELS: ReadonlySet<string> = new Set([
  ...EXPLICIT_REMOTE_BLOCKED_CHANNELS,
  ...Object.entries(CHANNEL_TIERS)
    .filter(([, tier]) => tier >= 3)
    .map(([channel]) => channel)
])

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

/**
 * sessionStorage key holding the per-run companion credential.
 *
 * Shared rather than inlined in `remote-api.ts` because the Android shell
 * (`desktop/mobile-shell/`) seeds this exact key before navigating, which is
 * how a paired phone resumes a host across an app kill without a fresh QR
 * (PLAN N5, multi-host). Two literals in two projects would drift silently.
 */
export const COMPANION_CRED_STORAGE_KEY = 'companion-cred'

// ----- timing constants (EXPLORATION §5.5: heartbeat host-death detection) -----

/** Server sends an app-level hb frame at this cadence. */
export const COMPANION_HEARTBEAT_MS = 5_000
/** Client declares the host gone after this silence (hb, ev or res). */
export const COMPANION_CLIENT_TIMEOUT_MS = 12_000
/** Failed auth attempts per address before lockout. */
export const COMPANION_LOCKOUT_THRESHOLD = 10
/** Lockout duration once the threshold is hit. */
export const COMPANION_LOCKOUT_MS = 10 * 60_000
/** Cap on INBOUND (client -> server) WS frame size (card 45c1999e: ws
 * defaults to 100 MiB with no cap otherwise). Most client->server frames are
 * small RPC invocation args (ids/strings/config -- see CompanionClientFrame
 * below), never diff/digest/export bodies (those are server->client 'res'/
 * 'ev' frames, outbound, unbounded by this). The largest REAL inbound
 * carrier is graph:save, which sends a whole GraphDoc (shared/graph.ts's own
 * MAX_NODE_TEXT=512 KiB for a single node, MAX_NODES=2000 -- a document can
 * legitimately exceed a naive 256 KiB bound; measured real graphs-*.json on
 * disk run ~13 KiB). pty:input can also carry a full pasted string in one
 * frame. 1 MiB stays two orders of magnitude under ws's 100 MiB default (so
 * the DoS reduction still holds) while leaving real documents headroom. */
export const COMPANION_MAX_PAYLOAD_BYTES = 1024 * 1024

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

  /** Count one failed attempt from `addr` toward the shared lockout
   * threshold/window (COMPANION_LOCKOUT_THRESHOLD/_MS). Called by `hello`'s
   * denied branch AND directly by callers for frames that never reach
   * `hello` at all (e.g. unparsable ones) -- both must count against the
   * same budget, or an attacker who only ever sends garbage never trips
   * the lockout. */
  recordFailure(addr: string): void {
    const f = this.failures.get(addr) ?? { count: 0, lockedUntil: 0 }
    f.count += 1
    if (f.count >= COMPANION_LOCKOUT_THRESHOLD) {
      f.lockedUntil = this.now() + COMPANION_LOCKOUT_MS
      f.count = 0
    }
    this.failures.set(addr, f)
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
    this.recordFailure(addr)
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
