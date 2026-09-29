import { createRequire } from 'node:module'
import type { MenuItemConstructorOptions } from 'electron'
import { AVATAR_HEARTBEAT_MS, type AvatarDeckIdentity, type AvatarState } from '../shared/avatar-state'
import { escapeAvatarTrayLabel, type AvatarAttachRequest } from '../shared/avatar-protocol'
import {
  avatarTrayMayRebound,
  buildAvatarTrayMenu,
  chooseAvatarDnd,
  type AvatarDndState,
  type AvatarTrayAction,
  type AvatarTrayMenuItem
} from './avatar-tray-menu'
import { reportError } from './log'

export interface AvatarTray {
  dispose(): void
  mayRebound(): boolean
}

export interface AvatarTrayOptions {
  state: AvatarState
  attachedDecks(): AvatarAttachRequest[]
  onDeckMenuClick(identity: AvatarDeckIdentity): void
  onQuit(): void
}

export interface AvatarTrayNative {
  setToolTip(tooltip: string): void
  setContextMenu(menu: unknown): void
  destroy(): void
}

export interface AvatarTrayDependencies {
  now(): number
  createTray(): AvatarTrayNative
  buildMenu(template: MenuItemConstructorOptions[]): unknown
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>
  clearInterval(timer: ReturnType<typeof setInterval>): void
  reportError(scope: string, message: string, error?: unknown): void
}

type ElectronTrayModule = Pick<typeof import('electron'), 'Menu' | 'Tray' | 'nativeImage'>

// Lazy loading keeps injected adapter tests independent of Electron runtime exports.
const requireElectron = createRequire(import.meta.url)

function electronTrayModule(): ElectronTrayModule {
  return requireElectron('electron') as ElectronTrayModule
}

const defaultAvatarTrayDependencies: AvatarTrayDependencies = {
  now: Date.now,
  createTray: () => {
    const { Tray, nativeImage } = electronTrayModule()
    return new Tray(nativeImage.createEmpty())
  },
  buildMenu: (template) => electronTrayModule().Menu.buildFromTemplate(template),
  setInterval,
  clearInterval,
  reportError
}

function nativeMenuItem(item: AvatarTrayMenuItem, invoke: (action: AvatarTrayAction) => void): MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' }

  return {
    label: escapeAvatarTrayLabel(item.label ?? ''),
    ...(item.type === 'radio' ? { type: 'radio' as const, checked: item.checked } : {}),
    ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
    ...(item.submenu === undefined ? {} : { submenu: item.submenu.map((child) => nativeMenuItem(child, invoke)) }),
    ...(item.action === undefined ? {} : { click: () => invoke(item.action!) })
  }
}

export function createAvatarTray(options: AvatarTrayOptions, dependencies: AvatarTrayDependencies = defaultAvatarTrayDependencies): AvatarTray {
  const tray = dependencies.createTray()
  let dnd: AvatarDndState | null = null

  const refresh = (): void => {
    try {
      const menu = buildAvatarTrayMenu(options.state.summary(), options.attachedDecks(), dnd, dependencies.now())
      tray.setToolTip(menu.tooltip)
      tray.setContextMenu(dependencies.buildMenu(menu.items.map((item) => nativeMenuItem(item, invoke))))
    } catch (error) {
      dependencies.reportError('avatar-tray', 'cannot refresh Avatar Tray', error)
    }
  }

  const invoke = (action: AvatarTrayAction): void => {
    if (action.kind === 'dnd') {
      dnd = chooseAvatarDnd(action.choice, dependencies.now())
      refresh()
      return
    }
    if (action.kind === 'deck-focus') {
      options.onDeckMenuClick(action.identity)
      return
    }
    options.onQuit()
  }

  refresh()
  const refreshTimer = dependencies.setInterval(refresh, AVATAR_HEARTBEAT_MS)

  return {
    dispose() {
      dependencies.clearInterval(refreshTimer)
      tray.destroy()
    },
    mayRebound() {
      return avatarTrayMayRebound(dnd, dependencies.now())
    }
  }
}
