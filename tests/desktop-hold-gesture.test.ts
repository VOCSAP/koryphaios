// PLAN MB4: hold-then-move gesture machine (the floating-basket grammar,
// EXPLORATION §4). Pure state transitions — no DOM.

import { test, expect } from 'bun:test'
import { HoldGesture, DEFAULT_HOLD_GESTURE } from '../desktop/src/shared/hold-gesture.ts'

const H = DEFAULT_HOLD_GESTURE.holdMs

test('quick move before hold = cancel (it was a scroll)', () => {
  const g = new HoldGesture()
  g.down(0, 0, 0)
  expect(g.move(0, 40, 50)).toBe('cancel')
})

test('hold then release without moving = options', () => {
  const g = new HoldGesture()
  g.down(0, 0, 0)
  expect(g.tick(H + 1)).toBe('seized')
  expect(g.up(H + 200)).toBe('options')
})

test('hold then move past slop = detach', () => {
  const g = new HoldGesture()
  g.down(0, 0, 0)
  expect(g.tick(H + 1)).toBe('seized')
  expect(g.move(30, 0, H + 100)).toBe('detach')
})

test('tiny wobble while held stays put', () => {
  const g = new HoldGesture()
  g.down(0, 0, 0)
  g.tick(H + 1)
  expect(g.move(2, 2, H + 50)).toBe('none')
})

test('slow finger that already passed the hold delay seizes on move', () => {
  const g = new HoldGesture()
  g.down(0, 0, 0)
  // No explicit tick; the move itself happens after the hold window.
  expect(g.move(30, 0, H + 5)).toBe('seized')
})

test('release before hold delay = cancel', () => {
  const g = new HoldGesture()
  g.down(0, 0, 0)
  expect(g.up(H - 100)).toBe('cancel')
})

test('cancel resets an active press', () => {
  const g = new HoldGesture()
  g.down(0, 0, 0)
  expect(g.cancel()).toBe('cancel')
  expect(g.current).toBe('idle')
})
