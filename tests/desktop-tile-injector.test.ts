import { expect, test } from 'bun:test'
import { TileInjector, type InjectorClock, type InjectorScreen } from '../desktop/src/main/tile-injector.ts'
import { DIRECTIVE_IDLE_WAIT_MS, runClearReloadInTurn } from '../desktop/src/main/directive-run.ts'
import type { XtermScreenRead } from '../desktop/src/main/xterm-screen.ts'
import { reachedWithin } from './_bounded-await'

const ESC = '\x1b'

class FakeClock implements InjectorClock {
  private current = 0

  now(): number {
    return this.current
  }
  private nextId = 1
  private readonly timers = new Map<number, { due: number; callback: () => void }>()

  setTimeout(callback: () => void, delay: number): NodeJS.Timeout {
    const id = this.nextId++
    this.timers.set(id, { due: this.current + delay, callback })
    return id as unknown as NodeJS.Timeout
  }

  clearTimeout(timer: NodeJS.Timeout): void {
    this.timers.delete(timer as unknown as number)
  }

  advance(delay: number): void {
    const target = this.current + delay
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([a, x], [b, y]) => x.due - y.due || a - b)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.current = due[1].due
      due[1].callback()
    }
    this.current = target
  }
}

const clearScreen = (): XtermScreenRead => {
  const lines = Array<string>(40).fill('')
  lines[0] = String.fromCodePoint(0x2500).repeat(120)
  lines[1] = String.fromCodePoint(0x276f)
  lines[2] = String.fromCodePoint(0x2500).repeat(120)
  return { status: 'ready', snapshot: { cols: 120, rows: 40, lines, cursor: { x: 0, y: 1 }, revision: 1 } }
}

function fixture(
  options: {
    reads?: readonly XtermScreenRead[]
    screen?: InjectorScreen
    runtime?: { needsAttention?: boolean; rateLimited?: boolean }
    lastOutputAt?: number | null | (() => number | null)
    replaceLifeAfterEscape?: boolean
    replaceLifeDuringIdleWait?: boolean
    turnCeilingMs?: number
    clock?: InjectorClock
  } = {}
) {
  const writes: string[] = []
  const reports: string[] = []
  const logs: string[] = []
  const alive = new Set(['t1'])
  let life: object | null = {}
  const reads = [...(options.reads ?? [clearScreen()])]
  const injector = new TileInjector(
    {
      isAlive: (id) => alive.has(id),
      life: (id) => (alive.has(id) ? life : null),
      write: (id, data) => {
        if (!alive.has(id)) return false
        writes.push(data === ESC ? 'ESC' : data)
        if (data === ESC && options.replaceLifeAfterEscape) life = {}
        return true
      }
    },
    options.screen ?? {
      read: () => reads.shift() ?? clearScreen()
    },
    { get: (id) => (alive.has(id) ? options.runtime ?? {} : undefined) },
    () => {
      if (options.replaceLifeDuringIdleWait) life = {}
      return typeof options.lastOutputAt === 'function' ? options.lastOutputAt() : options.lastOutputAt ?? null
    },
    { activityIdleMs: 500, settleMs: 5, idlePollMs: 5, ...(options.turnCeilingMs ? { turnCeilingMs: options.turnCeilingMs } : {}) },
    (message) => reports.push(message),
    (_scope, message) => logs.push(message),
    options.clock
  )
  return { injector, writes, reports, logs, alive }
}

/** The command text as written, whatever the bracketed-paste wrapping. */
const commands = (writes: string[]) => writes.map((w) => (w === 'ESC' ? 'ESC' : w.includes('/compact') ? '/compact' : w.includes('/clear') ? '/clear' : w.includes('/resume') ? '/resume' : w.includes('/magic-compact') ? '/magic-compact' : w))

function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms))])
}

