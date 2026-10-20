import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadDict } from '../desktop/src/main/i18n.ts'
import {
  approvalReaderPresentation,
  approvalWindowAssets,
  createApprovalNativeAdapter,
  routeApproval,
  createApprovalWindowController,
  type ApprovalWindowIpcHandler,
  type ApprovalWindowNativeAdapter,
  type ApprovalWindowNativeConstructionOptions
} from '../desktop/src/main/approval-window.ts'
import {
  APPROVAL_READER_ERROR_MAX_BYTES,
  APPROVAL_WINDOW_CHANNELS,
  type ApprovalPresentation,
  type ApprovalWindowSnapshot
} from '../desktop/src/shared/approval-window.ts'
import type { ApprovalDocument } from '../desktop/src/shared/approval-document.ts'

const document: ApprovalDocument = Object.freeze({
  message: 'Run this command?',
  detail: '01| npm run dev',
  approve: 'Run',
  refuse: 'Refuse',
  close: 'Close'
})

const presentation: ApprovalPresentation = {
  lang: 'en',
  text: { regionLabel: 'Full text', unreached: 'Not reached', reached: 'Reached', readFailed: 'Read failed', verdictFailed: 'Verdict failed' }
}

type Listener = (...args: unknown[]) => void

class FakeWindow {
  readonly listeners = new Map<string, Listener>()

  constructor(private readonly loadFailure = false) {}
  readonly webContents = {
    mainFrame: {},
    setWindowOpenHandler: (_handler: () => { action: 'deny' }) => {},
    on: (event: string, listener: Listener) => { this.listeners.set(`contents:${event}`, listener) },
    send: (_channel: string, _payload: unknown) => {}
  }
  loaded: string | null = null
  destroyed = false
  shown = false
  readonly prevented: string[] = []

  on(event: string, listener: Listener): void {
    this.listeners.set(event, listener)
  }

  show(): void {
    this.shown = true
  }

  destroy(): void {
    this.destroyed = true
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  loadFile(file: string): Promise<void> {
    this.loaded = file
    return this.loadFailure ? Promise.reject(new Error('load failed')) : Promise.resolve()
  }

  fire(event: string, ...args: unknown[]): void {
    this.fireWithDetails(event, {}, ...args)
  }

  fireWithDetails(event: string, details: Record<string, unknown>, ...args: unknown[]): void {
    this.listeners.get(event)?.({ ...details, preventDefault: () => { this.prevented.push(event) } }, ...args)
  }
}

class FakeSession {
  requestHandler: ((webContents: unknown, permission: string, callback: (allowed: boolean) => void, details: unknown) => void) | null = null
  readonly listeners = new Map<string, Listener>()
  storageCleared = false
  cacheCleared = false
  constructor(readonly partition: string) {}
  checkHandler: ((webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) | null = null

  setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (allowed: boolean) => void, details: unknown) => void): void {
    this.requestHandler = handler
  }

  setPermissionCheckHandler(handler: (webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean): void {
    this.checkHandler = handler
  }

  on(event: string, listener: Listener): void {
    this.listeners.set(event, listener)
  }

  async clearStorageData(): Promise<void> {
    this.storageCleared = true
  }

  async clearCache(): Promise<void> {
    this.cacheCleared = true
  }
}

interface Limits { now(): number; rendererErrorBurst: number; rendererErrorRefillMs: number }

function harness(loadFailure = false, view: ApprovalPresentation = presentation, limits: Partial<Limits> = {}, parent: () => FakeWindow | null = () => null) {
  const handlers = new Map<string, ApprovalWindowIpcHandler>()
  const windows: FakeWindow[] = []
  const sessions: FakeSession[] = []
  const constructed: ApprovalWindowNativeConstructionOptions<FakeWindow>[] = []
  const reports: string[] = []
  const verdicts: string[] = []
  const native = createApprovalNativeAdapter({
    preload: 'approval-preload.js',
    html: 'approval.html',
    parent,
    createWindow(options) {
      constructed.push(options)
      const window = new FakeWindow(loadFailure)
      windows.push(window)
      return window
    },
    sessionFromPartition: (partition) => {
      const session = new FakeSession(partition)
      sessions.push(session)
      return session
    },
    reportError: (_scope, message) => { reports.push(message) }
  })
  const controller = createApprovalWindowController({
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => { handlers.delete(channel) }
    },
    native,
    reportError: (_scope, message) => { reports.push(message) },
    onVerdict: (verdict) => { verdicts.push(verdict) },
    presentation: () => view,
    ...limits
  })
  return { controller, constructed, handlers, reports, sessions, verdicts, windows }
}

