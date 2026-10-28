import { afterEach, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionSkills, sessionSkillsHandlers, sessionSkillsPath, writeSessionSkills } from '../desktop/src/main/session-skills'

const dirs: string[] = []

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-session-skills-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('returns empty addenda only when the global file is absent', () => {
  const state = stateDir()

  expect(readSessionSkills(state)).toEqual({
    version: 1,
    addendum: { start: '', end: '', stop: '' }
  })
})

test('persists each addendum in the global state directory', () => {
  const state = stateDir()
  const settings = {
    version: 1 as const,
    addendum: { start: 'Prepare context.', end: 'Publish the handoff.', stop: 'Explain the stop.' }
  }

  expect(writeSessionSkills(state, settings)).toEqual(settings)
  expect(JSON.parse(readFileSync(sessionSkillsPath(state), 'utf8'))).toEqual(settings)
  expect(readSessionSkills(state)).toEqual(settings)
})

test('rejects a linked, malformed, or non-strict settings file instead of treating it as absent', () => {
  const state = stateDir()
  const file = sessionSkillsPath(state)
  const external = join(state, 'external.json')
  writeFileSync(external, JSON.stringify({ version: 1, addendum: { start: '', end: '', stop: '' } }))
  symlinkSync(external, file, process.platform === 'win32' ? 'file' : undefined)
  expect(() => readSessionSkills(state)).toThrow('symbolic link')
  rmSync(file)
  symlinkSync(join(state, 'missing.json'), file, process.platform === 'win32' ? 'file' : undefined)
  expect(() => writeSessionSkills(state, { version: 1, addendum: { start: '', end: '', stop: '' } })).toThrow('symbolic link')
  rmSync(file)

  for (const content of [
    '{',
    JSON.stringify({ version: 2, addendum: { start: '', end: '', stop: '' } }),
    JSON.stringify({ version: 1, addendum: { start: '', end: '', stop: '' }, commands: [] }),
    JSON.stringify({ version: 1, addendum: { start: 1, end: '', stop: '' } })
  ]) {
    writeFileSync(file, content)
    expect(() => readSessionSkills(state)).toThrow('Invalid session skills settings')
  }
  expect(() => writeSessionSkills(state, { version: 1, addendum: { start: '', end: '', stop: '' }, commands: [] })).toThrow('Invalid session skills settings')
})

test('distinguishes a non-regular file from a symbolic link', () => {
  const state = stateDir()
  mkdirSync(sessionSkillsPath(state))

  expect(() => readSessionSkills(state)).toThrow('Session skills settings is not a regular file')
})

test('names the oversized addendum that is rejected before persistence', () => {
  const state = stateDir()
  const settings = {
    version: 1 as const,
    addendum: { start: 'x'.repeat(16 * 1024 + 1), end: '', stop: '' }
  }

  expect(() => writeSessionSkills(state, settings)).toThrow('start')
  expect(existsSync(sessionSkillsPath(state))).toBe(false)
})

test('rejects an oversized persisted document before JSON parsing', () => {
  const state = stateDir()
  writeFileSync(sessionSkillsPath(state), 'x'.repeat(64 * 1024 + 1))

  expect(() => readSessionSkills(state)).toThrow('Session skills settings is too large')
})

