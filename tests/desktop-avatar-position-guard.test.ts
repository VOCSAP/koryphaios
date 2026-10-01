import { expect, test } from 'bun:test'
import { assertAvatarPositionMovable, canMoveAvatarAppearance } from '../desktop/src/main/avatar-position-guard.ts'

const base = {
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

test('rejects movement for a hidden Avatar before considering its position', () => {
  expect(() => assertAvatarPositionMovable({ ...base, visible: false })).toThrow('Avatar is hidden')
  expect(() => assertAvatarPositionMovable({ ...base, positionLocked: true })).toThrow('Avatar position is locked')
  expect(() => assertAvatarPositionMovable(base)).not.toThrow()
  expect(canMoveAvatarAppearance(base)).toBe(true)
  expect(canMoveAvatarAppearance({ ...base, visible: false })).toBe(false)
  expect(canMoveAvatarAppearance({ ...base, positionLocked: true })).toBe(false)
})
