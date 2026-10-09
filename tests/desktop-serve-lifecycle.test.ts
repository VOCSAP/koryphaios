import { describe, expect, test } from 'bun:test'
import type { ServeAction } from '../desktop/src/main/serve-config.ts'
import {
  SERVE_QUIT_DEADLINE_MS,
  initialServeLifecycle,
  reduce,
  selectServePublicState,
  stopBudgetMs,
  type ServeLaunch,
  type ServeLifecycleEffect,
  type ServeLifecycleEvent,
  type ServeLifecycleEventKind,
  type ServeLifecycleState,
  type ServePhaseKind,
  type ServePosixSignal,
  type ServeReduction,
  type ServeStopAct
} from '../desktop/src/main/serve-lifecycle.ts'

type Platform = 'linux' | 'darwin' | 'win32'
const PLATFORMS: readonly Platform[] = ['linux', 'darwin', 'win32']
const POSIX: readonly Platform[] = ['linux', 'darwin']
const WINDOWS: readonly Platform[] = ['win32']
const PID = 4242

const ACTION = {
  name: 'dev',
  cwd: '/repo',
  command: 'npm run dev',
  port: 'auto',
  url: 'http://${HOST}:${PORT}/',
  health: 'http://${HOST}:${PORT}/health',
  readyTimeoutSec: 30,
  env: {},
  inheritEnv: []
} as unknown as ServeAction

const LAUNCH: ServeLaunch = {
  file: '/bin/bash',
  args: ['-l', '-c', 'npm run dev'],
  cwd: '/repo',
  env: { PORT: '5173' },
  url: 'http://127.0.0.1:5173/',
  health: 'http://127.0.0.1:5173/health',
  port: 5173,
  readyTimeoutMs: 30_000
}

type Step = (state: ServeLifecycleState) => ServeLifecycleEvent

function timerOf(state: ServeLifecycleState, kind: 'readyDeadline' | 'probeDelay' | 'grace'): number | null {
  const phase = state.phase
  if (kind === 'readyDeadline') return phase.kind === 'probing' ? phase.deadlineTimer : null
  if (kind === 'probeDelay') return phase.kind === 'probing' ? phase.delayTimer : null
  if (phase.kind !== 'stopping') return null
  return phase.step.kind === 'grace' || phase.step.kind === 'leaderGrace' ? phase.step.timerId : null
}

const start: Step = () => ({ kind: 'Start', action: ACTION })
const stop: Step = () => ({ kind: 'Stop' })
const quit: Step = () => ({ kind: 'Quit' })
const quitDeadline: Step = () => ({ kind: 'QuitDeadline' })
const prepared: Step = (s) => ({ kind: 'Prepared', op: s.op, launch: LAUNCH })
const prepareFailed: Step = (s) => ({ kind: 'PrepareFailed', op: s.op, message: 'no free port' })
const spawned: Step = (s) => ({ kind: 'Spawned', op: s.op, pid: PID })
const spawnFailed: Step = (s) => ({ kind: 'SpawnFailed', op: s.op, message: 'spawn ENOENT' })
const logFailed: Step = (s) => ({ kind: 'LogFailed', op: s.op, message: 'session dir closed' })
const probeAnswered = (status: number): Step => (s) => ({ kind: 'ProbeAnswered', op: s.op, status })
const probeFailed: Step = (s) => ({ kind: 'ProbeFailed', op: s.op, message: 'ECONNREFUSED' })
const signalResult = (signal: ServePosixSignal, outcome: 'sent' | 'absent' | 'failed', code?: string): Step => (s) => ({
  kind: 'SignalResult',
  op: s.op,
  signal,
  outcome,
  ...(code ? { code, message: code } : {})
})
function probeOf(state: ServeLifecycleState): number | null {
  return state.phase.kind === 'stopping' ? state.phase.probe : null
}

function armedIds(state: ServeLifecycleState): number[] {
  return (['readyDeadline', 'probeDelay', 'grace'] as const).flatMap((kind) => {
    const id = timerOf(state, kind)
    return id === null ? [] : [id]
  })
}

/** The highest id already issued that the machine is not waiting for, so a stale answer looks like a real late one. */
function retiredId(next: number, live: readonly number[]): number {
  for (let id = next - 1; id >= 1; id--) if (!live.includes(id)) return id
  return 9999
}

const groupProbedWith = (outcome: 'present' | 'absent' | 'failed', code: string | undefined, probeId: (s: ServeLifecycleState) => number) => (s: ServeLifecycleState): ServeLifecycleEvent => ({
  kind: 'GroupProbed',
  op: s.op,
  probeId: probeId(s),
  outcome,
  ...(code ? { code, message: code } : {})
})
const groupProbed = (outcome: 'present' | 'absent' | 'failed', code?: string): Step =>
  groupProbedWith(outcome, code, (s) => {
    const probe = probeOf(s)
    if (probe === null) throw new Error('no group probe outstanding')
    return probe
  })
const taskkillDone = (code: number): Step => (s) => ({ kind: 'TaskkillDone', op: s.op, code, stderr: code === 0 ? '' : 'Access denied.\r\n' })
const childExited: Step = (s) => ({ kind: 'ChildExited', op: s.op, code: 1, signal: null })
const childError: Step = (s) => ({ kind: 'ChildError', op: s.op, message: 'EPIPE' })
const fire = (kind: 'readyDeadline' | 'probeDelay' | 'grace'): Step => (s) => {
  const timerId = timerOf(s, kind)
  if (timerId === null) throw new Error(`no ${kind} timer armed`)
  return { kind: 'TimerFired', timerId }
}

