import { SPAWN_CAP, SPAWN_CAP_MAX, SPAWN_CAP_MIN } from '../shared/spawn-cap-limits'

export { SPAWN_CAP, SPAWN_CAP_MAX, SPAWN_CAP_MIN }

export interface SpawnCap {
  reserve(requestedSessionCount: number): () => void
}

/** A live cap setting and the trace sink for a value that cannot be one; SPAWN_CAP applies instead of it. */
export interface SpawnCapSource {
  getCap(): unknown
  onInvalidCap(value: unknown): void
}

export function countLiveSessions(sessions: readonly { status: string }[]): number {
  return sessions.filter((session) => session.status !== 'exited').length
}

/** null when the value is not an integer within [SPAWN_CAP_MIN, SPAWN_CAP_MAX]: a NaN cap would let every spawn through. */
export function sanitizeSpawnCap(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= SPAWN_CAP_MIN && value <= SPAWN_CAP_MAX ? value : null
}

// Operator template and workspace gestures stay uncapped so a saved workspace can always be restored.
export function createSpawnCap(
  listSessions: () => readonly { status: string }[],
  source?: SpawnCapSource
): SpawnCap {
  let reservedSessionCount = 0

  function currentCap(): number {
    if (!source) return SPAWN_CAP
    const raw = source.getCap()
    const cap = sanitizeSpawnCap(raw)
    if (cap !== null) return cap
    source.onInvalidCap(raw)
    return SPAWN_CAP
  }

  return {
    reserve(requestedSessionCount: number): () => void {
      if (!Number.isInteger(requestedSessionCount) || requestedSessionCount < 1) {
        throw new Error(`spawn cap: requested session count must be a positive integer, got ${requestedSessionCount}`)
      }
      const cap = currentCap()
      const liveSessionCount = countLiveSessions(listSessions())
      if (liveSessionCount + reservedSessionCount + requestedSessionCount > cap) {
        if (liveSessionCount + requestedSessionCount <= cap) {
          throw new Error(
            `spawn cap: ${reservedSessionCount} slot(s) held by spawns awaiting approval or creation -- retry this call once they complete`
          )
        }
        throw new Error(
          `spawn cap: ${liveSessionCount} live session(s) + ${reservedSessionCount} reserved + ${requestedSessionCount} requested exceeds the ${cap} cap -- close sessions or spawn in waves`
        )
      }
      reservedSessionCount += requestedSessionCount
      let released = false
      return () => {
        if (released) return
        released = true
        reservedSessionCount -= requestedSessionCount
      }
    }
  }
}
