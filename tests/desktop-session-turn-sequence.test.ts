import { describe, expect, test } from 'bun:test'
import {
  reduceSequence,
  startSequence,
  stepArgs,
  stepText,
  type CommandTable,
  type PlanStep,
  type SequenceEffect,
  type SequenceEvent,
  type SequencePlan,
  type SequenceResult,
  type SequenceState,
  type SequenceStopReason
} from '../desktop/src/main/session-turn-sequence.ts'
import type { TurnSignal } from '../desktop/hooks/turn-signal-wire.ts'

const START = 'kory-session-start'
const END = 'kory-session-end'
const NONCE_A = 'a1b2c3d4e5f60718'
const NONCE_B = '0f1e2d3c4b5a6978'

const TABLE: CommandTable = {
  [START]: 'skill',
  [END]: 'skill',
  compact: 'compact',
  context: 'locale',
  clear: 'locale',
  help: 'dialogue',
  model: 'dialogue'
}

const skillA: PlanStep = { command: START, args: '2', nonce: NONCE_A }
const skillB: PlanStep = { command: END, nonce: NONCE_B }
const plan = (steps: PlanStep[], startQuiet = true): SequencePlan => ({ steps, table: TABLE, startQuiet })

/** Module signals with the module-wide counter the engine side keeps. */
function signals(first = 100) {
  let seq = first
  let lastEnter: number | undefined
  return {
    enter: (command: string, args = '', origin = 'composer'): TurnSignal => {
      lastEnter = ++seq
      return { kind: 'command.run:enter', seq: lastEnter, command, args, origin }
    },
    resolved: (command: string): TurnSignal => ({ kind: 'command.run:resolved', seq: ++seq, command }),
    /** A turn.start linked to the last command.run:enter unless `commandSeq` says otherwise (null: no link). */
    started: (turnId: string, agentId?: string, commandSeq?: number | null): TurnSignal => {
      const link = commandSeq === undefined ? lastEnter : (commandSeq ?? undefined)
      return {
        kind: 'turn.start',
        seq: ++seq,
        turnId,
        ...(agentId ? { agentId } : {}),
        ...(link === undefined ? {} : { commandSeq: link })
      }
    },
    completed: (
      turnId: string,
      options: { reason?: 'answer' | 'aborted' | 'refusal' | 'error'; agentId?: string; backgroundTasks?: number } = {}
    ): TurnSignal => {
      const reason = options.reason ?? 'answer'
      return {
        kind: 'turn.complete',
        seq: ++seq,
        turnId,
        reason,
        isAborted: reason === 'aborted',
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.backgroundTasks === undefined ? {} : { backgroundTasks: options.backgroundTasks })
      }
    },
    compacted: (): TurnSignal => ({ kind: 'session.compact:resolved', seq: ++seq }),
    ended: (reason: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other'): TurnSignal => ({ kind: 'session.end', seq: ++seq, reason })
  }
}

function drive(initial: SequencePlan) {
  const first = startSequence(initial)
  let state: SequenceState = first.state
  const effects: SequenceEffect[] = [...first.effects]
  return {
    get state() {
      return state
    },
    effects,
    send(event: SequenceEvent) {
      const transition = reduceSequence(state, event)
      state = transition.state
      effects.push(...transition.effects)
      return transition
    },
    signal(signal: TurnSignal) {
      return this.send({ type: 'signal', signal })
    },
    /** Effects of one kind, in order. */
    of<K extends SequenceEffect['type']>(type: K) {
      return effects.filter((effect): effect is Extract<SequenceEffect, { type: K }> => effect.type === type)
    }
  }
}

type Run = ReturnType<typeof drive>

/** A skill step typed and correlated, its turn T started and nothing else: enter, resolved, turn.start, in the engine's order. */
function inTurn(run: Run, s: ReturnType<typeof signals>, step: PlanStep, turnId: string, index = 0): void {
  run.send({ type: 'submitted', step: index })
  run.signal(s.enter(step.command, stepArgs(step)))
  run.signal(s.resolved(step.command))
  run.signal(s.started(turnId))
}

const stopped = (run: Run): SequenceStopReason | null => {
  const state = run.state
  return state.status === 'interrupted' || state.status === 'refused' ? state.reason : null
}