function replay(platform: Platform, steps: readonly Step[]): ServeLifecycleState {
  let state = initialServeLifecycle(platform)
  for (const step of steps) state = reduce(state, step(state)).state
  return state
}

interface Fixture {
  readonly name: string
  readonly platforms: readonly Platform[]
  readonly steps: readonly Step[]
}

const PROBING = [start, prepared, spawned]
const READY = [...PROBING, probeAnswered(200)]
const P_STOP = [...READY, stop]
const P_GRACE1 = [...P_STOP, signalResult('SIGINT', 'sent')]
const P_GRACE2 = [...P_GRACE1, fire('grace'), signalResult('SIGTERM', 'sent')]
const P_KILL = [...P_GRACE2, fire('grace')]
const P_TERM_EXITED = [...P_GRACE1, childExited, fire('grace')]
const P_GRACE2_EXITED = [...P_TERM_EXITED, signalResult('SIGTERM', 'sent')]
const W_STOP = [...READY, stop]

const FIXTURES: readonly Fixture[] = [
  { name: 'idle', platforms: PLATFORMS, steps: [] },
  { name: 'idleFailed', platforms: PLATFORMS, steps: [start, prepareFailed] },
  { name: 'idleQuitting', platforms: PLATFORMS, steps: [quit] },
  { name: 'preparing', platforms: PLATFORMS, steps: [start] },
  { name: 'spawning', platforms: PLATFORMS, steps: [start, prepared] },
  { name: 'spawningPendingStop', platforms: PLATFORMS, steps: [start, prepared, stop] },
  { name: 'probing', platforms: PLATFORMS, steps: PROBING },
  { name: 'probingDelay', platforms: PLATFORMS, steps: [...PROBING, probeFailed] },
  { name: 'probingRetry', platforms: PLATFORMS, steps: [...PROBING, probeFailed, fire('probeDelay')] },
  { name: 'ready', platforms: PLATFORMS, steps: READY },
  { name: 'stopSignal', platforms: POSIX, steps: P_STOP },
  { name: 'stopGrace1', platforms: POSIX, steps: P_GRACE1 },
  { name: 'stopGrace1Exited', platforms: POSIX, steps: [...P_GRACE1, childExited] },
  { name: 'stopTermSignal', platforms: POSIX, steps: [...P_GRACE1, fire('grace')] },
  { name: 'stopTermSignalExited', platforms: POSIX, steps: P_TERM_EXITED },
  { name: 'stopGrace2', platforms: POSIX, steps: P_GRACE2 },
  { name: 'stopGrace2Exited', platforms: POSIX, steps: P_GRACE2_EXITED },
  { name: 'stopKillSignal', platforms: POSIX, steps: P_KILL },
  { name: 'stopKillSignalExited', platforms: POSIX, steps: [...P_GRACE2_EXITED, fire('grace')] },
  { name: 'stopKillProbe', platforms: POSIX, steps: [...P_KILL, signalResult('SIGKILL', 'failed', 'EIO')] },
  { name: 'stopLeaderExited', platforms: POSIX, steps: [...PROBING, childExited] },
  { name: 'pStopQuitting', platforms: POSIX, steps: [...READY, quit] },
  { name: 'stopTaskkill', platforms: WINDOWS, steps: W_STOP },
  { name: 'stopTaskkillExited', platforms: WINDOWS, steps: [...W_STOP, childExited] },
  { name: 'stopLeaderGrace', platforms: WINDOWS, steps: [...W_STOP, taskkillDone(1)] },
  { name: 'wStopQuitting', platforms: WINDOWS, steps: [...READY, quit] }
]

interface Variant {
  readonly name: string
  readonly fresh: (state: ServeLifecycleState) => ServeLifecycleEvent | null
  readonly stale: ((state: ServeLifecycleState) => ServeLifecycleEvent) | null
}

function command(name: string, step: Step): Variant {
  return { name, fresh: step, stale: null }
}

function result(name: string, step: Step): Variant {
  return { name, fresh: step, stale: (s) => step({ ...s, op: s.op - 1 }) }
}

function timer(kind: 'readyDeadline' | 'probeDelay' | 'grace'): Variant {
  return {
    name: `TimerFired:${kind}`,
    fresh: (s) => (timerOf(s, kind) === null ? null : fire(kind)(s)),
    stale: (s) => ({ kind: 'TimerFired', timerId: retiredId(s.nextTimerId, armedIds(s)) })
  }
}

function probeAnswer(name: string, outcome: 'present' | 'absent' | 'failed', code?: string): Variant {
  return {
    name,
    fresh: (s) => (probeOf(s) === null ? null : groupProbed(outcome, code)(s)),
    stale: groupProbedWith(outcome, code, (s) => {
      const probe = probeOf(s)
      return retiredId(s.nextProbeId, probe === null ? [] : [probe])
    })
  }
}

const SIGNALS: readonly ServePosixSignal[] = ['SIGINT', 'SIGTERM', 'SIGKILL']

