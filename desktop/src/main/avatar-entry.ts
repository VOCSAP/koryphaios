import { spawn as spawnProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session } from 'electron'
import {
  brokerStopMarkerPath,
  clearBrokerStopMarker,
  readBrokerStopMarker,
  writeBrokerStopMarker
} from '../../../shared/broker-stop-marker'
import { avatarManualStop, avatarTrayBroker, createAvatarBrokerControl } from './avatar-broker-control'
import {
  avatarBrokerProbeUrls,
  brokerListenerEnds,
  brokerStopDialogOptions,
  confirmedStop,
  fetchBrokerHealth,
  manualStopRefresher,
  probeBrokerUrls,
  trayBrokerSummary
} from './avatar-broker-wiring'
import { startAvatarBrokerProbe, type AvatarBrokerProbe } from './avatar-broker-probe'
import {
  avatarBubbleDict,
  avatarBubblePlacement,
  createAvatarBubbleNativeAdapter,
  createAvatarBubbleWindow,
  type AvatarBubbleWindow
} from './avatar-bubble-window'
import { generateAvatarRunCertificate } from './avatar-certificate'
import { createAvatarClickGesture } from './avatar-click-gesture'
import { avatarAllowedBrokerUrls } from './avatar-deck-link'
import { createDeckFocusGesture, deckProcessIsAlive } from './avatar-focus-gesture'
import { createAvatarInboxService, type AvatarInboxService } from './avatar-inbox-service'
import { allowForegroundWindow, runForegroundHelper } from './avatar-foreground'
import { configureAvatarLifetime, type AvatarLifetimeLease } from './avatar-lifetime'
import { ensureAvatarPrivateDir } from './avatar-private-dir'
import { loopbackSocketOwner, runSocketOwnerHelper } from './avatar-socket-owner'
import { claimAvatarRegistry, type AvatarRegistryOwner } from './avatar-registry'
import { deckSocketEndpoints, startAvatarServer, type AvatarServer } from './avatar-server'
import { releaseAvatarResources } from './avatar-quit'
import { createAvatarTray, type AvatarTray } from './avatar-tray'
import { avatarTrayIconDir } from './avatar-tray-icon'
import { AVATAR_APPEARANCE_FILE, readAvatarAppearance, writeAvatarAppearance } from './avatar-appearance'
import { assembleAvatar, type AvatarAssembly } from './avatar-assembly'
import { finishAvatarStartup } from './avatar-startup'
import { avatarDeckStateDir, readAvatarLocale } from './avatar-locale'
import { selectWindowShown, type AvatarGeometry } from './avatar-window-state'
import { createAvatarQuitHandler } from './avatar-quit-handler'
import { AVATAR_TRAY_COPY } from './avatar-tray-copy'
import { deckBrokerMode, peersConfigPath, resolveBrokerEndpoint } from './broker-client'
import { ensureLoopbackBroker, locateUserBrokerScript, spawnDetachedBroker } from './broker-spawn'
import { loadDict } from './i18n'
import { initDeckLog, logInfo, logWarn, reportError } from './log'
import { installProcessFailureGuard } from './process-failure-guard'

app.setName('koryphaios')
const deckUserData = app.getPath('userData')
let lifetime: AvatarLifetimeLease | null = configureAvatarLifetime(app, deckUserData)
app.setAppLogsPath()
initDeckLog(app.getPath('logs'))
installProcessFailureGuard()
// The default application menu would give a focused avatar window Ctrl+R (in-place reload) and F11 (fullscreen).
Menu.setApplicationMenu(null)

const stateDir = avatarDeckStateDir(deckUserData)
let owner: AvatarRegistryOwner | null = null
let server: AvatarServer | null = null
let tray: AvatarTray | null = null
let brokerProbe: AvatarBrokerProbe | null = null
let avatarAssembly: AvatarAssembly | null = null
let bubble: AvatarBubbleWindow | null = null
let avatarInbox: AvatarInboxService | null = null
let stopFollowers: (() => void) | null = null

const brokerMarkerPath = (): string => brokerStopMarkerPath(peersConfigPath())
const brokerStoppedManually = (): boolean => avatarManualStop(deckBrokerMode(), readBrokerStopMarker(brokerMarkerPath()))

async function brokerAnswers(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}

function avatarGeometry(): AvatarGeometry {
  return {
    displays: screen.getAllDisplays().map((display) => ({ id: String(display.id), workArea: display.workArea }))
  }
}

function avatarMaskBounds(): Electron.Rectangle | null {
  const endpoint = avatarAssembly?.controller.currentWindow()
  const mask = endpoint ? BrowserWindow.fromWebContents(endpoint.webContents as Electron.WebContents) : null
  return mask && !mask.isDestroyed() && mask.isVisible() ? mask.getBounds() : null
}

