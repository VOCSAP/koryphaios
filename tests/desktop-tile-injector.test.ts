import { expect, test } from 'bun:test'
import { TileInjector, type InjectorClock, type InjectorScreen, type TileHold } from '../desktop/src/main/tile-injector.ts'
import { DIRECTIVE_IDLE_WAIT_MS, runClearReloadInTurn } from '../desktop/src/main/directive-run.ts'
import { composerState, inspectInjectGuard, type XtermScreenRead } from '../desktop/src/main/xterm-screen.ts'
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

const clearScreen = (typed = ''): XtermScreenRead => {
  const lines = Array<string>(40).fill('')
  lines[0] = String.fromCodePoint(0x2500).repeat(120)
  lines[1] = `${String.fromCodePoint(0x276f)}${typed}`
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
  return {
    injector,
    writes,
    reports,
    logs,
    alive,
    respawn: () => {
      life = {}
    }
  }
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

  expect(await injector.injectCommand('t1', '/clear')).toBe('screen-unavailable')
  expect(commands(writes)).toEqual(['ESC'])
  expect(logs).toEqual(['command injection screen-unavailable for t1: screen-pending'])
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
    [{ reads: [{ status: 'unavailable' as const, reason: 'screen-fault' as const }] }, 'screen-unavailable'],
    [{ runtime: { needsAttention: true } }, 'needs-attention'],
    [{ runtime: { rateLimited: true } }, 'rate-limited'],
    [{ runtime: { needsAttention: true, rateLimited: true } }, 'needs-attention'],
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

/** A hold of tile t1 that stays open until `finish`, and the turn queued behind it. */
async function openHold(injector: TileInjector) {
  let hold!: TileHold
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const held = injector.holdTile('t1', async (h) => {
    hold = h
    started()
    await finished
    return 'hold-finished'
  })
  await reachedWithin(ready, 'the hold start')
  return { hold, held, finish }
}

const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test('a hold is not released at the turn ceiling and can still write well past it', async () => {
  const clock = new FakeClock()
  const { injector, writes, reports } = fixture({ turnCeilingMs: 50, clock })
  const { hold, held, finish } = await openHold(injector)
  let nextStarted = false
  const next = injector.inTurn('t1', async () => {
    nextStarted = true
    return 'next-finished'
  })

  clock.advance(500)
  await microtasks()
  expect(nextStarted, 'the queued turn waits behind the hold').toBe(false)
  expect(hold.isCurrent()).toBe(true)
  const attempt = hold.inject('/clear')
  await microtasks()
  clock.advance(5)
  expect(await attempt).toBe('written')
  expect(commands(writes)).toEqual(['ESC', '/clear'])
  expect(reports).toEqual([])

  finish()
  expect(await held).toBe('hold-finished')
  expect(await next).toBe('next-finished')
})

test('revoking a hold refuses its later writes and starts the turn queued behind it', async () => {
  const { injector, writes, reports, logs } = fixture()
  const { hold, held, finish } = await openHold(injector)
  let nextStarted = false
  const next = injector.inTurn('t1', async () => {
    nextStarted = true
    return 'next-finished'
  })

  expect(injector.revokeHold('t1', 'operator typed')).toBe(true)
  expect(await reachedWithin(next, 'the turn queued behind a revoked hold')).toBe('next-finished')
  expect(nextStarted).toBe(true)
  expect(hold.isCurrent()).toBe(false)
  const refused = await hold.inject('/clear').then(
    () => '',
    (error) => (error instanceof Error ? error.message : String(error))
  )
  expect(refused).toContain('injection callback refused for t1')
  expect(writes).toEqual([])
  expect(logs).toEqual(['hold of tile t1 revoked: operator typed'])
  expect(reports).toEqual(['injection callback refused for t1: its turn is no longer current'])

  finish()
  expect(await held).toBe('hold-finished')
})

test('a revoked hold cannot write even when no turn is queued behind it', async () => {
  const { injector, writes } = fixture()
  const { hold, held, finish } = await openHold(injector)

  expect(injector.revokeHold('t1', 'operator typed')).toBe(true)
  expect(hold.isCurrent()).toBe(false)
  await expect(hold.inject('/clear')).rejects.toThrow('injection callback refused for t1')
  expect(writes).toEqual([])

  finish()
  await held
})

test('a revoked hold that finishes late leaves the newer hold current and revocable', async () => {
  const { injector } = fixture()
  const first = await openHold(injector)

  expect(injector.revokeHold('t1', 'first revoked')).toBe(true)
  const second = await openHold(injector)
  first.finish()
  expect(await first.held).toBe('hold-finished')

  expect(second.hold.isCurrent()).toBe(true)
  expect(injector.revokeHold('t1', 'second revoked')).toBe(true)
  expect(second.hold.isCurrent()).toBe(false)
  second.finish()
  expect(await second.held).toBe('hold-finished')
})

test('revokeHold does nothing without a hold, and never ends an ordinary turn', async () => {
  const { injector } = fixture()
  expect(injector.revokeHold('t1', 'nothing running')).toBe(false)

  let current!: () => boolean
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const turn = injector.inTurn('t1', async (isCurrent) => {
    current = isCurrent
    started()
    await finished
    return 'turn-finished'
  })
  await reachedWithin(ready, 'the ordinary turn start')

  expect(injector.revokeHold('t1', 'not a hold')).toBe(false)
  expect(current()).toBe(true)
  finish()
  expect(await turn).toBe('turn-finished')
  expect(injector.revokeHold('t1', 'after the turn')).toBe(false)
})

test('a hold whose callback fails still releases the tile and its record', async () => {
  const { injector } = fixture()
  const failed = injector.holdTile('t1', async () => {
    throw new Error('hold callback failed')
  })
  await expect(failed).rejects.toThrow('hold callback failed')

  expect(injector.revokeHold('t1', 'after the failure')).toBe(false)
  expect(await injector.inTurn('t1', async () => 'next-finished')).toBe('next-finished')
})

test('an injection with escape false types the command and writes no Escape', async () => {
  const { injector, writes } = fixture()

  const outcome = await injector.holdTile('t1', (hold) => hold.inject('/clear', { escape: false }))

  expect(outcome).toBe('written')
  expect(commands(writes)).toEqual(['/clear'])
})

test('an injection with escape false is refused like any other, a revoked hold included', async () => {
  for (const [options, expected] of [
    [{ runtime: { needsAttention: true } }, 'needs-attention'],
    [{ runtime: { rateLimited: true } }, 'rate-limited'],
    [{ lastOutputAt: Date.now() + 60_000 }, 'busy-timeout'],
    [{ replaceLifeDuringIdleWait: true }, 'no-terminal']
  ] as const) {
    const { injector, writes } = fixture(options)
    const outcome = await injector.holdTile('t1', (hold) => hold.inject('/clear', { idleWaitMs: 20, escape: false }))
    expect(outcome, JSON.stringify(options)).toBe(expected)
    expect(writes, JSON.stringify(options)).toEqual([])
  }

  const { injector, writes } = fixture()
  const { hold, held, finish } = await openHold(injector)
  injector.revokeHold('t1', 'stop')
  await expect(hold.inject('/clear', { escape: false })).rejects.toThrow('injection callback refused for t1')
  expect(writes).toEqual([])
  finish()
  await held
})

const refusalMessage = (attempt: Promise<unknown>) =>
  reachedWithin(
    attempt.then(
      () => '',
      (error) => (error instanceof Error ? error.message : String(error))
    ),
    'the injection outcome'
  )

test('a hold revoked while its injection waits for the tile to go idle writes nothing, with or without Escape', async () => {
  for (const escape of [true, false]) {
    let revoke = (): void => undefined
    let polls = 0
    const { injector, writes } = fixture({
      lastOutputAt: () => {
        if (polls++ > 0) return null
        revoke()
        return Date.now()
      }
    })
    const { hold, held, finish } = await openHold(injector)
    revoke = () => void injector.revokeHold('t1', 'operator typed')

    const message = await refusalMessage(hold.inject('/clear', { escape, idleWaitMs: 1000 }))

    expect(message, `escape ${escape}`).toContain('injection callback refused for t1')
    expect(polls, `escape ${escape}: the revocation came during the idle wait`).toBeGreaterThan(1)
    expect(writes, `escape ${escape}`).toEqual([])
    finish()
    await held
  }
})

test('a hold revoked while the Escape settles never types its command', async () => {
  const clock = new FakeClock()
  const { injector, writes } = fixture({ clock })
  const { hold, held, finish } = await openHold(injector)

  const outcome = refusalMessage(hold.inject('/clear'))
  await microtasks()
  expect(writes, 'the Escape is written and the settle delay is running').toEqual(['ESC'])
  injector.revokeHold('t1', 'operator typed')
  clock.advance(5)

  expect(await outcome).toContain('injection callback refused for t1')
  expect(commands(writes)).toEqual(['ESC'])
  finish()
  await held
})

test('a hold that ends while its injection waits for the tile to go idle is logged, not reported as an error', async () => {
  for (const end of ['revoked', 'settled'] as const) {
    let endHold = (): void => undefined
    let polls = 0
    const { injector, writes, reports, logs } = fixture({
      lastOutputAt: () => {
        if (polls++ > 0) return null
        endHold()
        return Date.now()
      }
    })
    const { hold, held, finish } = await openHold(injector)
    endHold = end === 'revoked' ? () => void injector.revokeHold('t1', 'operator typed') : finish

    const message = await refusalMessage(hold.inject('/clear', { escape: false, idleWaitMs: 1000 }))
    finish()
    await held

    expect(message, end).toContain('injection callback refused for t1')
    expect(writes, end).toEqual([])
    expect(reports, end).toEqual([])
    expect(logs, end).toContain('injection callback refused for t1: its turn is no longer current')
  }
})

test('a hold revoked while the Escape settles is logged, not reported as an error', async () => {
  const clock = new FakeClock()
  const { injector, reports, logs } = fixture({ clock })
  const { hold, held, finish } = await openHold(injector)

  const outcome = refusalMessage(hold.inject('/clear'))
  await microtasks()
  injector.revokeHold('t1', 'operator typed')
  clock.advance(5)

  expect(await outcome).toContain('injection callback refused for t1')
  expect(reports).toEqual([])
  expect(logs).toContain('injection callback refused for t1: its turn is no longer current')
  finish()
  await held
})

test('a turn without a hold still reports a stale injection on a tile that held one before', async () => {
  const clock = new FakeClock()
  let lastOutputAt: number | null = 0
  const { injector, writes, reports, logs } = fixture({
    turnCeilingMs: 50,
    lastOutputAt: () => lastOutputAt,
    clock
  })
  const earlier = await openHold(injector)
  earlier.finish()
  await earlier.held

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
    (error) => (error instanceof Error ? error.message : String(error))
  )
  releaseCurrent()
  expect(await current).toBe('current-finished')

  expect(staleError).toContain('injection callback refused for t1')
  expect(writes).toEqual([])
  expect(reports).toEqual([
    'injection turn of tile t1 still running after 50 ms; its queue is released',
    'injection callback refused for t1: its turn is no longer current'
  ])
  expect(logs).not.toContain('injection callback refused for t1: its turn is no longer current')
})

