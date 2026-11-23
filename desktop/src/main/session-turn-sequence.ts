// A sequence of slash commands typed into one tile, each started only once the
// previous one is proven finished by the engine's own events. Pure: no clock,
// no electron, no node-pty. A timer is an effect the runner arms and an event
// it sends back, and no timer ever ends a step well: it can only interrupt.

import { TURN_SIGNAL_LIMITS, isWireText, type TurnSignal, type TurnSignalRefusal } from '../../hooks/turn-signal-wire'
import type { SequenceInjectionRefusal, SequenceStopReason } from '../shared/types'
import type { CommandClass } from '../shared/session-command-line'

export type { CommandClass }

/** Declared by the caller: the engine's name of a command, without its slash, to its class. */
export type CommandTable = Readonly<Record<string, CommandClass>>

export interface PlanStep {
  command: string
  args?: string
  /** Required on a skill step, refused on any other: it rides in the args and tells our run from a typed one. */
  nonce?: string
}

export interface SequencePlan {
  steps: readonly PlanStep[]
  table: CommandTable
  /** False while a background task of an earlier turn may still run: the first step then waits. */
  startQuiet: boolean
}

export type InjectionRefusal = SequenceInjectionRefusal

export type { SequenceStopReason }

export type SequenceResult =
  | { status: 'done' }
  | { status: 'refused'; reason: SequenceStopReason }
  | { status: 'interrupted'; step: number; typed: boolean; reason: SequenceStopReason }

type Phase =
  | { kind: 'quiescence'; background: number | null }
  | { kind: 'submitting' }
  | { kind: 'awaiting-command'; timer: number }
  | { kind: 'awaiting-turn'; timer: number; commandSeq: number }
  | { kind: 'running-turn'; turnId: string }
  | { kind: 'compacting'; compacted: boolean }
  | { kind: 'locale' }

interface Running {
  status: 'running'
  plan: SequencePlan
  /**
   * The step in flight, or the next one to submit while the phase is
   * quiescence. An `interrupted` result carries it as `step`; `typed` false
   * says that step was never written into the tile.
   */
  step: number
  /** True once the step's text may have reached the tile: written, or already seen as a command.run. */
  typed: boolean
  phase: Phase
  lastSeq: number | null
  nextTimer: number
}

export type SequenceState = Running | SequenceResult

export type SequenceEvent =
  | { type: 'signal'; signal: TurnSignal }
  | { type: 'signal-refused'; reason: TurnSignalRefusal }
  | { type: 'source-changed' }
  | { type: 'submitted'; step: number }
  | { type: 'inject-refused'; step: number; outcome: InjectionRefusal }
  | { type: 'start-timeout'; token: number }
  | { type: 'operator-override' }
  | { type: 'operator-cancel' }
  | { type: 'revoked' }

export type SequenceEffect =
  | { type: 'submit'; step: number; text: string }
  | { type: 'arm-start-timer'; step: number; token: number }
  | { type: 'waiting-quiescence'; step: number; background: number | null }
  | { type: 'finish'; result: SequenceResult }

export interface Transition {
  state: SequenceState
  effects: SequenceEffect[]
}

const STEP_TOKEN_PREFIX = 'kory-step:'
const NONCE = /^[0-9a-f]{8,32}$/
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/

/** What the engine will report as the args of this step: its own args, then the nonce token. */
export function stepArgs(step: PlanStep): string {
  const base = step.args ?? ''
  if (step.nonce === undefined) return base
  return base === '' ? `${STEP_TOKEN_PREFIX}${step.nonce}` : `${base} ${STEP_TOKEN_PREFIX}${step.nonce}`
}

export function stepText(step: PlanStep): string {
  const args = stepArgs(step)
  return args === '' ? `/${step.command}` : `/${step.command} ${args}`
}

