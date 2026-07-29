import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  nativeTheme,
  Notification,
  safeStorage,
  shell
} from 'electron'
import type { AppConfig } from '@shared/types'
import { sanitizeGlowColor } from '@shared/palette'
import { loadConfig, saveConfig } from './store'
import { buildAppMenu } from './menu'
import { safeExternalUrl } from './external-url'
import { SessionService } from './session-service'
import { registerIpc, resolveDocsDir } from './ipc'
import { parseCliContext } from './cli-context'
import { computeScope, buildScopeEnv, resolveAdoptedScope, type Scope, type ScopeEnv } from './scope'
import {
  rememberScopeSecret,
  recallScopeSecret,
  type SecretCipher
} from './scope-secrets'
import { applyProviderKeyPatch, sanitizeProviders } from './provider-secrets'
import {
  globalLaunchCommand,
  globalWorktreeInit,
  type MagicCompactMode,
  projectLaunchCommand,
  projectWorktreeInit,
  resolveFeatures,
  resolveLaunchConfig
} from './launch-config'
import {
  MAGIC_TIMEOUT_MS,
  isMagicShimFailure,
  magicCompactPluginPresent,
  parseMagicResume
} from './magic-compact'
import { approve, isApproved, resolveApprovedLaunchCommand } from './launch-approval'
import { homedir, hostname } from 'node:os'
import { WorkspaceService } from './workspace-service'
import {
  BrokerHealthTracker,
  fetchGraphDrafts,
  fetchOperatorInbox,
  resolveBrokerEndpoint,
  sendAnnounce
} from './broker-client'
import { appendInboxHistory } from './inbox-store'
import { computeDeckProjectKey, listRoadmap, upsertRoadmap } from './roadmap-service'
import { createCheckpoint, purgeCheckpoints, restoreCommand } from './checkpoint-service'
import {
  canAutoDispatchNext,
  composeAssignText,
  composeStopText,
  dispatchNormalWave,
  firstQueued,
  nextBarrierPending,
  nextDispatchedState,
  runDirectiveWave,
  splitWave,
  type DispatchedEntry
} from './dispatch'
import { directiveKeys, isDirectiveCommand, resolveDirectiveTargets } from './directive'
import type { AssignResult, DispatchResult, RoadmapItem, StopResult } from '@shared/types'
import { composeJoinAnnounce, type JoinAnnounceIntent } from '@shared/announce'
import { isHead, queuedItems, wavesOf } from '@shared/workflow'
import { APP_STATE_SUBDIR, runDataMigration } from './migrate-data-dir'
import type { SessionRuntime } from '@shared/types'
import { listAgents } from './agents'
import { createSessionWithWorktree } from './create-session'
import { SandboxService } from './sandbox-service'
import { mapHostPathToContainer, rewriteLoopbackForContainer, sandboxifyEnv } from './sandbox-command'
import { Journal } from './journal'
import { flushJournalSnapshot, initDeckLog, logInfo, onDeckError, reportError } from './log'
import {
  startDeckControl,
  type DeckControlDeps,
  type DeckControlServer,
  type SpawnSummary
} from './deck-control'
import {
  composeSpawnAckText,
  composeSpawnFailText,
  writeEmbeddedAgentPrompt
} from './team-embedded'
import { startDesignEndpoint, type DesignEndpoint } from './design-endpoint'
import { ApprovalRuntime } from './approval-runtime'
import { remoteApprovalsEnabled } from './approval-store'
import {
  addApproval,
  buildKeystrokes,
  canApplyVerdict,
  claimApproval,
  connectChannel,
  disconnectChannel,
  fetchUndeliveredVerdicts,
  listChannels,
  markVerdictsDelivered
} from './approval-service'
import { applyEnrolment, exportEnrolment } from './operator-identity'
import { addEventSink, broadcast, regHandle } from './api-registry'
import { CompanionServer } from './companion-server'
import {
  SUPERVISOR_BRIEFING,
  SUPERVISOR_NAME,
  writeSupervisorMcpConfig,
  writeSupervisorSystemPrompt
} from './supervisor'
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  runWorktreeInit
} from './worktree-service'
import {
  globalTemplatesDir,
  listTemplates,
  localTemplatesDir,
  readTemplate,
  templateSource,
  writeTemplate
} from './template-store'
import { templateHasShellFields, templateToInputs, toTemplate, type TemplateInput } from '@shared/template'

let mainWindow: BrowserWindow | null = null
// The desktop window is the first event sink (PLAN MB1): state events emitted
// through broadcast() reach it exactly like the old direct sends, plus every
// authenticated companion client.
addEventSink((channel, payload) => mainWindow?.webContents.send(channel, payload))

// Pin the app-data folder on the "koryphaios" root (v0.7 rename; previously
// "claude-peers-desk", and before that userData lived in "claude-peers-deck").
// Must run before any getPath('userData') / loadConfig() below; the chained
// migrations in migrate-data-dir.ts carry the legacy folders' content over.
// App state lives under <userData>/config to avoid colliding with the launch
// config.json at the root.
app.setName('koryphaios')
runDataMigration({ userDataDir: app.getPath('userData') })

// Rolling main.log under the platform logs dir (PLAN O3): in a packaged app
// console output goes nowhere, this file is the only durable trail. Bound
// before anything else can fail so even startup errors land in it.
app.setAppLogsPath()
initDeckLog(app.getPath('logs'))

// Last-resort safety nets. Steady-state: log + journal and keep running (live
// PTYs beat a crash). Before the window exists there is nothing to keep alive:
// surface the error loudly and exit instead of dying silently.
const handleFatal = (kind: string) => (e: unknown) => {
  reportError('main', kind, e)
  if (!app.isReady()) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
    try {
      dialog.showErrorBox('Koryphaios', `Startup failure (${kind}):\n\n${msg}`)
    } catch {
      // dialog unavailable this early: the log line above is the trace.
    }
    process.exit(1)
  }
}
process.on('uncaughtException', handleFatal('uncaught exception'))
process.on('unhandledRejection', handleFatal('unhandled rejection'))

// Renderer / GPU / utility process crashes never reach uncaughtException: hook
// them explicitly, journal them, and offer a reload when the window died.
app.on('render-process-gone', (_e, contents, details) => {
  reportError('renderer', `render process gone (${details.reason}, exit ${details.exitCode})`)
  if (details.reason === 'clean-exit') return
  const win = BrowserWindow.fromWebContents(contents)
  if (!win || win.isDestroyed()) return
  const choice = dialog.showMessageBoxSync(win, {
    type: 'error',
    buttons: ['Reload', 'Close'],
    defaultId: 0,
    cancelId: 1,
    title: 'Koryphaios',
    message: 'The interface crashed.',
    detail: `Reason: ${details.reason} (exit code ${details.exitCode}). Reload restores the window; running sessions are preserved.`
  })
  if (choice === 0) contents.reload()
})
app.on('child-process-gone', (_e, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return
  reportError('main', `child process gone: ${details.type} (${details.reason}, exit ${details.exitCode})`)
})

// Resolve the launch context (invocation cwd + optional custom scope id) and
// scope new sessions to that project dir. The override stays in-memory so the
// app-wide config.json is not polluted with one project's directory.
const cliContext = parseCliContext(process.argv, process.env)
let config: AppConfig = { ...loadConfig(), projectDir: cliContext.projectDir }

// The isolated forced group every session shares + the child env that pins them
// to it. The secret lives only here + in a chmod-600 temp file. Both are MUTABLE
// so a freshly-opened (empty) app can adopt a restored workspace's scope without
// relaunching (DESIGN 6.6).
let activeScope: Scope = computeScope(cliContext.projectDir, cliContext.scopeId)
let activeScopeEnv: ScopeEnv = buildScopeEnv(activeScope)

// D8: remember a custom scope's secret on this machine (encrypted via the OS
// credential store) so a custom-scope workspace can be restored without
// re-supplying the secret via the launch arg. Keyed by groupId in userData.
const secretCipher: SecretCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (buf) => safeStorage.decryptString(buf)
}
const secretsDir = (): string => join(app.getPath('userData'), APP_STATE_SUBDIR)

// If this window was launched with a custom scope, remember its secret (opt-out
// via the rememberScopeSecrets setting). The plaintext never hits disk -- only
// the encrypted blob, in a userData file separate from the workspace JSON.
if (activeScope.scopeKind === 'custom' && config.rememberScopeSecrets) {
  try {
    rememberScopeSecret(secretsDir(), secretCipher, activeScope.groupId, activeScope.secret)
  } catch (e) {
    reportError('scope', 'could not remember scope secret', e)
  }
}

// Base command each session runs. presets/models/worktreeInit follow the
// normal project > global precedence (resolveLaunchConfig at use sites); the
// launchCommand itself is SECURITY-GATED (PLAN C19): the service starts on
// the global/default command and a PROJECT-sourced launchCommand only lands
// after the operator approves it once (see the app.whenReady gate below).
const safeLaunchCommand = globalLaunchCommand()

// Shared C19 approval store (launchCommand + worktreeInit + project templates).
const approvalsFile = (): string => join(app.getPath('userData'), APP_STATE_SUBDIR, 'launch-approvals.json')

// B5: the operator-approved worktree-init hook for this project, resolved once
// at whenReady through the C19 gate below. undefined = no hook runs. Passed to
// every spawn path (createSessionWithWorktree) instead of re-reading the
// project config, so a repo-shipped worktreeInit cannot reach the shell ungated.
let approvedWorktreeInit: string | undefined
const getWorktreeInit = (): string | undefined => approvedWorktreeInit

const isFrLocale = (): boolean => (config.locale || app.getLocale()).toLowerCase().startsWith('fr')

const getConfig = (): AppConfig => config
const setConfig = (patch: Partial<AppConfig>): AppConfig => {
  // B9: projectDir is a launch-time, in-memory context (from cliContext), never
  // a runtime setting — the renderer only ever patches display/settings fields.
  // A `config:set { projectDir }` would repoint every project-scoped resolver
  // (worktreeInit, launchCommand, templates) at an attacker-chosen repo AFTER
  // the C19 boot gate ran, so it is rejected here rather than silently applied.
  if (patch.projectDir !== undefined && patch.projectDir !== config.projectDir) {
    reportError('config', `rejected config:set projectDir override (${patch.projectDir})`)
    const { projectDir: _ignored, ...rest } = patch
    patch = rest
  }
  // The glow colour lands in a CSS variable renderer-side: clamp to hex/''
  // here too so a compromised-renderer patch can't persist arbitrary text.
  if (patch.glowColor !== undefined) {
    patch = { ...patch, glowColor: sanitizeGlowColor(patch.glowColor) }
  }
  // Local-provider API keys never persist in clear (C29): a renderer patch
  // carries transient `apiKey` fields that are encrypted (safeStorage) into
  // `apiKeyEnc` here, and the renderer echo below only ever sees `hasKey`.
  if (patch.localProviders) {
    patch = {
      ...patch,
      localProviders: applyProviderKeyPatch(
        config.localProviders ?? [],
        patch.localProviders,
        secretCipher
      )
    }
  }
  config = { ...config, ...patch }
  saveConfig(config)
  nativeTheme.themeSource = config.theme
  broadcast('config:changed', sanitizeConfigForRenderer(config))
  return config
}