test('an injection with escape false refuses a draft that appeared while it waited for the tile to go idle', async () => {
  let draft = false
  let polls = 0
  const { injector, writes, logs } = fixture({
    screen: { read: () => clearScreen(draft ? ' half a thought' : '') },
    lastOutputAt: () => {
      if (polls++ > 0) return null
      draft = true
      return Date.now()
    }
  })

  const outcome = await injector.holdTile('t1', (hold) => hold.inject('/clear', { escape: false, idleWaitMs: 1000 }))

  expect(outcome).toBe('refused-modal')
  expect(writes).toEqual([])
  expect(logs.some((line) => line.includes('draft-present'))).toBe(true)
  expect(logs.join('\n')).not.toContain('half a thought')
})

test('an injection with escape false reads the composer again right before it writes', async () => {
  const draft = clearScreen(' half a thought')
  const { injector, writes, logs } = fixture({ reads: [clearScreen(), draft] })

  const outcome = await injector.holdTile('t1', (hold) => hold.inject('/clear', { escape: false }))

  expect(outcome).toBe('refused-modal')
  expect(writes).toEqual([])
  expect(logs.some((line) => line.includes('draft-present'))).toBe(true)
})

test('an injection with escape false refuses a screen the guard calls clear but whose composer is unknown', async () => {
  const rule = String.fromCodePoint(0x2500).repeat(120)
  const lines = Array<string>(40).fill('')
  for (const top of [0, 5]) {
    lines[top] = rule
    lines[top + 1] = String.fromCodePoint(0x276f)
    lines[top + 2] = rule
  }
  const snapshot = { cols: 120, rows: 40, lines, cursor: { x: 0, y: 6 }, revision: 1 }
  expect(inspectInjectGuard(snapshot), 'the premise: the guard alone would let the write through').toEqual({ state: 'clear' })
  expect(composerState(snapshot)).toBe('unknown')
  const { injector, writes, logs } = fixture({ screen: { read: () => ({ status: 'ready', snapshot }) } })

  const outcome = await injector.holdTile('t1', (hold) => hold.inject('/clear', { escape: false }))

  expect(outcome).toBe('refused-modal')
  expect(writes).toEqual([])
  expect(logs.some((line) => line.includes('draft-present, composer unknown'))).toBe(true)
})

