import type { ServeAction } from './serve-config'

export const STOP_GRACE_MS = 3000
export const SYSTEM_COMMAND_TIMEOUT_MS = 3000
export const PROBE_INTERVAL_MS = 500
export const SERVE_QUIT_DEADLINE_MS = 12_000

export type ServeStopReason = 'operator' | 'quit' | 'readinessTimeout' | 'childError' | 'leaderExited' | 'logSetup'
export type ServePosixSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL'
export type ServeStopAct = ServePosixSignal | 'taskkill' | 'killLeader'
export type ServeTimerKind = 'readyDeadline' | 'probeDelay' | 'grace'

export interface ServeLaunch {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly url: string
  readonly health: string
  readonly port: number
  readonly readyTimeoutMs: number
}

export interface ServeRun {
  readonly launch: ServeLaunch
  readonly pid: number
}

export interface ServeFailure {
  readonly message: string
  readonly url?: string
  readonly port?: number
  readonly pid?: number
}

export type ServeStopStep =
  | { readonly kind: 'signal'; readonly signal: ServePosixSignal }
  | { readonly kind: 'grace'; readonly signal: 'SIGINT' | 'SIGTERM'; readonly timerId: number }
  | { readonly kind: 'killProbe' }
  | { readonly kind: 'taskkill' }
  | { readonly kind: 'leaderGrace'; readonly timerId: number }

export type ServePhase =
  | { readonly kind: 'idle'; readonly failure: ServeFailure | null }
  | { readonly kind: 'preparing' }
  | { readonly kind: 'spawning'; readonly launch: ServeLaunch; readonly pendingStop: 'operator' | 'quit' | null }
  | {
      readonly kind: 'probing'
      readonly run: ServeRun
      readonly deadlineTimer: number
      readonly delayTimer: number | null
      readonly lastStatus: string
    }
  | { readonly kind: 'ready'; readonly run: ServeRun }
  | {
      readonly kind: 'stopping'
      readonly run: ServeRun
      readonly reason: ServeStopReason
      /** Set by the first failing cause; a later one never overwrites it. */
      readonly failure: string | null
      readonly leaderExited: boolean
      readonly step: ServeStopStep
      readonly acts: readonly ServeStopAct[]
      /** The outstanding probeGroup; an answer carrying another id is stale. */
      readonly probe: number | null
    }

export type ServePhaseKind = ServePhase['kind']

export interface ServeLifecycleState {
  readonly platform: NodeJS.Platform
  readonly quitting: boolean
  /** Incremented by Start only: a result carrying another op belongs to a closed run. */
  readonly op: number
  readonly nextTimerId: number
  readonly nextProbeId: number
  readonly logOpen: number | null
  readonly phase: ServePhase
}

export type ServeLifecycleEvent =
  | { readonly kind: 'Start'; readonly action: ServeAction }
  | { readonly kind: 'Stop' }
  | { readonly kind: 'Quit' }
  | { readonly kind: 'QuitDeadline' }
  | { readonly kind: 'Prepared'; readonly op: number; readonly launch: ServeLaunch }
  | { readonly kind: 'PrepareFailed'; readonly op: number; readonly message: string }
  | { readonly kind: 'Spawned'; readonly op: number; readonly pid: number }
  | { readonly kind: 'SpawnFailed'; readonly op: number; readonly message: string }
  | { readonly kind: 'LogFailed'; readonly op: number; readonly message: string }
  | { readonly kind: 'ProbeAnswered'; readonly op: number; readonly status: number }
  | { readonly kind: 'ProbeFailed'; readonly op: number; readonly message: string }
  | {
      readonly kind: 'SignalResult'
      readonly op: number
      readonly signal: ServePosixSignal
      readonly outcome: 'sent' | 'absent' | 'failed'
      readonly code?: string
      readonly message?: string
    }
  | {
      readonly kind: 'GroupProbed'
      readonly op: number
      readonly probeId: number
      readonly outcome: 'present' | 'absent' | 'failed'
      readonly code?: string
      readonly message?: string
    }
  | { readonly kind: 'TaskkillDone'; readonly op: number; readonly code: number; readonly stderr: string }
  | { readonly kind: 'ChildExited'; readonly op: number; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'ChildError'; readonly op: number; readonly message: string }
  | { readonly kind: 'TimerFired'; readonly timerId: number }

