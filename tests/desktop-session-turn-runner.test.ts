import { describe, expect, test } from 'bun:test'
import {
  runSequence,
  START_TIMEOUT_MS,
  type RunResult,
  type SequenceHandle,
  type SequenceInput,
  type SequenceRunHost,
  type SequenceStateView,
  type SequenceStepInput
} from '../desktop/src/main/session-turn-runner.ts'
import type { TileHold } from '../desktop/src/main/tile-injector.ts'
import type { TurnSignalEvent } from '../desktop/src/main/turn-signal-server.ts'
import type { DirectiveOutcome } from '../desktop/src/main/session-service.ts'
import type { TurnSignal } from '../desktop/hooks/turn-signal-wire.ts'

const TILE = 'tile-1'
const GENERATION = {}
const NONCES = ['00000000000000a1', '00000000000000b2', '00000000000000c3']

const START: SequenceStepInput = { command: 'kory-session-start', args: '2', commandClass: 'skill' }
const END: SequenceStepInput = { command: 'kory-session-end', commandClass: 'skill' }
const COMPACT: SequenceStepInput = { command: 'compact', commandClass: 'compact' }

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface WorldOptions {
  source?: boolean
  current?: boolean
  deferStart?: boolean
  outcomes?: Array<DirectiveOutcome | Error>
  /** Every injection waits for `settleInject`. */
  holdInject?: boolean
  subscribeThrows?: boolean
  /** holdTile rejects with this error before running the hold. */
  holdRejects?: Error
  /** What the host reports as the tile's background task count; null = unknown. */
  background?: number | null
  stateThrows?: boolean
}

interface FakeTimer {
  ms: number
  callback: () => void
  live: boolean
}

function makeWorld(options: WorldOptions = {}) {
  const order: string[] = []
  const typed: string[] = []
  const injectOptions: unknown[] = []
  const journal: string[] = []
  const errors: string[] = []
  const claims = new Set<string>()
  const timers: FakeTimer[] = []
  const outcomes = [...(options.outcomes ?? [])]
  const counts = { holds: 0, subscribes: 0, unsubscribes: 0, minted: 0 }
  const states: SequenceStateView[] = []
  let background = options.background ?? null
  let listener: ((event: TurnSignalEvent) => void) | null = null
  let revoke!: (reason: string) => void
  const revoked = new Promise<string>((resolve) => {
    revoke = resolve
  })
  let startHold!: () => void
  const gate = options.deferStart
    ? new Promise<void>((resolve) => {
        startHold = resolve
      })
    : Promise.resolve()
  let settleInject!: (error?: Error) => void
  const injectGate = options.holdInject
    ? new Promise<void>((resolve, reject) => {
        settleInject = (error) => (error ? reject(error) : resolve())
      })
    : Promise.resolve()

  const host: SequenceRunHost = {
    holdTile: async (_id, fn) => {
      counts.holds += 1
      await gate
      if (options.holdRejects) throw options.holdRejects
      const hold: TileHold = {
        isCurrent: () => options.current ?? true,
        revoked,
        inject: async (text, injectOpts) => {
          order.push('inject')
          typed.push(text)
          injectOptions.push(injectOpts)
          await injectGate
          const next = outcomes.shift() ?? 'written'
          if (next instanceof Error) throw next
          return next
        }
      }
      return fn(hold)
    },
    subscribe: (_id, next) => {
      order.push('subscribe')
      if (options.subscribeThrows) throw new Error('tile already has a listener')
      counts.subscribes += 1
      listener = next
      return () => {
        counts.unsubscribes += 1
        listener = null
      }
    },
    backgroundTasks: () => background,
    onState: (view) => {
      states.push(view)
      if (options.stateThrows) throw new Error('observer failed')
    },
    life: () => GENERATION,
    hasSource: () => options.source ?? true,
    tryClaim: (id) => {
      if (claims.has(id)) return null
      claims.add(id)
      return () => claims.delete(id)
    },
    clock: {
      setTimeout: (callback, ms) => {
        const timer: FakeTimer = { ms, callback, live: true }
        timers.push(timer)
        return timer as unknown as NodeJS.Timeout
      },
      clearTimeout: (timer) => {
        ;(timer as unknown as FakeTimer).live = false
      }
    },
    mintNonce: () => NONCES[counts.minted++]!,
    journal: (line) => journal.push(line),
    reportError: (message) => errors.push(message)
  }

  return {
    host,
    order,
    typed,
    injectOptions,
    journal,
    errors,
    claims,
    counts,
    states,
    setBackground: (count: number | null) => {
      background = count
    },
    revoke: (reason: string) => revoke(reason),
    startHold: () => startHold(),
    settleInject: (error?: Error) => settleInject(error),
    liveTimers: () => timers.filter((timer) => timer.live),
    fire: (index: number) => {
      const timer = timers[index]!
      timer.live = false
      timer.callback()
    },
    timerMs: () => timers.map((timer) => timer.ms),
    emit: (event: TurnSignalEvent) => listener?.(event),
    signal(signal: TurnSignal, generation: object = GENERATION) {
      listener?.({ type: 'signal', signal, loadId: 'load-1', generation })
    }
  }
}

