import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { reportError as deckReportError } from './log'
import { t, type SupportedLocale } from './i18n'
import {
  createApprovalWindowState,
  observeApprovalRead,
  requestApproval,
  settleApproval,
  type ApprovalWindowState
} from './approval-window-state'
import type { ApprovalDocument } from '../shared/approval-document'
import {
  APPROVAL_READER_ERROR_MAX_BYTES,
  APPROVAL_WINDOW_CHANNELS,
  type ApprovalPresentation,
  type ApprovalReadMetrics,
  type ApprovalVerdict,
  type ApprovalWindowSnapshot
} from '../shared/approval-window'

export interface ApprovalWindowWebContents {
  mainFrame: unknown
  send(channel: string, payload: unknown): void
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

export interface ApprovalWindowIpcEvent {
  sender: ApprovalWindowWebContents
  senderFrame: unknown
}

export type ApprovalWindowIpcHandler = (event: ApprovalWindowIpcEvent, ...args: unknown[]) => Promise<unknown>

export interface ApprovalWindowIpcMain {
  handle(channel: string, handler: ApprovalWindowIpcHandler): void
  removeHandler(channel: string): void
}

export interface ApprovalWindowNativeConstructionOptions<W = unknown> {
  width: number
  height: number
  show: false
  parent?: W
  modal?: true
  webPreferences: {
    preload: string
    partition: string
    sandbox: true
    contextIsolation: true
    nodeIntegration: false
    webviewTag: false
  }
}

export interface ApprovalWindowBrowserWindow {
  webContents: ApprovalWindowWebContents
  on(event: string, listener: (...args: unknown[]) => void): void
  show(): void
  destroy(): void
  isDestroyed(): boolean
  loadFile(file: string): Promise<unknown>
}

export interface ApprovalWindowLifecycle {
  closed(): void
  failed(): void
}

export interface ApprovalWindowNativeAdapter {
  open(generation: number, lifecycle: ApprovalWindowLifecycle): void
  close(generation: number): void
  endpoint(generation: number): ApprovalWindowWebContents | null
}

export interface ApprovalWindowSession {
  setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (allowed: boolean) => void, details: unknown) => void): void
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean): void
  on(event: 'will-download', listener: (event: unknown) => void): void
  clearStorageData(): Promise<void>
  clearCache(): Promise<void>
}

export interface ApprovalWindowNativeAdapterOptions<W extends ApprovalWindowBrowserWindow = ApprovalWindowBrowserWindow> {
  preload: string
  html: string
  /** The live main window the reader is modal to, or null to open it standalone. */
  parent(): W | null
  createWindow(options: ApprovalWindowNativeConstructionOptions<W>): W
  sessionFromPartition(partition: string): ApprovalWindowSession
  reportError(scope: string, message: string, error?: unknown): void
}

export interface ApprovalWindowControllerOptions {
  ipc: ApprovalWindowIpcMain
  native: ApprovalWindowNativeAdapter
  reportError?(scope: string, message: string, error?: unknown): void
  onVerdict?(verdict: ApprovalVerdict): void
  /** Localised interface text of the reader, resolved when the reader asks for its state. */
  presentation(document: ApprovalDocument): ApprovalPresentation
  now?(): number
  rendererErrorBurst?: number
  rendererErrorRefillMs?: number
}

export interface ApprovalRouteSpec {
  approveIndex: number | null
  document: ApprovalDocument
}

export interface ApprovalRouteReader {
  open(document: ApprovalDocument, onVerdict: (approved: boolean) => void): { kind: 'opened' | 'busy' }
}

export async function routeApproval<T extends ApprovalRouteSpec>(
  spec: T,
  deps: { native(spec: T): Promise<boolean>; reader: ApprovalRouteReader; report(error: unknown): void }
): Promise<boolean> {
  if (spec.approveIndex !== null) return await deps.native(spec)
  return await new Promise<boolean>((resolve) => {
    try {
      if (deps.reader.open(spec.document, resolve).kind === 'busy') resolve(false)
    } catch (error) {
      deps.report(error)
      resolve(false)
    }
  })
}