const VARIANTS = {
  Start: [command('Start', start)],
  Stop: [command('Stop', stop)],
  Quit: [command('Quit', quit)],
  QuitDeadline: [command('QuitDeadline', quitDeadline)],
  Prepared: [result('Prepared', prepared)],
  PrepareFailed: [result('PrepareFailed', prepareFailed)],
  Spawned: [result('Spawned', spawned)],
  SpawnFailed: [result('SpawnFailed', spawnFailed)],
  LogFailed: [result('LogFailed', logFailed)],
  ProbeAnswered: [result('ProbeAnswered:200', probeAnswered(200)), result('ProbeAnswered:503', probeAnswered(503))],
  ProbeFailed: [result('ProbeFailed', probeFailed)],
  SignalResult: SIGNALS.flatMap((signal) => [
    result(`SignalResult:${signal}:sent`, signalResult(signal, 'sent')),
    result(`SignalResult:${signal}:absent`, signalResult(signal, 'absent')),
    result(`SignalResult:${signal}:EPERM`, signalResult(signal, 'failed', 'EPERM')),
    result(`SignalResult:${signal}:EIO`, signalResult(signal, 'failed', 'EIO'))
  ]),
  GroupProbed: [
    probeAnswer('GroupProbed:present', 'present'),
    probeAnswer('GroupProbed:absent', 'absent'),
    probeAnswer('GroupProbed:EPERM', 'failed', 'EPERM'),
    probeAnswer('GroupProbed:EIO', 'failed', 'EIO')
  ],
  TaskkillDone: [result('TaskkillDone:0', taskkillDone(0)), result('TaskkillDone:1', taskkillDone(1))],
  ChildExited: [result('ChildExited', childExited)],
  ChildError: [result('ChildError', childError)],
  TimerFired: [timer('readyDeadline'), timer('probeDelay'), timer('grace')]
} satisfies Record<ServeLifecycleEventKind, readonly Variant[]>

const ALL_VARIANTS: readonly Variant[] = Object.values(VARIANTS).flat()

const SAME = '='
type Reply = 'none' | 'accepted' | 'deferred' | 'busy' | 'rejected'
type Outcome = readonly [label: string, effects: readonly string[], reply?: Reply]
type Cell = Outcome | { readonly posix?: Outcome; readonly linux?: Outcome; readonly darwin?: Outcome; readonly win32?: Outcome }
type Row = Readonly<Record<string, Cell>>

function split(posix: Outcome, win32: Outcome): Cell {
  return { posix, win32 }
}

function stopping(label: string, quitting = false): Row {
  return {
    Start: [SAME, [], 'busy'],
    Stop: [SAME, [], 'deferred'],
    Quit: quitting ? [SAME, [], 'deferred'] : [`${label}/q`, [], 'deferred'],
    ChildError: [SAME, ['report']],
    LogFailed: [label, ['report']]
  }
}

function quitted(row: Row): Row {
  const mark = (o: Outcome): Outcome => [o[0] === SAME ? SAME : `${o[0]}/q`, o[1], o[2]]
  return Object.fromEntries(
    Object.entries(row).map(([name, cell]) => [
      name,
      Array.isArray(cell)
        ? mark(cell as Outcome)
        : Object.fromEntries(Object.entries(cell).map(([p, o]) => [p, mark(o as Outcome)]))
    ])
  )
}

const BUSY: Outcome = [SAME, [], 'busy']
const F = 'failed{pid,port,url}'

const P_STOP_SIGNAL_CELLS: Row = {
  QuitDeadline: [F, ['signal:SIGKILL', 'report', 'closeLog']],
  'SignalResult:SIGINT:sent': ['stopping:grace:SIGINT', ['arm:grace']],
  'SignalResult:SIGINT:absent': ['idle', ['closeLog']],
  'SignalResult:SIGINT:EPERM': { linux: ['stopping:signal:SIGTERM', ['report', 'signal:SIGTERM']], darwin: ['idle', ['closeLog']] },
  'SignalResult:SIGINT:EIO': ['stopping:signal:SIGTERM', ['report', 'signal:SIGTERM']],
  ChildExited: ['stopping:signal:SIGINT+exited', []]
}

const W_STOP_TASKKILL_CELLS: Row = {
  'TaskkillDone:0': ['idle', ['closeLog']],
  'TaskkillDone:1': ['stopping:leaderGrace!', ['report', 'killLeader', 'arm:grace']],
  QuitDeadline: [F, ['killLeader', 'report', 'closeLog']],
  ChildExited: ['stopping:taskkill+exited', []]
}

function graceProbeAnswers(grace: string): Row {
  return {
    'GroupProbed:absent': ['idle', ['cancelTimer', 'closeLog']],
    'GroupProbed:EPERM': { linux: [grace, []], darwin: ['idle', ['cancelTimer', 'closeLog']] },
    'GroupProbed:present': [grace, []],
    'GroupProbed:EIO': [grace, []]
  }
}

function killSignalCells(probing: string): Row {
  return {
    QuitDeadline: [F, ['report', 'closeLog']],
    'SignalResult:SIGKILL:sent': ['idle', ['closeLog']],
    'SignalResult:SIGKILL:absent': ['idle', ['closeLog']],
    'SignalResult:SIGKILL:EPERM': { linux: [probing, ['report', 'probeGroup']], darwin: ['idle', ['closeLog']] },
    'SignalResult:SIGKILL:EIO': [probing, ['report', 'probeGroup']]
  }
}

function termSignalCells(next: string, grace: string, graceEffects: readonly string[]): Row {
  return {
    QuitDeadline: [F, ['signal:SIGKILL', 'report', 'closeLog']],
    'SignalResult:SIGTERM:sent': [grace, graceEffects],
    'SignalResult:SIGTERM:absent': ['idle', ['closeLog']],
    'SignalResult:SIGTERM:EPERM': { linux: [next, ['report', 'signal:SIGKILL']], darwin: ['idle', ['closeLog']] },
    'SignalResult:SIGTERM:EIO': [next, ['report', 'signal:SIGKILL']]
  }
}

