import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAvatarAppearance, type AvatarAppearance } from '../desktop/src/main/avatar-appearance.ts'
import {
  createNotificationSounder,
  MIN_SOUND_GAP_MS,
  type NotificationSounderDeps,
  type SoundApproval,
  type SoundAppearance
} from '../desktop/src/main/notification-sound.ts'
import { playNotificationSound, SOUND_URLS } from '../desktop/src/renderer/src/notification-sound-player.ts'
import { COMPANION_MANIFEST } from '../desktop/src/shared/companion.ts'
import type { NotificationSoundKind } from '../desktop/src/shared/types.ts'
import { extractBracedBody } from './_braced-body.ts'
import { stripComments } from './_state-scope-audit.ts'

const T0 = 1_800_000_000_000

function approval(id: string, over: Partial<SoundApproval> = {}): SoundApproval {
  return { id, kind: 'permission', status: 'pending', origin: { tile_ref: '' }, ...over }
}

function rig(start: Partial<{ enabled: boolean; appearance: SoundAppearance; ready: boolean }> = {}) {
  const state = {
    delivered: true,
    enabled: start.enabled ?? true,
    appearance: start.appearance ?? { sound: true, dndUntil: null },
    now: T0,
    appearanceReads: 0,
    played: [] as NotificationSoundKind[],
    reports: [] as string[],
    reportedErrors: [] as unknown[],
    playError: new Error('play boom'),
    appearanceError: new Error('appearance boom'),
    timers: [] as { at: number; run: () => void }[],
    playThrows: false,
    appearanceThrows: false
  }
  const deps: NotificationSounderDeps = {
    enabled: () => state.enabled,
    appearance: () => {
      state.appearanceReads += 1
      if (state.appearanceThrows) throw state.appearanceError
      return state.appearance
    },
    now: () => state.now,
    play: (kind) => {
      if (state.playThrows) throw state.playError
      if (state.delivered) state.played.push(kind)
      return state.delivered
    },
    later: (delayMs, run) => void state.timers.push({ at: state.now + delayMs, run }),
    report: (text, err) => {
      state.reports.push(text)
      state.reportedErrors.push(err)
    }
  }
  const sounder = createNotificationSounder(deps)
  if (start.ready !== false) sounder.rendererReady()
  /** Moves the clock to `at`, firing every timer due on the way. */
  const advanceTo = (at: number): void => {
    for (;;) {
      const due = state.timers.filter((t) => t.at <= at).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      state.timers.splice(state.timers.indexOf(due), 1)
      state.now = due.at
      due.run()
    }
    state.now = at
  }
  return { state, sounder, advanceTo }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('a new approval rings once and the same pending row does not ring again on later ticks', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([approval('a1')])
  state.now += MIN_SOUND_GAP_MS * 10
  sounder.noteApprovals([approval('a1')])
  sounder.noteApprovals([approval('a1'), approval('a2', { kind: 'question' })])
  expect(state.played).toEqual(['permission', 'question'])
})

test('a permission rings the permission sound while a question and a plan ring the question sound', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([approval('q', { kind: 'question' })])
  state.now += MIN_SOUND_GAP_MS
  sounder.noteApprovals([approval('q', { kind: 'question' }), approval('p', { kind: 'plan' })])
  state.now += MIN_SOUND_GAP_MS
  sounder.noteApprovals([approval('q', { kind: 'question' }), approval('p', { kind: 'plan' }), approval('x')])
  expect(state.played).toEqual(['question', 'question', 'permission'])
})

test('a burst of new approvals in one tick plays one sound, the permission one when any row is a permission', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([approval('q1', { kind: 'question' }), approval('p1'), approval('q2', { kind: 'plan' })])
  expect(state.played).toEqual(['permission'])
})

test('a row that left the pending list rings again when it comes back', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([approval('a1')])
  state.now += MIN_SOUND_GAP_MS
  sounder.noteApprovals([])
  state.now += MIN_SOUND_GAP_MS
  sounder.noteApprovals([approval('a1')])
  expect(state.played).toEqual(['permission', 'permission'])
})