export type ServeLifecycleEventKind = ServeLifecycleEvent['kind']

export type ServeLifecycleEffect =
  | { readonly kind: 'prepare'; readonly op: number; readonly action: ServeAction }
  | {
      readonly kind: 'spawn'
      readonly op: number
      readonly file: string
      readonly args: readonly string[]
      readonly cwd: string
      readonly env: Readonly<Record<string, string | undefined>>
      readonly detached: boolean
    }
  | { readonly kind: 'openLog'; readonly op: number }
  | { readonly kind: 'closeLog'; readonly op: number }
  | { readonly kind: 'probe'; readonly op: number; readonly url: string; readonly timeoutMs: number }
  | { readonly kind: 'abortProbe'; readonly op: number }
  /**
   * Sent to -pid without remeasuring the leader: POSIX never hands out a PID
   * equal to the id of a process group that still exists, so the group itself
   * is the identity, even after its leader was reaped.
   */
  | { readonly kind: 'signalGroup'; readonly op: number; readonly pid: number; readonly signal: ServePosixSignal }
  | { readonly kind: 'probeGroup'; readonly op: number; readonly pid: number; readonly probeId: number }
  | { readonly kind: 'taskkill'; readonly op: number; readonly pid: number }
  | { readonly kind: 'killLeader'; readonly op: number }
  | { readonly kind: 'armTimer'; readonly timer: ServeTimerKind; readonly timerId: number; readonly delayMs: number }
  | { readonly kind: 'cancelTimer'; readonly timerId: number }
  | { readonly kind: 'report'; readonly message: string }

export type ServeReply =
  | { readonly kind: 'none' }
  | { readonly kind: 'accepted' }
  | { readonly kind: 'deferred' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'rejected'; readonly reason: string }

export interface ServeReduction {
  readonly state: ServeLifecycleState
  readonly effects: readonly ServeLifecycleEffect[]
  readonly reply: ServeReply
}

export type ServePublicStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'stopping'

export interface ServePublicState {
  readonly status: ServePublicStatus
  readonly url?: string
  readonly port?: number
  readonly pid?: number
  readonly error?: string
}

export function initialServeLifecycle(platform: NodeJS.Platform): ServeLifecycleState {
  return { platform, quitting: false, op: 0, nextTimerId: 1, nextProbeId: 1, logOpen: null, phase: { kind: 'idle', failure: null } }
}

export function stopBudgetMs(platform: NodeJS.Platform): number {
  return platform === 'win32' ? SYSTEM_COMMAND_TIMEOUT_MS + STOP_GRACE_MS : 2 * STOP_GRACE_MS
}

function runFields(run: ServeRun): { url: string; port: number; pid: number } {
  return { url: run.launch.url, port: run.launch.port, pid: run.pid }
}

export function selectServePublicState(state: ServeLifecycleState): ServePublicState {
  const phase = state.phase
  switch (phase.kind) {
    case 'idle':
      return phase.failure ? { status: 'failed', ...withoutMessage(phase.failure), error: phase.failure.message } : { status: 'idle' }
    case 'preparing':
    case 'spawning':
    case 'probing':
      return { status: 'starting' }
    case 'ready':
      return { status: 'ready', ...runFields(phase.run) }
    case 'stopping':
      return { status: 'stopping', ...runFields(phase.run) }
    default:
      return assertNever(phase)
  }
}

function withoutMessage(failure: ServeFailure): Omit<ServeFailure, 'message'> {
  const { message: _message, ...rest } = failure
  return rest
}

