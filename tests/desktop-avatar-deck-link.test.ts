import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createAvatarClient } from '../desktop/src/main/avatar-client.ts'
import {
  boundedAvatarDetach,
  deckAvatarClientOptions,
  focusDeckWindow,
  type DeckAvatarLinkDeps,
  type DeckAvatarWindow
} from '../desktop/src/main/avatar-deck-link.ts'
import { avatarPrivateDir } from '../desktop/src/main/avatar-private-dir.ts'
import {
  AVATAR_REGISTRY_FILE,
  AVATAR_REGISTRY_VERSION,
  type AvatarRendezvous
} from '../desktop/src/main/avatar-registry.ts'
import {
  AVATAR_SETTINGS_FILE,
  writeAvatarAutoAttach,
  writeProjectAvatarSettings
} from '../desktop/src/main/avatar-settings.ts'
import { parseAvatarAttachRequest } from '../desktop/src/shared/avatar-protocol.ts'
import type { SessionRuntime } from '../desktop/src/shared/types.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-avatar-deck-link-'))
  dirs.push(dir)
  return dir
}

function deps(overrides: Partial<DeckAvatarLinkDeps> = {}): DeckAvatarLinkDeps {
  return {
    deckRunId: randomUUID(),
    projectDir: 'C:/work/example',
    projectKey: 'project-a',
    stateDir: freshDir(),
    brokerUrl: 'http://127.0.0.1:7899',
    sessions: () => [],
    window: () => null,
    ...overrides
  }
}

function fakeWindow(state: { minimized?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = []
  const window: DeckAvatarWindow = {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  }
  return { window, calls }
}

test('auto-attach reads the state-dir settings file for this project key, project opt-out first', () => {
  const stateDir = freshDir()
  const settingsFile = join(stateDir, AVATAR_SETTINGS_FILE)
  const projectA = deckAvatarClientOptions(deps({ stateDir, projectKey: 'project-a' }))
  const projectB = deckAvatarClientOptions(deps({ stateDir, projectKey: 'project-b' }))
  expect(projectA.autoAttachEnabled()).toBe(true)

  writeProjectAvatarSettings(settingsFile, 'project-a', { optOut: true })
  expect(projectA.autoAttachEnabled()).toBe(false)
  expect(projectB.autoAttachEnabled()).toBe(true)

  writeAvatarAutoAttach(settingsFile, false)
  expect(projectB.autoAttachEnabled()).toBe(false)
})

test('builds a Deck identity the attach parser accepts, with an absolute projectDir and a bounded name', () => {
  const longName = `${'n'.repeat(70)}&co`
  const options = deckAvatarClientOptions(deps({ projectDir: join('relative', longName) }))
  expect(isAbsolute(options.deck.projectDir)).toBe(true)
  expect(options.deck.deckName).toBe('n'.repeat(64))
  expect(options.deck.deckPid).toBe(process.pid)
  expect(() => parseAvatarAttachRequest({ protocol_version: 1, ...options.deck })).not.toThrow()
})

test('never ends the bounded Deck name on half of a surrogate pair', () => {
  const name = `${'a'.repeat(63)}\u{1F600}`
  const options = deckAvatarClientOptions(deps({ projectDir: join('relative', name) }))
  expect(options.deck.deckName).toBe('a'.repeat(63))
  expect(deckAvatarClientOptions(deps({ projectDir: join('relative', `${'a'.repeat(62)}\u{1F600}`) })).deck.deckName).toBe(
    `${'a'.repeat(62)}\u{1F600}`
  )
})

test('the quit waits at most three seconds for the Avatar detach, and says so when it gives up', async () => {
  const reports: string[] = []
  const waits: number[] = []
  const report = (_scope: string, message: string): void => {
    reports.push(message)
  }
  await boundedAvatarDetach(new Promise<void>(() => undefined), async (ms) => {
    waits.push(ms)
  }, report)
  expect(waits).toEqual([3_000])
  expect(reports).toEqual(['Avatar detach still pending after 3000 ms, quitting anyway'])

  await boundedAvatarDetach(Promise.resolve(), () => new Promise<void>(() => undefined), report)
  expect(reports).toHaveLength(1)
})

test('reads the rendezvous from the state dir', () => {
  const stateDir = freshDir()
  const options = deckAvatarClientOptions(deps({ stateDir }))
  expect(options.rendezvous()).toBeNull()

  const record: AvatarRendezvous = {
    version: AVATAR_REGISTRY_VERSION,
    avatarRunId: 'avatar-run-1',
    pid: process.pid,
    port: 43123,
    certPem: 'avatar-test-certificate',
    token: 'avatar-test-token'
  }
  mkdirSync(avatarPrivateDir(stateDir), { recursive: true })
  writeFileSync(join(avatarPrivateDir(stateDir), AVATAR_REGISTRY_FILE), JSON.stringify(record))
  expect(options.rendezvous()).toEqual(record)
})

test('passes every session, supervisor included, to the Avatar counters', () => {
  const sessions = [{ supervisor: true }, { supervisor: false }] as unknown as SessionRuntime[]
  expect(deckAvatarClientOptions(deps({ sessions: () => sessions })).sessions()).toBe(sessions)
})

test('focus restores a minimized Deck window, then shows it, then focuses it', async () => {
  const minimized = fakeWindow({ minimized: true })
  await focusDeckWindow(minimized.window)
  expect(minimized.calls).toEqual(['restore', 'show', 'focus'])

  const visible = fakeWindow()
  await deckAvatarClientOptions(deps({ window: () => visible.window })).focus()
  expect(visible.calls).toEqual(['show', 'focus'])
})

test('focus rejects without a window or on a destroyed one, touching nothing', async () => {
  const destroyed = fakeWindow({ destroyed: true, minimized: true })
  await expect(focusDeckWindow(null)).rejects.toThrow('the Deck window is not available')
  await expect(focusDeckWindow(destroyed.window)).rejects.toThrow('the Deck window is not available')
  expect(destroyed.calls).toEqual([])
})

test('the detach promise awaited by the quit release never rejects, even when every Avatar call fails', async () => {
  const reports: string[] = []
  const client = createAvatarClient({
    ...deckAvatarClientOptions(deps()),
    rendezvous: () => ({
      version: AVATAR_REGISTRY_VERSION,
      avatarRunId: 'avatar-run-1',
      pid: process.pid,
      port: 1,
      certPem: 'cert',
      token: 'token'
    }),
    post: (_rendezvous, path) => (path === '/attach' ? Promise.resolve(200) : Promise.reject(new Error('Avatar unreachable'))),
    connect: () => {
      throw new Error('socket refused')
    },
    every: () => () => undefined,
    report: (_scope, message) => reports.push(message)
  })
  client.start()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const outcome = await client.stop().then(
    (value) => ({ settled: 'resolved', value }),
    () => ({ settled: 'rejected', value: undefined })
  )
  expect(outcome.settled).toBe('resolved')
  expect(outcome.value).toBeUndefined()
  expect(reports).toEqual(['Avatar link failed'])
})

test('source scan: the quit effects stop the Avatar client before the session service', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'index.ts'), 'utf-8')
  const avatar = [...source.matchAll(/label: 'avatar'/g)].map((match) => match.index)
  const service = [...source.matchAll(/label: 'service'/g)].map((match) => match.index)
  expect(avatar).toHaveLength(1)
  expect(service).toHaveLength(1)
  expect(avatar[0]!).toBeLessThan(service[0]!)
})
