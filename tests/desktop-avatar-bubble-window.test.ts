import { describe, expect, test } from 'bun:test'
import {
  avatarBubbleDict,
  avatarBubblePlacement,
  avatarBubbleSize,
  createAvatarBubbleNativeAdapter,
  createAvatarBubbleWindow,
  type AvatarBubbleBrowserWindow,
  type AvatarBubbleIpcHandler,
  type AvatarBubbleLifecycle,
  type AvatarBubbleNativeAdapter,
  type AvatarBubblePlacement,
  type AvatarBubbleRect,
  type AvatarBubbleWindowConstructionOptions,
  type AvatarBubbleWindowOptions,
  type AvatarBubbleWebContents
} from '../desktop/src/main/avatar-bubble-window'
import { AVATAR_BUBBLE_CHANNELS, AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS, type AvatarBubbleBox, type AvatarBubbleState } from '../desktop/src/shared/avatar-bubble-view'
import type { AvatarInboxAction, InboxRelayApproval } from '../desktop/src/shared/avatar-inbox-protocol'
import type { AvatarDeckIdentity } from '../desktop/src/shared/avatar-state'
import { createAvatarInboxService, type AvatarInboxGestureResult, type AvatarInboxReadEntry } from '../desktop/src/main/avatar-inbox-service'
import type { InboxAckStatus } from '../desktop/src/shared/types'
import type { ApprovalWindowSession } from '../desktop/src/main/approval-window'
import { AVATAR_WINDOW_SIZES, restoreAvatarPlacement } from '../desktop/src/main/avatar-window-placement'

const DECK = { deckRunId: 'run-a', broker_url: 'http://127.0.0.1:7899' }
const ID_1 = '00000000-0000-4000-8000-000000000001'
const ID_2 = '00000000-0000-4000-8000-000000000002'

function approval(id: string, patch: Partial<InboxRelayApproval> = {}): InboxRelayApproval {
  return {
    id,
    kind: 'permission',
    status: 'pending',
    informational: false,
    reply_route: 'hook',
    mergeable: false,
    absorbed_permission: false,
    title: 'Bash',
    question: 'ls',
    options: [],
    questions: null,
    created_at: '2026-11-17T10:00:00.000Z',
    from_peer_id: 'peer-1',
    tile_name: null,
    ...patch
  }
}

interface FakeContents extends AvatarBubbleWebContents {
  sent: Array<[string, unknown]>
}

function contents(): FakeContents {
  const sent: Array<[string, unknown]> = []
  return { mainFrame: {}, sent, send: (channel, payload) => sent.push([channel, payload]), setWindowOpenHandler() {}, on() {} }
}

function harness(initial: InboxRelayApproval[] = [approval(ID_1)], overrides: Partial<AvatarBubbleWindowOptions> = {}) {
  const handlers = new Map<string, AvatarBubbleIpcHandler>()
  const endpoints = new Map<number, FakeContents>()
  const lifecycles = new Map<number, AvatarBubbleLifecycle>()
  const closed: number[] = []
  const errors: string[] = []
  const acted: Array<[AvatarDeckIdentity, AvatarInboxAction]> = []
  const focused: AvatarDeckIdentity[] = []
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = []
  const flips: boolean[] = []
  let now = 0
  let outcome: AvatarInboxGestureResult = { outcome: 'won' }
  const box: AvatarBubbleBox = {
    identity: DECK,
    approvals: initial,
    messages: [],
    closed: [],
    truncated: { approvals: 0, messages: 0, closed: 0 },
    scopeGeneration: 1,
    settledLocally: new Set(),
    reads: new Map()
  }
  const marked: Array<[AvatarDeckIdentity, AvatarInboxReadEntry, InboxAckStatus]> = []
  let placement: AvatarBubblePlacement | null = { rect: { x: 0, y: 0, width: 388, height: 560 }, anchor: 'left' }
  const expandedPlacement: AvatarBubblePlacement = { rect: { x: 100, y: 50, width: 1152, height: 832 }, anchor: 'right' }
  const asked: boolean[] = []
  const opened: AvatarBubbleRect[] = []
  const resized: Array<[number, AvatarBubbleRect]> = []
  let resizeFails = false
  let stored = false
  let persistFails = false
  const persisted: boolean[] = []
  const native: AvatarBubbleNativeAdapter = {
    open(generation, rect, lifecycle) {
      opened.push(rect)
      endpoints.set(generation, contents())
      lifecycles.set(generation, lifecycle)
    },
    focus() {},
    resize(generation, rect) {
      if (resizeFails) throw new Error('window gone')
      resized.push([generation, rect])
    },
    close(generation) {
      closed.push(generation)
      endpoints.delete(generation)
      lifecycles.get(generation)?.closed()
    },
    endpoint: (generation) => endpoints.get(generation) ?? null
  }
  const bubble = createAvatarBubbleWindow({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) },
    native,
    boxes: () => [box],
    decks: () => [{ ...DECK, deckName: 'koryphaios' }],
    act: async (identity, action) => {
      acted.push([identity, action])
      if (outcome.outcome === 'won') box.settledLocally = new Set([...box.settledLocally, action.approval_id])
      return outcome
    },
    markRead: (identity, entry, status) => {
      marked.push([identity, entry, status])
      return { read: status }
    },
    focusDeck: async (identity) => {
      focused.push(identity)
    },
    theme: () => 'dark',
    lang: 'fr',
    dict: { 'avatarBubble.allow': 'Autoriser' },
    placement: (expanded) => {
      asked.push(expanded)
      return expanded && placement !== null ? expandedPlacement : placement
    },
    expanded: () => stored,
    persistExpanded: (value) => {
      if (persistFails) throw new Error('disk full')
      persisted.push(value)
      stored = value
    },
    now: () => now,
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    reportError: (_scope, message) => errors.push(message),
    onNotificationAvailabilityChanged: () => flips.push(bubble.notificationServiceReady()),
    ...overrides
  })
  const event = (generation: number) => {
    const sender = endpoints.get(generation)!
    return { sender, senderFrame: sender.mainFrame }
  }
  const call = (channel: string, generation: number, ...args: unknown[]) => handlers.get(channel)!(event(generation), ...args)
  const actIntent = (generation: number, action: unknown) => ({ generation, ...DECK, action })
  return {
    bubble,
    box,
    handlers,
    endpoints,
    lifecycles,
    closed,
    errors,
    acted,
    marked,
    focused,
    timers,
    flips,
    call,
    actIntent,
    setNow: (value: number) => {
      now = value
    },
    setOutcome: (value: AvatarInboxGestureResult) => {
      outcome = value
    },
    setPlacement: (value: AvatarBubblePlacement | null) => {
      placement = value
    },
    failResize: () => {
      resizeFails = true
    },
    failPersist: () => {
      persistFails = true
    },
    storeExpanded: (value: boolean) => {
      stored = value
    },
    persisted,
    asked,
    opened,
    resized,
    expandedRect: () => expandedPlacement.rect,
    normalRect: () => placement?.rect
  }
}

