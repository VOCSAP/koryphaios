import { describe, expect, test } from 'bun:test'
import { AVATAR_VIEW_CHANNELS, type AvatarViewState } from '../desktop/src/shared/avatar-view.ts'
import type { AvatarAppearance } from '../desktop/src/main/avatar-appearance.ts'
import {
  createAvatarNativeAdapter,
  registerAvatarViewIpcHandlers,
  type AvatarBrowserWindow,
  type AvatarViewIpcHandler,
  type AvatarWindowConstructionOptions
} from '../desktop/src/main/avatar-window.ts'
import { createAvatarWindowController } from '../desktop/src/main/avatar-window-controller.ts'
import type { AvatarGeometry, AvatarPublication } from '../desktop/src/main/avatar-window-state.ts'

const DISPLAY_A = { id: '1', workArea: { x: 0, y: 0, width: 1000, height: 800 } }
const GEOMETRY: AvatarGeometry = { displays: [DISPLAY_A], size: { width: 100, height: 100 } }

function appearance(patch: Partial<AvatarAppearance> = {}): AvatarAppearance {
  return {
    version: 1,
    visible: true,
    alwaysOnTop: true,
    positionLocked: false,
    size: 'm',
    idleOpacity: 1,
    motion: 'continuous',
    dndUntil: null,
    dndChoice: null,
    positions: Object.create(null) as AvatarAppearance['positions'],
    ...patch
  }
}

type DestroyMode = 'closed' | 'close-then-closed' | 'silent' | 'vanish-without-closed' | 'throw'

class FakeWindow implements AvatarBrowserWindow {
  destroyed = false
  gone = false
  destroyMode: DestroyMode = 'closed'
  destroyCalls = 0
  closePrevented: boolean | null = null
  onDestroy: (() => void) | null = null
  readonly failing = new Set<string>()
  readonly calls: string[] = []
  readonly sent: AvatarViewState[] = []
  readonly positions: [number, number][] = []
  readonly topmost: boolean[] = []
  readonly mouse: { ignore: boolean; options?: { forward: true } }[] = []
  readonly loads: string[] = []
  private resolveLoad: (() => void) | null = null
  private rejectLoad: ((error: Error) => void) | null = null
  private readonly listeners = new Map<string, (...args: unknown[]) => void>()
  private readonly webListeners = new Map<string, (...args: unknown[]) => void>()
  windowOpen: (() => { action: 'deny' }) | null = null

  get moves(): [number, number][] {
    return this.positions.slice(1)
  }

  readonly webContents = {
    mainFrame: {},
    send: (channel: string, payload: AvatarViewState): void => {
      this.step('send')
      expect(channel).toBe('avatar-view:state')
      this.sent.push(payload)
    },
    setWindowOpenHandler: (handler: () => { action: 'deny' }): void => {
      this.windowOpen = handler
    },
    on: (event: string, listener: (...args: unknown[]) => void): void => {
      this.step('webContents.on')
      this.webListeners.set(event, listener)
    }
  }

  constructor(
    readonly index: number,
    readonly options: AvatarWindowConstructionOptions,
    private readonly log: string[]
  ) {}

  private step(name: string): void {
    if (this.failing.has(name)) throw new Error(`${name} failed`)
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener)
  }

  emit(event: 'close' | 'closed'): boolean {
    let prevented = false
    this.listeners.get(event)?.({ preventDefault: () => { prevented = true } })
    return prevented
  }

  emitWeb(event: string): boolean {
    let prevented = false
    this.webListeners.get(event)?.({ preventDefault: () => { prevented = true } })
    return prevented
  }

  destroy(): void {
    this.destroyCalls += 1
    this.onDestroy?.()
    this.step('destroy')
    if (this.destroyMode === 'throw') throw new Error('destroy failed')
    if (this.destroyMode === 'silent') return
    this.destroyed = true
    if (this.destroyMode === 'vanish-without-closed') {
      this.gone = true
      return
    }
    if (this.destroyMode === 'close-then-closed') this.closePrevented = this.emit('close')
    this.gone = true
    this.emit('closed')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  hide(): void {
    this.step('hide')
    this.calls.push('hide')
    this.log.push(`w${this.index}:hide`)
  }

  loadFile(file: string): Promise<unknown> {
    this.loads.push(file)
    return new Promise<void>((resolve, reject) => {
      this.resolveLoad = resolve
      this.rejectLoad = reject
    })
  }

  finishLoad(): void {
    this.resolveLoad?.()
  }

  failLoad(): void {
    this.rejectLoad?.(new Error('load failed'))
  }

  setAlwaysOnTop(alwaysOnTop: boolean): void {
    this.step('setAlwaysOnTop')
    this.topmost.push(alwaysOnTop)
  }

  setIgnoreMouseEvents(ignore: boolean, options?: { forward: true }): void {
    this.step('setIgnoreMouseEvents')
    this.mouse.push({ ignore, options })
  }

  setPosition(x: number, y: number): void {
    this.step('setPosition')
    this.positions.push([x, y])
  }

  showInactive(): void {
    this.step('showInactive')
    this.calls.push('show')
    this.log.push(`w${this.index}:show`)
  }

  die(): void {
    this.destroyed = true
    this.gone = true
    this.emit('closed')
  }
}

