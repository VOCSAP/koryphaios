import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLockDatabase, type LockConnection, type LockOpener } from '../desktop/src/main/file-lock.ts'
import { onDeckError } from '../desktop/src/main/log.ts'
import {
  acquireLock,
  lockPath,
  probeSameHostLock,
  readLock,
  releaseHeldLock,
  releaseLock
} from '../desktop/src/main/workspace-lock.ts'
import { ensureWorkspacesDir, saveWorkspace, type Workspace } from '../desktop/src/main/workspace-store.ts'
import { WorkspaceService, type WorkspaceDeps } from '../desktop/src/main/workspace-service.ts'
import type { AppConfig, SessionDef } from '../desktop/src/shared/types.ts'

const MODULE = join(import.meta.dir, '..', 'desktop', 'src', 'main', 'workspace-lock.ts')

const dirs: string[] = []
const children: Array<{ kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> }> = []
const heldLocks = new Set<LockConnection>()
const services: WorkspaceService[] = []

afterEach(async () => {
  for (const svc of services.splice(0)) svc.releaseOnQuit()
  for (const held of heldLocks) releaseHeldLock(held)
  heldLocks.clear()
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await child.exited
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-wslock-'))
  dirs.push(dir)
  ensureWorkspacesDir(dir)
  return dir
}

const liveness = { host: 'this-host', bootInstant: 0, staleMs: 120_000, startedAt: 1_000 }

function takeLock(projectDir: string, id: string, pid: number, isPidAlive: (pid: number) => boolean = () => true) {
  const held = acquireLock(projectDir, id, { ...liveness, now: Date.now(), pid, isPidAlive })
  if (held) heldLocks.add(held)
  return held
}

/**
 * Another Deck process running the real acquireLock. `race` waits on a start
 * barrier, then judges the same stale lock as its twin (its isPidAlive waits,
 * bounded, for the twin to reach the same point) and keeps what it won while
 * the twin tries. `hold` takes the lock and never gives it back.
 */
function writeChildScript(dir: string): string {
  const script = join(dir, 'wslock-child.ts')
  writeFileSync(script, [
    "import { existsSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    `import { acquireLock } from ${JSON.stringify(MODULE)}`,
    'const [mode, projectDir, barrier, name] = process.argv.slice(2)',
    'const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)',
    "const twin = name === 'A' ? 'B' : 'A'",
    'const waitFor = (file: string, ms: number) => { const end = Date.now() + ms; while (!existsSync(file) && Date.now() < end) sleep(5) }',
    'const isPidAlive = () => {',
    "  writeFileSync(join(barrier, `judged-${name}`), '')",
    '  waitFor(join(barrier, `judged-${twin}`), 1_000)',
    '  return false',
    '}',
    "if (mode === 'race') {",
    "  writeFileSync(join(barrier, `ready-${name}`), '')",
    '  waitFor(join(barrier, `ready-${twin}`), 5_000)',
    '}',
    "const held = acquireLock(projectDir, 'ws1', { host: 'this-host', bootInstant: 0, staleMs: 120_000, startedAt: 1_000, now: Date.now(), pid: process.pid, isPidAlive })",
    "if (mode === 'hold') { writeFileSync(join(barrier, 'held'), String(held !== null)); sleep(60_000) }",
    'process.stdout.write(JSON.stringify({ name, acquired: held !== null }))',
    'sleep(1_000)'
  ].join('\n'))
  return script
}

function spawnChild(script: string, args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  return child
}

async function holdInChild(projectDir: string, id = 'ws1') {
  expect(id, 'the child script locks ws1').toBe('ws1')
  const barrier = join(projectDir, 'barrier')
  mkdirSync(barrier, { recursive: true })
  const child = spawnChild(writeChildScript(barrier), ['hold', projectDir, barrier, 'H'])
  const deadline = Date.now() + 10_000
  while (!existsSync(join(barrier, 'held'))) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the holder')
    await Bun.sleep(10)
  }
  expect(readFileSync(join(barrier, 'held'), 'utf8'), 'the holder process must have acquired the lock').toBe('true')
  return child
}

