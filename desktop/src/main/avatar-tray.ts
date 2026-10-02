import { createRequire } from 'node:module'
import type { MenuItemConstructorOptions } from 'electron'
import { AVATAR_HEARTBEAT_MS, type AvatarDeckIdentity } from '../shared/avatar-state'
import { escapeAvatarTrayLabel, type AvatarAttachRequest } from '../shared/avatar-protocol'
import type { AvatarViewSummary } from '../shared/avatar-view'
import {
  avatarTrayEvent,
  avatarTrayMayRebound,
  buildAvatarTrayMenu,
  type AvatarDndState,
  type AvatarTrayAction,
  type AvatarTrayAppearance,
  type AvatarTrayMenuItem
} from './avatar-tray-menu'
import { avatarTrayIconPath, avatarTrayTaskbar, avatarTrayVariant, type AvatarTrayTaskbar, type AvatarTrayVariant } from './avatar-tray-icon'
import type { AvatarEvent } from './avatar-window-state'
import type { SupportedLocale } from './i18n'
import { reportError } from './log'

export interface AvatarTray {
  dispose(): void
  mayRebound(): boolean
}

export interface AvatarTrayOptions {
  summary(): AvatarViewSummary
  iconDir: string
  locale: SupportedLocale
  attachedDecks(): AvatarAttachRequest[]
  appearance(): AvatarTrayAppearance
  windowShown(): boolean
  dispatch(event: AvatarEvent): void
  getDnd(): AvatarDndState | null
  onDnd(choice: AvatarDndState['choice']): void
  onDeckMenuClick(identity: AvatarDeckIdentity): void
  onQuit(): void
}

export interface AvatarTrayNative {
  setToolTip(tooltip: string): void
  setContextMenu(menu: unknown): void
  setImage(image: AvatarTrayImage): void
  destroy(): void
}

export interface AvatarTrayImage {
  isEmpty(): boolean
}

export interface AvatarTrayDependencies {
  now(): number
  loadImage(path: string): AvatarTrayImage
  createTray(image: AvatarTrayImage): AvatarTrayNative
  buildMenu(template: MenuItemConstructorOptions[]): unknown
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>
  clearInterval(timer: ReturnType<typeof setInterval>): void
  reportError(scope: string, message: string, error?: unknown): void
  platform: string
  systemIntegratedUiDark(): boolean | undefined
  onSystemThemeUpdated(listener: () => void): () => void
}

export type ElectronTrayModule = Pick<typeof import('electron'), 'Menu' | 'Tray' | 'nativeImage' | 'nativeTheme'>

// Lazy loading keeps injected adapter tests independent of Electron runtime exports.
const requireElectron = createRequire(import.meta.url)

export function electronAvatarTrayDependencies(electron: () => ElectronTrayModule): AvatarTrayDependencies {
  return {
    now: Date.now,
    loadImage: (path) => electron().nativeImage.createFromPath(path),
    createTray: (image) => {
      const tray = new (electron().Tray)(image as import('electron').NativeImage)
      return {
        setToolTip: (tooltip) => tray.setToolTip(tooltip),
        setContextMenu: (menu) => tray.setContextMenu(menu as import('electron').Menu),
        setImage: (next) => tray.setImage(next as import('electron').NativeImage),
        destroy: () => tray.destroy()
      }
    },
    buildMenu: (template) => electron().Menu.buildFromTemplate(template),
    setInterval,
    clearInterval,
    reportError,
    platform: process.platform,
    // Tracks the taskbar only while nothing in this process forces the app theme
    // source; forcing it makes this value follow the app theme instead.
    systemIntegratedUiDark: () => electron().nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
    onSystemThemeUpdated: (listener) => {
      const theme = electron().nativeTheme
      theme.on('updated', listener)
      return () => { theme.removeListener('updated', listener) }
    }
  }
}

const defaultAvatarTrayDependencies = electronAvatarTrayDependencies(() => requireElectron('electron') as ElectronTrayModule)

function assertNever(value: never): never {
  throw new Error(`Unhandled Avatar Tray action: ${JSON.stringify(value)}`)
}