/** Renderer copy of the config: provider secrets stripped, `hasKey` exposed. */
const sanitizeConfigForRenderer = (cfg: AppConfig): AppConfig => ({
  ...cfg,
  localProviders: sanitizeProviders(cfg.localProviders ?? [])
})

// Embedded plugin shipping the SessionStart back-channel hook, loaded into every
// Deck session via --plugin-dir so a /clear-minted session id is captured at save
// (see desk-backchannel-hook + SessionService.refreshLiveSessionIds). Resolved
// like ipc.ts locales: from process.resourcesPath when packaged, the app dir in
// dev. Empty when the dir is missing (build skipped) so the spawn never breaks.
const deckPluginDir = ((): string => {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'deck-plugin')
    : join(app.getAppPath(), 'deck-plugin')
  return existsSync(dir) ? dir : ''
})()

// Design endpoint (PLAN D2b): loopback receiver for element picks coming from
// EXTERNAL apps in design mode (Tauri/Electron dev builds running the
// deck-design client). Started at whenReady; its url/token are injected into
// every PTY the Deck spawns, so `tauri dev` launched from a session terminal
// inherits the pair — nothing is persisted, nothing transits the broker (which
// may be remote/headless: picks are a strictly local loop).
let designServer: DesignEndpoint | null = null

// Remote approvals (PLAN-notifications-mobiles N2.c). Armed at whenReady only
// when the operator enabled it; `env()` always emits the key so a value
// inherited from the parent process can never silently re-enable it.
const approvals = new ApprovalRuntime({
  stateDir: join(app.getPath('userData'), APP_STATE_SUBDIR),
  cipher: secretCipher,
  endpoint: () => resolveBrokerEndpoint(),
  sessionRef: `window-${activeScope.groupId.slice(0, 12)}`,
  host: hostname()
})

/** Global switch AND no project opt-out — a project can restrict, never enable. */
function approvalsEnabled(): boolean {
  return remoteApprovalsEnabled({
    globalEnabled: config.mobileApprovals === true,
    file: join(app.getPath('userData'), APP_STATE_SUBDIR, 'approvals.json'),
    projectKey: computeDeckProjectKey(cliContext.projectDir)
  })
}

const service = new SessionService(
  getConfig,
  () => ({
    ...activeScopeEnv.env,
    ...approvals.env(),
    ...(designServer
      ? {
          CLAUDE_DECK_DESIGN_URL: designServer.url,
          CLAUDE_DECK_DESIGN_TOKEN: designServer.token
        }
      : null)
  }),
  safeLaunchCommand,
  deckPluginDir
)

// Activity journal (PLAN C14): per-window narration of spawns, exits, quota
// episodes, attention screens, worktree ops, announces… Ring-buffered, never
// persisted. Fed here + in ipc.ts; read by the Journal rail view.
const journal = new Journal()

// Route every reportError() into the journal (PLAN O3): failures show up in
// the Journal view next to the activity they interrupted.
onDeckError((scope, text) => journal.add('error', `[${scope}] ${text}`))

service.on('created', (r: SessionRuntime) => {
  const branch = r.worktree ? ` on ⎇ ${r.worktree.branch}` : ''
  journal.add('session', `session "${r.name}" spawned${branch}${r.supervisor ? ' (supervisor)' : ''}`)
})
// ----- Sandbox mode (PLAN-SANDBOX SBX1–SBX3) -----
// Per-project container lifecycle. Constructed eagerly (cheap: name hashing
// only) — every engine call is on-demand. The settings live in the operator's
// app-state sandbox.json (never a repo file, hostile input #1).
const claudeHomeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const sandbox = new SandboxService({
  projectDir: cliContext.projectDir,
  projectKey: computeDeckProjectKey(cliContext.projectDir),
  stateDir: join(app.getPath('userData'), APP_STATE_SUBDIR),
  // Projection source (CLAUDE.md/agents/skills/plugins) + peers back-channel.
  claudeHomeDir,
  // Shipped Dockerfile: resources when packaged, the repo dir in dev — same
  // resolution as deckPluginDir / the docs dir.
  imageContextDir: app.isPackaged
    ? join(process.resourcesPath, 'sandbox')
    : join(app.getAppPath(), 'resources', 'sandbox'),
  containerBrokerUrl: () => rewriteLoopbackForContainer(resolveBrokerEndpoint().url),
  journal: (msg) => journal.add('session', msg)
})
// The service emits 'changed' after every state transition (ensure, warm-up,
// container actions); fan it out to the window and companion clients. The
// renderer store and NavRail were ALREADY subscribed to this channel — the
// producer side was never wired, so the rail's status only moved when the
// Docker view polled.
sandbox.on('changed', (st) => broadcast('sandbox:changed', st))
// Startup warm-up: when this project already runs sandboxed, create/start the
// container and project the config NOW, in the background — not during the
// first agent spawn, where the ~10 s plugins projection read as "the app hangs
// for fifteen seconds". No-op (and silent) when sandbox is off, the engine is
// down or the image is not built yet.
void sandbox.warmUp().catch((e) => reportError('sandbox', 'startup warm-up failed', e))

// The broker URL a CONTAINERIZED session must dial: the host endpoint with
// loopback rewritten to host.docker.internal (server.ts hard-refuses to
// auto-spawn a broker on a non-loopback URL, so a bad bridge fails loudly
// instead of forking an isolated broker inside the container).
const containerBrokerEnv = (): Record<string, string> => {
  const endpoint = resolveBrokerEndpoint()
  return {
    CLAUDE_PEERS_BROKER_URL: rewriteLoopbackForContainer(endpoint.url),
    ...(endpoint.token ? { CLAUDE_PEERS_BROKER_TOKEN: endpoint.token } : null)
  }
}

// SBX1: wrap sandboxed spawns. The scope-secret file is read HERE (host-side,
// with a trace on failure) so the pure env translator stays fs-free.
service.setSandboxProvider(
  () => {
    const launch = sandbox.launchInfo()
    if (!launch) return null
    return {
      wrap: (sessionId, command, cwdHost, env) => {
        const cwd = mapHostPathToContainer(cwdHost, launch.workSource)
        if (cwd === null) {
          // Never relocate an agent silently: refusing marks the tile exited
          // with a trace, which the operator can act on.
          throw new Error(
            `session cwd is outside the sandbox mount (${cwdHost} not under ${launch.workSource})`
          )
        }
        sandbox.writeLaunchScript(sessionId, {
          command,
          cwd,
          env: {
            ...sandboxifyEnv(env, (path) => {
              try {
                return readFileSync(path, 'utf8').trim()
              } catch (e) {
                reportError('sandbox', `scope secret file unreadable: ${path}`, e)
                return null
              }
            }),
            ...containerBrokerEnv()
          }
        })
        return sandbox.execCommand(launch, sessionId)
      }
    }
  },
  // M2 resume: transcripts live in the container's auth volume, so the host
  // readers would see none and every restore would start fresh.
  (cwdHost) => sandbox.transcriptsFor(cwdHost),
  // Sandboxed sessions write their back-channel + peer cache into the
  // Deck-owned dir mounted in the container, never the host ~/.claude/peers.
  () => (sandbox.isEnabled() ? sandbox.peersDirHost : null)
)

// SBX3/M3: pre-spawn gate — container up AND authenticated before ANY tile
// spawns. 'sandbox-auth-required' routes the renderer to the login modal
// (one modal, instead of a login prompt in every tile). Returns the EFFECTIVE
// PROJECT ROOT so copy mode lands sessions + worktrees inside the clone that
// is actually mounted at /work.
/** Warm the container-side transcript cache for a session's real cwd (M2). */
const warmSandboxTranscripts = async (cwd: string): Promise<void> => {
  if (sandbox.isEnabled()) await sandbox.refreshTranscripts(cwd)
}

const sandboxGate = async (): Promise<string | null> => {
  if (!sandbox.isEnabled()) return null
  const st = await sandbox.ensure()
  if (!st.engine || st.containerState !== 'running') {
    throw new Error(st.error ? `sandbox: ${st.error}` : 'sandbox: container not ready')
  }
  if (st.authed !== true) throw new Error('sandbox-auth-required')
  return sandbox.effectiveRoot()
}

service.on('removed', ({ name }: { id: string; name: string }) => {
  journal.add('session', `session "${name}" closed`)
})
service.on('exit', ({ id, exitCode, name }: { id: string; exitCode: number; name?: string }) => {
  const label = name ?? id.slice(0, 8)
  journal.add(
    'session',
    exitCode === 0 ? `session "${label}" exited cleanly` : `session "${label}" exited with code ${exitCode}`
  )
  // Supervisor-spawned session died before its peer_id resolved (TS3): fail the
  // ack right away instead of letting the 120 s timer expire.
  const pending = pendingSpawnAcks.get(id)
  if (pending) {
    clearTimeout(pending.timer)
    pendingSpawnAcks.delete(id)
    void announceToSupervisor(composeSpawnFailText(pending.name, `exited (code ${exitCode})`))
  }
})
service.on(
  'quota',
  ({ id, limited, resumed }: { id: string; limited: boolean; resumed?: boolean }) => {
    const name = service.list().find((s) => s.id === id)?.name ?? id.slice(0, 8)
    if (resumed) journal.add('quota', `session "${name}" auto-resumed after the usage limit`)
    else if (limited) journal.add('quota', `session "${name}" hit the usage limit`)
  }
)

// Outbound megaphone: broadcast a system message to every active peer in this
// window's forced group via the broker /announce endpoint. Best-effort -- an
// announce must never crash the main process. Returns the peers it reached.
const broadcastAnnounce = async (text: string, excludePeerId?: string): Promise<number> => {
  if (!text.trim()) return 0
  try {
    const { sent } = await sendAnnounce(
      { groupId: activeScope.groupId, secret: activeScope.secret, text, excludePeerId },
      { endpoint: resolveBrokerEndpoint() }
    )
    if (sent > 0) journal.add('announce', `announce to ${sent} peer(s): ${text.slice(0, 120)}`)
    return sent
  } catch (e) {
    reportError('announce', 'announce failed', e)
    return 0
  }
}