test('a screen guard modal refusal logs its rule and line without rendered screen text', async () => {
  const hiddenScreenText = 'untrusted screen content'
  const lines = Array<string>(40).fill('')
  lines[5] = `${String.fromCodePoint(0x276f)} 1. ${hiddenScreenText}`
  const screen: InjectorScreen = {
    read: () => ({ status: 'ready', snapshot: { cols: 120, rows: 40, lines, cursor: { x: 0, y: 5 }, revision: 1 } })
  }
  const { injector, writes, logs } = fixture({ screen })

  expect(await injector.injectCommand('t1', '/clear')).toBe('refused-modal')
  expect(writes).toEqual([])
  expect(logs).toEqual(['command injection refused-modal for t1: screen guard picker at line 6'])
  expect(logs.join('\n')).not.toContain(hiddenScreenText)
})

test('an unavailable screen after Escape refuses the text submission', async () => {
  const { injector, writes, logs } = fixture({
    reads: [clearScreen(), { status: 'unavailable', reason: 'screen-pending' }]
  })

  expect(await injector.injectCommand('t1', '/clear')).toBe('refused-modal')
  expect(commands(writes)).toEqual(['ESC'])
  expect(logs).toEqual(['command injection refused-modal for t1: screen unavailable screen-pending'])
})

test('a replaced PTY life after Escape receives no command text', async () => {
  const { injector, writes } = fixture({ replaceLifeAfterEscape: true })

  expect(await injector.injectCommand('t1', '/clear')).toBe('no-terminal')
  expect(commands(writes)).toEqual(['ESC'])
})

test('a life replacement while injection waits writes nothing', async () => {
  const { injector, writes } = fixture({ replaceLifeDuringIdleWait: true })

  expect(await injector.injectCommand('t1', '/clear')).toBe('no-terminal')
  expect(commands(writes)).toEqual([])
})

test('a life replacement during an expired idle wait writes nothing', async () => {
  const { injector, writes } = fixture({ replaceLifeDuringIdleWait: true, lastOutputAt: Date.now() + 60_000 })

  expect(await injector.injectCommand('t1', '/clear', 0)).toBe('no-terminal')
  expect(commands(writes)).toEqual([])
})

test('two injections outside of any turn interleave their Escape and command writes', async () => {
  const { injector, writes } = fixture()
  await Promise.all([injector.injectCommand('t1', '/compact'), injector.injectCommand('t1', '/clear')])
  expect(commands(writes)).toEqual(['ESC', 'ESC', '/compact', '/clear'])
})

test('two directives on the same tile take turns: one Escape and command at a time', async () => {
  const { injector, writes } = fixture()
  const outcomes = await withinMs(
    Promise.all([
      injector.inTurn('t1', () => injector.injectCommand('t1', '/compact')),
      injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))
    ]),
    1_000,
    'the earlier turn never released'
  )
  expect(outcomes).toEqual(['written', 'written'])
  expect(commands(writes)).toEqual(['ESC', '/compact', 'ESC', '/clear'])
})

test('a turn that fails does not block the next one', async () => {
  const { injector, writes } = fixture()
  const failed = injector.inTurn('t1', () => Promise.reject(new Error('boom')))
  const next = injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))
  await expect(failed).rejects.toThrow('boom')
  expect(await withinMs(next, 1_000, 'the earlier turn never released')).toBe('written')
  expect(commands(writes)).toEqual(['ESC', '/clear'])
})

