import { EventEmitter } from 'node:events'
import { expect, test } from 'bun:test'
import type { ServeAction } from '../desktop/src/main/serve-config.ts'
import { SYSTEM_COMMAND_TIMEOUT_MS } from '../desktop/src/main/serve-lifecycle.ts'
import { measureWindowsProcessStamp } from '../desktop/src/main/process-stamp.ts'
import {
  ServeService,
  runSystemCommand,
  type ServeChild,
  type ServeFetchResponse,
  type ServeServiceDeps,
  type ServeSpawnOptions
} from '../desktop/src/main/serve-service.ts'

const PID = 4512
const PORT = 4317
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe'

class FakeChild extends EventEmitter implements ServeChild {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()

  constructor(readonly pid: number = PID) {
    super()
  }

  killCalls = 0

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }

  kill(): void {
    this.killCalls++
  }
}

class FakeClock {
  now = 0
  private nextId = 1
  private readonly timers = new Map<number, { due: number; ms: number; fire: () => void }>()

  setTimer = (ms: number, fire: () => void): unknown => {
    const id = this.nextId++
    this.timers.set(id, { due: this.now + ms, ms, fire })
    return id
  }

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  pending(): number[] {
    return [...this.timers.values()].map((timer) => timer.ms)
  }

  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.due <= target).sort(([a, x], [b, y]) => x.due - y.due || a - b)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.now = due[1].due
      due[1].fire()
    }
    this.now = target
  }
}

function action(overrides: Partial<ServeAction> = {}): ServeAction {
  return {
    name: 'web',
    cwd: 'C:/project/web',
    command: 'bun run dev -- --host ${HOST} --port ${PORT}',
    port: 'auto',
    url: 'http://${HOST}:${PORT}/',
    health: 'http://${HOST}:${PORT}/health',
    readyTimeoutSec: 1,
    env: { API_URL: 'http://${HOST}:${PORT}/api', NODE_ENV: 'development' },
    inheritEnv: ['PATH'],
    ...overrides
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

async function completeWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(1_000).then(() => {
      throw new Error(`${label} did not settle`)
    })
  ])
}

function errno(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code })
}

interface HarnessInit {
  platform?: NodeJS.Platform
  systemRoot?: string
  ports?: number[]
  allocatePort?: () => Promise<number>
  sessionDir?: () => string
  fetch?: ServeServiceDeps['fetch']
  statuses?: Array<number | Error>
  onSignal?: (pid: number, signal: NodeJS.Signals, child: FakeChild) => void
  onProbe?: (pid: number, child: FakeChild) => void
  run?: ServeServiceDeps['run']
  createLog?: (child: FakeChild) => void
  failTimer?: (ms: number) => boolean
  onReport?: (message: string) => void
}