test('a pending question bound to a tile rings the question sound', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([approval('q1', { kind: 'question', origin: { tile_ref: 'tile-lead' } })])
  expect(state.played).toEqual(['question'])
})

test('a permission bound to a tile rings the permission sound and its needs-you edge adds nothing', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteApprovals([approval('p1', { origin: { tile_ref: 'tile-a' } })])
  advanceTo(T0 + 10_000)
  sounder.noteAttention('tile-a')
  expect(state.played).toEqual(['permission'])
})

test('a needs-you edge rings attention only for a tile no pending approval waits on', () => {
  const { state, sounder, advanceTo } = rig()
  const rows = [
    approval('p1', { origin: { tile_ref: 'tile-a' } }),
    approval('i1', { informational: true, origin: { tile_ref: 'tile-info' } }),
    approval('d1', { status: 'answered', origin: { tile_ref: 'tile-done' } }),
    approval('e1', { status: 'expired_notif', origin: { tile_ref: 'tile-late' } })
  ]
  sounder.noteApprovals(rows)
  let at = T0
  for (const tile of ['tile-a', 'tile-late', 'tile-b', 'tile-info', 'tile-done']) {
    at += 10_000
    advanceTo(at)
    sounder.noteAttention(tile)
  }
  expect(state.played).toEqual(['permission', 'attention', 'attention', 'attention'])
})

test('a tile whose approval left the list, or whose list cannot be read, rings attention again', () => {
  const settled = rig()
  settled.sounder.noteApprovals([approval('p1', { origin: { tile_ref: 'tile-a' } })])
  settled.sounder.noteApprovals([])
  settled.advanceTo(T0 + 10_000)
  settled.sounder.noteAttention('tile-a')
  expect(settled.state.played).toEqual(['permission', 'attention'])

  const unreadable = rig()
  unreadable.sounder.noteApprovals([approval('p1', { origin: { tile_ref: 'tile-a' } })])
  unreadable.sounder.approvalsUnavailable()
  unreadable.advanceTo(T0 + 10_000)
  unreadable.sounder.noteAttention('tile-a')
  expect(unreadable.state.played).toEqual(['permission', 'attention'])
})

test('an informational row and a settled row do not ring', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([
    approval('i1', { informational: true }),
    approval('d1', { status: 'answered' }),
    approval('d2', { status: 'expired' })
  ])
  expect(state.played).toEqual([])
})

test('a pending row whose notification expired still counts as awaiting the operator', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([approval('e1', { status: 'expired_notif' })])
  expect(state.played).toEqual(['permission'])
})

test('a tile that starts waiting rings the attention sound', () => {
  const { state, sounder } = rig()
  sounder.noteAttention('t1')
  expect(state.played).toEqual(['attention'])
})

test('the Settings switch off silences every sound and reads no appearance file', () => {
  const { state, sounder } = rig({ enabled: false })
  sounder.noteAttention('t1')
  sounder.noteApprovals([approval('a1')])
  expect(state.played).toEqual([])
  expect(state.appearanceReads).toBe(0)
})

test('a row met while muted does not ring once the sound is switched back on', () => {
  const { state, sounder } = rig({ enabled: false })
  sounder.noteApprovals([approval('a1')])
  state.enabled = true
  state.now += MIN_SOUND_GAP_MS
  sounder.noteApprovals([approval('a1')])
  expect(state.played).toEqual([])
})

test('the Avatar tray Sound box off silences the approval and the tile sounds', () => {
  const { state, sounder } = rig({ appearance: { sound: false, dndUntil: null } })
  sounder.noteAttention('t1')
  sounder.noteApprovals([approval('a1')])
  expect(state.played).toEqual([])
})

test('Do Not Disturb silences the sound until its end, and the end restores it', () => {
  const { state, sounder } = rig({ appearance: { sound: true, dndUntil: T0 + 60_000 } })
  sounder.noteAttention('t1')
  expect(state.played).toEqual([])
  state.now = T0 + 59_999
  sounder.noteAttention('t1')
  expect(state.played, 'one millisecond before the end').toEqual([])
  state.now = T0 + 60_000
  sounder.noteAttention('t1')
  expect(state.played, 'dndUntil equal to now is over').toEqual(['attention'])
})