interface Draft {
  s: ServeLifecycleState
  effects: ServeLifecycleEffect[]
  reply: ServeReply
}

const NONE: ServeReply = { kind: 'none' }
const ACCEPTED: ServeReply = { kind: 'accepted' }
const DEFERRED: ServeReply = { kind: 'deferred' }
const BUSY: ServeReply = { kind: 'busy' }

function assertNever(value: never): never {
  throw new Error(`Unclassified Serve lifecycle variant: ${JSON.stringify(value)}`)
}

function set(d: Draft, patch: Partial<ServeLifecycleState>): void {
  d.s = { ...d.s, ...patch }
}

function emit(d: Draft, effect: ServeLifecycleEffect): void {
  d.effects.push(effect)
}

function report(d: Draft, message: string): void {
  emit(d, { kind: 'report', message })
}

function arm(d: Draft, timer: ServeTimerKind, delayMs: number): number {
  const timerId = d.s.nextTimerId
  set(d, { nextTimerId: timerId + 1 })
  emit(d, { kind: 'armTimer', timer, timerId, delayMs })
  return timerId
}

function armedTimers(phase: ServePhase): number[] {
  if (phase.kind === 'probing') return phase.delayTimer === null ? [phase.deadlineTimer] : [phase.deadlineTimer, phase.delayTimer]
  if (phase.kind === 'stopping' && (phase.step.kind === 'grace' || phase.step.kind === 'leaderGrace')) return [phase.step.timerId]
  return []
}

function cancelArmed(d: Draft, fired: number | null = null): void {
  for (const timerId of armedTimers(d.s.phase)) {
    if (timerId !== fired) emit(d, { kind: 'cancelTimer', timerId })
  }
}

function failureFor(phase: ServePhase, message: string): ServeFailure {
  if (phase.kind === 'probing' || phase.kind === 'ready' || phase.kind === 'stopping') return { message, ...runFields(phase.run) }
  if (phase.kind === 'spawning') return { message, url: phase.launch.url, port: phase.launch.port }
  return { message }
}

function enterIdle(d: Draft, failure: string | null, fired: number | null = null): void {
  cancelArmed(d, fired)
  if (d.s.logOpen !== null) emit(d, { kind: 'closeLog', op: d.s.logOpen })
  set(d, { logOpen: null, phase: { kind: 'idle', failure: failure === null ? null : failureFor(d.s.phase, failure) } })
}

function isPosix(state: ServeLifecycleState): boolean {
  return state.platform !== 'win32'
}

function beginStop(d: Draft, run: ServeRun, reason: ServeStopReason, failure: string | null, leaderExited: boolean): void {
  const op = d.s.op
  if (isPosix(d.s)) {
    emit(d, { kind: 'signalGroup', op, pid: run.pid, signal: 'SIGINT' })
    set(d, { phase: { kind: 'stopping', run, reason, failure, leaderExited, step: { kind: 'signal', signal: 'SIGINT' }, acts: ['SIGINT'], probe: null } })
    return
  }
  emit(d, { kind: 'taskkill', op, pid: run.pid })
  set(d, { phase: { kind: 'stopping', run, reason, failure, leaderExited, step: { kind: 'taskkill' }, acts: ['taskkill'], probe: null } })
}

function probeGroup(d: Draft, pid: number): number {
  const probeId = d.s.nextProbeId
  set(d, { nextProbeId: probeId + 1 })
  emit(d, { kind: 'probeGroup', op: d.s.op, pid, probeId })
  return probeId
}

function stopProbing(d: Draft, run: ServeRun, reason: ServeStopReason, failure: string | null, fired: number | null = null): void {
  emit(d, { kind: 'abortProbe', op: d.s.op })
  cancelArmed(d, fired)
  if (failure !== null) report(d, failure)
  beginStop(d, run, reason, failure, false)
}