function harness(init: HarnessInit = {}) {
  const clock = new FakeClock()
  const children: FakeChild[] = []
  const spawns: Array<{ file: string; args: string[]; options: ServeSpawnOptions }> = []
  const runs: Array<{ file: string; args: string[] }> = []
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
  const probes: number[] = []
  const errors: string[] = []
  const log = { info: [] as string[], error: [] as string[] }
  const logDirs: string[] = []
  let logWriteFailure: ((file: string, error: unknown) => void) | null = null
  const ports = [...(init.ports ?? [PORT])]
  const statuses = [...(init.statuses ?? [200])]
  const current = (): FakeChild => children.at(-1) ?? new FakeChild()
  const deps: ServeServiceDeps = {
    platform: init.platform ?? 'linux',
    systemRoot: init.systemRoot ?? 'C:\\Windows',
    sessionDir: init.sessionDir ?? (() => 'C:/state/sessions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    allocatePort: init.allocatePort ?? (async () => ports.shift() ?? PORT),
    fetch: init.fetch ?? (async () => {
      const response = statuses.shift() ?? 500
      if (response instanceof Error) throw response
      return { status: response }
    }),
    setTimer: (ms, fire) => {
      if (init.failTimer?.(ms)) throw new Error(`no timer for ${ms}ms`)
      return clock.setTimer(ms, fire)
    },
    clearTimer: clock.clearTimer,
    spawn: (file, args, options) => {
      spawns.push({ file, args, options })
      const child = new FakeChild()
      children.push(child)
      return child
    },
    run: async (file, args) => {
      runs.push({ file, args })
      return init.run ? init.run(file, args) : { code: 0, stdout: '', stderr: '' }
    },
    signal: (pid, signal) => {
      if (signal === 0) {
        probes.push(pid)
        init.onProbe?.(pid, current())
        return
      }
      signals.push({ pid, signal })
      init.onSignal?.(pid, signal, current())
    },
    createLog: (dir, options) => {
      init.createLog?.(current())
      logDirs.push(dir)
      logWriteFailure = options.onWriteFailure
      return {
        info: (text) => log.info.push(text),
        error: (text) => log.error.push(text)
      }
    },
    reportError: (_scope, message) => {
      errors.push(message)
      init.onReport?.(message)
    }
  }
  const service = new ServeService(deps)
  return {
    service,
    get child(): FakeChild {
      return current()
    },
    children,
    clock,
    spawns,
    runs,
    signals,
    probes,
    errors,
    log,
    logDirs,
    triggerLogWriteFailure: (file: string, error: unknown) => {
      if (!logWriteFailure) throw new Error('log writer was not created')
      logWriteFailure(file, error)
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const ESCALATION: Array<{ pid: number; signal: NodeJS.Signals }> = [
  { pid: -PID, signal: 'SIGINT' },
  { pid: -PID, signal: 'SIGTERM' },
  { pid: -PID, signal: 'SIGKILL' }
]

async function readyHarness(init: HarnessInit = {}): Promise<ReturnType<typeof harness>> {
  const h = harness({ statuses: [200], ...init })
  await h.service.start(action())
  await settle()
  expect(h.service.state().status).toBe('ready')
  return h
}

test('measures a Windows process through the supplied PowerShell path', async () => {
  const calls: string[] = []

  await measureWindowsProcessStamp({
    powershellPath: POWERSHELL,
    run: async (file) => {
      calls.push(file)
      return { code: 0, stdout: '2026-10-09T14:00:00.0000000Z', stderr: '' }
    },
    readFile: () => null
  }, PID)

  expect(calls).toEqual([POWERSHELL])
})

test('bounds a system command and keeps the failure message when stderr is empty', async () => {
  const timeouts: number[] = []
  const missing = await runSystemCommand(TASKKILL, ['/T'], (_file, _args, options, callback) => {
    timeouts.push(options.timeout)
    callback(Object.assign(new Error(`spawn ${TASKKILL} ENOENT`), { code: 'ENOENT' }), '', '')
  })
  const denied = await runSystemCommand(TASKKILL, ['/T'], (_file, _args, options, callback) => {
    timeouts.push(options.timeout)
    callback(Object.assign(new Error('Command failed'), { code: 5 }), '', 'Access denied.')
  })

  expect(timeouts).toEqual([SYSTEM_COMMAND_TIMEOUT_MS, SYSTEM_COMMAND_TIMEOUT_MS])
  expect(missing).toEqual({ code: 1, stdout: '', stderr: `spawn ${TASKKILL} ENOENT` })
  expect(denied).toEqual({ code: 5, stdout: '', stderr: 'Access denied.' })
})

test('launches the Windows shell through the System32 PowerShell path without detaching it', async () => {
  const h = harness({ platform: 'win32' })

  await h.service.start(action())

  expect(h.spawns[0]?.file).toBe(POWERSHELL)
  expect(h.spawns[0]?.options.detached).toBe(false)
})

test('refuses to start on Windows when SystemRoot is not a canonical absolute path', async () => {
  const h = harness({ platform: 'win32', systemRoot: 'C:\\Windows\\..\\clone' })

  await h.service.start(action())

  expect(h.spawns).toEqual([])
  expect(h.service.state()).toEqual({ status: 'failed', error: 'cannot resolve Windows system executable: dot-dot' })
})

test('starts a detached shell command with substituted action values', async () => {
  const h = harness()

  await h.service.start(action())
  await settle()

  expect(h.spawns).toHaveLength(1)
  expect(h.spawns[0]).toMatchObject({
    options: {
      cwd: 'C:/project/web',
      detached: true,
      env: {
        HOST: '127.0.0.1',
        PORT: '4317',
        API_URL: 'http://127.0.0.1:4317/api',
        NODE_ENV: 'development'
      }
    }
  })
  expect(h.spawns[0]?.args).toContain('bun run dev -- --host 127.0.0.1 --port 4317')
  expect(h.service.state()).toEqual({
    status: 'ready',
    url: 'http://127.0.0.1:4317/',
    port: PORT,
    pid: PID
  })
})

test('accepts readiness status 399', async () => {
  const h = harness({ statuses: [399] })

  await h.service.start(action())
  await settle()

  expect(h.service.state().status).toBe('ready')
})

test('aborts a health request when its readiness deadline expires', async () => {
  let aborted = false
  const h = harness({
    platform: 'win32',
    fetch: (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new Error('health request deadline elapsed'))
      }, { once: true })
    })
  })

  await h.service.start(action())
  h.clock.advance(1000)
  await settle()

  expect(aborted).toBe(true)
  expect(h.runs).toEqual([{ file: TASKKILL, args: ['/T', '/F', '/PID', String(PID)] }])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'health check http://127.0.0.1:4317/health timed out after no response' })
})

