import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  avatarLaunchCommand,
  ensureAvatar,
  spawnDetachedAvatar,
  type AvatarEnsureDeps,
  type AvatarLaunchCommand,
  type AvatarLaunchInput
} from '../desktop/src/main/avatar-ensure.ts'
import { AVATAR_REGISTRY_VERSION, type AvatarRendezvous } from '../desktop/src/main/avatar-registry.ts'

const rendezvous: AvatarRendezvous = {
  version: AVATAR_REGISTRY_VERSION,
  avatarRunId: 'avatar-run-1',
  pid: 4242,
  port: 43123,
  certPem: 'avatar-test-certificate',
  token: 'avatar-test-token'
}

function launchInput(overrides: Partial<AvatarLaunchInput> = {}): AvatarLaunchInput {
  return {
    execPath: 'C:/deck/electron.exe',
    mainDir: 'C:/deck/out/main',
    env: {
      PATH: 'C:/bin',
      APPDATA: 'C:/Users/me/AppData/Roaming',
      CLAUDE_PEERS_BROKER_URL: 'http://127.0.0.1:7899',
      CLAUDE_PEERS_DESK_PROJECT_DIR: 'C:/work/project',
      CLAUDE_PEERS_DESK_SCOPE_ID: 'scope-1',
      CLAUDE_PEERS_FORCE_GROUP_NAME: 'kory-run',
      CLAUDE_PEERS_BROKER_TOKEN: 'avatar-test-token',
      ELECTRON_RUN_AS_NODE: '1',
      UNSET: undefined
    },
    homeDir: 'C:/Users/me',
    isPackaged: false,
    ...overrides
  }
}

test('a dev Deck launches its own Electron binary on its app root with --avatar, from home, detached', () => {
  const launch = avatarLaunchCommand(launchInput())
  expect(launch).toEqual({
    command: 'C:/deck/electron.exe',
    args: [join('C:/deck'), '--avatar'],
    options: {
      cwd: 'C:/Users/me',
      env: {
        PATH: 'C:/bin',
        APPDATA: 'C:/Users/me/AppData/Roaming',
        CLAUDE_PEERS_BROKER_URL: 'http://127.0.0.1:7899'
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  })
})

test('a packaged Deck launches its own executable with --avatar only, which its entry routes to the Avatar', () => {
  const launch = avatarLaunchCommand(launchInput({ execPath: 'C:/Koryphaios/koryphaios.exe', isPackaged: true }))
  expect(launch.command).toBe('C:/Koryphaios/koryphaios.exe')
  expect(launch.args).toEqual(['--avatar'])
})

function ensureDeps(overrides: Partial<AvatarEnsureDeps> & { appearsAfter?: number } = {}) {
  const spawned: AvatarLaunchCommand[] = []
  const sleeps: number[] = []
  let polls = 0
  const appearsAfter = overrides.appearsAfter ?? Number.POSITIVE_INFINITY
  const deps: AvatarEnsureDeps = {
    autoAttachEnabled: () => true,
    rendezvous: () => (spawned.length > 0 && polls++ >= appearsAfter ? rendezvous : null),
    launch: () => avatarLaunchCommand(launchInput()),
    spawn: async (launch) => {
      spawned.push(launch)
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...overrides
  }
  return { deps, spawned, sleeps }
}

test('does not start an Avatar the Deck will not attach to', async () => {
  const { deps, spawned } = ensureDeps({ autoAttachEnabled: () => false })
  expect(await ensureAvatar(deps)).toEqual({ action: 'disabled' })
  expect(spawned).toEqual([])
})

const DISABLED_AVATAR_TRACE = "logInfo('avatar', 'Avatar automatic attachment is disabled')"

function assertDisabledAvatarTrace(file: string): void {
  const source = readFileSync(file, 'utf-8')
  const disabled = source.indexOf("case 'disabled':")
  const alreadyRunning = source.indexOf("case 'already-running':", disabled)
  expect(disabled, 'startAvatarProcess must handle the disabled Avatar outcome').toBeGreaterThanOrEqual(0)
  expect(alreadyRunning, 'the disabled Avatar outcome must end before the next case').toBeGreaterThan(disabled)
  expect(source.slice(disabled, alreadyRunning)).toContain(DISABLED_AVATAR_TRACE)
}

test('writes the disabled Avatar outcome to the Deck main log with an informational trace', () => {
  const source = resolve(import.meta.dir, '..', 'desktop', 'src', 'main', 'index.ts')
  assertDisabledAvatarTrace(source)

  const mirrorDir = mkdtempSync(join(tmpdir(), 'kory-avatar-disabled-trace-'))
  const mirror = join(mirrorDir, 'index.ts')
  try {
    copyFileSync(source, mirror)
    const original = readFileSync(mirror, 'utf-8')
    const mutated = original.replace(DISABLED_AVATAR_TRACE, 'void 0')
    expect(mutated, 'the negative control must remove the disabled Avatar trace').not.toBe(original)
    writeFileSync(mirror, mutated)
    expect(() => assertDisabledAvatarTrace(mirror)).toThrow(DISABLED_AVATAR_TRACE)
  } finally {
    rmSync(mirrorDir, { recursive: true, force: true })
  }
})

test('leaves a live Avatar alone', async () => {
  const { deps, spawned } = ensureDeps({ rendezvous: () => rendezvous })
  expect(await ensureAvatar(deps)).toEqual({ action: 'already-running' })
  expect(spawned).toEqual([])
})

test('spawns once and reports started when the rendezvous appears while polling', async () => {
  const { deps, spawned, sleeps } = ensureDeps({ appearsAfter: 2 })
  expect(await ensureAvatar(deps)).toEqual({ action: 'started' })
  expect(spawned).toHaveLength(1)
  expect(sleeps).toEqual([200, 200, 200])
})

test('gives a cold start fifteen seconds before reporting no rendezvous, which is not a failure', async () => {
  const { deps, spawned, sleeps } = ensureDeps()
  expect(await ensureAvatar(deps)).toEqual({ action: 'no-rendezvous', waitedMs: 15_000 })
  expect(spawned).toHaveLength(1)
  expect(sleeps).toHaveLength(75)
})

test('fails with the real reason, without polling, when the spawn emits error asynchronously', async () => {
  const { deps, sleeps } = ensureDeps({
    spawn: () =>
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error('spawn C:/missing/electron.exe ENOENT')), 0)
      })
  })
  expect(await ensureAvatar(deps)).toEqual({ action: 'failed', reason: 'spawn C:/missing/electron.exe ENOENT' })
  expect(sleeps).toEqual([])
})

function settledWithin<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`the spawn promise was still pending after ${ms} ms`)
    })
  ])
}

function realLaunch(command: string, args: string[]): AvatarLaunchCommand {
  return {
    command,
    args,
    options: { cwd: tmpdir(), env: { ...process.env } as Record<string, string>, detached: true, stdio: 'ignore', windowsHide: true }
  }
}

test('a real spawn of a missing executable rejects with its asynchronous error', async () => {
  const reports: string[] = []
  const missing = join(tmpdir(), 'kory-avatar-missing-binary.exe')
  await expect(
    settledWithin(spawnDetachedAvatar(spawn, realLaunch(missing, []), (_scope, message) => reports.push(message)))
  ).rejects.toThrow('kory-avatar-missing-binary.exe')
  expect(reports).toEqual([])
})

test('a real spawn of an existing executable resolves once the child started', async () => {
  await expect(
    settledWithin(spawnDetachedAvatar(spawn, realLaunch(process.execPath, ['--version']), () => undefined))
  ).resolves.toBeUndefined()
})
