import { expect, test } from 'bun:test'
import { AVATAR_VIEW_CHANNELS, type AvatarViewState } from '../desktop/src/shared/avatar-view.ts'
import { registerAvatarViewIpcHandlers, type AvatarViewIpcHandler } from '../desktop/src/main/avatar-window.ts'

type Handler = AvatarViewIpcHandler

function state(): AvatarViewState {
  return {
    generation: 4,
    revision: 7,
    summary: {
      face: 'seul',
      counters: { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
      unread: 0,
      decks: []
    },
    presentation: {
      position: { x: 100, y: 200 },
      theme: 'dark',
      motion: 'continuous',
      dndActive: false,
      visible: true,
      alwaysOnTop: true,
      positionLocked: false,
      size: 'm',
      idleOpacity: 1
    }
  }
}

test('accepts each AvatarView handler only from its current main frame', async () => {
  const handlers = new Map<string, Handler>()
  const mainFrame = {}
  const currentContents = { mainFrame }
  const foreignContents = { mainFrame: {} }
  let current = { webContents: currentContents, generation: 4 }
  const calls: unknown[][] = []
  const dispose = registerAvatarViewIpcHandlers({
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => { handlers.delete(channel) }
    },
    currentWindow: () => current,
    getState: state,
    setPosition: (...args) => { calls.push(args) },
    setPointerInside: (...args) => { calls.push(args) },
    reportError: (...args) => { calls.push(args) }
  })
  const cases: [string, unknown[]][] = [
    [AVATAR_VIEW_CHANNELS.getState, []],
    [AVATAR_VIEW_CHANNELS.setPosition, [12, -3]],
    [AVATAR_VIEW_CHANNELS.setPointerInside, [true]],
    [AVATAR_VIEW_CHANNELS.reportError, ['renderer failed']]
  ]
  const senderCases = [
    ['current main frame', { sender: currentContents, senderFrame: mainFrame }, true],
    ['foreign window', { sender: foreignContents, senderFrame: foreignContents.mainFrame }, false],
    ['current subframe', { sender: currentContents, senderFrame: {} }, false]
  ] as const

  expect([...handlers.keys()].sort()).toEqual(Object.values(AVATAR_VIEW_CHANNELS).filter((channel) => channel !== AVATAR_VIEW_CHANNELS.state).sort())
  for (const [channel, args] of cases) {
    const handler = handlers.get(channel)!
    for (const [_name, event, accepted] of senderCases) {
      if (accepted) await expect(handler(event, ...args)).resolves.toEqual(channel === AVATAR_VIEW_CHANNELS.getState ? state() : undefined)
      else await expect(handler(event, ...args)).rejects.toThrow('AvatarView sender is not current')
    }
    current = null as unknown as typeof current
    await expect(handler(senderCases[0][1], ...args)).rejects.toThrow('AvatarView sender is not current')
    current = { webContents: currentContents, generation: 4 }
  }

  const setPosition = handlers.get(AVATAR_VIEW_CHANNELS.setPosition)!
  const setPointerInside = handlers.get(AVATAR_VIEW_CHANNELS.setPointerInside)!
  const reportRendererError = handlers.get(AVATAR_VIEW_CHANNELS.reportError)!
  await expect(setPosition(senderCases[0][1], 12, 3, 400, 400)).rejects.toThrow('AvatarView position requires exactly two finite numbers')
  await expect(setPosition(senderCases[0][1], Number.NaN, 3)).rejects.toThrow('AvatarView position requires exactly two finite numbers')
  await expect(setPointerInside(senderCases[0][1], 'true')).rejects.toThrow('AvatarView pointer state must be a boolean')
  await expect(reportRendererError(senderCases[0][1], 'x'.repeat(2_049))).rejects.toThrow('AvatarView error message is invalid')
  expect(calls).toEqual([[12, -3], [true], ['renderer failed']])

  dispose()
  expect(handlers).toEqual(new Map())
})

