import { expect, test } from 'bun:test'
import { createAvatarBootstrap } from '../desktop/src/main/avatar-bootstrap.ts'

const appearance = {
  version: 1 as const,
  visible: true,
  alwaysOnTop: true,
  positionLocked: false,
  size: 'm' as const,
  idleOpacity: 1,
  motion: 'continuous' as const,
  dndUntil: null,
  dndChoice: null,
  positions: {}
}

function publication(revision: number) {
  return { revision, generation: null, appearance, position: null }
}

test('connects AvatarState attachment, broker state, suspicion and detach to the projection', () => {
  let now = 1_000
  const bootstrap = createAvatarBootstrap({ theme: 'dark', now: () => now })
  const identity = { deckRunId: 'deck-1', broker_url: 'https://broker.test' }

  bootstrap.state.receiveSnapshot({
    identity,
    counters: { working: 1, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
    unread: 0
  })
  expect(bootstrap.presentation.project(publication(1)).summary.face).toBe('travaille')
  bootstrap.state.setBrokerReachable(identity.broker_url, false)
  expect(bootstrap.presentation.project(publication(2)).summary.decks[0]).toMatchObject({ brokerReachable: false, torchOut: true })
  now += 15_000
  expect(bootstrap.presentation.project(publication(3)).summary.decks[0]).toMatchObject({ suspect: true, torchOut: true })
  bootstrap.state.detach(identity)
  expect(bootstrap.presentation.project(publication(4)).summary).toMatchObject({ face: 'seul', decks: [], counters: { working: 0 } })
})