test('a dndUntil that is not a future finite time never mutes', () => {
  for (const dndUntil of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
    const { state, sounder } = rig({ appearance: { sound: true, dndUntil } })
    sounder.noteAttention('t1')
    expect(state.played, `dndUntil ${String(dndUntil)}`).toEqual(['attention'])
  }
})

test('a row met during Do Not Disturb does not ring when it ends', () => {
  const { state, sounder } = rig({ appearance: { sound: true, dndUntil: T0 + 60_000 } })
  sounder.noteApprovals([approval('a1')])
  state.now = T0 + 120_000
  sounder.noteApprovals([approval('a1')])
  expect(state.played).toEqual([])
})

test('a sound requested inside the gap is deferred to its end and played once, the preferred kind', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteAttention('t1')
  advanceTo(T0 + 100)
  sounder.noteAttention('t2')
  sounder.noteApprovals([approval('x1')])
  sounder.noteAttention('t3')
  expect(state.played, 'nothing before the end of the gap').toEqual(['attention'])
  expect(state.timers.length, 'one timer for the whole wait').toBe(1)
  advanceTo(T0 + MIN_SOUND_GAP_MS)
  expect(state.played).toEqual(['attention', 'permission'])
  advanceTo(T0 + 60_000)
  expect(state.played, 'the deferred sound plays once').toEqual(['attention', 'permission'])
})

test('a row whose sound waits for the gap is not asked again by the next poll', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteAttention('t1')
  sounder.noteApprovals([approval('x1')])
  sounder.noteApprovals([approval('x1')])
  advanceTo(T0 + 60_000)
  sounder.noteApprovals([approval('x1')])
  expect(state.played).toEqual(['attention', 'permission'])
})

test('a deferred sound is judged again when its gap ends', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteAttention('t1')
  sounder.noteApprovals([approval('x1')])
  state.appearance = { sound: true, dndUntil: T0 + 60_000 }
  advanceTo(T0 + MIN_SOUND_GAP_MS)
  expect(state.played, 'Do Not Disturb started during the gap').toEqual(['attention'])
  state.appearance = { sound: true, dndUntil: null }
  advanceTo(T0 + 120_000)
  sounder.rendererReady()
  expect(state.played, 'the silenced sound is dropped').toEqual(['attention'])
})

test('a gap ending while no renderer listens keeps the sound for the next ready signal', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteAttention('t1')
  sounder.noteApprovals([approval('x1')])
  sounder.rendererNotReady()
  advanceTo(T0 + 5_000)
  expect(state.played).toEqual(['attention'])
  sounder.rendererReady()
  expect(state.played).toEqual(['attention', 'permission'])
})

test('a permission queued behind another sound and resolved before the end of the gap plays nothing', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteAttention('t1')
  advanceTo(T0 + 100)
  sounder.noteApprovals([approval('x1')])
  sounder.noteApprovals([])
  advanceTo(T0 + MIN_SOUND_GAP_MS)
  expect(state.played).toEqual(['attention'])
})

test('the kind of a deferred sound follows the rows still open when its gap ends', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteAttention('t1')
  advanceTo(T0 + 100)
  sounder.noteApprovals([approval('p1'), approval('q1', { kind: 'question' })])
  sounder.noteApprovals([approval('q1', { kind: 'question' })])
  advanceTo(T0 + MIN_SOUND_GAP_MS)
  expect(state.played).toEqual(['attention', 'question'])
})

test('an attention sound held for a tile that stops waiting is dropped, and another tile keeps its own', () => {
  const cleared = rig()
  cleared.sounder.noteAttention('t1')
  cleared.advanceTo(T0 + 100)
  cleared.sounder.noteAttention('t2')
  cleared.sounder.noteAttentionCleared('t2')
  cleared.advanceTo(T0 + MIN_SOUND_GAP_MS)
  expect(cleared.state.played).toEqual(['attention'])

  const other = rig()
  other.sounder.noteAttention('t1')
  other.advanceTo(T0 + 100)
  other.sounder.noteAttention('t2')
  other.sounder.noteAttention('t3')
  other.sounder.noteAttentionCleared('t2')
  other.advanceTo(T0 + MIN_SOUND_GAP_MS)
  expect(other.state.played).toEqual(['attention', 'attention'])
})

