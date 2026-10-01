import { AVATAR_VIEW_CHANNELS, type AvatarViewState } from '../shared/avatar-view'
import type { AvatarWindowSize } from './avatar-window-placement'

export interface AvatarViewWebContents {
  mainFrame: unknown
}

export interface AvatarViewIpcEvent {
  sender: AvatarViewWebContents
  senderFrame: unknown
}

export type AvatarViewIpcHandler = (event: AvatarViewIpcEvent, ...args: unknown[]) => unknown

export interface AvatarViewIpcMain {
  handle(channel: string, handler: AvatarViewIpcHandler): void
  removeHandler(channel: string): void
}

export interface AvatarViewWindowEndpoint {
  webContents: AvatarViewWebContents
  generation: number
}

export interface AvatarViewIpcOptions {
  ipc: AvatarViewIpcMain
  currentWindow(): AvatarViewWindowEndpoint | null
  loadingWindow(): AvatarViewWindowEndpoint | null
  getState(generation: number): AvatarViewState | Promise<AvatarViewState>
  setPosition(x: number, y: number): void | Promise<void>
  setPointerInside(inside: boolean): void | Promise<void>
  reportError(message: string): void
  now?(): number
  rendererErrorBurst?: number
  rendererErrorRefillMs?: number
}

export interface AvatarWindowConstructionOptions {
  width: number
  height: number
  resizable: false
  maximizable: false
  fullscreenable: false
  frame: false
  transparent: true
  alwaysOnTop: boolean
  skipTaskbar: true
  show: false
  webPreferences: {
    preload: string
    sandbox: true
    contextIsolation: true
    nodeIntegration: false
    webviewTag: false
  }
}

export interface AvatarBrowserWebContents extends AvatarViewWebContents {
  send(channel: string, payload: AvatarViewState): void
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

export interface AvatarBrowserWindow {
  webContents: AvatarBrowserWebContents
  on(event: string, listener: (...args: unknown[]) => void): void
  destroy(): void
  isDestroyed(): boolean
  hide(): void
  loadFile(file: string): Promise<unknown>
  setAlwaysOnTop(alwaysOnTop: boolean): void
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: true }): void
  setPosition(x: number, y: number): void
  setSize(width: number, height: number): void
  getSize(): number[]
  showInactive(): void
}

export interface AvatarNativeCallbacks {
  rendererGone(token: number): void
  closeRequested(token: number): boolean
  closed(token: number): void
}

export interface AvatarNativeAdapterOptions {
  preload: string
  html: string
  createWindow(options: AvatarWindowConstructionOptions): AvatarBrowserWindow
  windowSize: AvatarWindowSize
  callbacks: AvatarNativeCallbacks
}

export interface AvatarNativeAdapter {
  allocate(token: number, alwaysOnTop: boolean): void
  load(token: number): Promise<void>
  prepare(token: number, x: number, y: number, size: AvatarWindowSize, alwaysOnTop: boolean): void
  send(token: number, state: AvatarViewState): void
  show(token: number): void
  hide(token: number): void
  setPointerMode(token: number, inside: boolean): void
  setAlwaysOnTop(token: number, alwaysOnTop: boolean): void
  setPosition(token: number, x: number, y: number): void
  destroy(token: number): void
  isDestroyed(token: number): boolean
  release(token: number): void
  endpoint(token: number): AvatarViewWindowEndpoint | null
}

export class AvatarAllocationError extends Error {
  constructor(readonly cause: unknown) {
    super('Avatar window setup failed after allocation')
  }
}

function isCurrentSender(event: AvatarViewIpcEvent, current: AvatarViewWindowEndpoint | null): boolean {
  return current !== null && event.sender === current.webContents && event.senderFrame === current.webContents.mainFrame
}

function requireCurrentSender(event: AvatarViewIpcEvent, current: AvatarViewWindowEndpoint | null): void {
  if (!isCurrentSender(event, current)) throw new Error('AvatarView sender is not current')
}

function requireNoArguments(args: unknown[]): void {
  if (args.length !== 0) throw new Error('AvatarView state does not accept arguments')
}

function requirePosition(args: unknown[]): asserts args is [number, number] {
  if (args.length !== 2 || !Number.isFinite(args[0]) || !Number.isFinite(args[1])) {
    throw new Error('AvatarView position requires exactly two finite numbers')
  }
}

function requirePointerInside(args: unknown[]): asserts args is [boolean] {
  if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('AvatarView pointer state must be a boolean')
}

function requireErrorMessage(args: unknown[]): asserts args is [string] {
  if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 2_048) {
    throw new Error('AvatarView error message is invalid')
  }
}

