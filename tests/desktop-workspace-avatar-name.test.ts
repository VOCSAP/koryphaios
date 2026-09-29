import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { deckAvatarClientOptions } from '../desktop/src/main/avatar-deck-link.ts'
import { WorkspaceService } from '../desktop/src/main/workspace-service.ts'
import { loadWorkspace, saveWorkspace } from '../desktop/src/main/workspace-store.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-workspace-avatar-name-'))
  dirs.push(dir)
  return dir
}

function session(name: string, cwd: string) {
  return { id: `local-${name}`, name, cwd, command: '', args: '', sessionId: `sid-${name}`, color: '#4488ff', createdAt: 1 }
}

function makeService(projectDir: string, capture: () => unknown[]): WorkspaceService {
  const deps = {
    projectDir,
    service: { captureSessions: capture, refreshLiveSessionIds: () => {}, restoreFrom: () => [] },
    getConfig: () => ({ displayMode: '2x2', gridCols: 2, gridRows: 2 }),
    setConfig: () => {},
    getScope: () => ({ secret: 's', scopeKind: 'ephemeral', groupId: 'a'.repeat(32), name: 'test-scope', root: 'test' }),
    adoptScope: () => {},
    confirmShellFields: () => {
      throw new Error('confirmShellFields must not be called: no fixture carries args')
    },
    confirmUntrustedCwd: () => {
      throw new Error('confirmUntrustedCwd must not be called: every fixture cwd is in the project')
    }
  }
  return new WorkspaceService(deps as unknown as ConstructorParameters<typeof WorkspaceService>[0])
}

test('the Deck name follows the current workspace: none, auto name, Save As, then New', () => {
  const project = freshProject()
  const svc = makeService(project, () => [session('agent', project)])
  expect(svc.currentWorkspaceName).toBeNull()

  svc.saveAuto()
  expect(svc.currentWorkspaceName?.startsWith('auto · test-scope · ')).toBe(true)

  svc.saveNamed('Alpha')
  expect(svc.currentWorkspaceName).toBe('Alpha')

  svc.startNew()
  expect(svc.currentWorkspaceName).toBeNull()
  svc.releaseOnQuit()
})

test('a restored workspace gives its name even when the recapture persists nothing', () => {
  const project = freshProject()
  const first = makeService(project, () => [session('agent', project)])
  const saved = first.saveNamed('Alpha')
  first.releaseOnQuit()

  const second = makeService(project, () => [])
  expect(second.restore(saved.id, 'attended')).toEqual({ ok: true })
  expect(second.currentWorkspaceName).toBe('Alpha')
  second.releaseOnQuit()
})

test('a restored workspace whose name is not a string yields no name, and the Deck falls back to its folder', () => {
  for (const hostile of [123, {}, []]) {
    const project = freshProject()
    const first = makeService(project, () => [session('agent', project)])
    const saved = first.saveNamed('Alpha')
    first.releaseOnQuit()
    const stored = loadWorkspace(project, saved.id)!
    saveWorkspace(project, { ...stored, name: hostile as unknown as string })

    const second = makeService(project, () => [])
    expect(second.restore(saved.id, 'attended')).toEqual({ ok: true })
    expect(second.currentWorkspaceName).toBeNull()
    const options = deckAvatarClientOptions({
      deckRunId: 'deck-run-1',
      projectDir: project,
      projectKey: 'project-a',
      stateDir: project,
      brokerUrl: 'http://127.0.0.1:7899',
      sessions: () => [],
      window: () => null,
      workspaceName: () => second.currentWorkspaceName
    })
    expect(() => options.deck()).not.toThrow()
    expect(options.deck().deckName).toBe(basename(project))
    second.releaseOnQuit()
  }
})

test('deleting the current workspace clears the Deck name', () => {
  const project = freshProject()
  const svc = makeService(project, () => [session('agent', project)])
  const saved = svc.saveNamed('Alpha')
  svc.deleteWs(saved.id)
  expect(svc.currentWorkspaceName).toBeNull()
  svc.releaseOnQuit()
})
