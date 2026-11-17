import { describe, expect, test } from 'bun:test'
import {
  avatarBubbleDict,
  avatarBubblePlacement,
  createAvatarBubbleNativeAdapter,
  createAvatarBubbleWindow,
  type AvatarBubbleBrowserWindow,
  type AvatarBubbleIpcHandler,
  type AvatarBubbleLifecycle,
  type AvatarBubbleNativeAdapter,
  type AvatarBubblePlacement,
  type AvatarBubbleWindowConstructionOptions,
  type AvatarBubbleWindowOptions,
  type AvatarBubbleWebContents
} from '../desktop/src/main/avatar-bubble-window'
import { AVATAR_BUBBLE_CHANNELS, AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS, type AvatarBubbleBox, type AvatarBubbleState } from '../desktop/src/shared/avatar-bubble-view'
import type { AvatarInboxAction, InboxRelayApproval } from '../desktop/src/shared/avatar-inbox-protocol'
import type { AvatarDeckIdentity } from '../desktop/src/shared/avatar-state'
import type { AvatarInboxGestureResult } from '../desktop/src/main/avatar-inbox-service'
import type { ApprovalWindowSession } from '../desktop/src/main/approval-window'

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
  let now = 0
  let outcome: AvatarInboxGestureResult = { outcome: 'won' }
  const box: AvatarBubbleBox = {
    identity: DECK,
    approvals: initial,
    messages: [],
    closed: [],
    truncated: { approvals: 0, messages: 0, closed: 0 },
    settledLocally: new Set()
  }
  let placement: AvatarBubblePlacement | null = { rect: { x: 0, y: 0, width: 388, height: 560 }, anchor: 'left' }
  const native: AvatarBubbleNativeAdapter = {
    open(generation, _rect, lifecycle) {
      endpoints.set(generation, contents())
      lifecycles.set(generation, lifecycle)
    },
    focus() {},
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
    focusDeck: async (identity) => {
      focused.push(identity)
    },
    theme: () => 'dark',
    lang: 'fr',
    dict: { 'avatarBubble.allow': 'Autoriser' },
    placement: () => placement,
    now: () => now,
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    reportError: (_scope, message) => errors.push(message),
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
    focused,
    timers,
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
    }
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

describe('avatar bubble native window', () => {
  function fakeWindow() {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const contentListeners = new Map<string, (...args: unknown[]) => void>()
    let destroyed = false
    const window: AvatarBubbleBrowserWindow = {
      webContents: {
        mainFrame: {},
        send() {},
        setWindowOpenHandler() {},
        on: (name, listener) => contentListeners.set(name, listener)
      },
      on: (name, listener) => listeners.set(name, listener),
      show() {},
      focus() {},
      destroy() {
        destroyed = true
        listeners.get('closed')?.()
      },
      isDestroyed: () => destroyed,
      loadFile: async () => undefined
    }
    return { window, listeners, contentListeners, destroyed: () => destroyed }
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

  function adapterOf(runId: string) {
    const session = fakeSession()
    const partitions: string[] = []
    const created: AvatarBubbleWindowConstructionOptions[] = []
    const fakes: Array<ReturnType<typeof fakeWindow>> = []
    let closed = 0
    const adapter = createAvatarBubbleNativeAdapter({
      preload: 'p',
      html: 'h',
      runId,
      createWindow: (options) => {
        created.push(options)
        const fake = fakeWindow()
        fakes.push(fake)
        return fake.window
      },
      sessionFromPartition: (partition) => {
        partitions.push(partition)
        return session.bubbleSession
      },
      reportError() {}
    })
    const openNext = (generation: number) => adapter.open(generation, { x: 0, y: 0, width: 388, height: 560 }, { closed: () => (closed += 1) })
    return { adapter, openNext, session, partitions, created, fakes, closed: () => closed }
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
})

describe('avatarBubbleDict', () => {
  test('keeps only the bubble and Courrier keys', () => {
    expect(avatarBubbleDict({ 'avatarBubble.allow': 'a', 'inbox.title': 'b', 'settings.title': 'c', 'xavatarBubble.y': 'd' })).toEqual({
      'avatarBubble.allow': 'a',
      'inbox.title': 'b'
    })
  })
})
