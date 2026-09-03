import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
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
import { createMissingDirTracker, deckPluginDirFor } from './session-command'
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
import { approve, commandHash, isApproved, resolveApprovedLaunchCommand } from './launch-approval'
import { homedir, hostname } from 'node:os'
import {
  WorkspaceService,
  refusesUnattendedApproval,
  type CallerAttendance,
  type WorkspaceApprovalGateResult
} from './workspace-service'
import type { WorkspaceSession } from './workspace-store'
import {
  BrokerHealthTracker,
  fetchDispatchRequests,
  fetchGraphDrafts,
  fetchOperatorInbox,
  purgeOperatorInbox,
  resolveBrokerEndpoint,
  resolveDispatchRequest,
  sendAnnounce
} from './broker-client'
import { appendInboxHistory, clearInboxHistory, deleteInboxHistoryEntries } from './inbox-store'
import { createInboxSessionTracker, purgeInboxSessionCore } from './inbox-session'
import {
  computeDeckProjectKey,
  configureRoadmapSigner,
  listRoadmap,
  upsertRoadmap
} from './roadmap-service'
import { createCheckpoint, purgeCheckpoints, restoreCommand } from './checkpoint-service'
import {
  canAutoDispatchNext,
  composeAssignText,
  composeStopText,
  composeUnresolvedContext,
  dispatchNormalWave,
  firstQueued,
  nextBarrierPending,
  nextDispatchedState,
  runDirectiveWave,
  runDispatchRequestPoll,
  splitWave,
  unresolvedDirectiveNote,
  type DispatchedEntry
} from './dispatch'
import { directiveKeys, isDirectiveCommand, resolveDirectiveTargets } from './directive'
import { unreachedTargets, unreachedTargetsText } from './directive-journal'
import { decidePeerAnnounce } from './peer-rotation'
import { ownsIdleLock } from './idle-lock'
import type {
  AssignResult,
  DirectiveDispatch,
  DispatchedWaveMember,
  DispatchResult,
  RoadmapItem,
  StopResult
} from '@shared/types'
import {
  composeJoinAnnounce,
  joinAnnounceTargets,
  type JoinAnnounceIntent
} from '@shared/announce'
import { isHead, queuedItems, wavesOf } from '@shared/workflow'
import { APP_STATE_SUBDIR, runDataMigration } from './migrate-data-dir'
import type { SessionRuntime } from '@shared/types'
import { listAgents } from './agents'
import { createSessionWithWorktree } from './create-session'
import { SandboxService, type SandboxLaunch } from './sandbox-service'
import {
  mapHostPathToContainer,
  rewriteLoopbackForContainer,
  rewritePluginDirForContainer,
  sandboxifyEnv,
  SANDBOX_RUN_DIR
} from './sandbox-command'
// Card 9e529177: consumed, not rewritten -- see sandbox-protect.ts's own
// header for why this is the ONLY module allowed to compute/render the plan.
import { renderProtectionNotice } from './sandbox-protect'
import {
  composeAppendSystemPrompt,
  extractAppendSystemPromptFile,
  isValidSandboxSessionId,
  isWithinDir,
  sandboxPromptRoot
} from './sandbox-prompt'
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
import { ApprovalRuntime, armApprovalsAtStartup } from './approval-runtime'
import { remoteApprovalsEnabled } from './approval-store'
import {
  addApproval,
  buildKeystrokes,
  claimApproval,
  classifyVerdict,
  connectChannel,
  disconnectChannel,
  fetchPendingApprovals,
  fetchUndeliveredVerdicts,
  listChannels,
  markVerdictsDelivered
} from './approval-service'
import {
  applyEnrolment,
  createOperatorIdentity,
  exportEnrolment,
  loadOperatorIdentity
} from './operator-identity'
import { buildAuthProof, generateCredential } from './approval-auth'
import { addEventSink, broadcast, regHandle } from './api-registry'
import { CompanionServer } from './companion-server'
import {
  SUPERVISOR_BRIEFING,
  SUPERVISOR_NAME,
  writeSupervisorMcpConfig,
  writeSupervisorSystemPrompt,
  writeTeamLeadMcpConfig
} from './supervisor'
import { buildMintTeamLeadBridge, isTeamLeadAgent } from './team-lead-bridge'
import { sweepTeamLeadMcpConfigs, teamLeadInstanceToken, teamLeadMcpConfigFileName } from './team-lead-mcp-sweep'
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
import {
  sessionsHaveShellFields,
  templateHasShellFields,
  templateToInputs,
  toTemplate,
  type TemplateResolveResult
} from '@shared/template'

let mainWindow: BrowserWindow | null = null
// The desktop window is the first event sink (PLAN MB1): state events emitted
// through broadcast() reach it exactly like the old direct sends, plus every
// authenticated companion client.
addEventSink((channel, payload) => mainWindow?.webContents.send(channel, payload))

// Must run before any getPath('userData')/loadConfig() below; the chained
// migrations in migrate-data-dir.ts carry the legacy folders' content over.
// App state lives under <userData>/config to avoid colliding with the launch
// config.json at the root.
app.setName('koryphaios')

// Rolling main.log under the platform logs dir (PLAN O3): in a packaged app
// console output goes nowhere, this file is the only durable trail. Bound
// before anything else can fail -- INCLUDING the data migration below, whose
// reportError calls would otherwise fall back to console.error and vanish in a
// packaged app, exactly when a migration failure matters most (card eda86400).
// Only setName has to precede it, since the logs path derives from the app name.
app.setAppLogsPath()
initDeckLog(app.getPath('logs'))

runDataMigration({ userDataDir: app.getPath('userData') })

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
// Delegates to sandbox-prompt.ts's sandboxPromptRoot so the value
// composeSandboxAppendPrompt's containment check anchors on is PROVABLY the
// same expression every other call site here uses -- not a parallel one
// that could silently diverge (card 9e529177 audit round 2).
const secretsDir = (): string => sandboxPromptRoot(app.getPath('userData'))

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

// getDeckPluginDir re-checks existsSync live at every spawn instead of caching
// it once at boot, so a plugin dir deleted mid-run is caught, not silently
// kept.
// Passed by reference to every consumer, never called and its result stored,
// which is what makes that live check happen at spawn time rather than boot.
// reportError fires once per episode of absence, not once per process (would
// arm on the first harmless boot and never fire again) or per spawn (log spam).
const deckPluginMissingTracker = createMissingDirTracker()
const getDeckPluginDir = (): string => {
  const dir = deckPluginDirFor(app.isPackaged, process.resourcesPath, app.getAppPath())
  const exists = existsSync(dir)
  if (deckPluginMissingTracker.check(exists)) {
    reportError(
      'session',
      'deck-plugin dir missing (resources/deck-plugin) -- back-channel hook, deck-control and demo-browser MCP servers unavailable until the app is repackaged and the Deck restarted'
    )
  }
  return exists ? dir : ''
}

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
  host: hostname(),
  projectKey: () => computeDeckProjectKey(cliContext.projectDir)
})