type World = ReturnType<typeof makeWorld>

/** Module signals with the module-wide counter the engine side keeps. */
function signals(first = 100) {
  let seq = first
  let lastEnter: number | undefined
  return {
    enter: (command: string, args = ''): TurnSignal => {
      lastEnter = ++seq
      return { kind: 'command.run:enter', seq: lastEnter, command, args, origin: 'composer' }
    },
    resolved: (command: string): TurnSignal => ({ kind: 'command.run:resolved', seq: ++seq, command }),
    started: (turnId: string, linked = true): TurnSignal => ({
      kind: 'turn.start',
      seq: ++seq,
      turnId,
      ...(linked && lastEnter !== undefined ? { commandSeq: lastEnter } : {})
    }),
    completed: (
      turnId: string,
      options: { reason?: 'answer' | 'aborted'; backgroundTasks?: number } = {}
    ): TurnSignal => {
      const reason = options.reason ?? 'answer'
      return {
        kind: 'turn.complete',
        seq: ++seq,
        turnId,
        reason,
        isAborted: reason === 'aborted',
        ...(options.backgroundTasks === undefined ? {} : { backgroundTasks: options.backgroundTasks })
      }
    }
  }
}

type Signals = ReturnType<typeof signals>

function watch(handle: SequenceHandle): { value?: RunResult; rejected?: unknown } {
  const box: { value?: RunResult; rejected?: unknown } = {}
  handle.result.then(
    (value) => {
      box.value = value
    },
    (error) => {
      box.rejected = error
    }
  )
  return box
}

async function start(world: World, steps: SequenceStepInput[]) {
  const handle = runSequence(world.host, TILE, { steps } satisfies SequenceInput)
  const result = watch(handle)
  await flush()
  return { handle, result }
}

function enterOf(world: World, s: Signals, index: number): TurnSignal {
  const match = /^\/(\S+) ?(.*)$/.exec(world.typed[index]!)!
  return s.enter(match[1]!, match[2]!)
}

async function openTurn(world: World, s: Signals, index: number, turnId: string): Promise<void> {
  const enter = enterOf(world, s, index)
  world.signal(enter)
  world.signal(s.resolved((enter as { command: string }).command))
  world.signal(s.started(turnId))
  await flush()
}

