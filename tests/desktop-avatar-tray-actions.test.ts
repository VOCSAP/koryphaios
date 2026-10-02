import { expect, test } from 'bun:test'
import type { AvatarAppearance } from '../desktop/src/main/avatar-appearance.ts'
import { assembleAvatar } from '../desktop/src/main/avatar-assembly.ts'
import { AVATAR_TRAY_ACTION_KINDS, buildAvatarTrayMenu, type AvatarTrayAction, type AvatarTrayMenuItem } from '../desktop/src/main/avatar-tray-menu.ts'
import { createAvatarTray, type AvatarTrayDependencies } from '../desktop/src/main/avatar-tray.ts'
import type { AvatarBrowserWindow } from '../desktop/src/main/avatar-window.ts'
import { AVATAR_WINDOW_SIZES } from '../desktop/src/main/avatar-window-placement.ts'
import { selectWindowShown } from '../desktop/src/main/avatar-window-state.ts'
import type { AvatarAttachRequest } from '../desktop/src/shared/avatar-protocol.ts'
import type { AvatarViewState } from '../desktop/src/shared/avatar-view.ts'

const NOW = 1_000

const APPEARANCE: AvatarAppearance = {
  version: 1,
  visible: true,
  alwaysOnTop: true,
  positionLocked: false,
  size: 'm',
  idleOpacity: 1,
  motion: 'continuous',
  dndUntil: null,
  dndChoice: null,
  positions: {}
}

const DECK: AvatarAttachRequest = {
  protocol_version: 1,
  deckRunId: 'deck-1',
  deckPid: 1,
  broker_url: 'https://broker.test',
  projectDir: 'C:/work',
  deckName: 'Alpha'
}

class MiniWindow implements AvatarBrowserWindow {
  destroyed = false
  readonly calls: string[] = []
  private readonly listeners = new Map<string, (...args: unknown[]) => void>()
  readonly webContents = {
    mainFrame: {},
    send: (_channel: string, _payload: AvatarViewState): void => {},
    setWindowOpenHandler: (): void => {},
    on: (event: string, listener: (...args: unknown[]) => void): void => {
      this.listeners.set(`web:${event}`, listener)
    }
  }

