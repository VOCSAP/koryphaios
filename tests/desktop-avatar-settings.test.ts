import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('a write refused by a held lock names the lock failure and leaves the file untouched', () => {
  const file = settingsFile()
  writeAvatarAutoAttach(file, true)
  const holder = new Database(`${file}.lock.sqlite`)
  holder.run('BEGIN IMMEDIATE')
  try {
    const startedAt = Date.now()
    expect(() => writeAvatarAutoAttach(file, false)).toThrow(
      /^Avatar settings could not be written: another process is writing .*retry/
    )
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  } finally {
    holder.run('ROLLBACK')
    holder.close()
  }
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ autoAttach: true, projects: {} })
  writeAvatarAutoAttach(file, false)
  expect(avatarAutoAttachEnabled(file, 'project-a')).toBe(false)
})

test('a lock file left by the previous lock protocol neither blocks the write nor is deleted', () => {
  const file = settingsFile()
  const legacyLock = `${file}.lock`
  writeFileSync(legacyLock, JSON.stringify({ pid: process.pid, at: Date.now() }))

  expect(writeProjectAvatarSettings(file, 'project-a', { optOut: true })).toEqual({ optOut: true })
  expect(existsSync(legacyLock)).toBe(true)
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