function preflightRefusal(plan: SequencePlan): SequenceStopReason | null {
  if (plan.steps.length === 0) return 'empty-plan'
  for (const step of plan.steps) {
    if (!Object.hasOwn(plan.table, step.command)) return 'unknown-command'
    const commandClass = plan.table[step.command]
    if (commandClass === 'dialogue') return 'dialogue-command'
    if (commandClass === 'skill' ? step.nonce === undefined || !NONCE.test(step.nonce) : step.nonce !== undefined) {
      return 'bad-nonce'
    }
    if (
      Array.from(step.command).length > TURN_SIGNAL_LIMITS.command ||
      Array.from(stepArgs(step)).length > TURN_SIGNAL_LIMITS.args
    ) {
      return 'step-too-long'
    }
    const own = step.args ?? ''
    const args = stepArgs(step)
    if (!COMMAND_NAME.test(step.command)) return 'bad-args'
    if (own !== own.trim() || (args !== '' && !isWireText(args, TURN_SIGNAL_LIMITS.args))) return 'bad-args'
  }
  return null
}

const terminal = (result: SequenceResult): Transition => ({ state: result, effects: [{ type: 'finish', result }] })

function stop(state: Running, reason: SequenceStopReason): Transition {
  return terminal({ status: 'interrupted', step: state.step, typed: state.typed, reason })
}

function submit(state: Running, step: number): Transition {
  const planned = state.plan.steps[step]!
  return {
    state: { ...state, step, typed: false, phase: { kind: 'submitting' } },
    effects: [{ type: 'submit', step, text: stepText(planned) }]
  }
}

function waitQuiet(state: Running, step: number, background: number | null): Transition {
  return {
    state: { ...state, step, typed: false, phase: { kind: 'quiescence', background } },
    effects: [{ type: 'waiting-quiescence', step, background }]
  }
}

/** A step is proven finished: the next one starts, or the sequence is done. */
function advance(state: Running): Transition {
  const next = state.step + 1
  return next >= state.plan.steps.length ? terminal({ status: 'done' }) : submit(state, next)
}

function armTimer(state: Running, phaseOf: (timer: number) => Phase): Transition {
  const token = state.nextTimer
  return {
    state: { ...state, phase: phaseOf(token), nextTimer: token + 1 },
    effects: [{ type: 'arm-start-timer', step: state.step, token }]
  }
}

const TURN_END_REASON = { aborted: 'turn-aborted', refusal: 'turn-refused', error: 'turn-error' } as const

/** Why a main turn.complete is not a clean answer, or null when it is one. */
function unansweredReason(signal: Extract<TurnSignal, { kind: 'turn.complete' }>): SequenceStopReason | null {
  if (signal.isAborted) return 'turn-aborted'
  return signal.reason === 'answer' ? null : TURN_END_REASON[signal.reason]
}

/** The quiet check after a main turn.complete: `background` is the count the module read from the engine's Stop. */
function afterTurn(state: Running, background: number | undefined, nextStep: number): Transition {
  if (background === undefined) return stop(state, 'quiescence-unknown')
  return background === 0 ? submit(state, nextStep) : waitQuiet(state, nextStep, background)
}