const BASE_TABLE: Readonly<Record<string, Row>> = {
  idle: {
    Start: ['preparing', ['prepare'], 'accepted'],
    Quit: ['idle/q', []]
  },
  idleFailed: {
    Start: ['preparing', ['prepare'], 'accepted'],
    Quit: ['failed{}/q', []]
  },
  idleQuitting: {
    Start: [SAME, [], 'rejected']
  },
  preparing: {
    Start: BUSY,
    Stop: ['idle', [], 'accepted'],
    Quit: ['idle/q', [], 'accepted'],
    Prepared: ['spawning', ['spawn']],
    PrepareFailed: ['failed{}', ['report']]
  },
  spawning: {
    Start: BUSY,
    Stop: ['spawning+stop', [], 'deferred'],
    Quit: ['spawning+stop/q', [], 'deferred'],
    Spawned: ['probing', ['openLog', 'arm:readyDeadline', 'probe']],
    SpawnFailed: ['failed{port,url}', ['report']]
  },
  spawningPendingStop: {
    Start: BUSY,
    Stop: [SAME, [], 'deferred'],
    Quit: ['spawning+stop/q', [], 'deferred'],
    Spawned: split(['stopping:signal:SIGINT', ['signal:SIGINT']], ['stopping:taskkill', ['taskkill']]),
    SpawnFailed: ['failed{port,url}', ['report']]
  },
  probing: {
    Start: BUSY,
    Stop: split(
      ['stopping:signal:SIGINT', ['abortProbe', 'cancelTimer', 'signal:SIGINT'], 'accepted'],
      ['stopping:taskkill', ['abortProbe', 'cancelTimer', 'taskkill'], 'accepted']
    ),
    Quit: split(
      ['stopping:signal:SIGINT/q', ['abortProbe', 'cancelTimer', 'signal:SIGINT'], 'accepted'],
      ['stopping:taskkill/q', ['abortProbe', 'cancelTimer', 'taskkill'], 'accepted']
    ),
    LogFailed: split(
      ['stopping:signal:SIGINT!', ['abortProbe', 'cancelTimer', 'report', 'signal:SIGINT']],
      ['stopping:taskkill!', ['abortProbe', 'cancelTimer', 'report', 'taskkill']]
    ),
    'ProbeAnswered:200': ['ready', ['cancelTimer']],
    'ProbeAnswered:503': ['probing:wait', ['arm:probeDelay']],
    ProbeFailed: ['probing:wait', ['arm:probeDelay']],
    'TimerFired:readyDeadline': split(
      ['stopping:signal:SIGINT!', ['abortProbe', 'report', 'signal:SIGINT']],
      ['stopping:taskkill!', ['abortProbe', 'report', 'taskkill']]
    ),
    ChildExited: split(
      ['stopping:signal:SIGINT+exited!', ['abortProbe', 'cancelTimer', 'report', 'signal:SIGINT']],
      [F, ['abortProbe', 'report', 'cancelTimer', 'closeLog']]
    ),
    ChildError: split(
      ['stopping:signal:SIGINT!', ['abortProbe', 'cancelTimer', 'report', 'signal:SIGINT']],
      ['stopping:taskkill!', ['abortProbe', 'cancelTimer', 'report', 'taskkill']]
    )
  },
  probingDelay: {
    Start: BUSY,
    Stop: split(
      ['stopping:signal:SIGINT', ['abortProbe', 'cancelTimer', 'cancelTimer', 'signal:SIGINT'], 'accepted'],
      ['stopping:taskkill', ['abortProbe', 'cancelTimer', 'cancelTimer', 'taskkill'], 'accepted']
    ),
    Quit: split(
      ['stopping:signal:SIGINT/q', ['abortProbe', 'cancelTimer', 'cancelTimer', 'signal:SIGINT'], 'accepted'],
      ['stopping:taskkill/q', ['abortProbe', 'cancelTimer', 'cancelTimer', 'taskkill'], 'accepted']
    ),
    LogFailed: split(
      ['stopping:signal:SIGINT!', ['abortProbe', 'cancelTimer', 'cancelTimer', 'report', 'signal:SIGINT']],
      ['stopping:taskkill!', ['abortProbe', 'cancelTimer', 'cancelTimer', 'report', 'taskkill']]
    ),
    'TimerFired:probeDelay': ['probing', ['probe']],
    'TimerFired:readyDeadline': split(
      ['stopping:signal:SIGINT!', ['abortProbe', 'cancelTimer', 'report', 'signal:SIGINT']],
      ['stopping:taskkill!', ['abortProbe', 'cancelTimer', 'report', 'taskkill']]
    ),
    ChildExited: split(
      ['stopping:signal:SIGINT+exited!', ['abortProbe', 'cancelTimer', 'cancelTimer', 'report', 'signal:SIGINT']],
      [F, ['abortProbe', 'report', 'cancelTimer', 'cancelTimer', 'closeLog']]
    ),
    ChildError: split(
      ['stopping:signal:SIGINT!', ['abortProbe', 'cancelTimer', 'cancelTimer', 'report', 'signal:SIGINT']],
      ['stopping:taskkill!', ['abortProbe', 'cancelTimer', 'cancelTimer', 'report', 'taskkill']]
    )
  },
  ready: {
    Start: BUSY,
    Stop: split(['stopping:signal:SIGINT', ['signal:SIGINT'], 'accepted'], ['stopping:taskkill', ['taskkill'], 'accepted']),
    Quit: split(['stopping:signal:SIGINT/q', ['signal:SIGINT'], 'accepted'], ['stopping:taskkill/q', ['taskkill'], 'accepted']),
    LogFailed: split(['stopping:signal:SIGINT!', ['report', 'signal:SIGINT']], ['stopping:taskkill!', ['report', 'taskkill']]),
    ChildExited: split(['stopping:signal:SIGINT+exited!', ['report', 'signal:SIGINT']], [F, ['report', 'closeLog']]),
    ChildError: split(['stopping:signal:SIGINT!', ['report', 'signal:SIGINT']], ['stopping:taskkill!', ['report', 'taskkill']])
  },
  stopSignal: { ...stopping('stopping:signal:SIGINT'), ...P_STOP_SIGNAL_CELLS },
  stopGrace1: {
    ...stopping('stopping:grace:SIGINT'),
    QuitDeadline: [F, ['signal:SIGKILL', 'report', 'cancelTimer', 'closeLog']],
    'TimerFired:grace': ['stopping:signal:SIGTERM', ['signal:SIGTERM']],
    ChildExited: ['stopping:grace:SIGINT+exited?', ['probeGroup']]
  },
  stopGrace1Exited: {
    ...stopping('stopping:grace:SIGINT+exited?'),
    ...graceProbeAnswers('stopping:grace:SIGINT+exited'),
    QuitDeadline: [F, ['signal:SIGKILL', 'report', 'cancelTimer', 'closeLog']],
    'TimerFired:grace': ['stopping:signal:SIGTERM+exited', ['signal:SIGTERM']]
  },
  stopTermSignal: {
    ...stopping('stopping:signal:SIGTERM'),
    ...termSignalCells('stopping:signal:SIGKILL', 'stopping:grace:SIGTERM', ['arm:grace']),
    ChildExited: ['stopping:signal:SIGTERM+exited', []]
  },
  stopTermSignalExited: {
    ...stopping('stopping:signal:SIGTERM+exited'),
    ...termSignalCells('stopping:signal:SIGKILL+exited', 'stopping:grace:SIGTERM+exited?', ['arm:grace', 'probeGroup'])
  },
  stopGrace2: {
    ...stopping('stopping:grace:SIGTERM'),
    QuitDeadline: [F, ['signal:SIGKILL', 'report', 'cancelTimer', 'closeLog']],
    'TimerFired:grace': ['stopping:signal:SIGKILL', ['signal:SIGKILL']],
    ChildExited: ['stopping:grace:SIGTERM+exited?', ['probeGroup']]
  },
  stopGrace2Exited: {
    ...stopping('stopping:grace:SIGTERM+exited?'),
    ...graceProbeAnswers('stopping:grace:SIGTERM+exited'),
    QuitDeadline: [F, ['signal:SIGKILL', 'report', 'cancelTimer', 'closeLog']],
    'TimerFired:grace': ['stopping:signal:SIGKILL+exited', ['signal:SIGKILL']]
  },
  stopKillSignal: {
    ...stopping('stopping:signal:SIGKILL'),
    ...killSignalCells('stopping:killProbe?'),
    ChildExited: ['stopping:signal:SIGKILL+exited', []]
  },
  stopKillSignalExited: {
    ...stopping('stopping:signal:SIGKILL+exited'),
    ...killSignalCells('stopping:killProbe+exited?')
  },
  stopKillProbe: {
    ...stopping('stopping:killProbe?'),
    QuitDeadline: [F, ['report', 'closeLog']],
    'GroupProbed:absent': ['idle', ['closeLog']],
    'GroupProbed:present': [F, ['report', 'closeLog']],
    'GroupProbed:EIO': [F, ['report', 'closeLog']],
    'GroupProbed:EPERM': { linux: [F, ['report', 'closeLog']], darwin: ['idle', ['closeLog']] },
    ChildExited: ['stopping:killProbe+exited?', []]
  },
  stopLeaderExited: {
    ...stopping('stopping:signal:SIGINT+exited!'),
    QuitDeadline: [F, ['signal:SIGKILL', 'report', 'closeLog']],
    'SignalResult:SIGINT:sent': ['stopping:grace:SIGINT+exited!?', ['arm:grace', 'probeGroup']],
    'SignalResult:SIGINT:absent': [F, ['closeLog']],
    'SignalResult:SIGINT:EPERM': {
      linux: ['stopping:signal:SIGTERM+exited!', ['report', 'signal:SIGTERM']],
      darwin: [F, ['closeLog']]
    },
    'SignalResult:SIGINT:EIO': ['stopping:signal:SIGTERM+exited!', ['report', 'signal:SIGTERM']]
  },
  pStopQuitting: { ...stopping('stopping:signal:SIGINT/q', true), ...quitted(P_STOP_SIGNAL_CELLS) },
  stopTaskkill: { ...stopping('stopping:taskkill'), ...W_STOP_TASKKILL_CELLS },
  stopTaskkillExited: {
    ...stopping('stopping:taskkill+exited'),
    'TaskkillDone:0': ['idle', ['closeLog']],
    'TaskkillDone:1': [F, ['report', 'closeLog']],
    QuitDeadline: [F, ['report', 'closeLog']]
  },
  stopLeaderGrace: {
    ...stopping('stopping:leaderGrace!'),
    'TimerFired:grace': [F, ['report', 'closeLog']],
    ChildExited: [F, ['report', 'cancelTimer', 'closeLog']],
    QuitDeadline: [F, ['report', 'cancelTimer', 'closeLog']]
  },
  wStopQuitting: { ...stopping('stopping:taskkill/q', true), ...quitted(W_STOP_TASKKILL_CELLS) }
}

