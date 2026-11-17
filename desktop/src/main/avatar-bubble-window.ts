import {
  AVATAR_BUBBLE_CHANNELS,
  AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS,
  avatarBubbleCardKey,
  avatarBubbleGestures,
  projectAvatarBubble,
  safeLine,
  type AvatarBubbleAnchor,
  type AvatarBubbleBox,
  type AvatarBubbleDeck,
  type AvatarBubbleLost,
  type AvatarBubbleModel,
  type AvatarBubbleState,
  type AvatarBubbleTheme
} from '../shared/avatar-bubble-view'
import { parseAvatarInboxAction } from '../shared/avatar-inbox-protocol'
import type { AvatarDeckIdentity } from '../shared/avatar-state'
import type { AvatarInboxGestureResult } from './avatar-inbox-service'
import type { ApprovalWindowSession } from './approval-window'

export interface AvatarBubbleWebContents {
  mainFrame: unknown
  send(channel: string, payload: unknown): void
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

export interface AvatarBubbleIpcEvent {
  sender: unknown
  senderFrame: unknown
}

export type AvatarBubbleIpcHandler = (event: AvatarBubbleIpcEvent, ...args: unknown[]) => Promise<unknown>

export interface AvatarBubbleIpcMain {
  handle(channel: string, handler: AvatarBubbleIpcHandler): void
  removeHandler(channel: string): void
}

export interface AvatarBubbleLifecycle {
  closed(): void
}

export interface AvatarBubbleRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AvatarBubbleNativeAdapter {
  open(generation: number, rect: AvatarBubbleRect, lifecycle: AvatarBubbleLifecycle): void
  focus(generation: number): void
  close(generation: number): void
  endpoint(generation: number): AvatarBubbleWebContents | null
}

export interface AvatarBubblePlacement {
  rect: AvatarBubbleRect
  anchor: AvatarBubbleAnchor
}

/** 380 x 560 of bubble plus the 8 px margin on the mask side where the renderer draws the tail. */
export const AVATAR_BUBBLE_SIZE = { width: 388, height: 560 } as const
const RENDERER_ERROR_MAX_CHARS = 2_048
const DICT_PREFIXES = ['avatarBubble.', 'inbox.'] as const

/** Against the mask on the side with room (left first), bottom edges aligned, kept inside the work area. */
export function avatarBubblePlacement(mask: AvatarBubbleRect, workArea: AvatarBubbleRect): AvatarBubblePlacement {
  const width = Math.min(AVATAR_BUBBLE_SIZE.width, workArea.width)
  const height = Math.min(AVATAR_BUBBLE_SIZE.height, workArea.height)
  const left = mask.x - width
  const anchor: AvatarBubbleAnchor = left >= workArea.x ? 'right' : 'left'
  const x = anchor === 'right' ? left : mask.x + mask.width
  const y = mask.y + mask.height - height
  return {
    rect: {
      x: Math.round(Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width)),
      y: Math.round(Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height)),
      width,
      height
    },
    anchor
  }
}

/** The bubble's own keys and the Courrier's, so the renderer never reads the rest of the Deck's text. */
export function avatarBubbleDict(dict: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(dict).filter(([key]) => DICT_PREFIXES.some((prefix) => key.startsWith(prefix))))
}

export interface AvatarBubbleWindowConstructionOptions {
  x: number
  y: number
  width: number
  height: number
  resizable: false
  maximizable: false
  minimizable: false
  fullscreenable: false
  frame: false
  transparent: true
  alwaysOnTop: true
  skipTaskbar: true
  focusable: true
  show: false
  webPreferences: {
    preload: string
    partition: string
    sandbox: true
    contextIsolation: true
    nodeIntegration: false
    webviewTag: false
  }
}

export interface AvatarBubbleBrowserWindow {
  webContents: AvatarBubbleWebContents
  on(event: string, listener: (...args: unknown[]) => void): void
  show(): void
  focus(): void
  destroy(): void
  isDestroyed(): boolean
  loadFile(file: string): Promise<unknown>
}