type StoppingPhase = Extract<ServePhase, { kind: 'stopping' }>

function updateStopping(d: Draft, phase: StoppingPhase, patch: Partial<StoppingPhase>): void {
  set(d, { phase: { ...phase, ...patch } })
}

function sendSignal(d: Draft, phase: StoppingPhase, signal: ServePosixSignal): void {
  emit(d, { kind: 'signalGroup', op: d.s.op, pid: phase.run.pid, signal })
  updateStopping(d, phase, { step: { kind: 'signal', signal }, acts: [...phase.acts, signal], probe: null })
}

/** darwin answers EPERM to killpg on a group holding only a zombie; for a group the Deck spawned under its own account, that means empty. */
function groupGoneOnDarwin(state: ServeLifecycleState, code: string | undefined): boolean {
  return state.platform === 'darwin' && code === 'EPERM'
}

function requestStop(d: Draft, reason: 'operator' | 'quit'): void {
  const phase = d.s.phase
  switch (phase.kind) {
    case 'idle':
      return
    case 'preparing':
      enterIdle(d, null)
      d.reply = ACCEPTED
      return
    case 'spawning':
      if (phase.pendingStop === null) set(d, { phase: { ...phase, pendingStop: reason } })
      d.reply = DEFERRED
      return
    case 'probing':
      stopProbing(d, phase.run, reason, null)
      d.reply = ACCEPTED
      return
    case 'ready':
      beginStop(d, phase.run, reason, null, false)
      d.reply = ACCEPTED
      return
    case 'stopping':
      d.reply = DEFERRED
      return
    default:
      assertNever(phase)
  }
}

function exitDescription(code: number | null, signal: string | null): string {
  return signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
}

function stale(event: ServeLifecycleEvent, state: ServeLifecycleState): boolean {
  if (event.kind === 'TimerFired') return !armedTimers(state.phase).includes(event.timerId)
  if (event.kind === 'GroupProbed') return event.op !== state.op || state.phase.kind !== 'stopping' || state.phase.probe !== event.probeId
  if ('op' in event) return event.op !== state.op
  return false
}

