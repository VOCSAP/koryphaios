import { expect, test } from 'bun:test'
import {
  canReplaceDeckNotifications,
  shouldSuppressDeckNotification,
  type AvatarNotificationAvailability,
  type AvatarNotificationObservation
} from '../desktop/src/main/avatar-notification-policy.ts'

const READY: AvatarNotificationAvailability = { serviceReady: true, maskReady: true, maskVisible: true, rendererAlive: true, dndActive: false }

test('the Avatar replaces the Deck notifications only when every condition holds, each one on its own', () => {
  expect(canReplaceDeckNotifications(READY, true)).toBe(true)
  for (const condition of ['serviceReady', 'maskReady', 'maskVisible', 'rendererAlive'] as const) {
    expect(canReplaceDeckNotifications({ ...READY, [condition]: false }, true), condition).toBe(false)
  }
  expect(canReplaceDeckNotifications({ ...READY, dndActive: true }, true), 'dndActive').toBe(false)
  expect(canReplaceDeckNotifications(READY, false), 'a ready service with no valid projection').toBe(false)
})

test('a truthy value is not a yes: the booleans must be strict', () => {
  const loose = (patch: Record<string, unknown>) => ({ ...READY, ...patch }) as unknown as AvatarNotificationAvailability
  for (const condition of ['serviceReady', 'maskReady', 'maskVisible', 'rendererAlive']) {
    expect(canReplaceDeckNotifications(loose({ [condition]: 1 }), true), condition).toBe(false)
  }
  expect(canReplaceDeckNotifications(loose({ dndActive: 0 }), true), 'a falsy dndActive is not a strict false').toBe(false)
  expect(canReplaceDeckNotifications(READY, 1 as unknown as boolean)).toBe(false)
})

const OBSERVED: AvatarNotificationObservation = {
  negotiated: true,
  bound: true,
  currentContext: true,
  status: { replace: true, receivedAt: 1_000, leaseMs: 15_000 }
}

test('a Deck notification is suppressed only inside the 15000 ms lease, boundaries included', () => {
  expect(shouldSuppressDeckNotification(OBSERVED, 1_000), 'at the instant of reception').toBe(true)
  expect(shouldSuppressDeckNotification(OBSERVED, 1_000 + 14_999)).toBe(true)
  expect(shouldSuppressDeckNotification(OBSERVED, 1_000 + 15_000), 'a lease at its full length is over').toBe(false)
  expect(shouldSuppressDeckNotification(OBSERVED, 999), 'a clock gone backwards').toBe(false)
  expect(shouldSuppressDeckNotification(OBSERVED, Number.NaN)).toBe(false)
  expect(shouldSuppressDeckNotification(OBSERVED, Number.POSITIVE_INFINITY)).toBe(false)
  const received = (receivedAt: number) => ({ ...OBSERVED, status: { replace: true, receivedAt, leaseMs: 15_000 } })
  expect(shouldSuppressDeckNotification(received(Number.NaN), 1_000)).toBe(false)
  expect(shouldSuppressDeckNotification(received(Number.NEGATIVE_INFINITY), 1_000)).toBe(false)
})

test('a Deck notification is not suppressed without a negotiated, bound, current binding or a true status of exactly 15000 ms', () => {
  for (const condition of ['negotiated', 'bound', 'currentContext'] as const) {
    expect(shouldSuppressDeckNotification({ ...OBSERVED, [condition]: false }, 1_000), condition).toBe(false)
    expect(shouldSuppressDeckNotification({ ...OBSERVED, [condition]: 1 as unknown as boolean }, 1_000), `${condition} truthy`).toBe(false)
  }
  expect(shouldSuppressDeckNotification({ ...OBSERVED, status: null }, 1_000), 'no status').toBe(false)
  expect(shouldSuppressDeckNotification({ ...OBSERVED, status: { replace: false, receivedAt: 1_000, leaseMs: 15_000 } }, 1_000), 'replace false').toBe(false)
  expect(
    shouldSuppressDeckNotification({ ...OBSERVED, status: { replace: 1 as unknown as boolean, receivedAt: 1_000, leaseMs: 15_000 } }, 1_000),
    'replace truthy'
  ).toBe(false)
  for (const leaseMs of [14_999, 15_001, 30_000, 0]) {
    expect(shouldSuppressDeckNotification({ ...OBSERVED, status: { replace: true, receivedAt: 1_000, leaseMs } }, 1_000), `lease ${leaseMs}`).toBe(false)
  }
})