describe('preflight', () => {
  const refused = (steps: PlanStep[], reason: SequenceStopReason) => {
    const { state, effects } = startSequence(plan(steps))
    expect(state).toEqual({ status: 'refused', reason })
    expect(effects).toEqual([{ type: 'finish', result: { status: 'refused', reason } }])
  }

  test('an empty plan, an unknown command and a dialogue command are refused before anything is typed', () => {
    refused([], 'empty-plan')
    refused([{ command: 'nosuch' }], 'unknown-command')
    refused([skillA, { command: 'constructor' }], 'unknown-command')
    refused([{ command: 'help' }], 'dialogue-command')
    refused([skillA, { command: 'model' }], 'dialogue-command')
  })

  test('a skill needs a well formed nonce and no other class may carry one', () => {
    refused([{ command: START }], 'bad-nonce')
    refused([{ command: START, nonce: 'xyz' }], 'bad-nonce')
    refused([{ command: START, nonce: 'A1B2C3D4E5F60718' }], 'bad-nonce')
    refused([{ command: 'compact', nonce: NONCE_A }], 'bad-nonce')
    refused([{ command: 'context', nonce: NONCE_A }], 'bad-nonce')
  })

  test('a step the wire could not carry back is refused', () => {
    refused([{ command: START, args: 'x'.repeat(256), nonce: NONCE_A }], 'step-too-long')
    refused([{ command: 'compact', args: 'x'.repeat(257) }], 'step-too-long')
    expect(startSequence(plan([{ command: 'compact', args: 'x'.repeat(256) }])).state.status).toBe('running')
  })

  test('the args and the text of a skill step end with its nonce token, other classes carry none', () => {
    expect(stepArgs(skillA)).toBe(`2 kory-step:${NONCE_A}`)
    expect(stepText(skillA)).toBe(`/${START} 2 kory-step:${NONCE_A}`)
    expect(stepText(skillB)).toBe(`/${END} kory-step:${NONCE_B}`)
    expect(stepText({ command: 'compact' })).toBe('/compact')
    expect(stepText({ command: 'compact', args: 'keep the plan' })).toBe('/compact keep the plan')
  })

  test('a quiet start types the first step, a busy one waits for quiescence first', () => {
    const quiet = startSequence(plan([skillA]))
    expect(quiet.effects).toEqual([{ type: 'submit', step: 0, text: stepText(skillA) }])
    const busy = startSequence(plan([skillA], false))
    expect(busy.effects).toEqual([{ type: 'waiting-quiescence', step: 0, background: null }])
  })
})

describe('a skill step', () => {
  test('typing it proves nothing: it ends on the turn.complete of its own turn', () => {
    const run = drive(plan([skillA]))
    const s = signals()
    run.send({ type: 'submitted', step: 0 })
    expect(run.state.status).toBe('running')
    run.signal(s.enter(START, stepArgs(skillA)))
    expect(run.state.status).toBe('running')
    run.signal(s.started('T1'))
    expect(run.state.status).toBe('running')
    run.signal(s.completed('T1', { backgroundTasks: 0 }))
    expect(run.state).toEqual({ status: 'done' })
    expect(run.of('finish')).toEqual([{ type: 'finish', result: { status: 'done' } }])
  })

  test('the command.run is correlated by origin, name and the exact args with the nonce', () => {
    const wrong: Array<[string, (s: ReturnType<typeof signals>) => TurnSignal]> = [
      ['another origin', (s) => s.enter(START, stepArgs(skillA), 'plugin')],
      ['another command', (s) => s.enter(END, stepArgs(skillA))],
      ['no nonce', (s) => s.enter(START, '2')],
      ['another nonce', (s) => s.enter(START, `2 kory-step:${NONCE_B}`)],
      ['no args at all', (s) => s.enter(START, '')]
    ]
    for (const [name, make] of wrong) {
      const run = drive(plan([skillA]))
      run.send({ type: 'submitted', step: 0 })
      run.signal(make(signals()))
      expect(run.state, name).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'foreign-command' })
    }
  })

  test('a command.run that arrives before the written event still correlates, and the late event changes nothing', () => {
    const run = drive(plan([skillA]))
    const s = signals()
    run.signal(s.enter(START, stepArgs(skillA)))
    run.signal(s.started('T1'))
    run.send({ type: 'submitted', step: 0 })
    expect(run.of('arm-start-timer')).toHaveLength(1)
    run.signal(s.completed('T1', { backgroundTasks: 0 }))
    expect(run.state).toEqual({ status: 'done' })
  })

  test('only the first main turn.start after the correlated command counts, a sub-agent never does', () => {
    const run = drive(plan([skillA]))
    const s = signals()
    run.send({ type: 'submitted', step: 0 })
    run.signal(s.enter(START, stepArgs(skillA)))
    run.signal(s.started('SUB', 'agent-1'))
    run.signal(s.started('T1'))
    run.signal(s.completed('T1', { agentId: 'agent-1', backgroundTasks: 0 }))
    expect(run.state.status, 'a sub-agent complete with the same turnId is not ours').toBe('running')
    run.signal(s.completed('SUB', { agentId: 'agent-1', backgroundTasks: 0 }))
    expect(run.state.status).toBe('running')
    run.signal(s.completed('T1', { backgroundTasks: 0 }))
    expect(run.state).toEqual({ status: 'done' })
  })

  test('another turnId, a complete before the start, or a second main turn interrupts', () => {
    const mismatch = drive(plan([skillA]))
    const a = signals()
    inTurn(mismatch, a, skillA, 'T1')
    mismatch.signal(a.completed('T0', { backgroundTasks: 0 }))
    expect(stopped(mismatch)).toBe('turn-mismatch')

    const early = drive(plan([skillA]))
    const b = signals()
    early.send({ type: 'submitted', step: 0 })
    early.signal(b.enter(START, stepArgs(skillA)))
    early.signal(b.completed('T1', { backgroundTasks: 0 }))
    expect(stopped(early), 'complete before start').toBe('turn-mismatch')

    const overlap = drive(plan([skillA]))
    const c = signals()
    inTurn(overlap, c, skillA, 'T1')
    overlap.signal(c.started('T1'))
    expect(overlap.state.status, 'the same turn started twice is a duplicate').toBe('running')
    overlap.signal(c.started('T2'))
    expect(stopped(overlap)).toBe('turn-overlap')
  })

  test('an end that is not a clean answer interrupts the sequence', () => {
    for (const [reason, expected] of [
      ['aborted', 'turn-aborted'],
      ['refusal', 'turn-refused'],
      ['error', 'turn-error']
    ] as const) {
      const run = drive(plan([skillA, skillB]))
      const s = signals()
      inTurn(run, s, skillA, 'T1')
      run.signal(s.completed('T1', { reason, backgroundTasks: 0 }))
      expect(run.state, reason).toEqual({ status: 'interrupted', step: 0, typed: true, reason: expected })
      expect(run.of('submit'), reason).toHaveLength(1)
    }
  })

  test('a turn that is aborted by flag is not an answer even when its reason says answer', () => {
    const run = drive(plan([skillA]))
    const s = signals()
    inTurn(run, s, skillA, 'T1')
    run.signal({ ...s.completed('T1', { backgroundTasks: 0 }), isAborted: true } as TurnSignal)
    expect(stopped(run)).toBe('turn-aborted')
  })

  test('a turn or a command that nobody asked for interrupts at every other moment', () => {
    const early = drive(plan([skillA]))
    const a = signals()
    early.signal(a.started('T9'))
    expect(stopped(early), 'a main turn while the text is being typed').toBe('foreign-turn')

    const lateCommand = drive(plan([skillA]))
    const b = signals()
    inTurn(lateCommand, b, skillA, 'T1')
    lateCommand.signal(b.enter('compact'))
    expect(stopped(lateCommand), 'a typed command during our turn').toBe('foreign-command')

    const stray = drive(plan([skillA]))
    const c = signals()
    stray.send({ type: 'submitted', step: 0 })
    stray.signal(c.completed('T9', { backgroundTasks: 0 }))
    expect(stopped(stray), 'a main turn.complete before the command').toBe('unexpected-turn')
  })
})

