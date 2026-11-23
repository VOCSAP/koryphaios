import { afterEach, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractBracedBody } from './_braced-body'
import { readSessionSkills, registerSessionSkillsChannels, sessionSkillsHandlers, sessionSkillsPath, writeSessionSkills } from '../desktop/src/main/session-skills'
import { APP_STATE_SUBDIR, appStateDirOf } from '../desktop/src/main/migrate-data-dir'

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
    version: 3,
    addendum: { start: '', end: '', stop: '' },
    storage: { mode: 'kory', instructions: '' },
    commands: { start: [], end: [], stop: [] }
  })
})

test('normalizes an absent or v1 settings document to Kory storage', () => {
  const state = stateDir()
  const expected = {
    version: 3 as const,
    addendum: { start: '', end: '', stop: '' },
    storage: { mode: 'kory' as const, instructions: '' },
    commands: { start: [], end: [], stop: [] }
  }

  expect(readSessionSkills(state)).toEqual(expected)
  writeFileSync(sessionSkillsPath(state), JSON.stringify({ version: 1, addendum: { start: 'resume', end: '', stop: '' } }))
  expect(readSessionSkills(state)).toEqual({
    ...expected,
    addendum: { start: 'resume', end: '', stop: '' }
  })
})

test('accepts bounded custom storage instructions', () => {
  const state = stateDir()
  const settings = {
    version: 3 as const,
    addendum: { start: '', end: '', stop: '' },
    storage: { mode: 'custom' as const, instructions: 'é'.repeat(8 * 1024) },
    commands: { start: [], end: [], stop: [] }
  }

  expect(writeSessionSkills(state, settings)).toEqual(settings)
  expect(() => writeSessionSkills(state, { ...settings, storage: { mode: 'custom', instructions: 'é'.repeat(8 * 1024 + 1) } })).toThrow('storage')
  expect(() => writeSessionSkills(state, { ...settings, storage: { mode: 'custom', instructions: '   ' } })).toThrow('Invalid session skills settings')
})

