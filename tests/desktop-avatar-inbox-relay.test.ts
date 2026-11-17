import { expect, test } from 'bun:test'
import {
  approvalTileName,
  createInboxActionHandler,
  createInboxPusher,
  createStampedReader,
  INBOX_PUSH_INTERVAL_MS,
  relayInboxMessages,
  type InboxRelaySourcesInput
} from '../desktop/src/main/avatar-inbox-relay.ts'
import { BrokerHttpError, type ApprovalDeps } from '../desktop/src/main/approval-service.ts'
import type { Approval } from '../desktop/src/shared/types.ts'
import { inboxActionAllowed, type InboxRelayApproval } from '../desktop/src/shared/avatar-inbox-protocol.ts'

const identity = { deckRunId: 'deck-run-1', broker_url: 'http://127.0.0.1:7899' }
const ID = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'

function approval(id: string, title = 'Proceed?'): Approval {
  return {
    id,
    operator_id: 'op',
    origin: { host: 'h', os_user_hash: 'x', project_key: 'p', group_id: 'g', from_peer: 'peer-a', session_ref: 's', tile_ref: 'tile-1' },
    kind: 'question',
    title,
    question: 'q',
    options: [],
    status: 'pending',
    reply_route: 'channel',
    mergeable: false,
    absorbed_permission: false,
    informational: false,
    answered_via: null,
    answer_kind: null,
    answer_text: null,
    questions: null,
    answers: null,
    created_at: '2026-11-17T08:00:00.000Z',
    notif_expires_at: '2026-11-17T09:00:00.000Z',
    answered_at: null,
    delivered_at: null
  }
}

function harness(initial: Approval[] = [approval(ID)]) {
  let clock = 1_000
  let current: InboxRelaySourcesInput = { approvals: initial, messages: [], closed: [], tileName: () => null }
  const sent: Array<Record<string, any>> = []
  const timers: Array<{ at: number; fire: () => void; cancelled: boolean }> = []
  const reports: string[] = []
  let failSend = false
  const pusher = createInboxPusher({
    identity,
    scopeGeneration: 4,
    sources: () => current,
    send: (text) => {
      if (failSend) throw new Error('socket gone')
      sent.push(JSON.parse(text))
    },
    after: (ms, fire) => {
      const timer = { at: clock + ms, fire, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    now: () => clock,
    report: (_scope, message) => reports.push(message)
  })
  return {
    pusher,
    sent,
    reports,
    set(next: Approval[]) {
      current = { ...current, approvals: next }
    },
    advance(ms: number) {
      clock += ms
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue
        if (timer.at <= clock) timer.fire()
        else timers.push(timer)
      }
    },
    failSend(value: boolean) {
      failSend = value
    }
  }
}

test('the first snapshot leaves at once with seq 1, the generation and the Deck identity', () => {
  const h = harness()
  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]).toMatchObject({ type: 'inbox_snapshot', seq: 1, scope_generation: 4, ...identity })
  expect([...h.pusher.sentApprovals().keys()]).toEqual([ID])
})

test('changes inside the push window coalesce into one frame carrying the latest state', () => {
  const h = harness()
  h.set([approval(ID), approval(OTHER)])
  h.pusher.changed()
  h.set([approval(OTHER)])
  h.pusher.changed()
  expect(h.sent, 'nothing before the window closes').toHaveLength(1)
  h.advance(INBOX_PUSH_INTERVAL_MS)
  expect(h.sent).toHaveLength(2)
  expect(h.sent[1]!.seq).toBe(2)
  expect(h.sent[1]!.approvals.map((a: { id: string }) => a.id)).toEqual([OTHER])
  expect([...h.pusher.sentApprovals().keys()]).toEqual([OTHER])
})

test('an unchanged state sends nothing, and a stopped pusher sends nothing more', () => {
  const h = harness()
  h.advance(INBOX_PUSH_INTERVAL_MS)
  h.pusher.changed()
  expect(h.sent).toHaveLength(1)
  h.set([approval(OTHER)])
  h.pusher.changed()
  expect(h.sent).toHaveLength(2)
  h.set([approval(ID)])
  h.pusher.changed()
  h.pusher.stop()
  h.advance(INBOX_PUSH_INTERVAL_MS)
  expect(h.sent, 'the frame scheduled before stop never leaves').toHaveLength(2)
})