test('an attention sound held for a tile gives way to the row that tile gets', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteAttention('t1')
  advanceTo(T0 + 100)
  sounder.noteAttention('t2')
  sounder.noteApprovals([approval('q2', { kind: 'question', origin: { tile_ref: 't2' } })])
  sounder.noteApprovals([])
  advanceTo(T0 + MIN_SOUND_GAP_MS)
  expect(state.played, 'the row took over and was resolved: nothing is left to ring').toEqual(['attention'])
})

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** Runs the timers due until `at` one at a time, letting each poll settle before the next one. */
async function elapse(state: ReturnType<typeof rig>['state'], at: number): Promise<void> {
  for (;;) {
    await flush()
    const due = state.timers.filter((t) => t.at <= at).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    state.timers.splice(state.timers.indexOf(due), 1)
    state.now = due.at
    due.run()
  }
  state.now = at
  await flush()
}

/** A needs-you edge on tile t1, whose permission row exists once `row.created` is set. */
function needsYou() {
  const harness = rig()
  const row = { created: false, polls: 0, waiting: true }
  const refresh = async (): Promise<void> => {
    row.polls += 1
    harness.sounder.noteApprovals(row.created ? [approval('h1', { origin: { tile_ref: 't1' } })] : [])
  }
  harness.sounder.noteNeedsYou('t1', refresh, () => row.waiting)
  return { ...harness, row }
}

test('a needs-you edge followed in the same turn by the fallback row rings that question once', async () => {
  const { state, sounder } = rig()
  let created = false
  let raise: Promise<unknown> | undefined
  let finishRaise: () => void = () => undefined
  let polls = 0
  const poll = () => {
    polls += 1
    sounder.noteApprovals(created ? [approval('f1', { kind: 'question', origin: { tile_ref: 't1' } })] : [])
  }
  sounder.noteNeedsYou('t1', () => Promise.resolve(raise).then(poll), () => true)
  raise = new Promise<void>((resolve) => {
    finishRaise = () => {
      created = true
      resolve()
    }
  })
  await flush()
  expect(state.played, 'nothing while the row is on its way').toEqual([])
  expect(polls, 'the first poll waits for the row being created').toBe(0)
  finishRaise()
  await elapse(state, T0 + 60_000)
  expect(state.played).toEqual(['question'])
})

test('a hook row arriving after the first poll but inside the wait rings its own kind only', async () => {
  const { state, row } = needsYou()
  await elapse(state, T0 + 700)
  expect(state.played).toEqual([])
  row.created = true
  await elapse(state, T0 + 60_000)
  expect(state.played).toEqual(['permission'])
})

test('a row present at the first poll ends the wait with no further poll', async () => {
  const harness = rig()
  const row = { polls: 0 }
  harness.sounder.noteNeedsYou(
    't1',
    async () => {
      row.polls += 1
      harness.sounder.noteApprovals([approval('h1', { origin: { tile_ref: 't1' } })])
    },
    () => true
  )
  await elapse(harness.state, T0 + 100)
  harness.sounder.noteApprovals([])
  await elapse(harness.state, T0 + 60_000)
  expect(harness.state.played, 'a wait that ended on a row never rings attention later').toEqual(['permission'])
  expect(row.polls).toBe(1)
})

test('a needs-you edge that never gets a row polls every 500 ms and rings attention once, at 5000 ms', async () => {
  const { state, row } = needsYou()
  await elapse(state, T0 + 499)
  expect(row.polls).toBe(1)
  await elapse(state, T0 + 500)
  expect(row.polls, 'a second poll one step later').toBe(2)
  await elapse(state, T0 + 4999)
  expect(state.played).toEqual([])
  await elapse(state, T0 + 5000)
  expect(state.played).toEqual(['attention'])
  expect(row.polls, 'one poll per step before the deadline, none at it').toBe(10)
  const polls = row.polls
  await elapse(state, T0 + 60_000)
  expect(row.polls, 'polling stops at the deadline').toBe(polls)
  expect(state.played).toEqual(['attention'])
})