test('revokeHold resolves the revoked promise of the hold with its reason', async () => {
  const { injector } = fixture()
  const { hold, held, finish } = await openHold(injector)

  expect(injector.revokeHold('t1', 'pty exited')).toBe(true)

  expect(await reachedWithin(hold.revoked, 'the revoked promise')).toBe('pty exited')
  finish()
  await held
})

test('a hold that ends any other way never resolves its revoked promise, and revoking another hold does not either', async () => {
  const { injector } = fixture()
  const first = await openHold(injector)
  let firstRevoked = false
  void first.hold.revoked.then(() => {
    firstRevoked = true
  })
  first.finish()
  await first.held
  await microtasks()
  expect(firstRevoked, 'a hold that settled by itself').toBe(false)
  expect(injector.revokeHold('t1', 'too late')).toBe(false)
  await microtasks()
  expect(firstRevoked, 'a revocation after its end').toBe(false)

  const second = await openHold(injector)
  const secondRevoked: string[] = []
  void second.hold.revoked.then((reason) => {
    secondRevoked.push(reason)
  })
  injector.revokeHold('t1', 'second only')
  const thirdHold = await openHold(injector)
  let thirdRevoked = false
  void thirdHold.hold.revoked.then(() => {
    thirdRevoked = true
  })
  await microtasks()
  expect(secondRevoked).toEqual(['second only'])
  expect(thirdRevoked, 'the next hold is not revoked by its predecessor').toBe(false)
  second.finish()
  thirdHold.finish()
  await Promise.all([second.held, thirdHold.held])
})