const TABLE: Readonly<Record<string, Row>> = { ...BASE_TABLE, probingRetry: BASE_TABLE.probing! }

/** Shows what each cell must preserve beyond the phase: the public failure fields, a pending failure (!) and an outstanding group probe (?). */
function label(state: ServeLifecycleState): string {
  const phase = state.phase
  let base: string
  switch (phase.kind) {
    case 'idle':
      base = phase.failure ? `failed{${Object.keys(phase.failure).filter((key) => key !== 'message').sort().join(',')}}` : 'idle'
      break
    case 'preparing':
    case 'ready':
      base = phase.kind
      break
    case 'spawning':
      base = phase.pendingStop ? 'spawning+stop' : 'spawning'
      break
    case 'probing':
      base = phase.delayTimer === null ? 'probing' : 'probing:wait'
      break
    case 'stopping': {
      const step = phase.step
      const stepLabel = step.kind === 'signal' || step.kind === 'grace' ? `${step.kind}:${step.signal}` : step.kind
      base = `stopping:${stepLabel}${phase.leaderExited ? '+exited' : ''}${phase.failure !== null ? '!' : ''}${phase.probe !== null ? '?' : ''}`
      break
    }
  }
  return state.quitting ? `${base}/q` : base
}

function effectLabel(effect: ServeLifecycleEffect): string {
  if (effect.kind === 'signalGroup') return `signal:${effect.signal}`
  if (effect.kind === 'armTimer') return `arm:${effect.timer}`
  return effect.kind
}

