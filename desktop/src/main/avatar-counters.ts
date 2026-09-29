import type { AvatarDeckCounters } from '../shared/avatar-state'
import type { SessionRuntime } from '../shared/types'

export interface AvatarCounterProjection {
  counters: AvatarDeckCounters
  unread: number
}

function emptyCounters(): AvatarDeckCounters {
  return {
    working: 0,
    idle: 0,
    unknown: 0,
    waiting: 0,
    exited: 0,
    rateLimited: 0
  }
}

export function projectAvatarCounters(sessions: SessionRuntime[]): AvatarCounterProjection {
  const counters = emptyCounters()

  for (const session of sessions) {
    if (session.status === 'exited') {
      counters.exited += 1
    } else if (session.needsAttention) {
      counters.waiting += 1
    } else if (session.rateLimited) {
      counters.rateLimited += 1
    } else {
      counters[session.activity] += 1
    }
  }

  return { counters, unread: 0 }
}
