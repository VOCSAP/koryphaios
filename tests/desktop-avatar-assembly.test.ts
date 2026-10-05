import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readAvatarAppearance,
  writeAvatarAppearance,
  type AvatarAppearance
} from '../desktop/src/main/avatar-appearance.ts'
import { assembleAvatar, followAvatarScreens } from '../desktop/src/main/avatar-assembly.ts'
import type { AvatarBrowserWindow, AvatarViewIpcHandler } from '../desktop/src/main/avatar-window.ts'
import type { AvatarGeometry } from '../desktop/src/main/avatar-window-state.ts'
import { AVATAR_VIEW_CHANNELS, type AvatarViewState } from '../desktop/src/shared/avatar-view.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-avatar-assembly-'))
  dirs.push(dir)
  return dir
}

const MAIN = { id: '1', workArea: { x: 0, y: 0, width: 1000, height: 800 } }
const LEFT = { id: '2', workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }
const GEOMETRY: AvatarGeometry = { displays: [MAIN] }

class MiniWindow implements AvatarBrowserWindow {
  destroyed = false
  readonly sent: AvatarViewState[] = []
  readonly positions: [number, number][] = []
  readonly calls: string[] = []
  private readonly listeners = new Map<string, (...args: unknown[]) => void>()
  readonly webContents = {
    mainFrame: {},
    send: (_channel: string, payload: AvatarViewState): void => {
      this.sent.push(payload)
    },
    setWindowOpenHandler: (): void => {},
    on: (event: string, listener: (...args: unknown[]) => void): void => {
      this.listeners.set(`web:${event}`, listener)
    }
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener)
  }

  emit(event: string): boolean {
    let prevented = false
    this.listeners.get(event)?.({ preventDefault: () => { prevented = true } })
    return prevented
  }

  crash(): void {
    this.listeners.get('web:render-process-gone')?.()
  }

  destroy(): void {
    this.destroyed = true
    this.emit('closed')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  hide(): void {
    this.calls.push('hide')
  }

  loadFile(): Promise<unknown> {
    return Promise.resolve()
  }

  setAlwaysOnTop(): void {}
  setIgnoreMouseEvents(): void {}

  setPosition(x: number, y: number): void {
    this.positions.push([x, y])
  }

  private size: [number, number] = [0, 0]

  setSize(width: number, height: number): void {
    this.size = [width, height]
  }

  setContentSize(width: number, height: number): void {
    this.size = [width, height]
  }

  getSize(): number[] {
    return [...this.size]
  }

  showInactive(): void {
    this.calls.push('show')
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function setup(options: { geometry?: AvatarGeometry; seed?: AvatarAppearance; locale?: 'en' | 'fr' } = {}) {
  const dir = tempDir()
  const file = join(dir, 'avatar-appearance.json')
  const target = { file }
  if (options.seed) writeAvatarAppearance(file, options.seed, { reportError: () => {} })
  const reports: string[] = []
  const gestures: string[] = []
  const reportError = (_scope: string, message: string): void => {
    reports.push(message)
  }
  const handlers = new Map<string, AvatarViewIpcHandler>()
  const windows: MiniWindow[] = []
  const timers: { delay: number; callback: () => void; active: boolean }[] = []
  let dark = true
  let reads = 0
  const startupAppearance = (() => {
    reads += 1
    return readAvatarAppearance(file, { reportError })
  })()
  const assembly = assembleAvatar({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => { handlers.delete(channel) } },
    available: true,
    preload: 'avatar-preload.js',
    html: 'avatar.html',
    createWindow: () => {
      const window = new MiniWindow()
      windows.push(window)
      return window
    },
    appearance: startupAppearance,
    writeSnapshot: (snapshot) => writeAvatarAppearance(target.file, snapshot, { reportError }),
    geometry: () => options.geometry ?? GEOMETRY,
    theme: () => (dark ? 'dark' : 'light'),
    locale: options.locale ?? 'fr',
    now: () => 1_000,
    reportError,
    gesture: (kind) => { gestures.push(kind) },
    setTimeout: (callback, delay) => {
      const timer = { delay, callback, active: true }
      timers.push(timer)
      return timer
    },
    clearTimeout: (handle) => {
      ;(handle as { active: boolean }).active = false
    }
  })
  const invoke = (channel: string, window: MiniWindow, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(channel)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args))
  const fire = (delay: number): void => {
    const timer = [...timers].reverse().find((candidate) => candidate.active && candidate.delay === delay)
    if (!timer) throw new Error(`no ${delay} ms timer`)
    timer.active = false
    timer.callback()
  }
  const open = async (): Promise<MiniWindow> => {
    assembly.controller.dispatch({ kind: 'ShowRequested' })
    await flush()
    return windows[windows.length - 1]!
  }
  const stored = (): AvatarAppearance => JSON.parse(readFileSync(target.file, 'utf8')) as AvatarAppearance
  return { assembly, file, target, dir, reports, gestures, handlers, windows, invoke, fire, open, stored, reads: () => reads, setDark: (value: boolean) => { dark = value } }
}

