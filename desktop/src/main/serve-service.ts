import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, platform as hostPlatform } from 'node:os'
import { EventEmitter } from 'node:events'
import { win32 } from 'node:path'
import { createRollingLogger, reportError } from './log'
import { isMintedServeAction, type ApprovedServeAction, type ServeAction } from './serve-config'
import {
  SERVE_QUIT_DEADLINE_MS,
  SYSTEM_COMMAND_TIMEOUT_MS,
  initialServeLifecycle,
  reduce,
  selectServePublicState,
  type ServeLaunch,
  type ServeLifecycleEffect,
  type ServeLifecycleEvent,
  type ServeLifecycleState,
  type ServeReply,
  type ServePosixSignal
} from './serve-lifecycle'
import {
  LOGIN_ENV_CAPTURE_TIMEOUT_MS,
  captureLoginEnv,
  loginEnvSeed,
  loginShell,
  type LoginEnvRequest,
  type ServeEnv
} from './serve-login-env'
import { buildShellInvocation } from './shell-command'
import { system32Dir } from './windows-system-root'

export type ServeStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'stopping'

export interface ServeState {
  status: ServeStatus
  url?: string
  port?: number
  pid?: number
  error?: string
}

export interface ServeStartOutcome {
  outcome: 'started' | 'busy' | 'quitting' | 'refused'
  state: ServeState
}

