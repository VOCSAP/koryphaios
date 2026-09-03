import { join } from 'node:path'
import { app, BrowserWindow, desktopCapturer, dialog, shell, webContents } from 'electron'
import { broadcast, isLocalIpcEvent, regHandle, regOn } from './api-registry'
import { safeExternalUrl } from './external-url'
import type {
  AckableInboxEntry,
  AppConfig,
  AssignResult,
  CreateSessionInput,
  DispatchResult,
  HelpExchange,
  I18nPayload,
  DeckGraphDraft,
  LaunchConfig,
  RoadmapListFilters,
  RoadmapQuery,
  RoadmapUpsertFields,
  SandboxContainerAction,
  SandboxSettingsPatch,
  SessionRuntime,
  StopMode,
  StopReport,
  StopResult
} from '@shared/types'
import { inboxEntryKey } from '@shared/types'
import { broadcastStop, lockTargets, STOP_MODES, stopTouchesLocks, toInterruptMode } from './agent-stop'
import type { SandboxService } from './sandbox-service'
import { buildAuthCommand, SANDBOX_AUTH_PTY_ID, SANDBOX_BUILD_PTY_ID } from './sandbox-command'
import { APP_STATE_SUBDIR } from './migrate-data-dir'
import { buildHelpPrompt, buildHelpSystemPrompt, sanitizeHelpSelection } from './help-assistant'
import { buildWandPrompt, WAND_SYSTEM_PROMPT, type WandDraft } from './context-wand'
import { runUtilityInference, type UtilityDeps } from './utility-inference'
import { markGraphDraftOpened, resolveBrokerEndpoint } from './broker-client'
import type { BrokerStatusEvent } from './broker-client'
import {
  appendAckedKey,
  appendSeenKey,
  loadAckStateWithMigrationSeed,
  loadInboxHistory
} from './inbox-store'
import { classifyInboxDeleteIds } from './inbox-session'
import {
  buildDigestSystemPrompt,
  collectSources,
  DIGEST_PROMPT,
  readDigestConfig,
  sourcesForProject
} from './digest'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import {
  archiveRoadmap,
  computeDeckProjectKey,
  listRoadmap,
  lockPark,
  lockRelease,
  reorderRoadmap,
  searchRoadmap,
  upsertRoadmap
} from './roadmap-service'
import { validateReorderWaves } from './roadmap-reorder-validate'
import { createSessionWithWorktree } from './create-session'
import { composePlanImportPrompt } from './import-plan'
import { collectDiff, collectFileDiff, composeDiffReviewPrompt } from './diff-service'
import { clearReviewState, readReviewState, validatePersistedReview, writeReviewState } from './review-state-service'
import { recordingFileName } from '@shared/recording'
import { DEFAULT_DEMO_TARGET, sanitizeTarget } from '@shared/models'
import { startDemoControl } from './demo-control'
import { createBrowserDriver } from './browser-drive'
import {
  buildDemoCommand,
  cancelDemoRun,
  demoRunning,
  MAX_SCENARIO_CHARS,
  runDemoCommand,
  writeDemoMcpConfig,
  writeDemoScenarioFile,
  writeDemoSystemPrompt
} from './demo-driver'
import { markProviderUsed } from './usage-service'
import { listExplorerDir, readExplorerFile } from './explorer-service'
import {
  canonicalPath,
  createWorktree,
  listWorktrees,
  removeWorktree,
  runWorktreeInit,
  worktreeStatus
} from './worktree-service'
import { resolve as resolvePath } from 'node:path'
import type { SessionService } from './session-service'
import { STOP_IDLE_WAIT_MS } from './session-service'
import type { CallerAttendance, WorkspaceService } from './workspace-service'
import type { Journal, JournalKind } from './journal'
import { listAgents } from './agents'
import { resolveLaunchConfig, saveGlobalConfig } from './launch-config'
import {
  listTemplates,
  readTemplate,
  templateSource,
  writeTemplate,
  deleteTemplate,
  globalTemplatesDir,
  localTemplatesDir
} from './template-store'
import {
  deleteSnippet,
  globalSnippetsDir,
  listSnippets,
  localSnippetsDir,
  writeSnippet
} from './snippet-store'
import { deleteGraph, loadGraphs, migrateGraphsAtRest, upsertGraph } from './graph-store'
import { getCatalogs } from './model-registry'
import { readUsage } from './usage-service'
import { runPtyCommand } from './pty-run'
import { GRAPH_INFER_TIMEOUT_MS } from './model-adapters'
import { decryptProviders, sanitizeProviders } from './provider-secrets'
import type { SecretCipher } from './scope-secrets'
import { compileContext, runInference, type InferRequest } from './graph-engine'
import { graphId as graphDocId, parseGraphDoc, type GraphDoc } from '../shared/graph'
import { parseTemplate, toTemplate, type TemplateResolveResult } from '@shared/template'
import { templateInputsOrThrow } from '@shared/template-apply-outcome'
import { workspaceRestoreOrThrow } from '@shared/workspace-restore-outcome'
import { availableLocales, loadDict, resolveLocale } from './i18n'
import { reportError } from './log'

/**
 * Build the renderer i18n payload from the current config. Reads shipped locale
 * files (resources dir when packaged, app dir in dev) plus a user-override dir
 * under userData, then falls back to the embedded English base for any gap.
 */
/**
 * Shipped reference-documentation directory (desktop/docs), resolved like the
 * locales: process.resourcesPath when packaged (extraResources), the app dir
 * in dev. '' when missing so callers can omit the docs pointer cleanly.
 */
export function resolveDocsDir(): string {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'docs')
    : join(app.getAppPath(), 'docs')
  return existsSync(dir) ? dir : ''
}

function buildI18n(config: AppConfig): I18nPayload {
  const locale = resolveLocale(config.locale, app.getLocale())
  const shippedDir = app.isPackaged
    ? join(process.resourcesPath, 'locales')
    : join(app.getAppPath(), 'locales')
  const userDir = join(app.getPath('userData'), 'locales')
  const dirs = [shippedDir, userDir]
  return { locale, dict: loadDict(locale, dirs), available: availableLocales(dirs) }
}

interface IpcDeps {
  service: SessionService
  workspaces: WorkspaceService
  getConfig: () => AppConfig
  setConfig: (patch: Partial<AppConfig>) => AppConfig
  /** safeStorage-backed cipher (index.ts): local-provider API keys (C29). */
  secretCipher: SecretCipher
  getWindow: () => BrowserWindow | null
  /** Broadcast a free-text operator message to the active group; returns peer count. */
  announce: (text: string) => Promise<number>
  /** Spawn (or return) the Home supervisor session (PLAN C5). */
  ensureSupervisor: () => Promise<SessionRuntime>
  /** Activity journal (PLAN C14), owned by index.ts. */
  journal: Journal
  /** Dispatch the first queued roadmap item to the team-lead (PLAN C15). */
  dispatchNext: () => Promise<DispatchResult>
  /** Operator stop on an in_progress item (PLAN K3): notify + unlock. */
  stopRoadmapItem: (id: string) => Promise<StopResult>
  /** Direct assignment to one live peer via targeted announce (PLAN K6). */
  assignRoadmapItem: (id: string, peerId: string) => Promise<AssignResult>
  /** Git checkpoint of a dirty tree before an agent spawns there (PLAN C16). */
  checkpoint: (dir: string) => Promise<void>
  /** Operator-approved worktree-init hook for this project (B5), or undefined. */
  getWorktreeInit: () => string | undefined
  /**
   * Containment + approval gate for a template path (B4 + M-SEC-9): returns a
   * discriminated result (card 96c98453) -- 'ok:false' distinguishes a real
   * anomaly (out-of-tree path, malformed file) from the operator declining a
   * repo-local shell-bearing template ('refused', not an error). `attendance`
   * (card 64f8f629): 'unattended' never opens the shell-field approval dialog
   * for an unapproved payload.
   */
  resolveTemplateInputs: (path: string, attendance: CallerAttendance) => TemplateResolveResult
  /** Current broker reachability (PLAN O5), owned by index.ts. */
  brokerStatus: () => BrokerStatusEvent
  /** Force an immediate broker poll (banner Retry button). */
  brokerRetry: () => void
  /**
   * deck-plugin dir (built hook/mcp/design assets), '' when the build was
   * skipped or has since gone missing. A GETTER (card d02c8e96 fix c), not a
   * cached string: index.ts's getDeckPluginDir re-checks existsSync live on
   * every call, so a dir deleted mid-run (aborted repackage) is caught at the
   * next demo-browser launch instead of silently reusing a stale path.
   */
  deckPluginDir: () => string
  /** Sandbox container lifecycle for this project (PLAN-SANDBOX). */
  sandbox: SandboxService
  /**
   * Pre-spawn readiness gate handed to createSessionWithWorktree (SBX3/M3):
   * resolves the EFFECTIVE project root (the ephemeral clone in copy mode),
   * or null when the sandbox is off.
   */
  sandboxGate: () => Promise<string | null>
  /** Warm the container-side transcript cache for a session's real cwd (M2). */
  sandboxWarmTranscripts: (cwd: string) => Promise<void>
  /**
   * Answer a pending/expired_notif blocking question as the operator
   * (Courrier family 3): claims it broker-side and delivers to the waiting
   * agent. `false` means another channel (phone/telegram/discord) won the
   * race, not a failure -- mirrors index.ts's existing local-claim path.
   */
  approvalReply: (id: string, text: string) => Promise<boolean>
  /**
   * Decline a pending/expired_notif blocking question. This IS an answer
   * (settles the ticket, unblocks the agent with a refusal) -- never an ack.
   */
  approvalDecline: (id: string) => Promise<boolean>
  /**
   * Allow a pending/expired_notif 'permission' approval. Mirrors
   * approvalDecline exactly (card c7df3781) -- same claim primitive, other
   * verdict (`answerKind: 'allow'`).
   */
  approvalAllow: (id: string) => Promise<boolean>
  /** Reply to an ordinary (family 1) inbox message: a plain targeted announce, not correlated to anything broker-side. */
  announceTo: (toPeerId: string, text: string) => Promise<number>
  /**
   * Courrier lot 1D (card 1e81ee7b): session-scope purge, called after each
   * of the three classifying gestures (app:new-clear, a successful
   * workspace:restore, template:apply mode='replace'). Best-effort -- never
   * throws, never blocks the gesture it rides on.
   */
  purgeInboxSession: () => Promise<void>
  /** Courrier lot 1E (card 1e81ee7b): manual delete, see inbox-store.ts. */
  inboxDelete: (ids: number[]) => Promise<number>
  /**
   * Card 3c322f10 (piece 2, operator route): lazily start (or return the
   * already-started) deck-control HTTP endpoint. `sessions:create` awaits
   * this itself, proactively, BEFORE calling into SessionService.create()
   * for an `agent: 'team-lead'` request -- kept OUT of SessionService.create()
   * itself (team-lead arbitration) so session creation stays synchronous/
   * atomic for every other caller. Shared with ensureSupervisor (index.ts),
   * never a second lazy-start guard.
   */
  ensureControlServer: () => Promise<unknown>
}

