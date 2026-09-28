import { expect, test } from 'bun:test'
import {
  AVATAR_HEARTBEAT_MS,
  AVATAR_SUSPECT_AFTER_MS,
  AvatarState,
  type AvatarDeckIdentity,
  type AvatarDeckSnapshot
} from '../desktop/src/shared/avatar-state.ts'

function identity(deckRunId: string, broker_url = 'http://broker.example:7899'): AvatarDeckIdentity {
  return { deckRunId, broker_url }
}

function snapshot(
  deckRunId: string,
  counters: Partial<AvatarDeckSnapshot['counters']> = {},
  broker_url?: string
): AvatarDeckSnapshot {
  return {
    identity: identity(deckRunId, broker_url),
    counters: { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0, ...counters },
    unread: 0
  }
}

test('derives the named heartbeat and suspect timing defaults', () => {
  const state = new AvatarState({ now: () => 0 })

  expect(AVATAR_HEARTBEAT_MS).toBe(5_000)
  expect(AVATAR_SUSPECT_AFTER_MS).toBe(15_000)
  expect(state.timing).toEqual({ heartbeatMs: 5_000, suspectAfterMs: 15_000 })
})

test('retains counters and makes a silent Deck suspect without removing it', () => {
  let now = 0
  const state = new AvatarState({ now: () => now })
  state.receiveSnapshot(snapshot('run-a', { working: 2, waiting: 1 }))

  now = AVATAR_SUSPECT_AFTER_MS
  const summary = state.summary()

  expect(summary.face).toBe('panne')
  expect(summary.counters).toMatchObject({ working: 2, waiting: 1 })
  expect(summary.decks).toEqual([
    expect.objectContaining({ identity: identity('run-a'), suspect: true, torchOut: true })
  ])
})

test('a valid snapshot restores freshness and preserves priority ordering', () => {
  let now = 0
  const state = new AvatarState({ now: () => now })
  state.receiveSnapshot(snapshot('run-a', { waiting: 1, working: 1 }))
  expect(state.summary().face).toBe('reclame')

  state.receiveSnapshot({ ...snapshot('run-a', { rateLimited: 1 }), unread: 3 })
  expect(state.summary().face).toBe('perdu')

  state.receiveSnapshot({ ...snapshot('run-a'), unread: 3 })
  expect(state.summary().face).toBe('courrier')

  state.receiveSnapshot(snapshot('run-a', { working: 1 }))
  expect(state.summary().face).toBe('travaille')

  state.receiveSnapshot(snapshot('run-a'))
  expect(state.summary().face).toBe('endormi')

  now = AVATAR_SUSPECT_AFTER_MS
  expect(state.summary().face).toBe('panne')

  state.receiveSnapshot(snapshot('run-a', { working: 1 }))
  expect(state.summary().face).toBe('travaille')
})

test('keeps broker failures independent from state heartbeats', () => {
  const state = new AvatarState({ now: () => 0 })
  state.receiveSnapshot(snapshot('run-a', { working: 1 }))
  state.setBrokerReachable('http://broker.example:7899', false)
  state.receiveSnapshot(snapshot('run-a', { working: 1 }))

  expect(state.summary()).toMatchObject({
    face: 'panne',
    decks: [expect.objectContaining({ suspect: false, torchOut: true, brokerReachable: false })]
  })

  state.setBrokerReachable('http://broker.example:7899', true)
  expect(state.summary()).toMatchObject({
    face: 'travaille',
    decks: [expect.objectContaining({ suspect: false, torchOut: false, brokerReachable: true })]
  })
})

test('keys Decks by both run and broker and removes only the matching identity', () => {
  const state = new AvatarState({ now: () => 0 })
  const firstBroker = 'http://broker-one.example:7899'
  const secondBroker = 'http://broker-two.example:7899'
  state.receiveSnapshot(snapshot('run-a', { working: 1 }, firstBroker))
  state.receiveSnapshot(snapshot('run-a', { idle: 1 }, secondBroker))

  expect(state.summary().decks).toHaveLength(2)
  expect(state.removeDeadDeck(identity('run-a', firstBroker), false)).toBe(false)
  expect(state.summary().decks).toHaveLength(2)

  state.detach(identity('run-a', firstBroker))
  expect(state.summary().decks).toEqual([expect.objectContaining({ identity: identity('run-a', secondBroker) })])

  expect(state.removeDeadDeck(identity('run-a', secondBroker), true)).toBe(true)
  expect(state.summary()).toMatchObject({ face: 'seul', decks: [] })
})

test('scopes broker failure to its Deck and aggregates every Deck contribution', () => {
  const state = new AvatarState({ now: () => 0 })
  const failedBroker = 'http://broker-failed.example:7899'
  const healthyBroker = 'http://broker-healthy.example:7899'
  state.receiveSnapshot({ ...snapshot('run-a', { working: 2, unknown: 1 }, failedBroker), unread: 3 })
  state.receiveSnapshot({ ...snapshot('run-b', { idle: 4, waiting: 1 }, healthyBroker), unread: 5 })
  state.setBrokerReachable(failedBroker, false)

  const summary = state.summary()
  expect(summary.face).toBe('panne')
  expect(summary.counters).toEqual({ working: 2, idle: 4, unknown: 1, waiting: 1, exited: 0, rateLimited: 0 })
  expect(summary.unread).toBe(8)
  expect(summary.decks).toEqual(expect.arrayContaining([
    expect.objectContaining({ identity: identity('run-a', failedBroker), brokerReachable: false, torchOut: true }),
    expect.objectContaining({ identity: identity('run-b', healthyBroker), brokerReachable: true, torchOut: false })
  ]))
})

test('prioritizes waiting work over failed, unread, and active counts', () => {
  const state = new AvatarState({ now: () => 0 })
  state.receiveSnapshot({
    ...snapshot('run-a', { working: 1, waiting: 1, exited: 1, rateLimited: 1 }),
    unread: 1
  })

  expect(state.summary().face).toBe('reclame')
})
