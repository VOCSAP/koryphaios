import { describe, expect, test } from 'bun:test'
import {
  AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS,
  AVATAR_BUBBLE_CHANNELS,
  avatarBubbleMessageKey,
  avatarBubbleReadApi,
  projectAvatarBubble,
  safeBlock,
  safeLine,
  type AvatarBubbleBox,
  type AvatarBubbleDeck
} from '../desktop/src/shared/avatar-bubble-view'
import type { InboxRelayApproval, InboxRelayMessage } from '../desktop/src/shared/avatar-inbox-protocol'

const ch = (code: number): string => String.fromCharCode(code)
const RLO = ch(0x202e)
const NUL = ch(0)
const LS = ch(0x2028)
const ZWSP = ch(0x200b)
const REPLACEMENT = ch(0xfffd)

const DECK_A = { deckRunId: 'run-a', broker_url: 'http://127.0.0.1:7899' }
const DECK_B = { deckRunId: 'run-b', broker_url: 'http://127.0.0.1:7899' }

function approval(id: number, patch: Partial<InboxRelayApproval> = {}): InboxRelayApproval {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    kind: 'permission',
    status: 'pending',
    informational: false,
    reply_route: 'hook',
    mergeable: false,
    absorbed_permission: false,
    title: `Bash ${id}`,
    question: 'rm -rf build',
    options: [],
    questions: null,
    created_at: `2026-11-17T10:00:0${id}.000Z`,
    from_peer_id: 'peer-1',
    tile_name: 'tile',
    ...patch
  }
}

function message(id: number, patch: Partial<InboxRelayMessage> = {}): InboxRelayMessage {
  return {
    id,
    from_peer_id: 'peer-1',
    text: 'hello',
    sent_at: `2026-11-17T10:00:0${id}.000Z`,
    state: 'open',
    closed_at: null,
    closed_by: null,
    reason: null,
    ...patch
  }
}

function box(identity: typeof DECK_A, patch: Partial<AvatarBubbleBox> = {}): AvatarBubbleBox {
  return {
    identity,
    approvals: [],
    messages: [],
    closed: [],
    truncated: { approvals: 0, messages: 0, closed: 0 },
    scopeGeneration: 1,
    settledLocally: new Set(),
    reads: new Map(),
    ...patch
  }
}

const decks: AvatarBubbleDeck[] = [
  { ...DECK_A, deckName: 'koryphaios' },
  { ...DECK_B, deckName: 'koryphaios' }
]

describe('safeLine and safeBlock', () => {
  test('safeLine folds every line break into one line and neutralises bidi, control and invisible characters', () => {
    expect(safeLine(`a\r\nb\nc${LS}d`)).toBe('a / b / c / d')
    expect(safeLine(`x${RLO}y${NUL}z${ZWSP}`)).toBe(`x${REPLACEMENT}y${REPLACEMENT}z${REPLACEMENT}`)
  })

  test('safeBlock keeps line breaks as \\n and neutralises everything else, bidi override included', () => {
    expect(safeBlock(`a\r\nb\rc${LS}d\ne`)).toBe('a\nb\nc\nd\ne')
    expect(safeBlock(`x${RLO}y${NUL}\tz${ZWSP}`)).toBe(`x${REPLACEMENT}y${REPLACEMENT}${REPLACEMENT}z${REPLACEMENT}`)
  })
})