export function approvalWindowAssets(mainDir: string): { preload: string; html: string } {
  return {
    preload: join(mainDir, '../preload/approval.js'),
    html: join(mainDir, '../renderer/approval.html')
  }
}

function preventDefault(event: unknown): void {
  if (typeof event === 'object' && event !== null && 'preventDefault' in event && typeof event.preventDefault === 'function') {
    event.preventDefault()
  }
}

export function createApprovalNativeAdapter<W extends ApprovalWindowBrowserWindow>(options: ApprovalWindowNativeAdapterOptions<W>): ApprovalWindowNativeAdapter {
  const windows = new Map<number, ApprovalWindowBrowserWindow>()
  const partition = () => `approval-window:${randomUUID()}`

  return {
    open(generation, lifecycle) {
      let window: ApprovalWindowBrowserWindow
      try {
        const ephemeralPartition = partition()
        const approvalSession = options.sessionFromPartition(ephemeralPartition)
        approvalSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
        approvalSession.setPermissionCheckHandler(() => false)
        approvalSession.on('will-download', (event) => preventDefault(event))
        const parent = options.parent()
        window = options.createWindow({
          width: 640,
          height: 700,
          show: false,
          ...(parent === null ? {} : { parent, modal: true as const }),
          webPreferences: {
            preload: options.preload,
            partition: ephemeralPartition,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false
          }
        })
        windows.set(generation, window)
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.on('ready-to-show', () => window.show())
        window.on('close', () => lifecycle.closed())
        window.on('closed', () => {
          windows.delete(generation)
          void Promise.all([approvalSession.clearStorageData(), approvalSession.clearCache()]).catch((error) => {
            options.reportError('approval-window', 'Approval window session cleanup failed', error)
          })
          lifecycle.closed()
        })
        let loaded = false
        window.webContents.on('did-finish-load', () => { loaded = true })
        window.webContents.on('did-start-navigation', (details) => {
          if (!loaded || !isRecord(details) || details.isMainFrame !== true) return
          options.reportError('approval-window', 'Approval window reload was refused')
          lifecycle.failed()
        })
        window.webContents.on('will-navigate', (event) => {
          preventDefault(event)
          options.reportError('approval-window', 'Approval window navigation was refused')
          lifecycle.failed()
        })
        window.webContents.on('will-frame-navigate', (event) => {
          preventDefault(event)
          options.reportError('approval-window', 'Approval window frame navigation was refused')
          lifecycle.failed()
        })
        window.webContents.on('render-process-gone', () => {
          options.reportError('approval-window', 'Approval window renderer crashed')
          lifecycle.failed()
        })
        window.webContents.on('preload-error', (_event, _path, error) => {
          options.reportError('approval-window', 'Approval window preload failed', error)
          lifecycle.failed()
        })
      } catch (error) {
        options.reportError('approval-window', 'Approval window setup failed', error)
        lifecycle.failed()
        return
      }
      void window.loadFile(options.html).catch((error) => {
        options.reportError('approval-window', 'Approval window failed to load', error)
        lifecycle.failed()
      })
    },
    close(generation) {
      const window = windows.get(generation)
      if (window && !window.isDestroyed()) window.destroy()
    },
    endpoint(generation) {
      return windows.get(generation)?.webContents ?? null
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireCurrentSender(
  event: ApprovalWindowIpcEvent,
  state: ApprovalWindowState,
  native: ApprovalWindowNativeAdapter,
  reportRejected: (scope: string, message: string, error?: unknown) => void
): void {
  const current = state.current
  const endpoint = current === null ? null : native.endpoint(current.generation)
  if (endpoint === null || event.sender !== endpoint || event.senderFrame !== endpoint.mainFrame) {
    reportRejected('approval-window', 'Approval window sender was rejected')
    throw new Error('Approval window sender is not current')
  }
}

function requireNoArguments(args: unknown[]): void {
  if (args.length !== 0) throw new Error('Approval window state does not accept arguments')
}

function readIntent(args: unknown[]): { generation: number; fingerprint: string; metrics: ApprovalReadMetrics } {
  const value = args[0]
  if (args.length !== 1 || !isRecord(value) || !isRecord(value.metrics) || typeof value.generation !== 'number' || typeof value.fingerprint !== 'string') {
    throw new Error('Approval window read intent is invalid')
  }
  const metrics = value.metrics
  const { viewportHeight, scrollHeight, scrollTop } = metrics
  if (typeof viewportHeight !== 'number' || typeof scrollHeight !== 'number' || typeof scrollTop !== 'number') {
    throw new Error('Approval window read intent is invalid')
  }
  return { generation: value.generation, fingerprint: value.fingerprint, metrics: { viewportHeight, scrollHeight, scrollTop } }
}

/** Cuts at a code point boundary, so a truncated report never ends in half a UTF-8 sequence. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

/** C0, DEL and C1 become visible \xNN, so a report cannot break the log line or forge a prefix or an escape sequence. */
export function neutralizeControls(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? `\\x${code.toString(16).padStart(2, '0')}` : char
  }
  return out
}

export function approvalReaderPresentation(dict: Record<string, string>, lang: SupportedLocale): ApprovalPresentation {
  return {
    lang,
    text: {
      regionLabel: t(dict, 'approvalReader.regionLabel'),
      unreached: t(dict, 'approvalReader.unreached'),
      reached: t(dict, 'approvalReader.reached'),
      readFailed: t(dict, 'approvalReader.readFailed'),
      verdictFailed: t(dict, 'approvalReader.verdictFailed')
    }
  }
}

function readerErrorMessage(args: unknown[]): string {
  if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('Approval window error report is invalid')
  return truncateUtf8(neutralizeControls(args[0]), APPROVAL_READER_ERROR_MAX_BYTES)
}

function verdictIntent(args: unknown[]): { generation: number; fingerprint: string; verdict: unknown } {
  const value = args[0]
  if (args.length !== 1 || !isRecord(value) || typeof value.generation !== 'number' || typeof value.fingerprint !== 'string') {
    throw new Error('Approval window verdict intent is invalid')
  }
  return { generation: value.generation, fingerprint: value.fingerprint, verdict: value.verdict }
}

export function createApprovalWindowController(options: ApprovalWindowControllerOptions): {
  open(document: ApprovalDocument, onVerdict?: (verdict: ApprovalVerdict) => void): { kind: 'opened'; generation: number } | { kind: 'busy' }
  dispose(): void
} {
  const reportError = options.reportError ?? deckReportError
  const verdictCallbacks = new Map<number, (verdict: ApprovalVerdict) => void>()
  const now = options.now ?? Date.now
  let state = createApprovalWindowState()
  let rejectedSeen = false
  let rejectedGeneration: number | null = null
  let rejectedAt = 0
  let rejectedSuppressed = 0
  const reportRejectedSender = (scope: string, message: string): void => {
    const generation = state.current?.generation ?? null
    const at = now()
    if (!rejectedSeen || rejectedGeneration !== generation) {
      rejectedSeen = true
      rejectedGeneration = generation
      rejectedAt = at
      rejectedSuppressed = 0
      reportError(scope, message)
      return
    }
    if (at - rejectedAt >= 1_000) {
      if (rejectedSuppressed > 0) reportError(scope, `${rejectedSuppressed} rejected senders suppressed`)
      rejectedAt = at
      rejectedSuppressed = 0
      reportError(scope, message)
      return
    }
    rejectedSuppressed += 1
  }

  const settle = (generation: number, verdict: ApprovalVerdict, closeWindow: boolean): void => {
    const current = state.current
    if (current === null || current.generation !== generation) return
    const result = settleApproval(state, { generation, fingerprint: current.fingerprint, verdict })
    state = result.state
    if (!result.accepted || result.verdict === null) return
    if (closeWindow) options.native.close(generation)
    try {
      verdictCallbacks.get(generation)?.(result.verdict)
    } catch (error) {
      reportError('approval-window', 'Approval window verdict delivery failed', error)
    } finally {
      verdictCallbacks.delete(generation)
    }
  }

  const getState: ApprovalWindowIpcHandler = async (event, ...args): Promise<ApprovalWindowSnapshot> => {
    requireCurrentSender(event, state, options.native, reportRejectedSender)
    requireNoArguments(args)
    const current = state.current!
    let presentation: ApprovalPresentation
    try {
      presentation = options.presentation(current.document)
    } catch (error) {
      reportError('approval-window', 'Approval window presentation failed', error)
      throw error
    }
    return { generation: current.generation, fingerprint: current.fingerprint, document: current.document, presentation }
  }

  const read: ApprovalWindowIpcHandler = async (event, ...args): Promise<void> => {
    requireCurrentSender(event, state, options.native, reportRejectedSender)
    const transition = observeApprovalRead(state, readIntent(args))
    state = transition.state
    if (!transition.accepted) throw new Error('Approval window reading observation was rejected')
  }

  const verdict: ApprovalWindowIpcHandler = async (event, ...args): Promise<void> => {
    requireCurrentSender(event, state, options.native, reportRejectedSender)
    const result = settleApproval(state, verdictIntent(args))
    state = result.state
    if (!result.accepted || result.verdict === null) {
      reportError('approval-window', `Rejected approval-window verdict: ${result.reason}`)
      throw new Error(result.reason)
    }
    options.native.close(result.state.generation)
    try {
      verdictCallbacks.get(result.state.generation)?.(result.verdict)
    } catch (error) {
      reportError('approval-window', 'Approval window verdict delivery failed', error)
    } finally {
      verdictCallbacks.delete(result.state.generation)
    }
  }

  const burst = options.rendererErrorBurst ?? 5
  const refillMs = options.rendererErrorRefillMs ?? 1_000
  let bucketGeneration: number | null = null
  let available = burst
  let lastRefillAt = 0
  let suppressed = 0
  let saturationReported = false

  const rendererError: ApprovalWindowIpcHandler = async (event, ...args): Promise<void> => {
    requireCurrentSender(event, state, options.native, reportRejectedSender)
    const message = readerErrorMessage(args)
    const generation = state.current!.generation
    const at = now()
    if (bucketGeneration !== generation) {
      bucketGeneration = generation
      available = burst
      lastRefillAt = at
      suppressed = 0
      saturationReported = false
    } else {
      const replenished = Math.floor(Math.max(0, at - lastRefillAt) / refillMs)
      if (replenished > 0) {
        available = Math.min(burst, available + replenished)
        lastRefillAt += replenished * refillMs
      }
    }
    if (available < 1) {
      suppressed += 1
      if (!saturationReported) {
        saturationReported = true
        reportError('approval-window', 'approval-reader: error reports saturated, dropping until the rate limit refills')
      }
      return
    }
    available -= 1
    const dropped = suppressed > 0 ? `${suppressed} reports dropped; ` : ''
    suppressed = 0
    reportError('approval-window', `approval-reader: ${dropped}${message}`)
  }

  options.ipc.handle(APPROVAL_WINDOW_CHANNELS.getState, getState)
  options.ipc.handle(APPROVAL_WINDOW_CHANNELS.read, read)
  options.ipc.handle(APPROVAL_WINDOW_CHANNELS.verdict, verdict)
  options.ipc.handle(APPROVAL_WINDOW_CHANNELS.reportError, rendererError)

  return {
    open(document, onVerdict = options.onVerdict ?? (() => {})) {
      const request = requestApproval(state, document)
      state = request.state
      if (request.kind === 'busy') return { kind: 'busy' }
      verdictCallbacks.set(request.current.generation, onVerdict)
      try {
        options.native.open(request.current.generation, {
          closed: () => settle(request.current.generation, 'refuse', false),
          failed: () => settle(request.current.generation, 'refuse', true)
        })
      } catch (error) {
        reportError('approval-window', 'Approval window could not open', error)
        settle(request.current.generation, 'refuse', false)
      }
      return { kind: 'opened', generation: request.current.generation }
    },
    dispose() {
      options.ipc.removeHandler(APPROVAL_WINDOW_CHANNELS.getState)
      options.ipc.removeHandler(APPROVAL_WINDOW_CHANNELS.read)
      options.ipc.removeHandler(APPROVAL_WINDOW_CHANNELS.verdict)
      options.ipc.removeHandler(APPROVAL_WINDOW_CHANNELS.reportError)
      const current = state.current
      if (current !== null) settle(current.generation, 'refuse', true)
    }
  }
}