test('an injection that sends the Escape does not read the composer: a draft there is not its concern', async () => {
  const { injector, writes } = fixture({ screen: { read: () => clearScreen(' half a thought') } })

  const outcome = await injector.holdTile('t1', (hold) => hold.inject('/clear', { escape: true }))

  expect(outcome).toBe('written')
  expect(commands(writes)).toEqual(['ESC', '/clear'])
})

test('an injection with escape false on an empty composer is written, and an unreadable screen refuses it', async () => {
  const empty = fixture()
  expect(await empty.injector.holdTile('t1', (hold) => hold.inject('/clear', { escape: false }))).toBe('written')

  const unreadable = fixture({ reads: [clearScreen(), { status: 'unavailable', reason: 'no screen' } as unknown as XtermScreenRead] })
  expect(await unreadable.injector.holdTile('t1', (hold) => hold.inject('/clear', { escape: false }))).toBe('screen-unavailable')
  expect(unreadable.writes).toEqual([])
})

test('a hold injects nothing once the tile runs another PTY than the one it started on', async () => {
  const { injector, writes, respawn } = fixture()
  const { hold, held, finish } = await openHold(injector)

  respawn()

  expect(await hold.inject('/clear')).toBe('no-terminal')
  expect(await hold.inject('/clear', { escape: false })).toBe('no-terminal')
  expect(writes).toEqual([])
  finish()
  await held

  const gone = fixture()
  gone.alive.delete('t1')
  expect(await gone.injector.holdTile('t1', (hold2) => hold2.inject('/clear'))).toBe('no-terminal')
})