describe('the engine events a sequence must not trust', () => {
  test('a seq that repeats changes nothing, one that goes back or skips interrupts, the first one sets the baseline', () => {
    const run = drive(plan([skillA]))
    const s = signals(5000)
    run.send({ type: 'submitted', step: 0 })
    const entered = s.enter(START, stepArgs(skillA))
    run.signal(entered)
    const before = run.state
    const duplicate = run.signal(entered)
    expect(duplicate.state).toBe(before)
    expect(duplicate.effects).toEqual([])

    const back = drive(plan([skillA]))
    const t = signals(5000)
    back.send({ type: 'submitted', step: 0 })
    back.signal(t.enter(START, stepArgs(skillA)))
    back.signal({ ...t.started('T1'), seq: 5000 })
    expect(stopped(back)).toBe('seq-regressed')

    const gap = drive(plan([skillA]))
    const u = signals(5000)
    gap.send({ type: 'submitted', step: 0 })
    gap.signal(u.enter(START, stepArgs(skillA)))
    u.started('skipped')
    gap.signal(u.started('T1'))
    expect(stopped(gap)).toBe('seq-gap')
  })

  test('a compaction outside a compact step is ignored without advancing anything', () => {
    const run = drive(plan([skillA]))
    const s = signals()
    inTurn(run, s, skillA, 'T1')
    const effects = run.effects.length
    run.signal(s.compacted())
    expect(run.state.status).toBe('running')
    expect(run.effects).toHaveLength(effects)
    run.signal(s.completed('T1', { backgroundTasks: 0 }))
    expect(run.state).toEqual({ status: 'done' })
  })

  test('a session that ends during a step interrupts it', () => {
    const run = drive(plan([skillA]))
    const s = signals()
    inTurn(run, s, skillA, 'T1')
    run.signal(s.ended('clear'))
    expect(stopped(run)).toBe('session-ended')
  })
})

