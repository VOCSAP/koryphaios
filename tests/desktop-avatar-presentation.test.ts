import { expect, test } from 'bun:test'
import { createAvatarPresentation } from '../desktop/src/main/avatar-presentation.ts'
import { AvatarState } from '../desktop/src/shared/avatar-state.ts'

const now = new Date(2026, 4, 14, 10, 30).getTime()

test('publishes one projected summary to the Tray reader and current window sink', () => {
  const state = new AvatarState({ now: () => now })
  state.receiveSnapshot({
    identity: { deckRunId: 'deck-1', broker_url: 'https://broker.test' },
    counters: { working: 1, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
    unread: 0
  })
  const envelopes: unknown[] = []
  const presentation = createAvatarPresentation({
    state,
    appearance: {
      version: 1,
      visible: true,
      alwaysOnTop: true,
      positionLocked: false,
      size: 'm',
      idleOpacity: 1,
      motion: 'continuous',
      dndUntil: null,
      dndChoice: null,
      positions: {}
    },
    theme: 'dark',
    send: (envelope) => envelopes.push(envelope)
  })

  const traySummary = presentation.summaryForTray()

  expect(traySummary).toEqual({
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
  })
  expect(envelopes).toEqual([{ generation: 0, revision: 1, summary: traySummary, presentation: expect.objectContaining({ motion: 'continuous', dndActive: false }) }])
})

test('retains the summary while an absolute DND deadline expires', () => {
  let currentNow = now
  const state = new AvatarState({ now: () => currentNow })
  const presentation = createAvatarPresentation({
    state,
    appearance: {
      version: 1,
      visible: true,
      alwaysOnTop: true,
      positionLocked: false,
      size: 'm',
      idleOpacity: 1,
      motion: 'continuous',
      dndUntil: now + 1_000,
      dndChoice: '30m',
      positions: {}
    },
    now: () => currentNow,
    theme: 'dark',
    send: () => {}
  })

  expect(presentation.summaryForTray().face).toBe('seul')
  expect(presentation.getState().presentation.dndActive).toBe(true)
  currentNow += 1_000
  expect(presentation.getState().presentation.dndActive).toBe(false)
  expect(presentation.getState().summary.face).toBe('seul')
  presentation.setTheme('light')
  expect(presentation.getState().presentation.theme).toBe('light')
})