test('a failed send is traced once and retried on the next change', () => {
  const h = harness()
  h.failSend(true)
  h.set([approval(OTHER)])
  h.advance(INBOX_PUSH_INTERVAL_MS)
  h.pusher.changed()
  h.advance(INBOX_PUSH_INTERVAL_MS)
  h.pusher.changed()
  expect(h.reports).toEqual(['the inbox snapshot could not be built or sent to the Avatar'])
  h.failSend(false)
  h.advance(INBOX_PUSH_INTERVAL_MS)
  h.pusher.changed()
  expect(h.sent.map((f) => f.seq)).toEqual([1, 2])
})

const deps = { projectKey: 'p' } as unknown as ApprovalDeps

function handler(answer: (call: { kind: string; args: unknown }) => Promise<Approval | null>) {
  const calls: Array<{ kind: string; args: unknown }> = []
  const act = createInboxActionHandler({
    approvalDeps: () => deps,
    claim: ((_deps: ApprovalDeps, args: unknown) => {
      const call = { kind: 'claim', args }
      calls.push(call)
      return answer(call)
    }) as never,
    ack: ((_deps: ApprovalDeps, id: string, via: string) => {
      const call = { kind: 'ack', args: { id, via } }
      calls.push(call)
      return answer(call)
    }) as never
  })
  return { act, calls }
}

function relayed(overrides: Partial<InboxRelayApproval> = {}): InboxRelayApproval {
  return {
    id: ID,
    kind: 'question',
    status: 'pending',
    informational: false,
    reply_route: 'channel',
    mergeable: false,
    absorbed_permission: false,
    title: 'Proceed?',
    question: 'q',
    options: [],
    questions: [{ question: 'Which?', header: '', options: [{ label: 'One', description: '' }], multi_select: false }],
    created_at: '2026-11-17T08:00:00.000Z',
    from_peer_id: 'peer-a',
    tile_name: null,
    ...overrides
  }
}

const sentIds = new Map([[ID, relayed()]])

test('a cut approval takes only deny or acknowledge, before any broker call', async () => {
  const { act, calls } = handler(async () => approval(ID))
  const cut = new Map([[ID, relayed({ cut: true })]])
  for (const action of [
    { approval_id: ID, action: 'allow' as const },
    { approval_id: ID, action: 'text' as const, text: 'go' },
    { approval_id: ID, action: 'answers' as const, answers: { 'Which?': ['One'] } }
  ]) {
    expect(await act(action, cut), action.action).toEqual({ error: 'action_not_allowed' })
  }
  expect(calls).toEqual([])
  expect(await act({ approval_id: ID, action: 'deny' }, cut)).toEqual({ outcome: 'won' })
  expect(await act({ approval_id: ID, action: 'acknowledge' }, cut)).toEqual({ outcome: 'won' })
})

test('the Deck refuses a gesture the relayed kind does not offer', () => {
  expect(inboxActionAllowed(relayed({ informational: true }), 'allow')).toBe(false)
  expect(inboxActionAllowed(relayed({ informational: true }), 'text')).toBe(false)
  expect(inboxActionAllowed(relayed({ informational: true }), 'acknowledge')).toBe(true)
  expect(inboxActionAllowed(relayed({ kind: 'permission' }), 'text')).toBe(false)
  expect(inboxActionAllowed(relayed({ kind: 'permission' }), 'acknowledge')).toBe(false)
  expect(inboxActionAllowed(relayed({ kind: 'permission' }), 'allow')).toBe(true)
  expect(inboxActionAllowed(relayed({ questions: null }), 'answers')).toBe(false)
  expect(inboxActionAllowed(relayed({ absorbed_permission: true }), 'deny')).toBe(false)
  expect(inboxActionAllowed(relayed({ mergeable: true }), 'acknowledge')).toBe(false)
  expect(inboxActionAllowed(relayed({ reply_route: 'pty' }), 'acknowledge')).toBe(false)
})

test('a source that throws is traced instead of escaping the push', () => {
  const reports: string[] = []
  const sent: string[] = []
  expect(() =>
    createInboxPusher({
      identity,
      scopeGeneration: 1,
      sources: () => {
        throw new Error('journal unreadable')
      },
      send: (text) => sent.push(text),
      after: () => () => undefined,
      now: () => 0,
      report: (_scope, message) => reports.push(message)
    })
  ).not.toThrow()
  expect([sent, reports]).toEqual([[], ['the inbox snapshot could not be built or sent to the Avatar']])
})

test('the relayed journal is read again only when its stamp changes', () => {
  let stamp = 'a'
  let reads = 0
  const read = createStampedReader(
    () => stamp,
    () => {
      reads += 1
      return reads
    }
  )
  expect([read(), read(), read()]).toEqual([1, 1, 1])
  stamp = 'b'
  expect(read()).toBe(2)
  expect(reads).toBe(2)
})