test('a tile that stops waiting during the wait rings nothing and stops polling', async () => {
  const { state, row } = needsYou()
  await elapse(state, T0 + 700)
  row.waiting = false
  await elapse(state, T0 + 1500)
  const polls = row.polls
  await elapse(state, T0 + 60_000)
  expect(state.played).toEqual([])
  expect(row.polls).toBe(polls)
})

test('a poll that never ends is cut off at the deadline, which decides once', async () => {
  const { state, sounder } = rig()
  let settle: () => void = () => undefined
  sounder.noteNeedsYou('t1', () => new Promise<void>((resolve) => (settle = resolve)), () => true)
  await elapse(state, T0 + 4999)
  expect(state.played).toEqual([])
  await elapse(state, T0 + 5000)
  expect(state.played).toEqual(['attention'])
  await elapse(state, T0 + 60_000)
  settle()
  await elapse(state, T0 + 120_000)
  expect(state.played).toEqual(['attention'])
})

test('a tile that stopped waiting before the deadline of a hanging poll rings nothing', async () => {
  const { state, sounder } = rig()
  let waiting = true
  sounder.noteNeedsYou('t1', () => new Promise<void>(() => undefined), () => waiting)
  await flush()
  waiting = false
  await elapse(state, T0 + 60_000)
  expect(state.played).toEqual([])
})

test('a failing poll is reported once and the wait goes on to the deadline', async () => {
  const { state, sounder } = rig()
  const boom = new Error('poll boom')
  let polls = 0
  sounder.noteNeedsYou(
    't1',
    () => {
      polls += 1
      return Promise.reject(boom)
    },
    () => true
  )
  await elapse(state, T0 + 4999)
  expect(state.played).toEqual([])
  await elapse(state, T0 + 5000)
  expect(state.played).toEqual(['attention'])
  expect(polls, 'a failing poll is retried at each step').toBe(10)
  expect(state.reports).toEqual(['notification sound could not wait for the approvals'])
  expect(state.reportedErrors[0]).toBe(boom)
})

test('a row whose sound could not be queued is asked again at the next poll', () => {
  const { state, sounder } = rig()
  state.appearanceThrows = true
  sounder.noteApprovals([approval('x1')])
  state.appearanceThrows = false
  sounder.noteApprovals([approval('x1')])
  expect(state.played).toEqual(['permission'])
})

test('a clock set back does not silence the sound', () => {
  const { state, sounder } = rig()
  sounder.noteAttention('t1')
  state.now -= 3_600_000
  sounder.noteAttention('t1')
  expect(state.played).toEqual(['attention', 'attention'])
})

test('a tick with nothing new reads no appearance file', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([])
  sounder.noteApprovals([approval('i', { informational: true })])
  expect(state.appearanceReads).toBe(0)
  sounder.noteApprovals([approval('a1')])
  expect(state.appearanceReads).toBe(1)
})

test('a failing player or an unreadable appearance is reported and never thrown', () => {
  const failingPlay = rig()
  failingPlay.state.playThrows = true
  expect(() => failingPlay.sounder.noteApprovals([approval('a1')])).not.toThrow()
  failingPlay.state.now += MIN_SOUND_GAP_MS
  expect(() => failingPlay.sounder.noteAttention('t1')).not.toThrow()
  expect(failingPlay.state.reports).toEqual(['notification sound failed', 'notification sound failed'])
  expect(failingPlay.state.reportedErrors[0], 'the thrown error travels with the report').toBe(failingPlay.state.playError)

  const failingRead = rig()
  failingRead.state.appearanceThrows = true
  expect(() => failingRead.sounder.noteAttention('t1')).not.toThrow()
  expect(failingRead.state.reports).toEqual(['notification sound failed'])
  expect(failingRead.state.reportedErrors[0], 'the thrown error travels with the report').toBe(failingRead.state.appearanceError)
})