describe('avatar bubble IPC', () => {
  test('getState answers the current window with the projected model', async () => {
    const h = harness()
    h.bubble.open()
    const state = (await h.call(AVATAR_BUBBLE_CHANNELS.getState, 1)) as AvatarBubbleState
    expect(state).toMatchObject({ generation: 1, anchor: 'left', lang: 'fr', dict: { 'avatarBubble.allow': 'Autoriser' } })
    expect(state.model.reclame.map((card) => card.approvalId)).toEqual([ID_1])
  })

  test('no bubble opens while the mask is not shown', () => {
    const h = harness()
    h.setPlacement(null)
    h.bubble.open()
    expect(h.endpoints.size).toBe(0)
    expect(h.errors).toEqual(['Avatar bubble was not opened because the mask is not shown'])
  })

  test('a sender from an earlier generation is refused and reaches no gesture', async () => {
    const h = harness()
    h.bubble.open()
    const stale = h.endpoints.get(1)!
    h.bubble.close()
    h.bubble.open()
    const act = h.handlers.get(AVATAR_BUBBLE_CHANNELS.act)!
    await expect(act({ sender: stale, senderFrame: stale.mainFrame }, h.actIntent(2, { approval_id: ID_1, action: 'deny' }))).rejects.toThrow('not current')
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.act, 2, h.actIntent(1, { approval_id: ID_1, action: 'deny' }))).rejects.toThrow('intent is invalid')
    expect(h.acted).toEqual([])
  })

  test('a sub-frame of the current window is refused', async () => {
    const h = harness()
    h.bubble.open()
    const act = h.handlers.get(AVATAR_BUBBLE_CHANNELS.act)!
    const sender = h.endpoints.get(1)!
    await expect(act({ sender, senderFrame: {} }, h.actIntent(1, { approval_id: ID_1, action: 'deny' }))).rejects.toThrow('not current')
    expect(h.acted).toEqual([])
  })

  test('a gesture replayed on an entry already settled from the bubble is refused before the inbox service', async () => {
    const h = harness()
    h.bubble.open()
    h.box.settledLocally = new Set([ID_1])
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.act, 1, h.actIntent(1, { approval_id: ID_1, action: 'deny' }))).rejects.toThrow('does not hold')
    expect(h.acted).toEqual([])
  })

  test('a gesture the card does not offer is refused main-side, even one inboxActionAllowed accepts', async () => {
    const questions = [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: '' }], multi_select: false }]
    const h = harness([approval(ID_1, { kind: 'question', reply_route: 'hook', questions })])
    h.bubble.open()
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.act, 1, h.actIntent(1, { approval_id: ID_1, action: 'text', text: 'hi' }))).rejects.toThrow(
      'not offered'
    )
    expect(h.acted).toEqual([])
  })

  test('renderer error reports are rate limited, and the next one after a refill says how many were dropped', async () => {
    const h = harness(undefined, { rendererErrorBurst: 2, rendererErrorRefillMs: 1_000 })
    h.bubble.open()
    for (const message of ['a', 'b', 'c']) await h.call(AVATAR_BUBBLE_CHANNELS.reportError, 1, message)
    h.setNow(1_000)
    await h.call(AVATAR_BUBBLE_CHANNELS.reportError, 1, 'd')
    expect(h.errors).toEqual(['avatar-bubble renderer: a', 'avatar-bubble renderer: b', 'avatar-bubble renderer: 1 reports dropped; d'])
  })

  test('a late closed from an earlier window leaves the reopened bubble current', async () => {
    const h = harness()
    h.bubble.open()
    const first = h.lifecycles.get(1)!
    h.bubble.close()
    h.bubble.open()
    first.closed()
    const state = (await h.call(AVATAR_BUBBLE_CHANNELS.getState, 2)) as AvatarBubbleState
    expect(state.generation).toBe(2)
  })

  test('an action outside the enum is refused before the inbox service', async () => {
    const h = harness()
    h.bubble.open()
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.act, 1, h.actIntent(1, { approval_id: ID_1, action: 'handback' }))).rejects.toThrow('refused')
    expect(h.acted).toEqual([])
  })

  test('an approval id absent from the inbox is refused before the inbox service', async () => {
    const h = harness()
    h.bubble.open()
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.act, 1, h.actIntent(1, { approval_id: ID_2, action: 'deny' }))).rejects.toThrow('does not hold')
    await expect(
      h.call(AVATAR_BUBBLE_CHANNELS.act, 1, { generation: 1, deckRunId: 'other', broker_url: DECK.broker_url, action: { approval_id: ID_1, action: 'deny' } })
    ).rejects.toThrow('does not hold')
    expect(h.acted).toEqual([])
  })

  test('allow on a cut entry is refused main-side', async () => {
    const h = harness([approval(ID_1, { cut: true })])
    h.bubble.open()
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.act, 1, h.actIntent(1, { approval_id: ID_1, action: 'allow' }))).rejects.toThrow('not offered')
    expect(h.acted).toEqual([])
  })

  test('the last won gesture closes the bubble once Reclame is empty', async () => {
    const h = harness([approval(ID_1), approval(ID_2)])
    h.bubble.open()
    expect(await h.call(AVATAR_BUBBLE_CHANNELS.act, 1, h.actIntent(1, { approval_id: ID_1, action: 'allow' }))).toEqual({ outcome: 'won' })
    expect(h.closed).toEqual([])
    await h.call(AVATAR_BUBBLE_CHANNELS.act, 1, h.actIntent(1, { approval_id: ID_2, action: 'deny' }))
    expect(h.acted.map(([identity, action]) => [identity.deckRunId, action])).toEqual([
      ['run-a', { approval_id: ID_1, action: 'allow' }],
      ['run-a', { approval_id: ID_2, action: 'deny' }]
    ])
    expect(h.closed).toEqual([1])
  })

  test('a lost gesture shows the card settled elsewhere for 2 s, then the bubble closes', async () => {
    const h = harness()
    h.bubble.open()
    await h.call(AVATAR_BUBBLE_CHANNELS.getState, 1)
    h.setOutcome({ outcome: 'lost' })
    await h.call(AVATAR_BUBBLE_CHANNELS.act, 1, h.actIntent(1, { approval_id: ID_1, action: 'allow' }))
    const pushed = h.endpoints.get(1)!.sent.at(-1)![1] as AvatarBubbleState
    expect(pushed.model.reclame).toMatchObject([{ approvalId: ID_1, settledElsewhere: true, gestures: [] }])
    h.box.approvals = []
    const timer = h.timers.at(-1)!
    expect(timer.at).toBe(AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS)
    h.setNow(timer.at)
    timer.callback()
    expect(h.closed).toEqual([1])
  })

  test('focusDeck reaches only an attached Deck', async () => {
    const h = harness()
    h.bubble.open()
    await h.call(AVATAR_BUBBLE_CHANNELS.focusDeck, 1, { generation: 1, ...DECK })
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.focusDeck, 1, { generation: 1, deckRunId: 'other', broker_url: DECK.broker_url })).rejects.toThrow(
      'not attached'
    )
    expect(h.focused).toEqual([DECK])
  })

  test('changed pushes the new state to the open bubble only', () => {
    const h = harness()
    h.bubble.changed()
    h.bubble.open()
    h.bubble.changed()
    expect(h.endpoints.get(1)!.sent.map(([channel]) => channel)).toEqual([AVATAR_BUBBLE_CHANNELS.state])
  })
})

