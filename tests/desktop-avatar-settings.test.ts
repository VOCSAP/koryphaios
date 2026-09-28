import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  avatarAutoAttachEnabled,
  projectAvatarSettings,
  writeAvatarAutoAttach,
  writeProjectAvatarSettings
} from '../desktop/src/main/avatar-settings.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function settingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-avatar-settings-'))
  dirs.push(dir)
  return join(dir, 'avatar-settings.json')
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${file}`)
}

test('auto-attach defaults to enabled when no setting has been persisted', () => {
  const file = settingsFile()

  expect(avatarAutoAttachEnabled(file, 'project-a')).toBe(true)
  expect(projectAvatarSettings(file, 'project-a')).toEqual({ optOut: false })
})

test('a persisted global auto-attach choice overrides the default', () => {
  const file = settingsFile()

  writeAvatarAutoAttach(file, false)
  expect(avatarAutoAttachEnabled(file, 'project-a')).toBe(false)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ autoAttach: false, projects: {} })
})

test('a project opt-out wins over an enabled global choice', () => {
  const file = settingsFile()
  writeAvatarAutoAttach(file, true)

  expect(writeProjectAvatarSettings(file, 'project-a', { optOut: true })).toEqual({ optOut: true })
  expect(avatarAutoAttachEnabled(file, 'project-a')).toBe(false)
  expect(avatarAutoAttachEnabled(file, 'project-b')).toBe(true)
})

test('a global update preserves persisted project opt-outs', () => {
  const file = settingsFile()
  writeProjectAvatarSettings(file, 'project-a', { optOut: true })

  writeAvatarAutoAttach(file, false)

  expect(avatarAutoAttachEnabled(file, 'project-a')).toBe(false)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    autoAttach: false,
    projects: { 'project-a': { optOut: true } }
  })
})

test('preserves an existing opt-out when a patch contains undefined', () => {
  const file = settingsFile()
  writeProjectAvatarSettings(file, 'project-a', { optOut: true })

  expect(writeProjectAvatarSettings(file, 'project-a', { optOut: undefined })).toEqual({ optOut: true })
  expect(avatarAutoAttachEnabled(file, 'project-a')).toBe(false)
})

test('reports a directory-creation failure as an Avatar settings failure', () => {
  const file = settingsFile()
  writeFileSync(file, 'not a directory')

  expect(() => writeAvatarAutoAttach(join(file, 'avatar-settings.json'), false)).toThrow(
    'Avatar settings could not be written'
  )
})

test('serializes a settings update behind an existing cross-process write lock', async () => {
  const file = settingsFile()
  const lockFile = `${file}.lock`
  const script = join(dirname(file), 'hold-settings-lock.mjs')
  writeFileSync(script, [
    "import { rmSync, writeFileSync } from 'node:fs'",
    'const [file, lockFile] = process.argv.slice(2)',
    "writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })",
    'setTimeout(() => {',
    "  writeFileSync(file, JSON.stringify({ autoAttach: false, projects: {} }))",
    '  rmSync(lockFile)',
    '}, 50)'
  ].join('\n'))
  const holder = Bun.spawn([process.execPath, script, file, lockFile])
  await waitForFile(lockFile)

  writeProjectAvatarSettings(file, 'project-a', { optOut: true })
  expect(await holder.exited).toBe(0)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    autoAttach: false,
    projects: { 'project-a': { optOut: true } }
  })
})

test('recovers a stale settings lock from this process', () => {
  const file = settingsFile()
  const lockFile = `${file}.lock`
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() - 11_000 }), { flag: 'wx' })

  writeAvatarAutoAttach(file, false)

  expect(existsSync(lockFile)).toBe(false)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ autoAttach: false, projects: {} })
})

test('recovers an empty settings lock after its mtime expires', () => {
  const file = settingsFile()
  const lockFile = `${file}.lock`
  writeFileSync(lockFile, '', { flag: 'wx' })
  const staleAt = new Date(Date.now() - 11_000)
  utimesSync(lockFile, staleAt, staleAt)

  expect(writeProjectAvatarSettings(file, 'empty', { optOut: true })).toEqual({ optOut: true })
  expect(existsSync(lockFile)).toBe(false)
})

test('recovers a malformed settings lock after its mtime expires', () => {
  const file = settingsFile()
  const lockFile = `${file}.lock`
  writeFileSync(lockFile, '{', { flag: 'wx' })
  const staleAt = new Date(Date.now() - 11_000)
  utimesSync(lockFile, staleAt, staleAt)

  expect(writeProjectAvatarSettings(file, 'malformed', { optOut: true })).toEqual({ optOut: true })
  expect(existsSync(lockFile)).toBe(false)
})

test('rejects a live stale lock after a bounded wait', async () => {
  const file = settingsFile()
  const lockFile = `${file}.lock`
  const script = join(dirname(file), 'hold-live-settings-lock.mjs')
  writeFileSync(script, [
    "import { writeFileSync } from 'node:fs'",
    'const lockFile = process.argv[2]',
    "writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() - 11_000 }), { flag: 'wx' })",
    'setInterval(() => {}, 1_000)'
  ].join('\n'))
  const holder = Bun.spawn([process.execPath, script, lockFile])
  await waitForFile(lockFile)

  try {
    const startedAt = Date.now()
    expect(() => writeAvatarAutoAttach(file, false)).toThrow('Avatar settings could not be written')
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(500)
    expect(elapsed).toBeLessThan(3_000)
  } finally {
    holder.kill()
    await holder.exited
  }
})

test('a malformed setting cannot silently opt a project out', () => {
  const file = settingsFile()
  writeFileSync(file, JSON.stringify({ autoAttach: 'false', projects: { 'project-a': { optOut: 'yes' } } }))

  expect(avatarAutoAttachEnabled(file, 'project-a')).toBe(true)
})

test('persists settings for prototype-looking project keys as own entries', () => {
  const file = settingsFile()

  for (const projectKey of ['constructor', '__proto__']) {
    expect(projectAvatarSettings(file, projectKey)).toEqual({ optOut: false })
    expect(writeProjectAvatarSettings(file, projectKey, { optOut: true })).toEqual({ optOut: true })
    expect(avatarAutoAttachEnabled(file, projectKey)).toBe(false)
  }

  expect(JSON.parse(readFileSync(file, 'utf8')).projects).toEqual(
    JSON.parse('{"constructor":{"optOut":true},"__proto__":{"optOut":true}}')
  )
})