function nativeMenuItem(item: AvatarTrayMenuItem, invoke: (action: AvatarTrayAction) => void): MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' }

  return {
    label: escapeAvatarTrayLabel(item.label ?? ''),
    ...(item.type === 'radio' || item.type === 'checkbox' ? { type: item.type, checked: item.checked } : {}),
    ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
    ...(item.submenu === undefined ? {} : { submenu: item.submenu.map((child) => nativeMenuItem(child, invoke)) }),
    ...(item.action === undefined ? {} : { click: () => invoke(item.action!) })
  }
}

export function createAvatarTray(options: AvatarTrayOptions, dependencies: AvatarTrayDependencies = defaultAvatarTrayDependencies): AvatarTray {
  const loadIcon = (variant: AvatarTrayVariant, taskbar: AvatarTrayTaskbar): AvatarTrayImage => {
    const iconPath = avatarTrayIconPath(options.iconDir, variant, taskbar)
    const icon = dependencies.loadImage(iconPath)
    if (icon.isEmpty()) dependencies.reportError('avatar-tray', `Avatar Tray icon missing or unreadable: ${iconPath}`)
    return icon
  }
  const currentTaskbar = (): AvatarTrayTaskbar => avatarTrayTaskbar(dependencies.platform, dependencies.systemIntegratedUiDark())
  let variant = avatarTrayVariant(options.summary().face)
  let taskbar = currentTaskbar()
  const tray = dependencies.createTray(loadIcon(variant, taskbar))

  // The pair is recorded even when its image is unreadable, so a missing file
  // is reported once per change instead of on every heartbeat.
  const syncIcon = (nextVariant: AvatarTrayVariant, nextTaskbar: AvatarTrayTaskbar): void => {
    if (nextVariant === variant && nextTaskbar === taskbar) return
    variant = nextVariant
    taskbar = nextTaskbar
    const icon = loadIcon(nextVariant, nextTaskbar)
    if (!icon.isEmpty()) tray.setImage(icon)
  }

  const onThemeUpdated = (): void => {
    try {
      syncIcon(variant, currentTaskbar())
    } catch (error) {
      dependencies.reportError('avatar-tray', 'cannot follow the taskbar theme', error)
    }
  }

  // The heartbeat re-reads the taskbar too, in case a taskbar-only change does
  // not raise nativeTheme 'updated'.
  const refresh = (): void => {
    try {
      const summary = options.summary()
      syncIcon(avatarTrayVariant(summary.face), currentTaskbar())
      const menu = buildAvatarTrayMenu(summary, options.attachedDecks(), options.getDnd(), dependencies.now(), options.appearance(), options.windowShown(), options.locale)
      tray.setToolTip(menu.tooltip)
      tray.setContextMenu(dependencies.buildMenu(menu.items.map((item) => nativeMenuItem(item, invoke))))
    } catch (error) {
      dependencies.reportError('avatar-tray', 'cannot refresh Avatar Tray', error)
    }
  }

  const invoke = (action: AvatarTrayAction): void => {
    switch (action.kind) {
      case 'dnd':
        options.onDnd(action.choice)
        refresh()
        return
      case 'deck-focus':
        options.onDeckMenuClick(action.identity)
        return
      case 'quit':
        options.onQuit()
        return
      case 'dnd-off':
      case 'visible':
      case 'lock':
      case 'always-on-top':
      case 'motion':
      case 'size':
        options.dispatch(avatarTrayEvent(action))
        refresh()
        return
      default:
        assertNever(action)
    }
  }

  refresh()
  const refreshTimer = dependencies.setInterval(refresh, AVATAR_HEARTBEAT_MS)
  const stopFollowingTheme = dependencies.onSystemThemeUpdated(onThemeUpdated)

  return {
    dispose() {
      dependencies.clearInterval(refreshTimer)
      stopFollowingTheme()
      tray.destroy()
    },
    mayRebound() {
      return avatarTrayMayRebound(options.getDnd(), dependencies.now())
    }
  }
}