describe('quiescence', () => {
  test('the next step is typed only when a main turn.complete reports no background task', () => {
    const run = drive(plan([skillA, skillB]))
    const s = signals()
    inTurn(run, s, skillA, 'T1')
    run.signal(s.completed('T1', { backgroundTasks: 2 }))
    expect(run.of('submit')).toHaveLength(1)
    expect(run.of('waiting-quiescence')).toEqual([{ type: 'waiting-quiescence', step: 1, background: 2 }])

    run.signal(s.completed('SUB', { agentId: 'agent-1', backgroundTasks: 0 }))
    expect(run.of('submit'), 'a sub-agent end says nothing of the main loop').toHaveLength(1)

    run.signal(s.started('N1'))
    run.signal(s.completed('N1', { backgroundTasks: 1 }))
    expect(run.of('submit')).toHaveLength(1)
    expect(run.of('waiting-quiescence').at(-1)).toEqual({ type: 'waiting-quiescence', step: 1, background: 1 })

    run.signal(s.started('N2'))
    run.signal(s.completed('N2', { backgroundTasks: 0 }))
    expect(run.of('submit').at(-1)).toEqual({ type: 'submit', step: 1, text: stepText(skillB) })
  })

  test('the operator may go on without waiting, and only while it waits', () => {
    const run = drive(plan([skillA, skillB]))
    const s = signals()
    run.send({ type: 'operator-override' })
    expect(run.of('submit'), 'nothing to override while the first step is typed').toHaveLength(1)
    inTurn(run, s, skillA, 'T1')
    run.send({ type: 'operator-override' })
    expect(run.of('submit'), 'nor while a step runs').toHaveLength(1)
    run.signal(s.completed('T1', { backgroundTasks: 3 }))
    run.send({ type: 'operator-override' })
    expect(run.of('submit').at(-1)).toEqual({ type: 'submit', step: 1, text: stepText(skillB) })
  })

  test('a busy start waits for a first quiet turn or an override', () => {
    const run = drive(plan([skillA], false))
    const s = signals()
    run.signal(s.started('N1'))
    run.signal(s.completed('N1', { backgroundTasks: 0 }))
    expect(run.of('submit')).toEqual([{ type: 'submit', step: 0, text: stepText(skillA) }])

    const forced = drive(plan([skillA], false))
    forced.send({ type: 'operator-override' })
    expect(forced.of('submit')).toHaveLength(1)
  })

  test('an end that is not a clean answer while waiting interrupts, and so does a missing count', () => {
    const aborted = drive(plan([skillA, skillB]))
    const s = signals()
    inTurn(aborted, s, skillA, 'T1')
    aborted.signal(s.completed('T1', { backgroundTasks: 1 }))
    aborted.signal(s.completed('N1', { reason: 'aborted', backgroundTasks: 0 }))
    expect(aborted.state).toEqual({ status: 'interrupted', step: 1, typed: false, reason: 'turn-aborted' })

    const unknown = drive(plan([skillA, skillB]))
    const t = signals()
    inTurn(unknown, t, skillA, 'T1')
    unknown.signal(t.completed('T1'))
    expect(unknown.state).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'quiescence-unknown' })

    const waiting = drive(plan([skillA, skillB]))
    const u = signals()
    inTurn(waiting, u, skillA, 'T1')
    waiting.signal(u.completed('T1', { backgroundTasks: 1 }))
    waiting.signal(u.completed('N1'))
    expect(stopped(waiting)).toBe('quiescence-unknown')
  })

  test('the last step ends the sequence without waiting for background tasks', () => {
    for (const backgroundTasks of [0, 4, undefined]) {
      const run = drive(plan([skillA]))
      const s = signals()
      inTurn(run, s, skillA, 'T1')
      run.signal(s.completed('T1', { backgroundTasks }))
      expect(run.state, String(backgroundTasks)).toEqual({ status: 'done' })
    }
  })

  test('a command typed while it waits interrupts', () => {
    const run = drive(plan([skillA, skillB]))
    const s = signals()
    inTurn(run, s, skillA, 'T1')
    run.signal(s.completed('T1', { backgroundTasks: 1 }))
    run.signal(s.enter('compact'))
    expect(stopped(run)).toBe('foreign-command')
  })
})

