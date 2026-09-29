import { expect, test } from 'bun:test'
import {
  createDeckFocusGesture,
  deckProcessIsAlive,
  type DeckFocusGestureDeps
} from '../desktop/src/main/avatar-focus-gesture.ts'
import type { AvatarCommandResult } from '../desktop/src/main/avatar-server.ts'

const deck = {
  protocol_version: 1,
  deckRunId: 'deck-run-1',
  deckPid: 4242,
  broker_url: 'http://127.0.0.1:7899',
  projectDir: 'C:/work/example',
  deckName: 'Example'
}
const identity = { deckRunId: deck.deckRunId, broker_url: deck.broker_url }

function settledWithin<T>(promise: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`the focus gesture was still pending after ${ms} ms`)
    })
  ])
}

function harness(overrides: Partial<DeckFocusGestureDeps> = {}) {
  const calls: string[] = []
  const reports: string[] = []
  const infos: string[] = []
  const gesture = createDeckFocusGesture({
    platform: 'win32',
    attachedDecks: () => [deck],
    isAlive: () => true,
    isDeckBound: () => true,
    allowForeground: async (pid) => {
      calls.push(`allow:${pid}`)
      return true
    },
    focusDeck: async (target) => {
      calls.push(`focus:${target.deckRunId}`)
      return { requestId: 'request-1', ok: true }
    },
    report: (_scope, message) => reports.push(message),
    info: (_scope, message) => infos.push(message),
    ...overrides
  })
  return { gesture, calls, reports, infos }
}

test('cedes the foreground to the Deck pid before sending the focus command', async () => {
  const { gesture, calls, reports, infos } = harness()
  await gesture(identity)
  expect(calls).toEqual(['allow:4242', 'focus:deck-run-1'])
  expect(reports).toEqual([])
  expect(infos).toEqual(['Deck deck-run-1 brought to front'])
})

test('refuses and traces a Deck detached since the menu was built', async () => {
  const { gesture, calls, reports } = harness({ attachedDecks: () => [] })
  await gesture(identity)
  expect(calls).toEqual([])
  expect(reports).toEqual(['refused to focus Deck deck-run-1: it is no longer attached'])
})

test('never focuses another attached Deck in place of the one clicked', async () => {
  const other = { ...deck, deckRunId: 'deck-run-2', deckPid: 5151 }
  const { gesture, calls, reports } = harness({ attachedDecks: () => [other] })
  await gesture(identity)
  expect(calls).toEqual([])
  expect(reports).toEqual(['refused to focus Deck deck-run-1: it is no longer attached'])
})

test('refuses and traces a Deck whose process is not alive', async () => {
  const { gesture, calls, reports } = harness({ isAlive: () => false })
  await gesture(identity)
  expect(calls).toEqual([])
  expect(reports).toEqual(['refused to focus Deck deck-run-1: its process 4242 is not alive'])
})

test('refuses and traces an unbound Deck before ceding anything', async () => {
  const { gesture, calls, reports } = harness({ isDeckBound: () => false })
  await gesture(identity)
  expect(calls).toEqual([])
  expect(reports).toEqual(['refused to focus Deck deck-run-1: it is not bound to the Avatar'])
})

test('refuses and traces a second click while a focus is in flight, then accepts the next one', async () => {
  let finish: (result: AvatarCommandResult) => void = () => undefined
  let focusCalls = 0
  const { gesture, reports } = harness({
    focusDeck: () => {
      focusCalls += 1
      return new Promise((resolve) => {
        finish = resolve
      })
    }
  })
  const first = gesture(identity)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settledWithin(gesture(identity))
  expect(focusCalls).toBe(1)
  expect(reports).toEqual(['refused to focus Deck deck-run-1: a focus is already in flight'])
  finish({ requestId: 'request-1', ok: true })
  await settledWithin(first)
  const third = gesture(identity)
  await new Promise((resolve) => setTimeout(resolve, 0))
  finish({ requestId: 'request-2', ok: true })
  await settledWithin(third)
  expect(focusCalls).toBe(2)
})

test('does not cede the foreground outside Windows but still sends the focus', async () => {
  const { gesture, calls } = harness({ platform: 'darwin' })
  await gesture(identity)
  expect(calls).toEqual(['focus:deck-run-1'])
})

test('traces a failed cession and still sends the focus', async () => {
  const calls: string[] = []
  const { gesture, reports } = harness({
    allowForeground: async () => false,
    focusDeck: async () => {
      calls.push('focus')
      return { requestId: 'request-1', ok: true }
    }
  })
  await gesture(identity)
  expect(calls).toEqual(['focus'])
  expect(reports).toEqual(['could not cede the foreground to Deck deck-run-1; its window may only flash'])
})

test('traces a refused or failed focus, never as a success', async () => {
  const refused = harness({ focusDeck: async () => ({ requestId: 'request-1', ok: false, error: 'focus_failed' }) })
  await refused.gesture(identity)
  expect(refused.reports).toEqual(['Deck deck-run-1 refused the focus: focus_failed'])
  expect(refused.infos).toEqual([])

  const failed = harness({ focusDeck: () => Promise.reject(new Error('Avatar command result timed out')) })
  await failed.gesture(identity)
  expect(failed.reports).toEqual(['focus of Deck deck-run-1 failed'])
  expect(failed.infos).toEqual([])
})

test('a process is alive only when this user may signal it', () => {
  expect(deckProcessIsAlive(process.pid)).toBe(true)
  expect(deckProcessIsAlive(0x7fff_fff0)).toBe(false)
})
