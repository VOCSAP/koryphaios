import { expect, test } from 'bun:test'
import { avatarFaceCopy } from '../desktop/src/main/avatar-face-copy.ts'
import { AVATAR_TRAY_COPY } from '../desktop/src/main/avatar-tray-copy.ts'
import {
  avatarTrayMayRebound,
  buildAvatarTrayMenu,
  chooseAvatarDnd,
  type AvatarDndState,
  type AvatarTrayAppearance,
  type AvatarTrayMenuItem
} from '../desktop/src/main/avatar-tray-menu.ts'
import { createAvatarTray, type AvatarTrayDependencies } from '../desktop/src/main/avatar-tray.ts'
import { AVATAR_HEARTBEAT_MS, AvatarState, type AvatarSummary } from '../desktop/src/shared/avatar-state.ts'
import type { AvatarAttachRequest } from '../desktop/src/shared/avatar-protocol.ts'
import type { AvatarViewSummary } from '../desktop/src/shared/avatar-view.ts'

const now = new Date(2026, 4, 14, 10, 30).getTime()

const APPEARANCE: AvatarTrayAppearance = { positionLocked: false, alwaysOnTop: true, motion: 'continuous', size: 'm' }

function view(summary: AvatarSummary): AvatarViewSummary {
  return { ...summary, faceCopy: avatarFaceCopy(summary, 'en') }
}

function stateSummary(): AvatarViewSummary {
  const state = new AvatarState({ now: () => now })
  state.receiveSnapshot({
    identity: { deckRunId: 'deck-1', broker_url: 'https://broker-one.test/?a=1&b=2' },
    counters: { working: 2, idle: 0, unknown: 0, waiting: 1, exited: 0, rateLimited: 0 },
    unread: 1
  })
  state.receiveSnapshot({
    identity: { deckRunId: 'deck-2', broker_url: 'https://broker-two.test/?x=3&y=4' },
    counters: { working: 1, idle: 1, unknown: 0, waiting: 1, exited: 0, rateLimited: 0 },
    unread: 3
  })
  return view(state.summary())
}

const summary = stateSummary()

const attached: AvatarAttachRequest[] = [
  {
    protocol_version: 1,
    deckRunId: 'deck-1',
    deckPid: 1,
    broker_url: 'https://broker-one.test/?a=1&b=2',
    projectDir: 'C:/work/A & B',
    deckName: 'Alpha & Beta'
  },
  {
    protocol_version: 1,
    deckRunId: 'deck-2',
    deckPid: 2,
    broker_url: 'https://broker-two.test/?x=3&y=4',
    projectDir: 'D:/projects/Second & Deck',
    deckName: 'Alpha & Beta'
  }
]

interface NativeItem {
  label?: string
  checked?: boolean
  submenu?: NativeItem[]
  click?: () => void
}

function labels(items: AvatarTrayMenuItem[]): string[] {
  return items.flatMap((item) => [item.label, ...(item.submenu ? labels(item.submenu) : [])]).filter((label): label is string => label !== undefined)
}

