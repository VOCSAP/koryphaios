import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { platform as hostPlatform } from 'node:os'
import { EventEmitter } from 'node:events'
import { win32 } from 'node:path'
import { createRollingLogger, reportError } from './log'
import { type ServeAction } from './serve-config'
import { buildShellInvocation } from './shell-command'
import { system32Dir } from './windows-system-root'
import {
  measurePosixProcessStamp,
  measureWindowsProcessStamp,
  sameProcessStamp,
  type ProcessStamp
} from './process-stamp'

export type { ProcessStamp } from './process-stamp'

export type ServeStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'stopping'

export interface ServeState {
  status: ServeStatus
  url?: string
  port?: number
  pid?: number
  error?: string
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

export interface ServeServiceDeps {
  sessionDir: () => string
  platform?: NodeJS.Platform
  systemRoot?: string
  allocatePort?: () => Promise<number>
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<ServeFetchResponse>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  spawn?: (file: string, args: string[], options: ServeSpawnOptions) => ServeChild
  run?: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  signal?: (pid: number, signal: NodeJS.Signals) => void
  measureProcess?: (pid: number, platform: NodeJS.Platform) => Promise<ProcessStamp>
  createLog?: (dir: string, options: ServeLogOptions) => ServeLog
  reportError?: typeof reportError
}

interface RunningServe {
  child: ServeChild
  pid: number
  stamp: ProcessStamp
  url: string
  health: string
  port: number
  exited: boolean
  stopping?: Promise<void>
}

const HOST = '127.0.0.1'
const READINESS_INTERVAL_MS = 500
const STOP_GRACE_MS = 3000
const SYSTEM_COMMAND_TIMEOUT_MS = 3000
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

function defaultRun(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf-8', windowsHide: true, timeout: SYSTEM_COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (error as NodeJS.ErrnoException & { code: number }).code
        : error
          ? 1
          : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
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

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ESRCH'
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function defaultMeasureProcess(
  pid: number,
  platform: NodeJS.Platform,
  systemRoot: string | undefined,
  run: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
): Promise<ProcessStamp> {
  const deps = {
    run,
    readFile: defaultReadFile,
    powershellPath: platform === 'win32'
      ? windowsSystemExecutable(systemRoot, 'WindowsPowerShell\\v1.0\\powershell.exe')
      : undefined
  }
  if (platform === 'win32') return measureWindowsProcessStamp(deps, pid)
  return measurePosixProcessStamp(deps, platform, pid)
}

function defaultLog(dir: string, options: ServeLogOptions): ServeLog {
  return createRollingLogger({
    dir,
    name: SERVE_LOG_FILE.slice(0, -'.log'.length),
    mirrorToConsole: false,
    onWriteFailure: options.onWriteFailure
  })
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ServeService extends EventEmitter {
  private readonly platform: NodeJS.Platform
  private readonly allocatePort: () => Promise<number>
  private readonly fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<ServeFetchResponse>
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly spawn: (file: string, args: string[], options: ServeSpawnOptions) => ServeChild
  private readonly run: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void
  private readonly measureProcess: (pid: number, platform: NodeJS.Platform) => Promise<ProcessStamp>
  private readonly createLog: (dir: string, options: ServeLogOptions) => ServeLog
  private readonly reportError: typeof reportError
  private current: RunningServe | null = null
  private currentLog: ServeLog | null = null
  private startPromise: Promise<ServeState> | null = null
  private currentState: ServeState = { status: 'idle' }

  constructor(private readonly deps: ServeServiceDeps) {
    super()
    this.platform = deps.platform ?? hostPlatform()
    this.allocatePort = deps.allocatePort ?? defaultAllocatePort
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init))
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
    this.spawn = deps.spawn ?? defaultSpawn
    this.run = deps.run ?? defaultRun
    this.signal = deps.signal ?? process.kill
    this.measureProcess = deps.measureProcess ?? ((pid, platform) =>
      defaultMeasureProcess(pid, platform, deps.systemRoot ?? process.env.SystemRoot, this.run)
    )
    this.createLog = deps.createLog ?? defaultLog
    this.reportError = deps.reportError ?? reportError
  }

  state(): ServeState {
    return { ...this.currentState }
  }

  async start(action: ServeAction): Promise<ServeState> {
    if (this.current || this.startPromise) return this.state()
    const pending = this.startInner(action)
    this.startPromise = pending
    try {
      return await pending
    } finally {
      if (this.startPromise === pending) this.startPromise = null
    }
  }

  async stop(): Promise<void> {
    if (this.startPromise) await this.startPromise
    const running = this.current
    if (!running) return
    this.setState({ status: 'stopping', url: running.url, port: running.port, pid: running.pid })
    const stopping = running.stopping ??= this.stopRunning(running)
    try {
      await stopping
      if (this.current === running) this.current = null
      if (this.current === null) {
        this.currentLog = null
        this.setState({ status: 'idle' })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportError('serve', message, error)
      if (this.current === running) this.current = null
      if (this.current === null) {
        this.currentLog = null
        this.setState({ status: 'failed', url: running.url, port: running.port, pid: running.pid, error: message })
      }
    }
  }

  private async startInner(action: ServeAction): Promise<ServeState> {
    let child: ServeChild | null = null
    let groupVerified = false
    const startup = {
      exit: null as { code: number | null; signal: NodeJS.Signals | null } | null,
      error: null as Error | null
    }
    this.setState({ status: 'starting' })
    try {
      const port = action.port === 'auto' ? await this.allocatePort() : action.port
      const url = interpolate(action.url, port)
      const health = interpolate(action.health, port)
      const env: NodeJS.ProcessEnv = { ...process.env }
      for (const name of action.inheritEnv) {
        const value = process.env[name]
        if (value !== undefined) env[name] = value
      }
      for (const [name, value] of Object.entries(action.env)) env[name] = interpolate(value, port)
      env.HOST = HOST
      env.PORT = String(port)
      const invocation = buildShellInvocation({ command: interpolate(action.command, port), shell: '', interactive: false }, this.platform)
      child = this.spawn(invocation.file, invocation.args, {
        cwd: action.cwd,
        env,
        detached: this.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      child.once('exit', (code, signal) => {
        startup.exit = { code, signal }
      })
      child.once('error', (error) => {
        startup.error = error
      })
      if (child.pid === undefined) throw new Error('serve process did not expose a pid')
      const stamp = await this.measureProcess(child.pid, this.platform)
      if (startup.error) throw startup.error
      const exited = startup.exit
      if (exited) {
        const exit = exited.signal ? `signal ${exited.signal}` : `code ${exited.code ?? 'unknown'}`
        throw new Error(`serve process exited with ${exit} before readiness`)
      }
      if (stamp.pid !== child.pid || stamp.platform !== this.platform) {
        throw new Error(`cannot establish identity for serve pid ${child.pid}`)
      }
      if (stamp.platform !== 'win32' && stamp.pgid !== child.pid) {
        throw new Error(`serve pid ${child.pid} does not lead its process group`)
      }
      groupVerified = stamp.platform === 'win32' || stamp.pgid === child.pid
      const running: RunningServe = { child, pid: child.pid, stamp, url, health, port, exited: false }
      this.current = running
      this.attachChild(running)
      this.currentLog = this.createLog(this.deps.sessionDir(), {
        onWriteFailure: (file, error) => this.reportError('serve', `could not write serve log ${file}`, error)
      })
      child.stdout?.on('data', (chunk) => this.currentLog?.info(String(chunk)))
      child.stderr?.on('data', (chunk) => this.currentLog?.error(String(chunk)))
      void this.awaitReady(running, action.readyTimeoutSec).catch((error) =>
        this.reportError('serve', 'serve readiness task failed', error)
      )
      return this.state()
    } catch (error) {
      if (child) await this.terminateStartupChild(child, startup.exit !== null, groupVerified)
      if (this.current?.child === child) this.current = null
      this.currentLog = null
      const message = error instanceof Error ? error.message : String(error)
      this.reportError('serve', 'serve process could not start', error)
      this.setState({ status: 'failed', error: message })
      return this.state()
    }
  }

  private async terminateStartupChild(child: ServeChild, exited: boolean, groupVerified: boolean): Promise<void> {
    if (exited) return
    try {
      if (child.pid === undefined || !groupVerified) {
        child.kill()
        return
      }
      if (this.platform === 'win32') {
        const taskkill = windowsSystemExecutable(this.deps.systemRoot ?? process.env.SystemRoot, 'taskkill.exe')
        const result = await this.run(taskkill, ['/T', '/F', '/PID', String(child.pid)])
        if (result.code !== 0) throw new Error(`taskkill failed for serve pid ${child.pid}: ${result.stderr.trim()}`)
        return
      }
      this.signal(-child.pid, 'SIGKILL')
    } catch (error) {
      if (!isNoSuchProcess(error)) {
        this.reportError('serve', 'could not clean up failed serve process', error)
      }
    }
  }

  private attachChild(running: RunningServe): void {
    running.child.once('exit', (code, signal) => {
      running.exited = true
      if (this.current !== running) return
      this.current = null
      this.currentLog = null
      if (this.currentState.status === 'stopping') return
      const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      const message = `serve process exited with ${exit}${this.currentState.status === 'ready' ? '' : ' before readiness'}`
      this.reportError('serve', message)
      this.setState({ status: 'failed', url: running.url, port: running.port, pid: running.pid, error: message })
    })
    running.child.once('error', (error) => {
      if (this.current !== running) return
      this.current = null
      this.currentLog = null
      this.reportError('serve', 'serve process error', error)
      this.setState({ status: 'failed', url: running.url, port: running.port, pid: running.pid, error: error.message })
    })
  }

  private async awaitReady(running: RunningServe, readyTimeoutSec: number): Promise<void> {
    const deadline = this.now() + readyTimeoutSec * 1000
    let lastStatus = 'no response'
    while (this.current === running && this.currentState.status === 'starting') {
      try {
        const remaining = Math.max(0, deadline - this.now())
        const response = await this.fetch(running.health, { signal: AbortSignal.timeout(remaining) })
        if (response.body) {
          void Promise.resolve()
            .then(() => response.body!.cancel())
            .catch((error) => this.reportError('serve', 'could not cancel serve health response body', error))
        }
        if (this.current !== running || this.currentState.status !== 'starting') return
        if (response.status >= 200 && response.status <= 399) {
          this.setState({ status: 'ready', url: running.url, port: running.port, pid: running.pid })
          return
        }
        lastStatus = `HTTP ${response.status}`
      } catch (error) {
        lastStatus = error instanceof Error ? error.message : String(error)
      }
      if (this.now() >= deadline) {
        await this.fail(running, `health check ${running.health} timed out after ${lastStatus}`)
        return
      }
      await this.sleep(READINESS_INTERVAL_MS)
    }
  }

  private async fail(running: RunningServe, message: string): Promise<void> {
    if (this.current !== running) return
    this.reportError('serve', message)
    this.setState({ status: 'stopping', url: running.url, port: running.port, pid: running.pid })
    try {
      await this.stopRunning(running)
    } catch (error) {
      this.reportError('serve', 'serve process could not stop after readiness failure', error)
    }
    if (this.current === running) {
      this.current = null
      this.currentLog = null
      this.setState({ status: 'failed', url: running.url, port: running.port, pid: running.pid, error: message })
    }
  }

  private async stopRunning(running: RunningServe): Promise<void> {
    if (this.platform === 'win32') {
      await this.assertCurrentIdentity(running)
      const taskkill = windowsSystemExecutable(this.deps.systemRoot ?? process.env.SystemRoot, 'taskkill.exe')
      const result = await this.run(taskkill, ['/T', '/F', '/PID', String(running.pid)])
      if (result.code !== 0) throw new Error(`taskkill failed for serve pid ${running.pid}: ${result.stderr.trim()}`)
      return
    }
    if (!running.exited) await this.assertCurrentIdentity(running)
    if (!this.signalGroup(running.pid, 'SIGINT')) return
    await this.sleep(STOP_GRACE_MS)
    if (!running.exited) await this.assertCurrentIdentity(running)
    if (!this.signalGroup(running.pid, 'SIGTERM')) return
    await this.sleep(STOP_GRACE_MS)
    if (!running.exited) await this.assertCurrentIdentity(running)
    this.signalGroup(running.pid, 'SIGKILL')
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): boolean {
    try {
      this.signal(-pid, signal)
      return true
    } catch (error) {
      if (isNoSuchProcess(error)) return false
      throw error
    }
  }

  private async assertCurrentIdentity(running: RunningServe): Promise<void> {
    const measured = await this.measureProcess(running.pid, this.platform)
    if (!sameProcessStamp(running.stamp, measured)) {
      throw new Error('serve process identity changed before shutdown')
    }
  }

  private setState(state: ServeState): void {
    this.currentState = state
    this.emit('changed', this.state())
  }
}