describe('a compact step', () => {
  const compactPlan = (args?: string) => plan([{ command: 'compact', ...(args ? { args } : {}) }])

  test('it ends on session.compact:resolved then command.run:resolved, correlated by order and never by a nonce', () => {
    const run = drive(compactPlan('keep the plan'))
    const s = signals()
    expect(run.of('submit')).toEqual([{ type: 'submit', step: 0, text: '/compact keep the plan' }])
    run.send({ type: 'submitted', step: 0 })
    run.signal(s.enter('compact', 'keep the plan'))
    run.signal(s.compacted())
    expect(run.state.status).toBe('running')
    run.signal(s.resolved('compact'))
    expect(run.state).toEqual({ status: 'done' })
  })

  test('a resolved command without a compaction before it is a failed compaction', () => {
    const run = drive(compactPlan())
    const s = signals()
    run.send({ type: 'submitted', step: 0 })
    run.signal(s.enter('compact'))
    run.signal(s.resolved('compact'))
    expect(run.state).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'compact-failed' })
  })

  test('a compaction outside the step does not count for it', () => {
    const run = drive(compactPlan())
    const s = signals()
    run.signal(s.compacted())
    run.send({ type: 'submitted', step: 0 })
    run.signal(s.enter('compact'))
    run.signal(s.resolved('compact'))
    expect(stopped(run), 'the compaction before the step was not this one').toBe('compact-failed')
  })

  test('a turn during a compaction is unexpected, and args that are not ours are a foreign command', () => {
    const turn = drive(compactPlan())
    const a = signals()
    turn.send({ type: 'submitted', step: 0 })
    turn.signal(a.enter('compact'))
    turn.signal(a.started('T1'))
    expect(stopped(turn)).toBe('unexpected-turn')

    const args = drive(compactPlan('keep the plan'))
    const b = signals()
    args.send({ type: 'submitted', step: 0 })
    args.signal(b.enter('compact', 'something else'))
    expect(stopped(args)).toBe('foreign-command')
  })
})

describe('a locale step', () => {
  test('it ends on command.run:resolved', () => {
    const run = drive(plan([{ command: 'context' }]))
    const s = signals()
    run.send({ type: 'submitted', step: 0 })
    run.signal(s.enter('context'))
    expect(run.state.status).toBe('running')
    run.signal(s.resolved('context'))
    expect(run.state).toEqual({ status: 'done' })
  })

  test('only a clear step may see its session end, and only with reason clear', () => {
    const clear = drive(plan([{ command: 'clear' }]))
    const a = signals()
    clear.send({ type: 'submitted', step: 0 })
    clear.signal(a.enter('clear'))
    clear.signal(a.ended('clear'))
    clear.signal(a.resolved('clear'))
    expect(clear.state).toEqual({ status: 'done' })

    const other = drive(plan([{ command: 'clear' }]))
    const b = signals()
    other.send({ type: 'submitted', step: 0 })
    other.signal(b.enter('clear'))
    other.signal(b.ended('logout'))
    expect(stopped(other)).toBe('session-ended')

    const context = drive(plan([{ command: 'context' }]))
    const c = signals()
    context.send({ type: 'submitted', step: 0 })
    context.signal(c.enter('context'))
    context.signal(c.ended('clear'))
    expect(stopped(context)).toBe('session-ended')
  })
})

describe('a mixed sequence', () => {
  test('a skill, a compaction, a locale command and a skill run one after the other', () => {
    const steps: PlanStep[] = [skillA, { command: 'compact' }, { command: 'context' }, skillB]
    const run = drive(plan(steps))
    const s = signals()
    inTurn(run, s, skillA, 'T1')
    run.signal(s.completed('T1', { backgroundTasks: 0 }))
    expect(run.of('submit').at(-1)).toEqual({ type: 'submit', step: 1, text: '/compact' })
    run.send({ type: 'submitted', step: 1 })
    run.signal(s.enter('compact'))
    run.signal(s.compacted())
    run.signal(s.resolved('compact'))
    expect(run.of('submit').at(-1)).toEqual({ type: 'submit', step: 2, text: '/context' })
    run.send({ type: 'submitted', step: 2 })
    run.signal(s.enter('context'))
    run.signal(s.resolved('context'))
    expect(run.of('submit').at(-1)).toEqual({ type: 'submit', step: 3, text: stepText(skillB) })
    inTurn(run, s, skillB, 'T2', 3)
    run.signal(s.completed('T2', { backgroundTasks: 5 }))
    expect(run.state).toEqual({ status: 'done' })
    expect(run.of('submit').map((effect) => effect.step)).toEqual([0, 1, 2, 3])
    expect(run.of('finish')).toHaveLength(1)
  })
})