interface Timer {
  id: number
  callback: () => void
  delay: number
  active: boolean
}

interface RigOptions {
  appearance?: Partial<AvatarAppearance>
  available?: boolean
  configure?: (window: FakeWindow) => void
  geometry?: AvatarGeometry
}

const SUMMARY: AvatarViewState['summary'] = {
  face: 'seul',
  counters: { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
  unread: 0,
  decks: []
}

function rig(init: RigOptions = {}) {
  const windows: FakeWindow[] = []
  const log: string[] = []
  const timers: Timer[] = []
  const reports: { message: string; error?: unknown }[] = []
  const written: AvatarAppearance[] = []
  const tray: AvatarViewState[] = []
  const handlers = new Map<string, AvatarViewIpcHandler>()
  const state = { maxAlive: 0, builds: 0, writeFails: false, createFails: false, writes: 0 }

  const controller = createAvatarWindowController({
    available: init.available ?? true,
    preload: 'avatar-preload.js',
    html: 'avatar.html',
    createWindow: (options) => {
      if (state.createFails) throw new Error('constructor failed')
      const alive = windows.filter((window) => !window.gone).length
      const window = new FakeWindow(windows.length + 1, options, log)
      windows.push(window)
      state.maxAlive = Math.max(state.maxAlive, alive + 1)
      init.configure?.(window)
      return window
    },
    appearance: appearance(init.appearance),
    geometry: init.geometry ?? GEOMETRY,
    buildEnvelope: (publication: AvatarPublication) => {
      state.builds += 1
      return {
        generation: publication.generation ?? 0,
        revision: publication.revision,
        summary: SUMMARY,
        presentation: {
          position: publication.position ? { x: publication.position.x, y: publication.position.y } : null,
          theme: 'dark',
          motion: publication.appearance.motion,
          dndActive: false,
          visible: publication.appearance.visible,
          alwaysOnTop: publication.appearance.alwaysOnTop,
          positionLocked: publication.appearance.positionLocked,
          size: publication.appearance.size,
          idleOpacity: publication.appearance.idleOpacity
        }
      }
    },
    publishTray: (envelope) => {
      tray.push(envelope)
    },
    writeSnapshot: (snapshot) => {
      state.writes += 1
      if (state.writeFails) throw new Error('disk full')
      written.push(snapshot)
    },
    reportError: (_scope, message, error) => {
      reports.push({ message, error })
    },
    setTimeout: (callback, delay) => {
      const timer = { id: timers.length + 1, callback, delay, active: true }
      timers.push(timer)
      return timer.id
    },
    clearTimeout: (handle) => {
      const timer = timers.find((candidate) => candidate.id === handle)
      if (timer) timer.active = false
    }
  })

  const dispose = registerAvatarViewIpcHandlers({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => { handlers.delete(channel) } },
    currentWindow: controller.currentWindow,
    loadingWindow: controller.loadingWindow,
    getState: controller.getState,
    setPosition: controller.setPosition,
    setPointerInside: controller.setPointerInside,
    reportError: () => {}
  })

  const invoke = (channel: string, window: FakeWindow, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(channel)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args))

  const activeTimer = (delay: number): Timer => {
    const found = [...timers].reverse().find((timer) => timer.active && timer.delay === delay)
    if (!found) throw new Error(`no active ${delay} ms timer`)
    return found
  }

  const fire = (delay: number): void => {
    const timer = activeTimer(delay)
    timer.active = false
    timer.callback()
  }

  const open = async (): Promise<FakeWindow> => {
    controller.dispatch({ kind: 'ShowRequested' })
    const window = windows[windows.length - 1]!
    window.finishLoad()
    await flush()
    return window
  }

  return { controller, windows, log, timers, reports, written, tray, handlers, state, dispose, invoke, activeTimer, fire, open }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const aliveWindows = (windows: FakeWindow[]): number => windows.filter((window) => !window.gone).length

