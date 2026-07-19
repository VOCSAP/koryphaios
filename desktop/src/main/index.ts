import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  Notification,
  safeStorage,
  shell
} from 'electron'
import type { AppConfig } from '@shared/types'
import { loadConfig, saveConfig } from './store'
import { buildAppMenu } from './menu'
import { SessionService } from './session-service'
import { registerIpc } from './ipc'
import { parseCliContext } from './cli-context'
import { computeScope, buildScopeEnv, resolveAdoptedScope, type Scope, type ScopeEnv } from './scope'
import {
  rememberScopeSecret,
  recallScopeSecret,
  type SecretCipher
} from './scope-secrets'
import { applyProviderKeyPatch, sanitizeProviders } from './provider-secrets'
import { globalLaunchCommand, projectLaunchCommand, resolveLaunchConfig } from './launch-config'
import { resolveApprovedLaunchCommand } from './launch-approval'
import { WorkspaceService } from './workspace-service'
import {
  fetchGraphDrafts,
  fetchOperatorInbox,
  resolveBrokerEndpoint,
  sendAnnounce
} from './broker-client'
import { appendInboxHistory } from './inbox-store'
import { computeDeckProjectKey, listRoadmap, upsertRoadmap } from './roadmap-service'
import { createCheckpoint, purgeCheckpoints, restoreCommand } from './checkpoint-service'
import { composeAssignText, composeDispatchText, composeStopText, firstQueued } from './dispatch'
import type { AssignResult, DispatchResult, StopResult } from '@shared/types'
import { composeJoinAnnounce, type JoinAnnounceIntent } from '@shared/announce'
import { APP_STATE_SUBDIR, runDataMigration } from './migrate-data-dir'
import type { SessionRuntime } from '@shared/types'
import { listAgents } from './agents'
import { createSessionWithWorktree } from './create-session'
import { Journal } from './journal'
import { flushJournalSnapshot, initDeckLog, logInfo, onDeckError, reportError } from './log'
import { startDeckControl, type DeckControlDeps, type DeckControlServer } from './deck-control'
import { startDesignEndpoint, type DesignEndpoint } from './design-endpoint'
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
  writeTemplate
} from './template-store'
import { templateToInputs, toTemplate } from '@shared/template'

let mainWindow: BrowserWindow | null = null

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