test('two Decks judging the same stale lock at once: exactly one acquires it', async () => {
  const projectDir = freshProject()
  writeFileSync(lockPath(projectDir, 'ws1'), JSON.stringify({ pid: 999_999, host: 'this-host', startedAt: 1, heartbeat: 1 }))
  const barrier = join(projectDir, 'barrier')
  mkdirSync(barrier)
  const script = writeChildScript(barrier)
  const a = spawnChild(script, ['race', projectDir, barrier, 'A'])
  const b = spawnChild(script, ['race', projectDir, barrier, 'B'])
  const outputs = await Promise.all(
    [a, b].map(async (child) => {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
      ])
      expect(code, err).toBe(0)
      return JSON.parse(out) as { name: string; acquired: boolean }
    })
  )
  expect(
    outputs.filter((o) => o.acquired).length,
    `both Decks own the workspace when both win: ${JSON.stringify(outputs)}`
  ).toBe(1)
})

test('a Deck killed while owning a workspace frees it for the next one, within a bounded wait', async () => {
  const projectDir = freshProject()
  const holder = await holdInChild(projectDir)
  expect(takeLock(projectDir, 'ws1', 5555, () => false), 'a live owner process must refuse').toBeNull()
  holder.kill('SIGKILL')
  await holder.exited
  const startedAt = Date.now()
  const pidAlive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  expect(takeLock(projectDir, 'ws1', 5555, pidAlive), 'the dead owner left its lock behind').not.toBeNull()
  expect(Date.now() - startedAt).toBeLessThan(2_000)
  expect(readLock(projectDir, 'ws1')!.pid).toBe(5555)
})

test("releasing a workspace this Deck does not own leaves the owner's locks in place", async () => {
  const projectDir = freshProject()
  await holdInChild(projectDir)
  expect(releaseLock(projectDir, 'ws1', { pid: 5555, host: 'this-host' }, null)).toBe(false)
  expect(readLock(projectDir, 'ws1'), "the owner's JSON lock").not.toBeNull()
  expect(probeSameHostLock(projectDir, 'ws1'), "the owner's OS lock").toBe('held')
  expect(takeLock(projectDir, 'ws1', 5555, () => false)).toBeNull()
})

test('a JSON lock from another host decides alone: refused while its heartbeat is fresh, taken once stale', () => {
  const projectDir = freshProject()
  const foreign = { pid: 1, host: 'other-host', startedAt: 1, heartbeat: Date.now() }
  writeFileSync(lockPath(projectDir, 'ws1'), JSON.stringify(foreign))
  expect(probeSameHostLock(projectDir, 'ws1')).toBe('free')
  expect(takeLock(projectDir, 'ws1', 5555)).toBeNull()
  writeFileSync(lockPath(projectDir, 'ws1'), JSON.stringify({ ...foreign, heartbeat: Date.now() - 200_000 }))
  expect(takeLock(projectDir, 'ws1', 5555)).not.toBeNull()
  expect(readLock(projectDir, 'ws1')!.host).toBe('this-host')
})

test('an unreadable JSON lock is rewritten once the OS lock is won', () => {
  const projectDir = freshProject()
  writeFileSync(lockPath(projectDir, 'ws1'), '{ torn')
  expect(readLock(projectDir, 'ws1')).toBeNull()
  expect(takeLock(projectDir, 'ws1', 5555)).not.toBeNull()
  expect(readLock(projectDir, 'ws1')).toEqual({ pid: 5555, host: 'this-host', startedAt: 1_000, heartbeat: expect.any(Number) })
})

// ----- WorkspaceService -----

function sampleWorkspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: 'sample',
    pinned: false,
    cwd: '/abs/project',
    groupId: 'a'.repeat(64),
    scopeName: 'dev-pc-foo',
    scopeKind: 'ephemeral',
    displayMode: { kind: 'grid', x: 2, y: 2 },
    createdAt: 1000,
    updatedAt: 1000,
    sessions: [{ claudeSessionId: 'sid-1', name: 'reviewer', cwd: '/abs/project', args: [], color: '#4488ff', position: 0 }],
    ...overrides
  }
}

