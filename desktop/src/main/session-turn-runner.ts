import type { TileHold } from './tile-injector'
import type { TurnSignalEvent } from './turn-signal-server'
import {
  reduceSequence,
  startSequence,
  type CommandClass,
  type PlanStep,
  type SequenceEffect,
  type SequenceEvent,
  type SequencePlan,
  type SequenceResult,
  type SequenceState,
  type Transition
} from './session-turn-sequence'

/** Above the module's 10 s bound on one send: its sends are chained, so a slow one delays every signal behind it. */
export const START_TIMEOUT_MS = 45_000

export interface SequenceStepInput {
  command: string
  args?: string
  commandClass: CommandClass
}

export interface SequenceInput {
  steps: readonly SequenceStepInput[]
}

export type RunRefusal = 'bad-plan' | 'no-source' | 'sequence-active'
export type RunResult = SequenceResult | { status: 'refused'; reason: RunRefusal }

export interface SequenceHandle {
  result: Promise<RunResult>
  /** Skips the wait for background tasks: the next step is typed now. */
  override(): void
  cancel(): void
}

export interface SequenceRunHost {
  holdTile<T>(id: string, fn: (hold: TileHold) => Promise<T>): Promise<T>
  /** One listener per tile; throws when the tile already has one. Returns its unsubscribe. */
  subscribe(id: string, listener: (event: TurnSignalEvent) => void): () => void
  life(id: string): object | null
  /** Whether the tile was launched with a turn signal source. */
  hasSource(id: string): boolean
  /** The release of the tile's claim; null when a sequence already holds or awaits the tile. */
  tryClaim(id: string): (() => void) | null
  clock: { setTimeout(callback: () => void, delay: number): NodeJS.Timeout; clearTimeout(timer: NodeJS.Timeout): void }
  mintNonce(): string
  journal(line: string): void
  reportError(message: string, error?: unknown): void
}

function buildPlan(host: SequenceRunHost, input: SequenceInput): SequencePlan | null {
  const classes = new Map<string, CommandClass>()
  const steps: PlanStep[] = []
  for (const step of input.steps) {
    if ((classes.get(step.command) ?? step.commandClass) !== step.commandClass) return null
    classes.set(step.command, step.commandClass)
    steps.push({
      command: step.command,
      args: step.args,
      nonce: step.commandClass === 'skill' ? host.mintNonce() : undefined
    })
  }
  return { steps, table: Object.fromEntries(classes), startQuiet: true }
}

function journalResult(host: SequenceRunHost, tileId: string, total: number, result: RunResult): void {
  const where = `sequence on tile ${tileId}`
  if (result.status === 'done') host.journal(`${where}: done, ${total} ${total === 1 ? 'step' : 'steps'}`)
  else if (result.status === 'refused') host.journal(`${where}: refused (${result.reason})`)
  else host.journal(`${where}: stopped at step ${result.step + 1} of ${total} (${result.reason}), ${result.typed ? 'typed' : 'not typed'}`)
}

function runInHold(
  host: SequenceRunHost,
  tileId: string,
  hold: TileHold,
  started: Transition,
  early: SequenceEvent | null,
  attach: (dispatch: (event: SequenceEvent) => void) => void
): Promise<SequenceResult> {
  return new Promise<SequenceResult>((resolve) => {
    const life = host.life(tileId)
    const timers = new Map<number, NodeJS.Timeout>()
    let state: SequenceState = started.state
    let finished = false
    let unsubscribe: (() => void) | null = null

    const finish = (result: SequenceResult): void => {
      finished = true
      unsubscribe?.()
      resolve(result)
    }

    const run = (effect: SequenceEffect): void => {
      switch (effect.type) {
        case 'submit': {
          const step = effect.step
          hold.inject(effect.text, { escape: false }).then(
            (outcome) => dispatch(outcome === 'written' ? { type: 'submitted', step } : { type: 'inject-refused', step, outcome }),
            (error) => {
              if (finished) return
              host.reportError(`sequence on tile ${tileId}: injection of step ${step + 1} failed`, error)
              dispatch({ type: 'revoked' })
            }
          )
          return
        }
        case 'arm-start-timer': {
          const token = effect.token
          timers.set(
            token,
            host.clock.setTimeout(() => {
              timers.delete(token)
              dispatch({ type: 'start-timeout', token })
            }, START_TIMEOUT_MS)
          )
          return
        }
        case 'waiting-quiescence':
          host.journal(`sequence on tile ${tileId}: step ${effect.step + 1} waits for background tasks (${effect.background})`)
          return
        case 'finish':
          finish(effect.result)
          return
      }
    }

    const apply = (transition: Transition): void => {
      state = transition.state
      for (const effect of transition.effects) run(effect)
      const live = state.status === 'running' && 'timer' in state.phase ? state.phase.timer : null
      for (const [token, timer] of timers) {
        if (token === live) continue
        host.clock.clearTimeout(timer)
        timers.delete(token)
      }
    }

    const dispatch = (event: SequenceEvent): void => apply(reduceSequence(state, event))

    const listener = (event: TurnSignalEvent): void => {
      if (event.generation !== life) dispatch({ type: 'revoked' })
      else if (event.type === 'signal') dispatch({ type: 'signal', signal: event.signal })
      else if (event.type === 'signal-refused') dispatch({ type: 'signal-refused', reason: event.reason })
      else dispatch({ type: 'source-changed' })
    }

    attach(dispatch)
    void hold.revoked.then(() => dispatch({ type: 'revoked' }))
    if (early !== null) {
      apply(reduceSequence(started.state, early))
      return
    }
    try {
      unsubscribe = host.subscribe(tileId, listener)
    } catch (error) {
      host.reportError(`sequence on tile ${tileId}: no turn signal subscription`, error)
      apply(reduceSequence(started.state, { type: 'revoked' }))
      return
    }
    apply(started)
  })
}

export function runSequence(host: SequenceRunHost, tileId: string, input: SequenceInput): SequenceHandle {
  const total = input.steps.length
  const refused = (result: RunResult): SequenceHandle => {
    journalResult(host, tileId, total, result)
    return { result: Promise.resolve(result), override() {}, cancel() {} }
  }

  const plan = buildPlan(host, input)
  if (plan === null) return refused({ status: 'refused', reason: 'bad-plan' })
  const started = startSequence(plan)
  if (started.state.status === 'refused') return refused(started.state)
  if (!host.hasSource(tileId)) return refused({ status: 'refused', reason: 'no-source' })
  const release = host.tryClaim(tileId)
  if (release === null) return refused({ status: 'refused', reason: 'sequence-active' })

  let control: ((event: SequenceEvent) => void) | null = null
  let cancelRequested = false
  const result = host
    .holdTile(tileId, (hold) => {
      const early: SequenceEvent | null = !hold.isCurrent() ? { type: 'revoked' } : cancelRequested ? { type: 'operator-cancel' } : null
      return runInHold(host, tileId, hold, started, early, (dispatch) => {
        control = dispatch
      })
    })
    .then((outcome) => {
      journalResult(host, tileId, total, outcome)
      return outcome
    })
    .finally(release)
  return {
    result,
    override() {
      control?.({ type: 'operator-override' })
    },
    cancel() {
      if (control) control({ type: 'operator-cancel' })
      else cancelRequested = true
    }
  }
}
