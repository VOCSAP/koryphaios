import { expect, test } from 'bun:test'
import { AVATAR_READ_CAP_PER_DECK, createAvatarInboxService } from '../desktop/src/main/avatar-inbox-service.ts'
import { avatarBubbleMessageKey } from '../desktop/src/shared/avatar-bubble-view.ts'
import { reachedWithin } from './_bounded-await.ts'
import type { AvatarCommandResult } from '../desktop/src/main/avatar-server.ts'
import type { AvatarInboxAction, AvatarInboxSnapshotFrame, InboxRelayMessage } from '../desktop/src/shared/avatar-inbox-protocol.ts'

const deck = { deckRunId: 'deck-run-1', broker_url: 'http://127.0.0.1:7899' }
const other = { deckRunId: 'deck-run-2', broker_url: 'http://127.0.0.1:7899' }
const ID = '00000000-0000-4000-8000-000000000001'

function frame(ids: string[], seq = 1): AvatarInboxSnapshotFrame {
  return {
    type: 'inbox_snapshot',
    protocol_version: 1,
    ...deck,
    scope_generation: 2,
    seq,
    approvals: ids.map((id) => ({
      id,
      kind: 'question',
      status: 'pending',
      informational: false,
      reply_route: 'channel',
      mergeable: false,
      absorbed_permission: false,
      title: 't',
      question: 'q',
      options: [],
      questions: null,
      created_at: '2026-11-17T08:00:00.000Z',
      from_peer_id: 'peer-a',
      tile_name: null
    })),
    messages: [],
    closed: [],
    truncated: { approvals: 0, messages: 0, closed: 0 }
  }
}

function service(send: (identity: typeof deck, action: AvatarInboxAction) => Promise<AvatarCommandResult>) {
  const reports: string[] = []
  const sent: AvatarInboxAction[] = []
  const changes = { count: 0 }
  const inbox = createAvatarInboxService({
    send: (identity, action) => {
      sent.push(action)
      return send(identity, action)
    },
    report: (_scope, message) => reports.push(message),
    changed: () => {
      changes.count += 1
    }
  })
  return { inbox, reports, sent, changes }
}

const SENT = '2026-11-17T08:00:00.000Z'

function mail(id: number, sentAt = SENT): InboxRelayMessage {
  return { id, from_peer_id: 'peer-a', text: 'hi', sent_at: sentAt, state: 'open', closed_at: null, closed_by: null, reason: null }
}

function withMail(messages: InboxRelayMessage[], patch: Partial<AvatarInboxSnapshotFrame> = {}): AvatarInboxSnapshotFrame {
  return { ...frame([]), messages, ...patch }
}

function readsOf(inbox: ReturnType<typeof service>['inbox'], identity: typeof deck = deck): string[] {
  const box = inbox.boxes().find((candidate) => candidate.identity.deckRunId === identity.deckRunId && candidate.identity.broker_url === identity.broker_url)
  return [...(box?.reads.keys() ?? [])]
}

const idle = async (): Promise<AvatarCommandResult> => ({ requestId: 'r', ok: true, outcome: 'won' })

test('holds one box per Deck, replaced whole by each snapshot and erased on clear', () => {
  const { inbox } = service(async () => ({ requestId: 'r', ok: true, outcome: 'won' }))
  inbox.receive(deck, frame([ID]))
  inbox.receive(other, { ...frame([]), ...other })
  inbox.receive(deck, frame([], 2))
  expect(inbox.boxes().map((box) => [box.identity.deckRunId, box.approvals.length, box.scopeGeneration])).toEqual([
    ['deck-run-1', 0, 2],
    ['deck-run-2', 0, 2]
  ])
  inbox.clear(deck)
  expect(inbox.boxes().map((box) => box.identity.deckRunId)).toEqual(['deck-run-2'])
})

test('a won gesture is settled locally until the next snapshot, which is authoritative', async () => {
  const { inbox, sent } = service(async () => ({ requestId: 'r', ok: true, outcome: 'won' }))
  inbox.receive(deck, frame([ID]))
  expect(await inbox.act(deck, { approval_id: ID, action: 'allow' })).toEqual({ outcome: 'won' })
  expect(sent).toEqual([{ approval_id: ID, action: 'allow' }])
  expect([...inbox.boxes()[0]!.settledLocally]).toEqual([ID])
  inbox.receive(deck, frame([ID], 2))
  expect([...inbox.boxes()[0]!.settledLocally]).toEqual([])
})