function service(projectDir: string, pid: number, openLock?: LockOpener): WorkspaceService {
  let sessions: SessionDef[] = []
  const deps: WorkspaceDeps = {
    projectDir,
    service: {
      captureSessions: () => sessions,
      refreshLiveSessionIds: () => {},
      restoreFrom: (defs: SessionDef[]) => {
        sessions = defs
      }
    } as unknown as WorkspaceDeps['service'],
    getConfig: () => ({ displayMode: '2x2', gridCols: 2, gridRows: 2 }) as AppConfig,
    setConfig: () => {},
    getScope: () => ({ secret: 's', scopeKind: 'ephemeral', groupId: 'a'.repeat(64), name: 'n', root: 'n' }),
    adoptScope: () => {},
    confirmShellFields: () => 'approved',
    confirmUntrustedCwd: () => 'approved',
    pid,
    host: 'this-host',
    openLock
  }
  const svc = new WorkspaceService(deps)
  services.push(svc)
  return svc
}

test('the workspace list shows as locked a workspace another Deck process owns, and free once it dies', async () => {
  const projectDir = freshProject()
  saveWorkspace(projectDir, sampleWorkspace('ws1'))
  const svc = service(projectDir, 5555)
  const holder = await holdInChild(projectDir)
  expect(svc.listForCwd().find((w) => w.id === 'ws1')?.locked).toBe(true)
  expect(svc.restore('ws1', 'attended')).toEqual({ ok: false, reason: 'locked' })
  holder.kill('SIGKILL')
  await holder.exited
  expect(svc.listForCwd().find((w) => w.id === 'ws1')?.locked).toBe(false)
  expect(svc.restore('ws1', 'attended')).toEqual({ ok: true })
})

test('the OS lock of an owned workspace survives a garbage collection: the service keeps its connection', () => {
  const projectDir = freshProject()
  saveWorkspace(projectDir, sampleWorkspace('ws1'))
  const svc = service(projectDir, 5555)
  expect(svc.restore('ws1', 'attended')).toEqual({ ok: true })
  Bun.gc(true)
  Bun.gc(true)
  expect(probeSameHostLock(projectDir, 'ws1'), 'a collected connection drops its lock').toBe('held')
})

test('pruneStale never deletes a workspace whose lock it cannot read', () => {
  const projectDir = freshProject()
  for (const id of ['ws_torn', 'ws_free']) {
    saveWorkspace(projectDir, sampleWorkspace(id))
    const file = join(projectDir, '.claude', 'claude-peers', 'workspaces', `${id}.json`)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), updatedAt: 1000 }))
  }
  writeFileSync(lockPath(projectDir, 'ws_torn'), '{ torn')
  const svc = service(projectDir, 5555)
  expect(svc.pruneStale()).toEqual(['ws_free'])
  expect(existsSync(join(projectDir, '.claude', 'claude-peers', 'workspaces', 'ws_torn.json'))).toBe(true)
})

/** The real opener, counting the lock connections it hands out. */
function countingOpener(): { open: LockOpener; opened: () => number } {
  let opened = 0
  return {
    open: (path) => {
      opened += 1
      return openLockDatabase(path)
    },
    opened: () => opened
  }
}