describe('the runner events', () => {
  test('a refused injection stops the step it was for, and one for another step is stale', () => {
    for (const outcome of ['no-terminal', 'busy-timeout', 'refused-modal', 'screen-unavailable', 'needs-attention', 'rate-limited'] as const) {
      const run = drive(plan([skillA]))
      run.send({ type: 'inject-refused', step: 0, outcome })
      expect(run.state, outcome).toEqual({ status: 'interrupted', step: 0, typed: false, reason: `injection-${outcome}` })
    }
    const stale = drive(plan([skillA]))
    stale.send({ type: 'inject-refused', step: 3, outcome: 'refused-modal' })
    expect(stale.state.status).toBe('running')
  })

  test('a timeout can only interrupt, and only the one armed for the current wait', () => {
    const noCommand = drive(plan([skillA]))
    noCommand.send({ type: 'submitted', step: 0 })
    const first = noCommand.of('arm-start-timer')[0]!
    noCommand.send({ type: 'start-timeout', token: first.token + 7 })
    expect(noCommand.state.status, 'a token that is not the armed one').toBe('running')
    noCommand.send({ type: 'start-timeout', token: first.token })
    expect(noCommand.state).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'no-command-run' })

    const noTurn = drive(plan([skillA]))
    const s = signals()
    noTurn.send({ type: 'submitted', step: 0 })
    const commandTimer = noTurn.of('arm-start-timer')[0]!
    noTurn.signal(s.enter(START, stepArgs(skillA)))
    noTurn.send({ type: 'start-timeout', token: commandTimer.token })
    expect(noTurn.state.status, 'the command timer is spent once the command ran').toBe('running')
    const turnTimer = noTurn.of('arm-start-timer')[1]!
    expect(turnTimer.token).not.toBe(commandTimer.token)
    noTurn.send({ type: 'start-timeout', token: turnTimer.token })
    expect(noTurn.state).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'no-turn-start' })

    const started = drive(plan([skillA]))
    const t = signals()
    inTurn(started, t, skillA, 'T1')
    for (const effect of started.of('arm-start-timer')) started.send({ type: 'start-timeout', token: effect.token })
    expect(started.state.status, 'a running turn is not timed out').toBe('running')
  })

  test('a cancel or a revocation stops the sequence at any moment', () => {
    const phases: Array<(run: Run, s: ReturnType<typeof signals>) => void> = [
      () => undefined,
      (run) => run.send({ type: 'submitted', step: 0 }),
      (run, s) => inTurn(run, s, skillA, 'T1'),
      (run, s) => {
        inTurn(run, s, skillA, 'T1')
        run.signal(s.completed('T1', { backgroundTasks: 1 }))
      }
    ]
    for (const [index, reach] of phases.entries()) {
      for (const [event, reason] of [
        [{ type: 'operator-cancel' }, 'operator-cancelled'],
        [{ type: 'revoked' }, 'revoked']
      ] as const) {
        const run = drive(plan([skillA, skillB]))
        reach(run, signals())
        run.send(event)
        expect(stopped(run), `${reason} at phase ${index}`).toBe(reason)
      }
    }
  })

  test('a finished sequence ignores every later event and keeps its state', () => {
    const run = drive(plan([skillA]))
    const s = signals()
    inTurn(run, s, skillA, 'T1')
    run.signal(s.completed('T1', { backgroundTasks: 0 }))
    const done = run.state
    const effects = run.effects.length
    for (const event of [
      { type: 'signal', signal: s.started('T2') },
      { type: 'submitted', step: 0 },
      { type: 'operator-override' },
      { type: 'operator-cancel' },
      { type: 'revoked' },
      { type: 'start-timeout', token: 1 }
    ] as SequenceEvent[]) {
      expect(run.send(event).state).toBe(done)
    }
    expect(run.effects).toHaveLength(effects)

    const interrupted = drive(plan([skillA]))
    interrupted.send({ type: 'revoked' })
    const result: SequenceResult = interrupted.state as SequenceResult
    interrupted.signal(signals().enter(START, stepArgs(skillA)))
    expect(interrupted.state).toBe(result)
  })

  test('the reducer never changes the state it was given', () => {
    const first = startSequence(plan([skillA, skillB]))
    const snapshot = JSON.stringify(first.state)
    const s = signals()
    reduceSequence(first.state, { type: 'submitted', step: 0 })
    reduceSequence(first.state, { type: 'signal', signal: s.enter(START, stepArgs(skillA)) })
    expect(JSON.stringify(first.state)).toBe(snapshot)
  })

  test('a signal the wire refused interrupts the sequence in every phase', () => {
    const phases: Array<[string, SequencePlan, (run: Run, s: ReturnType<typeof signals>) => void]> = [
      ['busy start', plan([skillA], false), () => undefined],
      ['submitting', plan([skillA, skillB]), () => undefined],
      ['awaiting the command', plan([skillA, skillB]), (run) => run.send({ type: 'submitted', step: 0 })],
      [
        'awaiting the turn',
        plan([skillA, skillB]),
        (run, s) => {
          run.send({ type: 'submitted', step: 0 })
          run.signal(s.enter(START, stepArgs(skillA)))
        }
      ],
      ['running a turn', plan([skillA, skillB]), (run, s) => inTurn(run, s, skillA, 'T1')],
      [
        'quiescence',
        plan([skillA, skillB]),
        (run, s) => {
          inTurn(run, s, skillA, 'T1')
          run.signal(s.completed('T1', { backgroundTasks: 1 }))
        }
      ],
      [
        'compacting',
        plan([{ command: 'compact' }]),
        (run, s) => {
          run.send({ type: 'submitted', step: 0 })
          run.signal(s.enter('compact'))
        }
      ],
      [
        'locale',
        plan([{ command: 'context' }]),
        (run, s) => {
          run.send({ type: 'submitted', step: 0 })
          run.signal(s.enter('context'))
        }
      ]
    ]
    for (const [name, initial, reach] of phases) {
      const run = drive(initial)
      reach(run, signals())
      run.send({ type: 'signal-refused', reason: 'unknown-key' })
      expect(stopped(run), name).toBe('signal-refused')
      expect(run.effects.at(-1), name).toMatchObject({ type: 'finish' })
    }
  })

  test('a source change interrupts the sequence and says whether the step was typed', () => {
    const before = drive(plan([skillA]))
    before.send({ type: 'source-changed' })
    expect(before.state).toEqual({ status: 'interrupted', step: 0, typed: false, reason: 'source-changed' })

    const after = drive(plan([skillA]))
    after.send({ type: 'submitted', step: 0 })
    after.send({ type: 'source-changed' })
    expect(after.state).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'source-changed' })
    expect(after.effects.at(-1)).toMatchObject({ type: 'finish' })
  })

  test('a submitted event for another step interrupts, the one for the current step after its command.run changes nothing', () => {
    const wrong = drive(plan([skillA, skillB]))
    wrong.send({ type: 'submitted', step: 1 })
    expect(wrong.state).toEqual({ status: 'interrupted', step: 0, typed: false, reason: 'step-mismatch' })

    const late = drive(plan([skillA]))
    const s = signals()
    late.send({ type: 'submitted', step: 0 })
    late.signal(s.enter(START, stepArgs(skillA)))
    const before = late.state
    late.send({ type: 'submitted', step: 0 })
    expect(late.state).toBe(before)
  })

  test('typed turns true once the step is written or seen as a command, and back to false for the next step', () => {
    const typedOf = (run: Run) => (run.state.status === 'interrupted' ? run.state.typed : null)

    const quiet = drive(plan([skillA]))
    quiet.send({ type: 'operator-cancel' })
    expect(typedOf(quiet), 'nothing written yet').toBe(false)

    const written = drive(plan([skillA]))
    written.send({ type: 'submitted', step: 0 })
    written.send({ type: 'operator-cancel' })
    expect(typedOf(written), 'written').toBe(true)

    const seen = drive(plan([skillA]))
    seen.signal(signals().enter(START, stepArgs(skillA)))
    seen.send({ type: 'operator-cancel' })
    expect(typedOf(seen), 'the command.run came before the written event').toBe(true)

    const next = drive(plan([skillA, skillB]))
    const s = signals()
    inTurn(next, s, skillA, 'T1')
    next.signal(s.completed('T1', { backgroundTasks: 0 }))
    next.send({ type: 'operator-cancel' })
    expect(next.state).toEqual({ status: 'interrupted', step: 1, typed: false, reason: 'operator-cancelled' })
  })

  test('the resolved event of another command interrupts whatever the step', () => {
    const skill = drive(plan([skillA]))
    const s = signals()
    inTurn(skill, s, skillA, 'T1')
    skill.signal(s.resolved('other'))
    expect(stopped(skill)).toBe('foreign-command')

    const compact = drive(plan([{ command: 'compact' }]))
    const t = signals()
    compact.send({ type: 'submitted', step: 0 })
    compact.signal(t.enter('compact'))
    compact.signal(t.resolved('context'))
    expect(stopped(compact)).toBe('foreign-command')

    const locale = drive(plan([{ command: 'context' }]))
    const u = signals()
    locale.send({ type: 'submitted', step: 0 })
    locale.signal(u.enter('context'))
    locale.signal(u.resolved('compact'))
    expect(stopped(locale)).toBe('foreign-command')
  })
})