const getConfig = (): AppConfig => config
const setConfig = (patch: Partial<AppConfig>): AppConfig => {
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
  mainWindow?.webContents.send('config:changed', sanitizeConfigForRenderer(config))
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

const service = new SessionService(
  getConfig,
  () => ({
    ...activeScopeEnv.env,
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
service.on('removed', ({ name }: { id: string; name: string }) => {
  journal.add('session', `session "${name}" closed`)
})
service.on('exit', ({ id, exitCode, name }: { id: string; exitCode: number; name?: string }) => {
  const label = name ?? id.slice(0, 8)
  journal.add(
    'session',
    exitCode === 0 ? `session "${label}" exited cleanly` : `session "${label}" exited with code ${exitCode}`
  )
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

// Auto join announce: when a fresh session's peer_id first resolves, tell the
// other peers a newcomer joined (excluding the joiner itself). Fire-and-forget,
// never on the spawn critical path.
service.on('peer-resolved', ({ peerId, intent }: { peerId: string; intent: JoinAnnounceIntent }) => {
  void broadcastAnnounce(composeJoinAnnounce(peerId, intent), peerId)
})

// "Needs you" system notification (PLAN C11): a session hit a permission /
// question / plan screen. Clicking brings the window up and selects the tile.
service.on('attention', ({ id, waiting }: { id: string; waiting: boolean }) => {
  if (!waiting) return
  const session = service.list().find((s) => s.id === id)
  if (session) journal.add('attention', `session "${session.name}" waits for the operator`)
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
    if (messages.length === 0) return
    const batch = messages.map((m) => ({
      id: m.id,
      from: m.from_peer_id,
      text: m.text,
      sentAt: m.sent_at
    }))
    // The broker drain is destructive (delivered=1): journal the batch to
    // disk BEFORE showing it, so a Deck restart replays the whole inbox.
    appendInboxHistory(join(app.getPath('userData'), APP_STATE_SUBDIR), batch)
    mainWindow?.webContents.send('inbox:new', batch)
    notifyInbox(batch)
  } catch {
    // Broker down / unreachable: silent, the next tick retries.
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
      mainWindow?.webContents.send('graphDrafts:update', list)
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
const dispatchedIds = new Set<string>()
const DISPATCH_WATCH_MS = 20_000

const dispatchNext = async (): Promise<DispatchResult> => {
  try {
    const endpoint = resolveBrokerEndpoint()
    const key = computeDeckProjectKey(config.projectDir)
    const item = firstQueued(await listRoadmap(endpoint, key, {}))
    if (!item) return { sent: false, reason: 'empty-queue' }
    const sent = await announceToLead(composeDispatchText(item))
    if (sent === 0) return { sent: false, reason: 'no-lead' }
    // Unqueue + hand over as 'planned'; the lead moves it along from there.
    await upsertRoadmap(endpoint, key, {
      id: item.id,
      queue: null,
      status: item.status === 'idea' ? 'planned' : item.status
    })
    dispatchedIds.add(item.id)
    return { sent: true, title: item.title }
  } catch (e) {
    reportError('dispatch', 'dispatch failed', e)
    return { sent: false, reason: 'error' }
  }
}

const watchDispatched = async (): Promise<void> => {
  if (dispatchedIds.size === 0) return
  try {
    const endpoint = resolveBrokerEndpoint()
    const key = computeDeckProjectKey(config.projectDir)
    const items = await listRoadmap(endpoint, key, { include_archived: true })
    let completed = false
    for (const id of [...dispatchedIds]) {
      const it = items.find((i) => i.id === id)
      if (!it || it.status === 'done' || it.status === 'archived') {
        dispatchedIds.delete(id)
        completed = true
        if (it) journal.add('dispatch', `dispatched item done: "${it.title}"`)
      }
    }
    if (completed) {
      const r = await dispatchNext()
      if (r.sent) journal.add('dispatch', `auto-dispatched next queued item: "${r.title}"`)
    }
  } catch {
    // Broker down: the next tick retries.
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

// ----- Supervisor deck-control (PLAN C5) -----
// The loopback control endpoint the SUPERVISOR session pilots the app through.
// Started lazily at the first Home visit; the URL/token pair is injected only
// into the supervisor's generated --mcp-config, never into normal sessions.
const controlDeps: DeckControlDeps = {
  listAgents: () => listAgents(getConfig().projectDir),
  listModels: () => resolveLaunchConfig(getConfig().projectDir).models,
  listPresets: () => resolveLaunchConfig(getConfig().projectDir).presets,
  spawnSession: (input) =>
    createSessionWithWorktree(service, getConfig().projectDir, input, checkpointBeforeSpawn),
  listSessions: () => service.list(),
  restartSession: (id) => void service.restart(id),
  closeSession: (id) => service.remove(id),
  createWorktree: async (branch) => {
    const wt = await createWorktree(getConfig().projectDir, branch)
    const init = resolveLaunchConfig(getConfig().projectDir).worktreeInit
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
    const tpl = readTemplate(path)
    if (!tpl) return 0
    const inputs = templateToInputs(tpl)
    // One checkpoint covers the whole batch (all spawn into the project dir).
    if (inputs.length > 0) await checkpointBeforeSpawn(getConfig().projectDir)
    // Template lead only lands when the window has none yet (PLAN C18).
    const hasLead = service.list().some((s) => s.lead && s.status !== 'exited')
    for (const input of inputs) {
      await createSessionWithWorktree(
        service,
        getConfig().projectDir,
        hasLead ? { ...input, lead: undefined } : input
      )
    }
    return inputs.length
  },
  saveTemplate: (name, local) => {
    const tpl = toTemplate(service.captureSessions(), name)
    const dir = local ? localTemplatesDir(getConfig().projectDir) : globalTemplatesDir()
    return writeTemplate(dir, name || tpl.name || 'template', tpl)
  },
  announce: (text) => broadcastAnnounce(text)
}

let controlServer: DeckControlServer | null = null

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
  const appendSystemPromptFile = writeSupervisorSystemPrompt(stateDir)
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
      mainWindow?.webContents.send('workspace:current', summary)
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Embedded browser (PLAN D1): pages loaded in the <webview> never open new
  // Electron windows — window.open/target=_blank goes to the system browser.
  mainWindow.webContents.on('did-attach-webview', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
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

app.whenReady().then(() => {
  nativeTheme.themeSource = config.theme
  // PLAN C19: gate a PROJECT-sourced launchCommand behind a one-time operator
  // approval (hash remembered per project_key; a changed command asks again;
  // refusal keeps the global/default command for this run).
  const projCmd = projectLaunchCommand(cliContext.projectDir)
  if (projCmd && projCmd.trim() !== safeLaunchCommand.trim()) {
    const isFr = (config.locale || app.getLocale()).toLowerCase().startsWith('fr')
    const decision = resolveApprovedLaunchCommand({
      projectKey: computeDeckProjectKey(cliContext.projectDir),
      projectCommand: projCmd,
      fallback: safeLaunchCommand,
      approvalsFile: join(app.getPath('userData'), APP_STATE_SUBDIR, 'launch-approvals.json'),
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
    checkpoint: checkpointBeforeSpawn
  })
  service.start()
  // Attach an auto-save workspace capturing whatever the service just restored.
  workspaces.start()
  // Operator inbox drain (PLAN C12) + pending graph drafts (same cadence).
  inboxTimer = setInterval(() => {
    void pollOperatorInbox()
    void pollGraphDrafts()
  }, INBOX_POLL_MS)
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
  controlServer?.close()
  activeScopeEnv.cleanup()
})