async function startAvatar(): Promise<void> {
  if (!lifetime) {
    logWarn('avatar-entry', 'Avatar stopped because another process owns its singleton lock')
    app.quit()
    return
  }

  ensureAvatarPrivateDir(stateDir)
  const avatarRunId = randomUUID()
  const certificate = await generateAvatarRunCertificate()
  const token = randomBytes(32).toString('base64url')
  const appearanceFile = join(stateDir, AVATAR_APPEARANCE_FILE)
  const locale = readAvatarLocale(stateDir, app.getLocale(), { reportError })
  const assembly = assembleAvatar({
    ipc: ipcMain,
    available: process.platform === 'win32',
    preload: join(__dirname, '../preload/avatar.js'),
    html: join(__dirname, '../renderer/avatar.html'),
    createWindow: (options) => new BrowserWindow(options),
    appearance: readAvatarAppearance(appearanceFile, { reportError }),
    writeSnapshot: (snapshot) => writeAvatarAppearance(appearanceFile, snapshot, { reportError }),
    geometry: avatarGeometry,
    theme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    locale,
    now: Date.now,
    reportError,
    gesture: createAvatarClickGesture({
      decks: () => avatarAssembly?.state.summary().decks ?? [],
      attached: () => server?.attachedDecks() ?? [],
      send: (identity, command) => focusFromTray(identity, command),
      openBubble: () => bubble?.open(),
      info: logInfo,
      report: reportError
    }),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  })
  avatarAssembly = assembly
  const inbox = createAvatarInboxService({
    send: (identity, action) =>
      server ? server.sendInboxAction(identity, action) : Promise.reject(new Error('Avatar server is not running')),
    report: reportError,
    changed: () => bubble?.changed()
  })
  avatarInbox = inbox
  const shippedLocales = app.isPackaged ? join(process.resourcesPath, 'locales') : join(app.getAppPath(), 'locales')
  bubble = createAvatarBubbleWindow({
    ipc: ipcMain,
    native: createAvatarBubbleNativeAdapter({
      preload: join(__dirname, '../preload/avatar-bubble.js'),
      html: join(__dirname, '../renderer/avatar-bubble.html'),
      runId: avatarRunId,
      createWindow: (options) => new BrowserWindow(options),
      sessionFromPartition: (partition) => session.fromPartition(partition),
      reportError
    }),
    boxes: () => inbox.boxes(),
    decks: () => server?.attachedDecks() ?? [],
    act: (identity, action) => inbox.act(identity, action),
    markRead: (identity, entry, status) => inbox.markRead(identity, entry, status),
    focusDeck: (identity) => focusFromTray(identity, 'focus'),
    theme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    lang: locale,
    dict: avatarBubbleDict(loadDict(locale, [shippedLocales, join(deckUserData, 'locales')])),
    placement: () => {
      const mask = avatarMaskBounds()
      return mask ? avatarBubblePlacement(mask, screen.getDisplayMatching(mask).workArea) : null
    },
    now: Date.now,
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      return () => clearTimeout(handle)
    },
    reportError
  })
  server = await startAvatarServer({
    avatarRunId,
    certificate,
    state: assembly.state,
    token,
    allowedBrokerUrls: () => avatarAllowedBrokerUrls(resolveBrokerEndpoint().url),
    inbox
  })
  const refreshManualStop = manualStopRefresher(
    brokerStoppedManually,
    (stopped) => assembly.state.setManualStop(stopped),
    () => assembly.controller.dispatch({ kind: 'RefreshRequested' })
  )
  brokerProbe = startAvatarBrokerProbe({
    brokerUrls: probeBrokerUrls(refreshManualStop, () =>
      avatarBrokerProbeUrls(server?.attachedDecks().map((deck) => deck.broker_url) ?? [], deckBrokerMode(), resolveBrokerEndpoint().url)
    ),
    knownBrokerUrls: () => [resolveBrokerEndpoint().url],
    setBrokerReachable: (brokerUrl, reachable) => assembly.state.setBrokerReachable(brokerUrl, reachable)
  })

  const brokerControl = createAvatarBrokerControl({
    url: () => resolveBrokerEndpoint().url,
    selfPid: process.pid,
    listenerPid: (port) => {
      const ends = brokerListenerEnds(port)
      return loopbackSocketOwner(ends.local, ends.remote, { env: process.env, run: runSocketOwnerHelper })
    },
    isAlive: deckProcessIsAlive,
    brokerHealth: (port) => fetchBrokerHealth(port, fetch),
    attachedBrokerUrls: () => server?.attachedDecks().map((deck) => deck.broker_url) ?? [],
    confirm: async (details) => {
      const answer = await dialog.showMessageBox(brokerStopDialogOptions(AVATAR_TRAY_COPY[locale].brokerStopConfirm(details)))
      return confirmedStop(answer.response)
    },
    writeMarker: (marker) => writeBrokerStopMarker(brokerMarkerPath(), marker),
    clearMarker: () => clearBrokerStopMarker(brokerMarkerPath()),
    kill: (pid) => process.kill(pid),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date().toISOString(),
    health: () => brokerAnswers(resolveBrokerEndpoint().url),
    ensure: () =>
      ensureLoopbackBroker(deckBrokerMode(), resolveBrokerEndpoint().url, {
        isAlive: brokerAnswers,
        stopped: () => readBrokerStopMarker(brokerMarkerPath()).stopped,
        locate: () =>
          locateUserBrokerScript(app.getAppPath(), {
            readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
            exists: (path) => existsSync(path),
            homeDir: homedir(),
            warn: (message) => reportError('avatar-broker', message)
          }),
        spawn: (command, script, entryEnv) =>
          spawnDetachedBroker(command, script, entryEnv, {
            env: process.env,
            homeDir: homedir(),
            platform: process.platform,
            spawn: spawnProcess,
            report: (message, error) => reportError('avatar-broker', message, error)
          }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      }),
    refresh: refreshManualStop,
    report: reportError
  })

  const currentLifetime = lifetime
  const focusFromTray = createDeckFocusGesture({
    platform: process.platform,
    attachedDecks: () => server?.attachedDecks() ?? [],
    isAlive: deckProcessIsAlive,
    isDeckBound: (identity) => server?.isDeckBound(identity) ?? false,
    socketOwnerPid: async (identity) => {
      const ends = server ? deckSocketEndpoints(server, identity) : null
      if (!ends) return null
      return loopbackSocketOwner(ends.local, ends.remote, { env: process.env, run: runSocketOwnerHelper })
    },
    allowForeground: (pid) => allowForegroundWindow(pid, { platform: process.platform, env: process.env, run: runForegroundHelper }),
    focusDeck: (identity, command) =>
      server ? server.focusDeck(identity, command) : Promise.reject(new Error('Avatar server stopped'))
  })
  stopFollowers = finishAvatarStartup({
    claimRegistry: () => {
      const claim = claimAvatarRegistry(
        stateDir,
        () => ({
          version: 1,
          avatarRunId,
          pid: process.pid,
          port: server!.port,
          certPem: certificate.certPem,
          token
        }),
        currentLifetime
      )
      owner = claim.kind === 'claimed' ? claim.owner : null
      if (!owner) throw new Error('Avatar registry could not be claimed')
    },
    createTray: () => {
      tray = createAvatarTray({
        summary: trayBrokerSummary(refreshManualStop, assembly.traySummary),
        sweepDeadDecks: () => server?.sweepDeadDecks(deckProcessIsAlive),
        iconDir: avatarTrayIconDir(app.isPackaged, process.resourcesPath, app.getAppPath()),
        locale,
        attachedDecks: () => server?.attachedDecks() ?? [],
        appearance: () => assembly.controller.snapshot().appearance,
        windowShown: () => selectWindowShown(assembly.controller.snapshot()),
        dispatch: assembly.controller.dispatch,
        getDnd: assembly.trayDnd,
        onDnd: assembly.chooseDnd,
        onDeckMenuClick: (identity) => {
          void focusFromTray(identity, 'focus').catch((error: unknown) => reportError('avatar-focus', 'Tray focus gesture failed', error))
        },
        onQuit: () => app.quit(),
        broker: () =>
          avatarTrayBroker(deckBrokerMode(), brokerStoppedManually(), assembly.state.brokerReachable(resolveBrokerEndpoint().url)),
        onBroker: (value) => {
          void (value === 'stop' ? brokerControl.stop() : brokerControl.start())
        }
      })
    },
    theme: nativeTheme,
    themeChanged: () => {
      assembly.themeChanged()
      bubble?.changed()
    },
    screen,
    geometryChanged: assembly.geometryChanged,
    dispatch: assembly.controller.dispatch
  })
}

function disposeAvatarTray(): void {
  const currentTray = tray
  tray = null
  currentTray?.dispose()
}

async function stopAvatar(): Promise<void> {
  stopFollowers?.()
  stopFollowers = null
  bubble?.dispose()
  bubble = null
  avatarInbox?.dispose()
  avatarInbox = null
  avatarAssembly?.dispose()
  avatarAssembly = null
  brokerProbe?.stop()
  brokerProbe = null
  const currentServer = server
  const currentOwner = owner
  const currentLifetime = lifetime
  server = null
  owner = null
  lifetime = null
  await releaseAvatarResources(currentServer, currentOwner, currentLifetime)
}

const handleBeforeQuit = createAvatarQuitHandler({
  disposeTray: disposeAvatarTray,
  release: stopAvatar,
  quit: () => app.quit(),
  report: reportError
})

app.on('before-quit', handleBeforeQuit)

void app.whenReady().then(startAvatar).catch(async (error: unknown) => {
  try {
    await stopAvatar()
  } catch (stopError) {
    reportError('avatar-entry', 'cannot close Avatar server', stopError)
  }
  reportError('avatar-entry', 'Avatar startup failed', error)
  app.exit(1)
})