function findNativeItem(items: NativeItem[], label: string): NativeItem | undefined {
  for (const item of items) {
    if (item.label === label) return item
    if (item.submenu) {
      const found = findNativeItem(item.submenu, label)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function requireNativeItem(items: NativeItem[], label: string): NativeItem {
  const item = findNativeItem(items, label)
  if (item === undefined) throw new Error(`Missing native menu item: ${label}`)
  return item
}

function deckSubmenus(menu: ReturnType<typeof buildAvatarTrayMenu>): AvatarTrayMenuItem[][] {
  return menu.items.filter((item) => item.submenu?.some((child) => child.label === 'Bring Deck to front')).map((item) => item.submenu!)
}

test('keeps raw unique Deck labels and complete distinct Deck details in the pure menu model', () => {
  const menu = buildAvatarTrayMenu(summary, attached, null, now, APPEARANCE, true, 'en')

  expect(menu.tooltip).toBe('Koryphaios avatar: 2 sessions are waiting for you')
  expect(labels(menu.items)).toEqual(expect.arrayContaining([
    'Alpha & Beta',
    'Alpha & Beta (2)',
    'Project: C:/work/A & B',
    'Broker: https://broker-one.test/?a=1&b=2',
    '2 working | 1 waiting | 1 unread',
    'Project: D:/projects/Second & Deck',
    'Broker: https://broker-two.test/?x=3&y=4',
    '1 working | 1 waiting | 3 unread'
  ]))
  expect(deckSubmenus(menu)).toEqual([
    [
      { label: 'Project: C:/work/A & B', enabled: false },
      { label: 'Broker: https://broker-one.test/?a=1&b=2', enabled: false },
      { label: '2 working | 1 waiting | 1 unread', enabled: false },
      { type: 'separator' },
      { label: 'Bring Deck to front', action: { kind: 'deck-focus', identity: summary.decks[0]!.identity } }
    ],
    [
      { label: 'Project: D:/projects/Second & Deck', enabled: false },
      { label: 'Broker: https://broker-two.test/?x=3&y=4', enabled: false },
      { label: '1 working | 1 waiting | 3 unread', enabled: false },
      { type: 'separator' },
      { label: 'Bring Deck to front', action: { kind: 'deck-focus', identity: summary.decks[1]!.identity } }
    ]
  ])
  expect(menu.items.at(-1)?.action).toEqual({ kind: 'quit' })
})

test('keeps every counter while each do-not-disturb choice is active and falls back to Off once it expires', () => {
  const noDnd = buildAvatarTrayMenu(summary, attached, null, now, APPEARANCE, true, 'en')
  const checkedDnd = (menu: ReturnType<typeof buildAvatarTrayMenu>) =>
    menu.items.find((item) => item.label === 'Do not disturb')?.submenu?.filter((item) => item.checked).map((item) => item.action)
  expect(checkedDnd(noDnd), 'an inactive mode checks Off and only Off').toEqual([{ kind: 'dnd-off' }])
  const choices = [
    ['30m', now + 30 * 60 * 1_000],
    ['1h', now + 60 * 60 * 1_000],
    ['tomorrow', new Date(2026, 4, 15).getTime()]
  ] as const

  for (const [choice, until] of choices) {
    const dnd = chooseAvatarDnd(choice, now)
    expect(dnd).toEqual({ choice, until })
    expect(avatarTrayMayRebound(dnd, until - 1)).toBe(false)
    expect(avatarTrayMayRebound(dnd, until)).toBe(true)

    const active = buildAvatarTrayMenu(summary, attached, dnd, now, APPEARANCE, true, 'en')
    const expired = buildAvatarTrayMenu(summary, attached, dnd, until, APPEARANCE, true, 'en')
    expect(active.tooltip).toBe(noDnd.tooltip)
    expect(active.items[0]).toEqual(noDnd.items[0])
    expect(deckSubmenus(active)).toEqual(deckSubmenus(noDnd))
    expect(checkedDnd(active), `an active ${choice} checks that duration and only it`).toEqual([{ kind: 'dnd', choice }])
    expect(checkedDnd(expired), `an expired ${choice} checks Off again`).toEqual([{ kind: 'dnd-off' }])
  }
})

test('translates every native label, drives actions, refreshes, reports errors and disposes', () => {
  let currentNow = now
  let currentDnd: AvatarDndState | null = null
  const interval: { callback: (() => void) | null; delay: number | null } = { callback: null, delay: null }
  let cleared: unknown = null
  let destroyed = 0
  const tooltips: string[] = []
  const menus: NativeItem[][] = []
  const errors: unknown[] = []
  const focused: string[] = []
  let quit = 0
  const dependencies: AvatarTrayDependencies = {
    now: () => currentNow,
    loadImage: () => ({ isEmpty: () => false }),
    createTray: () => ({
      setToolTip: (tooltip) => tooltips.push(tooltip),
      setContextMenu: (menu) => menus.push(menu as NativeItem[]),
      setImage: () => {},
      destroy: () => { destroyed += 1 }
    }),
    buildMenu: (template) => template,
    setInterval: (callback, delay) => {
      interval.callback = callback
      interval.delay = delay
      return 'timer' as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: (timer) => { cleared = timer },
    reportError: (_scope, _message, error) => errors.push(error),
    platform: 'win32',
    systemIntegratedUiDark: () => true,
    onSystemThemeUpdated: () => () => {}
  }

  const tray = createAvatarTray({
    summary: () => summary,
    iconDir: 'icons',
    locale: 'en',
    attachedDecks: () => attached,
    appearance: () => APPEARANCE,
    windowShown: () => true,
    dispatch: () => {},
    getDnd: () => currentDnd,
    onDnd: (choice) => { currentDnd = chooseAvatarDnd(choice, currentNow) },
    onDeckMenuClick: (identity) => focused.push(identity.deckRunId),
    onQuit: () => { quit += 1 }
  }, dependencies)

  expect(tooltips).toEqual(['Koryphaios avatar: 2 sessions are waiting for you'])
  expect(interval.delay).toBe(AVATAR_HEARTBEAT_MS)
  expect(menus).toHaveLength(1)
  expect(requireNativeItem(menus[0]!, 'Alpha && Beta').submenu?.map((item) => item.label)).toEqual([
    'Project: C:/work/A && B',
    'Broker: https://broker-one.test/?a=1&&b=2',
    '2 working | 1 waiting | 1 unread',
    undefined,
    'Bring Deck to front'
  ])
  expect(requireNativeItem(menus[0]!, 'Alpha && Beta (2)').submenu?.map((item) => item.label)).toEqual([
    'Project: D:/projects/Second && Deck',
    'Broker: https://broker-two.test/?x=3&&y=4',
    '1 working | 1 waiting | 3 unread',
    undefined,
    'Bring Deck to front'
  ])

  requireNativeItem(menus[0]!, 'Bring Deck to front').click?.()
  requireNativeItem(menus[0]!, 'Alpha && Beta (2)').submenu?.find((item) => item.label === 'Bring Deck to front')?.click?.()
  requireNativeItem(menus[0]!, '30 minutes').click?.()
  expect(currentDnd as AvatarDndState | null).toEqual({ choice: '30m', until: now + 30 * 60 * 1_000 })
  expect(focused).toEqual(['deck-1', 'deck-2'])
  expect(quit).toBe(0)
  expect(tray.mayRebound()).toBe(false)
  expect(menus).toHaveLength(2)
  expect(requireNativeItem(menus[1]!, '30 minutes').checked).toBe(true)

  currentNow += 30 * 60 * 1_000
  expect(tray.mayRebound()).toBe(true)
  if (interval.callback === null) throw new Error('Expected refresh interval callback')
  interval.callback()
  expect(menus).toHaveLength(3)
  requireNativeItem(menus[2]!, 'Quit Avatar').click?.()
  expect(quit).toBe(1)

  tray.dispose()
  expect(cleared).toBe('timer')
  expect(destroyed).toBe(1)
  expect(errors).toEqual([])
})

test('reports a native refresh failure without preventing disposal', () => {
  const boom = new Error('tooltip failed')
  let destroyed = 0
  const errors: unknown[] = []
  const tray = createAvatarTray({
    summary: () => summary,
    iconDir: 'icons',
    locale: 'en',
    attachedDecks: () => attached,
    appearance: () => APPEARANCE,
    windowShown: () => true,
    dispatch: () => {},
    getDnd: () => null,
    onDnd: () => {},
    onDeckMenuClick: () => {},
    onQuit: () => {}
  }, {
    now: () => now,
    loadImage: () => ({ isEmpty: () => false }),
    createTray: () => ({
      setToolTip: () => { throw boom },
      setContextMenu: () => {},
      setImage: () => {},
      destroy: () => { destroyed += 1 }
    }),
    buildMenu: (template) => template,
    setInterval: () => 'timer' as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => {},
    reportError: (_scope, _message, error) => errors.push(error),
    platform: 'win32',
    systemIntegratedUiDark: () => true,
    onSystemThemeUpdated: () => () => {}
  })

  expect(errors).toEqual([boom])
  tray.dispose()
  expect(destroyed).toBe(1)
})

test('keeps the tray usable with no attached Deck', () => {
  const menu = buildAvatarTrayMenu(view(new AvatarState({ now: () => now }).summary()), [], null, now, APPEARANCE, true, 'en')

  expect(menu.tooltip).toBe('Koryphaios avatar: No Deck attached')
  expect(labels(menu.items)).toContain('Quit Avatar')
  expect(labels(menu.items)).not.toContain('Bring Deck to front')
})

test('a menu built in French carries the French texts', () => {
  const menu = buildAvatarTrayMenu(summary, attached, null, now, APPEARANCE, true, 'fr')
  const fr = AVATAR_TRAY_COPY.fr
  expect(labels(menu.items)).toEqual(expect.arrayContaining([
    fr.counters({ working: 3, waiting: 2, unread: 4 }),
    fr.project('C:/work/A & B'),
    fr.broker('https://broker-one.test/?a=1&b=2'),
    fr.focusDeck,
    fr.showAvatar,
    fr.lockPosition,
    fr.alwaysOnTop,
    fr.motion,
    fr.motionContinuous,
    fr.motionTransitions,
    fr.motionNone,
    fr.size,
    fr.sizeSmall,
    fr.sizeMedium,
    fr.sizeLarge,
    fr.doNotDisturb,
    fr.dndOff,
    fr.dnd30m,
    fr.dnd1h,
    fr.dndTomorrow,
    fr.quit
  ]))
  expect(labels(menu.items)).not.toContain(AVATAR_TRAY_COPY.en.quit)
})

test('every menu text has a French version distinct from the English one', () => {
  const sample = (value: unknown): string =>
    typeof value === 'function' ? (value as (arg: unknown) => string)({ working: 2, waiting: 3, unread: 4 }) : String(value)
  const keys = Object.keys(AVATAR_TRAY_COPY.en) as (keyof typeof AVATAR_TRAY_COPY.en)[]
  expect(Object.keys(AVATAR_TRAY_COPY.fr).sort()).toEqual([...keys].sort())
  for (const key of keys) {
    const en = key === 'project' || key === 'broker' ? AVATAR_TRAY_COPY.en[key]('X') : sample(AVATAR_TRAY_COPY.en[key])
    const fr = key === 'project' || key === 'broker' ? AVATAR_TRAY_COPY.fr[key]('X') : sample(AVATAR_TRAY_COPY.fr[key])
    expect(fr.length, `${key} fr`).toBeGreaterThan(0)
    expect(fr, `${key} must be translated`).not.toBe(en)
  }
  expect(AVATAR_TRAY_COPY.fr.counters({ working: 1, waiting: 0, unread: 1 })).toBe('1 au travail | 0 en attente | 1 non lu')
  expect(AVATAR_TRAY_COPY.fr.counters({ working: 0, waiting: 2, unread: 2 })).toBe('0 au travail | 2 en attente | 2 non lus')
})
