import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen } from 'electron'
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
import { avatarTrayIconDir } from './avatar-tray-icon'
import { AVATAR_APPEARANCE_FILE, readAvatarAppearance, writeAvatarAppearance } from './avatar-appearance'
import { assembleAvatar, type AvatarAssembly } from './avatar-assembly'
import { finishAvatarStartup } from './avatar-startup'
import { avatarDeckStateDir, readAvatarLocale } from './avatar-locale'
import { selectWindowShown, type AvatarGeometry } from './avatar-window-state'
import { createAvatarQuitHandler } from './avatar-quit-handler'
import { resolveBrokerEndpoint } from './broker-client'
import { initDeckLog, logWarn, reportError } from './log'
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
let stopFollowers: (() => void) | null = null

function avatarGeometry(): AvatarGeometry {
  return {
    displays: screen.getAllDisplays().map((display) => ({ id: String(display.id), workArea: display.workArea }))
  }
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
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  })
  avatarAssembly = assembly
  server = await startAvatarServer({ avatarRunId, certificate, state: assembly.state, token })
  brokerProbe = startAvatarBrokerProbe({
    brokerUrls: () => server?.attachedDecks().map((deck) => deck.broker_url) ?? [],
    knownBrokerUrls: () => [resolveBrokerEndpoint().url],
    setBrokerReachable: (brokerUrl, reachable) => assembly.state.setBrokerReachable(brokerUrl, reachable)
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
    focusDeck: (identity) => (server ? server.focusDeck(identity) : Promise.reject(new Error('Avatar server stopped')))
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
        summary: assembly.traySummary,
        iconDir: avatarTrayIconDir(app.isPackaged, process.resourcesPath, app.getAppPath()),
        locale,
        attachedDecks: () => server?.attachedDecks() ?? [],
        appearance: () => assembly.controller.snapshot().appearance,
        windowShown: () => selectWindowShown(assembly.controller.snapshot()),
        dispatch: assembly.controller.dispatch,
        getDnd: assembly.trayDnd,
        onDnd: assembly.chooseDnd,
        onDeckMenuClick: (identity) => {
          void focusFromTray(identity).catch((error: unknown) => reportError('avatar-focus', 'Tray focus gesture failed', error))
        },
        onQuit: () => app.quit()
      })
    },
    theme: nativeTheme,
    themeChanged: assembly.themeChanged,
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