// ----- Supervisor spawn-ack loop (PLAN TS3) -----
// Sessions spawned through deck-control get a script-driven connection ack: the
// Deck (not the agent) detects the peer_id resolution and taps the supervisor
// with a targeted announce. A 120 s timer covers the never-connected case.
const SPAWN_ACK_TIMEOUT_MS = 120_000
const pendingSpawnAcks = new Map<string, { name: string; timer: NodeJS.Timeout }>()

/** Targeted announce to the live supervisor. Best-effort, never throws. */
const announceToSupervisor = async (text: string): Promise<void> => {
  const supervisor = service.list().find((s) => s.supervisor && s.status !== 'exited' && s.peerId)
  if (!supervisor) {
    journal.add('announce', `supervisor unreachable, ack dropped: ${text.slice(0, 80)}`)
    return
  }
  try {
    await sendAnnounce(
      { groupId: activeScope.groupId, secret: activeScope.secret, text, toPeerId: supervisor.peerId! },
      { endpoint: resolveBrokerEndpoint() }
    )
  } catch (e) {
    reportError('announce', 'supervisor spawn-ack failed', e)
  }
}

const armSpawnAck = (id: string, name: string): void => {
  const existing = pendingSpawnAcks.get(id)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    pendingSpawnAcks.delete(id)
    const status = service.list().find((s) => s.id === id)?.status ?? 'gone'
    journal.add('session', `spawn-ack timeout for "${name}" (status ${status})`)
    void announceToSupervisor(composeSpawnFailText(name, status))
  }, SPAWN_ACK_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  pendingSpawnAcks.set(id, { name, timer })
}

/** Resolve a session's peer_id by polling, or null on timeout/exit (TS3). */
const waitForPeer = (id: string, timeoutMs: number): Promise<string | null> => {
  const POLL_MS = 500
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = (): void => {
      const s = service.list().find((r) => r.id === id)
      if (s?.peerId) return resolve(s.peerId)
      if (!s || s.status === 'exited' || Date.now() >= deadline) return resolve(null)
      const t = setTimeout(tick, POLL_MS)
      if (typeof t.unref === 'function') t.unref()
    }
    tick()
  })
}

// Auto join announce: when a fresh session's peer_id first resolves, tell the
// other peers a newcomer joined (excluding the joiner itself). Fire-and-forget,
// never on the spawn critical path. Doubles as the spawn-ack trigger (TS3).
service.on(
  'peer-resolved',
  ({ id, peerId, intent }: { id: string; peerId: string; intent: JoinAnnounceIntent }) => {
    void broadcastAnnounce(composeJoinAnnounce(peerId, intent), peerId)
    const pending = pendingSpawnAcks.get(id)
    if (pending) {
      clearTimeout(pending.timer)
      pendingSpawnAcks.delete(id)
      journal.add('session', `spawn-ack: "${pending.name}" connected as ${peerId}`)
      void announceToSupervisor(composeSpawnAckText(pending.name, peerId))
    }
  }
)

// "Needs you" system notification (PLAN C11): a session hit a permission /
// question / plan screen. Clicking brings the window up and selects the tile.
// Auto-ack of the development-channels warning (issue #42486): the Deck typed
// Enter on the dialog its own launch flag raised. Journaled so the automatic
// keystroke is never silent (a spurious ack is then diagnosable).
service.on('startup-ack', ({ name }: { id: string; name?: string }) => {
  journal.add('session', `auto-acknowledged the dev-channels warning for "${name ?? '?'}"`)
})

// Tiles currently on a waiting screen. This is what authorises typing a remote
// answer in: it must hold for BOTH producers (a hook-raised approval never
// passes through openApprovals below, so matching on that alone would silently
// drop every hook verdict).
const waitingTiles = new Set<string>()

// Approvals the DECK itself raised, per tile, so a local answer settles the
// remote one. Hook-raised approvals are not here — they are settled by the
// operator's channel and applied through the poller.
const openApprovals = new Map<string, string>()

/**
 * Apply approvals settled elsewhere (phone) to their session.
 *
 * Only the fallback path lands here: a hook or ask_operator verdict returns
 * through its own call. Guarded twice — the tile must still exist AND still be
 * waiting — because an answer arriving after the operator dealt with the
 * prompt locally must be dropped, not typed into whatever is on screen now.
 */
const pollApprovalVerdicts = async (): Promise<void> => {
  const deps = approvals.deps()
  if (!deps || !approvalsEnabled()) return
  try {
    const settled = await fetchUndeliveredVerdicts(deps)
    if (settled.length === 0) return
    const applied: string[] = []
    for (const approval of settled) {
      // tile_ref is a producer DECLARATION, not an authenticated field: it is
      // only ever used to look up a tile we own, and canApplyVerdict then
      // demands that tile still be the one waiting on this approval.
      const tile = approval.origin.tile_ref || approval.origin.session_ref
      const live = service.list().find((s) => s.id === tile)
      const state = live ? { exists: true, waiting: waitingTiles.has(tile) } : null
      if (!canApplyVerdict(approval, state)) {
        // Nothing to type, but it IS settled: mark it so it stops coming back.
        applied.push(approval.id)
        continue
      }
      const keys = buildKeystrokes(approval)
      if (!keys) {
        applied.push(approval.id)
        continue
      }
      service.write(tile, keys)
      waitingTiles.delete(tile)
      openApprovals.delete(tile)
      journal.add('attention', `answered "${live?.name ?? tile}" from ${approval.answered_via}`)
      applied.push(approval.id)
    }
    await markVerdictsDelivered(deps, applied)
  } catch (e) {
    reportError('approvals', 'verdict poll failed', e)
  }
}

service.on('attention', ({ id, waiting }: { id: string; waiting: boolean }) => {
  const session = service.list().find((s) => s.id === id)
  // The operator answered locally: settle the approval so the phone
  // notification is invalidated (the broker makes the two exclusive).
  if (!waiting) {
    waitingTiles.delete(id)
    const open = openApprovals.get(id)
    if (open) {
      openApprovals.delete(id)
      const deps = approvals.deps()
      if (deps) {
        void claimApproval(deps, { id: open, answerKind: 'allow' }).catch((e) =>
          reportError('approvals', 'could not settle a locally-answered approval', e)
        )
      }
    }
    return
  }
  waitingTiles.add(id)
  if (session) journal.add('attention', `session "${session.name}" waits for the operator`)
  // Fallback producer: sessions no hook covers (non-Claude CLIs, and open
  // questions detected on screen). Best-effort — never block the UI path.
  if (session && approvalsEnabled()) {
    const deps = approvals.deps()
    if (deps) {
      void addApproval(deps, {
        kind: 'question',
        title: session.name,
        question: `The session "${session.name}" is waiting for an answer on screen.`,
        sessionRef: id,
        tileRef: id,
        projectKey: computeDeckProjectKey(cliContext.projectDir),
        host: hostname(),
        // When the tile's peer has resolved, the broker delivers the answer as
        // a message (C-9) and nothing is typed. Non-Claude CLIs and
        // not-yet-registered tiles fall back to keystrokes.
        replyPeerId: session.peerId ?? undefined,
        groupId: activeScope.groupId
      })
        .then((a) => openApprovals.set(id, a.id))
        .catch((e) => reportError('approvals', 'could not raise an approval', e))
    }
  }
  if (!config.notifyAttention) return
  if (!Notification.isSupported()) return
  if (!session) return
  const isFr = (config.locale || app.getLocale()).toLowerCase().startsWith('fr')
  const n = new Notification({
    title: session.name,
    body: isFr ? 'attend une réponse de ta part' : 'is waiting for your input'
  })
  n.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
    mainWindow?.webContents.send('session:focus', id)
  })
  n.show()
})

// ----- Operator inbox (PLAN C12) -----
// Agents `send_message` to the reserved 'operator' peer; the broker parks those
// messages on the sentinel row and the Deck drains them here every 10 s
// (best-effort: the broker may not even be running before the first session
// spawns). Drained batches go to the renderer inbox + a system notification.
const INBOX_POLL_MS = 10_000
let inboxTimer: NodeJS.Timeout | null = null
// Drained batches whose disk write failed, retried on the next poll (O6): the
// broker already forgot them, this queue is their only copy.
const pendingInboxWrites: { id: number; from: string; text: string; sentAt: string }[] = []

// Broker reachability (PLAN O5): fed by the inbox poll below (one signal per
// tick -- pollGraphDrafts runs the same tick, feeding both would collapse the
// 2-failure hysteresis into a single tick). Transitions drive the renderer's
// red banner + the log/journal.
const brokerHealth = new BrokerHealthTracker((status) => {
  if (status.up) logInfo('broker', 'broker reachable again')
  else reportError('broker', `broker unreachable: ${status.lastError ?? 'unknown error'}`)
  broadcast('broker:status', status)
})

const notifyInbox = (batch: { from: string; text: string }[]): void => {
  if (!Notification.isSupported() || batch.length === 0) return
  const isFr = (config.locale || app.getLocale()).toLowerCase().startsWith('fr')
  const first = batch[0]!
  const n = new Notification(
    batch.length === 1
      ? { title: first.from, body: first.text.slice(0, 160) }
      : {
          title: isFr ? `${batch.length} messages d'agents` : `${batch.length} agent messages`,
          body: batch.map((m) => `${m.from}: ${m.text}`).join('\n').slice(0, 160)
        }
  )
  n.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
    mainWindow?.webContents.send('inbox:open')
  })
  n.show()
}

const pollOperatorInbox = async (): Promise<void> => {
  try {
    const messages = await fetchOperatorInbox(
      { groupId: activeScope.groupId, secret: activeScope.secret },
      { endpoint: resolveBrokerEndpoint() }
    )
    brokerHealth.recordSuccess()
    if (messages.length === 0 && pendingInboxWrites.length === 0) return
    const batch = messages.map((m) => ({
      id: m.id,
      from: m.from_peer_id,
      text: m.text,
      sentAt: m.sent_at
    }))
    // The broker drain is destructive (delivered=1): journal the batch to
    // disk BEFORE showing it, so a Deck restart replays the whole inbox. A
    // failed write re-queues the batch for the next tick (O6) -- these
    // messages exist nowhere else once drained.
    const toPersist = [...pendingInboxWrites.splice(0), ...batch]
    let failed = false
    appendInboxHistory(join(app.getPath('userData'), APP_STATE_SUBDIR), toPersist, undefined, (e) => {
      failed = true
      reportError('inbox', `history write failed (${toPersist.length} message(s) queued for retry)`, e)
    })
    if (failed) pendingInboxWrites.push(...toPersist)
    broadcast('inbox:new', batch)
    notifyInbox(batch)
  } catch (e) {
    // Broker down / unreachable: the next tick retries; the health tracker
    // owns the (deduplicated) reporting so this stays quiet per-tick.
    brokerHealth.recordFailure(e)
  }
}