test('cancels the health response body after reading its status', async () => {
  let cancelled = 0
  const h = harness({
    fetch: async () => ({
      status: 200,
      body: { cancel: () => { cancelled++ } }
    })
  })

  await h.service.start(action())
  await settle()

  expect(cancelled).toBe(1)
})

test('does not restore ready after a health response resolves during stop', async () => {
  const response = deferred<ServeFetchResponse>()
  const h = harness({ fetch: async () => response.promise })
  await h.service.start(action())
  await settle()

  const stopping = h.service.stop()
  response.resolve({ status: 200 })
  await settle()

  expect(h.service.state().status).toBe('stopping')
  h.clock.advance(3000)
  h.clock.advance(3000)
  await completeWithin(stopping, 'stop after a late health response')
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('reports a rejected health response body cancellation', async () => {
  const h = harness({
    fetch: async () => ({
      status: 200,
      body: { cancel: () => Promise.reject(new Error('body cleanup failed')) }
    })
  })

  await h.service.start(action())
  await settle()

  expect(h.errors).toEqual(['could not cancel serve health response body'])
})

test('reports a throwing state listener and still settles the quit', async () => {
  const h = await readyHarness({
    onSignal: (_pid, signal) => {
      if (signal === 'SIGINT') throw errno('ESRCH')
    }
  })
  h.service.on('changed', () => {
    throw new Error('listener bug')
  })

  await completeWithin(h.service.quit(), 'quit with a throwing listener')

  expect(h.errors).toContain('Serve state listener failed')
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('fails readiness after its timeout and stops the owned process', async () => {
  const h = harness({ statuses: [500, 500, 500] })

  await h.service.start(action())
  await settle()
  h.clock.advance(500)
  await settle()
  h.clock.advance(500)
  await settle()
  h.clock.advance(3000)
  h.clock.advance(3000)
  await settle()

  expect(h.service.state()).toMatchObject({
    status: 'failed',
    pid: PID,
    error: 'health check http://127.0.0.1:4317/health timed out after HTTP 500'
  })
  expect(h.signals).toEqual(ESCALATION)
  expect(h.errors).toEqual(['health check http://127.0.0.1:4317/health timed out after HTTP 500'])
})

test('stops the POSIX process group when the session log cannot open after spawn', async () => {
  const h = harness({
    sessionDir: () => {
      throw new Error('session state unavailable')
    },
    onSignal: (_pid, signal) => {
      if (signal === 'SIGINT') throw errno('ESRCH')
    }
  })

  await h.service.start(action())

  expect(h.signals).toEqual([{ pid: -PID, signal: 'SIGINT' }])
  expect(h.child.killCalls).toBe(0)
  expect(h.clock.pending()).toEqual([])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'could not open the serve log: session state unavailable' })
  await h.service.start(action())
  expect(h.spawns).toHaveLength(2)
})

test('uses taskkill to stop a spawned Windows process whose session log cannot open', async () => {
  const h = harness({
    platform: 'win32',
    sessionDir: () => {
      throw new Error('session state unavailable')
    }
  })

  await h.service.start(action())
  await settle()

  expect(h.runs).toEqual([{ file: TASKKILL, args: ['/T', '/F', '/PID', String(PID)] }])
  expect(h.child.killCalls).toBe(0)
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'could not open the serve log: session state unavailable' })
})

test('subscribes to child exit and error before the spawn is reported', async () => {
  const listeners: number[] = []
  const h = harness({
    createLog: (child) => listeners.push(child.listenerCount('exit'), child.listenerCount('error'))
  })

  await h.service.start(action())

  expect(listeners).toEqual([1, 1])
})

test('reaps the POSIX group of a child that exits while readiness is pending', async () => {
  const h = harness({
    statuses: [500],
    onSignal: (_pid, signal) => {
      if (signal === 'SIGINT') throw errno('ESRCH')
    }
  })

  await h.service.start(action())
  await settle()
  h.child.exit(17)
  await settle()

  expect(h.signals).toEqual([{ pid: -PID, signal: 'SIGINT' }])
  expect(h.service.state()).toMatchObject({
    status: 'failed',
    error: 'serve process exited with code 17 before readiness'
  })
})

