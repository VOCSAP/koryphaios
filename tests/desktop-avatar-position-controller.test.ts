import { expect, test } from 'bun:test'
import { createAvatarPositionController } from '../desktop/src/main/avatar-position-controller.ts'
import { canMoveAvatarAppearance } from '../desktop/src/main/avatar-position-guard.ts'

test('coalesces position effects and flushes the latest pending value', () => {
  let nextTimer = 0
  const timers = new Map<number, () => void>()
  const moved: { x: number; y: number }[] = []
  const persisted: { x: number; y: number }[] = []
  const controller = createAvatarPositionController({
    canApply: () => true,
    moveDelayMs: 16,
    persistDelayMs: 500,
    setTimeout: (callback) => {
      const id = ++nextTimer
      timers.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (timer) => { timers.delete(timer as unknown as number) },
    move: (position) => moved.push(position),
    persist: (position) => persisted.push(position),
    reportError: () => {}
  })

  controller.setPosition({ x: 1, y: 2 })
  controller.setPosition({ x: 3, y: 4 })
  controller.setPosition({ x: 5, y: 6 })
  expect(timers).toHaveLength(2)

  controller.flush()

  expect(moved).toEqual([{ x: 5, y: 6 }])
  expect(persisted).toEqual([{ x: 5, y: 6 }])
  expect(timers).toHaveLength(0)
})

test('limits repeated input to one movement and persistence per scheduling window', () => {
  let nextTimer = 0
  const timers = new Map<number, () => void>()
  const moved: { x: number; y: number }[] = []
  const persisted: { x: number; y: number }[] = []
  const controller = createAvatarPositionController({
    canApply: () => true,
    setTimeout: (callback) => {
      const id = ++nextTimer
      timers.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (timer) => { timers.delete(timer as unknown as number) },
    move: (position) => moved.push(position),
    persist: (position) => persisted.push(position),
    reportError: () => {}
  })

  for (let index = 0; index < 100; index += 1) controller.setPosition({ x: index, y: index + 1 })
  for (const callback of [...timers.values()]) callback()

  expect(moved).toEqual([{ x: 99, y: 100 }])
  expect(persisted).toEqual([{ x: 99, y: 100 }])
})

test('does not move or persist a queued position after movement becomes forbidden', () => {
  let nextTimer = 0
  let appearance = {
    version: 1 as const, visible: true, alwaysOnTop: true, positionLocked: false,
    size: 'm' as const, idleOpacity: 1, motion: 'continuous' as const,
    dndUntil: null, dndChoice: null, positions: {}
  }
  const timers = new Map<number, () => void>()
  const moved: { x: number; y: number }[] = []
  const persisted: { x: number; y: number }[] = []
  const controller = createAvatarPositionController({
    canApply: () => canMoveAvatarAppearance(appearance),
    setTimeout: (callback) => {
      const id = ++nextTimer
      timers.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (timer) => { timers.delete(timer as unknown as number) },
    move: (position) => moved.push(position),
    persist: (position) => persisted.push(position),
    reportError: () => {}
  })

  controller.setPosition({ x: 10, y: 20 })
  appearance = { ...appearance, visible: false }
  for (const callback of timers.values()) callback()

  expect(moved).toEqual([])
  expect(persisted).toEqual([])
})

test('does not persist a position when the native move fails', () => {
  let nextTimer = 0
  const timers = new Map<number, () => void>()
  const persisted: { x: number; y: number }[] = []
  const errors: string[] = []
  const controller = createAvatarPositionController({
    canApply: () => true,
    setTimeout: (callback) => {
      const id = ++nextTimer
      timers.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (timer) => { timers.delete(timer as unknown as number) },
    move: () => { throw new Error('window unavailable') },
    persist: (position) => persisted.push(position),
    reportError: (_scope, message) => errors.push(message)
  })

  controller.setPosition({ x: 10, y: 20 })
  for (const callback of timers.values()) callback()

  expect(persisted).toEqual([])
  expect(errors).toEqual(['cannot move Avatar window'])
})
