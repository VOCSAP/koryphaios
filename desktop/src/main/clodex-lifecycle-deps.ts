// Real main-process IO of the Clodex controller: the producers the three pure
// modules leave to their caller. Nothing here imports electron, so every
// adapter is exercised under `bun test`; index.ts supplies the two values only
// it knows, the operator's login shell and the Deck logs directory.
//
// The command line of the proxy is built by the pure modules from their own
// constants: this file passes argument arrays to the OS and interpolates
// nothing from the renderer, from a cloned repository or from an agent.

import { execFile, spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, openSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { hostname, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultClodexDeps } from './clodex-bridge'
import type { ClodexController, ClodexControllerDeps } from './clodex-lifecycle-controller'
import type { SqliteConnection } from './clodex-lifecycle-io'
import type { ClodexChild, ClodexSpawnOptions } from './clodex-process-io'
import { reportError } from './log'

/** Error scope of every trace emitted by this module. */
const SCOPE = 'clodex-lifecycle'

/** Proxy output, appended under the Deck logs dir. */
const PROXY_LOG_FILE = 'clodex-proxy.log'

const RUN_TIMEOUT_MS = 15_000
const RUN_MAX_OUTPUT = 1024 * 1024
const CONNECT_TIMEOUT_MS = 2_000
const MAX_PORT = 65_535

/**
 * Longest a closing window waits for the lease. Sized on the NOMINAL release,
 * measured at 5 s of tree-stop confirmation plus two subprocesses of about
 * 200 ms, with room for a login shell ten times slower on a loaded machine.
 * It stays far under the lock budget of the controller, so an expiry can never
 * be read as a contended store.
 */
export const RELEASE_DEADLINE_MS = 10_000

export type ReleaseDeadline = 'idle' | 'done' | 'expired' | 'failed'

export type ErrorSink = (scope: string, message: string, error?: unknown) => void

export interface ClodexDepsOptions {
  /** Login shell of the PATH probe, and of the proxy on POSIX only: win32 launches it through cmd.exe. */
  shell: string
  /** Directory the proxy output file is opened in. */
  logsDir: string
  env?: NodeJS.ProcessEnv
  plat?: NodeJS.Platform
  runId?: string
  onError?: ErrorSink
}

/**
 * A lease identity must be new at every launch. The group id is not: launched
 * with `--scope` or restored from a workspace, two runs carry the same one, and
 * two runs sharing a lease key would each take the other for itself.
 */
export function mintRunId(): string {
  return randomUUID()
}

/**
 * Instant this process started, so a recycled pid cannot answer for the run
 * that owned the lease. An unusable uptime falls back to now, which is still
 * constant for the run.
 */
export function processStartedAt(uptimeSeconds: number, now: number): number {
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return now
  const started = Math.round(now - uptimeSeconds * 1000)
  return Number.isSafeInteger(started) && started > 0 ? started : now
}

export function proxyLogPath(logsDir: string): string {
  return join(logsDir, PROXY_LOG_FILE)
}

export type BuiltinLookup = (id: string) => unknown

const builtinModule: BuiltinLookup = (id) => {
  const lookup = (process as { getBuiltinModule?: BuiltinLookup }).getBuiltinModule
  return typeof lookup === 'function' ? lookup.call(process, id) : undefined
}

/**
 * `node:sqlite` is resolved at call time, so the module stays importable by a
 * runtime that does not carry it; the controller opens the store lazily, so an
 * unavailable database is a failed start rather than a controller broken for
 * the rest of the run.
 */
export function openSqliteDatabase(path: string, lookup: BuiltinLookup = builtinModule): SqliteConnection {
  const builtin = lookup('node:sqlite') as { DatabaseSync?: new (p: string) => SqliteConnection } | undefined
  if (!builtin?.DatabaseSync) {
    throw new Error('this runtime has no node:sqlite to open the clodex record store')
  }
  mkdirSync(dirname(path), { recursive: true })
  return new builtin.DatabaseSync(path)
}

/** Refusal, timeout and unreachable host all answer false: readiness is proven, never assumed. */
export function probeTcp(port: number, onError: ErrorSink, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  if (!Number.isSafeInteger(port) || port <= 0 || port > MAX_PORT) {
    onError(SCOPE, `refusing to probe an unusable clodex port: ${String(port)}`)
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * A spawn error arrives on the child, not on the call: without this listener it
 * would surface as an unhandled event, and the lifecycle would wait for a
 * registration that can never come.
 */
export function toClodexChild(child: ChildProcess, onError: ErrorSink): ClodexChild {
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', (error) => {
      onError(SCOPE, 'the clodex proxy process failed to start', error)
      resolve()
    })
  })
  return {
    get pid() {
      return child.pid
    },
    exited,
    unref: () => child.unref()
  }
}