describe('the turn is tied to the command by the module', () => {
  const enteredSkill = () => {
    const run = drive(plan([skillA, skillB]))
    const s = signals()
    run.send({ type: 'submitted', step: 0 })
    run.signal(s.enter(START, stepArgs(skillA)))
    return { run, s }
  }

  test('a main turn.start linked to the command.run of the step starts the turn', () => {
    const { run, s } = enteredSkill()
    run.signal(s.started('T1'))
    run.signal(s.completed('T1', { backgroundTasks: 0 }))
    expect(run.of('submit').at(-1)).toMatchObject({ step: 1 })
  })

  test('a main turn.start with no link, or linked to another command.run, interrupts', () => {
    const unlinked = enteredSkill()
    unlinked.run.signal(unlinked.s.started('T1', undefined, null))
    expect(unlinked.run.state).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'turn-mismatch' })

    const other = enteredSkill()
    other.run.signal(other.s.started('T1', undefined, 5))
    expect(other.run.state).toEqual({ status: 'interrupted', step: 0, typed: true, reason: 'turn-mismatch' })
  })

  test('a sub-agent turn.start never needs the link and never starts the turn', () => {
    const { run, s } = enteredSkill()
    run.signal(s.started('A1', 'agent-1', null))
    expect(run.state.status).toBe('running')
    run.signal(s.started('T1'))
    run.signal(s.completed('T1', { backgroundTasks: 0 }))
    expect(run.of('submit').at(-1)).toMatchObject({ step: 1 })
  })
})