// ----- Graph drafts poll -----
// Agent-escalated questions parked broker-side (non-destructive list: nothing
// is consumed until the operator opens a draft). The full pending list is
// pushed to the renderer (inbox cards + glowing rail glyph); a system
// notification fires once per new draft id.
const notifiedDraftIds = new Set<string>()
let lastDraftSignature = ''

const pollGraphDrafts = async (): Promise<void> => {
  try {
    const drafts = await fetchGraphDrafts(computeDeckProjectKey(config.projectDir), {
      endpoint: resolveBrokerEndpoint()
    })
    const list = drafts.map((d) => ({
      id: d.id,
      from: d.from_peer,
      title: d.title,
      prompt: d.prompt,
      createdAt: d.created_at
    }))
    const signature = list.map((d) => d.id).join(',')
    if (signature !== lastDraftSignature) {
      lastDraftSignature = signature
      broadcast('graphDrafts:update', list)
    }
    const fresh = list.filter((d) => !notifiedDraftIds.has(d.id))
    for (const d of fresh) notifiedDraftIds.add(d.id)
    if (fresh.length > 0 && Notification.isSupported()) {
      const isFr = (config.locale || app.getLocale()).toLowerCase().startsWith('fr')
      const first = fresh[0]!
      const n = new Notification({
        title: isFr ? `Question à ouvrir en graphe — ${first.from}` : `Graph question — ${first.from}`,
        body: first.title.slice(0, 160)
      })
      n.on('click', () => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send('inbox:open')
      })
      n.show()
    }
  } catch {
    // Broker down / unreachable: silent, the next tick retries.
  }
}

/**
 * Targeted announce to the window's TEAM-LEAD (PLAN C10). No lead designated:
 * no-op -- unless exactly ONE non-supervisor session is active, which is then
 * addressed with an explicit "no team-lead designated" mention (never silent
 * implicit routing). Best-effort like every announce.
 */
const announceToLead = async (text: string): Promise<number> => {
  if (!text.trim()) return 0
  const live = service
    .list()
    .filter((s) => !s.supervisor && s.status !== 'exited' && s.peerId)
  let target = live.find((s) => s.lead) ?? null
  let body = text
  if (!target) {
    if (live.length !== 1) return 0
    target = live[0]!
    body = `${text}\n(No team-lead is designated; you are the only active session.)`
  }
  try {
    const { sent } = await sendAnnounce(
      {
        groupId: activeScope.groupId,
        secret: activeScope.secret,
        text: body,
        toPeerId: target.peerId
      },
      { endpoint: resolveBrokerEndpoint() }
    )
    if (sent > 0) {
      journal.add('dispatch', `to lead "${target.peerId}": ${text.slice(0, 120)}`)
    }
    return sent
  } catch (e) {
    reportError('announce', 'lead announce failed', e)
    return 0
  }
}

// ----- Git checkpoints (PLAN C16) -----
// Before an agent spawns into a DIRTY tree, snapshot the tracked changes as a
// dangling stash commit anchored under refs/claude-peers/ (no history, no
// working-tree change). Best-effort: a non-git cwd or git error never blocks
// the spawn. Piggybacks the >7-day purge on each attempt.
const checkpointBeforeSpawn = async (dir: string): Promise<void> => {
  try {
    const cp = await createCheckpoint(dir)
    if (cp) {
      journal.add(
        'checkpoint',
        `checkpoint ${cp.sha.slice(0, 10)} of ${dir} before spawn — restore with: ${restoreCommand(cp)}`
      )
    }
    void purgeCheckpoints(dir).catch(() => undefined)
  } catch {
    // Clean tree handled inside; anything else (non-git dir) is a no-op.
  }
}

// ----- Queue → team-lead dispatch (PLAN C15) -----
// The operator queues roadmap items; dispatching sends the first one to the
// team-lead as a targeted announce (C10), unqueues it and remembers its id.
// A light watcher polls the tracked ids and auto-dispatches the next queued
// item when a dispatched one turns done — the "conveyor belt" loop.
//
// WAVE BARRIER load-bearing caveat (card 42edc88b phase 3, canAutoDispatchNext
// in ./dispatch): once an item is dispatched it is unqueued and moved back to
// planned (see dispatchNextInner below), so firstQueued no longer sees it —
// its wave membership exists ONLY in this in-memory Map. Before the barrier
// this tracking was informational (a completion journal / conveyor-belt
// trigger); the barrier makes it load-bearing for CORRECTNESS (it gates
// whether the next auto-dispatch may fire at all). A Deck restart mid-wave
// loses it and can over-dispatch past a wave that hadn't actually finished.
// seedDispatchedFromRoadmap (below, called once at startup) partially
// mitigates this: an isHead item (locked in_progress, queue null) is
// re-seeded as claimed:true, but an in_progress-but-UNLOCKED item is not (see
// that function's own doc comment for why, and its documented blind spot).
//
// LIFECYCLE (card 6f19206e): each entry's `claimed` flag distinguishes
// "dispatched, lead has not set it in_progress yet" from "lead actually
// picked it up" — see nextDispatchedState's doc comment in ./dispatch for
// why a bare Set (deleted on planned+unlocked) is wrong: a freshly
// dispatched item is planned+unlocked too, before it is claimed. Without
// this distinction, an operator stop (stopRoadmapItem) or an idle-lock
// release (watchIdleLocks) reverting a CLAIMED item back to planned never
// left the Set, permanently closing the barrier above.
const dispatchedIds = new Map<string, DispatchedEntry>()

// Card 0e55a30b / 5852c074 acceptance criterion 4: canAutoDispatchNext can
// stay false because the queued head depends on an item this Deck never
// dispatched (e.g. a locked in_progress item excluded from enqueueClosure's
// "active work" filter) — dispatchedIds never changes in that case, so
// watchDispatched's early bail on an empty Map would never retry once that
// dependency resolves. barrierPending keeps the watcher polling through that
// gap: armed only when the barrier closes specifically on an unmet
// dependency at the head (not when the queue is simply empty, which needs no
// retry), cleared once a dispatch actually fires or the queue empties. The
// pure transition (bun-testable) is nextBarrierPending in ./dispatch.
let barrierPending = false
const DISPATCH_WATCH_MS = 20_000

/**
 * Magic-compact chain for one target (CT4). When the plugin is available (flag
 * 'on', or 'auto' + detected), inject /magic-compact, capture the "/resume <id>"
 * banner from the tile's output, and re-enter the compacted session IN PLACE
 * (option A: the process never restarts, so peer_id and the launch harness are
 * preserved). On the plugin's shim-failure message or a timeout, fall back to a
 * standard /compact. When the plugin is disabled/absent, go straight to /compact.
 *
 * EMPIRICAL CHECKS deferred to BACKLOG (CT4): that argument-form `/resume <id>`
 * is honored in the TUI on the targeted CC versions, and that the harness
 * survives the in-app session switch. Options B (restart fork-resume) and C
 * (kill+respawn) are the documented fallbacks if A regresses.
 */
const runMagicCompact = async (
  tileId: string,
  peerId: string,
  useMagic: boolean,
  mode: MagicCompactMode
): Promise<void> => {
  if (!useMagic) {
    const why = mode === 'off' ? 'disabled' : 'plugin absent'
    const o = await service.injectCommand(tileId, '/compact')
    journal.add('dispatch', `magic_compact -> "${peerId}": ${why}, used /compact (${o})`)
    return
  }
  // Inject FIRST, then arm the scanner. Arming after the command is typed means
  // the scanner can never capture output that predates it (a stale /resume
  // banner or unrelated agent text), and the MAGIC_TIMEOUT_MS budget starts at
  // injection rather than being eaten by injectCommand's idle wait. If injection
  // never happens (no terminal / busy timeout) no scanner is armed, so no
  // listeners leak. The banner is a PTY macrotask, so the synchronous
  // waitForOutput() on the next line always attaches before it can arrive.
  const injected = await service.injectCommand(tileId, '/magic-compact')
  if (injected !== 'sent') {
    journal.add('dispatch', `magic_compact -> "${peerId}": /magic-compact not injected (${injected})`)
    return
  }
  const res = await service.waitForOutput(tileId, MAGIC_TIMEOUT_MS, (buf) => {
    const id = parseMagicResume(buf)
    if (id) return { kind: 'resume' as const, id }
    if (isMagicShimFailure(buf)) return { kind: 'shim' as const }
    return null
  })
  if (res?.kind === 'resume') {
    // Option A: re-enter in place. The id is a strict UUID from the agent's own
    // terminal, typed behind the code-constant /resume prefix.
    const o = await service.injectCommand(tileId, `/resume ${res.id}`)
    journal.add(
      'dispatch',
      `magic_compact -> "${peerId}": compacted, re-entered ${res.id.slice(0, 8)} (${o})`
    )
    return
  }
  const o = await service.injectCommand(tileId, '/compact')
  const why = res?.kind === 'shim' ? 'plugin shim (not intercepted)' : 'no banner within timeout'
  journal.add('dispatch', `magic_compact -> "${peerId}": ${why}, fell back to /compact (${o})`)
}

/**
 * Execute a directive card (CT3): the Deck itself types the command into the
 * terminals of the card's live targets. It NEVER announces to the lead. The
 * command is a code constant (directiveKeys); the card's payload only selects
 * which constant and which live tiles. Per-target injection is fire-and-forget
 * (idle-gated inside injectCommand) so the dispatch loop never blocks; each
 * injection journals its own outcome. No live target / unreachable targets are
 * journaled, never silently dropped.
 */
