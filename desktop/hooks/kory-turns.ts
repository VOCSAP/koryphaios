import type { HttpFetchInit, On } from './claude-code-types.ts'
import { isSubagentId, SESSION_END_REASONS, TURN_SIGNAL_LIMITS, type TurnSignal } from './turn-signal-wire.ts'

export interface TurnsHost {
  env: { get(name: string): Promise<string | undefined> }
  http: { fetch(url: string, init: HttpFetchInit): Promise<{ status: number }> }
  clock: { sleep(ms: number): Promise<void> }
  ui: { log(text: string, options?: { to: 'debug' }): void }
}

type SignalBody<Signal extends TurnSignal = TurnSignal> = Signal extends TurnSignal ? Omit<Signal, 'seq'> : never

/** One per module load: the module is not reloaded by /clear or /compact, so nothing here is keyed by session. */
interface TurnState {
  loadId: string
  seq: number
  chain: Promise<void>
  failures: number
  /** Seq of the latest command.run:enter that no main turn.start has claimed yet. */
  pendingCommandSeq: number | null
  /** Snapshot of the classic.Stop of the running turn; null once the turn.complete took it. */
  stoppedBackground: Background | null
}

interface Background {
  tasks: number
  shells: number
  /** Null when there are more ids than one signal carries: a cut list would drop running sub-agents. */
  subagents: string[] | null
}

function draw(): string {
  return Math.random().toString(36).slice(2).padEnd(11, '0')
}

function newTurnState(): TurnState {
  return { loadId: draw() + draw(), seq: 0, chain: Promise.resolve(), failures: 0, pendingCommandSeq: null, stoppedBackground: null }
}

/** HttpInit has no timeout: without this a fetch that never answers holds every later send. */
const SEND_TIMEOUT_MS = 10_000

let state = newTurnState()

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function post($: TurnsHost, body: string): Promise<void> {
  let failure: string | null = null
  try {
    const url = await $.env.get('KORY_TURN_SIGNAL_URL')
    if (!url) return
    const reply = await Promise.race([
      $.http.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kory-Load': state.loadId },
        body
      }),
      $.clock.sleep(SEND_TIMEOUT_MS).then(() => null)
    ])
    if (reply === null) failure = `no answer in ${SEND_TIMEOUT_MS / 1000} s`
    else if (reply.status < 200 || reply.status >= 300) failure = `status ${reply.status}`
  } catch (err) {
    failure = errorText(err)
  }
  if (failure === null) return
  state.failures += 1
  $.ui.log(`Kory turn signal send failed (${state.failures} so far): ${failure}`, { to: 'debug' })
}

/** The seq is taken when the event happens and sends run one after the other, so the Deck reads them in order; a failed send leaves a gap the Deck stops on. */
function send($: TurnsHost, signal: SignalBody): number {
  state.seq += 1
  const seq = state.seq
  const body = JSON.stringify({ ...signal, seq })
  state.chain = state.chain.then(() => post($, body))
  return seq
}

/** This final form is reserved to the Deck's step correlation and is removed whatever typed it. */
const STEP_TOKEN_TAIL = /(?:^| )kory-step:[0-9a-f]{8,32}$/

function withoutStepToken(args: string): string {
  return args.replace(STEP_TOKEN_TAIL, '')
}

const SHELL_TASK_TYPES: readonly unknown[] = ['shell', 'monitor']

function taskField(task: unknown, field: 'type' | 'id'): unknown {
  return typeof task === 'object' && task !== null ? (task as Record<string, unknown>)[field] : undefined
}

function backgroundOf(tasks: unknown[]): Background {
  const subagents = tasks
    .filter((task) => taskField(task, 'type') === 'subagent')
    .map((task) => taskField(task, 'id'))
    .filter(isSubagentId)
  return {
    tasks: tasks.length,
    shells: tasks.filter((task) => SHELL_TASK_TYPES.includes(taskField(task, 'type'))).length,
    subagents: carried(subagents)
  }
}

function carried(subagents: string[]): string[] | null {
  return subagents.length > TURN_SIGNAL_LIMITS.backgroundSubagents ? null : subagents
}

function completeCounts({ tasks, shells, subagents }: Background): { backgroundTasks: number; backgroundShells: number; backgroundSubagents?: string[] } {
  const counts = { backgroundTasks: tasks, backgroundShells: shells }
  return subagents === null ? counts : { ...counts, backgroundSubagents: subagents }
}

/** The pending Stop snapshot leaves after this signal and replaces the Deck's ids, so it has to agree with it. */
function amendStopped(kind: 'subagent.start' | 'subagent.stop', agentId: string): void {
  const stopped = state.stoppedBackground
  if (!stopped?.subagents) return
  const others = stopped.subagents.filter((id) => id !== agentId)
  state.stoppedBackground = { ...stopped, subagents: carried(kind === 'subagent.start' ? [...others, agentId] : others) }
}

/** An id the Deck parser would refuse is not sent: a refused signal stops a running Skills sequence. */
function sendSubagent($: TurnsHost, kind: 'subagent.start' | 'subagent.stop', agentId: unknown): void {
  if (!isSubagentId(agentId)) return
  amendStopped(kind, agentId)
  send($, { kind, agentId })
}

/** Called by the session.compact hook that also reports telemetry: the loader takes one registration per event. */
export function reportCompacted($: TurnsHost): void {
  send($, { kind: 'session.compact:resolved' })
}

/** Called by the session.end hook that also reports telemetry. */
export function reportSessionEnd($: TurnsHost, reason: string): void {
  const known = (SESSION_END_REASONS as readonly string[]).includes(reason)
  send($, { kind: 'session.end', reason: known ? (reason as (typeof SESSION_END_REASONS)[number]) : 'other' })
}

export function register(on: On): void {
  state = newTurnState()

  on('command.run', async ($, e, next) => {
    state.pendingCommandSeq = send($, { kind: 'command.run:enter', command: e.command, args: e.args, origin: e.origin.kind })
    const args = withoutStepToken(e.args)
    const result = await next(args === e.args ? e : { ...e, args })
    send($, { kind: 'command.run:resolved', command: e.command })
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      state.stoppedBackground = null
      const commandSeq = state.pendingCommandSeq
      state.pendingCommandSeq = null
      send($, commandSeq === null ? { kind: 'turn.start', turnId: e.turnId } : { kind: 'turn.start', turnId: e.turnId, commandSeq })
    } else {
      send($, { kind: 'turn.start', turnId: e.turnId, agentId: e.agentId })
    }
    return next(e)
  })

  on('classic.Stop', async (_$, e, next) => {
    const tasks = e.background_tasks
    state.stoppedBackground = Array.isArray(tasks) ? backgroundOf(tasks) : null
    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    sendSubagent($, 'subagent.start', e.agent_id)
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    sendSubagent($, 'subagent.stop', e.agent_id)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const complete = { kind: 'turn.complete', turnId: e.turnId, reason: e.reason, isAborted: e.isAborted } as const
    if (e.agentId !== undefined) {
      if (isSubagentId(e.agentId)) amendStopped('subagent.stop', e.agentId)
      send($, { ...complete, agentId: e.agentId })
    } else {
      const stopped = state.stoppedBackground
      state.stoppedBackground = null
      send($, stopped === null ? complete : { ...complete, ...completeCounts(stopped) })
    }
    return next(e)
  })
}
