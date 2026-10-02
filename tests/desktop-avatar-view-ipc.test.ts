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
      faceCopy: { title: 'No Deck attached', ariaLabel: 'Koryphaios avatar: No Deck attached' },
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
      frame: 'normal',
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
    loadingWindow: () => null,
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

test('admits only the first state request of a window that is still loading and nothing else from it', async () => {
  const handlers = new Map<string, Handler>()
  const mainFrame = {}
  const loadingContents = { mainFrame }
  const generations: number[] = []
  const calls: unknown[][] = []
  registerAvatarViewIpcHandlers({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: () => {} },
    currentWindow: () => null,
    loadingWindow: () => ({ webContents: loadingContents, generation: 9 }),
    getState: (generation) => {
      generations.push(generation)
      return state()
    },
    setPosition: (...args) => { calls.push(args) },
    setPointerInside: (...args) => { calls.push(args) },
    reportError: (...args) => { calls.push(args) }
  })
  const event = { sender: loadingContents, senderFrame: mainFrame }

  await expect(handlers.get(AVATAR_VIEW_CHANNELS.getState)!(event)).resolves.toEqual(state())
  expect(generations).toEqual([9])
  await expect(handlers.get(AVATAR_VIEW_CHANNELS.getState)!({ sender: loadingContents, senderFrame: {} })).rejects.toThrow('AvatarView sender is not current')
  await expect(handlers.get(AVATAR_VIEW_CHANNELS.getState)!({ sender: { mainFrame: {} }, senderFrame: {} })).rejects.toThrow('AvatarView sender is not current')
  await expect(handlers.get(AVATAR_VIEW_CHANNELS.setPosition)!(event, 1, 2)).rejects.toThrow('AvatarView sender is not current')
  await expect(handlers.get(AVATAR_VIEW_CHANNELS.setPointerInside)!(event, true)).rejects.toThrow('AvatarView sender is not current')
  await expect(handlers.get(AVATAR_VIEW_CHANNELS.reportError)!(event, 'early')).rejects.toThrow('AvatarView sender is not current')
  expect(calls).toEqual([])
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
    loadingWindow: () => null,
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
