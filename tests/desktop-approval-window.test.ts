import { expect, test } from 'bun:test'
import {
  createApprovalNativeAdapter,
  createApprovalWindowController,
  type ApprovalWindowIpcHandler,
  type ApprovalWindowNativeConstructionOptions
} from '../desktop/src/main/approval-window.ts'
import { APPROVAL_WINDOW_CHANNELS, type ApprovalWindowSnapshot } from '../desktop/src/shared/approval-window.ts'
import type { ApprovalDocument } from '../desktop/src/shared/approval-document.ts'

const document: ApprovalDocument = Object.freeze({
  message: 'Run this command?',
  detail: '01| npm run dev',
  approve: 'Run',
  refuse: 'Refuse',
  close: 'Close'
})

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
  readonly prevented: string[] = []

  on(event: string, listener: Listener): void {
    this.listeners.set(event, listener)
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

  fire(event: string): void {
    this.listeners.get(event)?.({ preventDefault: () => { this.prevented.push(event) } })
  }
}

function harness(loadFailure = false) {
  const handlers = new Map<string, ApprovalWindowIpcHandler>()
  const windows: FakeWindow[] = []
  const constructed: ApprovalWindowNativeConstructionOptions[] = []
  const reports: string[] = []
  const verdicts: string[] = []
  const native = createApprovalNativeAdapter({
    preload: 'approval-preload.js',
    html: 'approval.html',
    createWindow(options) {
      constructed.push(options)
      const window = new FakeWindow(loadFailure)
      windows.push(window)
      return window
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
    onVerdict: (verdict) => { verdicts.push(verdict) }
  })
  return { controller, constructed, handlers, reports, verdicts, windows }
}

test('uses an ephemeral hardened partition and refuses foreign or subframe IPC', async () => {
  const { controller, constructed, handlers, windows } = harness()
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

  const current = windows[0]!.webContents
  const state = handlers.get(APPROVAL_WINDOW_CHANNELS.getState)!
  await expect(state({ sender: current, senderFrame: current.mainFrame })).resolves.toMatchObject({ generation: 1 })
  await expect(state({ sender: current, senderFrame: {} })).rejects.toThrow('Approval window sender is not current')
  await expect(state({ sender: new FakeWindow().webContents, senderFrame: {} })).rejects.toThrow('Approval window sender is not current')
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
  navigation.windows[0]!.fire('contents:will-navigate')
  expect(navigation.windows[0]!.prevented, 'the navigation itself must be cancelled, not only reported').toEqual(['contents:will-navigate'])
  expect(navigation.verdicts).toEqual(['refuse'])
  expect(navigation.reports).toContain('Approval window navigation was refused')

  const loading = harness(true)
  expect(loading.controller.open(document)).toEqual({ kind: 'opened', generation: 1 })
  await Promise.resolve()
  expect(loading.verdicts).toEqual(['refuse'])
  expect(loading.reports).toContain('Approval window failed to load')
})
