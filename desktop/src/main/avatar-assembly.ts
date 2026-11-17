import type { AvatarDeckIdentity, AvatarState } from '../shared/avatar-state'
import type { AvatarViewGesture, AvatarViewState, AvatarViewSummary, AvatarViewTheme } from '../shared/avatar-view'
import { avatarAppearanceDnd, type AvatarAppearance } from './avatar-appearance'
import { createAvatarBootstrap } from './avatar-bootstrap'
import { chooseAvatarDnd, type AvatarDndChoice, type AvatarDndState } from './avatar-tray-menu'
import { registerAvatarViewIpcHandlers, type AvatarBrowserWindow, type AvatarViewIpcMain, type AvatarWindowConstructionOptions } from './avatar-window'
import type { AvatarNotificationAvailability } from './avatar-notification-policy'
import { createAvatarWindowController, type AvatarWindowController } from './avatar-window-controller'
import type { AvatarGeometry } from './avatar-window-state'
import type { SupportedLocale } from './i18n'

export interface AvatarAssemblyOptions {
  ipc: AvatarViewIpcMain
  available: boolean
  preload: string
  html: string
  createWindow(options: AvatarWindowConstructionOptions): AvatarBrowserWindow
  appearance: AvatarAppearance
  writeSnapshot(appearance: AvatarAppearance): void
  geometry(): AvatarGeometry
  theme(): AvatarViewTheme
  locale: SupportedLocale
  now(): number
  localUnread(identity: AvatarDeckIdentity): number | undefined
  reportError(scope: string, message: string, error?: unknown): void
  gesture(kind: AvatarViewGesture): void | Promise<void>
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
  /** The mask, its renderer or the Do-not-disturb window changed what `notificationPresentation` reports. */
  onNotificationAvailabilityChanged?(): void
}

export type AvatarNotificationPresentation = Omit<AvatarNotificationAvailability, 'serviceReady'>

export interface AvatarAssembly {
  state: AvatarState
  controller: AvatarWindowController
  /** What the operator can see of the mask right now; the bubble service and the projection are read elsewhere. */
  notificationPresentation(): AvatarNotificationPresentation
  traySummary(): AvatarViewSummary
  trayDnd(): AvatarDndState | null
  chooseDnd(choice: AvatarDndChoice): void
  themeChanged(): void
  geometryChanged(): void
  dispose(): void
}

type AvatarScreenEvent = 'display-added' | 'display-removed' | 'display-metrics-changed'

export interface AvatarScreenSource {
  on(event: AvatarScreenEvent, listener: () => void): unknown
  removeListener(event: AvatarScreenEvent, listener: () => void): unknown
}

/** setTimeout fires at once above this many milliseconds. */
const MAX_NATIVE_TIMER_MS = 2_147_483_647

const AVATAR_SCREEN_EVENTS: readonly AvatarScreenEvent[] = ['display-added', 'display-removed', 'display-metrics-changed']

export function followAvatarScreens(source: AvatarScreenSource, onChange: () => void): () => void {
  for (const event of AVATAR_SCREEN_EVENTS) source.on(event, onChange)
  return () => {
    for (const event of AVATAR_SCREEN_EVENTS) source.removeListener(event, onChange)
  }
}

export function assembleAvatar(options: AvatarAssemblyOptions): AvatarAssembly {
  const { state, presentation } = createAvatarBootstrap({
    theme: options.theme(),
    locale: options.locale,
    now: options.now,
    localUnread: options.localUnread
  })
  const tray: { envelope: AvatarViewState | null } = { envelope: null }
  let dndTimer: unknown = null
  let dndTimerDeadline: number | null = null
  let lastPresentation = ''
  let closing = false
  const notificationPresentation = (): AvatarNotificationPresentation => {
    const snapshot = controller.snapshot()
    const { lifecycle, appearance } = snapshot
    const ready = lifecycle.kind === 'ready'
    const endpoint = ready ? controller.currentWindow() : null
    return {
      maskReady: ready,
      maskVisible: appearance.visible === true,
      rendererAlive: ready && endpoint !== null && endpoint.generation === lifecycle.token,
      dndActive: appearance.dndUntil !== null && options.now() < appearance.dndUntil
    }
  }
  const announceIfChanged = (): void => {
    const key = JSON.stringify(notificationPresentation())
    if (key === lastPresentation) return
    lastPresentation = key
    try {
      options.onNotificationAvailabilityChanged?.()
    } catch (error) {
      options.reportError('avatar-assembly', 'Avatar notification availability observer failed', error)
    }
  }
  const syncDndTimer = (): void => {
    if (closing) return
    const until = controller.snapshot().appearance.dndUntil
    const deadline = until !== null && options.now() < until ? until : null
    if (deadline === dndTimerDeadline) return
    if (dndTimer !== null) options.clearTimeout(dndTimer)
    dndTimer = null
    dndTimerDeadline = deadline
    if (deadline === null) return
    dndTimer = options.setTimeout(() => {
      if (dndTimerDeadline !== deadline) return
      dndTimer = null
      dndTimerDeadline = null
      syncDndTimer()
      announceIfChanged()
    }, Math.min(deadline - options.now(), MAX_NATIVE_TIMER_MS))
  }
  const controller = createAvatarWindowController({
    available: options.available,
    preload: options.preload,
    html: options.html,
    createWindow: options.createWindow,
    appearance: options.appearance,
    geometry: options.geometry(),
    buildEnvelope: presentation.project,
    publishTray: (envelope) => {
      tray.envelope = envelope
    },
    writeSnapshot: options.writeSnapshot,
    reportError: options.reportError,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    stateChanged: () => {
      syncDndTimer()
      announceIfChanged()
    }
  })
  syncDndTimer()
  lastPresentation = JSON.stringify(notificationPresentation())
  const disposeIpc = registerAvatarViewIpcHandlers({
    ipc: options.ipc,
    currentWindow: controller.currentWindow,
    loadingWindow: controller.loadingWindow,
    getState: controller.getState,
    setPosition: controller.setPosition,
    setPointerInside: controller.setPointerInside,
    gesture: (kind) => {
      if (kind === 'double' && state.summary().counters.waiting === 0) return
      return options.gesture(kind)
    },
    reportError: (message) => options.reportError('avatar-renderer', message)
  })

  return {
    state,
    controller,
    notificationPresentation,
    traySummary() {
      controller.dispatch({ kind: 'RefreshRequested' })
      if (tray.envelope === null) throw new Error('Avatar Tray summary is unavailable')
      return tray.envelope.summary
    },
    trayDnd: () => avatarAppearanceDnd(controller.snapshot().appearance),
    chooseDnd(choice) {
      const dnd = chooseAvatarDnd(choice, options.now())
      controller.dispatch({ kind: 'AppearanceChanged', patch: { dndUntil: dnd.until, dndChoice: dnd.choice } })
    },
    themeChanged() {
      presentation.setTheme(options.theme())
      controller.dispatch({ kind: 'RefreshRequested' })
    },
    geometryChanged() {
      controller.dispatch({ kind: 'GeometryChanged', geometry: options.geometry() })
    },
    dispose() {
      closing = true
      if (dndTimer !== null) options.clearTimeout(dndTimer)
      dndTimer = null
      dndTimerDeadline = null
      disposeIpc()
      controller.shutdown()
    }
  }
}