function lastWritten(written: AvatarAppearance[]): AvatarAppearance {
  const record = written[written.length - 1]
  if (!record) throw new Error('nothing written')
  return record
}

describe('window adapter security and pointer behaviour', () => {
  test('creates a hidden, transparent, sandboxed, click-through window that refuses navigation and secondary windows', async () => {
    const r = rig({ appearance: { alwaysOnTop: false } })
    const window = await r.open()

    expect(window.options).toMatchObject({
      frame: false,
      transparent: true,
      alwaysOnTop: false,
      skipTaskbar: true,
      show: false,
      webPreferences: { preload: 'avatar-preload.js', sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
    })
    expect(window.mouse[0]).toEqual({ ignore: true, options: { forward: true } })
    expect(window.windowOpen?.()).toEqual({ action: 'deny' })
    expect(window.emitWeb('will-navigate')).toBe(true)
    expect(window.loads).toEqual(['avatar.html'])
    expect(window.topmost).toEqual([false])
  })

  test('keeps pointer forwarding, topmost and visibility behind the machine', async () => {
    const r = rig()
    const window = await r.open()
    const before = window.mouse.length

    await r.invoke(AVATAR_VIEW_CHANNELS.setPointerInside, window, true)
    r.controller.dispatch({ kind: 'AppearanceChanged', patch: { alwaysOnTop: false } })
    r.controller.dispatch({ kind: 'HideRequested' })

    expect(window.mouse.slice(before)).toEqual([{ ignore: false }, { ignore: true, options: { forward: true } }])
    expect(window.topmost.at(-1)).toBe(false)
    expect(window.calls).toEqual(['show', 'hide'])
    await expect(r.invoke(AVATAR_VIEW_CHANNELS.setPointerInside, window, true)).rejects.toThrow('Avatar is hidden')
  })

  test('refuses a window construction that fails and one whose listeners cannot be attached', async () => {
    const failed = rig()
    failed.state.createFails = true
    failed.controller.dispatch({ kind: 'ShowRequested' })
    expect(failed.windows).toHaveLength(0)
    expect(failed.controller.snapshot().lifecycle.kind).toBe('absent')
    expect(failed.reports.map((report) => report.message)).toContain('Avatar window could not be created')
    failed.state.createFails = false
    await failed.open()
    expect(failed.controller.snapshot().lifecycle.kind).toBe('ready')

    const partial = rig({ configure: (window) => window.failing.add('webContents.on') })
    partial.controller.dispatch({ kind: 'ShowRequested' })
    await flush()
    expect(partial.windows).toHaveLength(1)
    expect(partial.windows[0]!.destroyed).toBe(true)
    expect(aliveWindows(partial.windows)).toBe(0)
    expect(partial.controller.snapshot().lifecycle.kind).toBe('absent')
    expect(partial.controller.currentWindow()).toBeNull()
  })

  test('creates no window at all where the platform has none', () => {
    const r = rig({ available: false })
    r.controller.dispatch({ kind: 'ShowRequested' })
    r.controller.dispatch({ kind: 'ReloadRequested' })
    expect(r.windows).toHaveLength(0)
    expect(r.controller.snapshot().lifecycle.kind).toBe('unavailable')
  })
})

describe('ordering cases a to g through the real adapter and IPC handlers', () => {
  test('a: a reload during load destroys g1 first, ignores its late load and never shows it', async () => {
    const r = rig()
    r.controller.dispatch({ kind: 'ShowRequested' })
    const g1 = r.windows[0]!
    r.controller.dispatch({ kind: 'ReloadRequested' })
    expect(g1.destroyed).toBe(true)
    expect(r.windows).toHaveLength(2)
    const g2 = r.windows[1]!

    g1.finishLoad()
    await flush()
    expect(g1.sent).toEqual([])
    expect(g1.calls).toEqual([])
    expect(r.controller.currentWindow()).toBeNull()

    g2.finishLoad()
    await flush()
    expect(r.controller.currentWindow()?.generation).toBe(2)
    expect(g2.calls).toEqual(['show'])
    expect(r.state.maxAlive).toBe(1)
  })

  test('a: a reload waits for the old window to be gone before creating the replacement', async () => {
    const r = rig({ configure: (window) => { window.destroyMode = window.index === 1 ? 'silent' : 'closed' } })
    r.controller.dispatch({ kind: 'ShowRequested' })
    const g1 = r.windows[0]!
    r.controller.dispatch({ kind: 'ReloadRequested' })
    expect(r.windows).toHaveLength(1)
    g1.finishLoad()
    await flush()
    expect(g1.sent).toEqual([])
    g1.die()
    expect(r.windows).toHaveLength(2)
    expect(r.state.maxAlive).toBe(1)
  })

  test('a: shutdown during load destroys the window, ignores its late load and allocates nothing more', async () => {
    const r = rig()
    r.controller.dispatch({ kind: 'ShowRequested' })
    const g1 = r.windows[0]!
    r.controller.shutdown()
    expect(g1.destroyed).toBe(true)
    g1.finishLoad()
    await flush()
    r.controller.dispatch({ kind: 'ShowRequested' })
    r.controller.dispatch({ kind: 'ReloadRequested' })
    expect(r.windows).toHaveLength(1)
    expect(g1.sent).toEqual([])
    expect(r.timers.filter((timer) => timer.active)).toEqual([])
  })

  test('b: a crash reported by the previous window leaves the loading replacement alone', async () => {
    const r = rig({ configure: (window) => { window.destroyMode = window.index === 1 ? 'silent' : 'closed' } })
    const g1 = await r.open()
    r.controller.dispatch({ kind: 'ReloadRequested' })
    expect(r.windows).toHaveLength(1)
    g1.emitWeb('render-process-gone')
    g1.die()
    const g2 = r.windows[1]!
    g1.emitWeb('render-process-gone')
    expect(r.controller.snapshot().lifecycle).toMatchObject({ kind: 'loading', token: 2 })
    g2.finishLoad()
    await flush()
    expect(r.controller.snapshot().lifecycle).toMatchObject({ kind: 'ready', token: 2 })
    expect(aliveWindows(r.windows)).toBe(1)
  })

  test('c: a failing first publication retires the window at once and a later Show creates g2', async () => {
    const r = rig({ configure: (window) => { if (window.index === 1) window.failing.add('send') } })
    r.controller.dispatch({ kind: 'ShowRequested' })
    r.windows[0]!.finishLoad()
    await flush()
    expect(r.controller.currentWindow()).toBeNull()
    expect(r.windows[0]!.destroyed).toBe(true)
    expect(r.windows[0]!.calls).toEqual([])
    expect(r.controller.snapshot().lifecycle.kind).toBe('absent')

    await r.open()
    expect(r.windows).toHaveLength(2)
    expect(r.controller.currentWindow()?.generation).toBe(2)
    expect(r.state.maxAlive).toBe(1)
  })

  test('c: a failing show retires the window at once and a later Show creates g2', async () => {
    const r = rig({ configure: (window) => { if (window.index === 1) window.failing.add('showInactive') } })
    await r.open()
    expect(r.controller.currentWindow()).toBeNull()
    expect(r.windows[0]!.destroyed).toBe(true)
    expect(r.controller.snapshot().appearance.visible).toBe(true)

    await r.open()
    expect(r.windows).toHaveLength(2)
    expect(r.windows[1]!.calls).toEqual(['show'])
  })

  describe('c, named limit: failure then a destroy that cannot be attested', () => {
    test('current is null, the failure is traced, nothing is allocated, even after probes and retries', async () => {
      const r = rig({
        configure: (window) => {
          window.failing.add('send')
          window.destroyMode = 'throw'
        }
      })
      await r.open()
      const g1 = r.windows[0]!
      expect(r.controller.currentWindow()).toBeNull()
      expect(r.controller.snapshot().lifecycle).toMatchObject({ kind: 'retiring', phase: 'blocked' })
      expect(r.reports.map((report) => report.message)).toContain('Avatar window could not be destroyed')

      r.fire(2_000)
      expect(r.windows).toHaveLength(1)
      const destroysBefore = g1.destroyCalls
      r.controller.dispatch({ kind: 'ShowRequested' })
      expect(g1.destroyCalls).toBe(destroysBefore + 1)
      expect(r.windows).toHaveLength(1)
      expect(r.controller.currentWindow()).toBeNull()
    })

    test('a window that finally disappears lets the explicit Show create its replacement', async () => {
      const r = rig({ configure: (window) => { if (window.index === 1) { window.failing.add('send'); window.destroyMode = 'throw' } } })
      await r.open()
      const g1 = r.windows[0]!
      g1.destroyed = true
      g1.gone = true
      r.controller.dispatch({ kind: 'ShowRequested' })
      expect(r.windows).toHaveLength(2)
      expect(r.state.maxAlive).toBe(1)
    })

    test('a destroy that threw and a first probe that said alive: the 2 s watchdog acknowledges once the window is gone', async () => {
      const r = rig({ configure: (window) => { if (window.index === 1) { window.failing.add('send'); window.destroyMode = 'throw' } } })
      await r.open()
      const g1 = r.windows[0]!
      expect(r.controller.snapshot().lifecycle).toMatchObject({ kind: 'retiring', phase: 'blocked' })
      g1.destroyed = true
      g1.gone = true
      r.fire(2_000)
      expect(r.controller.snapshot().lifecycle.kind).toBe('absent')
      await r.open()
      expect(r.windows).toHaveLength(2)
      expect(r.state.maxAlive).toBe(1)
    })

    test('a destroy that returns while the window stays alive is not replaced at the 2 s watchdog', async () => {
      const r = rig({ configure: (window) => { window.destroyMode = 'silent' } })
      await r.open()
      r.controller.dispatch({ kind: 'ReloadRequested' })
      r.fire(2_000)
      expect(r.windows).toHaveLength(1)
      expect(r.controller.snapshot().lifecycle).toMatchObject({ kind: 'retiring', phase: 'blocked' })
    })

    test('a closed event that never comes is replaced by the 2 s watchdog probe', async () => {
      const r = rig({ configure: (window) => { if (window.index === 1) window.destroyMode = 'vanish-without-closed' } })
      await r.open()
      r.controller.dispatch({ kind: 'ReloadRequested' })
      expect(r.windows).toHaveLength(1)
      r.fire(2_000)
      expect(r.windows).toHaveLength(2)
      expect(r.state.maxAlive).toBe(1)
    })

    test('a crash-only retirement that is confirmed gone returns to absent without relaunch', async () => {
      const r = rig({ configure: (window) => { if (window.index === 1) window.destroyMode = 'vanish-without-closed' } })
      const g1 = await r.open()
      g1.emitWeb('render-process-gone')
      r.fire(2_000)
      expect(r.controller.snapshot().lifecycle.kind).toBe('absent')
      expect(r.windows).toHaveLength(1)
    })
  })

  test('d: a user close hides, publishes and persists visible:false, and the IPC then refuses every move', async () => {
    const r = rig()
    const g1 = await r.open()
    const writes = r.written.length

    expect(g1.emit('close')).toBe(true)
    expect(g1.destroyed).toBe(false)
    expect(g1.calls).toEqual(['show', 'hide'])
    expect(r.controller.snapshot().appearance.visible).toBe(false)
    expect(r.written.length).toBe(writes + 1)
    expect(lastWritten(r.written).visible).toBe(false)
    expect(r.tray.at(-1)?.presentation.visible).toBe(false)
    expect(g1.sent.at(-1)?.presentation.visible).toBe(false)

    await expect(r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 10, 10)).rejects.toThrow('Avatar is hidden')
    expect(r.timers.some((timer) => timer.active && timer.delay === 16)).toBe(false)
    expect(g1.moves).toEqual([])
    expect(Object.keys(lastWritten(r.written).positions)).toEqual([])
  })

  test('e: a stale move timer does nothing after hide then show, or lock then unlock', async () => {
    const r = rig()
    const g1 = await r.open()
    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 100, 200)
    const stale = r.activeTimer(16)
    r.controller.dispatch({ kind: 'HideRequested' })
    r.controller.dispatch({ kind: 'ShowRequested' })
    stale.callback()
    expect(g1.moves).toEqual([])

    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 150, 250)
    const lockedStale = r.activeTimer(16)
    r.controller.dispatch({ kind: 'LockChanged', value: true })
    r.controller.dispatch({ kind: 'LockChanged', value: false })
    lockedStale.callback()
    expect(g1.moves).toEqual([])
    for (const record of r.written) expect(Object.keys(record.positions)).toEqual([])
  })

  test('f: an applied P1 survives hide and lock, a refused or never-applied P2 is never written', async () => {
    const r = rig()
    const g1 = await r.open()
    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 100, 200)
    r.fire(16)
    expect(g1.moves).toEqual([[100, 200]])

    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 400, 400)
    r.controller.dispatch({ kind: 'LockChanged', value: true })
    await expect(r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 500, 500)).rejects.toThrow('Avatar position is locked')
    r.controller.dispatch({ kind: 'HideRequested' })
    r.controller.shutdown()

    expect(g1.moves).toEqual([[100, 200]])
    const record = lastWritten(r.written)
    expect(record.visible).toBe(false)
    expect(record.positionLocked).toBe(true)
    expect(record.positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
    for (const entry of r.written) {
      const position = entry.positions['1']
      if (position !== undefined) expect(position).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
    }
  })

  test('f: a native failure for P2 after P1 keeps P1 and traces the failure', async () => {
    const r = rig()
    const g1 = await r.open()
    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 100, 200)
    r.fire(16)
    g1.failing.add('setPosition')
    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 400, 400)
    r.fire(16)
    r.controller.shutdown()

    expect(r.reports.map((report) => report.message)).toContain('cannot move Avatar window')
    expect(lastWritten(r.written).positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
  })

  test('g: destroying for a reload turns neither the close nor the closure into a hide, for either intent', async () => {
    for (const visible of [true, false]) {
      const r = rig({ appearance: { visible }, configure: (window) => { window.destroyMode = 'close-then-closed' } })
      if (visible) await r.open()
      else {
        r.controller.dispatch({ kind: 'ReloadRequested' })
        r.windows[0]!.finishLoad()
        await flush()
      }
      const g1 = r.windows[0]!
      const writes = r.written.length
      r.controller.dispatch({ kind: 'ReloadRequested' })

      expect(g1.destroyed).toBe(true)
      expect(g1.closePrevented).toBe(false)
      expect(r.controller.snapshot().appearance.visible).toBe(visible)
      expect(r.written.length).toBe(writes)
      expect(g1.calls.filter((call) => call === 'hide')).toEqual([])
      expect(r.windows).toHaveLength(2)
    }
  })

  test('g: shutdown destroys without hiding either', async () => {
    const r = rig({ configure: (window) => { window.destroyMode = 'close-then-closed' } })
    const g1 = await r.open()
    r.controller.shutdown()
    expect(g1.destroyed).toBe(true)
    expect(g1.calls).toEqual(['show'])
    expect(r.controller.snapshot().appearance.visible).toBe(true)
  })
})