test('resolves the built approval preload and page from the main output directory', () => {
  expect(approvalWindowAssets('desktop/out/main')).toEqual({
    preload: join('desktop/out/main', '../preload/approval.js'),
    html: join('desktop/out/main', '../renderer/approval.html')
  })
})

// bun's per-test timeout does not fail an await that never settles, so a promise a mutant leaves pending must read 'pending' instead of hanging the file.
const settledWithin = (promise: Promise<unknown>): Promise<string> =>
  Promise.race([promise.then(String), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0))])

test('routes short approval to native and long approval only to the reader', async () => {
  let nativeCalls = 0
  let readerCalls = 0
  const reports: unknown[] = []
  const report = (error: unknown): void => { reports.push(error) }
  const reader = { open: (_document: ApprovalDocument, settle: (approved: boolean) => void) => { readerCalls++; settle(true); return { kind: 'opened' as const } } }
  expect(await settledWithin(routeApproval({ approveIndex: 0, document }, { native: async () => { nativeCalls++; return true }, reader, report }))).toBe('true')
  expect(await settledWithin(routeApproval({ approveIndex: null, document }, { native: async () => { nativeCalls++; return true }, reader, report }))).toBe('true')
  expect(nativeCalls).toBe(1)
  expect(readerCalls).toBe(1)
  expect(reports).toEqual([])
})

test('refuses busy or synchronously failing approval readers, tracing the failure', async () => {
  const native = async () => true
  const reports: unknown[] = []
  const report = (error: unknown): void => { reports.push(error) }
  expect(await settledWithin(routeApproval({ approveIndex: null, document }, { native, reader: { open: () => ({ kind: 'busy' }) }, report }))).toBe('false')
  expect(reports, 'a busy reader is a refusal, not a failure').toEqual([])
  const failure = new Error('open failed')
  expect(await settledWithin(routeApproval({ approveIndex: null, document }, { native, reader: { open: () => { throw failure } }, report }))).toBe('false')
  expect(reports, 'a reader that fails to open must leave a trace').toEqual([failure])
})

test('settles the opened approval when a second reader request is busy', async () => {
  const { controller, windows } = harness()
  const reader = {
    open: (approval: ApprovalDocument, settle: (approved: boolean) => void) =>
      controller.open(approval, (verdict) => settle(verdict === 'approve'))
  }
  const reports: unknown[] = []
  const report = (error: unknown): void => { reports.push(error) }
  const first = routeApproval({ approveIndex: null, document }, { native: async () => true, reader, report })
  expect(await settledWithin(routeApproval({ approveIndex: null, document }, { native: async () => true, reader, report })), 'the busy request is refused').toBe('false')
  windows[0]!.fire('closed')
  expect(await settledWithin(first), 'the open approval must receive its own refusal').toBe('false')
  expect(reports).toEqual([])
})

test('uses an ephemeral hardened partition and bounds traces for foreign or subframe IPC', async () => {
  let clock = 0
  const { controller, constructed, handlers, reports, sessions, windows } = harness(false, presentation, { now: () => clock })
  expect(controller.open(document)).toEqual({ kind: 'opened', generation: 1 })

  const options = constructed[0]!
  expect(options.webPreferences).toMatchObject({
    preload: 'approval-preload.js',
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false
  })
  expect(options.webPreferences.partition).toMatch(/^approval-window:/)
  expect(options.webPreferences.partition).not.toContain('persist:')
  expect(sessions.map((session) => session.partition)).toEqual([options.webPreferences.partition])

  const current = windows[0]!.webContents
  const state = handlers.get(APPROVAL_WINDOW_CHANNELS.getState)!
  await expect(state({ sender: current, senderFrame: current.mainFrame })).resolves.toMatchObject({ generation: 1 })
  await expect(state({ sender: current, senderFrame: {} })).rejects.toThrow('Approval window sender is not current')
  await expect(state({ sender: new FakeWindow().webContents, senderFrame: {} })).rejects.toThrow('Approval window sender is not current')
  expect(reports).toEqual(['Approval window sender was rejected'])
  clock = 1_000
  await expect(state({ sender: current, senderFrame: {} })).rejects.toThrow('Approval window sender is not current')
  expect(reports).toEqual([
    'Approval window sender was rejected',
    '1 rejected senders suppressed',
    'Approval window sender was rejected'
  ])
})