test('reports a signal when the ready process exits unexpectedly', async () => {
  const h = await readyHarness({
    onSignal: (_pid, signal) => {
      if (signal === 'SIGINT') throw errno('ESRCH')
    }
  })

  h.child.exit(null, 'SIGTERM')
  await settle()

  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'serve process exited with signal SIGTERM' })
  expect(h.errors).toEqual(['serve process exited with signal SIGTERM'])
})

test('reports an error when the session serve log cannot be written', async () => {
  const h = harness()
  const failure = new Error('disk is read-only')
  await h.service.start(action())

  h.triggerLogWriteFailure('C:/state/sessions/run/serve.log', failure)

  expect(h.errors).toEqual(['could not write serve log C:/state/sessions/run/serve.log'])
})

test('stops the process group after an unexpected child error', async () => {
  const h = await readyHarness({
    onSignal: (_pid, signal) => {
      if (signal === 'SIGINT') throw errno('ESRCH')
    }
  })

  h.child.emit('error', new Error('serve socket closed'))
  await settle()

  expect(h.signals).toEqual([{ pid: -PID, signal: 'SIGINT' }])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'serve process error: serve socket closed' })
  expect(h.errors).toEqual(['serve process error: serve socket closed'])
})

test('creates a fresh session logger after an unexpected child exit', async () => {
  const h = harness({ platform: 'win32', statuses: [200, 200] })
  await h.service.start(action())
  await settle()
  h.child.exit(1)
  await settle()

  await h.service.start(action())
  await settle()

  expect(h.logDirs).toHaveLength(2)
})

test('does not spawn twice while a server is starting', async () => {
  const h = harness({ statuses: [500] })

  await h.service.start(action())
  await h.service.start(action({ command: 'must not spawn' }))

  expect(h.spawns).toHaveLength(1)
})