describe('avatar bubble expand gesture', () => {
  const expand = (generation: number, expanded: unknown) => ({ generation, expanded })
  const lastState = (h: ReturnType<typeof harness>): AvatarBubbleState => h.endpoints.get(1)!.sent.at(-1)![1] as AvatarBubbleState

  test('a bubble opens at the normal size', async () => {
    const h = harness()
    h.bubble.open()
    expect(h.asked).toEqual([false])
    expect(h.opened).toEqual([h.normalRect()!])
    expect(((await h.call(AVATAR_BUBBLE_CHANNELS.getState, 1)) as AvatarBubbleState).expanded).toBe(false)
  })

  test('a bubble opens at the size the store holds', async () => {
    const h = harness()
    h.storeExpanded(true)
    h.bubble.open()
    expect(h.asked).toEqual([true])
    expect(h.opened).toEqual([h.expandedRect()])
    expect(((await h.call(AVATAR_BUBBLE_CHANNELS.getState, 1)) as AvatarBubbleState).expanded).toBe(true)
  })

  test('the store decides the size of the next bubble, even when the last one was left larger', async () => {
    const h = harness()
    h.bubble.open()
    h.failPersist()
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true))
    h.bubble.close()
    h.bubble.open()
    expect(h.asked.at(-1)).toBe(false)
    expect(h.opened.at(-1)).toEqual(h.normalRect()!)
    expect(((await h.call(AVATAR_BUBBLE_CHANNELS.getState, 2)) as AvatarBubbleState).expanded).toBe(false)
  })

  test('each choice reaches the store once the window has been resized', async () => {
    const h = harness()
    h.bubble.open()
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true))
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, false))
    expect(h.persisted).toEqual([true, false])
  })

  test('a store that fails is traced and leaves the window and the pushed state at the new size', async () => {
    const h = harness()
    h.bubble.open()
    h.failPersist()
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true))
    expect(h.errors).toContain('Avatar bubble size could not be kept for the next bubble')
    expect(h.resized).toEqual([[1, h.expandedRect()]])
    expect(lastState(h).expanded).toBe(true)
  })

  test('expanding resizes the open window to the expanded placement and pushes the state with it', async () => {
    const h = harness()
    h.bubble.open()
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true))
    expect(h.asked).toEqual([false, true])
    expect(h.resized).toEqual([[1, h.expandedRect()]])
    expect(lastState(h)).toMatchObject({ generation: 1, expanded: true, anchor: 'right' })
  })

  test('the anchor follows the placement of each size, so a flip at the larger size reaches the renderer and back', async () => {
    const h = harness()
    h.bubble.open()
    expect(((await h.call(AVATAR_BUBBLE_CHANNELS.getState, 1)) as AvatarBubbleState).anchor).toBe('left')
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true))
    expect(lastState(h).anchor).toBe('right')
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, false))
    expect(lastState(h).anchor).toBe('left')
  })

  test('collapsing returns the window to the normal placement', async () => {
    const h = harness()
    h.bubble.open()
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true))
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, false))
    expect(h.resized.map(([, rect]) => rect)).toEqual([h.expandedRect(), h.normalRect()!])
    expect(lastState(h).expanded).toBe(false)
  })

  test('the next bubble opens at the size the last one was left at', async () => {
    const h = harness()
    h.bubble.open()
    await h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true))
    h.bubble.close()
    h.bubble.open()
    expect(h.opened.at(-1)).toEqual(h.expandedRect())
    expect(((await h.call(AVATAR_BUBBLE_CHANNELS.getState, 2)) as AvatarBubbleState).expanded).toBe(true)
  })

  test('a sender from an earlier generation, a sub-frame or a stale intent generation is refused and resizes nothing', async () => {
    const h = harness()
    h.bubble.open()
    const stale = h.endpoints.get(1)!
    h.bubble.close()
    h.bubble.open()
    const handler = h.handlers.get(AVATAR_BUBBLE_CHANNELS.setExpanded)!
    await expect(handler({ sender: stale, senderFrame: stale.mainFrame }, expand(2, true))).rejects.toThrow('not current')
    const current = h.endpoints.get(2)!
    await expect(handler({ sender: current, senderFrame: {} }, expand(2, true))).rejects.toThrow('not current')
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 2, expand(1, true))).rejects.toThrow('intent is invalid')
    expect(h.resized).toEqual([])
    expect(h.asked).toEqual([false, false])
  })

  test('a value that is not a boolean, or an intent with extra arguments, is refused, traced and resizes nothing', async () => {
    const h = harness()
    h.bubble.open()
    for (const bad of ['true', 1, null, undefined, {}]) {
      await expect(h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, bad))).rejects.toThrow('does not name a boolean')
    }
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true), 'more')).rejects.toThrow('intent is invalid')
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1)).rejects.toThrow('intent is invalid')
    expect(h.resized).toEqual([])
    expect(h.persisted).toEqual([])
    expect(h.errors.filter((message) => message.includes('does not name a boolean'))).toHaveLength(5)
    expect(((await h.call(AVATAR_BUBBLE_CHANNELS.getState, 1)) as AvatarBubbleState).expanded).toBe(false)
  })

  test('with the mask gone the request is refused and traced, and the bubble keeps its size', async () => {
    const h = harness()
    h.bubble.open()
    h.setPlacement(null)
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true))).rejects.toThrow('mask is not shown')
    expect(h.errors).toContain('Avatar bubble could not be resized because the mask is not shown')
    expect(h.resized).toEqual([])
    expect(h.persisted).toEqual([])
    expect(((await h.call(AVATAR_BUBBLE_CHANNELS.getState, 1)) as AvatarBubbleState).expanded).toBe(false)
  })

  test('a window that cannot be resized is traced, rejects, and the state keeps the old size and anchor', async () => {
    const h = harness()
    h.bubble.open()
    h.failResize()
    const before = h.endpoints.get(1)!.sent.length
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.setExpanded, 1, expand(1, true))).rejects.toThrow('could not be resized')
    expect(h.errors).toContain('Avatar bubble could not be resized')
    expect(h.endpoints.get(1)!.sent.length).toBe(before)
    expect(h.persisted).toEqual([])
    expect(((await h.call(AVATAR_BUBBLE_CHANNELS.getState, 1)) as AvatarBubbleState).expanded).toBe(false)
    expect(h.bubble.notificationServiceReady()).toBe(true)
  })

  test('dispose removes the handler', () => {
    const h = harness()
    h.bubble.dispose()
    expect(h.handlers.has(AVATAR_BUBBLE_CHANNELS.setExpanded)).toBe(false)
  })
})