test('traces a foreign sender probing while no approval is open, and the sender that crosses the trace window', async () => {
  let clock = 0
  const { handlers, reports } = harness(false, presentation, { now: () => clock })
  const state = handlers.get(APPROVAL_WINDOW_CHANNELS.getState)!
  const probe = async (at: number): Promise<void> => {
    clock = at
    await expect(state({ sender: new FakeWindow().webContents, senderFrame: {} })).rejects.toThrow('Approval window sender is not current')
  }

  await probe(0)
  expect(reports, 'the first foreign sender is traced even with no approval open').toEqual(['Approval window sender was rejected'])
  await probe(100)
  await probe(200)
  await probe(1_500)
  expect(reports).toEqual([
    'Approval window sender was rejected',
    '2 rejected senders suppressed',
    'Approval window sender was rejected'
  ])
})

test('delivers the refusal to the generation whose native window fails while opening', () => {
  const failures: [string, ApprovalWindowNativeAdapter['open']][] = [
    ['throws', () => { throw new Error('native open failed') }],
    ['fails synchronously', (_generation, lifecycle) => lifecycle.failed()]
  ]
  for (const [name, open] of failures) {
    const controller = createApprovalWindowController({
      ipc: { handle: () => {}, removeHandler: () => {} },
      native: { open, close: () => {}, endpoint: () => null },
      reportError: () => {},
      presentation: () => presentation
    })
    const verdicts: string[] = []
    expect(controller.open(document, (verdict) => { verdicts.push(verdict) }), name).toEqual({ kind: 'opened', generation: 1 })
    expect(verdicts, `a native window that ${name} must still refuse its own request`).toEqual(['refuse'])
  }
})

test('opens the reader as a modal child of the main window when there is one, standalone otherwise', () => {
  const standalone = harness()
  standalone.controller.open(document)
  expect(standalone.constructed[0]).not.toHaveProperty('parent')
  expect(standalone.constructed[0]).not.toHaveProperty('modal')

  const main = new FakeWindow()
  const child = harness(false, presentation, {}, () => main)
  child.controller.open(document)
  expect(child.constructed[0]).toMatchObject({ parent: main, modal: true })
})

test('denies every permission through the ephemeral partition session', () => {
  const { controller, sessions } = harness()
  controller.open(document)

  expect(sessions).toHaveLength(1)
  const session = sessions[0]!
  let allowed: boolean | null = null
  session.requestHandler!({}, 'camera', (value) => { allowed = value }, {})
  expect<boolean | null>(allowed).toBe(false)
  expect(session.checkHandler!({}, 'notifications', 'https://hostile.example', {})).toBe(false)
  let downloadPrevented = false
  session.listeners.get('will-download')!({ preventDefault: () => { downloadPrevented = true } })
  expect(downloadPrevented).toBe(true)
})

test('clears ephemeral session data and cache after the window closes', async () => {
  const { controller, sessions, windows } = harness()
  controller.open(document)
  windows[0]!.fire('closed')
  await Promise.resolve()

  expect(sessions[0]!.storageCleared).toBe(true)
  expect(sessions[0]!.cacheCleared).toBe(true)
})

test('settles Refuse exactly once on close before reading and renderer crash after reading', async () => {
  const { controller, handlers, verdicts, windows } = harness()
  const read = handlers.get(APPROVAL_WINDOW_CHANNELS.read)!
  const state = handlers.get(APPROVAL_WINDOW_CHANNELS.getState)!
  expect(controller.open(document)).toEqual({ kind: 'opened', generation: 1 })
  windows[0]!.fire('close')
  windows[0]!.fire('close')

  expect(verdicts).toEqual(['refuse'])
  expect(controller.open(document)).toEqual({ kind: 'opened', generation: 2 })
  const current = windows[1]!.webContents
  const snapshot = (await state({ sender: current, senderFrame: current.mainFrame })) as ApprovalWindowSnapshot
  await read(
    { sender: current, senderFrame: current.mainFrame },
    { generation: snapshot.generation, fingerprint: snapshot.fingerprint, metrics: { viewportHeight: 100, scrollHeight: 100, scrollTop: 0 } }
  )
  windows[1]!.fire('contents:render-process-gone')

  expect(verdicts).toEqual(['refuse', 'refuse'])
})