function queueBehindTurn(injector: TileInjector) {
  let finishTurn!: () => void
  const turnDone = new Promise<void>((resolve) => {
    finishTurn = resolve
  })
  const turn = injector.inTurn('t1', () => turnDone)
  const seen: { hold?: TileHold; injected?: string } = {}
  const queued = injector.holdTile('t1', async (hold) => {
    seen.hold = hold
    seen.injected = await hold.inject('/clear').then(
      (outcome) => outcome,
      (error) => (error instanceof Error ? error.message : String(error))
    )
    return 'hold-ran'
  })
  return { turn, queued, seen, finishTurn }
}

test('a hold revoked while queued starts revoked and writes nothing', async () => {
  const { injector, writes } = fixture()
  const { turn, queued, seen, finishTurn } = queueBehindTurn(injector)

  expect(injector.revokeHold('t1', 'session closing'), 'no hold was running').toBe(false)
  finishTurn()
  await turn
  expect(await reachedWithin(queued, 'the queued hold')).toBe('hold-ran')

  expect(await reachedWithin(seen.hold!.revoked, 'the revoked promise')).toBe('session closing')
  expect(seen.hold!.isCurrent()).toBe(false)
  expect(seen.injected).toContain('injection callback refused for t1')
  expect(writes).toEqual([])
  expect(await reachedWithin(injector.inTurn('t1', async () => 'next-finished'), 'the turn after it')).toBe('next-finished')
})

test('every hold queued when the revocation comes starts revoked, with the last reason', async () => {
  const { injector, writes } = fixture()
  const first = queueBehindTurn(injector)
  const second = injector.holdTile('t1', async (hold) => ({ revoked: await reachedWithin(hold.revoked, 'the second revoked promise') }))

  injector.revokeHold('t1', 'first reason')
  injector.revokeHold('t1', 'last reason')
  first.finishTurn()
  await first.turn
  await reachedWithin(first.queued, 'the first queued hold')

  expect(await reachedWithin(first.seen.hold!.revoked, 'the first revoked promise')).toBe('last reason')
  expect(await reachedWithin(second, 'the second queued hold')).toEqual({ revoked: 'last reason' })
  expect(writes).toEqual([])
})

test('a hold called after a revocation is not affected by it', async () => {
  const { injector, writes } = fixture()
  expect(injector.revokeHold('t1', 'nothing running')).toBe(false)

  const { hold, held, finish } = await openHold(injector)

  expect(hold.isCurrent()).toBe(true)
  expect(await hold.inject('/clear', { escape: false })).toBe('written')
  expect(commands(writes)).toEqual(['/clear'])
  finish()
  await held
})

test('a hold queued across a respawn of its tile refuses to write on the new PTY', async () => {
  const { injector, writes, respawn } = fixture()
  const { turn, queued, seen, finishTurn } = queueBehindTurn(injector)

  respawn()
  finishTurn()
  await turn
  await reachedWithin(queued, 'the queued hold')

  expect(seen.injected).toBe('no-terminal')
  expect(writes).toEqual([])
})
