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

  test('a card carries the text flags and the danger view, its rule ids and messages neutralised', () => {
    const entry = { id: `repo/x${RLO}`, source: 'repo', message: `m${ZWSP}\nn`, messageFrom: 'agent', known: true, confirmed: false } as const
    const unnamed = { ...entry, id: 'kory/unknown', source: 'kory', message: null, messageFrom: 'deck', known: false } as const
    const cardOf = (patch: Partial<InboxRelayApproval>) =>
      projectAvatarBubble({ boxes: [box(DECK_A, { approvals: [approval(1, patch)] })], decks, lost: [], now: 0 }).reclame[0]!

    const card = cardOf({ text_flags: ['bidi', 'control'], danger_view: { reevaluation: 'partial', entries: [entry, unnamed] } })
    expect(card.textFlags).toEqual(['bidi', 'control'])
    expect(card.dangerView).toEqual({
      reevaluation: 'partial',
      entries: [{ ...entry, id: `repo/x${REPLACEMENT}`, message: `m${REPLACEMENT} / n` }, unnamed]
    })
    expect(cardOf({})).toMatchObject({ textFlags: [] })
    expect(cardOf({}).dangerView).toBeUndefined()
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

  test('a card carries the recommended position of its options for a question only, and null for any other kind or no marker', () => {
    const cardOf = (patch: Partial<InboxRelayApproval>) =>
      projectAvatarBubble({ boxes: [box(DECK_A, { approvals: [approval(1, patch)] })], decks, lost: [], now: 0 }).reclame[0]!
    const question: Partial<InboxRelayApproval> = { kind: 'question', reply_route: 'channel', options: ['A', 'B', 'C'] }

    expect(cardOf({ ...question, recommended: 2 }).recommended).toBe(2)
    expect(cardOf({ ...question, recommended: 0 }).recommended).toBe(0)
    expect(cardOf({ ...question }).recommended).toBeNull()
    expect(cardOf({ ...question, recommended: null }).recommended).toBeNull()
    expect(cardOf({ kind: 'permission', reply_route: 'hook', options: ['A', 'B'], recommended: 0 }).recommended).toBeNull()
    expect(cardOf({ kind: 'plan', reply_route: 'hook', options: ['A', 'B'], recommended: 1 }).recommended).toBeNull()

    const card = cardOf({ ...question, options: [`a${NUL}`, 'B', 'C'], recommended: 1 })
    expect(card.options[card.recommended!]).toMatchObject({ value: 'B' })
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

  test('a closed question keeps its authority and sender projection per Deck', () => {
    const closed = (id: number, closed_by: 'lead' | null) => ({
      id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      title: `Q${id}`,
      closed_at: `2026-11-17T10:00:0${id}.000Z`,
      closed_by,
      reason: null,
      from_peer_id: id === 1 ? `peer${NUL}${RLO}\nlead` : `peer-${id}`,
      tile_name: id === 1 ? `Team${NUL}${RLO}\nlead` : null
    })
    const model = projectAvatarBubble({
      boxes: [box(DECK_A, { closed: [closed(1, 'lead')] }), box(DECK_B, { closed: [closed(2, null)] })],
      decks,
      lost: [],
      now: 0
    })
    expect(model.closed.map((entry) => [entry.title, entry.closedBy, entry.fromPeerId, entry.tileName])).toEqual([
      ['Q2', null, 'peer-2', null],
      ['Q1', 'lead', `peer${REPLACEMENT}${REPLACEMENT} / lead`, `Team${REPLACEMENT}${REPLACEMENT} / lead`]
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

describe('courrierPending', () => {
  test('counts the messages the disposition counts over the attached Decks, by composite read key, two Decks reusing an id and a date staying apart', () => {
    const sent = message(1).sent_at
    const readsA = new Map<string, 'seen' | 'acked'>([
      [avatarBubbleMessageKey(DECK_A, 1, 1, sent), 'acked'],
      [avatarBubbleMessageKey(DECK_A, 1, 4, message(4).sent_at), 'acked'],
      [avatarBubbleMessageKey(DECK_A, 1, 5, message(5).sent_at), 'seen']
    ])
    const messagesA = [
      message(1),
      message(2, { state: 'responded' }),
      message(3, { state: 'closed' }),
      message(4),
      message(5)
    ]
    const model = projectAvatarBubble({
      boxes: [box(DECK_A, { messages: messagesA, reads: readsA }), box(DECK_B, { messages: [message(1)] })],
      decks,
      lost: [],
      now: 0
    })
    expect(model.courrierPending).toBe(2)
    const alone = projectAvatarBubble({ boxes: [box(DECK_A, { messages: messagesA, reads: readsA })], decks, lost: [], now: 0 })
    expect(alone.courrierPending, 'Deck B reads nothing of Deck A').toBe(1)
    const detached = projectAvatarBubble({ boxes: [box(DECK_A, { messages: messagesA, reads: readsA })], decks: [decks[1]!], lost: [], now: 0 })
    expect(detached.courrierPending, 'a box whose Deck is not attached is not counted').toBe(0)
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