describe('projectAvatarBubble', () => {
  test('one queue over every Deck, blocking cards before informational ones, each labelled with its unique Deck label', () => {
    const model = projectAvatarBubble({
      boxes: [
        box(DECK_A, { approvals: [approval(1, { informational: true, kind: 'question', reply_route: 'channel' }), approval(3)] }),
        box(DECK_B, { approvals: [approval(2)] })
      ],
      decks,
      lost: [],
      now: 0
    })
    expect(model.reclame.map((card) => [card.approvalId.slice(-1), card.blocking, card.deckLabel])).toEqual([
      ['2', true, 'koryphaios (2)'],
      ['3', true, 'koryphaios'],
      ['1', false, 'koryphaios']
    ])
  })

  test('relayed text reaches the model already neutralised, line breaks kept only in the question body', () => {
    const hostile = approval(1, {
      title: `t${RLO}\nx`,
      question: `line1\nline2${RLO}`,
      options: [`o${NUL}`],
      from_peer_id: `p${RLO}`,
      tile_name: `n${LS}m`
    })
    const [card] = projectAvatarBubble({
      boxes: [box(DECK_A, { approvals: [hostile] })],
      decks: [{ ...DECK_A, deckName: `deck${RLO}` }],
      lost: [],
      now: 0
    }).reclame
    expect(card).toMatchObject({
      title: `t${REPLACEMENT} / x`,
      question: `line1\nline2${REPLACEMENT}`,
      options: [{ value: `o${NUL}`, label: `o${REPLACEMENT}` }],
      fromPeerId: `p${REPLACEMENT}`,
      tileName: 'n / m',
      deckLabel: `deck${REPLACEMENT}`
    })
  })

  test('a cut card offers deny and open-in-Deck, never allow', () => {
    const [card] = projectAvatarBubble({
      boxes: [box(DECK_A, { approvals: [approval(1, { cut: true })] })],
      decks,
      lost: [],
      now: 0
    }).reclame
    expect(card!.gestures).toEqual(['deny'])
    expect(card!.openInDeck).toBe(true)
    const [whole] = projectAvatarBubble({ boxes: [box(DECK_A, { approvals: [approval(1)] })], decks, lost: [], now: 0 }).reclame
    expect(whole!.gestures).toEqual(['allow', 'deny'])
    expect(whole!.openInDeck).toBe(false)
  })

  test('a card offers allow only on a hook permission, no deny on hook structured questions, free text never on a hook entry nor on structured questions', () => {
    const questions = [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: '' }], multi_select: false }]
    const gesturesOf = (patch: Partial<InboxRelayApproval>) =>
      projectAvatarBubble({ boxes: [box(DECK_A, { approvals: [approval(1, patch)] })], decks, lost: [], now: 0 }).reclame[0]!.gestures
    expect(gesturesOf({ kind: 'permission', reply_route: 'hook' })).toEqual(['allow', 'deny'])
    expect(gesturesOf({ kind: 'permission', reply_route: 'pty' })).toEqual(['deny'])
    expect(gesturesOf({ kind: 'permission', reply_route: 'channel' })).toEqual(['deny'])
    expect(gesturesOf({ kind: 'question', reply_route: 'hook', questions })).toEqual(['answers'])
    expect(gesturesOf({ kind: 'question', reply_route: 'hook', questions: null })).toEqual(['deny'])
    expect(gesturesOf({ kind: 'plan', reply_route: 'hook' })).toEqual(['deny'])
    expect(gesturesOf({ kind: 'question', reply_route: 'channel', questions })).toEqual(['deny', 'answers', 'acknowledge'])
    expect(gesturesOf({ kind: 'question', reply_route: 'channel' })).toEqual(['deny', 'text', 'acknowledge'])
  })

  test('an approval settled locally leaves the queue before the next snapshot', () => {
    const settled = approval(1)
    const model = projectAvatarBubble({
      boxes: [box(DECK_A, { approvals: [settled, approval(2)], settledLocally: new Set([settled.id]) })],
      decks,
      lost: [],
      now: 0
    })
    expect(model.reclame.map((card) => card.approvalId)).toEqual([approval(2).id])
  })

  test('a lost card shows settled elsewhere with no gesture for 2 s, once, then disappears', () => {
    const relayed = approval(1)
    const [card] = projectAvatarBubble({ boxes: [box(DECK_A, { approvals: [relayed] })], decks, lost: [], now: 0 }).reclame
    const lost = [{ card: card!, at: 1_000 }]
    const during = projectAvatarBubble({ boxes: [box(DECK_A, { approvals: [relayed] })], decks, lost, now: 1_000 + AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS - 1 })
    expect(during.reclame).toHaveLength(1)
    expect(during.reclame[0]).toMatchObject({ settledElsewhere: true, gestures: [], openInDeck: false })
    expect(during.nextChangeAt).toBe(1_000 + AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS)
    const after = projectAvatarBubble({ boxes: [box(DECK_A)], decks, lost, now: 1_000 + AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS })
    expect(after.reclame).toEqual([])
    expect(after.nextChangeAt).toBeNull()
  })

  test('a box whose Deck is not attached is dropped', () => {
    const model = projectAvatarBubble({
      boxes: [box({ deckRunId: 'gone', broker_url: DECK_A.broker_url }, { approvals: [approval(1)], messages: [message(1)] })],
      decks,
      lost: [],
      now: 0
    })
    expect(model.reclame).toEqual([])
    expect(model.courrier).toEqual([])
  })

  test('a closed message is marked closed from its state, even without closed_at', () => {
    const model = projectAvatarBubble({
      boxes: [box(DECK_A, { messages: [message(1, { state: 'closed' }), message(2, { text: `a\nb${RLO}` })] })],
      decks,
      lost: [],
      now: 0
    })
    expect(model.courrier.map((entry) => [entry.id, entry.closed, entry.text])).toEqual([
      [2, false, `a\nb${REPLACEMENT}`],
      [1, true, 'hello']
    ])
  })

  test('a message key names its Deck run, broker, scope generation, id and send date, and the projection carries that key', () => {
    const sentAt = message(1).sent_at
    const keys = [
      avatarBubbleMessageKey(DECK_A, 1, 1, sentAt),
      avatarBubbleMessageKey({ ...DECK_A, deckRunId: 'run-b' }, 1, 1, sentAt),
      avatarBubbleMessageKey({ ...DECK_A, broker_url: 'http://127.0.0.1:7900' }, 1, 1, sentAt),
      avatarBubbleMessageKey(DECK_A, 2, 1, sentAt),
      avatarBubbleMessageKey(DECK_A, 1, 2, sentAt),
      avatarBubbleMessageKey(DECK_A, 1, 1, '2026-11-17T10:00:09.000Z')
    ]
    expect(new Set(keys).size).toBe(keys.length)
    const [entry] = projectAvatarBubble({ boxes: [box(DECK_A, { messages: [message(1)] })], decks, lost: [], now: 0 }).courrier
    expect(entry).toMatchObject({ key: keys[0], scopeGeneration: 1, read: null })
  })

  test('a message takes its read state from its whole key: the same id and date at another Deck, generation or send date stays unread', () => {
    const reads = new Map<string, 'seen' | 'acked'>([[avatarBubbleMessageKey(DECK_A, 1, 1, message(1).sent_at), 'acked']])
    const readOf = (identity: typeof DECK_A, patch: Partial<AvatarBubbleBox>, sent: Partial<InboxRelayMessage> = {}) =>
      projectAvatarBubble({ boxes: [box(identity, { messages: [message(1, sent)], reads, ...patch })], decks, lost: [], now: 0 }).courrier[0]!.read
    expect(readOf(DECK_A, {})).toBe('acked')
    expect(readOf(DECK_B, {})).toBeNull()
    expect(readOf(DECK_A, { scopeGeneration: 2 })).toBeNull()
    expect(readOf(DECK_A, {}, { sent_at: '2026-11-17T10:00:09.000Z' })).toBeNull()
  })
})

describe('avatarBubbleReadApi', () => {
  test('markSeen and ack each invoke their own channel with the intent unchanged', async () => {
    const calls: Array<[string, unknown]> = []
    const api = avatarBubbleReadApi(async (channel, intent) => {
      calls.push([channel, intent])
      return 'seen'
    })
    const intent = { generation: 1, ...DECK_A, scopeGeneration: 2, id: 3, sentAt: message(3).sent_at }
    await api.markSeen(intent)
    await api.ack(intent)
    expect(calls).toEqual([
      [AVATAR_BUBBLE_CHANNELS.markSeen, intent],
      [AVATAR_BUBBLE_CHANNELS.ack, intent]
    ])
  })
})