test('lost and refused pass through without an error trace; a Deck failure is traced', async () => {
  const lost = service(async () => ({ requestId: 'r', ok: true, outcome: 'lost' }))
  lost.inbox.receive(deck, frame([ID]))
  expect(await lost.inbox.act(deck, { approval_id: ID, action: 'deny' })).toEqual({ outcome: 'lost' })
  expect(lost.reports).toEqual([])

  const refused = service(async () => ({ requestId: 'r', ok: true, outcome: 'refused', reason: 'informational' }))
  refused.inbox.receive(deck, frame([ID]))
  expect(await refused.inbox.act(deck, { approval_id: ID, action: 'text', text: 'x' })).toEqual({ outcome: 'refused', reason: 'informational' })
  expect(refused.reports).toEqual([])

  const failed = service(async () => ({ requestId: 'r', ok: false, error: 'inbox_action_failed' }))
  failed.inbox.receive(deck, frame([ID]))
  expect(await failed.inbox.act(deck, { approval_id: ID, action: 'allow' })).toEqual({ outcome: 'failed' })
  const unreachable = service(async () => {
    throw new Error('Avatar Deck is not bound')
  })
  unreachable.inbox.receive(deck, frame([ID]))
  expect(await unreachable.inbox.act(deck, { approval_id: ID, action: 'allow' })).toEqual({ outcome: 'failed' })
  expect([failed.reports.length, unreachable.reports.length]).toEqual([1, 1])
})

test('a gesture on an id outside the box, or a second one in flight, never reaches the Deck', async () => {
  let release: (result: AvatarCommandResult) => void = () => {}
  const { inbox, sent } = service(() => new Promise((resolve) => (release = resolve)))
  expect(await inbox.act(deck, { approval_id: ID, action: 'allow' })).toEqual({ outcome: 'unknown' })
  inbox.receive(deck, frame([ID]))
  const first = inbox.act(deck, { approval_id: ID, action: 'allow' })
  expect(await reachedWithin(inbox.act(deck, { approval_id: ID, action: 'deny' }), 'second gesture answered at once', 500)).toEqual({
    outcome: 'busy'
  })
  release({ requestId: 'r', ok: true, outcome: 'won' })
  expect(await reachedWithin(first, 'first gesture settled', 500)).toEqual({ outcome: 'won' })
  expect(sent).toEqual([{ approval_id: ID, action: 'allow' }])
})

test('a read state is keyed by Deck, broker, scope generation, id and send date, so two boxes holding the same id and date never share it', () => {
  const sameRun = { deckRunId: deck.deckRunId, broker_url: 'http://127.0.0.1:7900' }
  const { inbox, sent } = service(idle)
  inbox.receive(deck, withMail([mail(1)]))
  inbox.receive(other, { ...withMail([mail(1)]), ...other })
  inbox.receive(sameRun, { ...withMail([mail(1)]), ...sameRun })
  expect(inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'seen')).toEqual({ read: 'seen' })
  expect(readsOf(inbox)).toEqual([avatarBubbleMessageKey(deck, 2, 1, SENT)])
  expect(readsOf(inbox, other)).toEqual([])
  expect(readsOf(inbox, sameRun)).toEqual([])
  expect(inbox.markRead(sameRun, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'acked')).toEqual({ read: 'acked' })
  expect(inbox.markRead(other, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'acked')).toEqual({ read: 'acked' })
  expect(inbox.boxes().map((box) => [box.identity.deckRunId, box.identity.broker_url, [...box.reads.values()]])).toEqual([
    ['deck-run-1', 'http://127.0.0.1:7899', ['seen']],
    ['deck-run-2', 'http://127.0.0.1:7899', ['acked']],
    ['deck-run-1', 'http://127.0.0.1:7900', ['acked']]
  ])
  expect(sent).toEqual([])
})

