import { expect, test } from 'bun:test'
import type { AvatarAppearance } from '../desktop/src/main/avatar-appearance.ts'
import { createAvatarPresentation } from '../desktop/src/main/avatar-presentation.ts'
import type { AvatarPublication } from '../desktop/src/main/avatar-window-state.ts'
import { AvatarState } from '../desktop/src/shared/avatar-state.ts'

const now = new Date(2026, 4, 14, 10, 30).getTime()

function appearance(patch: Partial<AvatarAppearance> = {}): AvatarAppearance {
  return {
    version: 1,
    visible: true,
    alwaysOnTop: true,
    positionLocked: false,
    size: 'm',
    idleOpacity: 1,
    motion: 'continuous',
    dndUntil: null,
    dndChoice: null,
    positions: {},
    ...patch
  }
}

function publication(patch: Partial<AvatarPublication> = {}): AvatarPublication {
  return { revision: 1, generation: null, appearance: appearance(), position: null, ...patch }
}

test('projects one summary and the machine snapshot into a view state', () => {
  const state = new AvatarState({ now: () => now })
  state.receiveSnapshot({
    identity: { deckRunId: 'deck-1', broker_url: 'https://broker.test' },
    counters: { working: 1, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
    unread: 0
  })
  const presentation = createAvatarPresentation({ state, theme: 'dark' })

  const view = presentation.project(
    publication({
      revision: 5,
      generation: 3,
      appearance: appearance({ visible: false, positionLocked: true, size: 'l', idleOpacity: 0.5, motion: 'none' }),
      position: { screenId: '1', workArea: { x: 0, y: 0, width: 1000, height: 800 }, x: 10, y: 20 }
    })
  )

  expect(view).toEqual({
    generation: 3,
    revision: 5,
    summary: {
      face: 'travaille',
      counters: { working: 1, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
      unread: 0,
      decks: [{
        identity: { deckRunId: 'deck-1', broker_url: 'https://broker.test' },
        counters: { working: 1, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
        unread: 0,
        suspect: false,
        brokerReachable: true,
        torchOut: false
      }]
    },
    presentation: {
      position: { x: 10, y: 20 },
      theme: 'dark',
      motion: 'none',
      dndActive: false,
      visible: false,
      alwaysOnTop: true,
      positionLocked: true,
      size: 'l',
      idleOpacity: 0.5
    }
  })
})

test('takes visibility, lock and position from the snapshot it is given, never from an earlier call', () => {
  const presentation = createAvatarPresentation({ state: new AvatarState({ now: () => now }), theme: 'dark' })

  expect(presentation.project(publication({ appearance: appearance({ visible: false }) })).presentation.visible).toBe(false)
  expect(presentation.project(publication({ appearance: appearance({ visible: true }) })).presentation.visible).toBe(true)
  expect(presentation.project(publication()).presentation.position).toBeNull()
  expect(presentation.project(publication()).generation).toBe(0)
})

test('retains the summary while an absolute DND deadline expires', () => {
  let currentNow = now
  const state = new AvatarState({ now: () => currentNow })
  const presentation = createAvatarPresentation({ state, now: () => currentNow, theme: 'dark' })
  const snapshot = publication({ appearance: appearance({ dndUntil: now + 1_000, dndChoice: '30m' }) })

  expect(presentation.project(snapshot).summary.face).toBe('seul')
  expect(presentation.project(snapshot).presentation.dndActive).toBe(true)
  currentNow += 1_000
  expect(presentation.project(snapshot).presentation.dndActive).toBe(false)
  expect(presentation.project(snapshot).summary.face).toBe('seul')
  presentation.setTheme('light')
  expect(presentation.project(snapshot).presentation.theme).toBe('light')
})