const executeDirective = async (item: RoadmapItem): Promise<void> => {
  const cmd = item.directive
  // Re-validate the enum Deck-side (hostile input #2: broker response field).
  if (!isDirectiveCommand(cmd)) {
    reportError('dispatch', `directive card "${item.title}" carries no valid command; skipped`)
    return
  }
  const keys = directiveKeys(cmd)
  const { matched, missing } = resolveDirectiveTargets(item.target_peer_ids, service.list())
  if (matched.length === 0) {
    journal.add(
      'dispatch',
      `directive ${keys} "${item.title}": no live target (requested: ${
        item.target_peer_ids.join(', ') || 'none'
      })`
    )
    return
  }
  // Resolve the magic-compact decision ONCE per card (not per target): both
  // resolveFeatures (config reads) and the plugin fs scan are invariant across
  // the card's targets. CLAUDE_CONFIG_DIR is honored so a relocated ~/.claude
  // is still probed.
  let magicMode: MagicCompactMode = 'off'
  let useMagic = false
  if (cmd === 'magic_compact') {
    magicMode = resolveFeatures(config.projectDir).magicCompact
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    useMagic = magicMode === 'on' || (magicMode === 'auto' && magicCompactPluginPresent(claudeConfigDir))
  }
  for (const t of matched) {
    if (cmd === 'magic_compact') {
      void runMagicCompact(t.id, t.peerId, useMagic, magicMode)
    } else {
      void service
        .injectCommand(t.id, keys)
        .then((outcome) => journal.add('dispatch', `directive ${keys} -> "${t.peerId}": ${outcome}`))
        .catch((e) => reportError('dispatch', `directive injection failed for "${t.peerId}"`, e))
    }
  }
  if (missing.length > 0) {
    journal.add(
      'dispatch',
      `directive ${keys} "${item.title}": ${missing.length} target(s) not reachable: ${missing.join(', ')}`
    )
  }
}

// Multi-dispatch (roadmap card 5852c074): sends the WHOLE head wave (all
// items sharing the queue's head rank, wavesOf in shared/workflow) to the
// team-lead per call, not just its first member. splitWave/dispatchNormalWave
// (./dispatch) hold the pure decision/orchestration logic so they stay
// bun-testable; this function only drives the Electron-coupled network calls
// and owns the dispatchedIds mutation (single source of truth, as before).
const dispatchNextInner = async (): Promise<DispatchResult> => {
  try {
    const endpoint = resolveBrokerEndpoint()
    const key = computeDeckProjectKey(config.projectDir)
    // Drain directive-only waves first: the Deck executes them itself (inject
    // + mark done) and pulls the next wave. The guard bounds the loop should a
    // done-write ever fail to advance it.
    for (let guard = 0; guard < 64; guard++) {
      const items = await listRoadmap(endpoint, key, {})
      const waveIds = wavesOf(queuedItems(items))[0]
      if (!waveIds || waveIds.length === 0) return { sent: false, reason: 'empty-queue' }
      const byId = new Map(items.map((i) => [i.id, i]))
      const wave = waveIds.map((id) => byId.get(id)).filter((i): i is RoadmapItem => i !== undefined)
      const { directives, normal } = splitWave(wave)
      // Directive members execute immediately, whatever the rest of the wave
      // holds (CT3 contract, unchanged: the Deck runs them, never announced).
      // Mark-then-execute, not execute-then-mark (card b1932a6a): see
      // runDirectiveWave's doc comment in dispatch.ts for the cost-asymmetry
      // rationale and the accepted gap this ordering trades for.
      await runDirectiveWave(directives, {
        markDone: async (item) => {
          await upsertRoadmap(endpoint, key, { id: item.id, queue: null, status: 'done' })
        },
        execute: executeDirective,
        journal: (line) => journal.add('dispatch', line),
        reportError: (message, error) => reportError('dispatch', message, error)
      })
      if (normal.length === 0) continue // all-directive wave: pull the next one
      const { result, dispatched, failed } = await dispatchNormalWave(normal, {
        announce: (text) => announceToLead(text),
        upsert: async (item) => {
          await upsertRoadmap(endpoint, key, {
            id: item.id,
            queue: null,
            status: item.status === 'idea' ? 'planned' : item.status
          })
        }
      })
      for (const item of dispatched) dispatchedIds.set(item.id, { claimed: false })
      for (const { item, error } of failed) {
        reportError('dispatch', `wave member "${item.title}" failed to unqueue, not tracked`, error)
      }
      return result
    }
    return { sent: false, reason: 'error' }
  } catch (e) {
    reportError('dispatch', 'dispatch failed', e)
    return { sent: false, reason: 'error' }
  }
}

// Re-entrancy guard: dispatchNext is reachable both from the watchDispatched
// timer and the operator's manual dispatch IPC. Two overlapping runs could read
// the same head-of-queue directive before either marks it done and double-
// inject it (a duplicate /clear could wipe a freshly re-entered context). A
// single in-flight run is shared so concurrent callers coalesce onto it.
let dispatchInFlight: Promise<DispatchResult> | null = null
const dispatchNext = (): Promise<DispatchResult> => {
  if (dispatchInFlight) return dispatchInFlight
  dispatchInFlight = dispatchNextInner().finally(() => {
    dispatchInFlight = null
  })
  return dispatchInFlight
}

const watchDispatched = async (): Promise<void> => {
  if (dispatchedIds.size === 0 && !barrierPending) return
  try {
    const endpoint = resolveBrokerEndpoint()
    const key = computeDeckProjectKey(config.projectDir)
    const items = await listRoadmap(endpoint, key, { include_archived: true })
    let completed = false
    // Per-id lifecycle transition (card 6f19206e, nextDispatchedState in
    // ./dispatch): EVERY 'remove' outcome -- not just done/archived -- must
    // flip `completed`, so an abandonment (operator stop, idle-lock release)
    // re-arms the barrier check below exactly like a real completion does.
    // Only the journal wording differs by reason.
    for (const [id, entry] of [...dispatchedIds]) {
      const it = items.find((i) => i.id === id)
      const action = nextDispatchedState(entry, it)
      switch (action.kind) {
        case 'claim':
          dispatchedIds.set(id, { claimed: true })
          break
        case 'remove':
          dispatchedIds.delete(id)
          completed = true
          if (it) {
            const label = action.reason === 'abandoned' ? 'abandoned (claimed, then reverted before completion)' : action.reason
            journal.add('dispatch', `dispatched item ${label}: "${it.title}"`)
          } else {
            journal.add('dispatch', `dispatched item vanished from the roadmap: ${id.slice(0, 8)}`)
          }
          break
        case 'keep':
          break
      }
    }
    // R5 wave barrier (card 42edc88b phase 3, canAutoDispatchNext in
    // ./dispatch): only the AUTOMATIC path is gated here -- the manual
    // "send first to team-lead" button (ipc.ts roadmap:dispatch) calls
    // dispatchNext() directly, unguarded, and stays the operator's escape
    // hatch when the barrier holds (an abandoned in-flight item, or a head
    // whose dependency stalls).
    //
    // barrierPending (card 0e55a30b, absorbed into 5852c074) closes the gap a
    // pure dispatchedIds watch has: the queued head's depends_on can
    // reference an item this Deck never dispatched (e.g. a locked in_progress
    // item, excluded from enqueueClosure's "active work, not queueable"
    // filter), so dispatchedIds itself never changes when THAT dependency
    // resolves. `retry` below runs the check on every tick while a
    // dependency block is outstanding, not only on a completion transition;
    // journal lines still only fire on an actual state change (dispatch
    // success, or entering/leaving the blocked state), so a stuck item
    // doesn't flood the journal every DISPATCH_WATCH_MS.
    const retry = completed || (dispatchedIds.size === 0 && barrierPending)
    if (retry) {
      let dispatchSucceeded = false
      let attempted = false
      let dispatchReason: DispatchResult['reason'] | undefined
      if (canAutoDispatchNext(items, dispatchedIds)) {
        attempted = true
        const r = await dispatchNext()
        dispatchSucceeded = r.sent
        dispatchReason = r.reason
        if (r.sent) {
          journal.add(
            'dispatch',
            r.count
              ? `auto-dispatched next queued wave: ${r.count} items (${(r.titles ?? []).join(', ')})`
              : `auto-dispatched next queued item: "${r.title}"`
          )
        }
      } else if (dispatchedIds.size > 0 && completed) {
        journal.add(
          'dispatch',
          `wave barrier: waiting on ${dispatchedIds.size} more dispatched item(s) before advancing the queue`
        )
      }
      const wasBarrierPending = barrierPending
      barrierPending = nextBarrierPending(barrierPending, dispatchedIds.size, dispatchSucceeded, firstQueued(items) !== null)
      if (barrierPending && !wasBarrierPending) {
        // Two distinct diagnoses share this arming: canAutoDispatchNext
        // returning false (the head's dependency hasn't resolved yet) vs.
        // it returning true but the dispatch itself failing (attempted,
        // e.g. no team-lead connected). Report whichever actually happened,
        // not a fixed "unmet dependencies" string that would be wrong for
        // the second case. The "send first to team-lead" override is only
        // valid advice for the dependency case and the generic-failure case
        // -- it goes through the same announceToLead and would fail
        // identically when no lead is connected, so that branch gets its
        // own non-actionable wording instead.
        const reason =
          attempted && !dispatchSucceeded
            ? dispatchReason === 'no-lead'
              ? 'no team-lead connected, waiting for a lead to connect'
              : `dispatch failed (${dispatchReason ?? 'unknown'}), will retry (use "send first to team-lead" to override)`
            : 'next queued item has unmet dependencies, waiting (use "send first to team-lead" to override)'
        journal.add('dispatch', `wave barrier: ${reason}`)
      } else if (!barrierPending && wasBarrierPending && !dispatchSucceeded) {
        // The only other transition out of "pending": the head cleared from
        // the queue without going through a successful dispatch on THIS
        // tick (e.g. it was handled manually via the escape hatch above).
        // Excludes dispatchSucceeded on purpose: a successful auto-dispatch
        // already journaled its own "auto-dispatched next queued ..." line
        // above, and nextBarrierPending clears on that same success, so
        // without this guard the resolving tick would log both lines.
        journal.add('dispatch', 'wave barrier: cleared, queue advancing')
      }
    }
  } catch {
    // Broker down: the next tick retries.
  }
}

/**
 * Restart-time seed (roadmap card 5852c074, acceptance criterion 5): called
 * once at startup, before the watcher's first tick. dispatchedIds is
 * in-memory only (see its own doc comment above) — a Deck restart loses it
 * entirely, so an item the PREVIOUS process dispatched and the lead already
 * claimed becomes invisible to nextDispatchedState on the new process: never
 * tracked, so its eventual completion never re-arms the barrier for the
 * queue behind it.
 *
 * Seeds every isHead item (shared/workflow: locked, in_progress, queue null)
 * as claimed:true, not claimed:false — isHead REQUIRES status in_progress by
 * construction, so "claimed" (observed in_progress at least once — see
 * nextDispatchedState's doc comment on the 6f19206e semantic shift) is a
 * direct logical consequence here, not an approximation.
 *
 * BLIND SPOT, deliberately left open: isHead also REQUIRES `locked`, so an
 * in_progress-but-UNLOCKED item (e.g. a Deck-authored kanban drag, right
 * after a restart) is seeded as neither claimed nor tracked — exactly the
 * case the 6f19206e fix addressed for a LIVE Deck. A freshly restarted Deck
 * cannot tell that case apart from an item that was never dispatched at all
 * (both read as unlocked+in_progress from its fresh-boot point of view), so
 * this seed intentionally leaves it untracked: the manual "send first to
 * team-lead" button remains the escape hatch.
 *
 * Deliberately excludes: queued-but-not-dispatched items (queue non-null —
 * still visible to wavesOf/firstQueued, seeding them here would double-count
 * them once they are actually dispatched) and items locked via
 * assignRoadmapItem's direct-assign path (K6) — that Deck-authored upsert
 * never sets `locked` itself (broker.ts only grants the lock to a non-'deck'
 * author), so a fresh assign reads as unlocked and isHead already excludes
 * it without any extra filtering needed here.
 */
