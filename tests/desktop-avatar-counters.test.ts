import { expect, test } from 'bun:test'
import type { SessionRuntime } from '../desktop/src/shared/types.ts'
import { projectAvatarCounters } from '../desktop/src/main/avatar-counters.ts'
import { hookAwaitedTiles } from '../desktop/src/main/hook-attention.ts'
import { MAX_AVATAR_COUNTER, parseAvatarStateRequest } from '../desktop/src/shared/avatar-protocol.ts'
import { AvatarState, type AvatarFace } from '../desktop/src/shared/avatar-state.ts'
import type { HookAwaitRow } from '../desktop/src/shared/hook-await.ts'

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

const askOperator = (status = 'pending'): HookAwaitRow => ({ reply_route: 'channel', status, origin: { tile_ref: '' } })
const hookRow = (tile: string): HookAwaitRow => ({ reply_route: 'hook', status: 'pending', origin: { tile_ref: tile } })

function faceFor(
  rows: HookAwaitRow[],
  options: { ptyWaiting?: boolean; unread?: number } = {}
): { face: AvatarFace; waiting: number; unread: number } {
  const awaited = hookAwaitedTiles(rows as never)
  const sessions = ['lead', 'dev'].map((id) =>
    session({ id, activity: 'working', needsAttention: (id === 'lead' && options.ptyWaiting === true) || awaited.has(id) })
  )
  const state = new AvatarState({ now: () => 0 })
  state.receiveSnapshot({
    identity: { deckRunId: 'run', broker_url: 'http://broker' },
    ...projectAvatarCounters(sessions, rows, options.unread ?? 0)
  })
  const summary = state.summary()
  return { face: summary.face, waiting: summary.counters.waiting, unread: summary.unread }
}

test('a pending ask_operator question with no tile makes the Avatar claim the operator', () => {
  expect(faceFor([askOperator(), askOperator(), askOperator()])).toEqual({ face: 'reclame', waiting: 3, unread: 0 })
})

test('a tile on a wait screen and a hook row bound to a tile still make the Avatar claim', () => {
  expect(faceFor([], { ptyWaiting: true })).toMatchObject({ face: 'reclame', waiting: 1 })
  expect(faceFor([hookRow('lead')])).toMatchObject({ face: 'reclame', waiting: 1 })
})

test('a hook row a tile waits on is counted once, through its tile', () => {
  expect(faceFor([hookRow('lead'), askOperator()])).toMatchObject({ waiting: 2 })
  expect(faceFor([hookRow('lead')], { ptyWaiting: true })).toMatchObject({ waiting: 1 })
})

test('a request whose phone notification expired still claims, like in the Courrier', () => {
  expect(faceFor([askOperator('expired_notif')])).toEqual({ face: 'reclame', waiting: 1, unread: 0 })
})

test('a closed request claims nothing', () => {
  const closed = ['answered', 'answered_terminal', 'abandoned', 'acknowledged'].map((status) => askOperator(status))
  expect(faceFor(closed)).toEqual({ face: 'travaille', waiting: 0, unread: 0 })
})

test('unread inbox messages reach the Avatar instead of a constant zero', () => {
  expect(faceFor([], { unread: 2 })).toEqual({ face: 'courrier', waiting: 0, unread: 2 })
  expect(projectAvatarCounters([], [], 4).unread).toBe(4)
})

test('an invalid unread count is bounded and traced, so the Avatar still accepts the whole snapshot', () => {
  const cases: Array<[number, number]> = [
    [Number.NaN, 0],
    [2.7, 2],
    [-3, 0],
    [MAX_AVATAR_COUNTER + 5, MAX_AVATAR_COUNTER],
    [Number.POSITIVE_INFINITY, MAX_AVATAR_COUNTER],
    [Number.NEGATIVE_INFINITY, 0]
  ]
  for (const [raw, bounded] of cases) {
    const traced: unknown[] = []
    const projection = projectAvatarCounters([session({ activity: 'working' })], [], raw, (value) => traced.push(value))
    const wire = JSON.parse(JSON.stringify({ identity: { deckRunId: 'run', broker_url: 'http://127.0.0.1:7899' }, ...projection }))
    expect(parseAvatarStateRequest(wire).unread, `unread ${raw}`).toBe(bounded)
    expect(traced, `trace for unread ${raw}`).toEqual([raw])
  }
})

test('a valid unread count is sent as is without a trace', () => {
  const traced: unknown[] = []
  for (const value of [0, 7, MAX_AVATAR_COUNTER]) {
    expect(projectAvatarCounters([], [], value, (raw) => traced.push(raw)).unread).toBe(value)
  }
  expect(traced).toEqual([])
})