test('a sound requested before the renderer is ready is held, then sent once at the ready signal without consuming the gap or the signalled set', () => {
  const { state, sounder } = rig({ ready: false })
  sounder.noteApprovals([approval('a1')])
  sounder.noteAttention('t1')
  expect(state.played, 'nothing is sent while no renderer listens').toEqual([])
  sounder.rendererReady()
  expect(state.played, 'one coalesced sound, the preferred kind').toEqual(['permission'])
  sounder.noteApprovals([approval('a1')])
  expect(state.played, 'the held row counts as signalled').toEqual(['permission'])
  state.now += MIN_SOUND_GAP_MS
  sounder.rendererReady()
  expect(state.played, 'a second ready signal has nothing to send').toEqual(['permission'])
})

test('the held sound prefers permission over question over attention whatever the arrival order', () => {
  const orders: NotificationSoundKind[][] = [
    ['attention', 'question', 'permission'],
    ['permission', 'question', 'attention'],
    ['question', 'attention']
  ]
  for (const order of orders) {
    const { state, sounder } = rig({ ready: false })
    const rows: SoundApproval[] = []
    for (const kind of order) {
      if (kind === 'attention') sounder.noteAttention('t1')
      else {
        rows.push(approval(`id-${kind}`, { kind }))
        sounder.noteApprovals(rows)
      }
    }
    sounder.rendererReady()
    const wanted = order.includes('permission') ? 'permission' : 'question'
    expect(state.played, order.join(' > ')).toEqual([wanted])
  }
})

test('a renderer that reloads holds the next sound until its listener is back, and plays it once', () => {
  const { state, sounder } = rig()
  sounder.rendererNotReady()
  sounder.noteAttention('t1')
  expect(state.played, 'nothing is sent to a renderer without a listener').toEqual([])
  sounder.rendererReady()
  expect(state.played).toEqual(['attention'])
  state.now += MIN_SOUND_GAP_MS
  sounder.rendererReady()
  expect(state.played, 'the held sound is not replayed').toEqual(['attention'])
})

test('a request muted before the ready signal is never held', () => {
  const { state, sounder } = rig({ ready: false, enabled: false })
  sounder.noteAttention('t1')
  sounder.noteApprovals([approval('a1')])
  state.enabled = true
  sounder.rendererReady()
  expect(state.played).toEqual([])
})

test('Do Not Disturb or the tray Sound box off between the request and the ready signal silences the held sound', () => {
  const dnd = rig({ ready: false })
  dnd.sounder.noteAttention('t1')
  dnd.state.appearance = { sound: true, dndUntil: T0 + 60_000 }
  dnd.sounder.rendererReady()
  expect(dnd.state.played, 'Do Not Disturb started while waiting').toEqual([])

  const tray = rig({ ready: false })
  tray.sounder.noteAttention('t1')
  tray.state.appearance = { sound: false, dndUntil: null }
  tray.sounder.rendererReady()
  expect(tray.state.played, 'tray Sound switched off while waiting').toEqual([])
})

test('a sound the player could not hand to a window stays held, keeps the gap free, and is sent at the next ready signal', () => {
  const { state, sounder } = rig()
  state.delivered = false
  sounder.noteAttention('t1')
  expect(state.played).toEqual([])
  state.delivered = true
  sounder.noteAttention('t1')
  expect(state.played, 'the failed send did not consume the minimum gap').toEqual(['attention'])
  state.now += MIN_SOUND_GAP_MS
  state.delivered = false
  sounder.noteApprovals([approval('a1')])
  state.delivered = true
  state.now += MIN_SOUND_GAP_MS
  sounder.rendererReady()
  expect(state.played, 'the held permission is sent when a window signals ready').toEqual(['attention', 'permission'])
})