test('writes no temporary file after a completed save', () => {
  const state = stateDir()
  writeSessionSkills(state, { version: 1, addendum: { start: 'A', end: 'B', stop: 'C' } })

  expect(readdirSync(state).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

test('reads a later persisted value without retaining a prior snapshot', () => {
  const state = stateDir()
  writeSessionSkills(state, { version: 1, addendum: { start: 'first', end: '', stop: '' } })
  expect(readSessionSkills(state).addendum.start).toBe('first')

  writeSessionSkills(state, { version: 1, addendum: { start: 'second', end: '', stop: '' } })
  expect(readSessionSkills(state).addendum.start).toBe('second')
})

test('reads an externally replaced settings document on the next access', () => {
  const state = stateDir()
  writeSessionSkills(state, { version: 1, addendum: { start: 'first', end: '', stop: '' } })
  writeFileSync(sessionSkillsPath(state), JSON.stringify({ version: 1, addendum: { start: 'second', end: '', stop: '' } }))

  expect(readSessionSkills(state).addendum.start).toBe('second')
})

test('does not derive the settings file from the working directory', () => {
  const state = stateDir()
  const cwd = process.cwd()

  expect(sessionSkillsPath(state)).toBe(join(state, 'session-skills.json'))
  expect(sessionSkillsPath(state)).not.toBe(join(cwd, 'session-skills.json'))
})

const addenda = (start = '', end = '', stop = '') => ({ version: 1 as const, addendum: { start, end, stop } })

test('handlers set and get use their shared state directory', () => {
  const state = stateDir()
  const handlers = sessionSkillsHandlers(state)
  const value = addenda('first', 'second', 'third')

  expect(handlers.set(value)).toEqual(value)
  expect(handlers.get()).toEqual(value)
})

test('handler set rejects invalid payloads without persisting a document', () => {
  const state = stateDir()
  const handlers = sessionSkillsHandlers(state)

  expect(() => handlers.set({ version: 1, addendum: { start: '', end: '', stop: '' }, commands: [] })).toThrow('Invalid session skills settings')
  expect(existsSync(sessionSkillsPath(state))).toBe(false)
})

test('handler set ignores a hostile trailing directory argument', () => {
  const state = stateDir()
  const hostile = stateDir()
  const handlers = sessionSkillsHandlers(state)
  const value = addenda('global')

  expect(handlers.set(value, hostile)).toEqual(value)
  expect(handlers.get(hostile)).toEqual(value)
  expect(readSessionSkills(state)).toEqual(value)
  expect(existsSync(sessionSkillsPath(hostile))).toBe(false)
})

test('accepts an addendum at exactly the byte limit', () => {
  const state = stateDir()
  writeSessionSkills(state, addenda('x'.repeat(16 * 1024)))

  expect(readSessionSkills(state).addendum.start.length).toBe(16 * 1024)
})

test('counts UTF-8 bytes for the addendum limit', () => {
  const state = stateDir()
  expect(() => writeSessionSkills(state, addenda('é'.repeat(8 * 1024 + 1)))).toThrow('start')
  writeSessionSkills(state, addenda('é'.repeat(8 * 1024)))

  expect(readSessionSkills(state).addendum.start.length).toBe(8 * 1024)
})

test('refuses three individually valid addenda when their JSON document exceeds 64 KiB', () => {
  const state = stateDir()
  const quotes = '"'.repeat(16 * 1024)

  expect(() => writeSessionSkills(state, addenda(quotes, quotes, quotes))).toThrow('Session skills settings is too large')
  expect(readdirSync(state)).toEqual([])
})

test('counts UTF-8 bytes for the JSON document limit', () => {
  const state = stateDir()
  const mixed = '"'.repeat(8884) + '€'.repeat(2500)
  expect(Buffer.byteLength(mixed, 'utf8')).toBe(16 * 1024)

  expect(() => writeSessionSkills(state, addenda(mixed, mixed, mixed))).toThrow('Session skills settings is too large')
})

function exactDocument(): ReturnType<typeof addenda> {
  const base = Buffer.byteLength(JSON.stringify(addenda()), 'utf8')
  const extra = 64 * 1024 - base
  const start = '"'.repeat(16 * 1024)
  const end = 'x'.repeat(16 * 1024)
  const stop = 'x'.repeat(extra - 2 * start.length - end.length)
  return addenda(start, end, stop)
}

test('writes and reads a JSON document of exactly 64 KiB', () => {
  const state = stateDir()
  const value = exactDocument()
  expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBe(64 * 1024)

  writeSessionSkills(state, value)
  expect(readFileSync(sessionSkillsPath(state)).length).toBe(64 * 1024)
  expect(readSessionSkills(state)).toEqual(value)
})

test('reads a persisted 64 KiB document and rejects one byte more', () => {
  const state = stateDir()
  writeFileSync(sessionSkillsPath(state), JSON.stringify(exactDocument()))
  expect(readSessionSkills(state).addendum.end.length).toBe(16 * 1024)

  writeFileSync(sessionSkillsPath(state), JSON.stringify(exactDocument()) + ' ')
  expect(() => readSessionSkills(state)).toThrow('Session skills settings is too large')
})

test('round-trips three maximal addenda', () => {
  const state = stateDir()
  const full = 'x'.repeat(16 * 1024)
  writeSessionSkills(state, addenda(full, full, full))

  expect(readSessionSkills(state).addendum.stop.length).toBe(16 * 1024)
})

test('rejects unknown addendum keys on read and write', () => {
  const state = stateDir()
  const extra = { version: 1, addendum: { start: '', end: '', stop: '', extra: '' } }

  expect(() => writeSessionSkills(state, extra)).toThrow('Invalid session skills settings')
  writeFileSync(sessionSkillsPath(state), JSON.stringify(extra))
  expect(() => readSessionSkills(state)).toThrow('Invalid session skills settings')
})

test('rejects a version other than number 1', () => {
  const state = stateDir()
  writeFileSync(sessionSkillsPath(state), JSON.stringify({ version: '1', addendum: { start: '', end: '', stop: '' } }))

  expect(() => readSessionSkills(state)).toThrow('Invalid session skills settings')
})

test('replaces the settings file rather than rewriting it in place', () => {
  const state = stateDir()
  writeSessionSkills(state, addenda('old'))
  const alias = join(state, 'alias.json')
  linkSync(sessionSkillsPath(state), alias)
  writeSessionSkills(state, addenda('new'))

  expect(JSON.parse(readFileSync(alias, 'utf8')).addendum.start).toBe('old')
  expect(readSessionSkills(state).addendum.start).toBe('new')
})

test('a failed save removes its temporary file and preserves the prior document link', () => {
  const state = stateDir()
  writeSessionSkills(state, addenda('old'))
  const alias = join(state, 'old.json')
  linkSync(sessionSkillsPath(state), alias)
  rmSync(sessionSkillsPath(state))
  mkdirSync(sessionSkillsPath(state))

  expect(() => writeSessionSkills(state, addenda('new'))).toThrow()
  expect(readdirSync(state).filter((name) => name.endsWith('.tmp'))).toEqual([])
  expect(JSON.parse(readFileSync(alias, 'utf8')).addendum.start).toBe('old')
})