function onSignal(state: Running, signal: TurnSignal): Transition {
  if (state.lastSeq !== null) {
    if (signal.seq === state.lastSeq) return { state, effects: [] }
    if (signal.seq < state.lastSeq) return stop(state, 'seq-regressed')
    if (signal.seq > state.lastSeq + 1) return stop(state, 'seq-gap')
  }
  const seen: Running = { ...state, lastSeq: signal.seq }
  const planned = seen.plan.steps[seen.step]!
  const phase = seen.phase

  if (signal.kind === 'command.run:enter') {
    if (phase.kind !== 'submitting' && phase.kind !== 'awaiting-command') return stop(seen, 'foreign-command')
    if (signal.origin !== 'composer' || signal.command !== planned.command || signal.args !== stepArgs(planned)) {
      return stop(seen, 'foreign-command')
    }
    const entered: Running = { ...seen, typed: true }
    const commandClass = seen.plan.table[planned.command]
    if (commandClass === 'skill') {
      return armTimer(entered, (timer) => ({ kind: 'awaiting-turn', timer, commandSeq: signal.seq }))
    }
    return { state: { ...entered, phase: commandClass === 'compact' ? { kind: 'compacting', compacted: false } : { kind: 'locale' } }, effects: [] }
  }

  if (signal.kind === 'command.run:resolved') {
    if (signal.command !== planned.command) return stop(seen, 'foreign-command')
    if (phase.kind === 'compacting') return phase.compacted ? advance(seen) : stop(seen, 'compact-failed')
    if (phase.kind === 'locale') return advance(seen)
    return { state: seen, effects: [] }
  }

  if (signal.kind === 'session.compact:resolved') {
    if (phase.kind !== 'compacting') return { state: seen, effects: [] }
    return { state: { ...seen, phase: { kind: 'compacting', compacted: true } }, effects: [] }
  }

  if (signal.kind === 'session.end') {
    if (phase.kind === 'locale' && planned.command === 'clear' && signal.reason === 'clear') return { state: seen, effects: [] }
    return stop(seen, 'session-ended')
  }

  if (signal.agentId !== undefined) return { state: seen, effects: [] }

  if (signal.kind === 'turn.start') {
    if (phase.kind === 'quiescence') return { state: seen, effects: [] }
    if (phase.kind === 'awaiting-turn') {
      return signal.commandSeq === phase.commandSeq
        ? { state: { ...seen, phase: { kind: 'running-turn', turnId: signal.turnId } }, effects: [] }
        : stop(seen, 'turn-mismatch')
    }
    if (phase.kind === 'running-turn') {
      return signal.turnId === phase.turnId ? { state: seen, effects: [] } : stop(seen, 'turn-overlap')
    }
    return stop(seen, phase.kind === 'compacting' || phase.kind === 'locale' ? 'unexpected-turn' : 'foreign-turn')
  }

  const unanswered = unansweredReason(signal)
  if (phase.kind === 'quiescence') {
    if (unanswered) return stop(seen, unanswered)
    return afterTurn(seen, signal.backgroundTasks, seen.step)
  }
  if (phase.kind === 'awaiting-turn' || (phase.kind === 'running-turn' && signal.turnId !== phase.turnId)) {
    return stop(seen, 'turn-mismatch')
  }
  if (phase.kind !== 'running-turn') return stop(seen, 'unexpected-turn')
  if (unanswered) return stop(seen, unanswered)
  if (seen.step + 1 >= seen.plan.steps.length) return advance(seen)
  return afterTurn(seen, signal.backgroundTasks, seen.step + 1)
}

export function startSequence(plan: SequencePlan): Transition {
  const refusal = preflightRefusal(plan)
  if (refusal) return terminal({ status: 'refused', reason: refusal })
  const running: Running = { status: 'running', plan, step: 0, typed: false, phase: { kind: 'submitting' }, lastSeq: null, nextTimer: 1 }
  return plan.startQuiet ? submit(running, 0) : waitQuiet(running, 0, null)
}

export function reduceSequence(state: SequenceState, event: SequenceEvent): Transition {
  if (state.status !== 'running') return { state, effects: [] }
  const phase = state.phase
  switch (event.type) {
    case 'signal':
      return onSignal(state, event.signal)
    case 'signal-refused':
      return stop(state, 'signal-refused')
    case 'source-changed':
      return stop(state, 'source-changed')
    case 'submitted':
      if (event.step !== state.step) return stop(state, 'step-mismatch')
      return phase.kind === 'submitting'
        ? armTimer({ ...state, typed: true }, (timer) => ({ kind: 'awaiting-command', timer }))
        : { state, effects: [] }
    case 'inject-refused':
      return phase.kind === 'submitting' && event.step === state.step
        ? stop(state, `injection-${event.outcome}`)
        : { state, effects: [] }
    case 'start-timeout':
      if (phase.kind === 'awaiting-command' && event.token === phase.timer) return stop(state, 'no-command-run')
      if (phase.kind === 'awaiting-turn' && event.token === phase.timer) return stop(state, 'no-turn-start')
      return { state, effects: [] }
    case 'operator-override':
      return phase.kind === 'quiescence' ? submit(state, state.step) : { state, effects: [] }
    case 'operator-cancel':
      return stop(state, 'operator-cancelled')
    case 'revoked':
      return stop(state, 'revoked')
  }
}