function seed(patch: Partial<AvatarAppearance> = {}): AvatarAppearance {
  return {
    version: 1,
    visible: true,
    alwaysOnTop: true,
    positionLocked: false,
    size: 'm',
    frame: 'normal',
    idleOpacity: 1,
    motion: 'continuous',
    dndUntil: null,
    dndChoice: null,
    positions: {},
    ...patch
  }
}

describe('Avatar assembly', () => {
  test('creates no window and registers the four view channels until an explicit Show', () => {
    const s = setup()
    expect(s.windows).toHaveLength(0)
    expect([...s.handlers.keys()].sort()).toEqual(Object.values(AVATAR_VIEW_CHANNELS).filter((channel) => channel !== AVATAR_VIEW_CHANNELS.state).sort())
    s.assembly.dispose()
    expect(s.handlers.size).toBe(0)
  })

  test('forwards a validated gesture from the current Avatar window', async () => {
    const s = setup()
    const window = await s.open()

    await s.invoke(AVATAR_VIEW_CHANNELS.gesture, window, 'single')
    expect(s.gestures).toEqual(['single'])

    await s.invoke(AVATAR_VIEW_CHANNELS.gesture, window, 'double')
    expect(s.stored().visible).toBe(false)
    expect(s.gestures).toEqual(['single'])
  })

  test('the persisted file is a pure output: tampering with it mid-run is overwritten, never merged back', async () => {
    const s = setup()
    const window = await s.open()
    writeFileSync(s.file, JSON.stringify({ ...seed(), visible: false, positionLocked: true, idleOpacity: 0.2 }))

    s.assembly.controller.dispatch({ kind: 'AppearanceChanged', patch: { motion: 'none' } })

    expect(s.stored()).toMatchObject({ visible: true, positionLocked: false, idleOpacity: 1, motion: 'none' })
    expect(s.assembly.controller.snapshot().appearance).toMatchObject({ visible: true, positionLocked: false, idleOpacity: 1 })
    expect(s.reads()).toBe(1)
    expect(window.destroyed).toBe(false)
  })

  test('a user close writes visible:false and the real IPC handler then refuses the move, with nothing moved or stored', async () => {
    const s = setup()
    const window = await s.open()

    expect(window.emit('close')).toBe(true)

    expect(s.stored().visible).toBe(false)
    await expect(s.invoke(AVATAR_VIEW_CHANNELS.setPosition, window, 30, 40)).rejects.toThrow('Avatar is hidden')
    expect(window.positions.slice(1)).toEqual([])
    expect(s.stored().positions).toEqual({})
  })

  test('an applied P1 is stored after hide while a refused P2 never is', async () => {
    const s = setup()
    const window = await s.open()
    await s.invoke(AVATAR_VIEW_CHANNELS.setPosition, window, 100, 200)
    s.fire(16)
    s.assembly.controller.dispatch({ kind: 'HideRequested' })
    await expect(s.invoke(AVATAR_VIEW_CHANNELS.setPosition, window, 400, 400)).rejects.toThrow('Avatar is hidden')
    s.fire(500)

    expect(s.stored()).toMatchObject({ visible: false, positions: { '1': { workArea: MAIN.workArea, x: 100, y: 200 } } })
    expect(window.positions.slice(1)).toEqual([[100, 200]])
  })

  test('a disk failure keeps the preference and the position debt, then the next change writes both', async () => {
    const s = setup()
    const window = await s.open()
    await s.invoke(AVATAR_VIEW_CHANNELS.setPosition, window, 100, 200)
    s.fire(16)
    const good = s.target.file
    s.target.file = join(good, 'blocked', 'avatar-appearance.json')
    writeFileSync(good, '{}')

    s.assembly.controller.dispatch({ kind: 'HideRequested' })

    expect(s.assembly.controller.snapshot().appearance.visible).toBe(false)
    expect(s.reports.some((message) => message.startsWith('cannot write'))).toBe(true)
    s.target.file = good
    s.assembly.controller.dispatch({ kind: 'LockChanged', value: true })
    expect(s.stored()).toMatchObject({ visible: false, positionLocked: true, positions: { '1': { x: 100, y: 200 } } })
  })

  test('a position on a negative-coordinate screen is restored on the first window and again on the next one', async () => {
    const saved = seed({ positions: { '2': { workArea: LEFT.workArea, x: -1800, y: 100 } } })
    const s = setup({ geometry: { displays: [MAIN, LEFT] }, seed: saved })
    const g1 = await s.open()
    expect(g1.positions).toEqual([[-1800, 100]])

    s.assembly.controller.dispatch({ kind: 'ReloadRequested' })
    await flush()
    const g2 = s.windows[1]!
    expect(g2.positions).toEqual([[-1800, 100]])
    expect(s.stored().positions['2']).toEqual({ workArea: LEFT.workArea, x: -1800, y: 100 })
  })

  test('move, renderer crash, Show: the next window gets the same position', async () => {
    const s = setup()
    const g1 = await s.open()
    await s.invoke(AVATAR_VIEW_CHANNELS.setPosition, g1, 123, 234)
    s.fire(16)
    s.fire(500)
    g1.crash()
    await flush()
    expect(s.windows).toHaveLength(1)
    expect(g1.destroyed).toBe(true)

    const g2 = await s.open()
    expect(g2).not.toBe(g1)
    expect(g2.positions).toEqual([[123, 234]])
    expect(s.stored().positions['1']).toEqual({ workArea: MAIN.workArea, x: 123, y: 234 })
  })

  test('the Tray summary and the window envelope come from one A1 summary per refresh', async () => {
    const s = setup()
    const window = await s.open()
    let summaries = 0
    const summary = s.assembly.state.summary.bind(s.assembly.state)
    s.assembly.state.summary = () => {
      summaries += 1
      return summary()
    }

    const traySummary = s.assembly.traySummary()

    expect(summaries).toBe(1)
    expect(traySummary).toBe(window.sent.at(-1)!.summary)
  })

  test('the locale given to the assembly is the one the projection speaks', async () => {
    const en = setup({ locale: 'en' })
    const fr = setup({ locale: 'fr' })
    await en.open()
    await fr.open()

    const english = en.assembly.traySummary().faceCopy
    const french = fr.assembly.traySummary().faceCopy

    expect(french.title, 'two locales must not project the same copy').not.toBe(english.title)
    expect(english).toEqual({ title: 'No Deck attached', ariaLabel: 'Koryphaios avatar: No Deck attached' })
    expect(french).toEqual({ title: 'Aucun Deck attaché', ariaLabel: 'Avatar Koryphaios : Aucun Deck attaché' })
  })

  test('the theme and the Do Not Disturb choice flow through the machine to the window and the file', async () => {
    const s = setup()
    const window = await s.open()

    s.setDark(false)
    s.assembly.themeChanged()
    s.assembly.chooseDnd('30m')

    expect(window.sent.at(-1)!.presentation).toMatchObject({ theme: 'light', dndActive: true })
    expect(s.assembly.trayDnd()).toEqual({ choice: '30m', until: 1_000 + 30 * 60_000 })
    expect(s.stored()).toMatchObject({ dndChoice: '30m', dndUntil: 1_000 + 30 * 60_000 })
  })

  test('a screen topology change hands the freshly read geometry to the machine', async () => {
    const options: { geometry: AvatarGeometry } = { geometry: GEOMETRY }
    const s = setup(options)
    await s.open()
    const wider: AvatarGeometry = { displays: [MAIN, { id: '2', workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }] }
    options.geometry = wider

    expect(s.assembly.controller.snapshot().geometry, 'the geometry is read again only on a topology event').toEqual(GEOMETRY)
    s.assembly.geometryChanged()
    expect(s.assembly.controller.snapshot().geometry).toEqual(wider)
  })

  test('each of the three display events triggers a geometry refresh, and stopping detaches all three', () => {
    const source = new EventEmitter()
    const seen: string[] = []
    let current = ''
    const stop = followAvatarScreens(source, () => seen.push(current))

    for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
      current = event
      source.emit(event, {}, {})
    }
    expect(seen).toEqual(['display-added', 'display-removed', 'display-metrics-changed'])

    stop()
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      expect(source.listenerCount(event), `${event} still has a listener after stop`).toBe(0)
      source.emit(event, {}, {})
    }
    expect(seen).toHaveLength(3)
  })

  test('dispose flushes the applied position, destroys the window and unregisters the handlers', async () => {
    const s = setup()
    const window = await s.open()
    await s.invoke(AVATAR_VIEW_CHANNELS.setPosition, window, 100, 200)
    s.fire(16)

    s.assembly.dispose()

    expect(window.destroyed).toBe(true)
    expect(s.handlers.size).toBe(0)
    expect(s.stored().positions['1']).toEqual({ workArea: MAIN.workArea, x: 100, y: 200 })
  })
})