test('a sound delivered after a failed send leaves nothing held for the next ready signal', () => {
  const { state, sounder } = rig()
  state.delivered = false
  sounder.noteAttention('t1')
  state.delivered = true
  state.now += MIN_SOUND_GAP_MS
  sounder.noteApprovals([approval('a1')])
  expect(state.played).toEqual(['permission'])
  state.now += MIN_SOUND_GAP_MS
  sounder.rendererReady()
  expect(state.played, 'the held attention sound was superseded by the delivered one').toEqual(['permission'])
})

test('the minimum gap between two sounds is 1500 ms', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteAttention('t1')
  advanceTo(T0 + 100)
  sounder.noteAttention('t1')
  advanceTo(T0 + 1499)
  expect(state.played, '1499 ms after a sound is still too soon').toEqual(['attention'])
  advanceTo(T0 + 1500)
  expect(state.played, '1500 ms after a sound is allowed').toEqual(['attention', 'attention'])
})

test('rendererNotReady keeps the sound that was held', () => {
  const { state, sounder } = rig({ ready: false })
  sounder.noteAttention('t1')
  sounder.rendererNotReady()
  sounder.rendererReady()
  expect(state.played).toEqual(['attention'])
})

test('rendererNotReady keeps the minimum gap of the last sound that was sent', () => {
  const { state, sounder, advanceTo } = rig()
  sounder.noteAttention('t1')
  sounder.rendererNotReady()
  advanceTo(T0 + 1499)
  sounder.noteAttention('t1')
  sounder.rendererReady()
  expect(state.played, 'a reload does not allow a second sound inside the gap').toEqual(['attention'])
  advanceTo(T0 + 1500)
  expect(state.played).toEqual(['attention', 'attention'])
})

test('rendererNotReady keeps the rows already signalled', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([approval('a1')])
  sounder.rendererNotReady()
  sounder.rendererReady()
  state.now += MIN_SOUND_GAP_MS
  sounder.noteApprovals([approval('a1')])
  expect(state.played, 'a reload does not make a known row new').toEqual(['permission'])
})

test('the player builds one Audio per kind with its own url, plays it, and reports a rejected play', async () => {
  const created: { url: string; plays: number }[] = []
  const reported: unknown[][] = []
  let rejectWith: unknown = null
  class FakeAudio {
    private readonly record: { url: string; plays: number }
    constructor(url: string) {
      this.record = { url, plays: 0 }
      created.push(this.record)
    }
    play(): Promise<void> {
      this.record.plays += 1
      return rejectWith === null ? Promise.resolve() : Promise.reject(rejectWith)
    }
  }
  const saved = ['Audio', 'window'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, 'Audio', { value: FakeAudio, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'window', {
    value: { api: { reportError: (...args: unknown[]) => reported.push(args) } },
    configurable: true,
    writable: true
  })
  try {
    const kinds: NotificationSoundKind[] = ['permission', 'question', 'attention']
    for (const kind of kinds) playNotificationSound(kind)
    expect(created, 'one Audio per kind, on its own url, played once').toEqual(kinds.map((kind) => ({ url: SOUND_URLS[kind], plays: 1 })))
    expect(new Set(created.map((c) => c.url)).size, 'three different urls').toBe(3)

    rejectWith = new Error('decode failed')
    playNotificationSound('question')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    rejectWith = 'denied'
    playNotificationSound('attention')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(reported).toEqual([
      ['notification-sound', 'the question sound could not play: decode failed'],
      ['notification-sound', 'the attention sound could not play: denied']
    ])
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test('the three sound files exist and are three different sounds', () => {
  const dir = join(import.meta.dir, '..', 'desktop', 'src', 'renderer', 'src', 'assets', 'sounds')
  const hashes = ['approval', 'question', 'notification'].map((name) => {
    const file = join(dir, `${name}.ogg`)
    expect(existsSync(file), `${name}.ogg exists`).toBe(true)
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  })
  expect(new Set(hashes).size, 'no two kinds share a sound').toBe(3)
})

// preload/index.ts imports electron, which bun resolves to the binary path: its api object cannot run here.
test('the preload bridges the two sound channels the manifest declares, inside its api object', () => {
  const src = stripComments(readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'preload', 'index.ts'), 'utf8').replace(/\r\n/g, '\n'))
  const anchor = src.indexOf('const api: DeckApi = {')
  expect(anchor, 'the api object is found').toBeGreaterThanOrEqual(0)
  const body = extractBracedBody(src, src.indexOf('{', anchor), true)
  expect(body).toContain(`onNotificationSound: (cb) => subscribe('${COMPANION_MANIFEST.onNotificationSound.channel}', cb),`)
  expect(body).toContain(`notificationSoundReady: () => ipcRenderer.send('${COMPANION_MANIFEST.notificationSoundReady.channel}'),`)
})

// store.ts imports the @shared alias, which bun does not resolve, and its init() needs a full window.api: scan one block.
test('the renderer store subscribes to sounds and then tells main it listens, inside init()', () => {
  const src = stripComments(readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'renderer', 'src', 'store.ts'), 'utf8').replace(/\r\n/g, '\n'))
  const anchor = src.indexOf('  async init() {')
  expect(anchor, 'init() is found').toBeGreaterThanOrEqual(0)
  const body = extractBracedBody(src, src.indexOf('{', anchor), true)
  expect(body).toMatch(/window\.api\.onNotificationSound\(playNotificationSound\)\s*window\.api\.notificationSoundReady\(\)/)
})