export interface AvatarBubbleNativeAdapterOptions {
  preload: string
  html: string
  runId: string
  createWindow(options: AvatarBubbleWindowConstructionOptions): AvatarBubbleBrowserWindow
  sessionFromPartition(partition: string): ApprovalWindowSession
  reportError(scope: string, message: string, error?: unknown): void
}

function preventDefault(event: unknown): void {
  if (typeof event === 'object' && event !== null && 'preventDefault' in event && typeof event.preventDefault === 'function') {
    event.preventDefault()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Escape, a click elsewhere (blur), a navigation or a crashed renderer closes the bubble. */
export function createAvatarBubbleNativeAdapter(options: AvatarBubbleNativeAdapterOptions): AvatarBubbleNativeAdapter {
  const windows = new Map<number, AvatarBubbleBrowserWindow>()
  const close = (generation: number): void => {
    const window = windows.get(generation)
    if (window && !window.isDestroyed()) window.destroy()
  }

  // One partition per Avatar run: Electron never destroys a session made by fromPartition, and the bubble opens on every click.
  const partition = `avatar-bubble:${options.runId}`
  let runSession: ApprovalWindowSession | null = null
  const sessionOfRun = (): ApprovalWindowSession => {
    if (runSession !== null) return runSession
    const created = options.sessionFromPartition(partition)
    created.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    created.setPermissionCheckHandler(() => false)
    created.on('will-download', (event) => preventDefault(event))
    runSession = created
    return created
  }

  return {
    open(generation, rect, lifecycle) {
      let window: AvatarBubbleBrowserWindow
      let bubbleSession: ApprovalWindowSession
      try {
        bubbleSession = sessionOfRun()
        window = options.createWindow({
          ...rect,
          resizable: false,
          maximizable: false,
          minimizable: false,
          fullscreenable: false,
          frame: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
          focusable: true,
          show: false,
          webPreferences: {
            preload: options.preload,
            partition,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false
          }
        })
      } catch (error) {
        options.reportError('avatar-bubble', 'Avatar bubble window could not be created', error)
        lifecycle.closed()
        return
      }
      windows.set(generation, window)
      window.on('closed', () => {
        windows.delete(generation)
        void Promise.all([bubbleSession.clearStorageData(), bubbleSession.clearCache()]).catch((error: unknown) => {
          options.reportError('avatar-bubble', 'Avatar bubble session cleanup failed', error)
        })
        lifecycle.closed()
      })
      try {
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.on('ready-to-show', () => {
          window.show()
          window.focus()
        })
        window.on('blur', () => close(generation))
        window.webContents.on('before-input-event', (_event, input) => {
          if (isRecord(input) && input.type === 'keyDown' && input.key === 'Escape') close(generation)
        })
        window.webContents.on('will-navigate', (event) => {
          preventDefault(event)
          options.reportError('avatar-bubble', 'Avatar bubble navigation was refused')
          close(generation)
        })
        window.webContents.on('render-process-gone', () => {
          options.reportError('avatar-bubble', 'Avatar bubble renderer crashed')
          close(generation)
        })
        window.webContents.on('preload-error', (_event, _path, error) => {
          options.reportError('avatar-bubble', 'Avatar bubble preload failed', error)
          close(generation)
        })
      } catch (error) {
        options.reportError('avatar-bubble', 'Avatar bubble window setup failed', error)
        close(generation)
        return
      }
      void window.loadFile(options.html).catch((error: unknown) => {
        options.reportError('avatar-bubble', 'Avatar bubble failed to load', error)
        close(generation)
      })
    },
    focus(generation) {
      const window = windows.get(generation)
      if (window && !window.isDestroyed()) window.focus()
    },
    close,
    endpoint(generation) {
      return windows.get(generation)?.webContents ?? null
    }
  }
}

export interface AvatarBubbleWindowOptions {
  ipc: AvatarBubbleIpcMain
  native: AvatarBubbleNativeAdapter
  boxes(): readonly AvatarBubbleBox[]
  decks(): readonly AvatarBubbleDeck[]
  act: (identity: AvatarDeckIdentity, action: ReturnType<typeof parseAvatarInboxAction>) => Promise<AvatarInboxGestureResult>
  focusDeck(identity: AvatarDeckIdentity): Promise<void>
  theme(): AvatarBubbleTheme
  lang: 'en' | 'fr'
  dict: Record<string, string>
  /** Where the bubble opens against the mask; null when the mask is not shown. */
  placement(): AvatarBubblePlacement | null
  now(): number
  /** Returns a cancel function. */
  setTimer(callback: () => void, ms: number): () => void
  reportError(scope: string, message: string, error?: unknown): void
  rendererErrorBurst?: number
  rendererErrorRefillMs?: number
}

export interface AvatarBubbleWindow {
  open(): void
  close(): void
  /** The inbox, the attached Decks or the theme changed: the open bubble gets the new state. */
  changed(): void
  dispose(): void
}

function sameDeck(a: AvatarDeckIdentity, b: AvatarDeckIdentity): boolean {
  return a.deckRunId === b.deckRunId && a.broker_url === b.broker_url
}

function readIdentity(value: Record<string, unknown>): AvatarDeckIdentity {
  if (typeof value.deckRunId !== 'string' || typeof value.broker_url !== 'string') throw new Error('Avatar bubble intent names no Deck')
  return { deckRunId: value.deckRunId, broker_url: value.broker_url }
}

export function createAvatarBubbleWindow(options: AvatarBubbleWindowOptions): AvatarBubbleWindow {
  let generation = 0
  let current: number | null = null
  let anchor: AvatarBubbleAnchor = 'right'
  let lost: AvatarBubbleLost[] = []
  let lastModel: AvatarBubbleModel | null = null
  let closeWhenEmpty = false
  let cancelExpiry: (() => void) | null = null
  const burst = options.rendererErrorBurst ?? 5
  const refillMs = options.rendererErrorRefillMs ?? 1_000
  let available = burst
  let lastRefillAt = 0
  let suppressed = 0

  const model = (): AvatarBubbleModel => {
    const now = options.now()
    const projected = projectAvatarBubble({ boxes: options.boxes(), decks: options.decks(), lost, now })
    lost = lost.filter((entry) => now - entry.at < AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS)
    lastModel = projected
    return projected
  }

  const state = (open: number): AvatarBubbleState => ({
    generation: open,
    theme: options.theme(),
    lang: options.lang,
    dict: options.dict,
    anchor,
    model: model()
  })

  const close = (): void => {
    if (current === null) return
    const open = current
    current = null
    cancelExpiry?.()
    cancelExpiry = null
    options.native.close(open)
  }

  const push = (): void => {
    if (current === null) return
    const next = state(current)
    cancelExpiry?.()
    cancelExpiry = null
    if (closeWhenEmpty && next.model.reclame.length === 0) {
      close()
      return
    }
    if (next.model.nextChangeAt !== null) {
      cancelExpiry = options.setTimer(push, Math.max(0, next.model.nextChangeAt - options.now()))
    }
    try {
      options.native.endpoint(current)?.send(AVATAR_BUBBLE_CHANNELS.state, next)
    } catch (error) {
      options.reportError('avatar-bubble', 'Avatar bubble state could not be sent', error)
    }
  }

  const requireCurrent = (event: AvatarBubbleIpcEvent): number => {
    const open = current
    const endpoint = open === null ? null : options.native.endpoint(open)
    if (open === null || endpoint === null || event.sender !== endpoint || event.senderFrame !== endpoint.mainFrame) {
      options.reportError('avatar-bubble', 'Avatar bubble sender was rejected')
      throw new Error('Avatar bubble sender is not current')
    }
    return open
  }

  const requireIntent = (open: number, args: unknown[]): Record<string, unknown> => {
    const value = args[0]
    if (args.length !== 1 || !isRecord(value) || value.generation !== open) throw new Error('Avatar bubble intent is invalid')
    return value
  }

  const refuse = (message: string): never => {
    options.reportError('avatar-bubble', message)
    throw new Error(message)
  }

  const getState: AvatarBubbleIpcHandler = async (event, ...args) => {
    const open = requireCurrent(event)
    if (args.length !== 0) throw new Error('Avatar bubble state does not accept arguments')
    return state(open)
  }

  const act: AvatarBubbleIpcHandler = async (event, ...args) => {
    const open = requireCurrent(event)
    const intent = requireIntent(open, args)
    const identity = readIdentity(intent)
    let action: ReturnType<typeof parseAvatarInboxAction>
    try {
      action = parseAvatarInboxAction(intent.action)
    } catch (error) {
      return refuse(`Avatar bubble gesture was refused: ${error instanceof Error ? error.message : 'invalid'}`)
    }
    const box = options.boxes().find((candidate) => sameDeck(candidate.identity, identity))
    const approval = box?.approvals.find((candidate) => candidate.id === action.approval_id)
    if (!box || !approval || box.settledLocally.has(approval.id)) return refuse('Avatar bubble gesture names an entry the inbox does not hold')
    if (!avatarBubbleGestures(approval).includes(action.action)) return refuse(`Avatar bubble ${action.action} gesture is not offered on this entry`)
    const result = await options.act(identity, action)
    if (result.outcome === 'lost') {
      const key = avatarBubbleCardKey(identity, approval.id)
      const card = lastModel?.reclame.find((candidate) => candidate.key === key)
      if (card) lost = [...lost.filter((entry) => entry.card.key !== key), { card, at: options.now() }]
    }
    if (result.outcome === 'won' || result.outcome === 'lost') closeWhenEmpty = true
    if (current === open) push()
    return result
  }

  const focusDeck: AvatarBubbleIpcHandler = async (event, ...args) => {
    const open = requireCurrent(event)
    const identity = readIdentity(requireIntent(open, args))
    if (!options.decks().some((deck) => sameDeck(deck, identity))) return refuse('Avatar bubble focus names a Deck that is not attached')
    await options.focusDeck(identity)
  }

  const closeHandler: AvatarBubbleIpcHandler = async (event, ...args) => {
    requireCurrent(event)
    if (args.length !== 0) throw new Error('Avatar bubble close does not accept arguments')
    close()
  }

  const rendererError: AvatarBubbleIpcHandler = async (event, ...args) => {
    requireCurrent(event)
    if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('Avatar bubble error report is invalid')
    const at = options.now()
    const replenished = Math.floor(Math.max(0, at - lastRefillAt) / refillMs)
    if (replenished > 0) {
      available = Math.min(burst, available + replenished)
      lastRefillAt += replenished * refillMs
    }
    if (available < 1) {
      suppressed += 1
      return
    }
    available -= 1
    const dropped = suppressed > 0 ? `${suppressed} reports dropped; ` : ''
    suppressed = 0
    options.reportError('avatar-bubble', `avatar-bubble renderer: ${dropped}${safeLine(args[0].slice(0, RENDERER_ERROR_MAX_CHARS))}`)
  }

  options.ipc.handle(AVATAR_BUBBLE_CHANNELS.getState, getState)
  options.ipc.handle(AVATAR_BUBBLE_CHANNELS.act, act)
  options.ipc.handle(AVATAR_BUBBLE_CHANNELS.focusDeck, focusDeck)
  options.ipc.handle(AVATAR_BUBBLE_CHANNELS.close, closeHandler)
  options.ipc.handle(AVATAR_BUBBLE_CHANNELS.reportError, rendererError)

  return {
    open() {
      if (current !== null) {
        options.native.focus(current)
        return
      }
      const placement = options.placement()
      if (placement === null) {
        options.reportError('avatar-bubble', 'Avatar bubble was not opened because the mask is not shown')
        return
      }
      generation += 1
      const open = generation
      current = open
      anchor = placement.anchor
      closeWhenEmpty = false
      lost = []
      options.native.open(open, placement.rect, {
        closed: () => {
          if (current === open) {
            current = null
            cancelExpiry?.()
            cancelExpiry = null
          }
        }
      })
    },
    close,
    changed: push,
    dispose() {
      close()
      options.ipc.removeHandler(AVATAR_BUBBLE_CHANNELS.getState)
      options.ipc.removeHandler(AVATAR_BUBBLE_CHANNELS.act)
      options.ipc.removeHandler(AVATAR_BUBBLE_CHANNELS.focusDeck)
      options.ipc.removeHandler(AVATAR_BUBBLE_CHANNELS.close)
      options.ipc.removeHandler(AVATAR_BUBBLE_CHANNELS.reportError)
    }
  }
}