const seedDispatchedFromRoadmap = async (): Promise<void> => {
  try {
    const endpoint = resolveBrokerEndpoint()
    const key = computeDeckProjectKey(config.projectDir)
    const items = await listRoadmap(endpoint, key, {})
    for (const item of items) {
      if (isHead(item)) dispatchedIds.set(item.id, { claimed: true })
    }
    if (dispatchedIds.size > 0) {
      journal.add('dispatch', `restart seed: tracking ${dispatchedIds.size} already in-progress item(s)`)
    }
  } catch (e) {
    // Unlike watchDispatched's catch (retried every DISPATCH_WATCH_MS, so
    // "next tick retries" is literally true), this seed is a ONE-SHOT call at
    // startup: a broker that is merely slow to come up during the boot
    // window silently disables the mitigation for the entire process
    // lifetime, in exactly the case it exists to guard (auto-dispatching
    // over an unfinished wave). Trace it so that failure is visible.
    reportError('dispatch', 'restart seed failed; in-progress items not re-tracked', e)
  }
}
let dispatchTimer: NodeJS.Timeout | null = null

// ----- Direct assignment to one chosen peer (PLAN K6) -----
// The operator's "process now" flow: a targeted announce (CODE CONSTANT,
// composeAssignText) to the selected live peer, then the item moves to
// in_progress (unqueued). The lock arrives when the agent actually claims it
// with its own roadmap_update, like the launch/dispatch flows.
const assignRoadmapItem = async (id: string, peerId: string): Promise<AssignResult> => {
  const target = peerId.trim()
  if (!target) return { sent: false }
  try {
    const endpoint = resolveBrokerEndpoint()
    const key = computeDeckProjectKey(config.projectDir)
    const items = await listRoadmap(endpoint, key, {})
    const item = items.find((i) => i.id === id)
    if (!item) return { sent: false }
    const { sent } = await sendAnnounce(
      {
        groupId: activeScope.groupId,
        secret: activeScope.secret,
        text: composeAssignText(item),
        toPeerId: target
      },
      { endpoint }
    )
    if (sent === 0) return { sent: false }
    await upsertRoadmap(endpoint, key, { id: item.id, status: 'in_progress', queue: null })
    journal.add('dispatch', `item "${item.title}" assigned to "${target}"`)
    return { sent: true }
  } catch (e) {
    reportError('dispatch', 'assign failed', e)
    return { sent: false }
  }
}

// ----- Operator stop on an in_progress item (PLAN K3) -----
// Notifies the agents (via the SUPERVISOR when one is live, so the operator
// gets a report back through the inbox; group broadcast otherwise), then
// releases the lock and drops the item back to 'planned'. The stop text is a
// CODE CONSTANT (C8 rule) composed in dispatch.ts.
const stopRoadmapItem = async (id: string): Promise<StopResult> => {
  const endpoint = resolveBrokerEndpoint()
  const key = computeDeckProjectKey(config.projectDir)
  const items = await listRoadmap(endpoint, key, {})
  const item = items.find((i) => i.id === id)
  if (!item) return { stopped: false, via: 'none' }

  // Notify first (while the item still names the working peer), then unlock.
  let via: StopResult['via'] = 'none'
  const supervisor = service
    .list()
    .find((s) => s.supervisor && s.status !== 'exited' && s.peerId)
  if (supervisor) {
    try {
      const { sent } = await sendAnnounce(
        {
          groupId: activeScope.groupId,
          secret: activeScope.secret,
          text: composeStopText(item, true),
          toPeerId: supervisor.peerId!
        },
        { endpoint }
      )
      if (sent > 0) via = 'supervisor'
    } catch {
      // Supervisor unreachable: fall through to the group broadcast.
    }
  }
  if (via === 'none') {
    const sent = await broadcastAnnounce(composeStopText(item, false))
    if (sent > 0) via = 'broadcast'
  }

  await upsertRoadmap(
    endpoint,
    key,
    item.status === 'in_progress'
      ? { id: item.id, status: 'planned', locked: false }
      : { id: item.id, locked: false }
  )
  journal.add('dispatch', `stop requested on "${item.title}" (via ${via})`)
  return { stopped: true, via }
}

// ----- Deck-side lock release on idle terminals (PLAN K2) -----
// A locked item whose owner is one of THIS window's tiles with a silent PTY
// for LOCK_IDLE_MS is released (back to 'planned'). Finer than the broker's
// sweep -- the heartbeat keeps a peer 'active' even when Claude sits idle --
// but only covers sessions this Deck can observe; remote/CLI sessions rely on
// the broker's TTL + owner-gone sweep.
const LOCK_IDLE_MS = 2 * 3600_000
const LOCK_WATCH_MS = 60_000
const watchIdleLocks = async (): Promise<void> => {
  try {
    const endpoint = resolveBrokerEndpoint()
    const key = computeDeckProjectKey(config.projectDir)
    const items = await listRoadmap(endpoint, key, {})
    for (const item of items) {
      if (!item.locked || !item.locked_by) continue
      const owner = service
        .list()
        .find((s) => s.peerId === item.locked_by && s.status !== 'exited')
      if (!owner) continue // not one of our tiles: the broker sweep owns it
      const last = service.lastOutputAt(owner.id)
      if (last === null || Date.now() - last < LOCK_IDLE_MS) continue
      await upsertRoadmap(endpoint, key, { id: item.id, status: 'planned', locked: false })
      journal.add('dispatch', `lock released on "${item.title}" (session "${owner.name}" idle)`)
    }
  } catch {
    // Broker down: the next tick retries.
  }
}
let lockWatchTimer: NodeJS.Timeout | null = null

/**
 * Containment + approval gate for applying a template (B4 + M-SEC-9). Returns
 * the inputs to spawn, or null when: the path is outside the allowed template
 * dirs, the file is malformed, or a REPO-LOCAL template carrying a shell-bearing
 * `command`/`args` was declined by the operator. Global (operator-owned)
 * templates are trusted and never prompt. Approval is keyed per project +
 * template basename + shell-field content hash, so an unchanged approved
 * template re-applies silently while an edited command re-prompts.
 */
const resolveTemplateInputs = (path: string): TemplateInput[] | null => {
  const projectDir = getConfig().projectDir
  const source = templateSource(path, projectDir)
  if (!source) {
    reportError('template', `refused template path outside the allowed dirs: ${path}`)
    return null
  }
  const tpl = readTemplate(path)
  if (!tpl) return null
  if (source === 'local' && templateHasShellFields(tpl)) {
    const key = `${computeDeckProjectKey(projectDir)}::template::${basename(path)}`
    const value = JSON.stringify(
      tpl.sessions.map((s) => ({ command: s.command ?? '', args: s.args ?? '' }))
    )
    const file = approvalsFile()
    if (!isApproved(file, key, value)) {
      const isFr = isFrLocale()
      const preview = tpl.sessions
        .filter((s) => (s.command && s.command.trim()) || (s.args && s.args.trim()))
        .map((s) => `• ${[s.command, s.args].filter(Boolean).join(' ')}`)
        .join('\n')
      const ok =
        dialog.showMessageBoxSync({
          type: 'warning',
          buttons: isFr ? ['Appliquer ce modèle', 'Refuser'] : ['Apply this template', 'Refuse'],
          defaultId: 1,
          cancelId: 1,
          title: 'Koryphaios',
          message: isFr
            ? 'Ce modèle (config du projet) exécute des commandes personnalisées.'
            : 'This project template runs custom commands.',
          detail: isFr
            ? `Modèle : ${basename(path)}\n\n${preview}\n\nCes commandes seront exécutées dans un shell. N'accepte que si tu fais confiance à ce dépôt.`
            : `Template: ${basename(path)}\n\n${preview}\n\nThese commands run in a shell. Accept only if you trust this repository.`
        }) === 0
      if (!ok) {
        journal.add('session', `project template refused: ${basename(path)}`)
        return null
      }
      approve(file, key, value)
      journal.add('session', `project template approved: ${basename(path)}`)
    }
  }
  return templateToInputs(tpl)
}

// ----- Supervisor spawn approval (PLAN TS4) -----
// The trust-mode gate behind deck_spawn_session / deck_spawn_team. hands-free:
// no UI (the consent rule lives in the supervisor's system prompt); team-review:
// ONE recap dialog approves/refuses the whole plan; full-control: one dialog per
// entry. Dialogs reuse the native pattern of the template approval (B4).
const summaryLine = (s: SpawnSummary): string => {
  const parts = [
    `• ${s.name}`,
    s.embedded ? `[embedded: ${s.embedded}]` : s.agent ? `[agent: ${s.agent}]` : '',
    s.model ? `model ${s.model}` : '',
    s.effort ? `effort ${s.effort}` : '',
    s.worktree_branch ? `⎇ ${s.worktree_branch}` : ''
  ].filter(Boolean)
  const head = parts.join('  ')
  return s.prompt_preview ? `${head}\n   ${s.prompt_preview}` : head
}

const spawnDialog = (title: string, detail: string): boolean => {
  const isFr = isFrLocale()
  return (
    dialog.showMessageBoxSync({
      type: 'question',
      buttons: isFr ? ['Lancer', 'Refuser'] : ['Spawn', 'Refuse'],
      defaultId: 0,
      cancelId: 1,
      title: 'Koryphaios',
      message: title,
      detail
    }) === 0
  )
}