/** Runs a fixed command with fixed args; a non-zero exit is a result, never a rejection. */
export function runCommand(
  file: string,
  args: string[],
  timeoutMs = RUN_TIMEOUT_MS
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: RUN_MAX_OUTPUT },
      (err, stdout, stderr) => {
        const raw = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0
        resolve({
          code: typeof raw === 'number' ? raw : err ? -1 : 0,
          stdout: String(stdout ?? ''),
          stderr: err && !stderr ? String((err as Error).message) : String(stderr ?? '')
        })
      }
    )
  })
}

/**
 * Releases the lease of a closing window under a cap, and never rejects: the
 * caller quits on every outcome, since a release that cannot finish must not
 * leave a process behind with no window to close. An expiry does NOT cancel
 * the release in flight, it only stops waiting for it, so the lease may
 * outlive the window until another one reclaims it as stale.
 */
export async function releaseBeforeQuit(
  controller: ClodexController | null,
  capMs: number,
  sleep: (ms: number) => Promise<void>,
  onError: ErrorSink
): Promise<ReleaseDeadline> {
  if (!controller) return 'idle'
  let failure: unknown
  const outcome = await Promise.race([
    controller.stop().then(
      () => 'done' as const,
      (error: unknown) => {
        failure = error
        return 'failed' as const
      }
    ),
    // Both legs answer, including a timer the caller could not arm: a race
    // whose other half rejects would break the contract this function offers.
    sleep(capMs).then(
      () => 'expired' as const,
      () => 'expired' as const
    )
  ])
  if (outcome === 'expired') {
    onError(SCOPE, `the clodex lease was left in place: its release outlasted ${capMs} ms`)
  } else if (outcome === 'failed') {
    onError(SCOPE, 'the clodex lease could not be released', failure)
  }
  return outcome
}

/**
 * Production IO of the controller. The PATH probe is the bridge's own, so the
 * Deck resolves `clodex-claude` through the login shell exactly as the picker
 * does rather than through a second, divergent probe.
 */
export function createClodexControllerDeps(options: ClodexDepsOptions): ClodexControllerDeps {
  const base = options.env ?? process.env
  // On POSIX the spawn takes its login shell from this environment, the probe
  // takes it from the setting: without the override the two halves can resolve
  // PATH through different shells, and a probe that finds the wrapper is
  // followed by a launch that does not find the binary. The win32 spawn runs
  // through cmd.exe and ignores SHELL.
  const env = options.shell ? { ...base, SHELL: options.shell } : base
  const onError = options.onError ?? reportError
  const runId = options.runId ?? mintRunId()
  const startedAt = processStartedAt(process.uptime(), Date.now())
  const probeBin = defaultClodexDeps(options.shell).probeBin

  return {
    platform: options.plat ?? platform(),
    hostname: () => hostname(),
    env,
    now: () => Date.now(),
    pid: process.pid,
    startedAt,
    runId,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    run: (file: string, args: string[]) => runCommand(file, args),
    readFile: (path: string) => {
      try {
        return readFileSync(path, 'utf-8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    kill: (pid: number, signal: number | NodeJS.Signals) => {
      process.kill(pid, signal)
    },
    spawn: (file: string, args: string[], spawnOptions: ClodexSpawnOptions) =>
      toClodexChild(
        spawnProcess(file, args, {
          detached: spawnOptions.detached,
          windowsHide: spawnOptions.windowsHide,
          stdio: spawnOptions.stdio,
          cwd: spawnOptions.cwd,
          env: spawnOptions.env ?? env
        }),
        onError
      ),
    // The descriptor stays open for the run: the spawn attempts of one launch
    // are bounded, and closing it here would race the child that inherited it.
    openLog: () => {
      try {
        return openSync(proxyLogPath(options.logsDir), 'a')
      } catch (err) {
        onError(SCOPE, 'cannot open the clodex proxy log; its output is discarded', err)
        return null
      }
    },
    connect: (port: number) => probeTcp(port, onError),
    probeBin,
    openDatabase: openSqliteDatabase,
    onError
  }
}