test('the player url table maps each kind to its own sound file', () => {
  expect(Object.keys(SOUND_URLS).sort()).toEqual(['attention', 'permission', 'question'])
  expect(SOUND_URLS.permission).toMatch(/approval\.ogg$/)
  expect(SOUND_URLS.question).toMatch(/question\.ogg$/)
  expect(SOUND_URLS.attention).toMatch(/notification\.ogg$/)
})

function sounderOnFile(file: string, clock: { now: number }) {
  const played: NotificationSoundKind[] = []
  const sounder = createNotificationSounder({
    enabled: () => true,
    appearance: () => readAvatarAppearance(file, { reportError: () => {} }),
    now: () => clock.now,
    play: (kind) => {
      played.push(kind)
      return true
    },
    later: () => {},
    report: () => {}
  })
  sounder.rendererReady()
  return { sounder, played }
}

function storedAppearance(over: Partial<AvatarAppearance>): AvatarAppearance {
  return {
    version: 1,
    visible: true,
    alwaysOnTop: true,
    positionLocked: false,
    size: 'm',
    frame: 'normal',
    idleOpacity: 1,
    motion: 'continuous',
    bubbleExpanded: false,
    sound: true,
    dndUntil: null,
    dndChoice: null,
    positions: {},
    ...over
  }
}

test('the decision follows the Avatar appearance file: a missing or corrupt file rings, tray Sound off and a running Do Not Disturb are silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kory-notif-sound-'))
  dirs.push(dir)
  const file = join(dir, 'avatar-appearance.json')
  const clock = { now: T0 }

  const missing = sounderOnFile(file, clock)
  missing.sounder.noteAttention('t1')
  expect(missing.played, 'no Avatar ever ran').toEqual(['attention'])

  writeFileSync(file, JSON.stringify(storedAppearance({ sound: false })))
  const muted = sounderOnFile(file, clock)
  muted.sounder.noteAttention('t1')
  expect(muted.played, 'tray Sound off').toEqual([])

  writeFileSync(file, JSON.stringify(storedAppearance({ dndUntil: T0 + 30 * 60_000, dndChoice: '30m' })))
  const dnd = sounderOnFile(file, clock)
  dnd.sounder.noteAttention('t1')
  expect(dnd.played, 'Do Not Disturb running').toEqual([])
  clock.now = T0 + 30 * 60_000
  dnd.sounder.noteAttention('t1')
  expect(dnd.played, 'Do Not Disturb over').toEqual(['attention'])

  writeFileSync(file, '{ not json')
  const corrupt = sounderOnFile(file, clock)
  corrupt.sounder.noteAttention('t1')
  expect(corrupt.played, 'an unreadable file falls back to the defaults').toEqual(['attention'])
})
