import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'
import { startAvatarBrokerProbe, type AvatarBrokerProbe } from './avatar-broker-probe'
import { generateAvatarRunCertificate } from './avatar-certificate'
import { createDeckFocusGesture, deckProcessIsAlive } from './avatar-focus-gesture'
import { allowForegroundWindow, runForegroundHelper } from './avatar-foreground'
import { configureAvatarLifetime, type AvatarLifetimeLease } from './avatar-lifetime'
import { ensureAvatarPrivateDir } from './avatar-private-dir'
import { loopbackSocketOwner, runSocketOwnerHelper } from './avatar-socket-owner'
import { claimAvatarRegistry, type AvatarRegistryOwner } from './avatar-registry'
import { deckSocketEndpoints, startAvatarServer, type AvatarServer } from './avatar-server'
import { releaseAvatarResources } from './avatar-quit'
import { createAvatarTray, type AvatarTray } from './avatar-tray'
import { chooseAvatarDnd } from './avatar-tray-menu'
import { avatarTrayIconDir } from './avatar-tray-icon'
import { AVATAR_APPEARANCE_FILE, avatarAppearanceDnd, readAvatarAppearance, writeAvatarAppearance } from './avatar-appearance'
import { createAvatarBootstrap } from './avatar-bootstrap'
import { createAvatarPositionController, type AvatarPositionController } from './avatar-position-controller'
import { assertAvatarPositionMovable, canMoveAvatarAppearance } from './avatar-position-guard'
import { createAvatarWindow, registerAvatarViewIpcHandlers, type AvatarWindow } from './avatar-window'
import { createAvatarQuitHandler } from './avatar-quit-handler'
import { resolveBrokerEndpoint } from './broker-client'
import { initDeckLog, logWarn, reportError } from './log'
import { installProcessFailureGuard } from './process-failure-guard'
import { APP_STATE_SUBDIR } from './migrate-data-dir'

app.setName('koryphaios')
const deckUserData = app.getPath('userData')
let lifetime: AvatarLifetimeLease | null = configureAvatarLifetime(app, deckUserData)
app.setAppLogsPath()
initDeckLog(app.getPath('logs'))
installProcessFailureGuard()

const stateDir = join(deckUserData, APP_STATE_SUBDIR)
let owner: AvatarRegistryOwner | null = null
let server: AvatarServer | null = null
let tray: AvatarTray | null = null
let brokerProbe: AvatarBrokerProbe | null = null
let avatarWindow: AvatarWindow | null = null
let disposeAvatarViewIpc: (() => void) | null = null
let stopFollowingTheme: (() => void) | null = null
let positionController: AvatarPositionController | null = null

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
  let appearance = readAvatarAppearance(appearanceFile, { reportError })
  const { state, presentation } = createAvatarBootstrap({
    appearance,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    now: Date.now,
    send: (viewState) => avatarWindow?.sendState(viewState)
  })
  const updateTheme = (): void => presentation.setTheme(nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  nativeTheme.on('updated', updateTheme)
  stopFollowingTheme = () => nativeTheme.removeListener('updated', updateTheme)
  avatarWindow = createAvatarWindow({
    platform: process.platform,
    preload: join(__dirname, '../preload/avatar.js'),
    html: join(__dirname, '../renderer/avatar.html'),
    createWindow: (options) => new BrowserWindow(options),
    alwaysOnTop: appearance.alwaysOnTop,
    reportError,
    onGeneration: presentation.setGeneration
  })
  const controller = createAvatarPositionController({
    canApply: () => canMoveAvatarAppearance(appearance),
    move: (position) => {
      const currentWindow = avatarWindow
      if (!currentWindow) throw new Error('Avatar window is unavailable')
      currentWindow.setPosition(position.x, position.y)
      presentation.setPosition(position)
    },
    persist: (position) => {
      const display = screen.getDisplayNearestPoint(position)
      appearance = writeAvatarAppearance(appearanceFile, {
        positions: {
          ...appearance.positions,
          [String(display.id)]: { workArea: display.workArea, ...position }
        }
      }, { reportError })
    },
    reportError,
    setTimeout,
    clearTimeout
  })
  positionController = controller
  disposeAvatarViewIpc = registerAvatarViewIpcHandlers({
    ipc: ipcMain,
    currentWindow: () => avatarWindow?.current() ?? null,
    getState: presentation.getState,
    setPosition: (x, y) => {
      assertAvatarPositionMovable(appearance)
      const display = screen.getDisplayNearestPoint({ x, y })
      controller.setPosition({
        x: Math.min(Math.max(x, display.workArea.x), display.workArea.x + display.workArea.width),
        y: Math.min(Math.max(y, display.workArea.y), display.workArea.y + display.workArea.height)
      })
    },
    setPointerInside: (inside) => avatarWindow?.setPointerInside(inside),
    reportError: (message) => reportError('avatar-renderer', message)
  })
  server = await startAvatarServer({ avatarRunId, certificate, state, token })
  brokerProbe = startAvatarBrokerProbe({
    brokerUrls: () => server?.attachedDecks().map((deck) => deck.broker_url) ?? [],
    knownBrokerUrls: () => [resolveBrokerEndpoint().url],
    setBrokerReachable: (brokerUrl, reachable) => state.setBrokerReachable(brokerUrl, reachable)
  })

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
    lifetime
  )
  owner = claim.kind === 'claimed' ? claim.owner : null
  if (!owner) throw new Error('Avatar registry could not be claimed')
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
    focusDeck: (identity) => (server ? server.focusDeck(identity) : Promise.reject(new Error('Avatar server stopped')))
  })
  tray = createAvatarTray({
    summary: presentation.summaryForTray,
    iconDir: avatarTrayIconDir(app.isPackaged, process.resourcesPath, app.getAppPath()),
    attachedDecks: () => server?.attachedDecks() ?? [],
    getDnd: () => avatarAppearanceDnd(appearance),
    onDnd: (choice) => {
      const dnd = chooseAvatarDnd(choice, Date.now())
      appearance = writeAvatarAppearance(appearanceFile, {
        dndUntil: dnd.until,
        dndChoice: dnd.choice
      }, { reportError })
      presentation.updateAppearance(appearance)
    },
    onDeckMenuClick: (identity) => {
      void focusFromTray(identity).catch((error: unknown) => reportError('avatar-focus', 'Tray focus gesture failed', error))
    },
    onQuit: () => app.quit()
  })
}

function disposeAvatarTray(): void {
  const currentTray = tray
  tray = null
  currentTray?.dispose()
}

async function stopAvatar(): Promise<void> {
  disposeAvatarViewIpc?.()
  disposeAvatarViewIpc = null
  positionController?.flush()
  positionController = null
  avatarWindow?.destroy()
  avatarWindow = null
  stopFollowingTheme?.()
  stopFollowingTheme = null
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