export function registerAvatarViewIpcHandlers(options: AvatarViewIpcOptions): () => void {
  const now = options.now ?? Date.now
  const burst = options.rendererErrorBurst ?? 5
  const refillMs = options.rendererErrorRefillMs ?? 1_000
  let generation: number | null = null
  let available = burst
  let lastRefillAt = 0
  let suppressed = 0

  const reportRendererError = (endpoint: AvatarViewWindowEndpoint, message: string): void => {
    const at = now()
    if (generation !== endpoint.generation) {
      generation = endpoint.generation
      available = burst
      lastRefillAt = at
      suppressed = 0
    } else {
      const replenished = Math.floor(Math.max(0, at - lastRefillAt) / refillMs)
      if (replenished > 0) {
        available = Math.min(burst, available + replenished)
        lastRefillAt += replenished * refillMs
      }
    }
    if (available < 1) {
      suppressed += 1
      return
    }
    available -= 1
    if (suppressed > 0) {
      options.reportError(`${suppressed} Avatar renderer errors suppressed; ${message}`)
      suppressed = 0
      return
    }
    options.reportError(message)
  }

  const getState: AvatarViewIpcHandler = async (event, ...args) => {
    const current = options.currentWindow()
    const endpoint = isCurrentSender(event, current) ? current : options.loadingWindow()
    if (endpoint === null || !isCurrentSender(event, endpoint)) throw new Error('AvatarView sender is not current')
    requireNoArguments(args)
    return options.getState(endpoint.generation)
  }
  const setPosition: AvatarViewIpcHandler = async (event, ...args) => {
    requireCurrentSender(event, options.currentWindow())
    requirePosition(args)
    await options.setPosition(args[0], args[1])
  }
  const setPointerInside: AvatarViewIpcHandler = async (event, ...args) => {
    requireCurrentSender(event, options.currentWindow())
    requirePointerInside(args)
    await options.setPointerInside(args[0])
  }
  const reportError: AvatarViewIpcHandler = async (event, ...args) => {
    const endpoint = options.currentWindow()
    if (endpoint === null || !isCurrentSender(event, endpoint)) throw new Error('AvatarView sender is not current')
    requireErrorMessage(args)
    reportRendererError(endpoint, args[0])
  }

  options.ipc.handle(AVATAR_VIEW_CHANNELS.getState, getState)
  options.ipc.handle(AVATAR_VIEW_CHANNELS.setPosition, setPosition)
  options.ipc.handle(AVATAR_VIEW_CHANNELS.setPointerInside, setPointerInside)
  options.ipc.handle(AVATAR_VIEW_CHANNELS.reportError, reportError)

  return () => {
    options.ipc.removeHandler(AVATAR_VIEW_CHANNELS.getState)
    options.ipc.removeHandler(AVATAR_VIEW_CHANNELS.setPosition)
    options.ipc.removeHandler(AVATAR_VIEW_CHANNELS.setPointerInside)
    options.ipc.removeHandler(AVATAR_VIEW_CHANNELS.reportError)
  }
}

function preventDefault(event: unknown): void {
  if (typeof event === 'object' && event !== null && 'preventDefault' in event && typeof event.preventDefault === 'function') {
    event.preventDefault()
  }
}

export function createAvatarNativeAdapter(options: AvatarNativeAdapterOptions): AvatarNativeAdapter {
  const resources = new Map<number, AvatarBrowserWindow>()

  const resource = (token: number): AvatarBrowserWindow => {
    const window = resources.get(token)
    if (!window) throw new Error('Avatar window is unavailable')
    return window
  }

  const ignoreMouse = (window: AvatarBrowserWindow): void => window.setIgnoreMouseEvents(true, { forward: true })

  // A move may change the size at fractional DPI (measured under emulated 1.25/1.5 scaling only): never setBounds,
  // and put the size back after every move.
  const placeAt = (window: AvatarBrowserWindow, x: number, y: number, size: AvatarWindowSize): void => {
    window.setPosition(x, y)
    const [width = 0, height = 0] = window.getSize()
    if (Math.abs(width - size.width) >= 1 || Math.abs(height - size.height) >= 1) window.setSize(size.width, size.height)
  }

  return {
    allocate(token, alwaysOnTop) {
      if (resources.size > 0) throw new Error('Avatar window is already held')
      const window = options.createWindow({
        width: options.windowSize.width,
        height: options.windowSize.height,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        frame: false,
        transparent: true,
        alwaysOnTop,
        skipTaskbar: true,
        show: false,
        webPreferences: {
          preload: options.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false
        }
      })
      resources.set(token, window)
      try {
        // close and closed come first so a failing setup below still reports the closure.
        window.on('close', (event) => {
          if (options.callbacks.closeRequested(token)) preventDefault(event)
        })
        window.on('closed', () => {
          resources.delete(token)
          options.callbacks.closed(token)
        })
        ignoreMouse(window)
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.webContents.on('will-navigate', preventDefault)
        window.webContents.on('render-process-gone', () => options.callbacks.rendererGone(token))
      } catch (error) {
        throw new AvatarAllocationError(error)
      }
    },
    async load(token) {
      await resource(token).loadFile(options.html)
    },
    prepare(token, x, y, size, alwaysOnTop) {
      const window = resource(token)
      ignoreMouse(window)
      window.setAlwaysOnTop(alwaysOnTop)
      window.setSize(size.width, size.height)
      placeAt(window, x, y, size)
    },
    send(token, state) {
      resource(token).webContents.send('avatar-view:state', state)
    },
    show(token) {
      resource(token).showInactive()
    },
    hide(token) {
      resource(token).hide()
    },
    setPointerMode(token, inside) {
      const window = resource(token)
      if (inside) window.setIgnoreMouseEvents(false)
      else ignoreMouse(window)
    },
    setAlwaysOnTop(token, alwaysOnTop) {
      resource(token).setAlwaysOnTop(alwaysOnTop)
    },
    setPosition(token, x, y) {
      const window = resource(token)
      const [width = 0, height = 0] = window.getSize()
      placeAt(window, x, y, { width, height })
    },
    destroy(token) {
      resources.get(token)?.destroy()
    },
    isDestroyed(token) {
      const window = resources.get(token)
      return window === undefined || window.isDestroyed()
    },
    release(token) {
      resources.delete(token)
    },
    endpoint(token) {
      const window = resources.get(token)
      return window === undefined ? null : { webContents: window.webContents, generation: token }
    }
  }
}
