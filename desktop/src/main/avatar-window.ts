import { AVATAR_VIEW_CHANNELS, type AvatarViewState } from '../shared/avatar-view'

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
  getState(): AvatarViewState
  setPosition(x: number, y: number): void | Promise<void>
  setPointerInside(inside: boolean): void | Promise<void>
  reportError(message: string): void
  now?(): number
  rendererErrorBurst?: number
  rendererErrorRefillMs?: number
}

export interface AvatarWindowConstructionOptions {
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
  hide(): void
  loadFile(file: string): Promise<unknown>
  setAlwaysOnTop(alwaysOnTop: boolean): void
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: true }): void
  setPosition(x: number, y: number): void
  showInactive(): void
}

export interface AvatarWindowOptions {
  platform: string
  preload: string
  html: string
  alwaysOnTop: boolean
  createWindow(options: AvatarWindowConstructionOptions): AvatarBrowserWindow
  reportError(scope: string, message: string, error?: unknown): void
  onGeneration(generation: number): void
}

export interface AvatarWindow {
  show(): Promise<void>
  sendState(state: AvatarViewState): void
  setAlwaysOnTop(alwaysOnTop: boolean): void
  setPosition(x: number, y: number): void
  setPointerInside(inside: boolean): void
  hide(): void
  reload(): Promise<void>
  destroy(): void
  current(): AvatarViewWindowEndpoint | null
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
    requireCurrentSender(event, options.currentWindow())
    requireNoArguments(args)
    return options.getState()
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

export function createAvatarWindow(options: AvatarWindowOptions): AvatarWindow {
  let window: AvatarBrowserWindow | null = null
  let pendingWindow: { window: AvatarBrowserWindow; token: number } | null = null
  let creating: Promise<void> | null = null
  let creationToken = 0
  const destroyingWindows = new Set<AvatarBrowserWindow>()
  let disposed = false
  let generation = 0
  let pointerInside = false
  let alwaysOnTop = options.alwaysOnTop

  const applyPointerMode = (target: AvatarBrowserWindow): void => {
    if (pointerInside) target.setIgnoreMouseEvents(false)
    else target.setIgnoreMouseEvents(true, { forward: true })
  }

  const hideWindow = (target: AvatarBrowserWindow): void => {
    pointerInside = false
    applyPointerMode(target)
    target.hide()
  }

  const destroyWindow = (target: AvatarBrowserWindow): void => {
    destroyingWindows.add(target)
    target.destroy()
  }

  const invalidate = (): void => {
    creationToken += 1
    creating = null
    const pending = pendingWindow
    pendingWindow = null
    if (pending) destroyWindow(pending.window)
  }

  const destroyCurrent = (): void => {
    invalidate()
    const current = window
    window = null
    if (!current) return
    pointerInside = false
    applyPointerMode(current)
    destroyWindow(current)
  }

  const retire = (target: AvatarBrowserWindow, token: number): void => {
    const isCurrent = window === target
    const isPending = pendingWindow?.window === target
    if (!isCurrent && !isPending) return
    if (isCurrent) {
      window = null
      pointerInside = false
    }
    if (isPending) pendingWindow = null
    if (token === creationToken) {
      creationToken += 1
      creating = null
    }
    destroyWindow(target)
  }

  const create = async (token: number): Promise<void> => {
    if (options.platform !== 'win32' || disposed || token !== creationToken) return
    const next = options.createWindow({
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
    next.setIgnoreMouseEvents(true, { forward: true })
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    next.webContents.on('will-navigate', (event: unknown) => {
      if (typeof event === 'object' && event !== null && 'preventDefault' in event && typeof event.preventDefault === 'function') {
        event.preventDefault()
      }
    })
    pendingWindow = { window: next, token }
    next.webContents.on('render-process-gone', () => {
      options.reportError('avatar-window', 'Avatar renderer crashed')
      retire(next, token)
    })
    next.on('close', (event: unknown) => {
      if (destroyingWindows.has(next)) return
      if (typeof event === 'object' && event !== null && 'preventDefault' in event && typeof event.preventDefault === 'function') {
        event.preventDefault()
      }
      hideWindow(next)
    })
    next.on('closed', () => {
      destroyingWindows.delete(next)
      if (window === next) window = null
      if (pendingWindow?.window === next) {
        pendingWindow = null
        if (token === creationToken) {
          creationToken += 1
          creating = null
        }
      }
    })
    try {
      await next.loadFile(options.html)
      if (disposed || token !== creationToken || pendingWindow?.window !== next) return
      pendingWindow = null
      window = next
      generation += 1
      options.onGeneration(generation)
      if (disposed || token !== creationToken || window !== next) return
      next.showInactive()
    } catch (error) {
      if (pendingWindow?.window === next) {
        pendingWindow = null
        destroyWindow(next)
      }
      if (!disposed && token === creationToken) {
        options.reportError('avatar-window', 'Avatar renderer could not load', error)
      }
    }
  }

  const ensureCreated = async (): Promise<void> => {
    if (disposed || window !== null) return
    if (creating) return creating
    const token = creationToken
    const pending = create(token)
    creating = pending
    try {
      await pending
    } finally {
      if (creating === pending) creating = null
    }
  }

  return {
    async show() {
      if (disposed) return
      if (window !== null) {
        window.showInactive()
        return
      }
      await ensureCreated()
    },
    sendState(state) {
      window?.webContents.send('avatar-view:state', state)
    },
    setAlwaysOnTop(nextAlwaysOnTop) {
      alwaysOnTop = nextAlwaysOnTop
      window?.setAlwaysOnTop(alwaysOnTop)
    },
    setPosition(x, y) {
      window?.setPosition(x, y)
    },
    setPointerInside(inside) {
      pointerInside = inside
      if (window) applyPointerMode(window)
    },
    hide() {
      if (!window) return
      hideWindow(window)
    },
    async reload() {
      if (disposed) return
      destroyCurrent()
      await ensureCreated()
    },
    destroy() {
      disposed = true
      destroyCurrent()
    },
    current() {
      return window === null ? null : { webContents: window.webContents, generation }
    }
  }
}