test('traces a renderer crash in the error sink', () => {
  const { controller, reports, windows } = harness()
  controller.open(document)
  windows[0]!.fire('contents:render-process-gone')

  expect(reports, 'a crashed approval renderer must leave a trace').toContain('Approval window renderer crashed')
})

test('traces and rejects an invalid verdict while accepting approval only after reading', async () => {
  const { controller, handlers, reports, verdicts, windows } = harness()
  expect(controller.open(document)).toEqual({ kind: 'opened', generation: 1 })
  const current = windows[0]!.webContents
  const event = { sender: current, senderFrame: current.mainFrame }
  const state = (await handlers.get(APPROVAL_WINDOW_CHANNELS.getState)!(event)) as ApprovalWindowSnapshot
  const answer = handlers.get(APPROVAL_WINDOW_CHANNELS.verdict)!
  const read = handlers.get(APPROVAL_WINDOW_CHANNELS.read)!

  await expect(answer(event, { generation: state.generation, fingerprint: state.fingerprint, verdict: 'allow' })).rejects.toThrow('invalid-verdict')
  expect(reports).toContain('Rejected approval-window verdict: invalid-verdict')
  await expect(answer(event, { generation: state.generation, fingerprint: state.fingerprint, verdict: 'approve' })).rejects.toThrow('reading-required')
  await read(event, { generation: state.generation, fingerprint: state.fingerprint, metrics: { viewportHeight: 100, scrollHeight: 100, scrollTop: 0 } })
  await expect(answer(event, { generation: state.generation, fingerprint: state.fingerprint, verdict: 'approve' })).resolves.toBeUndefined()

  expect(verdicts).toEqual(['approve'])
})

test('gives every opened window its own non-persistent partition', () => {
  const { controller, constructed, windows } = harness()
  controller.open(document)
  windows[0]!.fire('close')
  controller.open(document)

  const [first, second] = constructed.map((options) => options.webPreferences.partition)
  expect(first).not.toBe(second)
  for (const partition of [first!, second!]) expect(partition.startsWith('persist:')).toBe(false)
})

test('destroys the window once a verdict is accepted', async () => {
  const { controller, handlers, windows } = harness()
  controller.open(document)
  const current = windows[0]!.webContents
  const event = { sender: current, senderFrame: current.mainFrame }
  const snapshot = (await handlers.get(APPROVAL_WINDOW_CHANNELS.getState)!(event)) as ApprovalWindowSnapshot

  await handlers.get(APPROVAL_WINDOW_CHANNELS.verdict)!(event, { generation: snapshot.generation, fingerprint: snapshot.fingerprint, verdict: 'refuse' })

  expect(windows[0]!.destroyed, 'an answered approval window must not stay on screen').toBe(true)
})

test('rejects read and verdict from a foreign sender or a subframe without recording them', async () => {
  const { controller, handlers, verdicts, windows } = harness()
  controller.open(document)
  const current = windows[0]!.webContents
  const legit = { sender: current, senderFrame: current.mainFrame }
  const snapshot = (await handlers.get(APPROVAL_WINDOW_CHANNELS.getState)!(legit)) as ApprovalWindowSnapshot
  const identity = { generation: snapshot.generation, fingerprint: snapshot.fingerprint }
  const read = handlers.get(APPROVAL_WINDOW_CHANNELS.read)!
  const answer = handlers.get(APPROVAL_WINDOW_CHANNELS.verdict)!
  const forged = [
    { name: 'foreign sender', event: { sender: new FakeWindow().webContents, senderFrame: current.mainFrame } },
    { name: 'subframe', event: { sender: current, senderFrame: {} } }
  ]

  for (const { name, event } of forged) {
    await expect(read(event, { ...identity, metrics: { viewportHeight: 100, scrollHeight: 100, scrollTop: 0 } }), `read from ${name}`).rejects.toThrow('Approval window sender is not current')
    await expect(answer(event, { ...identity, verdict: 'refuse' }), `verdict from ${name}`).rejects.toThrow('Approval window sender is not current')
  }

  expect(verdicts, 'a forged verdict must never settle the request').toEqual([])
  await expect(answer(legit, { ...identity, verdict: 'approve' }), 'a forged read must not unlock approval').rejects.toThrow('reading-required')
  expect(verdicts).toEqual([])
})