function resolveCell(cell: Cell | undefined, platform: Platform): Outcome | undefined {
  if (cell === undefined) return undefined
  if (Array.isArray(cell)) return cell as Outcome
  const split = cell as Exclude<Cell, Outcome>
  return split[platform] ?? (platform === 'win32' ? undefined : split.posix)
}

function owns(state: ServeLifecycleState): boolean {
  const kind = state.phase.kind
  return kind === 'probing' || kind === 'ready' || kind === 'stopping'
}

function preActs(state: ServeLifecycleState): readonly ServeStopAct[] {
  return state.phase.kind === 'stopping' ? state.phase.acts : []
}

function emittedActs(effects: readonly ServeLifecycleEffect[]): ServeStopAct[] {
  const acts: ServeStopAct[] = []
  for (const effect of effects) {
    if (effect.kind === 'signalGroup') acts.push(effect.signal)
    if (effect.kind === 'taskkill' || effect.kind === 'killLeader') acts.push(effect.kind)
  }
  return acts
}

function assertInvariants(platform: Platform, pre: ServeLifecycleState, event: ServeLifecycleEvent, out: ServeReduction): void {
  const post = out.state
  const emitted = emittedActs(out.effects)
  const prior = preActs(pre)

  if (owns(pre) && post.phase.kind === 'idle') {
    const failedWith = (code: string): boolean =>
      (event.kind === 'SignalResult' || event.kind === 'GroupProbed') && event.outcome === 'failed' && event.code === code
    const allowed =
      ((event.kind === 'SignalResult' || event.kind === 'GroupProbed') && event.outcome === 'absent') ||
      (platform === 'darwin' && failedWith('EPERM')) ||
      prior.includes('SIGKILL') ||
      emitted.includes('SIGKILL') ||
      (event.kind === 'TaskkillDone' && event.code === 0) ||
      prior.includes('killLeader') ||
      emitted.includes('killLeader') ||
      (platform === 'win32' && (event.kind === 'ChildExited' || (pre.phase.kind === 'stopping' && pre.phase.leaderExited)))
    expect(allowed, 'I1: an owned process entered idle without its group gone, SIGKILL, taskkill success, killLeader or an observed Windows exit').toBe(true)
  }

  for (const act of emitted) {
    expect(prior.includes(act), `I2: ${act} emitted twice for one op`).toBe(false)
    expect(emitted.filter((other) => other === act).length, `I2: ${act} emitted twice in one reduction`).toBe(1)
  }
  if (post.phase.kind === 'stopping') {
    for (const act of emitted) expect(post.phase.acts.includes(act), `I2: ${act} not recorded in acts`).toBe(true)
  }

  if (platform === 'win32' && (event.kind === 'ChildExited' || (pre.phase.kind === 'stopping' && pre.phase.leaderExited))) {
    expect(emitted.includes('taskkill'), 'I3: taskkill after an observed Windows exit').toBe(false)
  }

  if (pre.quitting || post.quitting) {
    expect(out.effects.some((effect) => effect.kind === 'prepare' || effect.kind === 'spawn'), 'I4: prepare or spawn after Quit').toBe(false)
  }

  if (post.phase.kind === 'idle') {
    expect(post.logOpen, 'I6: idle with a log still open').toBeNull()
    if (pre.logOpen !== null && pre.phase.kind !== 'idle') {
      expect(out.effects, 'I6: idle entry without closeLog').toContainEqual({ kind: 'closeLog', op: pre.logOpen })
    }
  }
}

