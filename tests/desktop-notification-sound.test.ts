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
    report: (text, err) => {
      state.reports.push(text)
      state.reportedErrors.push(err)
    }
  }
  const sounder = createNotificationSounder(deps)
  if (start.ready !== false) sounder.rendererReady()
  return { state, sounder }
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

test('an approval a tile already raises through its attention edge does not ring', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([approval('t1', { origin: { tile_ref: 'tile-3' } })])
  expect(state.played).toEqual([])
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
  sounder.noteAttention()
  expect(state.played).toEqual(['attention'])
})

test('the Settings switch off silences every sound and reads no appearance file', () => {
  const { state, sounder } = rig({ enabled: false })
  sounder.noteAttention()
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
  sounder.noteAttention()
  sounder.noteApprovals([approval('a1')])
  expect(state.played).toEqual([])
})

test('Do Not Disturb silences the sound until its end, and the end restores it', () => {
  const { state, sounder } = rig({ appearance: { sound: true, dndUntil: T0 + 60_000 } })
  sounder.noteAttention()
  expect(state.played).toEqual([])
  state.now = T0 + 59_999
  sounder.noteAttention()
  expect(state.played, 'one millisecond before the end').toEqual([])
  state.now = T0 + 60_000
  sounder.noteAttention()
  expect(state.played, 'dndUntil equal to now is over').toEqual(['attention'])
})