test('refuses and reports navigation and load failures', async () => {
  const navigation = harness()
  expect(navigation.controller.open(document)).toEqual({ kind: 'opened', generation: 1 })
  navigation.windows[0]!.fire('ready-to-show')
  expect(navigation.windows[0]!.shown).toBe(true)
  navigation.windows[0]!.fire('contents:will-navigate')
  expect(navigation.windows[0]!.prevented, 'the navigation itself must be cancelled, not only reported').toEqual(['contents:will-navigate'])
  expect(navigation.verdicts).toEqual(['refuse'])
  expect(navigation.reports).toContain('Approval window navigation was refused')

  const frameNavigation = harness()
  frameNavigation.controller.open(document)
  frameNavigation.windows[0]!.fire('contents:will-frame-navigate')
  expect(frameNavigation.windows[0]!.prevented).toEqual(['contents:will-frame-navigate'])
  expect(frameNavigation.verdicts).toEqual(['refuse'])
  expect(frameNavigation.reports).toContain('Approval window frame navigation was refused')

  const reload = harness()
  reload.controller.open(document)
  reload.windows[0]!.fire('contents:did-finish-load')
  // Electron 43 shape: the details event first, then the deprecated positional url, isInPlace, isMainFrame.
  reload.windows[0]!.fireWithDetails('contents:did-start-navigation', { url: 'approval.html', isMainFrame: true, isSameDocument: false }, 'approval.html', false, true)
  expect(reload.verdicts).toEqual(['refuse'])
  expect(reload.reports).toContain('Approval window reload was refused')

  const loading = harness(true)
  expect(loading.controller.open(document)).toEqual({ kind: 'opened', generation: 1 })
  await Promise.resolve()
  expect(loading.verdicts).toEqual(['refuse'])
  expect(loading.reports).toContain('Approval window failed to load')

  const preload = harness()
  expect(preload.controller.open(document)).toEqual({ kind: 'opened', generation: 1 })
  preload.windows[0]!.fire('contents:preload-error', 'approval-preload.js', new Error('preload failed'))
  expect(preload.verdicts).toEqual(['refuse'])
  expect(preload.reports).toContain('Approval window preload failed')
})

test('serves the reader presentation outside the fingerprint of the approved document', async () => {
  const french: ApprovalPresentation = { lang: 'fr', text: { ...presentation.text, reached: 'Fin atteinte' } }
  const snapshots: ApprovalWindowSnapshot[] = []
  for (const view of [presentation, french]) {
    const { controller, handlers, windows } = harness(false, view)
    controller.open(document)
    const current = windows[0]!.webContents
    snapshots.push((await handlers.get(APPROVAL_WINDOW_CHANNELS.getState)!({ sender: current, senderFrame: current.mainFrame })) as ApprovalWindowSnapshot)
  }

  expect(snapshots.map((snapshot) => snapshot.presentation)).toEqual([presentation, french])
  expect(snapshots[0]!.fingerprint, 'interface text must not change what the operator approves').toBe(snapshots[1]!.fingerprint)
})

test('logs a reader error report from the current window only, prefixed and cut to the byte cap', async () => {
  const { controller, handlers, reports, windows } = harness()
  controller.open(document)
  const current = windows[0]!.webContents
  const report = handlers.get(APPROVAL_WINDOW_CHANNELS.reportError)!

  await expect(report({ sender: new FakeWindow().webContents, senderFrame: {} }, 'forged')).rejects.toThrow('Approval window sender is not current')
  await expect(report({ sender: current, senderFrame: {} }, 'subframe')).rejects.toThrow('Approval window sender is not current')
  expect(reports.some((message) => message.includes('forged') || message.includes('subframe')), 'a foreign report must not reach the log').toBe(false)

  await expect(report({ sender: current, senderFrame: current.mainFrame }, `${'a'.repeat(APPROVAL_READER_ERROR_MAX_BYTES - 1)}éz`)).resolves.toBeUndefined()
  const logged = reports.at(-1)!
  expect(logged.startsWith('approval-reader: ')).toBe(true)
  const body = logged.slice('approval-reader: '.length)
  expect(Buffer.byteLength(body, 'utf8'), 'a multibyte char straddling the cap is dropped whole').toBe(APPROVAL_READER_ERROR_MAX_BYTES - 1)
})