interface TableRow {
  readonly platform: Platform
  readonly fixture: Fixture
  readonly variant: Variant
  readonly freshness: 'fresh' | 'stale'
}

const ROWS: TableRow[] = []
for (const fixture of FIXTURES) {
  for (const platform of fixture.platforms) {
    const pre = replay(platform, fixture.steps)
    for (const variant of ALL_VARIANTS) {
      if (variant.fresh(pre) !== null) ROWS.push({ platform, fixture, variant, freshness: 'fresh' })
      if (variant.stale) ROWS.push({ platform, fixture, variant, freshness: 'stale' })
    }
  }
}

describe('Serve lifecycle table', () => {
  test.each(ROWS.map((row) => [`${row.platform} ${row.fixture.name} ${row.variant.name} ${row.freshness}`, row] as const))('%s', (_name, row) => {
    const pre = replay(row.platform, row.fixture.steps)
    const event = row.freshness === 'fresh' ? row.variant.fresh(pre)! : row.variant.stale!(pre)
    const out = reduce(pre, event)
    assertInvariants(row.platform, pre, event, out)

    if (row.freshness === 'stale') {
      expect(out.state, 'I5: a stale result changed the state').toBe(pre)
      expect(out.effects, 'I5: a stale result emitted an effect').toEqual([])
      expect(out.reply).toEqual({ kind: 'none' })
      return
    }

    const expected = resolveCell(TABLE[row.fixture.name]?.[row.variant.name], row.platform)
    if (expected === undefined) {
      expect(out.state, 'unlisted cell changed the state').toEqual(pre)
      expect(out.effects.map(effectLabel), 'unlisted cell emitted an effect').toEqual([])
      expect(out.reply.kind).toBe('none')
      return
    }
    const [to, effects, reply = 'none'] = expected
    if (to === SAME) expect(out.state).toEqual(pre)
    else expect(label(out.state)).toBe(to)
    expect(out.effects.map(effectLabel)).toEqual([...effects])
    expect(out.reply.kind).toBe(reply)
  })
})

describe('Serve lifecycle table coverage', () => {
  test('fixtures reach every phase on every platform', () => {
    for (const platform of PLATFORMS) {
      const reached = new Set(FIXTURES.filter((f) => f.platforms.includes(platform)).map((f) => replay(platform, f.steps).phase.kind))
      const phases: ServePhaseKind[] = ['idle', 'preparing', 'spawning', 'probing', 'ready', 'stopping']
      expect([...reached].sort(), platform).toEqual([...phases].sort())
    }
  })

  test('every table cell names a fixture and an event variant that a row plays', () => {
    const played = new Set(ROWS.filter((row) => row.freshness === 'fresh').map((row) => `${row.fixture.name}/${row.variant.name}`))
    for (const [fixture, row] of Object.entries(TABLE)) {
      for (const variant of Object.keys(row)) expect(played.has(`${fixture}/${variant}`), `${fixture}/${variant}`).toBe(true)
    }
  })

  test('every fixture replays without a stale or ignored step', () => {
    for (const fixture of FIXTURES) {
      for (const platform of fixture.platforms) {
        let state = initialServeLifecycle(platform)
        for (const step of fixture.steps) {
          const next = reduce(state, step(state))
          expect(next.state, `${platform} ${fixture.name}`).not.toBe(state)
          state = next.state
        }
      }
    }
  })
})

function run(platform: Platform, steps: readonly Step[]): { state: ServeLifecycleState; effects: ServeLifecycleEffect[] } {
  let state = initialServeLifecycle(platform)
  const effects: ServeLifecycleEffect[] = []
  for (const step of steps) {
    const out = reduce(state, step(state))
    assertInvariants(platform, state, step(state), out)
    effects.push(...out.effects)
    state = out.state
  }
  return { state, effects }
}

function signalsOf(effects: readonly ServeLifecycleEffect[]): string[] {
  return effects.flatMap((effect) => (effect.kind === 'signalGroup' ? [effect.signal] : []))
}