test('aggregates suppressed renderer errors and resets its bucket for a new generation', async () => {
  const handlers = new Map<string, Handler>()
  const mainFrame = {}
  const contents = { mainFrame }
  let now = 0
  let generation = 1
  const reports: string[] = []
  registerAvatarViewIpcHandlers({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: () => {} },
    currentWindow: () => ({ webContents: contents, generation }),
    getState: state,
    setPosition: () => {},
    setPointerInside: () => {},
    reportError: (message) => reports.push(message),
    now: () => now,
    rendererErrorBurst: 2,
    rendererErrorRefillMs: 100
  })
  const report = handlers.get(AVATAR_VIEW_CHANNELS.reportError)!
  const event = { sender: contents, senderFrame: mainFrame }

  await report(event, 'one')
  await report(event, 'two')
  await report(event, 'three')
  now = 100
  await report(event, 'four')
  generation = 2
  await report(event, 'five')

  expect(reports).toEqual(['one', 'two', '1 Avatar renderer errors suppressed; four', 'five'])
})

test('keeps pointer forwarding, visibility, topmost state and reload lifecycle in the window adapter', async () => {
  const { createAvatarWindow } = await import('../desktop/src/main/avatar-window.ts')
  const windows: { destroy: () => void; hide: () => void; loadFile: (file: string) => Promise<void>; setAlwaysOnTop: (alwaysOnTop: boolean) => void; setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void; setPosition: (x: number, y: number) => void; showInactive: () => void; webContents: { mainFrame: object; send: (channel: string, payload: AvatarViewState) => void; setWindowOpenHandler: (handler: () => { action: 'deny' }) => void; on: (event: string, listener: (...args: unknown[]) => void) => void } }[] = []
  const generations: number[] = []
  const sent: unknown[][] = []
  const pointerModes: { ignore: boolean; options?: { forward: boolean } }[] = []
  const topmost: boolean[] = []
  const constructionTopmost: boolean[] = []
  let willNavigate: ((event: { preventDefault(): void }) => void) | null = null
  let renderProcessGone: (() => void) | null = null
  let windowOpen: (() => { action: 'deny' }) | null = null
  let hides = 0
  let shows = 0
  const avatarWindow = createAvatarWindow({
    platform: 'win32',
    preload: 'avatar-preload.js',
    html: 'avatar.html',
    alwaysOnTop: false,
    createWindow: (options) => {
      constructionTopmost.push(options.alwaysOnTop)
      expect(options).toMatchObject({
        frame: false,
        transparent: true,
        skipTaskbar: true,
        show: false,
        webPreferences: { preload: 'avatar-preload.js', sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
      })
      const window = {
        destroy: () => { windows.splice(windows.indexOf(window), 1) },
        on: () => {},
        hide: () => { hides += 1 },
        loadFile: async () => {},
        setAlwaysOnTop: (alwaysOnTop: boolean) => { topmost.push(alwaysOnTop) },
        setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => { pointerModes.push({ ignore, options }) },
        setPosition: () => {},
        showInactive: () => { shows += 1 },
        webContents: {
          mainFrame: {},
          send: (channel: string, payload: AvatarViewState) => { sent.push([channel, payload]) },
          setWindowOpenHandler: (handler: () => { action: 'deny' }) => { windowOpen = handler },
          on: (event: string, listener: (...args: unknown[]) => void) => {
            if (event === 'will-navigate') willNavigate = listener as (event: { preventDefault(): void }) => void
            if (event === 'render-process-gone') renderProcessGone = listener as () => void
          }
        }
      }
      windows.push(window)
      return window
    },
    reportError: () => {},
    onGeneration: (generation) => generations.push(generation)
  })

  await avatarWindow.show()
  expect(windowOpen?.()).toEqual({ action: 'deny' })
  if (willNavigate === null) throw new Error('Expected navigation guard')
  const navigationGuard = willNavigate as unknown as (event: { preventDefault(): void }) => void
  let prevented = false
  navigationGuard({ preventDefault: () => { prevented = true } })
  expect(prevented).toBe(true)
  avatarWindow.setPointerInside(true)
  avatarWindow.setPointerInside(false)
  avatarWindow.hide()
  await avatarWindow.show()
  avatarWindow.setAlwaysOnTop(true)
  avatarWindow.sendState(state())
  expect(sent).toEqual([[AVATAR_VIEW_CHANNELS.state, state()]])
  expect(pointerModes).toEqual([
    { ignore: true, options: { forward: true } },
    { ignore: false },
    { ignore: true, options: { forward: true } },
    { ignore: true, options: { forward: true } }
  ])
  expect(topmost).toEqual([true])
  expect(hides).toBe(1)
  expect(shows).toBe(2)

  if (renderProcessGone === null) throw new Error('Expected crash handler')
  const crashHandler = renderProcessGone as unknown as () => void
  crashHandler()
  await Promise.resolve()
  expect(generations).toEqual([1])
  expect(windows).toHaveLength(0)
  await avatarWindow.show()
  expect(generations).toEqual([1, 2])
  await avatarWindow.reload()
  expect(generations).toEqual([1, 2, 3])
  expect(constructionTopmost).toEqual([false, true, true])
  expect(pointerModes.filter((mode) => mode.ignore)).toEqual(expect.arrayContaining([
    { ignore: true, options: { forward: true } },
    { ignore: true, options: { forward: true } }
  ]))
})

test('invalidates a pending creation before reload', async () => {
  const { createAvatarWindow } = await import('../desktop/src/main/avatar-window.ts')
  const resolvers: (() => void)[] = []
  const windows: { destroy: () => void; hide: () => void; loadFile: () => Promise<void>; setAlwaysOnTop: () => void; setIgnoreMouseEvents: () => void; setPosition: () => void; showInactive: () => void; webContents: { mainFrame: {}; send: () => void; setWindowOpenHandler: () => void; on: () => void } }[] = []
  const generations: number[] = []
  const avatarWindow = createAvatarWindow({
    platform: 'win32',
    preload: 'avatar-preload.js',
    html: 'avatar.html',
    alwaysOnTop: true,
    createWindow: () => {
      const window = {
        destroy: () => { windows.splice(windows.indexOf(window), 1) },
        on: () => {},
        hide: () => {},
        loadFile: () => new Promise<void>((resolve) => resolvers.push(resolve)),
        setAlwaysOnTop: () => {},
        setIgnoreMouseEvents: () => {},
        setPosition: () => {},
        showInactive: () => {},
        webContents: { mainFrame: {}, send: () => {}, setWindowOpenHandler: () => {}, on: () => {} }
      }
      windows.push(window)
      return window
    },
    reportError: () => {},
    onGeneration: (generation) => generations.push(generation)
  })

  const first = avatarWindow.show()
  const replacement = avatarWindow.reload()
  resolvers.shift()!()
  resolvers.shift()!()
  await Promise.all([first, replacement])
  expect(windows).toHaveLength(1)
  expect(generations).toEqual([1])
  avatarWindow.destroy()
  expect(windows).toHaveLength(0)
})

interface DeferredAvatarWindow {
  destroyed: boolean
  emit(event: 'close' | 'closed' | 'render-process-gone'): boolean
  on(event: string, listener: (...args: unknown[]) => void): void
  destroy(): void
  hide(): void
  loadFile(): Promise<void>
  setAlwaysOnTop(): void
  setIgnoreMouseEvents(): void
  setPosition(): void
  showInactive(): void
  webContents: {
    mainFrame: {}
    send(): void
    setWindowOpenHandler(): void
    on(event: string, listener: (...args: unknown[]) => void): void
  }
}

function deferredWindowHarness() {
  const windows: DeferredAvatarWindow[] = []
  const resolvers: (() => void)[] = []
  const generations: number[] = []
  const createWindow = (): DeferredAvatarWindow => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const window: DeferredAvatarWindow = {
      destroyed: false,
      on: (event, listener) => { listeners.set(event, listener) },
      emit(event) {
        let prevented = false
        listeners.get(event)?.({ preventDefault: () => { prevented = true } })
        return prevented
      },
      destroy() {
        window.destroyed = true
        windows.splice(windows.indexOf(window), 1)
        listeners.get('closed')?.()
      },
      hide() {},
      loadFile: () => new Promise<void>((resolve) => resolvers.push(resolve)),
      setAlwaysOnTop() {},
      setIgnoreMouseEvents() {},
      setPosition() {},
      showInactive() {},
      webContents: {
        mainFrame: {},
        send() {},
        setWindowOpenHandler() {},
        on: (event, listener) => { listeners.set(event, listener) }
      }
    }
    windows.push(window)
    return window
  }
  return { windows, resolvers, generations, createWindow }
}

