import type { AvatarViewPosition } from '../shared/avatar-view'

export interface AvatarPositionControllerOptions {
  canApply(): boolean
  move(position: AvatarViewPosition): void
  persist(position: AvatarViewPosition): void
  reportError(scope: string, message: string, error?: unknown): void
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
  moveDelayMs?: number
  persistDelayMs?: number
}

export interface AvatarPositionController {
  setPosition(position: AvatarViewPosition): void
  flush(): void
}

export function createAvatarPositionController(options: AvatarPositionControllerOptions): AvatarPositionController {
  const canApply = options.canApply
  const moveDelayMs = options.moveDelayMs ?? 16
  const persistDelayMs = options.persistDelayMs ?? 500
  let latest: AvatarViewPosition | null = null
  let applied: AvatarViewPosition | null = null
  let movePending = false
  let persistPending = false
  let moveTimer: ReturnType<typeof setTimeout> | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  const move = (): void => {
    moveTimer = null
    if (!movePending || latest === null) return
    movePending = false
    if (!canApply()) return
    try {
      options.move(latest)
      applied = { ...latest }
    } catch (error) {
      applied = null
      options.reportError('avatar-position', 'cannot move Avatar window', error)
    }
  }

  const persist = (): void => {
    persistTimer = null
    if (!persistPending || latest === null) return
    persistPending = false
    if (!canApply() || applied === null || applied.x !== latest.x || applied.y !== latest.y) return
    try {
      options.persist(latest)
    } catch (error) {
      options.reportError('avatar-position', 'cannot persist Avatar position', error)
    }
  }

  return {
    setPosition(position) {
      latest = { x: position.x, y: position.y }
      movePending = true
      persistPending = true
      if (moveTimer === null) moveTimer = options.setTimeout(move, moveDelayMs)
      if (persistTimer === null) persistTimer = options.setTimeout(persist, persistDelayMs)
    },
    flush() {
      if (moveTimer !== null) {
        options.clearTimeout(moveTimer)
        moveTimer = null
      }
      if (persistTimer !== null) {
        options.clearTimeout(persistTimer)
        persistTimer = null
      }
      move()
      persist()
    }
  }
}