export interface ServeOutput {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

export interface ServeChild {
  readonly pid: number | undefined
  readonly stdout?: ServeOutput | null
  readonly stderr?: ServeOutput | null
  kill(): void
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export interface ServeSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  detached: boolean
  stdio: ['ignore', 'pipe', 'pipe']
  windowsHide: true
}

export interface ServeLog {
  info(text: string): void
  error(text: string): void
}

export interface ServeLogOptions {
  onWriteFailure(file: string, error: unknown): void
}

export interface ServeFetchResponse {
  status: number
  body?: { cancel(): Promise<unknown> | unknown } | null
}

export interface ServeCommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface ServeServiceDeps {
  sessionDir: () => string
  platform?: NodeJS.Platform
  systemRoot?: string
  allocatePort?: () => Promise<number>
  fetch?: (url: string, init?: { signal?: AbortSignal; redirect?: 'manual' }) => Promise<ServeFetchResponse>
  setTimer?: (ms: number, fire: () => void) => unknown
  clearTimer?: (handle: unknown) => void
  spawn?: (file: string, args: string[], options: ServeSpawnOptions) => ServeChild
  run?: (file: string, args: string[]) => Promise<ServeCommandResult>
  /** Signal 0 probes the group without signalling it. */
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void
  createLog?: (dir: string, options: ServeLogOptions) => ServeLog
  reportError?: typeof reportError
  /** The Deck's own environment: the Windows base, the source of inheritEnv and of the login seed. */
  env?: Readonly<Record<string, string | undefined>>
  /** The operator's shell, used for the login capture only when /etc/shells lists it by absolute path. */
  shell?: string
  etcShells?: () => string
  homeDir?: string
  captureLoginEnv?: (request: LoginEnvRequest) => Promise<ServeEnv>
}

type ExecFileLike = (
  file: string,
  args: string[],
  options: { encoding: 'utf-8'; windowsHide: true; timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => unknown

const HOST = '127.0.0.1'
/** serve.json is shared through the repository, so its command keeps one meaning whatever shell each operator logs in with. */
const COMMAND_SHELL = '/bin/sh'
export const SERVE_LOG_FILE = 'serve.log'

function interpolate(value: string, port: number): string {
  return value.replace(/\$\{(HOST|PORT)\}/g, (_match, name: string) => (name === 'HOST' ? HOST : String(port)))
}

async function defaultAllocatePort(): Promise<number> {
  const net = await import('node:net')
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (!address || typeof address === 'string') throw new Error('automatic port allocation returned no TCP port')
  return address.port
}

/** Never rejects: a spawn failure or a timeout kill resolves with a non-zero code and the error message as stderr. */
export function runSystemCommand(
  file: string,
  args: string[],
  execFileImpl: ExecFileLike = execFile as unknown as ExecFileLike
): Promise<ServeCommandResult> {
  return new Promise((resolve) => {
    execFileImpl(file, args, { encoding: 'utf-8', windowsHide: true, timeout: SYSTEM_COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      const exitCode = (error as { code?: unknown } | null)?.code
      const code = !error ? 0 : typeof exitCode === 'number' ? exitCode : 1
      const errorText = String(stderr ?? '')
      resolve({ code, stdout: String(stdout ?? ''), stderr: error && errorText.trim() === '' ? error.message : errorText })
    })
  })
}

function defaultSpawn(file: string, args: string[], options: ServeSpawnOptions): ServeChild {
  return spawn(file, args, options) as unknown as ServeChild
}

function windowsSystemExecutable(systemRoot: string | undefined, name: string): string {
  const root = system32Dir(systemRoot)
  if (!root.ok) throw new Error(`cannot resolve Windows system executable: ${root.reason}`)
  return win32.join(root.dir, name)
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A missing /etc/shells lists no shell, so the capture falls back to /bin/sh with a trace. */
function defaultEtcShells(): string {
  try {
    return readFileSync('/etc/shells', 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function defaultLog(dir: string, options: ServeLogOptions): ServeLog {
  return createRollingLogger({
    dir,
    name: SERVE_LOG_FILE.slice(0, -'.log'.length),
    mirrorToConsole: false,
    onWriteFailure: options.onWriteFailure
  })
}

interface Waiter {
  readonly until: (state: ServeLifecycleState) => boolean
  readonly resolve: () => void
}

export class ServeService extends EventEmitter {
  private readonly platform: NodeJS.Platform
  private readonly systemRoot: string | undefined
  private readonly allocatePort: () => Promise<number>
  private readonly fetch: (url: string, init?: { signal?: AbortSignal; redirect?: 'manual' }) => Promise<ServeFetchResponse>
  private readonly setTimer: (ms: number, fire: () => void) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly spawn: (file: string, args: string[], options: ServeSpawnOptions) => ServeChild
  private readonly run: (file: string, args: string[]) => Promise<ServeCommandResult>
  private readonly signal: (pid: number, signal: NodeJS.Signals | 0) => void
  private readonly createLog: (dir: string, options: ServeLogOptions) => ServeLog
  private readonly reportError: typeof reportError
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly shell: string | undefined
  private readonly etcShells: () => string
  private readonly homeDir: string
  private readonly captureLoginEnv: (request: LoginEnvRequest) => Promise<ServeEnv>
  private machine: ServeLifecycleState
  private published: ServeState
  private readonly queue: ServeLifecycleEvent[] = []
  private dispatching = false
  private readonly timers = new Map<number, unknown>()
  private readonly waiters: Waiter[] = []
  private taskkillFile: { op: number; file: string } | null = null
  private child: { op: number; child: ServeChild } | null = null
  private log: { op: number; log: ServeLog } | null = null
  private probe: { op: number; controller: AbortController } | null = null

  constructor(private readonly deps: ServeServiceDeps) {
    super()
    this.platform = deps.platform ?? hostPlatform()
    this.systemRoot = deps.systemRoot ?? process.env.SystemRoot
    this.allocatePort = deps.allocatePort ?? defaultAllocatePort
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init))
    this.setTimer = deps.setTimer ?? ((ms, fire) => setTimeout(fire, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.spawn = deps.spawn ?? defaultSpawn
    this.run = deps.run ?? ((file, args) => runSystemCommand(file, args))
    this.signal = deps.signal ?? ((pid, signal) => process.kill(pid, signal))
    this.createLog = deps.createLog ?? defaultLog
    this.reportError = deps.reportError ?? reportError
    this.env = deps.env ?? process.env
    this.shell = deps.shell ?? process.env.SHELL
    this.etcShells = deps.etcShells ?? defaultEtcShells
    this.homeDir = deps.homeDir ?? homedir()
    this.captureLoginEnv = deps.captureLoginEnv ?? captureLoginEnv
    this.machine = initialServeLifecycle(this.platform)
    this.published = { ...selectServePublicState(this.machine) }
  }

  state(): ServeState {
    return { ...this.published }
  }

  /** Only `started` means this call launched the run; its state may still end in `failed`. */
  async start(action: ApprovedServeAction): Promise<ServeStartOutcome> {
    if (!isMintedServeAction(action)) {
      this.reportError('serve', 'refused to start a serve action that did not come from the operator approval')
      return { outcome: 'refused', state: this.state() }
    }
    if (this.dispatching) return { outcome: 'busy', state: this.state() }
    const reply = this.dispatch({ kind: 'Start', action })
    if (reply?.kind !== 'accepted') {
      return { outcome: reply?.kind === 'rejected' ? 'quitting' : 'busy', state: this.state() }
    }
    await this.waitFor((state) => state.phase.kind !== 'preparing' && state.phase.kind !== 'spawning')
    return { outcome: 'started', state: this.state() }
  }

  async stop(): Promise<void> {
    this.dispatch({ kind: 'Stop' })
    await this.waitFor((state) => state.phase.kind === 'idle')
  }

  /** Settles at the next idle; past the deadline a run still stopping is killed (SIGKILL or killLeader) and forced to idle. */
  async quit(options: { deadlineMs?: number } = {}): Promise<void> {
    this.dispatch({ kind: 'Quit' })
    const deadline = this.setTimer(options.deadlineMs ?? SERVE_QUIT_DEADLINE_MS, () => this.dispatch({ kind: 'QuitDeadline' }))
    try {
      await this.waitFor((state) => state.phase.kind === 'idle')
    } finally {
      this.clearTimer(deadline)
    }
  }

  private waitFor(until: (state: ServeLifecycleState) => boolean): Promise<void> {
    if (until(this.machine)) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push({ until, resolve }))
  }

  /** @returns the reply to `event`, or null when it was queued behind the event being processed. */
  private dispatch(event: ServeLifecycleEvent): ServeReply | null {
    if (this.dispatching) {
      this.queue.push(event)
      return null
    }
    this.dispatching = true
    try {
      return this.process(event)
    } finally {
      try {
        for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) this.process(next)
      } finally {
        this.dispatching = false
      }
    }
  }

  private process(event: ServeLifecycleEvent): ServeReply | null {
    let effects: readonly ServeLifecycleEffect[]
    let reply: ServeReply
    try {
      const reduction = reduce(this.machine, event)
      this.machine = reduction.state
      effects = reduction.effects
      reply = reduction.reply
    } catch (error) {
      this.reportError('serve', `Serve lifecycle event ${event.kind} failed`, error)
      return null
    }
    for (const effect of effects) {
      try {
        this.perform(effect)
      } catch (error) {
        this.reportError('serve', `Serve effect ${effect.kind} failed outside its failure path`, error)
      }
    }
    this.publish()
    return reply
  }

  private publish(): void {
    const next = selectServePublicState(this.machine)
    if (JSON.stringify(next) !== JSON.stringify(this.published)) {
      this.published = { ...next }
      try {
        this.emit('changed', this.state())
      } catch (error) {
        this.reportError('serve', 'Serve state listener failed', error)
      }
    }
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index]!
      if (!waiter.until(this.machine)) continue
      this.waiters.splice(index, 1)
      waiter.resolve()
    }
  }

  private perform(effect: ServeLifecycleEffect): void {
    switch (effect.kind) {
      case 'prepare':
        void this.prepare(effect.op, effect.action)
        return
      case 'spawn':
        this.spawnChild(effect)
        return
      case 'openLog':
        this.openLog(effect.op)
        return
      case 'closeLog':
        if (this.log?.op === effect.op) this.log = null
        return
      case 'probe':
        this.startProbe(effect.op, effect.url)
        return
      case 'abortProbe':
        if (this.probe?.op === effect.op) this.probe.controller.abort()
        return
      case 'signalGroup':
        this.signalGroup(effect.op, effect.pid, effect.signal)
        return
      case 'probeGroup':
        this.probeGroup(effect.op, effect.pid, effect.probeId)
        return
      case 'taskkill':
        void this.taskkill(effect.op, effect.pid)
        return
      case 'killLeader':
        if (this.child?.op === effect.op) this.child.child.kill()
        return
      case 'armTimer': {
        const timerId = effect.timerId
        this.timers.set(timerId, this.setTimer(effect.delayMs, () => {
          this.timers.delete(timerId)
          this.dispatch({ kind: 'TimerFired', timerId })
        }))
        return
      }
      case 'cancelTimer': {
        const handle = this.timers.get(effect.timerId)
        if (handle === undefined) return
        this.timers.delete(effect.timerId)
        this.clearTimer(handle)
        return
      }
      case 'report':
        this.reportError('serve', effect.message)
        return
      default:
        effect satisfies never
    }
  }

  private captureLoginBase(): Promise<ServeEnv> {
    const shell = loginShell(this.shell, this.etcShells())
    if (shell !== this.shell) {
      this.reportError('serve', `login shell ${this.shell ?? '(unset)'} is not an absolute path listed in /etc/shells; capturing the login environment with ${shell}`)
    }
    return this.captureLoginEnv({ shell, cwd: this.homeDir, seed: loginEnvSeed(this.env), timeoutMs: LOGIN_ENV_CAPTURE_TIMEOUT_MS })
  }

  private async prepare(op: number, action: ServeAction): Promise<void> {
    let launch: ServeLaunch
    try {
      const port = action.port === 'auto' ? await this.allocatePort() : action.port
      const windows = this.platform === 'win32'
      const base = windows ? this.env : await this.captureLoginBase()
      const env: NodeJS.ProcessEnv = { ...base }
      for (const name of action.inheritEnv) {
        const value = this.env[name]
        if (value !== undefined) env[name] = value
      }
      for (const [name, value] of Object.entries(action.env)) env[name] = interpolate(value, port)
      env.HOST = HOST
      env.PORT = String(port)
      const command = interpolate(action.command, port)
      let invocation: { file: string; args: string[] }
      if (windows) {
        this.taskkillFile = { op, file: windowsSystemExecutable(this.systemRoot, 'taskkill.exe') }
        const shell = windowsSystemExecutable(this.systemRoot, 'WindowsPowerShell\\v1.0\\powershell.exe')
        invocation = buildShellInvocation({ command, shell, interactive: false }, this.platform)
      } else {
        invocation = { file: COMMAND_SHELL, args: ['-c', command] }
      }
      launch = {
        file: invocation.file,
        args: invocation.args,
        cwd: action.cwd,
        env,
        url: interpolate(action.url, port),
        health: interpolate(action.health, port),
        port,
        readyTimeoutMs: action.readyTimeoutSec * 1000
      }
    } catch (error) {
      this.dispatch({ kind: 'PrepareFailed', op, message: errorMessage(error) })
      return
    }
    this.dispatch({ kind: 'Prepared', op, launch })
  }

  private spawnChild(effect: Extract<ServeLifecycleEffect, { kind: 'spawn' }>): void {
    const op = effect.op
    let child: ServeChild
    try {
      child = this.spawn(effect.file, [...effect.args], {
        cwd: effect.cwd,
        env: { ...effect.env },
        detached: effect.detached,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      this.dispatch({ kind: 'SpawnFailed', op, message: errorMessage(error) })
      return
    }
    child.once('exit', (code, signal) => this.dispatch({ kind: 'ChildExited', op, code, signal }))
    child.once('error', (error) => this.dispatch({ kind: 'ChildError', op, message: error.message }))
    child.stdout?.on('data', (chunk) => {
      if (this.log?.op === op) this.log.log.info(String(chunk))
    })
    child.stderr?.on('data', (chunk) => {
      if (this.log?.op === op) this.log.log.error(String(chunk))
    })
    if (child.pid === undefined) {
      this.dispatch({ kind: 'SpawnFailed', op, message: 'serve process did not expose a pid' })
      return
    }
    this.child = { op, child }
    this.dispatch({ kind: 'Spawned', op, pid: child.pid })
  }

  private openLog(op: number): void {
    try {
      const log = this.createLog(this.deps.sessionDir(), {
        onWriteFailure: (file, error) => this.reportError('serve', `could not write serve log ${file}`, error)
      })
      this.log = { op, log }
    } catch (error) {
      this.dispatch({ kind: 'LogFailed', op, message: errorMessage(error) })
    }
  }

  private startProbe(op: number, url: string): void {
    const controller = new AbortController()
    this.probe = { op, controller }
    const signal = controller.signal
    void Promise.resolve()
      // Following a redirect would let the dev server send the Deck past the loopback rule of serve.json; a 3xx already counts as an answer.
      .then(() => this.fetch(url, { signal, redirect: 'manual' }))
      .then(
        (response) => {
          if (response.body) {
            void Promise.resolve()
              .then(() => response.body!.cancel())
              .catch((error) => this.reportError('serve', 'could not cancel serve health response body', error))
          }
          this.dispatch({ kind: 'ProbeAnswered', op, status: response.status })
        },
        (error) => this.dispatch({ kind: 'ProbeFailed', op, message: errorMessage(error) })
      )
  }

  private signalGroup(op: number, pid: number, signal: ServePosixSignal): void {
    try {
      this.signal(-pid, signal)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ESRCH') this.dispatch({ kind: 'SignalResult', op, signal, outcome: 'absent' })
      else this.dispatch({ kind: 'SignalResult', op, signal, outcome: 'failed', code, message: errorMessage(error) })
      return
    }
    this.dispatch({ kind: 'SignalResult', op, signal, outcome: 'sent' })
  }

  private probeGroup(op: number, pid: number, probeId: number): void {
    try {
      this.signal(-pid, 0)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ESRCH') this.dispatch({ kind: 'GroupProbed', op, probeId, outcome: 'absent' })
      else this.dispatch({ kind: 'GroupProbed', op, probeId, outcome: 'failed', code, message: errorMessage(error) })
      return
    }
    this.dispatch({ kind: 'GroupProbed', op, probeId, outcome: 'present' })
  }

  private async taskkill(op: number, pid: number): Promise<void> {
    let result: ServeCommandResult
    try {
      if (this.taskkillFile?.op !== op) throw new Error(`no taskkill path resolved for serve run ${op}`)
      result = await this.run(this.taskkillFile.file, ['/T', '/F', '/PID', String(pid)])
    } catch (error) {
      result = { code: 1, stdout: '', stderr: errorMessage(error) }
    }
    this.dispatch({ kind: 'TaskkillDone', op, code: result.code, stderr: result.stderr })
  }
}