describe('avatar bubble read gestures', () => {
  const SENT = '2026-11-17T10:00:00.000Z'
  const readIntent = (generation: number, patch: Record<string, unknown> = {}) => ({ generation, ...DECK, scopeGeneration: 1, id: 7, sentAt: SENT, ...patch })

  test('markSeen and ack reach the inbox service with their own status and push the new state', async () => {
    const h = harness()
    h.bubble.open()
    expect(await h.call(AVATAR_BUBBLE_CHANNELS.markSeen, 1, readIntent(1))).toBe('seen')
    expect(await h.call(AVATAR_BUBBLE_CHANNELS.ack, 1, readIntent(1))).toBe('acked')
    expect(h.marked).toEqual([
      [DECK, { scopeGeneration: 1, id: 7, sentAt: SENT }, 'seen'],
      [DECK, { scopeGeneration: 1, id: 7, sentAt: SENT }, 'acked']
    ])
    expect(h.endpoints.get(1)!.sent.map(([channel]) => channel)).toEqual([AVATAR_BUBBLE_CHANNELS.state, AVATAR_BUBBLE_CHANNELS.state])
  })

  test('a sender from an earlier window, a sub-frame or a stale window generation is refused and reaches no read state', async () => {
    const h = harness()
    h.bubble.open()
    const stale = h.endpoints.get(1)!
    h.bubble.close()
    h.bubble.open()
    for (const channel of [AVATAR_BUBBLE_CHANNELS.markSeen, AVATAR_BUBBLE_CHANNELS.ack]) {
      const handler = h.handlers.get(channel)!
      await expect(handler({ sender: stale, senderFrame: stale.mainFrame }, readIntent(2))).rejects.toThrow('not current')
      const current = h.endpoints.get(2)!
      await expect(handler({ sender: current, senderFrame: {} }, readIntent(2))).rejects.toThrow('not current')
      await expect(h.call(channel, 2, readIntent(1))).rejects.toThrow('refused')
    }
    expect(h.marked).toEqual([])
    expect(h.errors.filter((message) => message.includes('gesture was refused'))).toHaveLength(2)
  })

  test('an intent that names no Deck or no message is refused and traced', async () => {
    const h = harness()
    h.bubble.open()
    const bad = [
      readIntent(1, { id: 1.5 }),
      readIntent(1, { id: '7' }),
      readIntent(1, { scopeGeneration: Number.NaN }),
      readIntent(1, { sentAt: 7 }),
      readIntent(1, { deckRunId: undefined }),
      { generation: 1, ...DECK }
    ]
    for (const intent of bad) await expect(h.call(AVATAR_BUBBLE_CHANNELS.markSeen, 1, intent)).rejects.toThrow('refused')
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.ack, 1)).rejects.toThrow('refused')
    expect(h.marked).toEqual([])
    expect(h.errors).toHaveLength(bad.length + 1)
  })

  test('a refusal from the inbox service is traced with its reason and rejects', async () => {
    const h = harness(undefined, { markRead: () => ({ refused: 'stale_generation' }) })
    h.bubble.open()
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.markSeen, 1, readIntent(1))).rejects.toThrow('stale_generation')
    expect(h.errors).toEqual(['Avatar bubble seen gesture was refused: stale_generation'])
    expect(h.endpoints.get(1)!.sent).toEqual([])
  })

  test('through the real inbox service the pushed state carries the read state, and a stale scope generation is refused', async () => {
    const inbox = createAvatarInboxService({ send: async () => ({ requestId: 'r', ok: true }), report: () => undefined, changed: () => undefined })
    inbox.receive(DECK, {
      type: 'inbox_snapshot',
      protocol_version: 1,
      ...DECK,
      scope_generation: 4,
      seq: 1,
      approvals: [],
      messages: [{ id: 7, from_peer_id: 'peer-1', text: 'hi', sent_at: SENT, state: 'open', closed_at: null, closed_by: null, reason: null }],
      closed: [],
      truncated: { approvals: 0, messages: 0, closed: 0 }
    })
    const h = harness(undefined, { boxes: () => inbox.boxes(), markRead: (identity, entry, status) => inbox.markRead(identity, entry, status) })
    h.bubble.open()
    await expect(h.call(AVATAR_BUBBLE_CHANNELS.markSeen, 1, readIntent(1, { scopeGeneration: 3 }))).rejects.toThrow('stale_generation')
    expect(await h.call(AVATAR_BUBBLE_CHANNELS.markSeen, 1, readIntent(1, { scopeGeneration: 4 }))).toBe('seen')
    const pushed = h.endpoints.get(1)!.sent.at(-1)![1] as AvatarBubbleState
    expect(pushed.model.courrier).toMatchObject([{ id: 7, scopeGeneration: 4, read: 'seen' }])
    expect(await h.call(AVATAR_BUBBLE_CHANNELS.ack, 1, readIntent(1, { scopeGeneration: 4 }))).toBe('acked')
    expect(await h.call(AVATAR_BUBBLE_CHANNELS.markSeen, 1, readIntent(1, { scopeGeneration: 4 }))).toBe('acked')
  })
})