export function registerIpc({
  service,
  workspaces,
  getConfig,
  setConfig,
  secretCipher,
  getWindow,
  announce,
  ensureSupervisor,
  journal,
  dispatchNext,
  stopRoadmapItem,
  assignRoadmapItem,
  checkpoint,
  getWorktreeInit,
  resolveTemplateInputs,
  brokerStatus,
  brokerRetry,
  deckPluginDir,
  sandbox,
  sandboxGate,
  sandboxWarmTranscripts,
  approvalReply,
  approvalDecline,
  approvalAllow,
  announceTo,
  purgeInboxSession,
  inboxDelete,
  ensureControlServer
}: IpcDeps): void {
  // ----- sessions -----
  regHandle('sessions:list', () => service.list())
  // teamLeadDeckBridge is computed here from input?.agent directly, never read
  // off input and forwarded — no boolean may ride along on the object passed to
  // createSessionWithWorktree, which stays byte-for-byte what the caller sent.
  // A paired companion requesting agent:'team-lead' does get the bridge, by
  // design; that's acceptable only because such a companion can already call
  // pty:input into any live tile — execute an arbitrary command by shell-prefix
  // already — so these tools grant no additional power. Re-examine if that
  // tier-1 power is ever revoked or scoped down.
  regHandle('sessions:create', async (_e, input: CreateSessionInput) => {
    const teamLeadDeckBridge = input?.agent === 'team-lead'
    // Card 3c322f10 (piece 2, operator route, team-lead arbitration): started
    // PROACTIVELY here, not inside SessionService.create() -- see that
    // function's own doc for why staying synchronous/atomic there matters.
    // Best-effort: a failure here (e.g. deck-plugin dir missing) must not
    // block the operator's tile from opening at all, only mean it opens
    // without the bridge (SessionService.create()'s own mintTeamLeadBridge
    // reads `controlServer` as still null and degrades the same way it
    // already does for every other "not started" case).
    if (teamLeadDeckBridge) {
      try {
        await ensureControlServer()
      } catch (e) {
        reportError('session', 'failed to start the deck-control endpoint for an operator-opened team-lead tile', e)
      }
    }
    return createSessionWithWorktree(
      service,
      getConfig().projectDir,
      input ?? {},
      checkpoint,
      getWorktreeInit(),
      sandboxGate,
      sandboxWarmTranscripts,
      { teamLeadDeckBridge }
    )
  })
  regHandle('sessions:remove', (_e, id: string) => service.remove(id))
  regHandle('sessions:rename', (_e, id: string, name: string) => service.rename(id, name))
  regHandle('sessions:set-color', (_e, id: string, color: string) =>
    service.setColor(id, color)
  )
  regHandle('sessions:restart', (_e, id: string) => service.restart(id))
  regHandle('sessions:set-auto-resume', (_e, id: string, enabled: boolean) =>
    service.setAutoResume(id, !!enabled)
  )
  regHandle('sessions:clear-attention', (_e, id: string) => service.clearAttention(id))
  regHandle('sessions:set-lead', (_e, id: string) => service.setLead(id))
  regHandle('sessions:peek-next-color', () => service.peekNextColor())
  regHandle('sessions:reorder', (_e, ids: string[]) => service.reorder(ids ?? []))
  // "New (clear)": save+detach the current workspace (while sessions still
  // exist) THEN close all sessions, returning the window to the empty state.
  regHandle('app:new-clear', () => {
    workspaces.startNew()
    service.closeAll()
    broadcast('workspace:current', null)
    // Courrier lot 1D (card 1e81ee7b): "this session starts over" -- one of
    // the three classifying gestures. Fire-and-forget: purgeInboxSession is
    // itself best-effort and must never delay this handler's return.
    void purgeInboxSession()
  })

  // ----- pty io (fire-and-forget) -----
  regOn('pty:input', (_e, id: string, data: string) => service.write(id, data))
  regOn('pty:resize', (_e, id: string, cols: number, rows: number) =>
    service.resize(id, cols, rows)
  )

  // ----- embedded browser (PLAN D1) -----
  // Absolute path of the guest preload injected into the <webview>. Built as a
  // second preload entry (electron.vite.config.ts) next to index.js.
  regHandle('browser:preload-path', () => join(__dirname, '../preload/browser-inspect.js'))

  // Screenshot of the browser <webview> (draw mode, D1). The id must belong to
  // a webview hosted by OUR window — never an arbitrary webContents.
  regHandle('browser:capture', async (_e, id: number) => {
    const win = getWindow()
    const wc = typeof id === 'number' ? webContents.fromId(id) : undefined
    if (!win || !wc || wc.hostWebContents !== win.webContents) return null
    try {
      const img = await wc.capturePage()
      return img.toDataURL()
    } catch {
      return null
    }
  })

  // ----- window mirror (PLAN D2a) -----
  // List capturable OS windows/screens for the browser view's Window mode.
  // Thumbnails small on purpose: the picker only needs recognizable previews.
  regHandle('design:list-windows', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false
    })
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
  })

  // Full-size still of one source. desktopCapturer's thumbnail IS the capture:
  // requesting a large bounding box yields a native-resolution, aspect-true
  // image without opening a getUserMedia stream (a still is also what the
  // annotation flow wants — the page can't move under the strokes).
  regHandle('design:capture-window', async (_e, id: string) => {
    if (typeof id !== 'string' || !id) return null
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 4096, height: 4096 },
      fetchWindowIcons: false
    })
    const src = sources.find((s) => s.id === id)
    if (!src || src.thumbnail.isEmpty()) return null
    return { dataUrl: src.thumbnail.toDataURL(), title: src.name }
  })

  // Shared by browser:save-annotation and the review-state handlers below --
  // both need the same annotations dir (screenshots referenced by a pending
  // review live there; its 7-day prune runs from the save-annotation path).
  const reviewAnnotationsDir = (): string => join(app.getPath('userData'), APP_STATE_SUBDIR, 'annotations')
  // Sibling of, not inside, the annotations dir -- so the state file itself
  // is never swept by the annotations dir's 7-day prune.
  const reviewStateFile = (): string => join(app.getPath('userData'), APP_STATE_SUBDIR, 'review-pending.json')

  // Persist an annotated screenshot (page capture + operator strokes,
  // composited renderer-side) so the docked agent can Read the image file.
  // Kept under app state, pruned after 7 days (same policy as checkpoints).
  regHandle('browser:save-annotation', (_e, dataUrl: string) => {
    const PREFIX = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) return null
    const b64 = dataUrl.slice(PREFIX.length)
    if (b64.length > 48 * 1024 * 1024) return null // ~36 MB decoded, plenty
    const dir = reviewAnnotationsDir()
    try {
      mkdirSync(dir, { recursive: true })
      for (const f of readdirSync(dir)) {
        try {
          const p = join(dir, f)
          if (Date.now() - statSync(p).mtimeMs > 7 * 86_400_000) rmSync(p)
        } catch {
          /* concurrent cleanup */
        }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const path = join(dir, `annotation-${stamp}.png`)
      writeFileSync(path, Buffer.from(b64, 'base64'))
      return path
    } catch (err) {
      console.error('[browser] annotation save failed:', err)
      return null
    }
  })

  // Persisted design-review draft (review-state-service.ts): pending
  // PickAnnotation[] survive a window reload / app restart. Same annotations
  // dir as browser:save-annotation (screenshotPath containment checks
  // against it); the state file itself is a sibling under app state, not
  // inside the annotations dir (so its own 7-day prune never touches it).
  regHandle('browser:review-load', () =>
    readReviewState(reviewStateFile(), {
      annotationsDir: reviewAnnotationsDir(),
      report: (m, e) => reportError('browser', m, e)
    })
  )

  // The renderer is not trusted blindly (hostile input #3): re-validate
  // through the same STRICT/fail-closed validatePersistedReview the read
  // path uses before ever writing it to disk.
  regHandle('browser:review-save', async (_e, raw: unknown) => {
    const validated = await validatePersistedReview(raw, { annotationsDir: reviewAnnotationsDir() })
    if (!validated) {
      reportError('browser', 'review-save rejected: invalid review state', raw)
      throw new Error('invalid review state')
    }
    try {
      await writeReviewState(reviewStateFile(), validated)
      return true
    } catch (err) {
      reportError('browser', 'review-save failed', err)
      throw err
    }
  })

  regHandle('browser:review-clear', async () => {
    try {
      await clearReviewState(reviewStateFile())
    } catch (err) {
      reportError('browser', 'review-clear failed', err)
      throw err
    }
  })

  // Finished screen recording (REC, browser view). The bytes arrive as one
  // Uint8Array from the renderer's MediaRecorder; unlike annotations there is
  // no pruning — recordings are deliverables (README demos), the operator
  // deletes them. 1 GiB cap: far above any demo-length clip, below IPC pain.
  regHandle('browser:save-recording', (_e, data: Uint8Array, ext: string) => {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) return null
    if (data.byteLength > 1024 * 1024 * 1024) return null
    if (ext !== 'mp4' && ext !== 'webm') return null
    const dir = join(app.getPath('userData'), APP_STATE_SUBDIR, 'recordings')
    try {
      mkdirSync(dir, { recursive: true })
      const path = join(dir, recordingFileName(ext))
      writeFileSync(path, data)
      return path
    } catch (err) {
      reportError('browser', 'recording save failed', err)
      return null
    }
  })

  // ----- REC scripted scenario (demo driver) -----
  // One throwaway demo agent drives the embedded webview through a PER-RUN
  // loopback endpoint + token (demo-control.ts, least privilege: never the
  // supervisor's deck-control token) while the renderer records the pane.
  regHandle(
    'browser:demo-run',
    async (_e, webviewId: number, scenario: string, rawTarget: unknown) => {
      if (typeof webviewId !== 'number') throw new Error('webviewId is required')
      const wc = webContents.fromId(webviewId)
      // The id comes from the renderer: accept only a live <webview> guest —
      // handing the driver any other surface (the Deck window itself) would
      // let input events land on the app chrome.
      if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') {
        throw new Error('embedded browser webview not found')
      }
      if (typeof scenario !== 'string' || !scenario.trim()) throw new Error('scenario is required')
      if (scenario.length > MAX_SCENARIO_CHARS) {
        throw new Error(`scenario too long (max ${MAX_SCENARIO_CHARS} chars)`)
      }
      const target = sanitizeTarget(rawTarget, DEFAULT_DEMO_TARGET)
      if (target.cli !== 'claude') {
        throw new Error('only claude targets can run demo scenarios (the browser bridge rides --mcp-config)')
      }
      if (demoRunning()) throw new Error('a demo scenario is already running')
      const pluginDir = deckPluginDir()
      const mcpScript = join(pluginDir, 'mcp', 'demo-browser-mcp.mjs')
      if (!pluginDir || !existsSync(mcpScript)) {
        throw new Error('demo-browser MCP script missing -- run `npm run build:mcp`')
      }
      const stateDir = join(app.getPath('userData'), APP_STATE_SUBDIR)
      const control = await startDemoControl(createBrowserDriver(wc))
      try {
        const mcpConfigPath = writeDemoMcpConfig({
          dir: stateDir,
          mcpScriptPath: mcpScript,
          execPath: process.execPath,
          controlUrl: control.url,
          controlToken: control.token
        })
        const systemPromptFile = writeDemoSystemPrompt(stateDir)
        const scenarioFile = writeDemoScenarioFile(stateDir, scenario.trim())
        const command = buildDemoCommand({
          scenarioFile,
          systemPromptFile,
          mcpConfigPath,
          model: target.model
        })
        markProviderUsed(target.cli) // feed the amphora gauge
        return await runDemoCommand({
          command,
          shell: getConfig().shell,
          cwd: getConfig().projectDir
        })
      } finally {
        control.close()
      }
    }
  )

  regHandle('browser:demo-cancel', () => cancelDemoRun())

  // ----- sandbox mode (PLAN-SANDBOX SBX2–SBX5, M2/M3) -----
  regHandle('sandbox:status', (_e, force?: boolean) => sandbox.status(!!force))
  // The settings guard (SBX2): main-side, not just UI — changing WHERE agents
  // execute while agents run would strand live PTYs across the boundary.
  regHandle('sandbox:patch-settings', (_e, patch: SandboxSettingsPatch) => {
    if (service.hasLiveSessions()) throw new Error('sandbox-live-sessions')
    return sandbox.patchSettings(patch ?? {})
  })
  regHandle('sandbox:set-image', (_e, image: string) => {
    if (service.hasLiveSessions()) throw new Error('sandbox-live-sessions')
    sandbox.setImage(typeof image === 'string' ? image : '')
    return sandbox.status(true)
  })
  regHandle('sandbox:ensure', () => sandbox.ensure())
  // Explicit, scheme-gated external open. Preferred over window.open + the
  // window-open handler: the renderer states its intent, main decides, and a
  // refusal is a visible error instead of the OS being asked to find an app
  // for `about:` (which is what an unvalidated window.open produced).
  regHandle('shell:open-external', (_e, url: string) => {
    const safe = safeExternalUrl(url)
    if (!safe) throw new Error('only http(s) links can be opened externally')
    return shell.openExternal(safe)
  })
  // Image build in a utility PTY: a long, log-heavy job belongs in a terminal
  // the operator can read, not behind a spinner. `variant` is re-validated
  // main-side (enum, defaulting to base): 'custom' builds the operator's
  // fragment on top of the base image (f29b1917).
  regHandle('sandbox:image-build', (_e, variant?: string) => {
    const custom = variant === 'custom'
    const cfg = getConfig()
    service.spawnUtility(SANDBOX_BUILD_PTY_ID, cfg.projectDir, {
      command: custom ? sandbox.customBuildCommand() : sandbox.imageBuildCommand(),
      shell: cfg.shell,
      interactive: false
    })
    journal.add('session', `sandbox: ${custom ? 'custom ' : ''}image build started`)
    return SANDBOX_BUILD_PTY_ID
  })
  // Operator's Dockerfile fragment (app-state). Saving decides what runs in
  // every sandbox container, hence the trust-changing tier in companion.ts.
  regHandle('sandbox:custom-get', () => sandbox.customFragment())
  regHandle('sandbox:custom-save', (_e, fragment: string) => {
    sandbox.saveCustomFragment(typeof fragment === 'string' ? fragment : '')
  })
  // Overlay generation (50ac8683): host settings.json minus host-only hooks,
  // written to ~/.claude/sandbox-overrides/. `force` is the renderer-confirmed
  // overwrite of an existing overlay — never implicit.
  regHandle('sandbox:overlay-generate', (_e, force?: boolean) =>
    sandbox.generateOverlay(force === true)
  )
  // Projection opt-out: scrubs ~/.claude inside the container. Same guard as
  // the other lifecycle actions -- a live agent is USING that config.
  regHandle('sandbox:projection-remove', () => {
    if (service.hasLiveSessions()) throw new Error('sandbox-live-sessions')
    return sandbox.removeProjection()
  })
  regHandle('sandbox:build-stop', () => service.killUtility(SANDBOX_BUILD_PTY_ID))
  regHandle('sandbox:image-remove', () => {
    // Same guard as the rest of the sandbox lifecycle: an agent mid-task is
    // running FROM this image.
    if (service.hasLiveSessions()) throw new Error('sandbox-live-sessions')
    return sandbox.removeImage()
  })
  regHandle('sandbox:auth-purge', () => {
    // Guard on LIVE SESSIONS, not on a running container: the wipe targets the
    // app-wide credentials volume from a throwaway container, so this project's
    // container state is irrelevant. What must not happen is disconnecting
    // under a working agent.
    if (service.hasLiveSessions()) throw new Error('sandbox-live-sessions')
    return sandbox.purgeAuth()
  })
  regHandle('sandbox:reset-copy', () => {
    if (service.hasLiveSessions()) throw new Error('sandbox-live-sessions')
    return sandbox.resetCopy()
  })
  regHandle('sandbox:probe-bridge', () => sandbox.probeBrokerBridge())
  regHandle('sandbox:list', () => sandbox.list())
  regHandle('sandbox:container-action', async (_e, name: string, action: SandboxContainerAction) => {
    // Guard the CURRENT project's container while sessions run in it; the
    // name itself is re-validated (shape + kory.sandbox label) inside the
    // service before it ever reaches the engine CLI (hostile input #3).
    if (name === sandbox.containerName && action !== 'start' && service.hasLiveSessions()) {
      throw new Error('sandbox-live-sessions')
    }
    await sandbox.containerAction(name, action)
  })
  // First-run login (SBX3): provision ONLY what the login needs (engine, the
  // app-wide image, the credentials volume) and open the auth terminal on the
  // reserved utility PTY. Deliberately not `ensure()`: signing in is app-wide
  // and must not require this project's container to exist. Returns null when
  // already authenticated so the dialog short-circuits to its success state.
  regHandle('sandbox:auth-start', async () => {
    const st = await sandbox.ensureAuthPrereqs()
    if (!st.engine || st.imagePresent !== true) {
      throw new Error(st.error || 'sandbox image not ready')
    }
    if (st.authed === true) return null
    const cfg = getConfig()
    service.spawnUtility(SANDBOX_AUTH_PTY_ID, cfg.projectDir, {
      command: buildAuthCommand(st.engine, sandbox.image()),
      shell: cfg.shell,
      interactive: false
    })
    journal.add('session', 'sandbox: login terminal opened')
    return SANDBOX_AUTH_PTY_ID
  })
  regHandle('sandbox:auth-stop', () => service.killUtility(SANDBOX_AUTH_PTY_ID))
  // Post-build warm-up: create + project the container while the operator is
  // still looking at the build card, so the first agent spawn skips the ~10 s
  // projection. Fire-and-forget — the renderer must not wait on it.
  regHandle('sandbox:warm-up', () => {
    void sandbox.warmUp().catch((e) => reportError('sandbox', 'warm-up failed', e))
  })
  // Forced re-probe: the dialog polls this while the login terminal is up, so
  // it must bypass the status cache to see the credentials land.
  regHandle('sandbox:auth-probe', () => {
    sandbox.invalidateAuth()
    return sandbox.probeAuth()
  })

  // ----- config -----
  // The renderer never sees provider secrets: localProviders are sanitized to
  // a `hasKey` marker (C29). setConfig (index.ts) does the mirror encryption,
  // and returns the sanitized echo for the same reason.
  regHandle('config:get', () => ({
    ...getConfig(),
    localProviders: sanitizeProviders(getConfig().localProviders ?? [])
  }))
  regHandle('config:set', (_e, patch: Partial<AppConfig>) => ({
    ...setConfig(patch ?? {}),
    localProviders: sanitizeProviders(getConfig().localProviders ?? [])
  }))
  regHandle('dialog:pickDirectory', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getConfig().projectDir
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // ----- i18n -----
  regHandle('i18n:get', () => buildI18n(getConfig()))

  // ----- workspaces (persistence / restore) -----
  regHandle('workspace:list', () => workspaces.listForCwd())
  regHandle('workspace:save', (_e, name?: string) =>
    name && name.trim() ? workspaces.saveNamed(name) : workspaces.saveAuto()
  )
  regHandle('workspace:restore', async (_e, id: string) => {
    // Restore respawns straight through SessionService (no create gate), so
    // the container-side transcript cache must be warm here or every restored
    // tile would look "expired" and start fresh (PLAN-SANDBOX M2).
    if (sandbox.isEnabled()) {
      await sandbox.ensure()
      // Warm EVERY cwd the workspace will respawn into, not just the root:
      // worktree sessions live elsewhere and would otherwise all start fresh.
      for (const cwd of workspaces.sessionCwds(id)) await sandbox.refreshTranscripts(cwd)
    }
    // Card 07134c6a: workspaces.restore(id) now returns a discriminated
    // WorkspaceRestoreResult naming WHICH of six real causes fired, not a
    // bare boolean. workspaceRestoreOrThrow (shared/workspace-restore-
    // outcome.ts) is this handler's ONLY source of the outcome it returns --
    // it throws for 'lock-race' (the one reason the operator does not
    // already know, since their sessions were already swapped) and resolves
    // quietly for every other reason, carrying WHICH one through so store.ts
    // can pick the right toast instead of guessing.
    // Card 64f8f629: same isLocalIpcEvent-derived attendance as template:apply
    // above -- see its own doc for why an unrecognized event falls closed to
    // 'unattended'.
    const attendance: CallerAttendance = isLocalIpcEvent(_e) ? 'attended' : 'unattended'
    const result = workspaces.restore(id, attendance)
    const announceCurrent = (): void => {
      const current = workspaces.listForCwd().find((w) => w.current) ?? null
      broadcast('workspace:current', current)
    }
    // Card 07134c6a, review correction C2: 'lock-race' is the ONE non-ok
    // reason where sessions were ALREADY swapped (restoreFrom() already ran)
    // before the failure -- unlike every other reason (nothing moved), the
    // window's current-workspace state and the inbox must still reflect
    // that change even though workspaceRestoreOrThrow below is about to
    // throw an error to the caller. Checked on the RAW result (not by
    // catching the throw) so this only fires for the one reason actually
    // known to have changed state, never for a future unrecognised reason.
    if (!result.ok && result.reason === 'lock-race') {
      announceCurrent()
      void purgeInboxSession()
    }
    const outcome = workspaceRestoreOrThrow(result)
    if (outcome.applied) {
      announceCurrent()
      // Courrier lot 1D: only a SUCCESSFUL restore counts as "this session
      // starts over" -- a failed restore (applied===false) changed nothing
      // for every OTHER reason, so it must not purge either (see the
      // 'lock-race' exception handled above, before this point).
      void purgeInboxSession()
    }
    return outcome
  })
  regHandle('workspace:delete', (_e, id: string) => workspaces.deleteWs(id))
  regHandle('workspace:current', () => workspaces.currentWorkspaceId)

  // ----- announce (outbound megaphone) -----
  regHandle('announce:send', (_e, text: string) => announce(text ?? ''))

  // ----- roadmap (shared per-project backlog, PLAN C3) -----
  // Endpoint + project key are resolved per call: cheap (config file read + one
  // git exec) and always consistent with the current projectDir. Operator
  // writes are stamped by='deck' inside roadmap-service.
  const roadmapCtx = (): { endpoint: ReturnType<typeof resolveBrokerEndpoint>; key: string } => ({
    endpoint: resolveBrokerEndpoint(),
    key: computeDeckProjectKey(getConfig().projectDir)
  })
  regHandle('roadmap:list', (_e, filters: RoadmapListFilters) => {
    const { endpoint, key } = roadmapCtx()
    return listRoadmap(endpoint, key, filters ?? {})
  })
  regHandle('roadmap:search', (_e, query: RoadmapQuery) => {
    const { endpoint, key } = roadmapCtx()
    return searchRoadmap(endpoint, key, query ?? {})
  })
  regHandle('roadmap:upsert', (_e, fields: RoadmapUpsertFields) => {
    const { endpoint, key } = roadmapCtx()
    return upsertRoadmap(endpoint, key, fields ?? {})
  })
  regHandle('roadmap:archive', (_e, id: string) => {
    const { endpoint } = roadmapCtx()
    return archiveRoadmap(endpoint, id)
  })
  // Workflow lane: atomic queue rewrite (insert/reorder in the middle without
  // N racy per-item upserts). ids come from the renderer's derived lane order.
  // `waves` (roadmap card 42edc88b phase 1) is optional and re-validated here
  // -- this channel is companion/MCP-exposed at tier 1, and a tier is a
  // declaration, not an access gate, so a malformed nested array must never
  // reach the broker.
  regHandle('roadmap:reorder', (_e, ids: string[], waves?: string[][]) => {
    const { endpoint, key } = roadmapCtx()
    const cleanIds = Array.isArray(ids) ? ids : []
    if (waves === undefined) return reorderRoadmap(endpoint, key, cleanIds)
    const validated = validateReorderWaves(cleanIds, waves)
    if (!validated.ok) throw new Error(validated.error)
    return reorderRoadmap(endpoint, key, cleanIds, validated.waves)
  })
  // Queue dispatch (PLAN C15): first queued item -> targeted announce to the
  // team-lead. The renderer greys the button when no lead is designated.
  regHandle('roadmap:dispatch', () => dispatchNext())
  // Operator stop (PLAN K3): notify the agents, release the lock.
  regHandle('roadmap:stop', (_e, id: string) => stopRoadmapItem(id))
  // Direct assignment (PLAN K6): "process now" on one chosen live peer.
  regHandle('roadmap:assign', (_e, id: string, peerId: string) =>
    assignRoadmapItem(id, peerId)
  )
  // Utility-inference deps (lot A): the help/wand/digest flows share one
  // routing (utility-inference.ts) over the configured targets. Local-provider
  // keys are decrypted in memory here only, like graph:infer.
  // PTY-backed runner for the CLIs that misbehave without a TTY (antigravity).
  const runTty = (command: string): Promise<string> =>
    runPtyCommand({
      command,
      shell: getConfig().shell,
      cwd: getConfig().projectDir,
      timeoutMs: GRAPH_INFER_TIMEOUT_MS
    })

  const utilityDeps = (): UtilityDeps => ({
    stateDir: join(app.getPath('userData'), APP_STATE_SUBDIR),
    shell: getConfig().shell,
    cwd: getConfig().projectDir,
    localProviders: decryptProviders(getConfig().localProviders ?? [], secretCipher),
    runTty
  })

  // Context wand (PLAN C21): one read-only inference (config.wandTarget,
  // haiku default) drafts the item's context field grounded in the project
  // files. The result only fills the editor textarea -- saving stays an
  // explicit operator action.
  regHandle('roadmap:wand', (_e, draft: WandDraft) =>
    runUtilityInference(utilityDeps(), {
      target: getConfig().wandTarget,
      system: WAND_SYSTEM_PROMPT,
      prompt: buildWandPrompt(
        draft ?? { title: '', kind: '', description: '', rationale: '', context: '' }
      ),
      kind: 'wand'
    })
  )

  // ----- worktrees (PLAN C4/C6) -----
  regHandle('worktree:remove', async (_e, path: string) => {
    await removeWorktree(getConfig().projectDir, path)
    journal.add('worktree', `worktree removed: ${path}`)
  })
  regHandle('worktree:list', async () => {
    const worktrees = await listWorktrees(getConfig().projectDir)
    const sessions = service.list().filter((s) => s.status !== 'exited')
    return Promise.all(
      worktrees.map(async (w) => {
        const status = await worktreeStatus(w.path)
        // Both sides canonical: a session spawned in the MAIN tree carries the
        // projectDir as cwd, which can be the symlinked form (macOS /var) while
        // git reports the real one — comparing raw would drop the attachment.
        const attached = sessions.find(
          (s) => s.worktree?.path === w.path || canonicalPath(s.cwd) === w.path
        )
        return {
          ...w,
          ...status,
          sessionId: attached?.id ?? null,
          sessionName: attached?.name ?? null
        }
      })
    )
  })
  regHandle('worktree:create', async (_e, branch: string) => {
    const wt = await createWorktree(getConfig().projectDir, branch ?? '')
    const init = getWorktreeInit()
    if (init) runWorktreeInit(wt.path, init)
    journal.add('worktree', `worktree created on ⎇ ${wt.branch}`)
  })

  // ----- working-dir allow-set (PLAN GX5 + M-SEC): the ONLY dirs the
  // read-only Git/Files views may touch — the project dir, its worktrees and
  // the cwd of any Deck session. Recomputed and re-validated on EVERY call so
  // a renderer/companion `dir`/`root` argument can never reach an arbitrary
  // path (e.g. /etc via the diff --no-index content dump). Both the diff
  // handlers and the explorer handlers route their path argument through it.
  // Short-TTL memo of the raw worktree list: within one poll tick the diff
  // and explorer handlers ask for it several times (requireWorkDir, diffBase,
  // per-node explorer:list), and each call is a git subprocess. 1.5 s is well
  // under the views' 10 s/30 s polls; a just-added worktree is briefly absent
  // from the allow-set, which fails CLOSED (safe). Never caches sessions —
  // those come live from service.list().
  let wtMemo: { at: number; key: string; rows: Awaited<ReturnType<typeof listWorktrees>> } | null =
    null
  const WT_MEMO_MS = 1500
  const cachedWorktrees = async (): Promise<Awaited<ReturnType<typeof listWorktrees>>> => {
    const key = getConfig().projectDir
    const now = Date.now()
    if (wtMemo && wtMemo.key === key && now - wtMemo.at < WT_MEMO_MS) return wtMemo.rows
    const rows = await listWorktrees(key)
    wtMemo = { at: now, key, rows }
    return rows
  }

  const workDirRoots = async (): Promise<
    { path: string; label: string; main: boolean }[]
  > => {
    const roots = new Map<string, { path: string; label: string; main: boolean }>()
    const add = (path: string, label: string, main = false): void => {
      const p = resolvePath(path)
      if (!roots.has(p)) roots.set(p, { path: p, label, main })
    }
    try {
      for (const w of await cachedWorktrees()) {
        add(w.path, `⎇ ${w.branch ?? w.path}`, w.main)
      }
    } catch {
      // Not a git repo: the project dir alone is the root (equivalent fallback).
    }
    add(getConfig().projectDir, getConfig().projectDir, roots.size === 0)
    // All sessions (exited included): diffing/browsing a finished session's
    // dir is legitimate, and an exited tile's cwd is still a Deck-managed dir.
    for (const s of service.list()) add(s.cwd, s.name)
    return [...roots.values()]
  }
  const requireWorkDir = async (dir: unknown): Promise<string> => {
    const p = resolvePath(typeof dir === 'string' ? dir : '')
    if (!(await workDirRoots()).some((r) => r.path === p)) {
      throw new Error('dir not allowed')
    }
    return p
  }

  // ----- diff / review (PLAN C13) -----
  // Base resolution: a NON-MAIN worktree of the project is compared to the
  // main worktree's branch (merge-base); anything else (main tree, foreign
  // cwd) gets uncommitted-only. Never guessed from config.
  const diffBase = async (dir: string): Promise<string | null> => {
    try {
      const all = await cachedWorktrees()
      const main = all.find((w) => w.main)
      const target = all.find((w) => w.path === resolvePath(dir))
      if (!main?.branch || !target || target.main) return null
      return main.branch
    } catch {
      return null
    }
  }
  // `dir` is re-validated against the work-dir allow-set on every call: it
  // crosses the renderer/companion boundary and otherwise feeds an arbitrary
  // path to git (the --no-index fallback would dump any readable file).
  regHandle('diff:collect', async (_e, dir: string) => {
    const d = await requireWorkDir(dir)
    return collectDiff(d, await diffBase(d))
  })
  // Per-file diff (PLAN GX2). `dir` validated as above; collectFileDiff also
  // rejects a `path` escaping `dir` (lexical + realpath, see diff-service).
  regHandle('diff:collect-file', async (_e, dir: string, path: string) => {
    const d = await requireWorkDir(dir)
    return collectFileDiff(d, path, await diffBase(d))
  })
  // One-shot review agent (C7 pattern, code-constant prompt): reads the diff
  // in place and reports to the team-lead peer (C10) when one is live. `dir`
  // becomes the spawned agent's cwd, so it is validated against the allow-set
  // too (an arbitrary cwd would be worse than the read paths above).
  regHandle('diff:review', async (_e, dir: string) => {
    const d = await requireWorkDir(dir)
    const lead =
      service.list().find((s) => s.lead && s.status !== 'exited' && s.peerId)?.peerId ?? null
    await createSessionWithWorktree(
      service,
      getConfig().projectDir,
      {
        name: 'reviewer',
        cwd: d,
        prompt: composeDiffReviewPrompt({ dir: d, base: await diffBase(d), leadPeerId: lead }),
        announce: `one-shot reviewer: reviews the diff in "${d}"`
      },
      checkpoint
    )
    journal.add('review', `review agent spawned on ${d}${lead ? ` (reports to ${lead})` : ''}`)
    return true
  })

  // ----- file explorer (PLAN GX5): READ-ONLY -----
  // Shares the work-dir allow-set with the diff handlers (workDirRoots): the
  // renderer/companion can only ever browse under the project dir, the
  // worktrees, or a session cwd — never an arbitrary path. resolveWithin adds
  // realpath containment inside the chosen root (symlink escapes rejected).
  const explorerRoot = async (root: unknown): Promise<string> => {
    const p = resolvePath(typeof root === 'string' ? root : '')
    if (!(await workDirRoots()).some((r) => r.path === p)) {
      throw new Error('explorer: root not allowed')
    }
    return p
  }
  regHandle('explorer:roots', () => workDirRoots())
  regHandle('explorer:list', async (_e, root: string, rel: string) =>
    listExplorerDir(await explorerRoot(root), typeof rel === 'string' ? rel : '')
  )
  regHandle('explorer:read', async (_e, root: string, rel: string) =>
    readExplorerFile(await explorerRoot(root), typeof rel === 'string' ? rel : '')
  )

  // ----- activity journal (PLAN C14) -----
  regHandle('journal:list', (_e, kind?: string | null) =>
    journal.list((kind as JournalKind) || null)
  )
  // Plain-text export via a save dialog; returns the written path or null.
  regHandle('journal:export', async () => {
    const win = getWindow()
    const res = await dialog.showSaveDialog(win ?? undefined!, {
      defaultPath: join(getConfig().projectDir, 'deck-journal.txt'),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    })
    if (res.canceled || !res.filePath) return null
    try {
      writeFileSync(res.filePath, journal.toText() + '\n', 'utf-8')
    } catch (e) {
      reportError('journal', `export to ${res.filePath} failed`, e)
      return null
    }
    return res.filePath
  })

  // ----- broker reachability (PLAN O5) -----
  regHandle('broker:status', () => brokerStatus())
  regHandle('broker:retry', () => brokerRetry())

  // ----- renderer error reporting (PLAN O4) -----
  // ErrorBoundaries and the window-level error/unhandledrejection handlers
  // forward here so renderer failures reach main.log + the journal.
  regOn('app:report-error', (_e, scope: unknown, message: unknown) => {
    reportError(
      typeof scope === 'string' ? `renderer:${scope}` : 'renderer',
      typeof message === 'string' ? message.slice(0, 2000) : String(message)
    )
  })

  // ----- supervisor (PLAN C5) -----
  regHandle('supervisor:ensure', () => ensureSupervisor())

  // ----- plan import (PLAN C7) -----
  // File picker + one-shot import agent (code-constant prompt). Returns true
  // when an agent was spawned, false when the picker was cancelled.
  regHandle('roadmap:import-plan', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      defaultPath: getConfig().projectDir,
      filters: [
        { name: 'Plans', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const file = res.canceled ? null : (res.filePaths[0] ?? null)
    if (!file) return false
    await createSessionWithWorktree(
      service,
      getConfig().projectDir,
      {
        name: 'plan-import',
        prompt: composePlanImportPrompt(file),
        announce: `one-shot agent: imports plan "${file}" into the shared roadmap`
      },
      checkpoint
    )
    return true
  })

  // ----- multi-tile stop broadcast (card aaf4537d, lot 3) -----
  regHandle('agents:stop', async (_e, arg: { mode?: unknown; peerIds?: unknown }) => {
    const mode = arg?.mode
    // Allow-list, not an if/else that falls through to the most destructive
    // branch: an unknown mode (stale renderer build, fuzzed companion
    // payload) is refused before dispatch, never coerced to 'hard'.
    if (!STOP_MODES.includes(mode as StopMode)) {
      throw new Error(`agents:stop: unknown mode "${String(mode)}"`)
    }
    const stopMode = mode as StopMode
    // Renderer-supplied array, re-validated main-side (five hostile inputs,
    // #4): shape only here (array of non-empty strings) -- the empty-array
    // "never means everyone" business rule lives once, in broadcastStop.
    let peerIds: string[] | undefined
    if (arg?.peerIds !== undefined) {
      const raw = arg.peerIds
      if (!Array.isArray(raw) || !raw.every((p): p is string => typeof p === 'string' && p.length > 0)) {
        throw new Error('agents:stop: peerIds must be an array of non-empty strings when provided')
      }
      peerIds = raw
    }
    const { outcomes, missing } = await broadcastStop(
      stopMode,
      {
        list: () => service.list(),
        interrupt: (id, mode) => service.interrupt(id, toInterruptMode(mode)),
        injectCommand: (id, command) => service.injectCommand(id, command, STOP_IDLE_WAIT_MS),
        journal: (line) => journal.add('dispatch', line)
      },
      peerIds
    )
    const report: StopReport = { mode: stopMode, outcomes, locks: {} }
    if (missing.length > 0) report.missing = missing
    if (stopTouchesLocks(stopMode)) {
      // Derived from `outcomes` (what was actually dispatched to), never from
      // a fresh service.list() -- see lockTargets's doc comment (review round,
      // correction 1/2/3).
      const targetPeerIds = lockTargets(outcomes)
      if (targetPeerIds.length > 0) {
        try {
          const { endpoint, key } = roadmapCtx()
          const result = await (stopMode === 'pause'
            ? lockPark(endpoint, key, targetPeerIds)
            : lockRelease(endpoint, key, targetPeerIds))
          if (stopMode === 'pause') report.locks.parked = result.parked.length
          else report.locks.released = result.released.length
          // `failed` was parsed and never surfaced (correction 5b): a partial
          // lock-park silently reported only the successes.
          if (result.failed.length > 0) {
            report.locks.error = `${result.failed.length} peer(s) failed: ${result.failed.join(', ')}`
          }
        } catch (e) {
          // Round-4 mutation review (card aaf4537d): a foreign-owned park is
          // NOT a throw cause -- the route still answers 200 with that
          // peer_id in `result.failed`, handled a few lines above, never an
          // exception. What actually lands here: a network error, or a
          // 401/403/400 from the route itself (unregistered reserved
          // identity, missing operator proof, an over-cap batch). Report it,
          // never let it block the stop primitive itself.
          const msg = e instanceof Error ? e.message : String(e)
          report.locks.error = msg
          reportError('dispatch', `agents:stop ${stopMode}: lock call failed`, e)
        }
      } else {
        // NIT (correction 5c): explicit 0, not `{}` -- otherwise indistinguishable
        // from soft stop's intentionally-untouched lock table.
        if (stopMode === 'pause') report.locks.parked = 0
        else report.locks.released = 0
      }
    }
    return report
  })
  regHandle('agents:stop-state', () => {
    const tiles = service.list()
    const live = tiles.filter((r) => r.status !== 'exited')
    // Card f8082208: counted separately, never folded into idle (nor into
    // busy) -- see docs/DESIGN-ACTIVITY-PREDICATE.md section 5.
    const busy = live.filter((r) => r.activity === 'working')
    const unknown = live.filter((r) => r.activity === 'unknown')
    // paused and parkedCards stay hardcoded 0: computing them needs a roadmap
    // read scoped to this project's live peerIds, which this handler doesn't
    // have. Deliberately an honest 'not computed' rather than a fabricated
    // count.
    return { live: live.length, busy: busy.length, unknown: unknown.length, paused: 0, parkedCards: 0 }
  })

  // ----- help assistant (PLAN C9) -----
  // One throwaway `claude -p` per question: no MCP (--strict-mcp-config), no
  // mutating tools. The assistant does NOT need tools to know the app state:
  // the snapshot below is composed by the app (same broker/git reads the views
  // use) and injected into the system prompt. It covers ALL views, not just
  // the active one, so a roadmap question asked from the Agents view is still
  // grounded; each part degrades to an error note instead of failing the call.
  const helpSnapshot = async (): Promise<unknown> => {
    const part = async <T>(fn: () => T | Promise<T>): Promise<T | { error: string }> => {
      try {
        return await fn()
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    const [roadmap, worktrees] = await Promise.all([
      part(async () => {
        const { endpoint, key } = roadmapCtx()
        const items = await listRoadmap(endpoint, key, {})
        return items.map((i) => ({
          id: i.id.slice(0, 8),
          title: i.title,
          kind: i.kind,
          priority: i.priority,
          value: i.value,
          effort: i.effort,
          status: i.status,
          tags: i.tags,
          description: i.description.slice(0, 300),
          context: i.context.slice(0, 300)
        }))
      }),
      part(() => listWorktrees(getConfig().projectDir))
    ])
    const sessions = await part(() =>
      service.list().map((s) => ({
        name: s.name,
        peer_id: s.peerId,
        status: s.status,
        activity: s.activity,
        rate_limited: s.rateLimited,
        cwd: s.cwd,
        worktree_branch: s.worktree?.branch ?? null,
        supervisor: !!s.supervisor
      }))
    )
    return { roadmap_items: roadmap, sessions, git_worktrees: worktrees }
  }
  regHandle(
    'help:ask',
    async (_e, question: string, view: string, transcript: HelpExchange[], selection?: unknown) => {
      const docsDir = resolveDocsDir()
      // Files-view selection (PLAN GX7): rides the SYSTEM side (context file),
      // so the code never touches the command line / its arg cap.
      const sel = sanitizeHelpSelection(selection)
      const data = {
        ...((await helpSnapshot()) as Record<string, unknown>),
        ...(sel ? { code_selection: sel } : null)
      }
      return runUtilityInference(utilityDeps(), {
        target: getConfig().helpTarget,
        system: buildHelpSystemPrompt({ view, data, docsDir }),
        prompt: buildHelpPrompt(question ?? '', transcript ?? []),
        kind: 'help',
        addDir: docsDir || undefined
      })
    }
  )

  // ----- resume digest (PLAN C17) -----
  // Same read-only `claude -p` harness as help:ask, with the app snapshot PLUS
  // the configured project sources. Sources come from the GLOBAL config only
  // (readDigestConfig has no projectDir input by design — a repo-carried
  // command list would execute arbitrary code on clone); commands still run
  // with cwd = projectDir so generic sources adapt per project.
  regHandle('help:digest', async () => {
    const projectDir = getConfig().projectDir
    const cfg = readDigestConfig()
    const { key } = roadmapCtx()
    const sources = await collectSources(sourcesForProject(cfg, key), projectDir)
    return runUtilityInference(utilityDeps(), {
      target: getConfig().helpTarget,
      system: buildDigestSystemPrompt({
        locale: resolveLocale(getConfig().locale, app.getLocale()),
        data: await helpSnapshot(),
        sources
      }),
      prompt: DIGEST_PROMPT,
      kind: 'digest'
    })
  })

  // ----- create-menu data -----
  regHandle('agents:list', () => listAgents(getConfig().projectDir))
  regHandle('launch:get', () => resolveLaunchConfig(getConfig().projectDir))
  regHandle('launch:set-global', (_e, cfg: LaunchConfig) => saveGlobalConfig(cfg))

  // ----- templates (portable team recipes) -----
  regHandle('template:list', () => listTemplates(getConfig().projectDir))
  regHandle('template:export', (_e, name: string, local: boolean) => {
    // captureSessions() carries cwd; toTemplate strips it (and id/sessionId).
    const tpl = toTemplate(service.captureSessions(), name)
    const dir = local ? localTemplatesDir(getConfig().projectDir) : globalTemplatesDir()
    return writeTemplate(dir, name || tpl.name || 'template', tpl)
  })
  regHandle('template:delete', (_e, path: string) =>
    deleteTemplate(path, getConfig().projectDir)
  )
  regHandle('template:apply', async (_e, path: string, mode: 'append' | 'replace') => {
    // Containment + repo-local shell-field approval (B4 + M-SEC-9). Card
    // 96c98453, review correction C3: templateInputsOrThrow
    // (shared/template-apply-outcome.ts) is this handler's ONLY source of
    // `TemplateInput[]` -- there is no other `inputs` in scope, so a
    // mutation cannot silently "compute the decision, then return a count
    // anyway" for a real anomaly the way an earlier draft (a returned
    // throw/return-null descriptor this handler had to act on) could. The
    // same module also holds store.ts's half of this contract (whether to
    // show the success toast) and deck-control.ts's (the agent route's
    // empty-batch mapping), kept together so the three sinks cannot drift
    // apart from each other and let a refusal read as success again.
    // Card 64f8f629: `attendance` defaults to 'unattended' for anything
    // isLocalIpcEvent does not positively recognize as the real window's
    // own ipcMain event -- a companion call (REMOTE_EVENT) or any future
    // unrecognized caller must never be read as an attended operator.
    const attendance: CallerAttendance = isLocalIpcEvent(_e) ? 'attended' : 'unattended'
    const resolved = resolveTemplateInputs(path, attendance)
    const inputs = templateInputsOrThrow(resolved, path)
    if (inputs === null) return null
    // One checkpoint covers the batch: every session spawns in the project dir.
    if (inputs.length > 0) await checkpoint(getConfig().projectDir)
    if (mode === 'replace') {
      // Detach + auto-save the current workspace, then clear (mirrors New clear).
      workspaces.startNew()
      service.closeAll()
      broadcast('workspace:current', null)
      // Courrier lot 1D: this branch mirrors app:new-clear verbatim (comment
      // above), so it purges the same way -- the fifth path the design doc
      // names explicitly (measured: absent from the original three-gesture
      // enumeration, but it does the same startNew()+closeAll()).
      void purgeInboxSession()
    }
    // The template's lead becomes the window's ONLY when no lead exists yet
    // (PLAN C18) — applying a team must not silently steal the crown.
    const hasLead = service.list().some((s) => s.lead && s.status !== 'exited')
    // Each peer spawns in this window's current project dir + group (no cwd in
    // the template); order is preserved by creation order. Routed through the
    // worktree-aware path so composer templates with worktreeBranch work.
    for (const input of inputs) {
      await createSessionWithWorktree(
        service,
        getConfig().projectDir,
        hasLead ? { ...input, lead: undefined } : input,
        undefined,
        getWorktreeInit()
      )
    }
    return inputs.length
  })

  // ----- snippets (reusable prompts, PLAN C22) -----
  // Fill-not-send: the renderer pastes the text into a session's input field;
  // the main process only stores/lists .md files (project > global scope).
  regHandle('snippet:list', () => listSnippets(getConfig().projectDir))
  regHandle('snippet:save', (_e, name: string, local: boolean, text: string) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('snippet name is required')
    if (typeof text !== 'string' || !text.trim()) throw new Error('snippet text is required')
    const dir = local ? localSnippetsDir(getConfig().projectDir) : globalSnippetsDir()
    return writeSnippet(dir, name, text)
  })
  regHandle('snippet:delete', (_e, path: string) =>
    deleteSnippet(path, getConfig().projectDir)
  )

  // ----- graph chat (EXPLORATION-graph-chat C23-C27) -----
  // Desktop-local per-project persistence (D7), encrypted at rest via the
  // safeStorage-backed cipher (K8); inference = stateless headless fan-out
  // (D1), context recompiled from the graph on every call.
  const graphCtx = (): { stateDir: string; key: string } => ({
    stateDir: join(app.getPath('userData'), APP_STATE_SUBDIR),
    key: computeDeckProjectKey(getConfig().projectDir)
  })
  // Model catalogs for the pickers (C29): frontier CLIs detected through the
  // login shell (cached for the app run), local endpoints discovered live.
  // Keys are decrypted in memory here only — the catalog sent back carries none.
  regHandle('models:catalog', (_e, refresh?: boolean) =>
    getCatalogs(
      decryptProviders(getConfig().localProviders ?? [], secretCipher),
      getConfig().shell,
      { refresh: !!refresh }
    )
  )

  // Usage modal: quota gauges of the detected CLIs. No renderer-controlled
  // paths/commands cross this boundary (fixed binaries, fixed endpoints) and
  // the reports carry percentages only — tokens never leave usage-service.
  regHandle('usage:read', (_e, refresh?: boolean) =>
    readUsage(
      {
        shell: getConfig().shell,
        // Live tiles draw on the Claude subscription (multi-CLI tiles are a
        // deferred lot — revisit the hardcoded 'claude' with it).
        liveClis: () =>
          service.list().some((s) => s.status !== 'exited') ? ['claude'] : []
      },
      { refresh: !!refresh }
    )
  )

  regHandle('graph:list', () => {
    const { stateDir, key } = graphCtx()
    // Opportunistic K8 migration: a pre-encryption clear file is rewritten
    // encrypted the first time the view lists it (cheap no-op afterwards).
    migrateGraphsAtRest(stateDir, key, secretCipher)
    return loadGraphs(stateDir, key, secretCipher)
  })
  regHandle('graph:create', (_e, name: string) => {
    const { stateDir, key } = graphCtx()
    const doc: GraphDoc = {
      id: graphDocId(),
      name: (typeof name === 'string' && name.trim()) || 'graph',
      nodes: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    return upsertGraph(stateDir, key, doc, secretCipher)
  })
  regHandle('graph:delete', (_e, id: string) => {
    const { stateDir, key } = graphCtx()
    return deleteGraph(stateDir, key, id, secretCipher)
  })
  regHandle('graph:save', (_e, raw: unknown) => {
    const doc = parseGraphDoc(raw)
    if (!doc) return null
    const { stateDir, key } = graphCtx()
    return upsertGraph(stateDir, key, doc, secretCipher)
  })
  regHandle('graph:compile', (_e, graphId: string, nodeId: string) => {
    const { stateDir, key } = graphCtx()
    const doc = loadGraphs(stateDir, key, secretCipher).find((d) => d.id === graphId)
    if (!doc) throw new Error('unknown graph')
    return compileContext(doc, nodeId)
  })
  regHandle('graph:infer', async (_e, graphId: string, req: InferRequest) => {
    const { stateDir, key } = graphCtx()
    // Re-read from disk: the renderer may have saved node moves meanwhile.
    const doc = loadGraphs(stateDir, key, secretCipher).find((d) => d.id === graphId)
    if (!doc) throw new Error('unknown graph')
    const updated = await runInference(
      {
        stateDir,
        shell: getConfig().shell,
        cwd: getConfig().projectDir,
        localProviders: decryptProviders(getConfig().localProviders ?? [], secretCipher),
        runTty
      },
      doc,
      req ?? ({} as InferRequest)
    )
    journal.add('graph', `graph inference on ${req.nodeId} (${req.targets?.length ?? 0} target(s)${req.battle ? ', battle' : ''})`)
    return upsertGraph(stateDir, key, updated, secretCipher)
  })
  // Open a pending graph draft (operator click on the inbox card): create a
  // graph doc whose single user node carries the pre-filled prompt — nothing
  // is submitted, inference stays the manual circuit of the graph view.
  regHandle('graphDraft:open', async (_e, draft: DeckGraphDraft) => {
    if (!draft || typeof draft.id !== 'string' || typeof draft.prompt !== 'string') {
      throw new Error('invalid draft')
    }
    const { stateDir, key } = graphCtx()
    const nodeId = graphDocId()
    const doc: GraphDoc = {
      id: graphDocId(),
      name: (typeof draft.title === 'string' && draft.title.trim().slice(0, 200)) || 'question',
      nodes: [
        {
          id: nodeId,
          type: 'user',
          parents: [],
          text: draft.prompt.slice(0, 512 * 1024),
          x: 0,
          y: 0,
          createdAt: Date.now()
        }
      ],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    upsertGraph(stateDir, key, doc, secretCipher)
    // Broker flip is best-effort: opening must work even with the broker down
    // (worst case the draft reappears as pending and the operator re-opens it).
    try {
      await markGraphDraftOpened(draft.id, { endpoint: resolveBrokerEndpoint() })
    } catch {
      // next poll keeps it pending; the created doc stands either way
    }
    journal.add('graph', `graph draft opened: ${doc.name} (from ${draft.from || '?'})`)
    return { docId: doc.id, nodeId }
  })

  // Persisted operator-inbox history for startup hydration.
  // This file is the only durable copy of inbox history: even though the broker
  // drain (cursor by session_id) does not delete rows, session_id itself is
  // minted in-memory and never survives a restart, so the broker alone cannot
  // reconstruct history after one.
  regHandle('inbox:history', () =>
    loadInboxHistory(join(app.getPath('userData'), APP_STATE_SUBDIR))
  )
  regHandle('inbox:delete', (_e, rawIds: unknown) => {
    // Hostile IPC arg (renderer/companion input): checking Array.isArray
    // alone left the ELEMENTS unvalidated, so string-shaped ids used to
    // silently no-op both broker-side (deleted:0) and locally (Set
    // membership never matches). classifyInboxDeleteIds filters to integers
    // and separately reports the all-invalid-but-non-empty shape --
    // DECISION (team-lead ask, card 1e81ee7b hardening follow-up): main
    // answers that case itself (reject here) rather than forwarding an
    // emptied array that would race the broker's own separately-patched 400
    // for the same shape -- exactly one layer answers, not two silently
    // agreeing to a no-op. reportError is the LOG trace; the rejection is
    // the user-facing signal InboxPanel.tsx's deleteEntry() catch already
    // surfaces as a toast.
    const { valid, rejected } = classifyInboxDeleteIds(rawIds)
    if (rejected) {
      reportError('inbox', 'inbox:delete received only invalid (non-integer) ids', rawIds)
      return Promise.reject(new Error('inbox:delete: no valid ids'))
    }
    return inboxDelete(valid)
  })

  // ask_operator lot (Etape A): the unified Courrier actions. `id` /
  // `toPeerId` / `text` all originate in the renderer (hostile input #3) --
  // coerced to string here and re-validated broker-side by the resolve of
  // approvalReply/approvalDecline/approvalAllow/announceTo, which scope by
  // the CURRENT operator's own credential rather than trusting anything in
  // the payload.
  regHandle('approvals:reply', (_e, id: string, text: string) =>
    approvalReply(String(id ?? ''), String(text ?? ''))
  )
  regHandle('approvals:decline', (_e, id: string) => approvalDecline(String(id ?? '')))
  regHandle('approvals:allow', (_e, id: string) => approvalAllow(String(id ?? '')))
  regHandle('inbox:reply', (_e, toPeerId: string, text: string) =>
    announceTo(String(toPeerId ?? ''), String(text ?? ''))
  )

  // Local Courrier read-state (family 1/2 only -- see AckableInboxEntry).
  // `entry` is typed to exclude 'approval' at compile time; inboxEntryKey
  // (the SINGLE key producer, also importable by the renderer) re-validates
  // `kind` at runtime because the wire (structured-clone IPC) has no type
  // system of its own, so a hand-built payload bypassing TS could still
  // arrive shaped like an approval -- rejected there, never silently
  // coerced into a key.
  const ackedStateDir = (): string => join(app.getPath('userData'), APP_STATE_SUBDIR)
  regHandle('inbox:ack-state', () =>
    loadAckStateWithMigrationSeed(ackedStateDir(), (e) =>
      journal.add('error', `inbox ack migration-seed persist failed: ${e instanceof Error ? e.message : String(e)}`)
    )
  )
  regHandle('inbox:mark-seen', (_e, entry: AckableInboxEntry) =>
    appendSeenKey(ackedStateDir(), inboxEntryKey(entry), undefined, (e) =>
      journal.add('error', `inbox seen persist failed: ${e instanceof Error ? e.message : String(e)}`)
    )
  )
  regHandle('inbox:ack', (_e, entry: AckableInboxEntry) =>
    appendAckedKey(ackedStateDir(), inboxEntryKey(entry), undefined, (e) =>
      journal.add('error', `inbox ack persist failed: ${e instanceof Error ? e.message : String(e)}`)
    )
  )

  // ----- template composer (PLAN C18): read/write without spawning -----
  regHandle('template:read', (_e, path: string) =>
    // M-SEC-9: only read templates that live in an allowed dir.
    templateSource(path, getConfig().projectDir) ? readTemplate(path) : null
  )
  regHandle('template:write', (_e, name: string, local: boolean, tpl: unknown) => {
    // parseTemplate validates the shape AND normalizes lead uniqueness; a
    // demotion here is surfaced the same way readTemplate does (card 240d6efd).
    const parsed = parseTemplate(tpl)
    if (!parsed) throw new Error('invalid template')
    if (parsed.demotedLeadNames.length > 0) {
      reportError(
        'template',
        `template:write ${name || '(unnamed)'}: multiple sessions had lead: true, kept only ` +
          `the first (demoted: ${parsed.demotedLeadNames.join(', ')})`
      )
    }
    const out = parsed.template
    if (name && name.trim()) out.name = name.trim()
    const dir = local ? localTemplatesDir(getConfig().projectDir) : globalTemplatesDir()
    return writeTemplate(dir, name || out.name || 'template', out)
  })

  // ----- forward service events to every surface (window + companion, MB1) -----
  service.on('data', (e) => broadcast('pty:data', e))
  service.on('exit', (e) => broadcast('pty:exit', e))
  service.on('changed', (sessions) => broadcast('sessions:changed', sessions))
  service.on('thinking', (e) => broadcast('session:thinking', e))
  service.on('quota', (e) => broadcast('session:quota', e))
  service.on('attention', (e) => broadcast('session:attention', e))
  sandbox.on('changed', (st) => broadcast('sandbox:changed', st))
}