test('a directive queued during a magic_compact sequence is written only after the sequence ends', async () => {
  const { injector, writes } = fixture()
  let bannerSeen!: () => void
  const banner = new Promise<void>((resolve) => {
    bannerSeen = resolve
  })
  const magic = injector.serializeTile('t1', async (inject) => {
    expect(await inject('/magic-compact')).toBe('written')
    await banner
    return inject('/resume 0000')
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const directive = injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(commands(writes), 'nothing may reach the tile between /magic-compact and /resume').toEqual(['ESC', '/magic-compact'])
  bannerSeen()
  expect(await withinMs(magic, 1_000, 'the magic_compact sequence')).toBe('written')
  expect(await withinMs(directive, 1_000, 'the earlier turn never released')).toBe('written')
  expect(commands(writes)).toEqual(['ESC', '/magic-compact', 'ESC', '/resume', 'ESC', '/clear'])
})

test('a second clear_reload cannot type another /clear before the pending reload instruction settles', async () => {
  const { injector, writes } = fixture()
  const original = injector.injectCommand.bind(injector)
  let reloadStarted!: () => void
  const reloadPending = new Promise<void>((resolve) => {
    reloadStarted = resolve
  })
  let releaseReload!: () => void
  const reloadReleased = new Promise<void>((resolve) => {
    releaseReload = resolve
  })
  let firstReload = true
  injector.injectCommand = async (id, command, idleWaitMs) => {
    if (command.startsWith('Reprends le workstream') && firstReload) {
      firstReload = false
      reloadStarted()
      await reloadReleased
    }
    return original(id, command, idleWaitMs)
  }

  const first = runClearReloadInTurn(injector, () => {}, 't1', 'lead-a1b2', 'night-shift')
  await reloadPending
  const second = runClearReloadInTurn(injector, () => {}, 't1', 'lead-a1b2', 'night-shift')
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(commands(writes).filter((command) => command === '/clear')).toHaveLength(1)

  releaseReload()
  expect(await withinMs(first, 1_000, 'the first clear_reload sequence')).toBe('written')
  expect(await withinMs(second, 1_000, 'the second clear_reload sequence')).toBe('written')
  expect(commands(writes).filter((command) => command === '/clear')).toHaveLength(2)
})

test('a turn that never settles releases its tile at the ceiling, traced with the tile it held', async () => {
  const { injector, writes, reports } = fixture({ turnCeilingMs: 50 })
  void injector.inTurn('t1', () => new Promise(() => {}))
  const next = injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))
  expect(await withinMs(next, 1_000, 'the turn queued behind a stuck one')).toBe('written')
  expect(commands(writes)).toEqual(['ESC', '/clear'])
  expect(reports).toEqual(['injection turn of tile t1 still running after 50 ms; its queue is released'])
})

test('a callback resumed after its ceiling release cannot type into an active newer turn', async () => {
  const clock = new FakeClock()
  const { injector, writes, reports } = fixture({ turnCeilingMs: 50, clock })
  let injectStale!: (command: string) => Promise<string>
  let staleStarted!: () => void
  const staleReady = new Promise<void>((resolve) => {
    staleStarted = resolve
  })
  let releaseStale!: () => void
  const staleReleased = new Promise<void>((resolve) => {
    releaseStale = resolve
  })
  const stale = injector.serializeTile('t1', async (inject) => {
    injectStale = inject
    staleStarted()
    await staleReleased
    return 'stale-finished'
  })
  await reachedWithin(staleReady, 'the stale callback capture')
  let injectCurrent!: (command: string) => Promise<string>
  let currentStarted!: () => void
  const currentReady = new Promise<void>((resolve) => {
    currentStarted = resolve
  })
  let releaseCurrent!: () => void
  const currentReleased = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  const current = injector.serializeTile('t1', async (inject) => {
    injectCurrent = inject
    currentStarted()
    await currentReleased
    return 'current-finished'
  })

  clock.advance(50)
  await reachedWithin(currentReady, 'the newer callback after stale ceiling')
  const staleError = await injectStale('/compact').then(
    () => '',
    (error) => error instanceof Error ? error.message : String(error)
  )
  releaseStale()
  expect(await stale).toBe('stale-finished')

  const currentAttempt = injectCurrent('/clear')
  for (let i = 0; i < 2; i++) await Promise.resolve()
  clock.advance(5)
  expect(await currentAttempt).toBe('written')
  releaseCurrent()
  expect(await current).toBe('current-finished')

  expect(staleError).toContain('injection callback refused for t1')
  expect(commands(writes)).toEqual(['ESC', '/clear'])
  expect(reports).toEqual([
    'injection turn of tile t1 still running after 50 ms; its queue is released',
    'injection callback refused for t1: its turn is no longer current'
  ])
})