describe('avatar bubble native window', () => {
  interface FakeWindowSteps {
    show?: () => void
    setWindowOpenHandler?: () => void
    loadFile?: () => Promise<unknown>
    /** Width the system adds once a move has returned, as Windows does at 125 % DPI; it lands on settle(). */
    driftAfterMove?: number
    /** Destroyed while the adapter still holds it: `closed` has not been delivered yet. */
    destroyBeforeClosed?: boolean
  }

  function fakeWindow(steps: FakeWindowSteps = {}) {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const contentListeners = new Map<string, (...args: unknown[]) => void>()
    let destroyed = false
    const calls: string[] = []
    const sizes: Array<[number, number]> = []
    const geometry = { x: 0, y: 0, width: 388, height: 560 }
    let pendingDrift = 0
    const window: AvatarBubbleBrowserWindow = {
      webContents: {
        mainFrame: {},
        send() {},
        setWindowOpenHandler: () => steps.setWindowOpenHandler?.(),
        on: (name, listener) => contentListeners.set(name, listener)
      },
      on: (name, listener) => listeners.set(name, listener),
      show: () => steps.show?.(),
      focus() {},
      setPosition(x, y) {
        calls.push('setPosition')
        geometry.x = x
        geometry.y = y
        pendingDrift += steps.driftAfterMove ?? 0
      },
      setContentSize(width, height) {
        calls.push('setContentSize')
        sizes.push([width, height])
        geometry.width = width
        geometry.height = height
      },
      destroy() {
        destroyed = true
        if (!steps.destroyBeforeClosed) listeners.get('closed')?.()
      },
      isDestroyed: () => destroyed,
      loadFile: () => steps.loadFile?.() ?? Promise.resolve(undefined)
    }
    Object.assign(window, { getContentSize: () => [geometry.width, geometry.height] })
    const settle = (): void => {
      geometry.width += pendingDrift
      pendingDrift = 0
    }
    return { window, listeners, contentListeners, calls, sizes, geometry, settle, destroyed: () => destroyed }
  }

  function fakeSession() {
    const handlers: {
      request?: (webContents: unknown, permission: string, callback: (allowed: boolean) => void, details: unknown) => void
      check?: (webContents: unknown, permission: string, origin: string, details: unknown) => boolean
      download?: (event: unknown) => void
    } = {}
    let cleared = 0
    const bubbleSession: ApprovalWindowSession = {
      setPermissionRequestHandler: (handler) => {
        handlers.request = handler
      },
      setPermissionCheckHandler: (handler) => {
        handlers.check = handler
      },
      on: (_event, listener) => {
        handlers.download = listener
      },
      clearStorageData: async () => {
        cleared += 1
      },
      clearCache: async () => undefined
    }
    return { bubbleSession, handlers, cleared: () => cleared }
  }

  function adapterOf(runId: string, steps: FakeWindowSteps = {}, createFails = false) {
    const session = fakeSession()
    const partitions: string[] = []
    const created: AvatarBubbleWindowConstructionOptions[] = []
    const fakes: Array<ReturnType<typeof fakeWindow>> = []
    const events: string[] = []
    const traces: string[] = []
    let closed = 0
    const adapter = createAvatarBubbleNativeAdapter({
      preload: 'p',
      html: 'h',
      runId,
      createWindow: (options) => {
        if (createFails) throw new Error('constructor failed')
        created.push(options)
        const fake = fakeWindow(steps)
        fakes.push(fake)
        return fake.window
      },
      sessionFromPartition: (partition) => {
        partitions.push(partition)
        return session.bubbleSession
      },
      reportError: (_scope, message) => traces.push(message)
    })
    const openNext = (generation: number) =>
      adapter.open(generation, { x: 0, y: 0, width: 388, height: 560 }, {
        closed: () => {
          closed += 1
          events.push('closed')
        },
        failed: () => events.push('failed'),
        ready: () => events.push('ready')
      })
    return { adapter, openNext, session, partitions, created, fakes, events, traces, closed: () => closed }
  }

  function open() {
    const run = adapterOf('run-1')
    run.openNext(1)
    return { fake: run.fakes[0]!, closed: run.closed }
  }

  test('every bubble of one Avatar run shares one partition, created once, refusing every permission and download, cleared at each close', async () => {
    const run = adapterOf('run-1')
    run.openNext(1)
    run.fakes[0]!.window.destroy()
    await Promise.resolve()
    run.openNext(2)
    run.fakes[1]!.window.destroy()
    await Promise.resolve()
    expect(run.partitions).toEqual(['avatar-bubble:run-1'])
    expect(run.created.map((options) => options.webPreferences.partition)).toEqual(['avatar-bubble:run-1', 'avatar-bubble:run-1'])
    expect(run.session.cleared()).toBe(2)
    const answers: boolean[] = []
    run.session.handlers.request!({}, 'media', (allowed) => answers.push(allowed), {})
    expect(answers).toEqual([false])
    expect(run.session.handlers.check!({}, 'clipboard-read', 'file://', {})).toBe(false)
    let prevented = false
    run.session.handlers.download!({ preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
  })

  test('every resize moves the window then asks for the requested rect, never for a size read back after the system widened it', () => {
    const run = adapterOf('run-1', { driftAfterMove: 15 })
    run.openNext(1)
    const fake = run.fakes[0]!
    const first = { x: 120, y: 40, width: 1152, height: 832 }
    const second = { x: 300, y: 90, width: 700, height: 600 }

    run.adapter.resize(1, first)
    fake.settle()
    expect(fake.geometry.width, 'the system widened the window after the first move returned').toBe(first.width + 15)

    run.adapter.resize(1, second)
    fake.settle()
    expect(fake.calls).toEqual(['setPosition', 'setContentSize', 'setPosition', 'setContentSize'])
    expect(fake.sizes).toEqual([
      [first.width, first.height],
      [second.width, second.height]
    ])
    expect(fake.geometry).toEqual({ x: second.x, y: second.y, width: second.width + 15, height: second.height })
  })

  test('resize of an unknown or destroyed window is ignored', () => {
    const run = adapterOf('run-1', { destroyBeforeClosed: true })
    run.openNext(1)
    run.adapter.resize(9, { x: 0, y: 0, width: 500, height: 500 })
    run.fakes[0]!.window.destroy()
    run.adapter.resize(1, { x: 0, y: 0, width: 500, height: 500 })
    expect(run.fakes[0]!.calls).toEqual([])
  })

  test('Escape closes the bubble, another key does not', () => {
    const { fake, closed } = open()
    fake.contentListeners.get('before-input-event')!({}, { type: 'keyDown', key: 'a' })
    expect(fake.destroyed()).toBe(false)
    fake.contentListeners.get('before-input-event')!({}, { type: 'keyDown', key: 'Escape' })
    expect(fake.destroyed()).toBe(true)
    expect(closed()).toBe(1)
  })

  test('a click elsewhere (blur) closes the bubble', () => {
    const { fake } = open()
    fake.listeners.get('blur')!()
    expect(fake.destroyed()).toBe(true)
  })

  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
  }

  test('a window that cannot be created is reported failed, then closed', () => {
    const run = adapterOf('run-1', {}, true)
    run.openNext(1)
    expect(run.events).toEqual(['failed', 'closed'])
  })

  test('ready follows a successful show and focus, and a show that throws is a failure with no ready', () => {
    const good = adapterOf('run-1')
    good.openNext(1)
    good.fakes[0]!.listeners.get('ready-to-show')!()
    expect(good.events).toEqual(['ready'])

    const bad = adapterOf('run-2', { show: () => { throw new Error('show failed') } })
    bad.openNext(1)
    bad.fakes[0]!.listeners.get('ready-to-show')!()
    expect(bad.events).toEqual(['failed', 'closed'])
  })

  test('a renderer crash, a preload error and a setup failure are failures that precede the closure', () => {
    const crashRun = adapterOf('run-1')
    crashRun.openNext(1)
    crashRun.fakes[0]!.contentListeners.get('render-process-gone')!()
    expect(crashRun.events).toEqual(['failed', 'closed'])

    const preload = adapterOf('run-2')
    preload.openNext(1)
    preload.fakes[0]!.contentListeners.get('preload-error')!({}, 'preload.js', new Error('boom'))
    expect(preload.events).toEqual(['failed', 'closed'])

    const setup = adapterOf('run-3', { setWindowOpenHandler: () => { throw new Error('setup failed') } })
    setup.openNext(1)
    expect(setup.events).toEqual(['failed', 'closed'])
  })

  test('a navigation refusal closes the bubble without declaring the service failed', () => {
    const run = adapterOf('run-1')
    run.openNext(1)
    run.fakes[0]!.contentListeners.get('will-navigate')!({ preventDefault() {} })
    expect(run.events).toEqual(['closed'])
  })

  test('a document that fails to load is a failure, but a load aborted by an earlier normal close is not', async () => {
    const live = adapterOf('run-1', { loadFile: () => Promise.reject(new Error('load failed')) })
    live.openNext(1)
    await settle()
    expect(live.events).toEqual(['failed', 'closed'])
    expect(live.traces).toContain('Avatar bubble failed to load')

    let rejectLoad: (error: Error) => void = () => {}
    const aborted = adapterOf('run-2', { loadFile: () => new Promise((_resolve, reject) => { rejectLoad = reject }) })
    aborted.openNext(1)
    aborted.fakes[0]!.listeners.get('blur')!()
    expect(aborted.events).toEqual(['closed'])
    rejectLoad(new Error('aborted'))
    await settle()
    expect(aborted.events).toEqual(['closed'])
    expect(aborted.traces, 'an expected abort leaves no trace').toEqual([])
  })
})

describe('avatar bubble notification service', () => {
  const opened = async (overrides: Partial<AvatarBubbleWindowOptions> = {}) => {
    const h = harness(undefined, overrides)
    h.bubble.open()
    return h
  }
  const showAndServe = async (h: ReturnType<typeof harness>, generation: number): Promise<void> => {
    h.lifecycles.get(generation)!.ready()
    await h.call(AVATAR_BUBBLE_CHANNELS.getState, generation)
  }

  test('the service is ready once built, before any opening, and announces nothing yet', () => {
    const h = harness()
    expect(h.bubble.notificationServiceReady()).toBe(true)
    expect(h.flips).toEqual([])
  })

  test('a normal close, however often, keeps the service ready and announces nothing', async () => {
    const h = await opened()
    await showAndServe(h, 1)
    h.bubble.close()
    h.bubble.open()
    h.bubble.close()
    expect(h.bubble.notificationServiceReady()).toBe(true)
    expect(h.flips).toEqual([])
  })

  test('a failure makes the service unavailable, once, and the closure that follows heals nothing', async () => {
    const h = await opened()
    h.lifecycles.get(1)!.failed()
    expect(h.bubble.notificationServiceReady()).toBe(false)
    expect(h.flips).toEqual([false])

    h.bubble.close()
    expect(h.bubble.notificationServiceReady()).toBe(false)
    h.bubble.open()
    expect(h.bubble.notificationServiceReady(), 'an opening in progress after a failure is still unavailable').toBe(false)
    expect(h.flips).toEqual([false])
  })

  test('after a failure only a later generation that is shown and serves its state restores the service', async () => {
    const h = await opened()
    h.lifecycles.get(1)!.failed()
    h.bubble.close()

    h.bubble.open()
    h.lifecycles.get(2)!.ready()
    expect(h.bubble.notificationServiceReady(), 'shown but no state served yet').toBe(false)
    await h.call(AVATAR_BUBBLE_CHANNELS.getState, 2)
    expect(h.bubble.notificationServiceReady()).toBe(true)
    expect(h.flips).toEqual([false, true])

    h.lifecycles.get(2)!.failed()
    h.bubble.close()
    h.bubble.open()
    await h.call(AVATAR_BUBBLE_CHANNELS.getState, 3)
    expect(h.bubble.notificationServiceReady(), 'a served state without the show is not enough').toBe(false)
    h.lifecycles.get(3)!.ready()
    expect(h.bubble.notificationServiceReady()).toBe(true)
    expect(h.flips).toEqual([false, true, false, true])
  })

  test('the generation that failed cannot heal itself, even when it is shown and served again', async () => {
    const h = await opened()
    await showAndServe(h, 1)
    h.lifecycles.get(1)!.failed()
    expect(h.bubble.notificationServiceReady()).toBe(false)

    await showAndServe(h, 1)

    expect(h.bubble.notificationServiceReady()).toBe(false)
    expect(h.flips).toEqual([false])
  })

  test('the failure callback of an older generation is ignored', async () => {
    const h = await opened()
    const first = h.lifecycles.get(1)!
    h.bubble.close()
    h.bubble.open()

    first.failed()

    expect(h.bubble.notificationServiceReady()).toBe(true)
    expect(h.flips).toEqual([])
  })

  test('a creation failure inside open is a failure of the generation being opened', () => {
    const h = harness(undefined, {
      native: {
        open: (_generation, _rect, lifecycle) => {
          lifecycle.failed()
          lifecycle.closed()
        },
        focus() {},
        resize() {},
        close() {},
        endpoint: () => null
      }
    })
    h.bubble.open()
    expect(h.bubble.notificationServiceReady()).toBe(false)
    expect(h.flips).toEqual([false])
  })

  test('dispose makes the service unavailable, announced, before any handler is removed', () => {
    const seen: boolean[] = []
    const holder: { bubble: ReturnType<typeof harness>['bubble'] | null } = { bubble: null }
    const h = harness(undefined, {
      ipc: {
        handle() {},
        removeHandler: () => {
          seen.push(holder.bubble!.notificationServiceReady())
        }
      }
    })
    holder.bubble = h.bubble

    h.bubble.dispose()

    expect(h.flips).toEqual([false])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((ready) => ready === false)).toBe(true)
  })

  test('an observer that throws is traced and does not break the failure path', async () => {
    const h = await opened({
      onNotificationAvailabilityChanged: () => {
        throw new Error('observer failed')
      }
    })
    h.lifecycles.get(1)!.failed()
    expect(h.bubble.notificationServiceReady()).toBe(false)
    expect(h.errors).toContain('Avatar bubble availability observer failed')
  })
})