test('persists each addendum in the global state directory', () => {
  const state = stateDir()
  const settings = {
    version: 3 as const,
    addendum: { start: 'Prepare context.', end: 'Publish the handoff.', stop: 'Explain the stop.' },
    storage: { mode: 'kory' as const, instructions: '' },
    commands: { start: [], end: [], stop: [] }
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
  expect(() => writeSessionSkills(state, addenda())).toThrow('symbolic link')
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

test('throws a stat failure other than a missing file instead of reading it as absent', () => {
  const state = stateDir()
  const unstatable = join(state, 'a' + String.fromCharCode(0) + 'b')

  expect(() => readSessionSkills(unstatable)).toThrow()
})

test('distinguishes a non-regular file from a symbolic link', () => {
  const state = stateDir()
  mkdirSync(sessionSkillsPath(state))

  expect(() => readSessionSkills(state)).toThrow('Session skills settings is not a regular file')
})

test('names the oversized addendum that is rejected before persistence', () => {
  const state = stateDir()
  const settings = {
    version: 3 as const,
    addendum: { start: 'x'.repeat(16 * 1024 + 1), end: '', stop: '' },
    storage: { mode: 'kory' as const, instructions: '' },
    commands: { start: [], end: [], stop: [] }
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
  writeSessionSkills(state, addenda('A', 'B', 'C'))

  expect(readdirSync(state).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

test('reads a later persisted value without retaining a prior snapshot', () => {
  const state = stateDir()
  writeSessionSkills(state, addenda('first'))
  expect(readSessionSkills(state).addendum.start).toBe('first')

  writeSessionSkills(state, addenda('second'))
  expect(readSessionSkills(state).addendum.start).toBe('second')
})

test('reads an externally replaced settings document on the next access', () => {
  const state = stateDir()
  writeSessionSkills(state, addenda('first'))
  expect(readSessionSkills(state).addendum.start).toBe('first')
  writeFileSync(sessionSkillsPath(state), JSON.stringify({ version: 1, addendum: { start: 'second', end: '', stop: '' } }))

  expect(readSessionSkills(state).addendum.start).toBe('second')
})

test('does not derive the settings file from the working directory', () => {
  const state = stateDir()
  const cwd = process.cwd()

  expect(sessionSkillsPath(state)).toBe(join(state, 'session-skills.json'))
  expect(sessionSkillsPath(state)).not.toBe(join(cwd, 'session-skills.json'))
})

const addenda = (start = '', end = '', stop = '') => ({
  version: 3 as const,
  addendum: { start, end, stop },
  storage: { mode: 'kory' as const, instructions: '' },
  commands: { start: [] as string[], end: [] as string[], stop: [] as string[] }
})

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

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function registerChannels(state: string): Map<string, RegisteredHandler> {
  const registered = new Map<string, RegisteredHandler>()
  registerSessionSkillsChannels((channel, fn) => registered.set(channel, fn), state)
  return registered
}

test('registers skills:get and skills:set on the state directory it is given', () => {
  const state = stateDir()
  const other = stateDir()
  const registered = registerChannels(state)
  const value = addenda('wired')

  expect([...registered.keys()].sort()).toEqual(['skills:get', 'skills:set'])
  expect(registered.get('skills:set')!({ sender: 'ipc-event' }, value)).toEqual(value)
  expect(readSessionSkills(state)).toEqual(value)
  expect(registered.get('skills:get')!({ sender: 'ipc-event' })).toEqual(value)
  expect(existsSync(sessionSkillsPath(other))).toBe(false)
  expect(readdirSync(state).filter((name) => name !== 'session-skills.json')).toEqual([])
})

test('skills:get and skills:set ignore trailing arguments and refuse an invalid payload', () => {
  const state = stateDir()
  const hostile = stateDir()
  const registered = registerChannels(state)

  registered.get('skills:get')!({}, addenda('from-get'), hostile)
  expect(existsSync(sessionSkillsPath(state))).toBe(false)
  expect(() => registered.get('skills:set')!({}, { version: 1, addendum: {}, commands: [] }, hostile)).toThrow('Invalid session skills settings')
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

test('rejects unknown storage keys on read and write', () => {
  const state = stateDir()
  const extra = { version: 2, addendum: { start: '', end: '', stop: '' }, storage: { mode: 'kory', instructions: '', extra: '' } }

  expect(() => writeSessionSkills(state, extra)).toThrow('Invalid session skills settings')
  writeFileSync(sessionSkillsPath(state), JSON.stringify(extra))
  expect(() => readSessionSkills(state)).toThrow('Invalid session skills settings')
})

test('rejects a non-numeric version', () => {
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

// index.ts and ipc.ts import electron, so neither can be loaded here: the one
// line each of them contributes to the settings wiring is pinned as text.
test('the Deck must write skills where the helper reads them', () => {
  const main = join(import.meta.dir, '..', 'desktop', 'src', 'main')
  const wiring = 'the Deck must write skills where the helper reads them'
  const index = readFileSync(join(main, 'index.ts'), 'utf8')
  const ipc = readFileSync(join(main, 'ipc.ts'), 'utf8')
  const head = '}: IpcDeps): void {'
  const start = ipc.indexOf(head)
  if (start === -1) throw new Error(`ipc.ts: missing ${head}`)
  const registerIpcBody = extractBracedBody(ipc, start + head.length - 1, true)

  expect(index.split('sessionSkillsDir: sessionSkillsStateDir,').length - 1, `${wiring}: registerIpc receives the handoff state directory`).toBe(1)
  expect(registerIpcBody.split('registerSessionSkillsChannels(regHandle, sessionSkillsDir)').length - 1, `${wiring}: registerIpc registers the channels on that directory`).toBe(1)
  expect(registerIpcBody.split('registerSkillSequenceChannels(regHandle, service)').length - 1, `${wiring}: registerIpc registers the Skills sequence channels`).toBe(1)
})

const withCommands = (commands: { start?: string[]; end?: string[]; stop?: string[] }) => ({
  ...addenda('a', 'b', 'c'),
  commands: { start: [] as string[], end: [] as string[], stop: [] as string[], ...commands }
})

test('lifts a v2 file on disk to v3 with empty command lists and keeps its addendum and storage', () => {
  const state = stateDir()
  const storage = { mode: 'custom' as const, instructions: 'Keep notes in docs/.' }
  writeFileSync(sessionSkillsPath(state), JSON.stringify({ version: 2, addendum: { start: 'S', end: 'E', stop: 'P' }, storage }))

  expect(readSessionSkills(state)).toEqual({
    version: 3,
    addendum: { start: 'S', end: 'E', stop: 'P' },
    storage,
    commands: { start: [], end: [], stop: [] }
  })
})

test('lifts a v1 file through v2 to v3 in one read', () => {
  const state = stateDir()
  writeFileSync(sessionSkillsPath(state), JSON.stringify({ version: 1, addendum: { start: 'S', end: '', stop: '' } }))

  const read = readSessionSkills(state)
  expect(read.version).toBe(3)
  expect(read.storage).toEqual({ mode: 'kory', instructions: '' })
  expect(read.commands).toEqual({ start: [], end: [], stop: [] })
})

test('persists configured command lines for each moment and reads them back unchanged', () => {
  const state = stateDir()
  const value = withCommands({ start: ['/kleos-session-start'], end: ['/compact', '/review-notes today'], stop: ['/wrap-up'] })

  expect(writeSessionSkills(state, value)).toEqual(value)
  expect(JSON.parse(readFileSync(sessionSkillsPath(state), 'utf8')).commands).toEqual(value.commands)
  expect(readSessionSkills(state)).toEqual(value)
})

test('a v2 or v1 document carrying commands is refused, not lifted', () => {
  const state = stateDir()
  const file = sessionSkillsPath(state)
  const storage = { mode: 'kory', instructions: '' }
  for (const content of [
    { version: 2, addendum: { start: '', end: '', stop: '' }, storage, commands: { start: [], end: [], stop: [] } },
    { version: 1, addendum: { start: '', end: '', stop: '' }, commands: { start: [], end: [], stop: [] } }
  ]) {
    writeFileSync(file, JSON.stringify(content))
    expect(() => readSessionSkills(state)).toThrow('Invalid session skills settings')
  }
})

test('refuses a v3 document without commands, with an unknown top-level key, or with an unknown commands key', () => {
  const state = stateDir()
  const { commands: _commands, ...withoutCommands } = withCommands({})
  const documents = [
    withoutCommands,
    { ...withCommands({}), extra: true },
    { ...withCommands({}), commands: { start: [], end: [], stop: [], extra: [] } },
    { ...withCommands({}), commands: { start: [], end: [] } }
  ]

  for (const content of documents) {
    expect(() => writeSessionSkills(state, content)).toThrow('Invalid session skills settings')
    writeFileSync(sessionSkillsPath(state), JSON.stringify(content))
    expect(() => readSessionSkills(state)).toThrow('Invalid session skills settings')
  }
})

test('refuses a command list that is not an array of valid lines and names the moment and the line', () => {
  const state = stateDir()
  const refused: [unknown, string][] = [
    [{ start: 'not-an-array' }, 'Invalid session skills settings'],
    [{ end: ['/ok', 'no-slash'] }, 'Session skill command "end" line 2 is invalid (missing-slash)'],
    [{ stop: ['/a\nb'] }, 'Session skill command "stop" line 1 is invalid (control-character)'],
    [{ start: ['   '] }, 'Session skill command "start" line 1 is invalid (empty)'],
    [{ start: ['/'] }, 'Session skill command "start" line 1 is invalid (empty)'],
    [{ start: [42] }, 'Session skill command "start" line 1 is invalid (not-a-string)'],
    [{ end: ['/ok', '/Login'] }, 'Session skill command "end" line 2 is invalid (dialogue-command)']
  ]

  for (const [commands, message] of refused) {
    expect(() => writeSessionSkills(state, withCommands(commands as never)), message).toThrow(message)
    writeFileSync(sessionSkillsPath(state), JSON.stringify(withCommands(commands as never)))
    expect(() => readSessionSkills(state), message).toThrow(message)
  }
  expect(readdirSync(state)).toEqual(['session-skills.json'])
})

test('accepts a moment at exactly the line ceiling and refuses one line more', () => {
  const state = stateDir()
  const lines = Array.from({ length: 8 }, (_, index) => `/step-${index}`)

  expect(writeSessionSkills(state, withCommands({ start: lines })).commands.start).toEqual(lines)
  expect(() => writeSessionSkills(state, withCommands({ start: [...lines, '/step-8'] }))).toThrow('Session skill commands "start" has too many lines')
})

test('the Deck state directory that holds the skills settings comes from userData alone, whatever the cwd and the environment hold', () => {
  const userData = stateDir()
  const hostile = stateDir()
  const names = ['CLAUDE_PROJECT_DIR', 'DESK_PROJECT_DIR']
  const saved = names.map((name) => process.env[name])
  const cwd = process.cwd()
  for (const name of names) process.env[name] = hostile
  process.chdir(hostile)
  try {
    const dir = appStateDirOf(userData)

    expect(dir).toBe(join(userData, APP_STATE_SUBDIR))
    mkdirSync(dir, { recursive: true })
    writeSessionSkills(dir, addenda('global'))
    expect(readSessionSkills(dir).addendum.start).toBe('global')
    expect(readdirSync(hostile)).toEqual([])
  } finally {
    process.chdir(cwd)
    names.forEach((name, index) => {
      const value = saved[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
})

test('a v2 file whose custom storage has blank instructions is refused, not repaired to Kory storage', () => {
  const state = stateDir()
  const body = JSON.stringify({ version: 2, addendum: { start: 'S', end: '', stop: '' }, storage: { mode: 'custom', instructions: '   ' } })
  writeFileSync(sessionSkillsPath(state), body)

  expect(() => readSessionSkills(state)).toThrow('Invalid session skills settings')
  expect(readFileSync(sessionSkillsPath(state), 'utf8')).toBe(body)
})

test('rejects unknown storage keys in a v3 document on read and write', () => {
  const state = stateDir()
  const extra = { ...withCommands({}), storage: { mode: 'kory', instructions: '', extra: '' } }

  expect(() => writeSessionSkills(state, extra)).toThrow('Invalid session skills settings')
  writeFileSync(sessionSkillsPath(state), JSON.stringify(extra))
  expect(() => readSessionSkills(state)).toThrow('Invalid session skills settings')
})
