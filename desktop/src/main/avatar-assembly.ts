import type { AvatarState } from '../shared/avatar-state'
import type { AvatarViewGesture, AvatarViewState, AvatarViewSummary, AvatarViewTheme } from '../shared/avatar-view'
import { avatarAppearanceDnd, type AvatarAppearance } from './avatar-appearance'
import { createAvatarBootstrap } from './avatar-bootstrap'
import { chooseAvatarDnd, type AvatarDndChoice, type AvatarDndState } from './avatar-tray-menu'
import { registerAvatarViewIpcHandlers, type AvatarBrowserWindow, type AvatarViewIpcMain, type AvatarWindowConstructionOptions } from './avatar-window'
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
  reportError(scope: string, message: string, error?: unknown): void
  gesture(kind: AvatarViewGesture): void | Promise<void>
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface AvatarAssembly {
  state: AvatarState
  controller: AvatarWindowController
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

const AVATAR_SCREEN_EVENTS: readonly AvatarScreenEvent[] = ['display-added', 'display-removed', 'display-metrics-changed']

export function followAvatarScreens(source: AvatarScreenSource, onChange: () => void): () => void {
  for (const event of AVATAR_SCREEN_EVENTS) source.on(event, onChange)
  return () => {
    for (const event of AVATAR_SCREEN_EVENTS) source.removeListener(event, onChange)
  }
}

export function assembleAvatar(options: AvatarAssemblyOptions): AvatarAssembly {
  const { state, presentation } = createAvatarBootstrap({ theme: options.theme(), locale: options.locale, now: options.now })
  const tray: { envelope: AvatarViewState | null } = { envelope: null }
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
    clearTimeout: options.clearTimeout
  })
  const disposeIpc = registerAvatarViewIpcHandlers({
    ipc: options.ipc,
    currentWindow: controller.currentWindow,
    loadingWindow: controller.loadingWindow,
    getState: controller.getState,
    setPosition: controller.setPosition,
    setPointerInside: controller.setPointerInside,
    gesture: (kind) => {
      if (kind === 'double') {
        controller.dispatch({ kind: 'HideRequested' })
        return
      }
      return options.gesture(kind)
    },
    reportError: (message) => options.reportError('avatar-renderer', message)
  })

  return {
    state,
    controller,
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
      disposeIpc()
      controller.shutdown()
    }
  }
}