describe('runSequence', () => {
  test('types the next skill step only after the correlated turn completes, and ends done', async () => {
    const w = makeWorld()
    const s = signals()
    const { result } = await start(w, [START, END])
    expect(w.typed).toEqual([`/kory-session-start 2 kory-step:${NONCES[0]}`])
    expect(w.injectOptions).toEqual([{ escape: false }])

    await openTurn(w, s, 0, 'turn-1')
    expect(w.typed).toHaveLength(1)

    w.signal(s.completed('turn-1', { backgroundTasks: 0 }))
    await flush()
    expect(w.typed).toEqual([`/kory-session-start 2 kory-step:${NONCES[0]}`, `/kory-session-end kory-step:${NONCES[1]}`])
    expect(result.value).toBeUndefined()

    await openTurn(w, s, 1, 'turn-2')
    w.signal(s.completed('turn-2'))
    await flush()
    expect(result.value).toEqual({ status: 'done' })
    expect(w.counts.unsubscribes).toBe(1)
    expect(w.claims.size).toBe(0)
  })

  test('subscribes before the first step is typed', async () => {
    const w = makeWorld()
    await start(w, [START])
    expect(w.order.slice(0, 2)).toEqual(['subscribe', 'inject'])
  })

  test('mints a nonce for skill steps only', async () => {
    const w = makeWorld()
    const s = signals()
    await start(w, [START, COMPACT])
    await openTurn(w, s, 0, 'turn-1')
    w.signal(s.completed('turn-1', { backgroundTasks: 0 }))
    await flush()
    expect(w.counts.minted).toBe(1)
    expect(w.typed[1]).toBe('/compact')
  })

  test('a signal of another PTY generation stops the sequence', async () => {
    const w = makeWorld()
    const s = signals()
    const { result } = await start(w, [START, END])
    w.signal(enterOf(w, s, 0), {})
    await flush()
    expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'revoked' })
    expect(w.typed).toHaveLength(1)
  })

  test('a source change stops the sequence', async () => {
    const w = makeWorld()
    const { result } = await start(w, [START, END])
    w.emit({ type: 'source-changed', loadId: 'other-load', generation: GENERATION })
    await flush()
    expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'source-changed' })
    expect(w.counts.unsubscribes).toBe(1)
  })

  test('a refused signal stops the sequence', async () => {
    const w = makeWorld()
    const { result } = await start(w, [START, END])
    w.emit({ type: 'signal-refused', reason: 'unknown-key', generation: GENERATION })
    await flush()
    expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'signal-refused' })
  })

  test('a revoked hold stops the sequence and nothing is typed afterwards', async () => {
    const w = makeWorld()
    const s = signals()
    const { result } = await start(w, [START, END])
    await openTurn(w, s, 0, 'turn-1')
    w.revoke('pty exited')
    await flush()
    expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'revoked' })
    w.signal(s.completed('turn-1', { backgroundTasks: 0 }))
    await flush()
    expect(w.typed).toHaveLength(1)
    expect(w.counts.unsubscribes).toBe(1)
  })

  test('a hold that is no longer current types nothing and does not subscribe', async () => {
    const w = makeWorld({ current: false })
    const { result } = await start(w, [START])
    expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: false, reason: 'revoked' })
    expect(w.typed).toEqual([])
    expect(w.counts.subscribes).toBe(0)
  })

  test.each(['refused-modal', 'needs-attention', 'rate-limited', 'screen-unavailable', 'busy-timeout', 'no-terminal'] as const)(
    'an injection refused as %s stops the step untyped and is not retried',
    async (outcome) => {
      const w = makeWorld({ outcomes: [outcome] })
      const { result } = await start(w, [START, END])
      expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: false, reason: `injection-${outcome}` })
      expect(w.typed).toHaveLength(1)
      expect(w.liveTimers()).toHaveLength(0)
    }
  )

  test('an injection that throws is reported once, ends the sequence and releases the tile', async () => {
    const w = makeWorld({ outcomes: [new Error('turn no longer current')] })
    const { result } = await start(w, [START])
    expect(result.rejected).toBeUndefined()
    expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: false, reason: 'revoked' })
    expect(w.errors).toHaveLength(1)
    expect(w.errors[0]).toContain('step 1')
    expect(w.claims.size).toBe(0)
  })

  test('an injection that fails after the sequence was cancelled is not reported again', async () => {
    const w = makeWorld({ holdInject: true })
    const { handle, result } = await start(w, [START])
    handle.cancel()
    await flush()
    expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: false, reason: 'operator-cancelled' })
    w.settleInject(new Error('turn no longer current'))
    await flush()
    expect(w.errors).toEqual([])
  })

  test('an injection that fails after the sequence ended done is not reported', async () => {
    const w = makeWorld({ holdInject: true })
    const s = signals()
    const { result } = await start(w, [START])
    await openTurn(w, s, 0, 'turn-1')
    w.signal(s.completed('turn-1'))
    await flush()
    expect(result.value).toEqual({ status: 'done' })
    w.settleInject(new Error('turn no longer current'))
    await flush()
    expect(w.errors).toEqual([])
  })

  test('a subscription that throws is reported and nothing is typed', async () => {
    const w = makeWorld({ subscribeThrows: true })
    const { result } = await start(w, [START])
    expect(result.rejected).toBeUndefined()
    expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: false, reason: 'revoked' })
    expect(w.typed).toEqual([])
    expect(w.errors).toHaveLength(1)
    expect(w.claims.size).toBe(0)
  })

  describe('timers', () => {
    test('one start timer is live per waiting phase and none once the turn runs', async () => {
      const w = makeWorld()
      const s = signals()
      await start(w, [START])
      expect(w.liveTimers()).toHaveLength(1)
      expect(w.timerMs()).toEqual([START_TIMEOUT_MS])

      w.signal(enterOf(w, s, 0))
      await flush()
      expect(w.liveTimers()).toHaveLength(1)
      expect(w.timerMs()).toHaveLength(2)

      w.signal(s.resolved(START.command))
      w.signal(s.started('turn-1'))
      await flush()
      expect(w.liveTimers()).toHaveLength(0)
    })

    test('a start timer that fires before the command is seen stops the sequence with the step typed', async () => {
      const w = makeWorld()
      const { result } = await start(w, [START, END])
      w.fire(0)
      await flush()
      expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'no-command-run' })
    })

    test('an operator cancel leaves no live timer and a late timer callback changes nothing', async () => {
      const w = makeWorld()
      const { handle, result } = await start(w, [START, END])
      expect(w.liveTimers()).toHaveLength(1)
      handle.cancel()
      await flush()
      const stopped: RunResult = { status: 'interrupted', step: 0, typed: true, reason: 'operator-cancelled' }
      expect(result.value).toEqual(stopped)
      expect(w.liveTimers()).toHaveLength(0)
      const journaled = w.journal.length

      w.fire(0)
      await flush()
      expect(result.value).toEqual(stopped)
      expect(w.journal).toHaveLength(journaled)
      expect(w.typed).toHaveLength(1)
    })

    test('a stop while the turn start is awaited leaves no live timer', async () => {
      const w = makeWorld()
      const s = signals()
      const { result } = await start(w, [START, END])
      w.signal(enterOf(w, s, 0))
      expect(w.liveTimers()).toHaveLength(1)
      w.emit({ type: 'signal-refused', reason: 'bad-seq', generation: GENERATION })
      await flush()
      expect(result.value).toMatchObject({ status: 'interrupted', reason: 'signal-refused' })
      expect(w.liveTimers()).toHaveLength(0)
    })
  })

  describe('quiescence', () => {
    async function untilWaiting(w: World, s: Signals) {
      const run = await start(w, [START, END])
      await openTurn(w, s, 0, 'turn-1')
      w.signal(s.completed('turn-1', { backgroundTasks: 2 }))
      await flush()
      return run
    }

    test('waits while background tasks run and types the next step once none is left', async () => {
      const w = makeWorld()
      const s = signals()
      await untilWaiting(w, s)
      expect(w.typed).toHaveLength(1)
      expect(w.journal).toEqual([`sequence on tile ${TILE}: step 2 waits for background tasks (2)`])

      w.signal(s.started('turn-bg', false))
      w.signal(s.completed('turn-bg', { backgroundTasks: 0 }))
      await flush()
      expect(w.typed).toHaveLength(2)
    })

    test('override types the next step without waiting', async () => {
      const w = makeWorld()
      const s = signals()
      const { handle } = await untilWaiting(w, s)
      handle.override()
      await flush()
      expect(w.typed).toHaveLength(2)
    })

    test('cancel stops the wait with the next step untyped', async () => {
      const w = makeWorld()
      const s = signals()
      const { handle, result } = await untilWaiting(w, s)
      handle.cancel()
      await flush()
      expect(result.value).toEqual({ status: 'interrupted', step: 1, typed: false, reason: 'operator-cancelled' })
      expect(w.typed).toHaveLength(1)
    })
  })

  test('cancel before the hold starts types nothing', async () => {
    const w = makeWorld({ deferStart: true })
    const handle = runSequence(w.host, TILE, { steps: [START] })
    const result = watch(handle)
    handle.cancel()
    w.startHold()
    await flush()
    expect(result.value).toEqual({ status: 'interrupted', step: 0, typed: false, reason: 'operator-cancelled' })
    expect(w.typed).toEqual([])
    expect(w.claims.size).toBe(0)

    const third = runSequence(w.host, TILE, { steps: [END] })
    const accepted = watch(third)
    await flush()
    expect(accepted.value).toBeUndefined()
    expect(w.counts.holds).toBe(2)
    third.cancel()
  })

  test('a hold that rejects rejects the result and releases the tile', async () => {
    const failure = new Error('hold failed')
    const w = makeWorld({ holdRejects: failure })
    const { result } = await start(w, [START])
    expect(result.rejected).toBe(failure)
    expect(result.value).toBeUndefined()
    expect(w.claims.size).toBe(0)
  })

  describe('refusals before any hold', () => {
    test('a tile without a turn signal source is refused', async () => {
      const w = makeWorld({ source: false })
      const { result } = await start(w, [START])
      expect(result.value).toEqual({ status: 'refused', reason: 'no-source' })
      expect(w.counts.holds).toBe(0)
      expect(w.claims.size).toBe(0)
    })

    test('a second sequence on a claimed tile is refused, and the tile is free again once the first ends', async () => {
      const w = makeWorld()
      const first = await start(w, [START])
      const second = watch(runSequence(w.host, TILE, { steps: [END] }))
      await flush()
      expect(second.value).toEqual({ status: 'refused', reason: 'sequence-active' })
      expect(w.counts.holds).toBe(1)

      first.handle.cancel()
      await flush()
      expect(first.result.value).toMatchObject({ status: 'interrupted' })
      const third = runSequence(w.host, TILE, { steps: [END] })
      await flush()
      expect(w.counts.holds).toBe(2)
      third.cancel()
    })

    test('a command declared with two classes is refused', async () => {
      const w = makeWorld()
      const { result } = await start(w, [{ command: 'x', commandClass: 'skill' }, { command: 'x', commandClass: 'compact' }])
      expect(result.value).toEqual({ status: 'refused', reason: 'bad-plan' })
      expect(w.counts.holds).toBe(0)
    })
  })

  describe('journal', () => {
    test('a finished sequence leaves one line with the tile and no command text, args or nonce', async () => {
      const w = makeWorld()
      const s = signals()
      const secret: SequenceStepInput = { command: 'kory-session-start', args: 'SECRET-ARG', commandClass: 'skill' }
      await start(w, [secret])
      await openTurn(w, s, 0, 'turn-1')
      w.signal(s.completed('turn-1'))
      await flush()
      expect(w.journal).toEqual([`sequence on tile ${TILE}: done, 1 step`])
    })

    test('a stopped sequence names the step and the reason', async () => {
      const w = makeWorld()
      const s = signals()
      await start(w, [START, END])
      await openTurn(w, s, 0, 'turn-1')
      w.signal(s.completed('turn-1', { reason: 'aborted' }))
      await flush()
      expect(w.journal).toEqual([`sequence on tile ${TILE}: stopped at step 1 of 2 (turn-aborted), typed`])
    })

    test('a refusal is journaled with its reason', async () => {
      const w = makeWorld({ source: false })
      await start(w, [START])
      expect(w.journal).toEqual([`sequence on tile ${TILE}: refused (no-source)`])
    })
  })
})