// configureRoadmapSigner's loader runs lazily on the first write, not at boot,
// and deliberately does not read identity from ApprovalRuntime, so roadmap
// signing keeps working when arm() never runs or fails for an unrelated reason.
// A machine with no identity file yet mints one on that first signature;
// operator_id is the digest of the public key, so the credential self-certifies
// with no separate enrolment step.
// Known gap (card be4ae042): unlike arm(), this loader has no
// cipher.isAvailable() guard, so it can swap the live identity even while the
// cipher is unavailable.
configureRoadmapSigner(() => {
  const stateDir = join(app.getPath('userData'), APP_STATE_SUBDIR)
  const identity =
    loadOperatorIdentity(stateDir, secretCipher) ??
    createOperatorIdentity(stateDir, secretCipher, generateCredential())
  return (payload) => {
    // public_key travels WITH the payload and is therefore covered by the
    // signature: on first contact the broker has no row for this operator, and
    // operator_id is the digest of that key, so the pair self-certifies.
    const signed = { ...payload, public_key: identity.publicKey }
    return {
      public_key: identity.publicKey,
      auth: buildAuthProof(identity.privateKey, signed, {
        kind: 'operator',
        operator_id: identity.operatorId
      })
    }
  }
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
  getDeckPluginDir,
  undefined, // home: default (homedir()) -- unused by index.ts, kept positional per session-service.ts's existing append-at-the-end convention.
  // Both getters are wrapped in an arrow function on purpose: controlServer and
  // controlDeps are declared further down this file (TDZ), and the arrow only
  // reads them when called, not at construction.
  // This getter never starts the server itself, only reads whatever is
  // currently there; the sessions:create route awaits ensureControlServer()
  // first, so by the time this runs the server is already up (or the tile opens
  // without the bridge, fail-closed).
  buildMintTeamLeadBridge({
    getControlServer: () => controlServer,
    write: (token, callerId, allowedTools) => controlDeps.writeTeamLeadMcpConfig(token, callerId, allowedTools)
  })
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
  // Card a79c7696 volet 1: passed by reference, same live-recheck reason as
  // getDeckPluginDir's own LOAD-BEARING comment above (SessionService gets
  // the identical reference).
  deckPluginDir: getDeckPluginDir,
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

/**
 * Composes into one file the existing role prompt content (if present) and the
 * mount-mode protection notice (if the plan is 'applied'), since the flag is
 * singular and can only carry one file.
 * Either piece missing degrades to the other; both missing leaves the command
 * line unchanged, with no file written and no flag touched.
 */
function composeSandboxAppendPrompt(sessionId: string, command: string, launch: SandboxLaunch): string {
  if (!isValidSandboxSessionId(sessionId)) {
    // Defense in depth (card 9e529177 audit), not a live-exploit fix: see
    // isValidSandboxSessionId's own comment (sandbox-prompt.ts) for why.
    reportError('sandbox', `refusing to compose append-system-prompt file: sessionId is not a uuid (${sessionId})`)
    return command
  }
  const hostPromptPath = extractAppendSystemPromptFile(command)
  let roleContent = ''
  if (hostPromptPath) {
    if (isWithinDir(secretsDir(), hostPromptPath)) {
      try {
        roleContent = readFileSync(hostPromptPath, 'utf8')
      } catch (e) {
        reportError('sandbox', `append-system-prompt-file unreadable: ${hostPromptPath}`, e)
      }
    } else {
      // An uncontained host path here would become an exfiltration vector,
      // since this content is read host-side and injected into the sandboxed
      // agent's own prompt.
      // Compose the notice alone in that case; the spawn must not block on
      // this.
      reportError('sandbox', `append-system-prompt-file outside state dir, refusing to read: ${hostPromptPath}`)
    }
  }
  const notice = renderProtectionNotice(launch.protection)
  const containerPath = `${SANDBOX_RUN_DIR}/prompt-${sessionId}.txt`
  const rewrite = composeAppendSystemPrompt(command, roleContent, notice, containerPath)
  if (rewrite.composed === null) return command
  try {
    writeFileSync(join(launch.runDirHost, `prompt-${sessionId}.txt`), rewrite.composed + '\n', {
      mode: 0o600
    })
  } catch (e) {
    // A missing notice is an inconvenience (the :ro binds themselves stand
    // regardless -- see buildCreateArgs), not a failure: the spawn must
    // proceed, but the miss must leave a trace (CLAUDE.md "no silent errors").
    reportError('sandbox', `failed to write composed append-system-prompt file for ${sessionId}`, e)
    return command
  }
  return rewrite.command
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
          // Card a79c7696 volet 1: `command` still carries --plugin-dir
          // pointing at the HOST deck-plugin path (session-command.ts's
          // pluginFlag has no sandbox awareness) -- rewrite it onto the
          // container path projectDeckPlugin() copied it to. No-op if the
          // flag is absent (deck-plugin build missing on the host).
          command: composeSandboxAppendPrompt(sessionId, rewritePluginDirForContainer(command), launch),
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

service.on('removed', ({ id, name }: { id: string; name: string }) => {
  journal.add('session', `session "${name}" closed`)
  // Revokes a team-lead tile's minted deck-control token/callerId and deletes
  // its team-lead-mcp file only on final removal, not on crash or non-zero exit
  // (which emit 'exit', not 'removed') — a crashed tile is kept as a
  // restartable corpse and restart() reuses the same mcpConfig.
  // No-op for a session that never minted its own caller (the supervisor tile,
  // any non-lead profile).
  const revokedCallerId = controlServer?.revokeCallerForSession(id) ?? null
  if (revokedCallerId) cleanupTeamLeadMcpFile(revokedCallerId)
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

/**
 * Join-announce dispatch (card 8cb54a0f): resolves the operator's
 * `joinAnnounceLevel` via the pure joinAnnounceTargets decision and sends (or
 * deliberately doesn't) accordingly -- 'off' is silent, 'lead' addresses only
 * the active team-lead/supervisor session(s) with NO broadcast fallback,
 * 'all' keeps the historical broadcast-to-everyone behaviour. Named (not an
 * inline lambda) so the peer-resolved wiring below is a single, stable call
 * site. Fire-and-forget like every announce helper here, never on the spawn
 * critical path.
 */
const sendJoinAnnounce = async (peerId: string, intent: JoinAnnounceIntent): Promise<void> =>
  sendPeerAnnounce(peerId, composeJoinAnnounce(peerId, intent), 'join')

/**
 * The DISPATCH half of a peer announce, shared by the join announce above and
 * the peer_id rotation notice (card 6f59c73a L1). Extracted rather than
 * copied: two send paths that must agree on the level gate, on the
 * never-address-yourself rule and on the error trace would be exactly the kind
 * of divergence-prone pair this codebase has already paid for twice.
 * `subject` only labels the journal/error lines, so the two events stay
 * distinguishable in the log.
 */
const sendPeerAnnounce = async (peerId: string, text: string, subject: string): Promise<void> => {
  const level = getConfig().joinAnnounceLevel
  const decision = joinAnnounceTargets(level, service.list())
  if (decision.kind === 'silent') {
    // 'off' is the requested behaviour, not an abandon -- no trace. 'lead'
    // with nothing to address IS an abandon (mirrors announceToSupervisor's
    // own "unreachable, ack dropped" journal entry just above).
    if (level === 'lead') {
      journal.add('announce', `${subject} announce dropped: no active team-lead or supervisor`)
    }
    return
  }
  if (decision.kind === 'broadcast') {
    await broadcastAnnounce(text, peerId)
    return
  }
  // The subject peer itself is never its own announce target (mirrors
  // broadcastAnnounce's excludePeerId semantics on the 'all' branch above).
  const targets = decision.peerIds.filter((id) => id !== peerId)
  await Promise.all(
    targets.map(async (toPeerId) => {
      try {
        const { sent } = await sendAnnounce(
          { groupId: activeScope.groupId, secret: activeScope.secret, text, toPeerId },
          { endpoint: resolveBrokerEndpoint() }
        )
        if (sent > 0) {
          journal.add('announce', `${subject} announce to ${toPeerId}: ${text.slice(0, 120)}`)
        }
      } catch (e) {
        reportError('announce', `${subject} announce failed`, e)
      }
    })
  )
}

// Auto join announce: when a fresh session's peer_id first resolves, tell the
// other peers a newcomer joined (level-gated by sendJoinAnnounce above).
// Fire-and-forget, never on the spawn critical path. Doubles as the spawn-ack
// trigger (TS3).
//
// Card 6f59c73a (L1): this event now also fires when a live tile's id ROTATES,
// not only on first resolution -- peer-rotation.ts decides which of the two
// (or neither) applies, and composes the rotation wording. The spawn ack below
// stays pinned to FIRST RESOLUTION: an ack means "this spawn connected", which
// a rotation is not.
service.on(
  'peer-resolved',
  ({
    id,
    peerId,
    previousPeerId,
    intent
  }: {
    id: string
    peerId: string
    previousPeerId: string | null
    intent: JoinAnnounceIntent | null
  }) => {
    const tile = service.list().find((s) => s.id === id)
    const decision = decidePeerAnnounce({
      previousPeerId,
      nextPeerId: peerId,
      tileName: tile?.name ?? '',
      hasJoinIntent: !!intent
    })
    if (decision.kind === 'join' && intent) {
      void sendJoinAnnounce(peerId, intent)
    } else if (decision.kind === 'rotation') {
      // Same level gate and same send path as a join announce (an operator who
      // set joinAnnounceLevel to 'off' asked for silence on this channel), and
      // the rotating tile is never its own announce target.
      void sendPeerAnnounce(peerId, decision.text, 'rotation')
      journal.add('announce', `peer id rotated: ${previousPeerId ?? '?'} -> ${peerId}`)
    }
    // First resolution ONLY: a rotation must not fire a pending spawn ack,
    // which reports that a spawn CONNECTED. Truthiness, not `!== null`, on
    // purpose: a payload without the field at all (an older shape, a future
    // second emitter) then degrades to the HISTORICAL behaviour -- ack fires --
    // instead of silently swallowing an ack the operator is waiting on.
    if (previousPeerId) return
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

// Verdicts already announced as held (card 9c6de1e1), so the journal carries
// ONE line per held answer instead of one per poll tick. Pruned below against
// what the broker still returns, so it cannot outgrow the undelivered list.
const heldVerdicts = new Set<string>()

/**
 * Only the fallback path lands here: a hook or ask_operator verdict returning
 * through its own call is handled elsewhere. Guarded twice — the tile must
 * still exist and still be waiting — since an answer arriving after the
 * operator dealt with the prompt locally must be dropped, not typed into
 * whatever is on screen now.
 * 'Dropped' means held, not discarded: marking a verdict delivered tells the
 * broker to stop sending it, so doing that for a merely un-flagged tile would
 * lose the answer for good. classifyVerdict separates the two; only
 * 'settle'/'abandon' end a verdict's life here.
 */
const pollApprovalVerdicts = async (): Promise<void> => {
  const deps = approvals.deps()
  if (!deps || !approvalsEnabled()) return
  try {
    const settled = await fetchUndeliveredVerdicts(deps)
    if (settled.length === 0) {
      heldVerdicts.clear()
      return
    }
    const applied: string[] = []
    const seen = new Set<string>()
    for (const approval of settled) {
      seen.add(approval.id)
      // tile_ref is a producer DECLARATION, not an authenticated field: it is
      // only ever used to look up a tile we own, and classifyVerdict then
      // demands that tile still be the one waiting on this approval.
      const tile = approval.origin.tile_ref || approval.origin.session_ref
      const live = service.list().find((s) => s.id === tile)
      const state = live ? { exists: true, waiting: waitingTiles.has(tile) } : null
      const disposition = classifyVerdict(approval, state)
      if (disposition === 'settle') {
        // Nothing to type, and nothing ever will: mark it so it stops coming back.
        applied.push(approval.id)
        heldVerdicts.delete(approval.id)
        continue
      }
      if (disposition === 'defer') {
        // Left UNDELIVERED on purpose: the tile is alive, so the same answer is
        // retried at every poll until the session asks again.
        if (!heldVerdicts.has(approval.id)) {
          heldVerdicts.add(approval.id)
          journal.add(
            'attention',
            `holding the answer to "${live?.name ?? tile}" — its "needs you" flag is down; it will be typed in if the session asks again`
          )
        }
        continue
      }
      if (disposition === 'abandon') {
        // The window closed. Give up typing it, but never silently: the
        // operator answered and must learn that the session did not get it.
        applied.push(approval.id)
        heldVerdicts.delete(approval.id)
        reportError(
          'approvals',
          `the answer to "${approval.title}" (from ${approval.answered_via}) was never typed into "${live?.name ?? tile}": the session stopped asking. Answer it in the terminal.`
        )
        continue
      }
      const keys = buildKeystrokes(approval)
      if (!keys) {
        // Sanitisation refused the remote text. Settled, but nothing reaches
        // the session, so this must not be silent either.
        applied.push(approval.id)
        heldVerdicts.delete(approval.id)
        reportError(
          'approvals',
          `the answer to "${approval.title}" could not be typed into "${live?.name ?? tile}": nothing safe to send for a ${approval.answer_kind} answer`
        )
        continue
      }
      service.write(tile, keys)
      waitingTiles.delete(tile)
      openApprovals.delete(tile)
      heldVerdicts.delete(approval.id)
      journal.add('attention', `answered "${live?.name ?? tile}" from ${approval.answered_via}`)
      applied.push(approval.id)
    }
    // Anything absent from the broker's list is gone (answered elsewhere, expired,
    // purged): drop our bookkeeping with it.
    for (const id of heldVerdicts) if (!seen.has(id)) heldVerdicts.delete(id)
    await markVerdictsDelivered(deps, applied)
  } catch (e) {
    reportError('approvals', 'verdict poll failed', e)
  }
}

service.on(
  'attention',
  ({ id, waiting, manual }: { id: string; waiting: boolean; manual?: boolean }) => {
    const session = service.list().find((s) => s.id === id)
    // The operator answered locally: settle the approval so the phone
    // notification is invalidated (the broker makes the two exclusive).
    if (!waiting) {
      waitingTiles.delete(id)
      // A manual dismiss (card 4f0143ff escape hatch, session-service's
      // clearAttention) means "this flag was wrong", not "I answered this
      // via the terminal" -- do NOT read it as an answer, or clicking a
      // false-positive badge would silently ALLOW a pending remote/phone
      // approval nobody actually responded to (BLOCKER 2, review).
      if (manual) {
        // The approval stays open — the poller can still deliver it — but the
        // two views have just diverged: the Deck shows nothing pending while
        // the phone still does.
        const pending = openApprovals.get(id)
        if (pending)
          reportError(
            'approvals',
            `"${session?.name ?? id}" had its "needs you" flag dismissed while approval ${pending} is still open remotely — an answer sent from a phone cannot be typed in until that session asks again`
          )
        return
      }
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
  }
)

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

const currentInboxSessionId = createInboxSessionTracker(() => activeScope.groupId)

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
      {
        groupId: activeScope.groupId,
        secret: activeScope.secret,
        sessionId: currentInboxSessionId()
      },
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
    // Courrier lot 1B: the broker read is now non-destructive (cursor by
    // session_id, broker.ts), but this journal stays load-bearing for a
    // DIFFERENT reason -- see inbox-store.ts's header comment. Journal to
    // disk BEFORE showing it; a failed write re-queues the batch for the next
    // tick (O6) -- these messages exist nowhere else on this Deck once read.
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

/**
 * Bumps this session's broker cursor to MAX(id) and deletes local journal
 * entries up through the group's slowest live session, in the same instant —
 * skipping either half leaves the bug looking unfixed (broker-only or
 * local-only).
 * Best-effort by design: a purge failure must never block the gesture it rides
 * on.
 */
async function purgeInboxSession(): Promise<void> {
  await purgeInboxSessionCore({
    purgeBroker: async () => {
      await purgeOperatorInbox(
        {
          groupId: activeScope.groupId,
          secret: activeScope.secret,
          sessionId: currentInboxSessionId(),
          scope: 'session'
        },
        { endpoint: resolveBrokerEndpoint() }
      )
    },
    clearLocal: () =>
      clearInboxHistory(join(app.getPath('userData'), APP_STATE_SUBDIR), (e) =>
        reportError('inbox', 'local history truncate failed after session purge', e)
      ),
    onPurgeError: (e) =>
      reportError('inbox', 'session purge failed (broker-side Courrier may keep stale rows)', e)
  })
  broadcast('inbox:cleared')
}

/**
 * Courrier lot 1E (card 1e81ee7b): manual "delete this one" gesture, a third
 * state distinct from Close and Ack -- never a reinterpretation of either.
 * Global broker-side delete (any session, any group member sees it gone) +
 * local journal removal. Empty/unknown ids are a 0-effect no-op, matching the
 * broker's own scope='ids' semantics -- never an error.
 */
async function inboxDelete(ids: number[]): Promise<number> {
  let deleted = 0
  try {
    deleted = await purgeOperatorInbox(
      {
        groupId: activeScope.groupId,
        secret: activeScope.secret,
        sessionId: currentInboxSessionId(),
        scope: 'ids',
        ids
      },
      { endpoint: resolveBrokerEndpoint() }
    )
  } catch (e) {
    reportError('inbox', `manual delete failed for ${ids.length} id(s)`, e)
  }
  deleteInboxHistoryEntries(join(app.getPath('userData'), APP_STATE_SUBDIR), ids, (e) =>
    reportError('inbox', 'local history entry removal failed after manual delete', e)
  )
  broadcast('inbox:cleared')
  return deleted
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

// ----- Pending approvals poll (card 469f3176: the local Courrier) -----
// Producer for 'approvals:pending' -- the questions ask_operator (or the
// on-screen fallback) has raised and the Deck can still answer locally.
// Non-destructive (fetchPendingApprovals lists, it does not drain), same
// dedupe-by-signature shape as pollGraphDrafts above so a quiet tick does not
// re-render the renderer's list for nothing.
let lastPendingApprovalSignature = ''

const pollPendingApprovals = async (): Promise<void> => {
  const deps = approvals.deps()
  if (!deps) return
  try {
    const list = await fetchPendingApprovals(deps)
    const signature = list.map((a) => `${a.id}:${a.status}`).join(',')
    if (signature !== lastPendingApprovalSignature) {
      lastPendingApprovalSignature = signature
      broadcast('approvals:pending', list)
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

// dispatchedIds tracks wave membership only in this in-memory Map; once an item
// is dispatched it's unqueued and moved back to planned, so nothing else
// records which wave it belonged to. A Deck restart loses it and can
// over-dispatch past a wave that hadn't actually finished.
// Each entry's claimed flag distinguishes 'dispatched, not yet in_progress'
// from 'lead actually picked it up' — needed because a freshly dispatched item
// is planned+unlocked too, before being claimed, so a bare set would clear too
// early.
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
 * When the plugin is available, injects /magic-compact, captures the '/resume
 * <id>' banner, and re-enters the compacted session in place so peer_id and the
 * launch harness are preserved (the process never restarts).
 * Falls back to a standard /compact on the plugin's shim-failure message or a
 * timeout; goes straight to /compact when the plugin is disabled or absent.
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
  if (injected !== 'written') {
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
 * Executes a directive card by typing the command into the terminals of its
 * live targets, fire-and-forget per target so the dispatch loop never blocks;
 * it never announces to the lead. Returns what the card reached, read from
 * resolveDirectiveTargets's own buckets.
 * Must never reject: there is no await, so the only way to a rejected promise
 * is a synchronous throw in this prelude. sanitizeRoadmapItem has already
 * typed every field of item, and the two fs-touching calls swallow their own
 * errors and return false/null.
 */
const executeDirective = async (item: RoadmapItem): Promise<DirectiveDispatch> => {
  const cmd = item.directive
  // Re-validate the enum Deck-side (hostile input #2: broker response field).
  if (!isDirectiveCommand(cmd)) {
    reportError('dispatch', `directive card "${item.title}" carries no valid command; skipped`)
    // `directive: null` is the discriminant for "refused BEFORE any
    // resolution": both lists are empty because no bucket was ever computed,
    // not because every requested id was reached.
    return { id: item.id, title: item.title, directive: null, injected: [], unreached: [] }
  }
  const keys = directiveKeys(cmd)
  // Audit fix #8 (card 6c380073, dev2's directive.ts): `ambiguous` is READ
  // from resolveDirectiveTargets's own output, never re-derived here --
  // re-filtering service.list() a second time would be a second liveness
  // predicate, the exact drift this lot exists to close.
  const { matched, missing, ambiguous } = resolveDirectiveTargets(item.target_peer_ids, service.list())
  if (matched.length === 0) {
    // A collision (id resolved to MORE THAN ONE live tile) is a live target
    // refused for safety, not an absent one -- "no live target" is FALSE in
    // that case (the target exists, twice) and misleads whoever reads the
    // journal into thinking the peer_id was simply wrong. Both categories are
    // always reported: an earlier version of this branch listed ONLY the
    // ambiguous ids and silently dropped the plainly-absent ones, which is
    // why the wording now lives in a pure, probed function
    // (directive-journal.ts) instead of inline here.
    const detail = unreachedTargetsText(missing, ambiguous) || `requested: ${item.target_peer_ids.join(', ') || 'none'}`
    journal.add('dispatch', `directive ${keys} "${item.title}": ${detail}`)
    return {
      id: item.id,
      title: item.title,
      directive: cmd,
      injected: [],
      unreached: unreachedTargets(missing, ambiguous)
    }
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
      void runMagicCompact(t.id, t.peerId, useMagic, magicMode).catch((e) =>
        reportError('dispatch', `magic_compact failed for "${t.peerId}"`, e)
      )
    } else {
      void service
        .injectCommand(t.id, keys)
        .then((outcome) => journal.add('dispatch', `directive ${keys} -> "${t.peerId}": ${outcome}`))
        .catch((e) => reportError('dispatch', `directive injection failed for "${t.peerId}"`, e))
    }
  }
  if (missing.length > 0) {
    // Same composition as the no-match branch above, from the same pure
    // function -- two call sites, one wording, so neither can drop a category
    // the other reports.
    journal.add('dispatch', `directive ${keys} "${item.title}": ${unreachedTargetsText(missing, ambiguous)}`)
  }
  return {
    id: item.id,
    title: item.title,
    directive: cmd,
    injected: matched.map((t) => ({ tileId: t.id, peerId: t.peerId })),
    unreached: unreachedTargets(missing, ambiguous)
  }
}

// Multi-dispatch (roadmap card 5852c074): sends the WHOLE head wave (all
// items sharing the queue's head rank, wavesOf in shared/workflow) to the
// team-lead per call, not just its first member. splitWave/dispatchNormalWave
// (./dispatch) hold the pure decision/orchestration logic so they stay
// bun-testable; this function only drives the Electron-coupled network calls
// and owns the dispatchedIds mutation (single source of truth, as before).
const dispatchNextInner = async (): Promise<DispatchResult> => {
  // Card bf76d37f: declared OUTSIDE the try, and accumulated across guard
  // iterations, because the drain can execute several all-directive waves
  // before it returns -- possibly through the empty-queue exit, or through the
  // outer catch. Every one of those exits must still report the directives
  // this call already ran; resetting per wave, or scoping this to the try,
  // would drop exactly the work the caller cannot otherwise see.
  const executedDirectives: DirectiveDispatch[] = []
  const announcedMembers: DispatchedWaveMember[] = []
  // Attached to EVERY exit rather than to the success path only. Each half is
  // left absent when it stayed empty, so a dispatch that executed no directive
  // card (or announced nothing) keeps the exact result shape it had before.
  const withReports = (r: DispatchResult): DispatchResult => ({
    ...r,
    ...(executedDirectives.length > 0 ? { directives: executedDirectives } : {}),
    ...(announcedMembers.length > 0 ? { dispatched: announcedMembers } : {})
  })
  try {
    const endpoint = resolveBrokerEndpoint()
    const key = computeDeckProjectKey(config.projectDir)
    // Drain directive-only waves first: the Deck executes them itself (inject
    // + mark done) and pulls the next wave. The guard bounds the loop should a
    // done-write ever fail to advance it.
    for (let guard = 0; guard < 64; guard++) {
      const items = await listRoadmap(endpoint, key, {})
      const waveIds = wavesOf(queuedItems(items))[0]
      if (!waveIds || waveIds.length === 0) return withReports({ sent: false, reason: 'empty-queue' })
      const byId = new Map(items.map((i) => [i.id, i]))
      const wave = waveIds.map((id) => byId.get(id)).filter((i): i is RoadmapItem => i !== undefined)
      const { directives, normal } = splitWave(wave)
      // Directive members execute immediately, whatever the rest of the wave
      // holds (CT3 contract, unchanged: the Deck runs them, never announced).
      // Mark-then-execute, not execute-then-mark (card b1932a6a): see
      // runDirectiveWave's doc comment in dispatch.ts for the cost-asymmetry
      // rationale and the accepted gap this ordering trades for.
      executedDirectives.push(
        ...(await runDirectiveWave(directives, {
          markDone: async (item) => {
            await upsertRoadmap(endpoint, key, { id: item.id, queue: null, status: 'done' })
          },
          execute: executeDirective,
          journal: (line) => journal.add('dispatch', line),
          reportError: (message, error) => reportError('dispatch', message, error),
          // noteUnresolved's upsert replaces context wholesale (a full column
          // replace server-side), rather than the atomic append-context route,
          // so composeUnresolvedContext itself must carry the prior text
          // forward.
          // Any write to this card's context by another agent landing between
          // the top-of-loop roadmap read and this upsert is silently
          // overwritten; unbounded in the number of wave members, though in
          // practice today a wave is usually a single directive.
          noteUnresolved: async (item) => {
            await upsertRoadmap(endpoint, key, {
              id: item.id,
              context: composeUnresolvedContext(item.context, unresolvedDirectiveNote(item))
            })
          }
        }))
      )
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
      // Card bf76d37f: the announced members' IDENTITY, from the same
      // `dispatched` array that drives dispatchedIds above -- so the outcome
      // reported to a requesting agent and the set this Deck actually tracks
      // can never name different cards.
      announcedMembers.push(...dispatched.map((i) => ({ id: i.id, title: i.title, kind: i.kind })))
      for (const { item, error } of failed) {
        reportError('dispatch', `wave member "${item.title}" failed to unqueue, not tracked`, error)
      }
      return withReports(result)
    }
    return withReports({ sent: false, reason: 'error' })
  } catch (e) {
    reportError('dispatch', 'dispatch failed', e)
    return withReports({ sent: false, reason: 'error' })
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

// ----- Dispatch requests poll (card bf76d37f) -----
// An agent asks the Deck, through its MCP tool, to dispatch the next wave; the
// broker parks the request and this poller serves it on the same 10 s cadence
// as the four pollers above. The DECISION (park vs serve, what to answer, what
// to do with a throwing dispatch) lives in runDispatchRequestPoll (./dispatch)
// so it is behaviourally testable; this wrapper only supplies the deps.
//
// `inFlight` READS dispatchNext's existing guard, declared just above -- it is
// deliberately not a second guard, and not a queue behind the first: see
// runDispatchRequestPoll's doc comment for why serving a coalesced run would
// answer the requester about a dispatch it never caused.
const pollDispatchRequests = async (): Promise<void> => {
  try {
    const endpoint = resolveBrokerEndpoint()
    const key = computeDeckProjectKey(config.projectDir)
    await runDispatchRequestPoll({
      list: () => fetchDispatchRequests(key, { endpoint }),
      inFlight: () => dispatchInFlight !== null,
      dispatch: () => dispatchNext(),
      resolve: (id, outcome) => resolveDispatchRequest(id, outcome, { endpoint }),
      reportError: (message, error) => reportError('dispatch', message, error)
    })
  } catch {
    // Broker down / unreachable: silent, the next tick retries. Same shape as
    // the four pollers above -- only the LIST call can land here, since every
    // per-request failure is already reported inside runDispatchRequestPoll.
  }
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
    // Only the automatic dispatch path is gated here — the manual 'send first
    // to team-lead' button calls dispatchNext() directly, unguarded, and stays
    // the operator's escape hatch when the barrier holds.
    // barrierPending covers the case a pure dispatchedIds watch misses: the
    // queued head's dependency may be an item this Deck never dispatched, so
    // dispatchedIds itself never changes when that dependency resolves. retry
    // re-checks every tick while blocked; journal lines still only fire on an
    // actual state change.
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
 * dispatchedIds is in-memory only, so a Deck restart loses it entirely; this
 * seeds every locked, in_progress item as claimed:true at startup so its later
 * completion still re-arms the barrier.
 * An in_progress-but-unlocked item is deliberately left untracked: a freshly
 * restarted Deck can't tell it apart from one never dispatched at all, so the
 * manual dispatch button remains the escape hatch for that case.
 * Excludes queued-but-undispatched items (would double-count once actually
 * dispatched) and items locked via the direct-assign path, which never sets
 * locked for a 'deck' author and so already reads as unlocked.
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

// Releases a locked item back to 'planned' when its owner is one of this
// window's tiles with a silent PTY for LOCK_IDLE_MS — finer than the broker's
// sweep, since the heartbeat keeps a peer 'active' even while Claude sits idle,
// but only covers sessions this Deck can observe.
// Also requires locked_group to match this Deck's own group, fail-closed when
// locked_group is null, since a peer_id is only unique per group and a
// same-named peer in a different group could otherwise have its lock silently
// released.
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
        .find(
          (s) =>
            s.status !== 'exited' &&
            ownsIdleLock(item.locked_by, item.locked_group, s.peerId, activeScope.groupId)
        )
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
 * Shared approval core for a repo-cloned file whose content lands in a
 * sensitive sink: every caller reuses the same bookkeeping (keyed per project +
 * keyPart + content hash), so an unchanged approved file re-applies silently
 * while an edited one re-prompts.
 * hashPayload/previewLines are supplied by the caller rather than derived here,
 * so this stays agnostic to which field is dangerous — each caller names its
 * own vulnerability class.
 */
type ShellFieldApprovalOpts = {
  keyPart: string
  basename: string
  hashPayload: unknown
  previewLines: string[]
  labelEn: string
  labelFr: string
  messageEn: string
  messageFr: string
  buttonsEn: [string, string]
  buttonsFr: [string, string]
}

/**
 * The same {key, value} pair confirmShellFieldApproval's own isApproved()/
 * approve() calls use -- factored out so a caller can consult the cache
 * WITHOUT opening the dialog (see isShellFieldPreApproved below), and the
 * two can never disagree about which slot a given payload occupies.
 */
const shellFieldApprovalCacheKey = (opts: ShellFieldApprovalOpts): { key: string; value: string } => ({
  key: `${computeDeckProjectKey(getConfig().projectDir)}::${opts.keyPart}::${opts.basename}`,
  value: JSON.stringify(opts.hashPayload)
})

/**
 * Whether `opts` is already cache-approved, without ever risking the
 * blocking dialog (card 64f8f629): callers use this to decide 'unattended'
 * BEFORE calling confirmShellFieldApproval, since a payload already approved
 * must succeed even with nobody watching -- the dialog would have rubber-
 * stamped it too.
 */
const isShellFieldPreApproved = (opts: ShellFieldApprovalOpts): boolean => {
  const { key, value } = shellFieldApprovalCacheKey(opts)
  return isApproved(approvalsFile(), key, value)
}

const confirmShellFieldApproval = (opts: ShellFieldApprovalOpts): boolean => {
  const { key, value } = shellFieldApprovalCacheKey(opts)
  const file = approvalsFile()
  if (isApproved(file, key, value)) return true
  const isFr = isFrLocale()
  const preview = opts.previewLines.join('\n')
  const ok =
    dialog.showMessageBoxSync({
      type: 'warning',
      buttons: isFr ? opts.buttonsFr : opts.buttonsEn,
      defaultId: 1,
      cancelId: 1,
      title: 'Koryphaios',
      message: isFr ? opts.messageFr : opts.messageEn,
      detail: isFr
        ? `${opts.labelFr} : ${opts.basename}\n\n${preview}\n\nAccepte uniquement si tu fais confiance à ce dépôt.`
        : `${opts.labelEn}: ${opts.basename}\n\n${preview}\n\nAccept only if you trust this repository.`
    }) === 0
  if (!ok) {
    journal.add('session', `${opts.keyPart} refused: ${opts.basename}`)
    return false
  }
  approve(file, key, value)
  journal.add('session', `${opts.keyPart} approved: ${opts.basename}`)
  return true
}

const DECK_SPAWN_SHELL_FIELD_KEYPART = 'deck-spawn'

/**
 * Derives the same {basename, hashPayload} shape confirmShellFieldApproval's
 * own internal isApproved()/approve() key on -- factored out so the
 * hands-free short-circuit below and the actual gate call can never
 * disagree about which cache slot a given spawn entry occupies. `basename`
 * is content-derived (a short hash of the payload itself) rather than a
 * file name, since a spawn entry has no file: this is what lets two
 * DIFFERENT args strings live in two independent approval slots instead of
 * overwriting each other's single slot.
 */
function spawnShellFieldKey(entry: { command?: string; args?: string }): {
  basename: string
  hashPayload: { command: string; args: string }
} {
  const hashPayload = { command: entry.command ?? '', args: entry.args ?? '' }
  const basename = commandHash(JSON.stringify(hashPayload)).slice(0, 16)
  return { basename, hashPayload }
}

/**
 * Same content-hash-keyed approval cache as confirmShellFieldApproval (card
 * 64f8f629's isShellFieldPreApproved/shellFieldApprovalCacheKey), applied to
 * a spawn entry's shell fields. `attendance` (card ffafeea6) is always
 * 'unattended' on this route -- a deck-control caller is by construction an
 * agent, never the operator at the desktop -- so an unapproved payload
 * refuses and journals rather than opening a blocking dialog nobody is
 * watching.
 * The cache lives in userData, writable by any non-sandboxed host agent: it
 * separates cooperating authorities by role and does not resist a hostile
 * agent pre-approving its own payload.
 */
const confirmSpawnShellFields = (
  entry: { command?: string; args?: string },
  attendance: CallerAttendance
): boolean => {
  if (!sessionsHaveShellFields([entry])) return true
  const { basename, hashPayload } = spawnShellFieldKey(entry)
  const approvalOpts: ShellFieldApprovalOpts = {
    keyPart: DECK_SPAWN_SHELL_FIELD_KEYPART,
    basename,
    hashPayload,
    previewLines: [hashPayload.command, hashPayload.args]
      .filter((v) => v.trim())
      .map((v) => `• ${v}`),
    labelEn: 'Agent spawn',
    labelFr: 'Lancement agent',
    messageEn: 'This agent-requested session spawn runs custom launch arguments, executed in a shell.',
    messageFr:
      'Ce lancement de session demandé par un agent exécute des arguments personnalisés dans un shell.',
    buttonsEn: ['Spawn this session', 'Refuse'],
    buttonsFr: ['Lancer cette session', 'Refuser']
  }
  if (refusesUnattendedApproval(attendance, isShellFieldPreApproved(approvalOpts))) {
    journal.add(
      'session',
      `deck-spawn shell fields refused (no attended operator, not pre-approved): ${hashPayload.args || hashPayload.command}`
    )
    return false
  }
  return confirmShellFieldApproval(approvalOpts)
}

/**
 * Containment + approval gate for applying a template (B4 + M-SEC-9). Returns
 * a discriminated result (card 96c98453): 'ok:false' distinguishes a real
 * anomaly (path outside the allowed template dirs, malformed file -- both
 * MUST be surfaced as an error by callers) from the operator declining a
 * REPO-LOCAL template's shell-field approval dialog ('refused' -- a
 * deliberate choice, never an error). Global (operator-owned) templates are
 * trusted and never prompt. `attendance` (card 64f8f629) is required: an
 * 'unattended' caller never opens the dialog for an unapproved payload --
 * see confirmShellFieldApproval's own doc for why.
 */
const resolveTemplateInputs = (path: string, attendance: CallerAttendance): TemplateResolveResult => {
  const projectDir = getConfig().projectDir
  const source = templateSource(path, projectDir)
  if (!source) {
    reportError('template', `refused template path outside the allowed dirs: ${path}`)
    return { ok: false, reason: 'containment' }
  }
  const tpl = readTemplate(path)
  if (!tpl) {
    // Review correction C1, card 96c98453: mirrors the containment branch
    // above (2246) -- without this, a malformed template left NO trace
    // anywhere. readTemplate already swallows the real parse/schema cause
    // into a plain null (template-store.ts's own catch), and the agent
    // route (deck-control.ts) has no log sink of its own on this path
    // (`grep -c reportError deck-control.ts` is 0), so this is the only
    // place this anomaly is ever recorded.
    reportError('template', `template file is missing or invalid: ${path}`)
    return { ok: false, reason: 'malformed' }
  }
  if (source === 'local' && templateHasShellFields(tpl)) {
    const approvalOpts: ShellFieldApprovalOpts = {
      keyPart: 'template',
      basename: basename(path),
      hashPayload: tpl.sessions.map((s) => ({ command: s.command ?? '', args: s.args ?? '' })),
      previewLines: tpl.sessions
        .filter((s) => (s.command && s.command.trim()) || (s.args && s.args.trim()))
        .map((s) => `• ${[s.command, s.args].filter(Boolean).join(' ')}`),
      labelEn: 'Template',
      labelFr: 'Modèle',
      messageEn: 'This project template runs custom commands, executed in a shell.',
      messageFr: 'Ce modèle (config du projet) exécute des commandes personnalisées dans un shell.',
      buttonsEn: ['Apply this template', 'Refuse'],
      buttonsFr: ['Appliquer ce modèle', 'Refuser']
    }
    if (attendance === 'unattended' && !isShellFieldPreApproved(approvalOpts)) {
      journal.add('session', `template refused (no attended operator, not pre-approved): ${approvalOpts.basename}`)
      return { ok: false, reason: 'unattended' }
    }
    if (!confirmShellFieldApproval(approvalOpts)) {
      return { ok: false, reason: 'refused' }
    }
  }
  return { ok: true, inputs: templateToInputs(tpl) }
}

/**
 * Operator approval gate for workspace restore, shell-bearing `args` (card
 * 09d54a29): a workspace is read from the same repo-cloned dir as a template
 * (<projectDir>/.claude/claude-peers/workspaces/*.json) and its `args` lands
 * in the exact same shell sink, so it is gated the exact same way. Called by
 * WorkspaceService.restore() ONLY when workspaceHasShellFields(ws) is true.
 */
const confirmWorkspaceShellFields = (
  ws: { id: string; name: string; sessions: WorkspaceSession[] },
  attendance: CallerAttendance
): WorkspaceApprovalGateResult => {
  const approvalOpts: ShellFieldApprovalOpts = {
    keyPart: 'workspace',
    basename: ws.name && ws.name.trim() ? ws.name : ws.id,
    hashPayload: ws.sessions.map((s) => ({ args: s.args.join(' ') })),
    previewLines: ws.sessions
      .filter((s) => s.args.length > 0)
      .map((s) => `• ${s.name}: ${s.args.join(' ')}`),
    labelEn: 'Workspace',
    labelFr: 'Espace de travail',
    messageEn: 'This project workspace runs custom launch args, executed in a shell.',
    messageFr: 'Cet espace de travail (config du projet) exécute des arguments de lancement personnalisés dans un shell.',
    buttonsEn: ['Restore this workspace', 'Refuse'],
    buttonsFr: ['Restaurer cet espace de travail', 'Refuser']
  }
  if (attendance === 'unattended' && !isShellFieldPreApproved(approvalOpts)) {
    journal.add('session', `workspace shell fields refused (no attended operator, not pre-approved): ${approvalOpts.basename}`)
    return 'unattended'
  }
  return confirmShellFieldApproval(approvalOpts) ? 'approved' : 'declined'
}

/**
 * Operator approval gate for workspace restore, untrusted `cwd` (card
 * 09d54a29 follow-up, GX-SEC class): called by WorkspaceService.restore()
 * ONLY when workspaceHasUntrustedCwd(ws, projectDir) is true. A SEPARATE
 * vulnerability class from confirmWorkspaceShellFields above -- arbitrary
 * file read (the cwd becomes a readable root for the explorer/diff channels,
 * ipc.ts workDirRoots) rather than command execution -- kept as its own
 * keyPart/copy so the two are never silently conflated into one approval.
 */
const confirmWorkspaceUntrustedCwd = (
  ws: { id: string; name: string; sessions: WorkspaceSession[] },
  attendance: CallerAttendance
): WorkspaceApprovalGateResult => {
  const approvalOpts: ShellFieldApprovalOpts = {
    keyPart: 'workspace-cwd',
    basename: ws.name && ws.name.trim() ? ws.name : ws.id,
    hashPayload: ws.sessions.map((s) => ({ cwd: s.cwd ?? '' })),
    previewLines: ws.sessions
      .filter((s) => s.cwd && s.cwd.trim())
      .map((s) => `• ${s.name}: ${s.cwd}`),
    labelEn: 'Workspace',
    labelFr: 'Espace de travail',
    messageEn: 'This project workspace opens a session outside your project folder.',
    messageFr:
      'Cet espace de travail (config du projet) ouvre une session en dehors de votre dossier de projet.',
    buttonsEn: ['Restore this workspace', 'Refuse'],
    buttonsFr: ['Restaurer cet espace de travail', 'Refuser']
  }
  if (attendance === 'unattended' && !isShellFieldPreApproved(approvalOpts)) {
    journal.add('session', `workspace untrusted cwd refused (no attended operator, not pre-approved): ${approvalOpts.basename}`)
    return 'unattended'
  }
  return confirmShellFieldApproval(approvalOpts) ? 'approved' : 'declined'
}

// ----- Supervisor spawn approval (PLAN TS4) -----
// The trust-mode gate behind deck_spawn_session / deck_spawn_team. hands-free:
// no UI (the consent rule lives in the supervisor's system prompt); team-review
// would show ONE recap dialog, full-control one dialog per entry -- but every
// caller of this gate is a deck-control (agent) caller, CallerAttendance is
// always 'unattended' here (card ffafeea6), so those two modes refuse instead
// of opening a dialog nobody at the desktop could answer.
const summaryLine = (s: SpawnSummary): string => {
  const parts = [
    `• ${s.name}`,
    s.embedded ? `[embedded: ${s.embedded}]` : s.agent ? `[agent: ${s.agent}]` : '',
    s.model ? `model ${s.model}` : '',
    s.effort ? `effort ${s.effort}` : '',
    s.worktree_branch ? `⎇ ${s.worktree_branch}` : ''
  ].filter(Boolean)
  const head = parts.join('  ')
  // Shows args verbatim so the operator can see the free-form shell arguments
  // before approving the spawn.
  const lines = [head, s.args ? `   args: ${s.args}` : '', s.prompt_preview ? `   ${s.prompt_preview}` : ''].filter(
    Boolean
  )
  return lines.join('\n')
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

const approveSpawn = async (entries: SpawnSummary[], attendance: CallerAttendance): Promise<boolean[]> => {
  const mode = getConfig().supervisorSpawnMode
  if (mode === 'hands-free' || entries.length === 0) return entries.map(() => true)
  // alreadyApproved is always false here: unlike confirmSpawnShellFields's
  // per-payload cache, a whole spawn PLAN has no pre-approval concept to
  // fall back on -- an unattended caller refuses unconditionally rather than
  // opening spawnDialog on nobody.
  if (refusesUnattendedApproval(attendance, false)) {
    journal.add('session', `supervisor spawn plan (${entries.length}) refused (no attended operator to review)`)
    return entries.map(() => false)
  }
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

/**
 * Card 9d8e24f4: userData is shared by every Kory instance (no
 * requestSingleInstanceLock) -- this project directory's own identity, so
 * `teamLeadMcpConfigFile` below and the sweep call further down read the SAME
 * value rather than each deriving their own.
 */
const instanceToken = teamLeadInstanceToken(computeDeckProjectKey(cliContext.projectDir))

/** The team-lead --mcp-config filename for a given minted callerId (card 6c380073), prefixed per-instance (card 9d8e24f4). */
const teamLeadMcpConfigFile = (callerId: string): string => teamLeadMcpConfigFileName(instanceToken, callerId)

/**
 * Card 6c380073 (review round 2, point 3): sweep team-lead-mcp-*.json left
 * behind by a previous run. Every one of those carries a token that died with
 * the callerTable of the process that minted it, so they are inert as
 * AUTHORIZATION -- this is residue collection, not a security gate. Called
 * once at startup, BEFORE any mint, so it can never race a file the current
 * run has just written: this run's callerIds carry fresh random suffixes and
 * do not exist on disk yet at this point.
 * Card 9d8e24f4: the instance-token prefix (see `instanceToken` above) keeps
 * this from ever matching another live instance's file.
 */
const sweepStaleTeamLeadMcpConfigs = (): void => {
  const dir = join(app.getPath('userData'), APP_STATE_SUBDIR)
  sweepTeamLeadMcpConfigs(dir, instanceToken, {
    dirExists: existsSync,
    listFiles: readdirSync,
    removeFile: (d, name) => unlinkSync(join(d, name)),
    onFileError: (name, e) => reportError('deck', `failed to sweep stale team-lead mcp config ${name}`, e),
    onScanError: (e) => reportError('deck', 'failed to scan the app-state dir for stale team-lead mcp configs', e)
  })
}

/**
 * Audit fix #2 (card 6c380073): delete a team-lead callerId's --mcp-config
 * file, if any. Shared by the spawn-failure rollback (spawnEntry's own catch,
 * via revokeTeamLeadMcpConfig below) AND the final-removal revocation (the
 * 'removed' listener further down) so both paths agree on the exact same
 * file name. Best-effort: a missing file is not an error, and the file may
 * legitimately not exist yet (spawn failed before the write) or already be
 * gone (removed by the other path under a genuine race).
 */
const cleanupTeamLeadMcpFile = (callerId: string): void => {
  const file = join(app.getPath('userData'), APP_STATE_SUBDIR, teamLeadMcpConfigFile(callerId))
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch (e) {
    reportError('deck', `failed to remove team-lead mcp config for ${callerId}`, e)
  }
}

const controlDeps: DeckControlDeps = {
  listAgents: () => listAgents(getConfig().projectDir),
  listModels: () => resolveLaunchConfig(getConfig().projectDir).models,
  listPresets: () => resolveLaunchConfig(getConfig().projectDir).presets,
  spawnSession: (input) => {
    // Card 3c322f10: this is the plain `deck_spawn_session` MCP tool,
    // `entry.agent` set directly rather than `embedded_agent` -- deck-control.ts's
    // own leadMint/mcpConfig above only fires for the latter, so an
    // `agent: 'team-lead'` call here still needs the marker computed the same
    // way as every other route.
    return createSessionWithWorktree(
      service,
      getConfig().projectDir,
      input,
      checkpointBeforeSpawn,
      getWorktreeInit(),
      sandboxGate,
      warmSandboxTranscripts,
      { teamLeadDeckBridge: isTeamLeadAgent(input.agent) }
    )
  },
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
  // Card 89cb66f9: split in two so deck-control.ts can capCheck/approveSpawn
  // the whole batch and write ownedSessions per tile -- the old applyTemplate
  // returned only a count (inputs.length), never the created sessions.
  // resolveTemplate is PURE (path containment + repo-local shell-field
  // approval via resolveTemplateInputs): no spawn side effect. Since card
  // 96c98453 this forwards a discriminated TemplateResolveResult, not
  // TemplateInput[] | null -- deck-control.ts's own dep type and call site
  // were updated to match (see its own templateInputsOrEmpty usage).
  // Card ffafeea6: a deck-control caller is by construction an agent, never
  // the operator at the desktop -- 'unattended' unconditionally, regardless
  // of supervisorSpawnMode. An unapproved shell-bearing template refuses
  // rather than opening confirmShellFieldApproval's blocking dialog on a
  // caller who could never answer it.
  resolveTemplate: (path) => resolveTemplateInputs(path, 'unattended'),
  // Append-only by contract (deck-control): never closes existing tiles.
  // `checkpoint`/`hasLead` are decided ONCE by the caller for the whole
  // batch (same semantics the old inline loop had) and threaded through here
  // rather than recomputed per tile.
  spawnTemplateEntry: async (input, opts) => {
    if (opts.checkpoint) await checkpointBeforeSpawn(getConfig().projectDir)
    return createSessionWithWorktree(
      service,
      getConfig().projectDir,
      opts.hasLead ? { ...input, lead: undefined } : input,
      undefined,
      getWorktreeInit(),
      sandboxGate,
      warmSandboxTranscripts,
      // Card 3c322f10 (piece 3, agent route): the deck-control server is
      // necessarily already up here -- this call only ever arrives through
      // it -- so unlike the operator route there is no ensureControlServer()
      // to start proactively.
      { teamLeadDeckBridge: isTeamLeadAgent(input.agent) }
    )
  },
  saveTemplate: (name, local) => {
    const tpl = toTemplate(service.captureSessions(), name)
    const dir = local ? localTemplatesDir(getConfig().projectDir) : globalTemplatesDir()
    return writeTemplate(dir, name || tpl.name || 'template', tpl)
  },
  announce: (text) => broadcastAnnounce(text),
  // Team spawn (TS2-TS4): trust-mode gate, sync/async connection acks, and the
  // embedded profile prompt regenerated from the code constant at every spawn.
  // Card ffafeea6: 'unattended' unconditionally, same reasoning as
  // resolveTemplate above -- this route's caller is never the operator.
  approveSpawn: (entries) => approveSpawn(entries, 'unattended'),
  waitForPeer,
  armSpawnAck,
  writeEmbeddedPrompt: (id) =>
    writeEmbeddedAgentPrompt(join(app.getPath('userData'), APP_STATE_SUBDIR), id),
  // Card ff091064 (piece 2): mirrors ensureSupervisor's own writer call below,
  // for the team-lead tile instead of the Home supervisor tile. Only reached
  // once deck-control's dispatch is already handling a request, which cannot
  // happen before startDeckControl (below) has resolved and set controlServer.
  // Card 6c380073: `token`/`callerId` come from spawnEntry's own mintCaller()
  // call (deck-control.ts), never controlServer.token (the supervisor's) --
  // the filename is keyed on callerId so two team-lead spawns never race to
  // overwrite each other's --mcp-config.
  writeTeamLeadMcpConfig: (token: string, callerId: string, allowedTools: readonly string[]): string => {
    if (!controlServer) throw new Error('deck-control endpoint not started yet')
    const deckPluginDir = getDeckPluginDir()
    if (!deckPluginDir) throw new Error('deck-plugin dir missing (build skipped)')
    const mcpScript = join(deckPluginDir, 'mcp', 'deck-control-mcp.mjs')
    if (!existsSync(mcpScript)) {
      throw new Error('deck-control MCP script missing -- run `npm run build:mcp`')
    }
    return writeTeamLeadMcpConfig(
      {
        dir: join(app.getPath('userData'), APP_STATE_SUBDIR),
        mcpScriptPath: mcpScript,
        execPath: process.execPath,
        controlUrl: controlServer.url,
        controlToken: token
      },
      teamLeadMcpConfigFile(callerId),
      allowedTools
    )
  },
  // Audit fix #2 (card 6c380073): undo a writeTeamLeadMcpConfig() call whose
  // spawn failed after the token was minted and the file already written --
  // best-effort, a missing file is not an error.
  revokeTeamLeadMcpConfig: (callerId: string): void => {
    cleanupTeamLeadMcpFile(callerId)
  },
  // Audit fix #1c (card 6c380073): see confirmSpawnShellFields's own doc.
  // Card ffafeea6: 'unattended' unconditionally, same reasoning as
  // resolveTemplate/approveSpawn above.
  confirmSpawnShellFields: (entry) => confirmSpawnShellFields(entry, 'unattended')
}

let controlServer: DeckControlServer | null = null
let companionServer: CompanionServer | null = null
/**
 * Memoizes the in-flight start promise, not just the started server: two
 * callers could otherwise both observe controlServer still null, both invoke
 * startDeckControl, and the second assignment would silently orphan the first
 * server (a loopback listener with no remaining reference, never closed).
 * The null check and the assignment run synchronously with no await between
 * them, so a second caller arriving before the first startDeckControl resolves
 * always awaits that same in-flight promise instead of starting its own.
 */
let controlServerStarting: Promise<DeckControlServer> | null = null

/**
 * Lazily start the deck-control HTTP endpoint, memoized in the module-scope
 * `controlServer` above (race-safe via `controlServerStarting`, its own
 * doc). Card 3c322f10 (piece 2, operator route) factored this out of
 * ensureSupervisor (which used to inline the same check): the operator-route
 * team-lead bridge (buildMintTeamLeadBridge, wired into the SessionService
 * constructor above) needs the IDENTICAL "started once, shared across every
 * consumer" guard.
 */
const ensureControlServer = async (): Promise<DeckControlServer> => {
  if (controlServer) return controlServer
  if (!controlServerStarting) {
    controlServerStarting = startDeckControl(controlDeps)
      .then((server) => {
        controlServer = server
        return server
      })
      .catch((e) => {
        // Allow a later call to retry a failed start instead of being stuck
        // replaying the same rejection forever.
        controlServerStarting = null
        throw e
      })
  }
  return controlServerStarting
}

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

  const deckPluginDir = getDeckPluginDir()
  if (!deckPluginDir) throw new Error('deck-plugin dir missing (build skipped)')
  const mcpScript = join(deckPluginDir, 'mcp', 'deck-control-mcp.mjs')
  if (!existsSync(mcpScript)) {
    throw new Error('deck-control MCP script missing -- run `npm run build:mcp`')
  }
  const server = await ensureControlServer()
  const stateDir = join(app.getPath('userData'), APP_STATE_SUBDIR)
  const mcpConfig = writeSupervisorMcpConfig({
    dir: stateDir,
    mcpScriptPath: mcpScript,
    execPath: process.execPath,
    controlUrl: server.url,
    controlToken: server.token
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
  adoptScope,
  confirmShellFields: confirmWorkspaceShellFields,
  confirmUntrustedCwd: confirmWorkspaceUntrustedCwd
})

// Grey out File > Export template... when there is nothing to export. Must
// count the same population saveTemplate() itself serializes
// (service.captureSessions(), which excludes the supervisor): service.list()
// alone (includes it) left the item enabled on a supervisor-only moment for
// an export that would come back empty -- same root cause as the auto-save
// guard below, in this same file (b8d65b24, mutation-tested review).
const syncExportTemplateEnabled = (): void => {
  const item = Menu.getApplicationMenu()?.getMenuItemById('export-template')
  if (item) item.enabled = service.list().some((s) => !s.supervisor)
}
service.on('changed', syncExportTemplateEnabled)

// Continuously auto-save the live workspace (debounced) as sessions change, but
// only once there are non-supervisor sessions -- launching supervisor-only must
// not mint/clobber a workspace (the previous run stays restorable until the
// user acts). Must count the same population WorkspaceService.saveAuto() itself
// snapshots (captureSessions(), which excludes the supervisor): list() here
// includes it, so a naive length check would pass on a supervisor-only moment
// and race the guard now living in saveAuto() -- redundant with it, but this is
// the site whose own comment used to claim the opposite.
let autoSaveTimer: NodeJS.Timeout | null = null
service.on('changed', (sessions: SessionRuntime[]) => {
  if (!Array.isArray(sessions) || !sessions.some((s) => !s.supervisor)) return
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => {
    // A workspace I/O error must never take down the main process.
    try {
      const summary = workspaces.saveAuto()
      // null: saveAuto() itself declined (nothing captured) -- no title update.
      if (summary) broadcast('workspace:current', summary)
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
  // Card 6c380073: drop last run's team-lead --mcp-config files before this
  // run can mint anything (see the function's own doc for why the ordering
  // is what makes this safe rather than a race).
  sweepStaleTeamLeadMcpConfigs()
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
      onNewTemplate: () => toRenderer('menu:new-template'),
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
    // Card 3c322f10 (piece 2): declared at line ~2582, well before this call
    // site (~2964) -- no TDZ concern here, unlike the SessionService
    // constructor much earlier in the file.
    ensureControlServer,
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
      void pollPendingApprovals()
      void pollDispatchRequests()
    },
    approvalReply: async (id: string, text: string): Promise<boolean> => {
      const deps = approvals.deps()
      if (!deps) return false
      const res = await claimApproval(deps, { id, answerKind: 'text', answerText: text })
      return res !== null
    },
    approvalDecline: async (id: string): Promise<boolean> => {
      const deps = approvals.deps()
      if (!deps) return false
      const res = await claimApproval(deps, { id, answerKind: 'deny' })
      return res !== null
    },
    approvalAllow: async (id: string): Promise<boolean> => {
      const deps = approvals.deps()
      if (!deps) return false
      const res = await claimApproval(deps, { id, answerKind: 'allow' })
      return res !== null
    },
    // Unified Courrier's reply-to-a-peer-message action: same sendAnnounce
    // primitive as the existing team-lead/supervisor/assignment announces
    // above, just addressed by the caller's own toPeerId instead of a role
    // this process already knows.
    announceTo: async (toPeerId: string, text: string): Promise<number> => {
      try {
        const { sent } = await sendAnnounce(
          { groupId: activeScope.groupId, secret: activeScope.secret, text, toPeerId },
          { endpoint: resolveBrokerEndpoint() }
        )
        if (sent > 0) journal.add('announce', `announce to ${toPeerId}: ${text.slice(0, 120)}`)
        return sent
      } catch (e) {
        reportError('announce', 'targeted announce failed', e)
        return 0
      }
    },
    deckPluginDir: getDeckPluginDir,
    sandbox,
    sandboxGate,
    sandboxWarmTranscripts: warmSandboxTranscripts,
    purgeInboxSession,
    inboxDelete
  })
  // Arm remote approvals BEFORE service.start(): restored sessions spawn there,
  // and a session spawned without the credential path would never produce an
  // approval. Unconditional (card 469f3176): the blocking channel (ask_operator
  // + the local Courrier) must exist whether or not the operator ever wired a
  // phone transport -- config.mobileApprovals only decides whether a question
  // is ALSO relayed to Telegram/Discord/ntfy, never whether it can be asked at
  // all. A failure only means the feature stays off; the app starts anyway.
  const armed = await armApprovalsAtStartup(approvals)
  journal.add('session', armed ? 'remote approvals armed' : 'remote approvals unavailable')
  service.start()
  // Attach an auto-save workspace capturing whatever the service just restored.
  workspaces.start()
  // Operator inbox drain (PLAN C12) + pending graph drafts (same cadence).
  inboxTimer = setInterval(() => {
    void pollOperatorInbox()
    void pollGraphDrafts()
    void pollApprovalVerdicts()
    void pollPendingApprovals()
    // Card bf76d37f: same cadence, same best-effort contract as its four
    // siblings -- a tick that cannot reach the broker simply retries later.
    void pollDispatchRequests()
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