describe('Serve lifecycle scenarios', () => {
  test('a Stop during the readiness-failure escalation joins it instead of starting a second one', () => {
    const { state, effects } = run('linux', [
      ...PROBING,
      fire('readyDeadline'),
      stop,
      signalResult('SIGINT', 'sent'),
      stop,
      fire('grace'),
      signalResult('SIGTERM', 'sent'),
      fire('grace'),
      signalResult('SIGKILL', 'sent')
    ])
    expect(signalsOf(effects)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])
    expect(selectServePublicState(state)).toMatchObject({ status: 'failed', error: `health check ${LAUNCH.health} timed out after no response` })
  })

  test('a leader reaped during the grace ends the stop on the group probe, without waiting for the grace', () => {
    const { state, effects } = run('linux', [...P_GRACE1, childExited, groupProbed('absent')])
    expect(signalsOf(effects)).toEqual(['SIGINT'])
    expect(effects.at(-2)).toEqual({ kind: 'cancelTimer', timerId: timerOf(replay('linux', P_GRACE1), 'grace')! })
    expect(selectServePublicState(state)).toEqual({ status: 'idle' })
  })

  test('a group probe answered after its grace ended is ignored by the next step', () => {
    const inGrace = replay('linux', [...P_GRACE1, childExited])
    const late = groupProbed('present')(inGrace)
    const term = reduce(inGrace, fire('grace')(inGrace)).state
    expect(reduce(term, late)).toEqual({ state: term, effects: [], reply: { kind: 'none' } })

    const killProbe = replay('linux', [...P_GRACE2_EXITED, fire('grace'), signalResult('SIGKILL', 'failed', 'EIO')])
    expect(probeOf(killProbe)).not.toBe((late as { probeId: number }).probeId)
    expect(reduce(killProbe, late)).toEqual({ state: killProbe, effects: [], reply: { kind: 'none' } })
  })

  test('a leader exit observed before SIGTERM lands probes the group with the grace', () => {
    const { effects } = run('linux', [...P_TERM_EXITED, signalResult('SIGTERM', 'sent'), groupProbed('absent')])
    expect(signalsOf(effects)).toEqual(['SIGINT', 'SIGTERM'])
    expect(effects.filter((effect) => effect.kind === 'probeGroup')).toHaveLength(2)
  })

  test('an unexpected child error after readiness ends failed with its message', () => {
    const { state } = run('linux', [...READY, childError, signalResult('SIGINT', 'absent')])
    expect(selectServePublicState(state)).toEqual({ status: 'failed', url: LAUNCH.url, port: LAUNCH.port, pid: PID, error: 'serve process error: EPIPE' })
  })

  test('a spawn failure keeps the prepared url and port', () => {
    const { state } = run('darwin', [start, prepared, spawnFailed])
    expect(selectServePublicState(state)).toEqual({ status: 'failed', url: LAUNCH.url, port: LAUNCH.port, error: 'spawn ENOENT' })
  })

  test('a POSIX leader that exits alone has its group reaped, then reports the exit', () => {
    const { state, effects } = run('linux', [...READY, childExited, signalResult('SIGINT', 'absent')])
    expect(signalsOf(effects)).toEqual(['SIGINT'])
    expect(selectServePublicState(state)).toEqual({
      status: 'failed',
      url: LAUNCH.url,
      port: LAUNCH.port,
      pid: PID,
      error: 'serve process exited with code 1'
    })
  })

  test('darwin EPERM after the leader exit means an empty group, while Linux keeps escalating', () => {
    const steps = [...READY, childExited, signalResult('SIGINT', 'failed', 'EPERM')]
    const darwin = run('darwin', steps)
    expect(darwin.state.phase.kind).toBe('idle')
    expect(darwin.effects.filter((effect) => effect.kind === 'report')).toHaveLength(1)
    const linux = run('linux', steps)
    expect(signalsOf(linux.effects)).toEqual(['SIGINT', 'SIGTERM'])
  })

  test('a Windows exit during an in-flight taskkill fails without a second taskkill or a leader kill', () => {
    const { state, effects } = run('win32', [...W_STOP, childExited, taskkillDone(1)])
    expect(effects.filter((effect) => effect.kind === 'taskkill' || effect.kind === 'killLeader').map((effect) => effect.kind)).toEqual(['taskkill'])
    expect(selectServePublicState(state)).toMatchObject({ status: 'failed', error: `taskkill failed for serve pid ${PID}: Access denied.` })
  })

  test('the quit deadline after a failed SIGKILL sends no second SIGKILL', () => {
    const { state, effects } = run('linux', [...P_KILL, signalResult('SIGKILL', 'failed', 'EIO'), quit, quitDeadline])
    expect(signalsOf(effects)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])
    expect(state.phase.kind).toBe('idle')
  })

  test('a Quit during spawning stops the spawned process without opening its log', () => {
    const { state, effects } = run('linux', [start, prepared, quit, spawned, signalResult('SIGINT', 'absent')])
    expect(effects.some((effect) => effect.kind === 'openLog')).toBe(false)
    expect(selectServePublicState(state)).toEqual({ status: 'idle' })
  })

  test('a log that cannot open stops the process and fails with the log error', () => {
    const { state } = run('win32', [...PROBING, logFailed, taskkillDone(0)])
    expect(selectServePublicState(state)).toMatchObject({ status: 'failed', pid: PID, error: 'could not open the serve log: session dir closed' })
  })

  test('a Start after Quit is rejected and prepares nothing', () => {
    const state = replay('linux', [quit])
    const out = reduce(state, start(state))
    expect(out.reply).toEqual({ kind: 'rejected', reason: 'serve is shutting down' })
    expect(out.effects).toEqual([])
  })

  test('a result from a closed run is ignored by the next run', () => {
    const closed = replay('linux', [...READY, stop, signalResult('SIGINT', 'absent')])
    const late: ServeLifecycleEvent = { kind: 'ChildExited', op: closed.op, code: 0, signal: null }
    const state = replay('linux', [...READY, stop, signalResult('SIGINT', 'absent'), ...PROBING])
    expect(reduce(state, late)).toEqual({ state, effects: [], reply: { kind: 'none' } })
  })

  test('the stop budget fits under the quit deadline, which fits under the quit effect bound', () => {
    for (const platform of PLATFORMS) {
      expect(stopBudgetMs(platform)).toBeLessThan(SERVE_QUIT_DEADLINE_MS)
    }
    expect(SERVE_QUIT_DEADLINE_MS).toBeLessThan(16_000)
  })

  test('the spawn effect carries the prepared executable and detaches only on POSIX', () => {
    for (const platform of PLATFORMS) {
      const { effects } = run(platform, [start, prepared])
      expect(effects.at(-1)).toMatchObject({ kind: 'spawn', file: LAUNCH.file, detached: platform !== 'win32' })
    }
  })
})
