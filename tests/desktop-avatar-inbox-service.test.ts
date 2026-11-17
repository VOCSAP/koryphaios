import { expect, test } from 'bun:test'
import { createAvatarInboxService } from '../desktop/src/main/avatar-inbox-service.ts'
import { reachedWithin } from './_bounded-await.ts'
import type { AvatarCommandResult } from '../desktop/src/main/avatar-server.ts'
import type { AvatarInboxAction, AvatarInboxSnapshotFrame } from '../desktop/src/shared/avatar-inbox-protocol.ts'

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
  const inbox = createAvatarInboxService({
    send: (identity, action) => {
      sent.push(action)
      return send(identity, action)
    },
    report: (_scope, message) => reports.push(message)
  })
  return { inbox, reports, sent }
}

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