test('a read state survives a socket drop and a new snapshot of the same scope, acked is never lowered to seen, and nothing goes back to the Deck', () => {
  const { inbox, sent } = service(idle)
  inbox.receive(deck, withMail([mail(1)]))
  inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'seen')
  inbox.receive(deck, withMail([mail(1)], { seq: 2 }))
  expect([...inbox.boxes()[0]!.reads.values()]).toEqual(['seen'])
  inbox.clear(deck)
  expect(inbox.boxes()).toEqual([])
  inbox.receive(deck, withMail([mail(1)], { seq: 3 }))
  expect([...inbox.boxes()[0]!.reads.values()]).toEqual(['seen'])
  expect(inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'acked')).toEqual({ read: 'acked' })
  expect(inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'seen')).toEqual({ read: 'acked' })
  expect([...inbox.boxes()[0]!.reads.values()]).toEqual(['acked'])
  expect(sent).toEqual([])
})

test('a read state is purged on detach, on a scope generation change, and when the Avatar stops', () => {
  const { inbox, changes } = service(idle)
  inbox.receive(deck, withMail([mail(1)]))
  inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'seen')

  inbox.detach(deck)
  expect(readsOf(inbox)).toEqual([])
  inbox.receive(deck, withMail([mail(1)], { seq: 2 }))
  expect(readsOf(inbox)).toEqual([])

  inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'seen')
  inbox.receive(deck, withMail([mail(1)], { seq: 3, scope_generation: 3 }))
  expect(readsOf(inbox)).toEqual([])
  expect(inbox.markRead(deck, { scopeGeneration: 3, id: 1, sentAt: SENT }, 'seen')).toEqual({ read: 'seen' })
  inbox.receive(deck, withMail([mail(1)], { seq: 4, scope_generation: 2 }))
  expect(readsOf(inbox)).toEqual([])

  inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'seen')
  inbox.dispose()
  expect(readsOf(inbox)).toEqual([])

  const before = changes.count
  inbox.detach(deck)
  expect(changes.count).toBe(before)
  inbox.receive(deck, withMail([mail(1)], { seq: 5 }))
  inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'seen')
  const afterMark = changes.count
  inbox.detach(deck)
  expect(changes.count).toBe(afterMark + 1)
})

test('a gesture on a stale generation, an absent message or a Deck without a box is refused and stores nothing', () => {
  const { inbox } = service(idle)
  expect(inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'seen')).toEqual({ refused: 'no_box' })
  inbox.receive(deck, withMail([mail(1)]))
  expect(inbox.markRead(deck, { scopeGeneration: 1, id: 1, sentAt: SENT }, 'seen')).toEqual({ refused: 'stale_generation' })
  expect(inbox.markRead(deck, { scopeGeneration: 2, id: 2, sentAt: SENT }, 'seen')).toEqual({ refused: 'no_message' })
  expect(inbox.markRead(deck, { scopeGeneration: 2, id: 1, sentAt: '2026-11-17T09:00:00.000Z' }, 'seen')).toEqual({ refused: 'no_message' })
  expect(inbox.markRead(other, { scopeGeneration: 2, id: 1, sentAt: SENT }, 'seen')).toEqual({ refused: 'no_box' })
  expect(readsOf(inbox)).toEqual([])
})

test('read states per Deck are capped, the oldest touched leaving first', () => {
  const { inbox } = service(idle)
  const total = AVATAR_READ_CAP_PER_DECK + 5
  inbox.receive(deck, withMail(Array.from({ length: total }, (_, index) => mail(index + 1))))
  const mark = (id: number): unknown => inbox.markRead(deck, { scopeGeneration: 2, id, sentAt: SENT }, 'seen')
  for (let id = 1; id <= AVATAR_READ_CAP_PER_DECK; id += 1) mark(id)
  mark(1)
  for (let id = AVATAR_READ_CAP_PER_DECK + 1; id <= total; id += 1) mark(id)
  const kept = readsOf(inbox)
  expect(kept).toHaveLength(AVATAR_READ_CAP_PER_DECK)
  expect(kept).toContain(avatarBubbleMessageKey(deck, 2, 1, SENT))
  expect(kept).not.toContain(avatarBubbleMessageKey(deck, 2, 2, SENT))
  expect(kept).toContain(avatarBubbleMessageKey(deck, 2, total, SENT))
})
