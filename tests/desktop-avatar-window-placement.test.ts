import { expect, test } from 'bun:test'
import { clampAvatarPlacement, restoreAvatarPlacement } from '../desktop/src/main/avatar-window-placement.ts'

test('clamps a negative-coordinate placement without changing the requested avatar size', () => {
  expect(clampAvatarPlacement(
    { x: -1300, y: 800 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { width: 240, height: 240 }
  )).toEqual({ x: -1300, y: 800, width: 240, height: 240 })

  expect(clampAvatarPlacement(
    { x: -10, y: 1_000 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { width: 240, height: 240 }
  )).toEqual({ x: -240, y: 840, width: 240, height: 240 })
})

test('uses an available screen without discarding a missing screen placement', () => {
  const positions = {
    removed: { workArea: { x: -1920, y: 0, width: 1920, height: 1080 }, x: -1300, y: 800 }
  }

  const placement = restoreAvatarPlacement([
    { id: 'primary', workArea: { x: 0, y: 0, width: 1280, height: 720 } }
  ], positions, { width: 240, height: 240 })

  expect(placement).toEqual({ screenId: 'primary', x: 520, y: 240, width: 240, height: 240 })
  expect(positions).toHaveProperty('removed')
})

test('reduces an avatar that cannot fit into the available work area', () => {
  expect(clampAvatarPlacement(
    { x: 10, y: 10 },
    { x: 0, y: 0, width: 120, height: 80 },
    { width: 240, height: 240 }
  )).toEqual({ x: 0, y: 0, width: 120, height: 80 })
})
