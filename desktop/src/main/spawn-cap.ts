export const SPAWN_CAP = 8

export interface SpawnCap {
  reserve(requestedSessionCount: number): () => void
}

export function countLiveSessions(sessions: readonly { status: string }[]): number {
  return sessions.filter((session) => session.status !== 'exited').length
}

// Operator template and workspace gestures stay uncapped so a saved workspace can always be restored.
export function createSpawnCap(
  listSessions: () => readonly { status: string }[],
  cap = SPAWN_CAP
): SpawnCap {
  let reservedSessionCount = 0

  return {
    reserve(requestedSessionCount: number): () => void {
      if (!Number.isInteger(requestedSessionCount) || requestedSessionCount < 1) {
        throw new Error(`spawn cap: requested session count must be a positive integer, got ${requestedSessionCount}`)
      }
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