test('keeps a reader error report on one line with its control characters made visible', async () => {
  const { controller, handlers, reports, windows } = harness()
  controller.open(document)
  const current = windows[0]!.webContents
  const event = { sender: current, senderFrame: current.mainFrame }
  const report = handlers.get(APPROVAL_WINDOW_CHANNELS.reportError)!
  const ESC = String.fromCharCode(0x1b)
  const NEL = String.fromCharCode(0x85)

  await report(event, `boom\r\napproval-reader: forged${ESC}[31m${NEL}end`)
  const logged = reports.at(-1)!

  expect(logged.split('\n'), 'a newline would let the reader forge a second log entry').toHaveLength(1)
  expect([...logged].some((char) => { const code = char.codePointAt(0)!; return code <= 0x1f || (code >= 0x7f && code <= 0x9f) })).toBe(false)
  expect(logged).toBe(`approval-reader: boom${'\\'}x0d${'\\'}x0aapproval-reader: forged${'\\'}x1b[31m${'\\'}x85end`)
})

test('refuses a reader error report that is not a single string', async () => {
  const { controller, handlers, reports, windows } = harness()
  controller.open(document)
  const current = windows[0]!.webContents
  const event = { sender: current, senderFrame: current.mainFrame }
  const report = handlers.get(APPROVAL_WINDOW_CHANNELS.reportError)!

  await expect(report(event, ['a', 'b'])).rejects.toThrow('Approval window error report is invalid')
  await expect(report(event, 'a', 'b')).rejects.toThrow('Approval window error report is invalid')
  expect(reports.filter((message) => message.startsWith('approval-reader: '))).toEqual([])
})

test('rate-limits reader error reports with a single saturation trace per window', async () => {
  let clock = 0
  const { controller, handlers, reports, windows } = harness(false, presentation, { now: () => clock, rendererErrorBurst: 2, rendererErrorRefillMs: 1_000 })
  controller.open(document)
  const current = windows[0]!.webContents
  const event = { sender: current, senderFrame: current.mainFrame }
  const report = handlers.get(APPROVAL_WINDOW_CHANNELS.reportError)!

  for (const n of [1, 2, 3, 4, 5]) await report(event, `m${n}`)
  const fromReader = (): string[] => reports.filter((message) => message.startsWith('approval-reader: '))
  expect(fromReader(), 'a flooding reader must not fill the log').toEqual([
    'approval-reader: m1',
    'approval-reader: m2',
    'approval-reader: error reports saturated, dropping until the rate limit refills'
  ])

  clock = 1_000
  await report(event, 'm6')
  expect(fromReader().at(-1)).toBe('approval-reader: 3 reports dropped; m6')
  expect(fromReader().filter((message) => message.includes('saturated'))).toHaveLength(1)
})

test('reader presentation reads each text field from its own locale key, embedded English included', () => {
  const fields = ['regionLabel', 'unreached', 'reached', 'readFailed', 'verdictFailed'] as const
  const expected = (dict: Record<string, string>): Record<string, string | undefined> =>
    Object.fromEntries(fields.map((field) => [field, dict[`approvalReader.${field}`]]))

  const embedded = loadDict('en', [])
  const english = approvalReaderPresentation(embedded, 'en')
  expect(english.lang).toBe('en')
  expect<Record<string, string | undefined>>({ ...english.text }, 'each field must come from its own key').toEqual(expected(embedded))
  for (const field of fields) {
    expect(english.text[field], `approvalReader.${field} must have an embedded English value, never the raw key`).not.toBe(`approvalReader.${field}`)
  }
  expect(new Set(Object.values(english.text)).size, 'two fields must not share one text').toBe(fields.length)

  const shipped = loadDict('fr', [join(import.meta.dir, '..', 'desktop', 'locales')])
  const french = approvalReaderPresentation(shipped, 'fr')
  expect(french.lang).toBe('fr')
  expect<Record<string, string | undefined>>({ ...french.text }).toEqual(expected(shipped))
  for (const field of fields) expect(french.text[field], `approvalReader.${field} must be translated in fr.json`).not.toBe(english.text[field])
})