  crash(): void {
    this.listeners.get('web:render-process-gone')?.()
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener)
  }

  destroy(): void {
    this.destroyed = true
    this.listeners.get('closed')?.({ preventDefault: () => {} })
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

  setAlwaysOnTop(value: boolean): void {
    this.calls.push(`alwaysOnTop:${value}`)
  }

  setIgnoreMouseEvents(): void {}
  setPosition(): void {}

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

interface NativeItem {
  checked?: boolean
  submenu?: NativeItem[]
  click?: () => void
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function setup() {
  const windows: MiniWindow[] = []
  const menus: NativeItem[][] = []
  let heartbeat: (() => void) | null = null
  const assembly = assembleAvatar({
    ipc: { handle: () => {}, removeHandler: () => {} },
    available: true,
    preload: 'avatar-preload.js',
    html: 'avatar.html',
    createWindow: () => {
      const window = new MiniWindow()
      windows.push(window)
      return window
    },
    appearance: { ...APPEARANCE, positions: {} },
    writeSnapshot: () => {},
    geometry: () => ({ displays: [{ id: '1', workArea: { x: 0, y: 0, width: 1000, height: 800 } }] }),
    theme: () => 'dark',
    locale: 'en',
    now: () => NOW,
    reportError: () => {},
    setTimeout: () => ({}),
    clearTimeout: () => {}
  })
  assembly.state.receiveSnapshot({
    identity: { deckRunId: DECK.deckRunId, broker_url: DECK.broker_url },
    counters: { working: 1, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
    unread: 0
  })
  const dependencies: AvatarTrayDependencies = {
    now: () => NOW,
    loadImage: () => ({ isEmpty: () => false }),
    createTray: () => ({ setToolTip: () => {}, setContextMenu: (menu) => menus.push(menu as NativeItem[]), setImage: () => {}, destroy: () => {} }),
    buildMenu: (template) => template,
    setInterval: (callback) => {
      heartbeat = callback
      return 'timer' as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {},
    reportError: (_scope, message) => {
      throw new Error(message)
    },
    platform: 'win32',
    systemIntegratedUiDark: () => true,
    onSystemThemeUpdated: () => () => {}
  }
  const tray = createAvatarTray({
    summary: assembly.traySummary,
    iconDir: 'icons',
    locale: 'en',
    attachedDecks: () => [DECK],
    appearance: () => assembly.controller.snapshot().appearance,
    windowShown: () => selectWindowShown(assembly.controller.snapshot()),
    dispatch: assembly.controller.dispatch,
    getDnd: assembly.trayDnd,
    onDnd: assembly.chooseDnd,
    onDeckMenuClick: () => {},
    onQuit: () => {}
  }, dependencies)
  assembly.controller.dispatch({ kind: 'RestoreRequested' })
  await flush()

  const appearance = () => assembly.controller.snapshot().appearance
  const pureMenu = (): AvatarTrayMenuItem[] =>
    buildAvatarTrayMenu(assembly.traySummary(), [DECK], assembly.trayDnd(), NOW, appearance(), selectWindowShown(assembly.controller.snapshot()), 'en').items
  const locate = (match: (action: AvatarTrayAction) => boolean): { pure: AvatarTrayMenuItem; native: NativeItem } => {
    const walk = (pure: AvatarTrayMenuItem[], native: NativeItem[]): { pure: AvatarTrayMenuItem; native: NativeItem } | null => {
      for (const [index, item] of pure.entries()) {
        if (item.action && match(item.action)) return { pure: item, native: native[index]! }
        if (item.submenu) {
          const found = walk(item.submenu, native[index]!.submenu!)
          if (found) return found
        }
      }
      return null
    }
    const found = walk(pureMenu(), menus.at(-1)!)
    if (!found) throw new Error('no menu entry carries this action')
    return found
  }
  const checkedIn = (group: (action: AvatarTrayAction) => boolean): AvatarTrayAction[] => {
    const collect = (pure: AvatarTrayMenuItem[], native: NativeItem[]): AvatarTrayAction[] =>
      pure.flatMap((item, index) => [
        ...(item.action && group(item.action) && native[index]!.checked ? [item.action] : []),
        ...(item.submenu ? collect(item.submenu, native[index]!.submenu!) : [])
      ])
    return collect(pureMenu(), menus.at(-1)!)
  }
  const tick = (): void => {
    if (heartbeat === null) throw new Error('the Tray armed no heartbeat')
    heartbeat()
  }
  tick()
  return { assembly, tray, windows, menus, appearance, locate, checkedIn, pureMenu, tick }
}

test('Show the avatar hides and shows the window through the machine, and its tick follows the snapshot', async () => {
  const s = await setup()
  const window = s.windows.at(-1)!
  expect(s.locate((a) => a.kind === 'visible').native.checked).toBe(true)

  s.locate((a) => a.kind === 'visible').native.click!()
  expect(s.appearance().visible).toBe(false)
  expect(window.calls).toContain('hide')
  expect(s.locate((a) => a.kind === 'visible').native.checked, 'the tick must follow the machine').toBe(false)

  s.locate((a) => a.kind === 'visible').native.click!()
  await flush()
  expect(s.appearance().visible).toBe(true)
  expect(s.locate((a) => a.kind === 'visible').native.checked).toBe(true)
})

test('after a renderer crash the Show box is unticked and one click brings exactly one new window', async () => {
  const s = await setup()
  const before = s.windows.length
  s.windows.at(-1)!.crash()
  await flush()
  s.tick()
  expect(s.appearance().visible, 'a crash keeps the intention').toBe(true)

  const entry = s.locate((a) => a.kind === 'visible')
  expect(entry.native.checked, 'no window, so the box must not claim one').toBe(false)
  entry.native.click!()
  await flush()
  expect(s.windows.length - before, 'one click, one allocation').toBe(1)
  expect(s.locate((a) => a.kind === 'visible').native.checked).toBe(true)
})

test('Lock position and Always on top reach the machine, the native window and their ticks', async () => {
  const s = await setup()
  const window = s.windows.at(-1)!
  expect(s.locate((a) => a.kind === 'always-on-top').native.checked, 'stored on top before any click').toBe(true)

  s.locate((a) => a.kind === 'lock').native.click!()
  expect(s.appearance().positionLocked).toBe(true)
  expect(s.locate((a) => a.kind === 'lock').native.checked).toBe(true)

  s.locate((a) => a.kind === 'always-on-top').native.click!()
  expect(s.appearance().alwaysOnTop).toBe(false)
  expect(window.calls).toContain('alwaysOnTop:false')
  expect(s.locate((a) => a.kind === 'always-on-top').native.checked).toBe(false)
})

test('Motion checks exactly the stored choice', async () => {
  const s = await setup()
  expect(s.checkedIn((a) => a.kind === 'motion')).toEqual([{ kind: 'motion', value: 'continuous' }])

  s.locate((a) => a.kind === 'motion' && a.value === 'none').native.click!()
  expect(s.appearance().motion).toBe('none')
  expect(s.checkedIn((a) => a.kind === 'motion')).toEqual([{ kind: 'motion', value: 'none' }])
})

test('Size checks the stored choice and its click resizes the native window', async () => {
  const s = await setup()
  const window = s.windows.at(-1)!
  expect(s.checkedIn((a) => a.kind === 'size')).toEqual([{ kind: 'size', value: 'm' }])
  expect(window.getSize()).toEqual([AVATAR_WINDOW_SIZES.m.width, AVATAR_WINDOW_SIZES.m.height])

  s.locate((a) => a.kind === 'size' && a.value === 'l').native.click!()
  await flush()
  expect(s.appearance().size).toBe('l')
  expect(window.getSize(), 'the menu choice must reach the native window').toEqual([AVATAR_WINDOW_SIZES.l.width, AVATAR_WINDOW_SIZES.l.height])
  expect(s.checkedIn((a) => a.kind === 'size')).toEqual([{ kind: 'size', value: 'l' }])
})

test('Do not disturb checks Off when inactive, the chosen duration when active, and Off turns it off', async () => {
  const s = await setup()
  const dndGroup = (a: AvatarTrayAction): boolean => a.kind === 'dnd' || a.kind === 'dnd-off'
  expect(s.checkedIn(dndGroup), 'inactive: exactly Off').toEqual([{ kind: 'dnd-off' }])

  s.locate((a) => a.kind === 'dnd' && a.choice === '1h').native.click!()
  expect(s.appearance().dndChoice).toBe('1h')
  expect(s.checkedIn(dndGroup), 'active: exactly the chosen duration').toEqual([{ kind: 'dnd', choice: '1h' }])

  s.locate((a) => a.kind === 'dnd-off').native.click!()
  expect(s.appearance().dndUntil).toBeNull()
  expect(s.checkedIn(dndGroup)).toEqual([{ kind: 'dnd-off' }])
})

test('the menu offers every action kind the Tray knows how to route', async () => {
  const s = await setup()
  const kinds = new Set<string>()
  const visit = (items: AvatarTrayMenuItem[]): void => {
    for (const item of items) {
      if (item.action) kinds.add(item.action.kind)
      if (item.submenu) visit(item.submenu)
    }
  }
  visit(s.pureMenu())
  expect([...kinds].sort()).toEqual(Object.keys(AVATAR_TRAY_ACTION_KINDS).sort())
})