describe('avatarBubblePlacement', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 }

  test('opens against the left of the mask, bottom edges aligned, mask on its right, when there is room', () => {
    expect(avatarBubblePlacement({ x: 1700, y: 800, width: 160, height: 160 }, workArea)).toEqual({
      rect: { x: 1312, y: 400, width: 388, height: 560 },
      anchor: 'right'
    })
  })

  test('opens right of a mask at the left edge, mask on its left, inside the work area', () => {
    expect(avatarBubblePlacement({ x: 10, y: 20, width: 160, height: 160 }, workArea)).toEqual({
      rect: { x: 170, y: 0, width: 388, height: 560 },
      anchor: 'left'
    })
  })

  test('expanded, keeps the mask side and the bottom alignment at the larger size', () => {
    expect(avatarBubblePlacement({ x: 1700, y: 800, width: 160, height: 160 }, workArea, true)).toEqual({
      rect: { x: 548, y: 128, width: 1152, height: 832 },
      anchor: 'right'
    })
  })

  test('expanded, flips the anchor to the left when the larger bubble no longer fits left of the mask', () => {
    expect(avatarBubblePlacement({ x: 500, y: 800, width: 160, height: 160 }, workArea, true)).toEqual({
      rect: { x: 660, y: 128, width: 1152, height: 832 },
      anchor: 'left'
    })
  })

  test('expanded, never leaves the work area on any side, whichever display it sits on', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1040 }
    const masks = [
      { x: 1000, y: 800, width: 160, height: 160 },
      { x: 10, y: 20, width: 160, height: 160 },
      { x: 1750, y: 900, width: 160, height: 160 }
    ]
    for (const area of [workArea, second]) {
      for (const mask of masks) {
        const { rect } = avatarBubblePlacement({ ...mask, x: mask.x + area.x }, area, true)
        expect(rect.x).toBeGreaterThanOrEqual(area.x)
        expect(rect.y).toBeGreaterThanOrEqual(area.y)
        expect(rect.x + rect.width).toBeLessThanOrEqual(area.x + area.width)
        expect(rect.y + rect.height).toBeLessThanOrEqual(area.y + area.height)
      }
    }
  })

  test('not expanded by default, the size is the normal one', () => {
    expect(avatarBubblePlacement({ x: 1700, y: 800, width: 160, height: 160 }, workArea).rect).toMatchObject({ width: 388, height: 560 })
  })

  test('not expanded, the left side wins while it holds the normal width, even when the right side is wider', () => {
    expect(avatarBubblePlacement({ x: 500, y: 800, width: 160, height: 160 }, workArea)).toEqual({
      rect: { x: 112, y: 400, width: 388, height: 560 },
      anchor: 'right'
    })
  })

  const covers = (rect: { x: number; width: number }, mask: { x: number; width: number }): boolean =>
    rect.x < mask.x + mask.width && mask.x < rect.x + rect.width

  test('expanded, the mask at its default centred position keeps the bubble beside it, the anchor naming the mask side', () => {
    const restored = restoreAvatarPlacement([{ id: 'd', workArea }], {}, AVATAR_WINDOW_SIZES.m)
    const mask = { x: restored.x, y: restored.y, width: restored.width, height: restored.height }
    const { rect, anchor } = avatarBubblePlacement(mask, workArea, true)
    expect(covers(rect, mask), `bubble ${JSON.stringify(rect)} over mask ${JSON.stringify(mask)}`).toBe(false)
    expect(anchor).toBe('right')
    expect(rect.x + rect.width, 'against the mask, tail side').toBe(mask.x)
    expect(rect.width).toBe(mask.x - workArea.x)
  })

  test('expanded, the width is limited to the room on the wider side of the mask, which can be the right one', () => {
    const mask = { x: 800, y: 440, width: 160, height: 160 }
    const { rect, anchor } = avatarBubblePlacement(mask, workArea, true)
    expect(anchor).toBe('left')
    expect(rect.x).toBe(mask.x + mask.width)
    expect(rect.width).toBe(workArea.x + workArea.width - (mask.x + mask.width))
  })

  test('expanded, a mask near the left edge and one near the right edge keep the proportional width on their open side', () => {
    expect(avatarBubblePlacement({ x: 10, y: 20, width: 160, height: 160 }, workArea, true)).toMatchObject({ rect: { x: 170, width: 1152 }, anchor: 'left' })
    expect(avatarBubblePlacement({ x: 1750, y: 900, width: 160, height: 160 }, workArea, true)).toMatchObject({ rect: { x: 598, width: 1152 }, anchor: 'right' })
  })

  test('expanded, a side with less than the normal width is never the one the bubble takes', () => {
    const area = { x: 0, y: 0, width: 1000, height: 800 }
    const { rect, anchor } = avatarBubblePlacement({ x: 700, y: 300, width: 160, height: 160 }, area, true)
    expect(anchor).toBe('right')
    expect(rect.x + rect.width).toBe(700)
  })

  test('expanded, the normal width is the least room that narrows the bubble, 388 on a side narrows it and 387 on both sides does not', () => {
    const exact = { x: 0, y: 0, width: 936, height: 800 }
    expect(avatarBubblePlacement({ x: 388, y: 300, width: 160, height: 160 }, exact, true)).toMatchObject({ rect: { x: 0, width: 388 }, anchor: 'right' })
    const short = { x: 0, y: 0, width: 934, height: 800 }
    const shortMask = { x: 387, y: 300, width: 160, height: 160 }
    const placed = avatarBubblePlacement(shortMask, short, true)
    expect(placed.rect.width, 'no side holds 388: the proportional width is kept').toBe(560)
    expect(placed.anchor).toBe('left')
    expect(placed.rect.x, 'kept inside the work area').toBeGreaterThanOrEqual(short.x)
    expect(placed.rect.x + placed.rect.width, 'kept inside the work area').toBeLessThanOrEqual(short.x + short.width)
    expect(covers(placed.rect, shortMask), 'no room beside the mask: the overlap is accepted').toBe(true)
  })

  test('with room for the normal width on a side, a bubble of either size never covers the mask and the anchor names the mask side', () => {
    const areas = [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: 1920, y: 0, width: 1366, height: 728 },
      { x: 0, y: 0, width: 1000, height: 800 }
    ]
    let checked = 0
    for (const area of areas) {
      for (const expanded of [false, true]) {
        for (let x = area.x; x <= area.x + area.width - 160; x += 37) {
          for (const y of [area.y, area.y + Math.floor(area.height / 2), area.y + area.height - 160]) {
            const mask = { x, y, width: 160, height: 160 }
            const leftRoom = mask.x - area.x
            const rightRoom = area.x + area.width - (mask.x + mask.width)
            if (Math.max(leftRoom, rightRoom) < 388) continue
            checked += 1
            const { rect, anchor } = avatarBubblePlacement(mask, area, expanded)
            const label = `expanded ${expanded} area ${JSON.stringify(area)} mask x ${x}: ${JSON.stringify(rect)} ${anchor}`
            expect(covers(rect, mask), label).toBe(false)
            expect(anchor === 'right' ? rect.x + rect.width : rect.x, label).toBe(anchor === 'right' ? mask.x : mask.x + mask.width)
            expect(rect.width, label).toBeGreaterThanOrEqual(388)
            expect(rect.x, label).toBeGreaterThanOrEqual(area.x)
            expect(rect.x + rect.width, label).toBeLessThanOrEqual(area.x + area.width)
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
  })
})

describe('avatarBubbleSize', () => {
  const area = (width: number, height: number) => ({ x: 0, y: 0, width, height })

  test('normal size on a roomy screen', () => {
    expect(avatarBubbleSize(area(1920, 1040), false)).toEqual({ width: 388, height: 560 })
  })

  test('expanded is 60 % of the width and 80 % of the height of the work area', () => {
    expect(avatarBubbleSize(area(1920, 1040), true)).toEqual({ width: 1152, height: 832 })
  })

  test('expanded never goes below the normal size', () => {
    expect(avatarBubbleSize(area(1000, 600), true)).toEqual({ width: 600, height: 560 })
    expect(avatarBubbleSize(area(500, 1000), true)).toEqual({ width: 388, height: 800 })
  })

  test('expanded width stops at 1200 px on a large screen while the height keeps following the screen', () => {
    expect(avatarBubbleSize(area(3840, 2160), true)).toEqual({ width: 1200, height: 1728 })
  })

  test('a work area smaller than the normal size caps both sizes', () => {
    expect(avatarBubbleSize(area(300, 400), true)).toEqual({ width: 300, height: 400 })
    expect(avatarBubbleSize(area(300, 400), false)).toEqual({ width: 300, height: 400 })
  })

  test('a fractional work area smaller than the normal size gives integer DIP that stay inside it', () => {
    for (const expanded of [false, true]) {
      const size = avatarBubbleSize(area(300.6, 400.6), expanded)
      expect(size, `expanded ${expanded}`).toEqual({ width: 300, height: 400 })
    }
    expect(avatarBubbleSize(area(387.9, 559.9), false)).toEqual({ width: 387, height: 559 })
  })

  test('a fractional work area still gives integer DIP', () => {
    const size = avatarBubbleSize(area(1365.5, 728.5), true)
    expect(Number.isInteger(size.width)).toBe(true)
    expect(Number.isInteger(size.height)).toBe(true)
    expect(size).toEqual({ width: 819, height: 583 })
  })
})

describe('avatarBubbleDict', () => {
  test('keeps only the bubble and Courrier keys', () => {
    expect(avatarBubbleDict({ 'avatarBubble.allow': 'a', 'inbox.title': 'b', 'settings.title': 'c', 'xavatarBubble.y': 'd' })).toEqual({
      'avatarBubble.allow': 'a',
      'inbox.title': 'b'
    })
  })
})