const approveSpawn = async (entries: SpawnSummary[]): Promise<boolean[]> => {
  const mode = getConfig().supervisorSpawnMode
  if (mode === 'hands-free' || entries.length === 0) return entries.map(() => true)
  const isFr = isFrLocale()
  if (mode === 'team-review') {
    const ok = spawnDialog(
      isFr
        ? `Le superviseur veut lancer ${entries.length} session(s) d'agent`
        : `The supervisor wants to spawn ${entries.length} agent session(s)`,
      entries.map(summaryLine).join('\n')
    )
    journal.add('session', `supervisor spawn plan (${entries.length}) ${ok ? 'approved' : 'refused'}`)
    return entries.map(() => ok)
  }
  // full-control: one decision per entry.
  const decisions: boolean[] = []
  for (const entry of entries) {
    const ok = spawnDialog(
      isFr
        ? `Le superviseur veut lancer la session "${entry.name}"`
        : `The supervisor wants to spawn the session "${entry.name}"`,
      summaryLine(entry)
    )
    if (!ok) journal.add('session', `supervisor spawn refused: "${entry.name}"`)
    decisions.push(ok)
  }
  return decisions
}

// ----- Supervisor deck-control (PLAN C5) -----
// The loopback control endpoint the SUPERVISOR session pilots the app through.
// Started lazily at the first Home visit; the URL/token pair is injected only
// into the supervisor's generated --mcp-config, never into normal sessions.
const controlDeps: DeckControlDeps = {
  listAgents: () => listAgents(getConfig().projectDir),
  listModels: () => resolveLaunchConfig(getConfig().projectDir).models,
  listPresets: () => resolveLaunchConfig(getConfig().projectDir).presets,
  spawnSession: (input) =>
    createSessionWithWorktree(
      service,
      getConfig().projectDir,
      input,
      checkpointBeforeSpawn,
      getWorktreeInit(),
      sandboxGate,
      warmSandboxTranscripts
    ),
  listSessions: () => service.list(),
  sandboxExec: (command) => sandbox.supervisorExec(command),
  restartSession: (id) => void service.restart(id),
  closeSession: (id) => service.remove(id),
  createWorktree: async (branch) => {
    const wt = await createWorktree(getConfig().projectDir, branch)
    const init = getWorktreeInit()
    if (init) runWorktreeInit(wt.path, init)
    journal.add('worktree', `worktree created on ⎇ ${wt.branch} (supervisor)`)
    return wt
  },
  listWorktrees: () => listWorktrees(getConfig().projectDir),
  removeWorktree: async (path) => {
    await removeWorktree(getConfig().projectDir, path)
    journal.add('worktree', `worktree removed: ${path} (supervisor)`)
  },
  listTemplates: () => listTemplates(getConfig().projectDir),
  // Append-only by contract (deck-control): never closes existing tiles.
  applyTemplate: async (path) => {
    const inputs = resolveTemplateInputs(path)
    if (!inputs) return 0
    // One checkpoint covers the whole batch (all spawn into the project dir).
    if (inputs.length > 0) await checkpointBeforeSpawn(getConfig().projectDir)
    // Template lead only lands when the window has none yet (PLAN C18).
    const hasLead = service.list().some((s) => s.lead && s.status !== 'exited')
    for (const input of inputs) {
      await createSessionWithWorktree(
        service,
        getConfig().projectDir,
        hasLead ? { ...input, lead: undefined } : input,
        undefined,
        getWorktreeInit(),
        sandboxGate,
        warmSandboxTranscripts
      )
    }
    return inputs.length
  },
  saveTemplate: (name, local) => {
    const tpl = toTemplate(service.captureSessions(), name)
    const dir = local ? localTemplatesDir(getConfig().projectDir) : globalTemplatesDir()
    return writeTemplate(dir, name || tpl.name || 'template', tpl)
  },
  announce: (text) => broadcastAnnounce(text),
  // Team spawn (TS2-TS4): trust-mode gate, sync/async connection acks, and the
  // embedded profile prompt regenerated from the code constant at every spawn.
  approveSpawn,
  waitForPeer,
  armSpawnAck,
  writeEmbeddedPrompt: (id) =>
    writeEmbeddedAgentPrompt(join(app.getPath('userData'), APP_STATE_SUBDIR), id)
}

let controlServer: DeckControlServer | null = null
let companionServer: CompanionServer | null = null

/**
 * Return the live supervisor session, resume an exited one, or spawn it:
 * deck-control endpoint up, --mcp-config regenerated (per-launch token), role
 * anchored at system-prompt level via a file regenerated from the CODE
 * CONSTANT (never operator/repo-configurable -- PLAN C8 security decision:
 * a customizable harness could silently repurpose a session that pilots the
 * app; no --agent profile for the supervisor for the same reason).
 */
const ensureSupervisor = async (): Promise<SessionRuntime> => {
  const existing = service.list().find((s) => s.supervisor)
  if (existing && existing.status !== 'exited') return existing
  if (existing) return service.restart(existing.id)

  if (!deckPluginDir) throw new Error('deck-plugin dir missing (build skipped)')
  const mcpScript = join(deckPluginDir, 'mcp', 'deck-control-mcp.mjs')
  if (!existsSync(mcpScript)) {
    throw new Error('deck-control MCP script missing -- run `npm run build:mcp`')
  }
  if (!controlServer) controlServer = await startDeckControl(controlDeps)
  const stateDir = join(app.getPath('userData'), APP_STATE_SUBDIR)
  const mcpConfig = writeSupervisorMcpConfig({
    dir: stateDir,
    mcpScriptPath: mcpScript,
    execPath: process.execPath,
    controlUrl: controlServer.url,
    controlToken: controlServer.token
  })
  const appendSystemPromptFile = writeSupervisorSystemPrompt(stateDir, resolveDocsDir())
  return service.create({
    name: SUPERVISOR_NAME,
    prompt: SUPERVISOR_BRIEFING,
    supervisor: true,
    mcpConfig,
    appendSystemPromptFile,
    announce: 'supervisor session joined this group'
  })
}

/**
 * Adopt a restored workspace's scope. No-op once a session is running (the scope
 * is fixed at first spawn). Ephemeral workspaces mint a fresh secret; a custom
 * one is only reused if its groupId matches the launched scope (DESIGN 6.8).
 */
const adoptScope = (ws: { groupId: string; scopeKind: 'ephemeral' | 'custom' }): void => {
  if (service.hasLiveSessions()) return
  let next = resolveAdoptedScope(ws, activeScope, cliContext.projectDir)
  // D8: resolveAdoptedScope falls back to a fresh ephemeral when the launched
  // scope does not match the workspace's custom group. If we remembered that
  // group's secret, rebuild the scope from it to rejoin the same group.
  if (next.groupId !== ws.groupId && ws.scopeKind === 'custom' && config.rememberScopeSecrets) {
    const remembered = recallScopeSecret(secretsDir(), secretCipher, ws.groupId)
    if (remembered) next = computeScope(cliContext.projectDir, remembered)
  }
  if (next === activeScope) return
  activeScopeEnv.cleanup()
  activeScope = next
  activeScopeEnv = buildScopeEnv(activeScope)
}

const workspaces = new WorkspaceService({
  projectDir: cliContext.projectDir,
  service,
  getConfig,
  setConfig: (patch) => void setConfig(patch),
  getScope: () => activeScope,
  adoptScope
})

// Grey out File > Export template... when there is nothing to export. Kept in
// sync with the live session list (separate from the auto-save handler below,
// which early-returns on the empty list -- exactly when we must DISABLE).
const syncExportTemplateEnabled = (): void => {
  const item = Menu.getApplicationMenu()?.getMenuItemById('export-template')
  if (item) item.enabled = service.list().length > 0
}
service.on('changed', syncExportTemplateEnabled)