describe('initial state, crash, publication and persistence', () => {
  test('the first state request of a loading window waits for the promotion snapshot, which precedes the show', async () => {
    const r = rig()
    r.controller.dispatch({ kind: 'ShowRequested' })
    const g1 = r.windows[0]!
    const early = r.invoke(AVATAR_VIEW_CHANNELS.getState, g1)
    await expect(r.invoke(AVATAR_VIEW_CHANNELS.getState, g1)).rejects.toThrow('Avatar initial state is already awaited')
    let settled = false
    void early.then(() => { settled = true })
    await flush()
    expect(settled).toBe(false)

    g1.finishLoad()
    await flush()
    const envelope = (await early) as AvatarViewState
    expect(envelope.generation).toBe(1)
    expect(g1.sent[0]).toBe(envelope)
    expect(r.log).toEqual(['w1:show'])
    expect(g1.sent.length).toBeGreaterThan(0)
    await expect(r.invoke(AVATAR_VIEW_CHANNELS.getState, g1)).resolves.toBe(g1.sent.at(-1))
  })

  test('the first send of a window reaches it before its show', async () => {
    const r = rig()
    const order: string[] = []
    const g1Created = () => r.windows[0]!
    r.controller.dispatch({ kind: 'ShowRequested' })
    const g1 = g1Created()
    const send = g1.webContents.send
    g1.webContents.send = (channel, payload) => {
      order.push('send')
      send(channel, payload)
    }
    const show = g1.showInactive.bind(g1)
    g1.showInactive = () => {
      order.push('show')
      show()
    }
    g1.finishLoad()
    await flush()
    expect(order.indexOf('send')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('show')).toBeGreaterThan(order.indexOf('send'))
  })

  test('an invalidated window rejects its waiting state request', async () => {
    const r = rig()
    r.controller.dispatch({ kind: 'ShowRequested' })
    const g1 = r.windows[0]!
    const early = r.invoke(AVATAR_VIEW_CHANNELS.getState, g1)
    const outcome = early.then(() => 'resolved', (error: Error) => error.message)
    r.controller.dispatch({ kind: 'ReloadRequested' })
    expect(await outcome).toBe('AvatarView initial state was invalidated')
  })

  test('a state request from another window is refused while loading and after promotion', async () => {
    const r = rig()
    r.controller.dispatch({ kind: 'ShowRequested' })
    const g1 = r.windows[0]!
    const foreign = new FakeWindow(99, g1.options, [])
    await expect(r.invoke(AVATAR_VIEW_CHANNELS.getState, foreign)).rejects.toThrow('AvatarView sender is not current')
    g1.finishLoad()
    await flush()
    await expect(r.invoke(AVATAR_VIEW_CHANNELS.getState, foreign)).rejects.toThrow('AvatarView sender is not current')
  })

  test('a renderer crash destroys the window, keeps the intent visible and relaunches nothing', async () => {
    const r = rig()
    const g1 = await r.open()
    g1.emitWeb('render-process-gone')
    expect(g1.destroyed).toBe(true)
    expect(r.windows).toHaveLength(1)
    expect(r.controller.currentWindow()).toBeNull()
    expect(r.controller.snapshot().appearance.visible).toBe(true)
    expect(r.reports.map((report) => report.message)).toContain('Avatar renderer crashed')
    await flush()
    expect(r.windows).toHaveLength(1)

    await r.open()
    expect(r.controller.currentWindow()?.generation).toBe(2)
  })

  test('a document that fails to load is traced and retired', async () => {
    const r = rig()
    r.controller.dispatch({ kind: 'ShowRequested' })
    r.windows[0]!.failLoad()
    await flush()
    expect(r.controller.snapshot().lifecycle.kind).toBe('absent')
    expect(r.windows[0]!.destroyed).toBe(true)
    expect(r.reports.map((report) => report.message)).toContain('Avatar renderer could not load')
  })

  test('the load watchdog retires a document that never settles', () => {
    const r = rig()
    r.controller.dispatch({ kind: 'ShowRequested' })
    r.fire(15_000)
    expect(r.controller.snapshot().lifecycle.kind).toBe('absent')
    expect(r.windows[0]!.destroyed).toBe(true)
  })

  test('input is coalesced into one native move, one persistence, with the 16 and 500 ms delays', async () => {
    const r = rig()
    const g1 = await r.open()
    for (let index = 0; index < 100; index += 1) await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, index, index + 1)
    expect(r.timers.filter((timer) => timer.active && timer.delay === 16)).toHaveLength(1)

    r.fire(16)
    expect(g1.moves).toEqual([[99, 100]])
    expect(r.activeTimer(500)).toBeDefined()
    expect(r.written.every((record) => record.positions['1'] === undefined)).toBe(true)
    r.fire(500)
    expect(lastWritten(r.written).positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 99, y: 100 })
  })

  test('a failed native move persists nothing', async () => {
    const r = rig()
    const g1 = await r.open()
    g1.failing.add('setPosition')
    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 10, 20)
    r.fire(16)
    r.controller.shutdown()
    expect(r.reports.map((report) => report.message)).toContain('cannot move Avatar window')
    for (const record of r.written) expect(record.positions['1']).toBeUndefined()
  })

  test('a disk failure keeps the active preference, writes nothing more by itself and retries on the next change', async () => {
    const r = rig()
    await r.open()
    r.state.writeFails = true
    const attempts = r.state.writes
    r.controller.dispatch({ kind: 'HideRequested' })
    expect(r.state.writes).toBe(attempts + 1)
    expect(r.controller.snapshot().appearance.visible).toBe(false)
    expect(r.reports.map((report) => report.message)).toContain('Avatar appearance could not be written')
    await flush()
    expect(r.state.writes).toBe(attempts + 1)

    r.state.writeFails = false
    r.controller.dispatch({ kind: 'LockChanged', value: true })
    expect(lastWritten(r.written)).toMatchObject({ visible: false, positionLocked: true })
  })

  test('one A1 summary is taken per refresh and the Tray and window receive that same envelope', async () => {
    const r = rig()
    const g1 = await r.open()
    const builds = r.state.builds
    r.controller.dispatch({ kind: 'RefreshRequested' })
    expect(r.state.builds).toBe(builds + 1)
    expect(r.tray.at(-1)).toBe(g1.sent.at(-1))
  })

  test('shutdown flushes applied positions, destroys the window and leaves no timer behind', async () => {
    const r = rig()
    const g1 = await r.open()
    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 100, 200)
    r.fire(16)
    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 300, 300)
    r.controller.shutdown()

    expect(g1.destroyed).toBe(true)
    expect(g1.moves).toEqual([[100, 200]])
    expect(lastWritten(r.written).positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
    expect(r.timers.filter((timer) => timer.active)).toEqual([])
    r.controller.shutdown()
    expect(g1.destroyCalls).toBe(1)
  })

  test('shutdown is bounded: a destroy that throws and a disk that fails are reported, never thrown, never awaited', async () => {
    const r = rig({ configure: (window) => { window.destroyMode = 'throw' } })
    const g1 = await r.open()
    await r.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 100, 200)
    r.fire(16)
    r.state.writeFails = true

    expect(() => r.controller.shutdown()).not.toThrow()

    expect(r.controller.snapshot().lifecycle).toMatchObject({ kind: 'retiring', destination: 'stop' })
    const messages = r.reports.map((report) => report.message)
    expect(messages).toContain('Avatar window could not be destroyed')
    expect(messages).toContain('Avatar appearance could not be written')
    expect(r.timers.filter((timer) => timer.active)).toEqual([])
    r.controller.dispatch({ kind: 'ShowRequested' })
    expect(r.windows).toHaveLength(1)
  })

  test('a queued event that throws does not lose the queued events behind it', async () => {
    let ctl: ReturnType<typeof rig> | null = null
    const r = rig({
      configure: (window) => {
        window.onDestroy = () => {
          ctl!.controller.dispatch({ kind: 'Unclassified' } as never)
        }
      }
    })
    ctl = r
    await r.open()
    r.controller.dispatch({ kind: 'ReloadRequested' })

    expect(r.reports.map((report) => report.message)).toContain('Avatar queued event failed')
    expect(r.windows).toHaveLength(2)
    expect(r.controller.snapshot().lifecycle).toMatchObject({ kind: 'loading', token: 2 })
    expect(r.state.maxAlive).toBe(1)
  })

  test('a native event arriving while an effect runs is handled after the effect result', async () => {
    const r = rig({ configure: (window) => { window.destroyMode = 'close-then-closed' } })
    const g1 = await r.open()
    r.controller.dispatch({ kind: 'ReloadRequested' })
    expect(r.windows).toHaveLength(2)
    expect(g1.gone).toBe(true)
    expect(aliveWindows(r.windows)).toBe(1)
    expect(r.state.maxAlive).toBe(1)
  })
})

