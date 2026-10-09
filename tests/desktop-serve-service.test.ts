import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { ServeAction } from '../desktop/src/main/serve-config.ts'
import { measureWindowsProcessStamp } from '../desktop/src/main/process-stamp.ts'
import {
  ServeService,
  type ProcessStamp,
  type ServeChild,
  type ServeFetchResponse,
  type ServeServiceDeps,
  type ServeSpawnOptions
} from '../desktop/src/main/serve-service.ts'

const PID = 4512
const PORT = 4317

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
  readonly delays: number[] = []
  private waiters: Array<() => void> = []

  sleep = async (ms: number): Promise<void> => {
    this.delays.push(ms)
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  advance(ms: number): void {
    this.now += ms
    const resolve = this.waiters.shift()
    if (!resolve) throw new Error(`no pending sleep for ${ms}ms`)
    expect(this.delays.at(-1)).toBe(ms)
    resolve()
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

interface HarnessInit {
  platform?: NodeJS.Platform
  systemRoot?: string
  ports?: number[]
  allocatePort?: () => Promise<number>
  sessionDir?: () => string
  fetch?: ServeServiceDeps['fetch']
  statuses?: Array<number | Error>
  stamps?: ProcessStamp[]
  measureProcess?: (child: FakeChild) => Promise<ProcessStamp>
  useDefaultMeasure?: boolean
  onSignal?: (pid: number, signal: NodeJS.Signals, child: FakeChild) => void
  sleep?: ServeServiceDeps['sleep']
  run?: ServeServiceDeps['run']
}

function harness(init: HarnessInit = {}) {
  const clock = new FakeClock()
  const child = new FakeChild()
  const spawns: Array<{ file: string; args: string[]; options: ServeSpawnOptions }> = []
  const runs: Array<{ file: string; args: string[] }> = []
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
  const errors: string[] = []
  const log = { info: [] as string[], error: [] as string[] }
  const logDirs: string[] = []
  let logWriteFailure: ((file: string, error: unknown) => void) | null = null
  const ports = [...(init.ports ?? [PORT])]
  const statuses = [...(init.statuses ?? [200])]
  const stamps = [...(init.stamps ?? [stamp(init.platform ?? 'linux'), stamp(init.platform ?? 'linux'), stamp(init.platform ?? 'linux'), stamp(init.platform ?? 'linux')])]
  const deps: ServeServiceDeps = {
    platform: init.platform ?? 'linux',
    systemRoot: init.systemRoot,
    sessionDir: init.sessionDir ?? (() => 'C:/state/sessions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    allocatePort: init.allocatePort ?? (async () => ports.shift() ?? PORT),
    fetch: init.fetch ?? (async () => {
      const response = statuses.shift() ?? 500
      if (response instanceof Error) throw response
      return { status: response }
    }),
    now: () => clock.now,
    sleep: init.sleep ?? clock.sleep,
    spawn: (file, args, options) => {
      spawns.push({ file, args, options })
      return child
    },
    run: async (file, args) => {
      runs.push({ file, args })
      return init.run ? init.run(file, args) : { code: 0, stdout: '', stderr: '' }
    },
    signal: (pid, signal) => {
      signals.push({ pid, signal })
      init.onSignal?.(pid, signal, child)
    },
    measureProcess: init.useDefaultMeasure
      ? undefined
      : init.measureProcess
        ? () => init.measureProcess!(child)
        : async () => {
            const next = stamps.shift()
            if (!next) throw new Error('unexpected process stamp measurement')
            return next
          },
    createLog: (dir, options) => {
      logDirs.push(dir)
      logWriteFailure = options.onWriteFailure
      return {
        info: (text) => log.info.push(text),
        error: (text) => log.error.push(text)
      }
    },
    reportError: (_scope, message) => errors.push(message)
  }
  const service = new ServeService(deps)
  return {
    service,
    child,
    clock,
    spawns,
    runs,
    signals,
    errors,
    log,
    logDirs,
    triggerLogWriteFailure: (file: string, error: unknown) => {
      if (!logWriteFailure) throw new Error('log writer was not created')
      logWriteFailure(file, error)
    }
  }
}

function stamp(platform: NodeJS.Platform, identity = '889900'): ProcessStamp {
  return platform === 'win32'
    ? { platform: 'win32', pid: PID, creationUtc: identity }
    : { platform, pid: PID, startToken: identity, pgid: PID }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

test('measures a Windows process through the supplied PowerShell path', async () => {
  const calls: string[] = []

  await measureWindowsProcessStamp({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    run: async (file) => {
      calls.push(file)
      return { code: 0, stdout: '2026-10-09T14:00:00.0000000Z', stderr: '' }
    },
    readFile: () => null
  }, PID)

  expect(calls).toEqual(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
})

test('bounds the default system command execution', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'serve-service.ts'), 'utf8')

  expect(source).toContain("timeout: SYSTEM_COMMAND_TIMEOUT_MS")
  expect(source.replace('timeout: SYSTEM_COMMAND_TIMEOUT_MS', 'timeout: 0')).not.toContain("timeout: SYSTEM_COMMAND_TIMEOUT_MS")
})

test('measures the default Windows process through System32 PowerShell', async () => {
  const h = harness({
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    useDefaultMeasure: true,
    run: async () => ({
      code: 0,
      stdout: '2026-10-09T14:00:00.0000000Z',
      stderr: ''
    })
  })

  await h.service.start(action())
  await settle()

  expect(h.runs[0]?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(h.service.state().status).toBe('ready')
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

test('does not detach the Windows shell process', async () => {
  const h = harness({
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    measureProcess: async () => stamp('win32')
  })

  await h.service.start(action())
  await settle()

  expect(h.spawns[0]?.options.detached).toBe(false)
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
  const failed = new Promise<void>((resolve) => {
    h.service.on('changed', (state) => {
      if (state.status === 'failed') resolve()
    })
  })

  await h.service.start(action({ readyTimeoutSec: 0 }))
  await completeWithin(failed, 'aborted health request')

  expect(aborted).toBe(true)
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'health check http://127.0.0.1:4317/health timed out after health request deadline elapsed' })
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
  await settle()
  response.resolve({ status: 200 })
  await settle()

  expect(h.service.state().status).toBe('stopping')
  h.clock.advance(3000)
  await settle()
  h.clock.advance(3000)
  await stopping
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

test('reports an unhandled readiness task failure', async () => {
  const h = harness({
    statuses: [500],
    sleep: async () => {
      throw new Error('test sleep failure')
    }
  })

  await h.service.start(action())
  await settle()

  expect(h.errors).toEqual(['serve readiness task failed'])
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
  await settle()
  h.clock.advance(3000)
  await settle()

  expect(h.service.state()).toMatchObject({
    status: 'failed',
    error: 'health check http://127.0.0.1:4317/health timed out after HTTP 500'
  })
  expect(h.signals).toEqual([
    { pid: -PID, signal: 'SIGINT' },
    { pid: -PID, signal: 'SIGTERM' },
    { pid: -PID, signal: 'SIGKILL' }
  ])
  expect(h.errors).toEqual(['health check http://127.0.0.1:4317/health timed out after HTTP 500'])
})

test('kills the verified POSIX process group when session log setup fails after spawn', async () => {
  const h = harness({
    sessionDir: () => {
      throw new Error('session state unavailable')
    }
  })

  await h.service.start(action())

  expect(h.signals).toEqual([{ pid: -PID, signal: 'SIGKILL' }])
  expect(h.child.killCalls).toBe(0)
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'session state unavailable' })
  await h.service.start(action())
  expect(h.spawns).toHaveLength(2)
})

test('uses taskkill to clean up a spawned Windows process after setup fails', async () => {
  const h = harness({
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    measureProcess: async () => stamp('win32'),
    sessionDir: () => {
      throw new Error('session state unavailable')
    }
  })

  await h.service.start(action())

  expect(h.runs).toEqual([{ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/T', '/F', '/PID', String(PID)] }])
  expect(h.child.killCalls).toBe(0)
})

test('subscribes to child exit and error before measuring its process stamp', async () => {
  const h = harness({
    measureProcess: async (child) => {
      expect(child.listenerCount('exit')).toBe(1)
      expect(child.listenerCount('error')).toBe(1)
      return stamp('linux')
    }
  })

  await h.service.start(action())

  expect(h.service.state().status).toBe('ready')
})

test('kills a spawned child when its first stamp has a different PID', async () => {
  const h = harness({
    measureProcess: async () => ({ platform: 'linux', pid: PID + 1, startToken: '889900', pgid: PID })
  })

  await h.service.start(action())

  expect(h.child.killCalls).toBe(1)
  expect(h.service.state()).toMatchObject({ status: 'failed', error: `cannot establish identity for serve pid ${PID}` })
})

test('kills a spawned child when its first stamp has another platform', async () => {
  const h = harness({
    platform: 'win32',
    measureProcess: async () => stamp('linux')
  })

  await h.service.start(action())

  expect(h.child.killCalls).toBe(1)
  expect(h.service.state()).toMatchObject({ status: 'failed', error: `cannot establish identity for serve pid ${PID}` })
})

test('refuses a POSIX child that does not lead its detached process group', async () => {
  const h = harness({
    measureProcess: async () => ({ platform: 'linux', pid: PID, startToken: '889900', pgid: PID + 1 })
  })

  await h.service.start(action())

  expect(h.child.killCalls).toBe(1)
  expect(h.signals).toEqual([])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: `serve pid ${PID} does not lead its process group` })
})

test('reports an early child exit while readiness is pending', async () => {
  const h = harness({ statuses: [500] })

  await h.service.start(action())
  await settle()
  h.child.exit(17)
  await settle()

  expect(h.service.state()).toMatchObject({
    status: 'failed',
    error: 'serve process exited with code 17 before readiness'
  })
})

test('reports a signal when the ready process exits unexpectedly', async () => {
  const h = harness({ statuses: [200] })
  await h.service.start(action())
  await settle()

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

test('reports an unexpected child error after readiness', async () => {
  const h = harness({ statuses: [200] })
  const error = new Error('serve socket closed')
  await h.service.start(action())
  await settle()

  h.child.emit('error', error)
  await settle()

  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'serve socket closed' })
  expect(h.errors).toEqual(['serve process error'])
})

test('creates a fresh session logger after an unexpected child exit', async () => {
  const h = harness({ platform: 'win32', systemRoot: 'C:\\Windows', statuses: [200, 200] })
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

test('stopping during startup waits and terminates the spawned process', async () => {
  const port = deferred<number>()
  const h = harness({ platform: 'win32', systemRoot: 'C:\\Windows', allocatePort: () => port.promise })

  const started = h.service.start(action())
  const stopped = h.service.stop()
  port.resolve(PORT)
  await started
  await stopped

  expect(h.runs).toEqual([{ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/T', '/F', '/PID', String(PID)] }])
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('stops a verified POSIX group in escalation order', async () => {
  const h = harness({ statuses: [200] })
  await h.service.start(action())
  await settle()

  const stopping = h.service.stop()
  await settle()
  h.clock.advance(3000)
  await settle()
  h.clock.advance(3000)
  await stopping

  expect(h.signals).toEqual([
    { pid: -PID, signal: 'SIGINT' },
    { pid: -PID, signal: 'SIGTERM' },
    { pid: -PID, signal: 'SIGKILL' }
  ])
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('creates a fresh logger after a clean stop and restart', async () => {
  const h = harness({
    statuses: [200, 200],
    stamps: [stamp('linux'), stamp('linux'), stamp('linux'), stamp('linux'), stamp('linux')]
  })
  await h.service.start(action())
  await settle()

  const stopping = h.service.stop()
  await settle()
  h.clock.advance(3000)
  await settle()
  h.clock.advance(3000)
  await stopping
  await h.service.start(action())
  await settle()

  expect(h.logDirs).toHaveLength(2)
})

test('releases the session logger after a clean stop', async () => {
  const h = harness({ statuses: [200] })
  await h.service.start(action())
  await settle()

  const stopping = h.service.stop()
  await settle()
  h.clock.advance(3000)
  await settle()
  h.clock.advance(3000)
  await stopping
  h.child.stdout.emit('data', Buffer.from('late output'))

  expect(h.log.info).toEqual([])
})

test('shares one escalation between concurrent stop calls', async () => {
  const h = harness({ statuses: [200] })
  await h.service.start(action())
  await settle()

  const first = h.service.stop()
  await settle()
  const second = h.service.stop()
  await settle()
  h.clock.advance(3000)
  await settle()
  h.clock.advance(3000)
  await completeWithin(Promise.all([first, second]), 'concurrent stop')

  expect(h.signals).toEqual([
    { pid: -PID, signal: 'SIGINT' },
    { pid: -PID, signal: 'SIGTERM' },
    { pid: -PID, signal: 'SIGKILL' }
  ])
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('finishes shutdown when SIGINT reports an absent process group', async () => {
  let exited = false
  const h = harness({
    statuses: [200],
    measureProcess: async () => {
      if (exited) throw new Error('must not measure after group exit')
      return stamp('linux')
    },
    onSignal: (_pid, signal, child) => {
      if (signal !== 'SIGINT') return
      exited = true
      child.exit(null, 'SIGINT')
      const error = Object.assign(new Error('process group is gone'), { code: 'ESRCH' })
      throw error
    }
  })
  await h.service.start(action())
  await settle()

  await completeWithin(h.service.stop(), 'ESRCH shutdown')

  expect(h.signals).toEqual([{ pid: -PID, signal: 'SIGINT' }])
  expect(h.service.state()).toEqual({ status: 'idle' })
  expect(h.errors).toEqual([])
})

test('keeps escalating descendants without remeasuring after the leader exits', async () => {
  let exited = false
  const h = harness({
    statuses: [200],
    measureProcess: async () => {
      if (exited) throw new Error('must not measure after leader exit')
      return stamp('linux')
    },
    onSignal: (_pid, signal, child) => {
      if (signal !== 'SIGINT') return
      exited = true
      child.exit(null, 'SIGINT')
    }
  })
  await h.service.start(action())
  await settle()

  const stopping = h.service.stop()
  await settle()
  h.clock.advance(3000)
  await settle()
  h.clock.advance(3000)
  await stopping

  expect(h.signals).toEqual([
    { pid: -PID, signal: 'SIGINT' },
    { pid: -PID, signal: 'SIGTERM' },
    { pid: -PID, signal: 'SIGKILL' }
  ])
  expect(h.service.state()).toEqual({ status: 'idle' })
})

test('refuses the final POSIX escalation when the stamp changes after SIGTERM', async () => {
  const h = harness({
    statuses: [200],
    stamps: [stamp('linux'), stamp('linux'), stamp('linux'), stamp('linux', 'recycled-before-kill')]
  })
  await h.service.start(action())
  await settle()

  const stopping = h.service.stop()
  await settle()
  h.clock.advance(3000)
  await settle()
  h.clock.advance(3000)
  await stopping

  expect(h.signals).toEqual([
    { pid: -PID, signal: 'SIGINT' },
    { pid: -PID, signal: 'SIGTERM' }
  ])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'serve process identity changed before shutdown' })
})

test('uses the System32 taskkill path for a verified Windows tree', async () => {
  const h = harness({ platform: 'win32', systemRoot: 'C:\\Windows', statuses: [200] })
  await h.service.start(action())
  await settle()

  await h.service.stop()

  expect(h.runs).toEqual([{ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/T', '/F', '/PID', String(PID)] }])
  expect(h.signals).toEqual([])
})

test('refuses Windows shutdown when SystemRoot is not a canonical absolute path', async () => {
  const h = harness({ platform: 'win32', systemRoot: 'C:\\Windows\\..\\clone', statuses: [200] })
  await h.service.start(action())
  await settle()

  await h.service.stop()

  expect(h.runs).toEqual([])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'cannot resolve Windows system executable: dot-dot' })
})

test('refuses Windows taskkill when the process stamp changes', async () => {
  const h = harness({
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    statuses: [200],
    stamps: [stamp('win32'), stamp('win32', 'recycled-windows-process')]
  })
  await h.service.start(action())
  await settle()

  await h.service.stop()

  expect(h.runs).toEqual([])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'serve process identity changed before shutdown' })
})

test('refuses to signal a recycled PID with a different process stamp', async () => {
  const h = harness({
    statuses: [200],
    stamps: [stamp('linux'), stamp('linux', 'different-process')]
  })
  await h.service.start(action())
  await settle()

  await completeWithin(h.service.stop(), 'recycled PID shutdown')

  expect(h.signals).toEqual([])
  expect(h.service.state()).toMatchObject({ status: 'failed', error: 'serve process identity changed before shutdown' })
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