// Continuously auto-save the live workspace (debounced) as sessions change, but
// only once there ARE sessions -- launching empty must not mint/clobber a
// workspace (the previous run stays restorable until the user acts).
let autoSaveTimer: NodeJS.Timeout | null = null
service.on('changed', (sessions: unknown[]) => {
  if (!Array.isArray(sessions) || sessions.length === 0) return
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => {
    // A workspace I/O error must never take down the main process.
    try {
      const summary = workspaces.saveAuto()
      // Keep the renderer's window title in sync with the current workspace.
      broadcast('workspace:current', summary)
    } catch (e) {
      reportError('workspace', 'auto-save failed', e)
    }
  }, 1000)
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: config.theme === 'light' ? '#f5f5f5' : '#1e1e1e',
    title: 'Koryphaios',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // Embedded browser view (PLAN D1): the renderer hosts a <webview> tag.
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Open external links (e.g. OAuth completion pages) in the system browser.
  // Scheme-gated: openExternal launches whatever the OS registered for a
  // scheme, and the links reaching here come from sandboxed CLIs and remote
  // pages. Anything that is not http(s) -- `about:`, `file:`, a custom
  // protocol -- is refused with a trace rather than handed to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalUrl(url)
    if (safe) void shell.openExternal(safe)
    else reportError('deck', `refused to open a non-http(s) external link: ${url}`)
    return { action: 'deny' }
  })

  // Screen recording (browser view REC): getDisplayMedia is served with the
  // Deck's OWN window, always — no OS picker, no arbitrary-source access from
  // the renderer. Cropping to the browser pane happens renderer-side.
  mainWindow.webContents.session.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer
      .getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
      .then((sources) => {
        const own = mainWindow && sources.find((s) => s.id === mainWindow?.getMediaSourceId())
        if (own) callback({ video: own })
        else {
          reportError('browser', 'recording: own window not found among capture sources')
          callback({})
        }
      })
      .catch((e) => {
        reportError('browser', 'recording: desktopCapturer.getSources failed', e)
        callback({})
      })
  })

  // Embedded browser (PLAN D1): pages loaded in the <webview> never open new
  // Electron windows — window.open/target=_blank goes to the system browser.
  mainWindow.webContents.on('did-attach-webview', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      const safe = safeExternalUrl(url)
      if (safe) void shell.openExternal(safe)
      else reportError('browser', `refused to open a non-http(s) external link: ${url}`)
      return { action: 'deny' }
    })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = config.theme
  // PLAN C19: gate a PROJECT-sourced launchCommand behind a one-time operator
  // approval (hash remembered per project_key; a changed command asks again;
  // refusal keeps the global/default command for this run).
  const projCmd = projectLaunchCommand(cliContext.projectDir)
  if (projCmd && projCmd.trim() !== safeLaunchCommand.trim()) {
    const isFr = isFrLocale()
    const decision = resolveApprovedLaunchCommand({
      projectKey: computeDeckProjectKey(cliContext.projectDir),
      projectCommand: projCmd,
      fallback: safeLaunchCommand,
      approvalsFile: approvalsFile(),
      confirm: (command) =>
        dialog.showMessageBoxSync({
          type: 'warning',
          buttons: isFr ? ['Utiliser cette commande', 'Refuser'] : ['Use this command', 'Refuse'],
          defaultId: 1,
          cancelId: 1,
          title: 'Koryphaios',
          message: isFr
            ? 'Ce projet définit sa propre commande de lancement des sessions.'
            : 'This project defines its own session launch command.',
          detail: isFr
            ? `Commande (config du projet) :\n\n${command}\n\nElle sera exécutée dans chaque terminal de session de ce projet. N'accepte que si tu fais confiance à ce dépôt. Refuser garde la commande globale.`
            : `Command (project config):\n\n${command}\n\nIt will run in every session terminal of this project. Accept only if you trust this repository. Refusing keeps the global command.`
        }) === 0
    })
    if (decision.source === 'project') {
      service.setLaunchCommand(decision.command)
      if (decision.prompted) journal.add('session', `project launchCommand approved: ${decision.command}`)
    } else {
      journal.add('session', 'project launchCommand refused — using the global command')
    }
  }
  // B5: gate a PROJECT-sourced worktreeInit the same way. A repo-shipped
  // `.claude/claude-peers/config.json` worktreeInit runs through a shell on
  // worktree creation, so it only lands after a one-time operator approval;
  // refusal falls back to the global hook (or none).
  {
    const projWti = projectWorktreeInit(cliContext.projectDir)
    const globalWti = globalWorktreeInit()
    if (projWti && projWti.trim() && projWti.trim() !== (globalWti ?? '').trim()) {
      const isFr = isFrLocale()
      const decision = resolveApprovedLaunchCommand({
        projectKey: `${computeDeckProjectKey(cliContext.projectDir)}::worktreeInit`,
        projectCommand: projWti,
        fallback: globalWti ?? '',
        approvalsFile: approvalsFile(),
        confirm: (command) =>
          dialog.showMessageBoxSync({
            type: 'warning',
            buttons: isFr ? ['Exécuter ce hook', 'Refuser'] : ['Run this hook', 'Refuse'],
            defaultId: 1,
            cancelId: 1,
            title: 'Koryphaios',
            message: isFr
              ? 'Ce projet définit un hook exécuté à la création de worktree.'
              : 'This project defines a worktree-creation init hook.',
            detail: isFr
              ? `Hook (config du projet) :\n\n${command}\n\nIl sera exécuté dans un shell à chaque création de worktree de ce projet. N'accepte que si tu fais confiance à ce dépôt. Refuser désactive ce hook.`
              : `Hook (project config):\n\n${command}\n\nIt will run in a shell on every worktree creation for this project. Accept only if you trust this repository. Refusing disables the hook.`
          }) === 0
      })
      approvedWorktreeInit = decision.source === 'project' ? decision.command : globalWti || undefined
      journal.add(
        'session',
        decision.source === 'project'
          ? `project worktreeInit approved: ${decision.command}`
          : 'project worktreeInit refused — hook disabled'
      )
    } else {
      // No project override (or it equals the global one): the global hook is
      // operator-owned and trusted, no prompt.
      approvedWorktreeInit = (projWti && projWti.trim()) || globalWti || undefined
    }
  }
  // Tailored menu (drops the confusing default Edit roles); no auto-open DevTools.
  // "New (clear)" routes through the renderer so it can confirm before clearing.
  const toRenderer = (channel: string, payload?: unknown): void =>
    mainWindow?.webContents.send(channel, payload)
  Menu.setApplicationMenu(
    buildAppMenu({
      onOpenSettings: () => toRenderer('menu:settings'),
      onNewClear: () => toRenderer('menu:new-clear'),
      onSave: () => toRenderer('menu:save'),
      onSaveAs: () => toRenderer('menu:save-as'),
      onRestore: () => toRenderer('menu:restore'),
      onListWorkspaces: () => toRenderer('menu:list'),
      onExportTemplate: () => toRenderer('menu:export-template'),
      onImportTemplate: () => toRenderer('menu:import-template')
    })
  )
  // Reflect the initial session count on the Export-template menu item (the app
  // starts empty, so it begins disabled).
  syncExportTemplateEnabled()
  // Design endpoint (PLAN D2b): up before service.start() so even restored
  // sessions get the env pair. Picks are forwarded to the renderer, which
  // composes the prompt and routes it to the docked/selected agent.
  startDesignEndpoint((event) => {
    mainWindow?.webContents.send('design:pick', event)
    journal.add('review', `design pick from ${event.source || 'an external app'}: <${event.pick.tagName}>`)
  })
    .then((srv) => {
      designServer = srv
    })
    .catch((e) => reportError('design', 'design endpoint failed to start', e))
  // Companion server (PLAN MB1/MB2): LAN bridge, started only by the operator
  // via the 📱 button. Ephemeral by design — quitting the app revokes it.
  companionServer = new CompanionServer({
    staticDir: join(__dirname, '../renderer'),
    stateDir: join(app.getPath('userData'), APP_STATE_SUBDIR),
    journal: (msg) => journal.add('session', msg),
    onStatus: (info) => broadcast('companion:changed', info),
    // Lot 2: surface a device connection to the operator (renderer toast) so an
    // unexpected reconnect from a lost device is visible, not just journaled.
    onDeviceConnected: (addr, kind) => broadcast('companion:device-connected', { addr, kind })
  })
  regHandle('companion:start', async () => {
    const info = await companionServer!.start()
    return info
  })
  regHandle('companion:stop', async () => {
    await companionServer!.stop()
    return companionServer!.info
  })
  regHandle('companion:status', () => companionServer!.info)
  // Lot 2: paired-device management (list + manual revoke = lost-phone kill switch).
  regHandle('companion:devices', () => companionServer!.listDevices())
  regHandle('companion:revoke', (_e, id: string) => companionServer!.revokeDevice(id))
  regHandle('companion:revoke-all', () => companionServer!.revokeAllDevices())

  // ----- Remote-approval channels (PLAN N3/N4) -----
  // The bot token is handed to the BROKER, which seals it and runs the single
  // gateway (Telegram allows one getUpdates consumer per token). It never comes
  // back: only a 4-character hint does.
  regHandle('approvals:channels', async () => {
    const deps = approvals.deps()
    if (!deps) return []
    return listChannels(deps)
  })
  regHandle(
    'approvals:connect',
    async (_e, kind: 'telegram' | 'discord' | 'ntfy', args: { token?: string; server?: string }) => {
      // Arm on demand: connecting a channel is itself an opt-in to the feature.
      if (!approvals.operator) await approvals.arm()
      const deps = approvals.deps()
      if (!deps) throw new Error('operator identity unavailable')
      const out = await connectChannel(deps, {
        kind,
        token: String(args?.token ?? ''),
        server: String(args?.server ?? '')
      })
      journal.add('session', `notification channel connected: ${kind}`)
      return out
    }
  )
  regHandle('approvals:disconnect', async (_e, kind: 'telegram' | 'discord' | 'ntfy') => {
    const deps = approvals.deps()
    if (!deps) return { removed: 0 }
    const out = await disconnectChannel(deps, kind)
    journal.add('session', `notification channel disconnected: ${kind}`)
    return out
  })
  // Multi-PC enrolment. The payload is opaque KEY MATERIAL and is validated as
  // a working keypair -- it never becomes a path or a command (hostile input #3).
  regHandle('approvals:enrolment-export', () =>
    exportEnrolment(join(app.getPath('userData'), APP_STATE_SUBDIR), secretCipher)
  )
  regHandle('approvals:enrolment-apply', async (_e, payload: unknown) => {
    const adopted = applyEnrolment(join(app.getPath('userData'), APP_STATE_SUBDIR), secretCipher, payload)
    if (!adopted) return false
    await approvals.disarm()
    await approvals.arm()
    journal.add('session', 'this PC was linked to an existing operator identity')
    return true
  })
  registerIpc({
    service,
    workspaces,
    getConfig,
    setConfig,
    secretCipher,
    getWindow: () => mainWindow,
    announce: (text: string) => broadcastAnnounce(text),
    ensureSupervisor,
    journal,
    dispatchNext,
    stopRoadmapItem,
    assignRoadmapItem,
    checkpoint: checkpointBeforeSpawn,
    getWorktreeInit,
    resolveTemplateInputs,
    brokerStatus: () => brokerHealth.status,
    brokerRetry: () => {
      void pollOperatorInbox()
      void pollGraphDrafts()
      void pollApprovalVerdicts()
    },
    deckPluginDir,
    sandbox,
    sandboxGate,
    sandboxWarmTranscripts: warmSandboxTranscripts
  })
  // Arm remote approvals BEFORE service.start(): restored sessions spawn there,
  // and a session spawned without the credential path would never produce an
  // approval. A failure only means the feature stays off; the app starts anyway.
  if (config.mobileApprovals) {
    const armed = await approvals.arm()
    journal.add('session', armed ? 'remote approvals armed' : 'remote approvals unavailable')
  }
  service.start()
  // Attach an auto-save workspace capturing whatever the service just restored.
  workspaces.start()
  // Operator inbox drain (PLAN C12) + pending graph drafts (same cadence).
  inboxTimer = setInterval(() => {
    void pollOperatorInbox()
    void pollGraphDrafts()
    void pollApprovalVerdicts()
  }, INBOX_POLL_MS)
  // Restart seed (card 5852c074): re-track already in-progress items BEFORE
  // the watcher's first tick, see seedDispatchedFromRoadmap's doc comment.
  await seedDispatchedFromRoadmap()
  // Auto-dispatch watcher (PLAN C15): no-op while nothing was dispatched.
  dispatchTimer = setInterval(() => void watchDispatched(), DISPATCH_WATCH_MS)
  // Idle-lock watcher (PLAN K2): releases locks held by silent local tiles.
  lockWatchTimer = setInterval(() => void watchIdleLocks(), LOCK_WATCH_MS)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    workspaces.releaseOnQuit()
    service.stop()
    app.quit()
  }
})

app.on('before-quit', () => {
  // Persist this run's journal (PLAN O3): the ring buffer is the only
  // narrative of the run and would otherwise evaporate with the process.
  flushJournalSnapshot(app.getPath('logs'), journal.toText())
  logInfo('main', 'quitting')
  if (inboxTimer) clearInterval(inboxTimer)
  if (dispatchTimer) clearInterval(dispatchTimer)
  if (lockWatchTimer) clearInterval(lockWatchTimer)
  workspaces.releaseOnQuit()
  service.stop()
  // Persistent by design (docs/sandbox.md): closing the app STOPS the project
  // container (detached, quit never waits on the engine) — it never removes it.
  sandbox.stopCurrentDetached()
  controlServer?.close()
  // Ephemeral companion mode (MB2): closing the app IS the revocation — the
  // phone sees the socket drop and shows "host disconnected".
  void companionServer?.stop(true)
  // Revoke this window's agent credential and delete its file: a stale
  // credential surviving the app would keep raising approvals nobody applies.
  void approvals.disarm()
  activeScopeEnv.cleanup()
})