describe('start quiescence and state view', () => {
  test.each([null, 0])('types step 1 at once when the host reports %p background tasks', async (background) => {
    const w = makeWorld({ background })
    await start(w, [START])
    expect(w.typed).toHaveLength(1)
    expect(w.journal).toEqual([])
  })

  test('waits before step 1 while the host reports background tasks, and an override types it', async () => {
    const w = makeWorld({ background: 2 })
    const { handle } = await start(w, [START])
    expect(w.typed).toEqual([])
    expect(w.journal).toEqual([`sequence on tile ${TILE}: step 1 waits for background tasks (2)`])
    handle.override()
    await flush()
    expect(w.typed).toHaveLength(1)
  })

  test('reads the count when the hold starts, not when the run is requested', async () => {
    const w = makeWorld({ background: 0, deferStart: true })
    const handle = runSequence(w.host, TILE, { steps: [START] })
    w.setBackground(3)
    w.startHold()
    await flush()
    expect(w.typed).toEqual([])
    handle.cancel()
    await flush()
  })

  test('reports running for each step it types and done at the end', async () => {
    const w = makeWorld()
    const s = signals()
    await start(w, [START, END])
    await openTurn(w, s, 0, 'turn-1')
    w.signal(s.completed('turn-1', { backgroundTasks: 0 }))
    await flush()
    await openTurn(w, s, 1, 'turn-2')
    w.signal(s.completed('turn-2'))
    await flush()
    const base = { tileId: TILE, total: 2, background: null, reason: null }
    expect(w.states).toEqual([
      { ...base, step: 0, phase: 'running' },
      { ...base, step: 1, phase: 'running' },
      { ...base, step: 2, phase: 'done' }
    ])
  })

  test('reports waiting-background with the count it waits on, at the start and after a turn', async () => {
    const w = makeWorld({ background: 2 })
    const s = signals()
    const { handle } = await start(w, [START, END])
    expect(w.states).toEqual([{ tileId: TILE, step: 0, total: 2, phase: 'waiting-background', background: 2, reason: null }])
    handle.override()
    await flush()
    await openTurn(w, s, 0, 'turn-1')
    w.signal(s.completed('turn-1', { backgroundTasks: 3 }))
    await flush()
    expect(w.states.at(-1)).toEqual({ tileId: TILE, step: 1, total: 2, phase: 'waiting-background', background: 3, reason: null })
  })

  test('reports stopped with the step and the reason', async () => {
    const w = makeWorld({ background: 1 })
    const { handle } = await start(w, [START, END])
    handle.cancel()
    await flush()
    expect(w.states.at(-1)).toEqual({ tileId: TILE, step: 0, total: 2, phase: 'stopped', background: null, reason: 'operator-cancelled' })
  })

  test('an observer that throws is reported and does not stop the sequence', async () => {
    const w = makeWorld({ stateThrows: true })
    const s = signals()
    const { result } = await start(w, [START])
    await openTurn(w, s, 0, 'turn-1')
    w.signal(s.completed('turn-1'))
    await flush()
    expect(result.value).toEqual({ status: 'done' })
    expect(w.errors).toEqual(Array(2).fill(`sequence on tile ${TILE}: state observer failed`))
  })

  test('a run refused before the hold reports no state', async () => {
    const w = makeWorld({ source: false })
    await start(w, [START])
    expect(w.states).toEqual([])
  })
})