test('a dndUntil that is not a future finite time never mutes', () => {
  for (const dndUntil of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
    const { state, sounder } = rig({ appearance: { sound: true, dndUntil } })
    sounder.noteAttention()
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

test('two sounds closer than the minimum gap play once, and the next one after the gap plays', () => {
  const { state, sounder } = rig()
  sounder.noteAttention()
  state.now += MIN_SOUND_GAP_MS - 1
  sounder.noteAttention()
  expect(state.played).toEqual(['attention'])
  state.now += 1
  sounder.noteAttention()
  expect(state.played).toEqual(['attention', 'attention'])
})

test('a clock set back does not silence the sound', () => {
  const { state, sounder } = rig()
  sounder.noteAttention()
  state.now -= 3_600_000
  sounder.noteAttention()
  expect(state.played).toEqual(['attention', 'attention'])
})

test('a tick with nothing new reads no appearance file', () => {
  const { state, sounder } = rig()
  sounder.noteApprovals([])
  sounder.noteApprovals([approval('t', { origin: { tile_ref: 'tile-1' } })])
  expect(state.appearanceReads).toBe(0)
  sounder.noteApprovals([approval('a1')])
  expect(state.appearanceReads).toBe(1)
})

test('a failing player or an unreadable appearance is reported and never thrown', () => {
  const failingPlay = rig()
  failingPlay.state.playThrows = true
  expect(() => failingPlay.sounder.noteApprovals([approval('a1')])).not.toThrow()
  failingPlay.state.now += MIN_SOUND_GAP_MS
  expect(() => failingPlay.sounder.noteAttention()).not.toThrow()
  expect(failingPlay.state.reports).toEqual(['notification sound failed', 'notification sound failed'])
  expect(failingPlay.state.reportedErrors[0], 'the thrown error travels with the report').toBe(failingPlay.state.playError)

  const failingRead = rig()
  failingRead.state.appearanceThrows = true
  expect(() => failingRead.sounder.noteAttention()).not.toThrow()
  expect(failingRead.state.reports).toEqual(['notification sound failed'])
  expect(failingRead.state.reportedErrors[0], 'the thrown error travels with the report').toBe(failingRead.state.appearanceError)
})

test('a sound requested before the renderer is ready is held, then sent once at the ready signal without consuming the gap or the signalled set', () => {
  const { state, sounder } = rig({ ready: false })
  sounder.noteApprovals([approval('a1')])
  sounder.noteAttention()
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
    for (const kind of order) {
      if (kind === 'attention') sounder.noteAttention()
      else sounder.noteApprovals([approval(`id-${kind}`, { kind })])
    }
    sounder.rendererReady()
    const wanted = order.includes('permission') ? 'permission' : 'question'
    expect(state.played, order.join(' > ')).toEqual([wanted])
  }
})

test('a renderer that reloads holds the next sound until its listener is back, and plays it once', () => {
  const { state, sounder } = rig()
  sounder.rendererNotReady()
  sounder.noteAttention()
  expect(state.played, 'nothing is sent to a renderer without a listener').toEqual([])
  sounder.rendererReady()
  expect(state.played).toEqual(['attention'])
  state.now += MIN_SOUND_GAP_MS
  sounder.rendererReady()
  expect(state.played, 'the held sound is not replayed').toEqual(['attention'])
})

test('a request muted before the ready signal is never held', () => {
  const { state, sounder } = rig({ ready: false, enabled: false })
  sounder.noteAttention()
  sounder.noteApprovals([approval('a1')])
  state.enabled = true
  sounder.rendererReady()
  expect(state.played).toEqual([])
})

test('Do Not Disturb or the tray Sound box off between the request and the ready signal silences the held sound', () => {
  const dnd = rig({ ready: false })
  dnd.sounder.noteAttention()
  dnd.state.appearance = { sound: true, dndUntil: T0 + 60_000 }
  dnd.sounder.rendererReady()
  expect(dnd.state.played, 'Do Not Disturb started while waiting').toEqual([])

  const tray = rig({ ready: false })
  tray.sounder.noteAttention()
  tray.state.appearance = { sound: false, dndUntil: null }
  tray.sounder.rendererReady()
  expect(tray.state.played, 'tray Sound switched off while waiting').toEqual([])
})

test('a sound the player could not hand to a window stays held, keeps the gap free, and is sent at the next ready signal', () => {
  const { state, sounder } = rig()
  state.delivered = false
  sounder.noteAttention()
  expect(state.played).toEqual([])
  state.delivered = true
  sounder.noteAttention()
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
  sounder.noteAttention()
  state.delivered = true
  state.now += MIN_SOUND_GAP_MS
  sounder.noteApprovals([approval('a1')])
  expect(state.played).toEqual(['permission'])
  state.now += MIN_SOUND_GAP_MS
  sounder.rendererReady()
  expect(state.played, 'the held attention sound was superseded by the delivered one').toEqual(['permission'])
})

test('the minimum gap between two sounds is 1500 ms', () => {
  const { state, sounder } = rig()
  sounder.noteAttention()
  state.now = T0 + 1499
  sounder.noteAttention()
  expect(state.played, '1499 ms after a sound is still too soon').toEqual(['attention'])
  state.now = T0 + 1500
  sounder.noteAttention()
  expect(state.played, '1500 ms after a sound is allowed').toEqual(['attention', 'attention'])
})

test('rendererNotReady keeps the sound that was held', () => {
  const { state, sounder } = rig({ ready: false })
  sounder.noteAttention()
  sounder.rendererNotReady()
  sounder.rendererReady()
  expect(state.played).toEqual(['attention'])
})

test('rendererNotReady keeps the minimum gap of the last sound that was sent', () => {
  const { state, sounder } = rig()
  sounder.noteAttention()
  sounder.rendererNotReady()
  state.now = T0 + 1499
  sounder.noteAttention()
  sounder.rendererReady()
  expect(state.played, 'a reload does not allow a second sound inside the gap').toEqual(['attention'])
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
  missing.sounder.noteAttention()
  expect(missing.played, 'no Avatar ever ran').toEqual(['attention'])

  writeFileSync(file, JSON.stringify(storedAppearance({ sound: false })))
  const muted = sounderOnFile(file, clock)
  muted.sounder.noteAttention()
  expect(muted.played, 'tray Sound off').toEqual([])

  writeFileSync(file, JSON.stringify(storedAppearance({ dndUntil: T0 + 30 * 60_000, dndChoice: '30m' })))
  const dnd = sounderOnFile(file, clock)
  dnd.sounder.noteAttention()
  expect(dnd.played, 'Do Not Disturb running').toEqual([])
  clock.now = T0 + 30 * 60_000
  dnd.sounder.noteAttention()
  expect(dnd.played, 'Do Not Disturb over').toEqual(['attention'])

  writeFileSync(file, '{ not json')
  const corrupt = sounderOnFile(file, clock)
  corrupt.sounder.noteAttention()
  expect(corrupt.played, 'an unreadable file falls back to the defaults').toEqual(['attention'])
})
