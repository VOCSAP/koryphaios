import { expect, test } from 'bun:test'
import {
  avatarTrayMayRebound,
  buildAvatarTrayMenu,
  chooseAvatarDnd,
  type AvatarTrayMenuItem
} from '../desktop/src/main/avatar-tray-menu.ts'
import { createAvatarTray, type AvatarTrayDependencies } from '../desktop/src/main/avatar-tray.ts'
import { AVATAR_HEARTBEAT_MS, AvatarState, type AvatarSummary } from '../desktop/src/shared/avatar-state.ts'
import type { AvatarAttachRequest } from '../desktop/src/shared/avatar-protocol.ts'

const now = new Date(2026, 4, 14, 10, 30).getTime()

function stateSummary(): AvatarSummary {
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
  return state.summary()
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
  const menu = buildAvatarTrayMenu(summary, attached, null, now)

  expect(menu.tooltip).toBe('Koryphaios Avatar: reclame | 2 Decks | 3 working | 2 waiting | 4 unread')
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

test('keeps every counter while each do-not-disturb choice is active and clears its expired radio', () => {
  const noDnd = buildAvatarTrayMenu(summary, attached, null, now)
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

    const active = buildAvatarTrayMenu(summary, attached, dnd, now)
    const expired = buildAvatarTrayMenu(summary, attached, dnd, until)
    expect(active.tooltip).toBe(noDnd.tooltip)
    expect(active.items[0]).toEqual(noDnd.items[0])
    expect(deckSubmenus(active)).toEqual(deckSubmenus(noDnd))
    expect(active.items.find((item) => item.label === 'Do not disturb')?.submenu?.filter((item) => item.checked)).toEqual([
      expect.objectContaining({ action: { kind: 'dnd', choice } })
    ])
    expect(expired.items.find((item) => item.label === 'Do not disturb')?.submenu?.some((item) => item.checked)).toBe(false)
  }
})

test('translates every native label, drives actions, refreshes, reports errors and disposes', () => {
  let currentNow = now
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
    state: { summary: () => summary } as unknown as AvatarState,
    iconDir: 'icons',
    attachedDecks: () => attached,
    onDeckMenuClick: (identity) => focused.push(identity.deckRunId),
    onQuit: () => { quit += 1 }
  }, dependencies)

  expect(tooltips).toEqual(['Koryphaios Avatar: reclame | 2 Decks | 3 working | 2 waiting | 4 unread'])
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
    state: { summary: () => summary } as unknown as AvatarState,
    iconDir: 'icons',
    attachedDecks: () => attached,
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
  const menu = buildAvatarTrayMenu(new AvatarState({ now: () => now }).summary(), [], null, now)

  expect(menu.tooltip).toBe('Koryphaios Avatar: seul | 0 Decks | 0 working | 0 waiting | 0 unread')
  expect(labels(menu.items)).toContain('Quit Avatar')
  expect(labels(menu.items)).not.toContain('Bring Deck to front')
})