test('an injection that waits past its ceiling writes nothing after a newer turn starts', async () => {
  const clock = new FakeClock()
  let lastOutputAt: number | null = 0
  const { injector, writes, reports } = fixture({
    turnCeilingMs: 50,
    lastOutputAt: () => lastOutputAt,
    clock
  })
  let started!: () => void
  const injectionStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const stale = injector.serializeTile('t1', async (inject) => {
    const attempt = inject('/compact', 1_000)
    started()
    return attempt
  })
  await reachedWithin(injectionStarted, 'the stale injection idle wait')
  let currentStarted!: () => void
  const currentReady = new Promise<void>((resolve) => {
    currentStarted = resolve
  })
  let releaseCurrent!: () => void
  const currentReleased = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  const current = injector.serializeTile('t1', async () => {
    currentStarted()
    await currentReleased
    return 'current-finished'
  })

  for (let i = 0; i < 9; i++) {
    clock.advance(5)
    await Promise.resolve()
  }
  clock.advance(5)
  await reachedWithin(currentReady, 'the newer turn after stale idle wait')
  lastOutputAt = null
  clock.advance(5)
  for (let i = 0; i < 2; i++) await Promise.resolve()
  clock.advance(5)
  const staleError = await stale.then(
    () => '',
    (error) => error instanceof Error ? error.message : String(error)
  )
  releaseCurrent()
  expect(await current).toBe('current-finished')

  expect(staleError).toContain('injection callback refused for t1')
  expect(writes).toEqual([])
  expect(reports).toEqual([
    'injection turn of tile t1 still running after 50 ms; its queue is released',
    'injection callback refused for t1: its turn is no longer current'
  ])
})

test('a turn that ends before the ceiling leaves no trace', async () => {
  const { injector, reports } = fixture({ turnCeilingMs: 50 })
  expect(await injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))).toBe('written')
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(reports).toEqual([])
})

test('an injection inside a sequence waits for idleness no longer than the turn ceiling is sized on', async () => {
  const { injector } = fixture()
  const idleWaits: number[] = []
  injector.injectCommand = async (_id, _command, idleWaitMs) => {
    idleWaits.push(idleWaitMs ?? -1)
    return 'written'
  }
  await withinMs(
    injector.serializeTile('t1', async (inject) => {
      await inject('/compact', 10 * DIRECTIVE_IDLE_WAIT_MS)
      await inject('/compact', 1_000)
      return inject('/compact')
    }),
    1_000,
    'the sequence'
  )
  expect(idleWaits).toEqual([DIRECTIVE_IDLE_WAIT_MS, 1_000, DIRECTIVE_IDLE_WAIT_MS])
})

test('an injection inside a sequence never waits for another turn of its own tile', async () => {
  const { injector } = fixture()
  const outcome = injector.serializeTile('t1', (inject) => inject('/compact'))
  expect(await withinMs(outcome, 1_000, 'an injection inside serializeTile')).toBe('written')
})

test('each refusal writes nothing and names its outcome', async () => {
  for (const [options, expected] of [
    [{ reads: [{ status: 'unavailable' as const, reason: 'screen-fault' as const }] }, 'refused-modal'],
    [{ runtime: { needsAttention: true } }, 'refused-modal'],
    [{ runtime: { rateLimited: true } }, 'refused-modal'],
    [{ lastOutputAt: Date.now() + 60_000 }, 'busy-timeout']
  ] as const) {
    const { injector, writes } = fixture(options)
    expect(await injector.injectCommand('t1', '/compact', 20), JSON.stringify(options)).toBe(expected)
    expect(writes, JSON.stringify(options)).toEqual([])
  }
  const gone = fixture()
  gone.alive.clear()
  expect(await gone.injector.injectCommand('t1', '/compact')).toBe('no-terminal')
})