test('stopping idle is a no-op', async () => {
  const h = harness()

  await h.service.stop()

  expect(h.signals).toEqual([])
  expect(h.runs).toEqual([])
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('stopping while the port is allocated never spawns the server', async () => {
  const port = deferred<number>()
  const h = harness({ platform: 'win32', allocatePort: () => port.promise })

  const started = h.service.start(action())
  const stopped = h.service.stop()
  port.resolve(PORT)
  await completeWithin(started, 'start')
  await completeWithin(stopped, 'stop')
  await settle()

  expect(h.spawns).toEqual([])
  expect(h.runs).toEqual([])
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('stops a POSIX group in escalation order', async () => {
  const h = await readyHarness()

  const stopping = h.service.stop()
  h.clock.advance(3000)
  h.clock.advance(3000)
  await completeWithin(stopping, 'escalation')

  expect(h.signals).toEqual(ESCALATION)
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('creates a fresh logger after a clean stop and restart', async () => {
  const h = await readyHarness({ statuses: [200, 200] })

  const stopping = h.service.stop()
  h.clock.advance(3000)
  h.clock.advance(3000)
  await stopping
  await h.service.start(action())
  await settle()

  expect(h.logDirs).toHaveLength(2)
})

test('releases the session logger after a clean stop', async () => {
  const h = await readyHarness()

  const stopping = h.service.stop()
  h.clock.advance(3000)
  h.clock.advance(3000)
  await stopping
  h.child.stdout.emit('data', Buffer.from('late output'))

  expect(h.log.info).toEqual([])
})

test('does not write the output of a previous child into the log of the next run', async () => {
  const h = await readyHarness({
    statuses: [200, 200],
    onSignal: (_pid, signal) => {
      if (signal === 'SIGINT') throw errno('ESRCH')
    }
  })
  await h.service.stop()
  await h.service.start(action())
  await settle()

  h.children[0]!.stdout.emit('data', Buffer.from('previous run'))
  h.children[1]!.stdout.emit('data', Buffer.from('current run'))

  expect(h.log.info).toEqual(['current run'])
})

test('shares one escalation between concurrent stop calls', async () => {
  const h = await readyHarness()

  const first = h.service.stop()
  const second = h.service.stop()
  h.clock.advance(3000)
  h.clock.advance(3000)
  await completeWithin(Promise.all([first, second]), 'concurrent stop')

  expect(h.signals).toEqual(ESCALATION)
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('finishes shutdown when SIGINT reports an absent process group', async () => {
  const h = await readyHarness({
    onSignal: (_pid, signal, child) => {
      if (signal !== 'SIGINT') return
      child.exit(null, 'SIGINT')
      throw errno('ESRCH')
    }
  })

  await completeWithin(h.service.stop(), 'ESRCH shutdown')

  expect(h.signals).toEqual([{ pid: -PID, signal: 'SIGINT' }])
  expect(h.service.state()).toEqual({ status: 'idle' })
  expect(h.errors).toEqual([])
})

test('keeps escalating the group after its leader exits on SIGINT', async () => {
  const h = await readyHarness({
    onSignal: (_pid, signal, child) => {
      if (signal === 'SIGINT') child.exit(null, 'SIGINT')
    }
  })

  const stopping = h.service.stop()
  h.clock.advance(3000)
  h.clock.advance(3000)
  await completeWithin(stopping, 'escalation after leader exit')

  expect(h.signals).toEqual(ESCALATION)
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('ends the stop on an empty group probe instead of waiting out the grace', async () => {
  const h = await readyHarness({
    onProbe: () => {
      throw errno('ESRCH')
    }
  })

  const stopping = h.service.stop()
  h.child.exit(null, 'SIGINT')
  await completeWithin(stopping, 'stop after the leader exit')

  expect(h.signals).toEqual([{ pid: -PID, signal: 'SIGINT' }])
  expect(h.probes).toEqual([-PID])
  expect(h.clock.pending()).toEqual([])
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('uses the System32 taskkill path for a Windows tree', async () => {
  const h = await readyHarness({ platform: 'win32' })

  await completeWithin(h.service.stop(), 'taskkill stop')

  expect(h.runs).toEqual([{ file: TASKKILL, args: ['/T', '/F', '/PID', String(PID)] }])
  expect(h.signals).toEqual([])
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('kills the Windows leader by its handle when taskkill cannot run', async () => {
  const h = await readyHarness({
    platform: 'win32',
    run: async () => {
      throw new Error('taskkill unavailable')
    }
  })

  const stopping = h.service.stop()
  await settle()
  h.clock.advance(3000)
  await completeWithin(stopping, 'stop after a taskkill failure')

  expect(h.child.killCalls).toBe(1)
  expect(h.service.state()).toMatchObject({ status: 'failed', error: `taskkill failed for serve pid ${PID}: taskkill unavailable` })
})

test('quit kills the group at its deadline and settles', async () => {
  const h = await readyHarness()

  const quitting = h.service.quit({ deadlineMs: 5000 })
  h.clock.advance(3000)
  h.clock.advance(2000)
  await completeWithin(quitting, 'quit deadline')

  expect(h.signals).toEqual(ESCALATION)
  expect(h.errors).toEqual(['serve process did not stop before the quit deadline'])
  expect(h.clock.pending()).toEqual([])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'serve process did not stop before the quit deadline' })
})

test('reports an effect that throws outside its failure path and still settles the quit at its deadline', async () => {
  const h = await readyHarness({ failTimer: (ms) => ms === 3000 })

  const quitting = h.service.quit({ deadlineMs: 5000 })
  h.clock.advance(5000)
  await completeWithin(quitting, 'quit after a grace timer failure')

  expect(h.errors).toContain('Serve effect armTimer failed outside its failure path')
  expect(h.signals).toEqual([{ pid: -PID, signal: 'SIGINT' }, { pid: -PID, signal: 'SIGKILL' }])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'serve process did not stop before the quit deadline' })
})

test('keeps dispatching after an error escapes a queued event', async () => {
  let explosions = 2
  const h = await readyHarness({
    onSignal: (_pid, signal) => {
      if (signal === 'SIGINT') throw errno('EIO')
    },
    onReport: () => {
      if (explosions > 0) {
        explosions--
        throw new Error('error sink down')
      }
    }
  })

  await expect(h.service.stop()).rejects.toThrow('error sink down')
  const quitting = h.service.quit({ deadlineMs: 5000 })
  h.clock.advance(5000)
  await completeWithin(quitting, 'quit after an escaped error')

  expect(h.signals.at(-1)).toEqual({ pid: -PID, signal: 'SIGKILL' })
  expect(h.service.state().status).toBe('failed')
})

test('refuses to start after quit', async () => {
  const h = harness()

  await h.service.quit()
  const state = await h.service.start(action())

  expect(h.spawns).toEqual([])
  expect(state).toEqual({ status: 'idle' })
})

test('writes child standard streams to the session serve log', async () => {
  const h = harness({ statuses: [500] })
  await h.service.start(action())
  await settle()

  h.child.stdout.emit('data', Buffer.from('server output\n'))
  h.child.stderr.emit('data', Buffer.from('server failure\n'))

  expect(h.log.info).toEqual(['server output\n'])
  expect(h.log.error).toEqual(['server failure\n'])
})
