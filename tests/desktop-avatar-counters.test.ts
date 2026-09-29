import { expect, test } from 'bun:test'
import type { SessionRuntime } from '../desktop/src/shared/types.ts'
import { projectAvatarCounters } from '../desktop/src/main/avatar-counters.ts'

function session(overrides: Partial<SessionRuntime>): SessionRuntime {
  return {
    id: 'session-1',
    name: 'Session',
    cwd: 'C:/work/example',
    command: '',
    args: '',
    sessionId: '',
    color: '#000000',
    createdAt: 0,
    status: 'running',
    exitCode: null,
    pid: 1,
    peerId: null,
    activity: 'unknown',
    expired: false,
    rateLimited: false,
    resumeAt: null,
    needsAttention: false,
    claudeLaunch: true,
    liveStatus: null,
    ...overrides
  }
}

test('projects every live SessionRuntime state into distinct Avatar counters', () => {
  const projection = projectAvatarCounters([
    session({ id: 'working', activity: 'working' }),
    session({ id: 'idle', activity: 'idle' }),
    session({ id: 'unknown', activity: 'unknown' }),
    session({ id: 'waiting', activity: 'working', needsAttention: true }),
    session({ id: 'limited', activity: 'working', rateLimited: true }),
    session({ id: 'exited', status: 'exited', activity: 'working', exitCode: 1 })
  ])

  expect(projection).toEqual({
    counters: {
      working: 1,
      idle: 1,
      unknown: 1,
      waiting: 1,
      exited: 1,
      rateLimited: 1
    },
    unread: 0
  })
})

test('prioritizes exited, attention, and rate-limited states over activity', () => {
  const projection = projectAvatarCounters([
    session({ status: 'exited', activity: 'working', needsAttention: true, rateLimited: true }),
    session({ activity: 'idle', needsAttention: true }),
    session({ activity: 'unknown', rateLimited: true })
  ])

  expect(projection.counters).toEqual({
    working: 0,
    idle: 0,
    unknown: 0,
    waiting: 1,
    exited: 1,
    rateLimited: 1
  })
})