describe('a step the wire would refuse is refused before anything is typed', () => {
  const refusedAs = (step: PlanStep, reason: SequenceStopReason) => {
    expect(startSequence(plan([step])).state, JSON.stringify(step)).toEqual({ status: 'refused', reason })
  }
  const hidden = {
    newline: '\n',
    tab: '\t',
    format: String.fromCodePoint(0x200b),
    privateUse: String.fromCodePoint(0xe000),
    lineSeparator: String.fromCodePoint(0x2028)
  }

  test('a nonce of seven characters is refused, one of eight is the shortest accepted', () => {
    refusedAs({ command: START, nonce: 'a1b2c3d' }, 'bad-nonce')
    expect(startSequence(plan([{ command: START, nonce: 'a1b2c3d4' }])).state.status).toBe('running')
  })

  test('args with a control or invisible character are refused', () => {
    for (const [name, char] of Object.entries(hidden)) {
      refusedAs({ command: 'compact', args: `keep${char}plan` }, 'bad-args')
      refusedAs({ command: START, args: `x${char}`, nonce: NONCE_A }, 'bad-args')
      expect(name).toBeTruthy()
    }
  })

  test('args with a space at either end, or only spaces, are refused, inner spaces are not', () => {
    refusedAs({ command: 'compact', args: ' keep' }, 'bad-args')
    refusedAs({ command: 'compact', args: 'keep ' }, 'bad-args')
    refusedAs({ command: 'compact', args: '   ' }, 'bad-args')
    refusedAs({ command: START, args: 'x ', nonce: NONCE_A }, 'bad-args')
    expect(startSequence(plan([{ command: 'compact', args: 'keep the plan' }])).state.status).toBe('running')
  })

  test('a command name the wire would refuse is refused', () => {
    const table: CommandTable = { [`a${hidden.format}b`]: 'locale', [' ']: 'locale' }
    for (const command of Object.keys(table)) {
      expect(startSequence({ steps: [{ command }], table, startQuiet: true }).state, JSON.stringify(command)).toEqual({
        status: 'refused',
        reason: 'bad-args'
      })
    }
  })

  test('a command name is one token of letters, digits and : . _ -, never led by a punctuation', () => {
    const noBreakSpace = String.fromCodePoint(0x00a0)
    const bad = ['kory ', ' kory', 'kory x', '/kory', `kory${noBreakSpace}`, ':kory', '-kory', '.kory', '_kory', 'kory/x', 'kory\tx']
    const good = ['kory', 'kory-session-start', 'plugin:kory.run_2', 'A1']
    const table: CommandTable = Object.fromEntries([...bad, ...good].map((name) => [name, 'locale' as const]))
    for (const command of bad) {
      expect(startSequence({ steps: [{ command }], table, startQuiet: true }).state, JSON.stringify(command)).toEqual({
        status: 'refused',
        reason: 'bad-args'
      })
    }
    for (const command of good) {
      expect(startSequence({ steps: [{ command }], table, startQuiet: true }).state.status, command).toBe('running')
    }
  })
})

describe('the order the engine delivers for a skill', () => {
  const entered = () => {
    const run = drive(plan([skillA, skillB]))
    const s = signals()
    run.send({ type: 'submitted', step: 0 })
    run.signal(s.enter(START, stepArgs(skillA)))
    return { run, s }
  }

  test('enter, resolved of the step itself, turn.start and turn.complete run the step to its end', () => {
    const { run, s } = entered()
    run.signal(s.resolved(START))
    expect(run.state.status).toBe('running')
    run.signal(s.started('T1'))
    run.signal(s.completed('T1', { backgroundTasks: 0 }))
    expect(run.of('submit').at(-1)).toMatchObject({ step: 1 })
  })

  test('the resolved of the step itself is also harmless once its turn runs', () => {
    const { run, s } = entered()
    run.signal(s.started('T1'))
    run.signal(s.resolved(START))
    expect(run.state.status).toBe('running')
  })

  test('the same command.run:enter replayed while the turn is awaited or running interrupts', () => {
    const awaiting = entered()
    awaiting.run.signal(awaiting.s.enter(START, stepArgs(skillA)))
    expect(stopped(awaiting.run), 'awaiting the turn').toBe('foreign-command')

    const running = entered()
    running.run.signal(running.s.started('T1'))
    running.run.signal(running.s.enter(START, stepArgs(skillA)))
    expect(stopped(running.run), 'running the turn').toBe('foreign-command')
  })
})