test('every gesture is settled as answered via avatar', async () => {
  const { act, calls } = handler(async () => approval(ID))
  expect(await act({ approval_id: ID, action: 'allow' }, sentIds)).toEqual({ outcome: 'won' })
  await act({ approval_id: ID, action: 'deny' }, sentIds)
  await act({ approval_id: ID, action: 'text', text: 'go' }, sentIds)
  await act({ approval_id: ID, action: 'answers', answers: { 'Which?': ['One'] } }, sentIds)
  await act({ approval_id: ID, action: 'acknowledge' }, sentIds)
  expect(calls).toEqual([
    { kind: 'claim', args: { id: ID, via: 'avatar', answerKind: 'allow' } },
    { kind: 'claim', args: { id: ID, via: 'avatar', answerKind: 'deny' } },
    { kind: 'claim', args: { id: ID, via: 'avatar', answerKind: 'text', answerText: 'go' } },
    { kind: 'claim', args: { id: ID, via: 'avatar', answerKind: 'answers', answers: { 'Which?': ['One'] } } },
    { kind: 'ack', args: { id: ID, via: 'avatar' } }
  ])
})

test('an approval missing from the snapshot sent to this socket is refused before any broker call', async () => {
  const { act, calls } = handler(async () => approval(OTHER))
  expect(await act({ approval_id: OTHER, action: 'allow' }, sentIds)).toEqual({ error: 'unknown_approval' })
  expect(calls).toEqual([])
})

test('a lost race reads as lost, a 410 or 422 as refused with its reason, anything else is thrown', async () => {
  expect(await handler(async () => null).act({ approval_id: ID, action: 'allow' }, sentIds)).toEqual({ outcome: 'lost' })
  const reason = 'informational: acknowledge it, it takes no answer'
  for (const status of [410, 422]) {
    const refused = handler(async () => {
      throw new BrokerHttpError('/approval/claim', status, reason)
    })
    expect(await refused.act({ approval_id: ID, action: 'text', text: 'x' }, sentIds)).toEqual({ outcome: 'refused', reason })
  }
  const broken = handler(async () => {
    throw new BrokerHttpError('/approval/claim', 500, 'boom')
  })
  await expect(broken.act({ approval_id: ID, action: 'allow' }, sentIds)).rejects.toBeInstanceOf(BrokerHttpError)
})

test('one gesture per approval runs at a time', async () => {
  let release: (value: Approval | null) => void = () => {}
  let held = true
  const { act, calls } = handler(() => {
    if (!held) return Promise.resolve(approval(ID))
    held = false
    return new Promise((resolve) => (release = resolve))
  })
  const first = act({ approval_id: ID, action: 'allow' }, sentIds)
  expect(await act({ approval_id: ID, action: 'deny' }, sentIds)).toEqual({ error: 'busy' })
  release(approval(ID))
  expect(await first).toEqual({ outcome: 'won' })
  expect(calls).toHaveLength(1)
  expect(await act({ approval_id: ID, action: 'deny' }, sentIds)).toEqual({ outcome: 'won' })
})

test('malformed answers and a Deck without approvals are refused without a broker call', async () => {
  const { act, calls } = handler(async () => approval(ID))
  expect(await act({ approval_id: ID, action: 'answers', answers: { 'Which?': 'One' } as never }, sentIds)).toEqual({ error: 'invalid_inbox_action' })
  const offline = createInboxActionHandler({ approvalDeps: () => null, claim: (() => Promise.resolve(null)) as never })
  expect(await offline({ approval_id: ID, action: 'allow' }, sentIds)).toEqual({ error: 'unavailable' })
  expect(calls).toEqual([])
})

test('Courrier messages are deduplicated by broker id and carry their run state', () => {
  const a = { id: 1, from: 'p', text: 'one', sentAt: '2026-11-17T07:00:01.000Z' }
  const b = { id: 2, from: 'p', text: 'two', sentAt: '2026-11-17T07:00:02.000Z' }
  const closed = { state: 'closed' as const, settledAt: '2026-11-17T08:00:00.000Z' }
  expect(relayInboxMessages([a, b], [b], { [`msg:${b.sentAt}:${b.id}`]: closed })).toEqual([
    { message: a, entry: undefined },
    { message: b, entry: closed }
  ])
})

test('an approval names the Deck tile it was raised from, or none', () => {
  const sessions = [{ id: 'tile-1', name: 'Builder' }]
  expect(approvalTileName(approval(ID), sessions)).toBe('Builder')
  expect(approvalTileName(approval(ID), [])).toBeNull()
})