describe('native adapter against a missing or duplicated handle', () => {
  function adapter() {
    const windows: FakeWindow[] = []
    const native = createAvatarNativeAdapter({
      preload: 'p.js',
      html: 'a.html',
      createWindow: (options) => {
        const window = new FakeWindow(windows.length + 1, options, [])
        windows.push(window)
        return window
      },
      callbacks: { rendererGone: () => {}, closeRequested: () => false, closed: () => {} }
    })
    return { native, windows }
  }

  test('every native operation on an unknown token fails explicitly instead of being credited as a success', async () => {
    const { native } = adapter()
    const refused = 'Avatar window is unavailable'
    expect(() => native.show(7)).toThrow(refused)
    expect(() => native.hide(7)).toThrow(refused)
    expect(() => native.setPosition(7, 1, 2)).toThrow(refused)
    expect(() => native.prepare(7, 1, 2, true)).toThrow(refused)
    expect(() => native.setPointerMode(7, true)).toThrow(refused)
    expect(() => native.setAlwaysOnTop(7, true)).toThrow(refused)
    expect(() => native.send(7, {} as AvatarViewState)).toThrow(refused)
    await expect(native.load(7)).rejects.toThrow(refused)
    expect(native.endpoint(7)).toBeNull()
    expect(native.isDestroyed(7)).toBe(true)
    expect(() => native.destroy(7)).not.toThrow()
  })

  test('a second window cannot be held while the first is registered, and release frees the slot', () => {
    const { native, windows } = adapter()
    native.allocate(1, true)
    expect(() => native.allocate(2, true)).toThrow('Avatar window is already held')
    expect(windows).toHaveLength(1)
    expect(native.endpoint(1)?.generation).toBe(1)
    native.release(1)
    native.allocate(2, true)
    expect(windows).toHaveLength(2)
  })
})