test("the owner of the current workspace rewrites its vanished JSON lock without ever letting go of the OS lock", () => {
  const projectDir = freshProject()
  saveWorkspace(projectDir, sampleWorkspace('ws1'))
  const counter = countingOpener()
  const svc = service(projectDir, 5555, counter.open)
  expect(svc.restore('ws1', 'attended')).toEqual({ ok: true })
  rmSync(lockPath(projectDir, 'ws1'))
  expect(takeLock(projectDir, 'ws1', 6666, () => false), 'no other Deck may win while the JSON is gone').toBeNull()

  const opensBefore = counter.opened()
  expect(svc.saveAuto()).not.toBeNull()
  expect(counter.opened(), 'the owner reopened its lock database: it gave the OS lock up in between').toBe(opensBefore)
  expect(readLock(projectDir, 'ws1')!.pid).toBe(5555)
  expect(svc.currentWorkspaceId).toBe('ws1')
  expect(probeSameHostLock(projectDir, 'ws1')).toBe('held')
})

test('a lock database that cannot be probed keeps the workspace locked, traced once with its remedy', () => {
  const projectDir = freshProject()
  saveWorkspace(projectDir, sampleWorkspace('ws1'))
  const file = join(projectDir, '.claude', 'claude-peers', 'workspaces', 'ws1.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), updatedAt: 1000 }))
  const garbage = `${lockPath(projectDir, 'ws1')}.sqlite`
  writeFileSync(garbage, 'not a lock database, '.repeat(40))
  const reported: string[] = []
  onDeckError((_scope, text) => reported.push(text))
  try {
    const svc = service(projectDir, 5555)
    expect(probeSameHostLock(projectDir, 'ws1')).toBe('unprobeable')
    expect(svc.listForCwd().find((w) => w.id === 'ws1')?.locked).toBe(true)
    expect(svc.listForCwd().find((w) => w.id === 'ws1')?.locked).toBe(true)
    expect(svc.restore('ws1', 'attended')).toEqual({ ok: false, reason: 'locked' })
    expect(svc.pruneStale()).toEqual([])
  } finally {
    onDeckError(() => {})
  }
  const remedies = reported.filter((t) => t.includes(garbage) && t.includes('delete that file by hand'))
  expect(remedies.length, `one trace naming the file and its remedy, not one per probe: ${JSON.stringify(reported)}`).toBe(1)
  expect(readFileSync(garbage, 'utf8')).toBe('not a lock database, '.repeat(40))
})

test('a heartbeat that finds a foreign JSON lock gives the OS lock back', () => {
  const projectDir = freshProject()
  saveWorkspace(projectDir, sampleWorkspace('ws1'))
  const svc = service(projectDir, 5555)
  expect(svc.restore('ws1', 'attended')).toEqual({ ok: true })
  const tick = () => (svc as unknown as { heartbeatTick(): void }).heartbeatTick()
  rmSync(lockPath(projectDir, 'ws1'))
  tick()
  expect(readLock(projectDir, 'ws1')!.pid, 'a vanished JSON lock is rewritten by its OS lock owner').toBe(5555)
  expect(probeSameHostLock(projectDir, 'ws1')).toBe('held')

  writeFileSync(lockPath(projectDir, 'ws1'), JSON.stringify({ pid: 999_999, host: 'this-host', startedAt: 1, heartbeat: 1 }))
  tick()
  expect(readLock(projectDir, 'ws1')!.pid, "a dead foreign JSON lock is rewritten, as own() does").toBe(5555)
  expect(probeSameHostLock(projectDir, 'ws1'), 'a dead foreign JSON lock must not eject the owner').toBe('held')

  writeFileSync(lockPath(projectDir, 'ws1'), JSON.stringify({ pid: 1, host: 'other-host', startedAt: 1, heartbeat: Date.now() }))
  tick()
  expect(probeSameHostLock(projectDir, 'ws1'), 'the ejected owner still holds the OS lock').toBe('free')
})

test('a JSON lock naming this very Deck is taken back once the OS lock is won', () => {
  const projectDir = freshProject()
  writeFileSync(lockPath(projectDir, 'ws1'), JSON.stringify({ pid: 5555, host: 'this-host', startedAt: 1, heartbeat: Date.now() }))
  expect(takeLock(projectDir, 'ws1', 5555, () => true)).not.toBeNull()
  expect(takeLock(projectDir, 'ws1', 6666, () => true), 'the OS lock still refuses anyone else').toBeNull()
})
