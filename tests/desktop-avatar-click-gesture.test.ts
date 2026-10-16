import { expect, test } from 'bun:test'
import { createAvatarClickGesture, type AvatarClickGestureDeps } from '../desktop/src/main/avatar-click-gesture.ts'
import type { AvatarDeckIdentity, AvatarDeckStatus } from '../desktop/src/shared/avatar-state.ts'

const waiting = { deckRunId: 'run-b-waiting', broker_url: 'http://127.0.0.1:7899' }
const down = { deckRunId: 'run-a-down', broker_url: 'http://127.0.0.1:7900' }

function status(identity: AvatarDeckIdentity, counters: Partial<AvatarDeckStatus['counters']> = {}, torchOut = false): AvatarDeckStatus {
  return {
    identity,
    counters: { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0, ...counters },
    unread: 0,
    suspect: torchOut,
    brokerReachable: !torchOut,
    torchOut
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(decks: AvatarDeckStatus[], overrides: Partial<AvatarClickGestureDeps> = {}) {
  const sent: Array<[string, string]> = []
  const infos: string[] = []
  const reports: string[] = []
  const gesture = createAvatarClickGesture({
    decks: () => decks,
    attached: () => decks.map((deck) => deck.identity),
    send: async (identity, command) => {
      sent.push([identity.deckRunId, command])
    },
    info: (_scope, message) => infos.push(message),
    report: (_scope, message) => reports.push(message),
    ...overrides
  })
  return { gesture, sent, infos, reports }
}

test('a double-click sends open_question to the waiting Deck, not to the Deck shown in panne', async () => {
  const { gesture, sent, reports } = harness([status(down, {}, true), status(waiting, { waiting: 1 })])
  gesture('double')
  await flush()
  expect(sent).toEqual([['run-b-waiting', 'open_question']])
  expect(reports).toEqual([])
})

test('a double-click with no attached Deck waiting sends nothing and says why', async () => {
  const { gesture, sent, infos } = harness([status(down, { exited: 1 }, true)], {
    attached: () => [down]
  })
  gesture('double')
  await flush()
  expect(sent).toEqual([])
  expect(infos).toEqual(['Avatar double-click ignored because no attached Deck waits on the operator'])
})

test('a double-click ignores a waiting Deck that is not attached', async () => {
  const { gesture, sent } = harness([status(waiting, { waiting: 1 })], { attached: () => [] })
  gesture('double')
  await flush()
  expect(sent).toEqual([])
})

test('a single click keeps focusing the Deck of the global urgent face', async () => {
  const { gesture, sent } = harness([status(down, {}, true), status(waiting, { waiting: 1 })])
  gesture('single')
  await flush()
  expect(sent).toEqual([['run-a-down', 'focus']])
})

test('a single click with no urgent Deck sends nothing and says why', async () => {
  const { gesture, sent, infos } = harness([status(waiting, { working: 1 })])
  gesture('single')
  await flush()
  expect(sent).toEqual([])
  expect(infos).toEqual(['Avatar click ignored because no attached Deck produces an urgent face'])
})

test('a failed send is reported, never thrown at the gesture', async () => {
  const { gesture, reports } = harness([status(waiting, { waiting: 1 })], {
    send: () => Promise.reject(new Error('server stopped'))
  })
  gesture('double')
  gesture('single')
  await flush()
  expect(reports).toEqual([
    'Avatar double-click open question gesture failed',
    'Avatar click focus gesture failed'
  ])
})