export function reduce(state: ServeLifecycleState, event: ServeLifecycleEvent): ServeReduction {
  if (stale(event, state)) return { state, effects: [], reply: NONE }
  const d: Draft = { s: state, effects: [], reply: NONE }
  const phase = state.phase
  switch (event.kind) {
    case 'Start': {
      if (phase.kind !== 'idle') {
        d.reply = BUSY
        break
      }
      if (state.quitting) {
        d.reply = { kind: 'rejected', reason: 'serve is shutting down' }
        break
      }
      const op = state.op + 1
      set(d, { op, phase: { kind: 'preparing' } })
      emit(d, { kind: 'prepare', op, action: event.action })
      d.reply = ACCEPTED
      break
    }
    case 'Stop':
      requestStop(d, 'operator')
      break
    case 'Quit':
      if (!state.quitting) set(d, { quitting: true })
      requestStop(d, 'quit')
      break
    case 'QuitDeadline': {
      if (phase.kind !== 'stopping') break
      const message = 'serve process did not stop before the quit deadline'
      if (isPosix(state)) {
        if (!phase.acts.includes('SIGKILL')) emit(d, { kind: 'signalGroup', op: state.op, pid: phase.run.pid, signal: 'SIGKILL' })
      } else if (!phase.acts.includes('killLeader') && !phase.leaderExited) {
        emit(d, { kind: 'killLeader', op: state.op })
      }
      report(d, message)
      enterIdle(d, phase.failure ?? message)
      break
    }
    case 'Prepared':
      if (phase.kind !== 'preparing') break
      set(d, { phase: { kind: 'spawning', launch: event.launch, pendingStop: null } })
      emit(d, {
        kind: 'spawn',
        op: state.op,
        file: event.launch.file,
        args: event.launch.args,
        cwd: event.launch.cwd,
        env: event.launch.env,
        detached: isPosix(state)
      })
      break
    case 'PrepareFailed':
      if (phase.kind !== 'preparing') break
      report(d, event.message)
      enterIdle(d, event.message)
      break
    case 'Spawned': {
      if (phase.kind !== 'spawning') break
      const run: ServeRun = { launch: phase.launch, pid: event.pid }
      if (phase.pendingStop !== null) {
        beginStop(d, run, phase.pendingStop, null, false)
        break
      }
      emit(d, { kind: 'openLog', op: state.op })
      set(d, { logOpen: state.op })
      const deadlineTimer = arm(d, 'readyDeadline', phase.launch.readyTimeoutMs)
      emit(d, { kind: 'probe', op: state.op, url: phase.launch.health, timeoutMs: phase.launch.readyTimeoutMs })
      set(d, { phase: { kind: 'probing', run, deadlineTimer, delayTimer: null, lastStatus: 'no response' } })
      break
    }
    case 'SpawnFailed':
      if (phase.kind !== 'spawning') break
      report(d, event.message)
      enterIdle(d, event.message)
      break
    case 'LogFailed': {
      if (phase.kind !== 'probing' && phase.kind !== 'ready' && phase.kind !== 'stopping') break
      const message = `could not open the serve log: ${event.message}`
      set(d, { logOpen: null })
      if (phase.kind === 'stopping') {
        report(d, message)
        break
      }
      if (phase.kind === 'probing') {
        stopProbing(d, phase.run, 'logSetup', message)
        break
      }
      report(d, message)
      beginStop(d, phase.run, 'logSetup', message, false)
      break
    }
    case 'ProbeAnswered':
      if (phase.kind !== 'probing' || phase.delayTimer !== null) break
      if (event.status >= 200 && event.status <= 399) {
        cancelArmed(d)
        set(d, { phase: { kind: 'ready', run: phase.run } })
        break
      }
      set(d, { phase: { ...phase, lastStatus: `HTTP ${event.status}`, delayTimer: arm(d, 'probeDelay', PROBE_INTERVAL_MS) } })
      break
    case 'ProbeFailed':
      if (phase.kind !== 'probing' || phase.delayTimer !== null) break
      set(d, { phase: { ...phase, lastStatus: event.message, delayTimer: arm(d, 'probeDelay', PROBE_INTERVAL_MS) } })
      break
    case 'TimerFired':
      if (phase.kind === 'probing') {
        if (event.timerId === phase.delayTimer) {
          set(d, { phase: { ...phase, delayTimer: null } })
          emit(d, { kind: 'probe', op: state.op, url: phase.run.launch.health, timeoutMs: phase.run.launch.readyTimeoutMs })
          break
        }
        stopProbing(d, phase.run, 'readinessTimeout', `health check ${phase.run.launch.health} timed out after ${phase.lastStatus}`, event.timerId)
        break
      }
      if (phase.kind === 'stopping' && phase.step.kind === 'grace' && phase.step.timerId === event.timerId) {
        sendSignal(d, phase, phase.step.signal === 'SIGINT' ? 'SIGTERM' : 'SIGKILL')
        break
      }
      if (phase.kind === 'stopping' && phase.step.kind === 'leaderGrace' && phase.step.timerId === event.timerId) {
        const message = 'serve leader did not exit after taskkill failed'
        report(d, message)
        enterIdle(d, phase.failure ?? message, event.timerId)
      }
      break
    case 'SignalResult': {
      if (phase.kind !== 'stopping' || phase.step.kind !== 'signal' || phase.step.signal !== event.signal) break
      if (
        event.outcome === 'absent' ||
        (event.outcome === 'failed' && groupGoneOnDarwin(state, event.code)) ||
        (event.outcome === 'sent' && event.signal === 'SIGKILL')
      ) {
        enterIdle(d, phase.failure)
        break
      }
      if (event.outcome === 'sent') {
        const timerId = arm(d, 'grace', STOP_GRACE_MS)
        const probe = phase.leaderExited ? probeGroup(d, phase.run.pid) : null
        updateStopping(d, phase, { step: { kind: 'grace', signal: event.signal as 'SIGINT' | 'SIGTERM', timerId }, probe })
        break
      }
      report(d, `could not send ${event.signal} to serve process group ${phase.run.pid}: ${event.message ?? event.code ?? 'unknown error'}`)
      if (event.signal === 'SIGKILL') {
        const probe = probeGroup(d, phase.run.pid)
        updateStopping(d, phase, { step: { kind: 'killProbe' }, probe })
        break
      }
      sendSignal(d, phase, event.signal === 'SIGINT' ? 'SIGTERM' : 'SIGKILL')
      break
    }
    case 'GroupProbed': {
      if (phase.kind !== 'stopping' || (phase.step.kind !== 'grace' && phase.step.kind !== 'killProbe')) break
      if (event.outcome === 'absent' || (event.outcome === 'failed' && groupGoneOnDarwin(state, event.code))) {
        enterIdle(d, phase.failure)
        break
      }
      if (phase.step.kind === 'grace') {
        updateStopping(d, phase, { probe: null })
        break
      }
      const message = `serve process group ${phase.run.pid} is unreachable after SIGKILL`
      report(d, message)
      enterIdle(d, phase.failure ?? message)
      break
    }
    case 'TaskkillDone': {
      if (phase.kind !== 'stopping' || phase.step.kind !== 'taskkill') break
      if (event.code === 0) {
        enterIdle(d, phase.failure)
        break
      }
      const message = `taskkill failed for serve pid ${phase.run.pid}: ${event.stderr.trim()}`
      report(d, message)
      if (phase.leaderExited) {
        enterIdle(d, phase.failure ?? message)
        break
      }
      emit(d, { kind: 'killLeader', op: state.op })
      const timerId = arm(d, 'grace', STOP_GRACE_MS)
      updateStopping(d, phase, {
        failure: phase.failure ?? message,
        step: { kind: 'leaderGrace', timerId },
        acts: [...phase.acts, 'killLeader']
      })
      break
    }
    case 'ChildExited': {
      const exit = exitDescription(event.code, event.signal)
      if (phase.kind === 'probing' || phase.kind === 'ready') {
        const message = `serve process exited with ${exit}${phase.kind === 'probing' ? ' before readiness' : ''}`
        if (phase.kind === 'probing') emit(d, { kind: 'abortProbe', op: state.op })
        if (isPosix(state)) {
          cancelArmed(d)
          report(d, message)
          beginStop(d, phase.run, 'leaderExited', message, true)
          break
        }
        report(d, message)
        enterIdle(d, message)
        break
      }
      if (phase.kind !== 'stopping' || phase.leaderExited) break
      if (phase.step.kind === 'grace') {
        updateStopping(d, phase, { leaderExited: true, probe: probeGroup(d, phase.run.pid) })
        break
      }
      updateStopping(d, phase, { leaderExited: true })
      if (phase.step.kind === 'leaderGrace') {
        const message = 'serve leader exited after taskkill failed; its descendants may survive'
        report(d, message)
        enterIdle(d, phase.failure ?? message)
      }
      break
    }
    case 'ChildError': {
      if (phase.kind !== 'probing' && phase.kind !== 'ready' && phase.kind !== 'stopping') break
      const message = `serve process error: ${event.message}`
      if (phase.kind === 'stopping') {
        report(d, message)
        break
      }
      if (phase.kind === 'probing') {
        stopProbing(d, phase.run, 'childError', message)
        break
      }
      report(d, message)
      beginStop(d, phase.run, 'childError', message, false)
      break
    }
    default:
      assertNever(event)
  }
  return { state: d.s, effects: d.effects, reply: d.reply }
}
