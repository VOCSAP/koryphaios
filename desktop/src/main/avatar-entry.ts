import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { startAvatarBrokerProbe, type AvatarBrokerProbe } from './avatar-broker-probe'
import { generateAvatarRunCertificate } from './avatar-certificate'
import { createDeckFocusGesture, deckProcessIsAlive } from './avatar-focus-gesture'
import { allowForegroundWindow, runForegroundHelper } from './avatar-foreground'
import { configureAvatarLifetime, type AvatarLifetimeLease } from './avatar-lifetime'
import { ensureAvatarPrivateDir } from './avatar-private-dir'
import { claimAvatarRegistry, type AvatarRegistryOwner } from './avatar-registry'
import { startAvatarServer, type AvatarServer } from './avatar-server'
import { releaseAvatarResources } from './avatar-quit'
import { createAvatarTray, type AvatarTray } from './avatar-tray'
import { createAvatarQuitHandler } from './avatar-quit-handler'
import { resolveBrokerEndpoint } from './broker-client'
import { initDeckLog, reportError } from './log'
import { installProcessFailureGuard } from './process-failure-guard'
import { APP_STATE_SUBDIR } from './migrate-data-dir'
import { AvatarState } from '../shared/avatar-state'

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

async function startAvatar(): Promise<void> {
  if (!lifetime) {
    app.quit()
    return
  }

  ensureAvatarPrivateDir(stateDir)
  const avatarRunId = randomUUID()
  const certificate = await generateAvatarRunCertificate()
  const token = randomBytes(32).toString('base64url')
  const state = new AvatarState({ now: Date.now })
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
    allowForeground: (pid) => allowForegroundWindow(pid, { platform: process.platform, env: process.env, run: runForegroundHelper }),
    focusDeck: (identity) => (server ? server.focusDeck(identity) : Promise.reject(new Error('Avatar server stopped')))
  })
  tray = createAvatarTray({
    state,
    attachedDecks: () => server?.attachedDecks() ?? [],
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