test('destroys a pending window before reload publishes its replacement', async () => {
  const { createAvatarWindow } = await import('../desktop/src/main/avatar-window.ts')
  const harness = deferredWindowHarness()
  const avatarWindow = createAvatarWindow({
    platform: 'win32', preload: 'avatar-preload.js', html: 'avatar.html', alwaysOnTop: true,
    createWindow: harness.createWindow, reportError: () => {}, onGeneration: (generation) => harness.generations.push(generation)
  })

  const first = avatarWindow.show()
  const original = harness.windows[0]!
  const replacement = avatarWindow.reload()
  expect(original.destroyed).toBe(true)
  expect(harness.windows).toHaveLength(1)
  original.emit('render-process-gone')
  harness.resolvers[1]!()
  await replacement
  harness.resolvers[0]!()
  await first

  expect(harness.windows).toHaveLength(1)
  expect(harness.generations).toEqual([1])
})

test('destroys a pending window when Avatar is destroyed', async () => {
  const { createAvatarWindow } = await import('../desktop/src/main/avatar-window.ts')
  const harness = deferredWindowHarness()
  const avatarWindow = createAvatarWindow({
    platform: 'win32', preload: 'avatar-preload.js', html: 'avatar.html', alwaysOnTop: true,
    createWindow: harness.createWindow, reportError: () => {}, onGeneration: (generation) => harness.generations.push(generation)
  })

  const pending = avatarWindow.show()
  const original = harness.windows[0]!
  avatarWindow.destroy()
  expect(original.destroyed).toBe(true)
  expect(harness.windows).toHaveLength(0)
  harness.resolvers[0]!()
  await pending

  expect(harness.generations).toEqual([])
  expect(harness.windows).toHaveLength(0)
})

test('hides a user close while destroy closes the Avatar window', async () => {
  const { createAvatarWindow } = await import('../desktop/src/main/avatar-window.ts')
  const harness = deferredWindowHarness()
  let hides = 0
  let shows = 0
  const createWindow = () => {
    const window = harness.createWindow()
    window.hide = () => { hides += 1 }
    window.showInactive = () => { shows += 1 }
    return window
  }
  const avatarWindow = createAvatarWindow({
    platform: 'win32', preload: 'avatar-preload.js', html: 'avatar.html', alwaysOnTop: true,
    createWindow, reportError: () => {}, onGeneration: () => {}
  })

  const opening = avatarWindow.show()
  harness.resolvers[0]!()
  await opening
  const window = harness.windows[0]!
  expect(window.emit('close')).toBe(true)
  expect(window.destroyed).toBe(false)
  expect(hides).toBe(1)
  await avatarWindow.show()
  expect(shows).toBe(2)
  avatarWindow.destroy()

  expect(window.destroyed).toBe(true)
  expect(harness.windows).toHaveLength(0)
})
