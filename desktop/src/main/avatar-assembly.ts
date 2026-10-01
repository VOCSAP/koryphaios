import type { AvatarState } from '../shared/avatar-state'
import type { AvatarViewState, AvatarViewSummary, AvatarViewTheme } from '../shared/avatar-view'
import { avatarAppearanceDnd, type AvatarAppearance } from './avatar-appearance'
import { createAvatarBootstrap } from './avatar-bootstrap'
import { chooseAvatarDnd, type AvatarDndChoice, type AvatarDndState } from './avatar-tray-menu'
import { registerAvatarViewIpcHandlers, type AvatarBrowserWindow, type AvatarViewIpcMain, type AvatarWindowConstructionOptions } from './avatar-window'
import { createAvatarWindowController, type AvatarWindowController } from './avatar-window-controller'
import type { AvatarGeometry } from './avatar-window-state'

export interface AvatarAssemblyOptions {
  ipc: AvatarViewIpcMain
  available: boolean
  preload: string
  html: string
  createWindow(options: AvatarWindowConstructionOptions): AvatarBrowserWindow
  appearance: AvatarAppearance
  writeSnapshot(appearance: AvatarAppearance): void
  geometry: AvatarGeometry
  theme(): AvatarViewTheme
  now(): number
  reportError(scope: string, message: string, error?: unknown): void
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
  dispose(): void
}

export function assembleAvatar(options: AvatarAssemblyOptions): AvatarAssembly {
  const { state, presentation } = createAvatarBootstrap({ theme: options.theme(), now: options.now })
  const tray: { envelope: AvatarViewState | null } = { envelope: null }
  const controller = createAvatarWindowController({
    available: options.available,
    preload: options.preload,
    html: options.html,
    createWindow: options.createWindow,
    appearance: options.appearance,
    geometry: options.geometry,
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
    dispose() {
      disposeIpc()
      controller.shutdown()
    }
  }
}
