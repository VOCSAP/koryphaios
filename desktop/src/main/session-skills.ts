import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionSkillAddendum, SessionSkillCommands, SessionSkillSettings } from '../shared/types'
import { SESSION_COMMAND_LIMITS, SESSION_SKILL_TEXT_MAX_BYTES as MAX_ADDENDUM_BYTES } from '../shared/session-skill-limits'
import { checkConfiguredLine } from '../shared/session-command-line'

const SESSION_SKILLS_FILE = 'session-skills.json'
const MAX_DOCUMENT_BYTES = 64 * 1024

export function sessionSkillsPath(stateDir: string): string {
  return join(stateDir, SESSION_SKILLS_FILE)
}

function emptySessionSkills(): SessionSkillSettings {
  return {
    version: 3,
    addendum: { start: '', end: '', stop: '' },
    storage: { mode: 'kory', instructions: '' },
    commands: { start: [], end: [], stop: [] }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function validateAddendum(value: unknown): asserts value is SessionSkillAddendum {
  if (!isRecord(value) || !hasExactKeys(value, ['start', 'end', 'stop'])) throw new Error('Invalid session skills settings')
  for (const moment of ['start', 'end', 'stop'] as const) {
    const addendum = value[moment]
    if (typeof addendum !== 'string') throw new Error('Invalid session skills settings')
    if (Buffer.byteLength(addendum, 'utf8') > MAX_ADDENDUM_BYTES) throw new Error(`Session skill addendum "${moment}" is too large`)
  }
}

function validateStorage(value: unknown): asserts value is SessionSkillSettings['storage'] {
  if (!isRecord(value) || !hasExactKeys(value, ['mode', 'instructions']) || (value.mode !== 'kory' && value.mode !== 'custom') || typeof value.instructions !== 'string') {
    throw new Error('Invalid session skills settings')
  }
  if (Buffer.byteLength(value.instructions, 'utf8') > MAX_ADDENDUM_BYTES) throw new Error('Session skill storage instructions is too large')
  if (value.mode === 'custom' && value.instructions.trim() === '') throw new Error('Invalid session skills settings')
}

function validateCommands(value: unknown): asserts value is SessionSkillCommands {
  if (!isRecord(value) || !hasExactKeys(value, ['start', 'end', 'stop'])) throw new Error('Invalid session skills settings')
  for (const moment of ['start', 'end', 'stop'] as const) {
    const lines = value[moment]
    if (!Array.isArray(lines)) throw new Error('Invalid session skills settings')
    if (lines.length > SESSION_COMMAND_LIMITS.linesPerMoment) throw new Error(`Session skill commands "${moment}" has too many lines`)
    lines.forEach((line, index) => {
      const checked = checkConfiguredLine(line)
      if (!checked.ok) throw new Error(`Session skill command "${moment}" line ${index + 1} is invalid (${checked.reason})`)
    })
  }
}

type SessionSkillsV2 = Omit<SessionSkillSettings, 'version' | 'commands'> & { version: 2 }

function legacySessionSkillsV1(value: unknown): SessionSkillsV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'addendum']) || value.version !== 1) return null
  validateAddendum(value.addendum)
  return { version: 2, addendum: value.addendum, storage: { mode: 'kory', instructions: '' } }
}

// Chain v1 -> v2 -> v3: a document older than the current schema is lifted, never repaired.
function legacySessionSkills(value: unknown): SessionSkillSettings | null {
  const v2 = legacySessionSkillsV1(value) ?? value
  if (!isRecord(v2) || !hasExactKeys(v2, ['version', 'addendum', 'storage']) || v2.version !== 2) return null
  validateAddendum(v2.addendum)
  validateStorage(v2.storage)
  return { version: 3, addendum: v2.addendum, storage: v2.storage, commands: { start: [], end: [], stop: [] } }
}

function validateSessionSkills(value: unknown): asserts value is SessionSkillSettings {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'addendum', 'storage', 'commands']) || value.version !== 3) throw new Error('Invalid session skills settings')
  validateAddendum(value.addendum)
  validateStorage(value.storage)
  validateCommands(value.commands)
}

function serializeSessionSkills(value: SessionSkillSettings): string {
  const content = JSON.stringify(value)
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('Session skills settings is too large')
  return content
}

function existingSessionSkillsFile(file: string) {
  try {
    return lstatSync(file)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

export function readSessionSkills(stateDir: string): SessionSkillSettings {
  const file = sessionSkillsPath(stateDir)
  const stat = existingSessionSkillsFile(file)
  if (!stat) return emptySessionSkills()
  if (stat.isSymbolicLink()) throw new Error('Session skills settings is a symbolic link')
  if (!stat.isFile()) throw new Error('Session skills settings is not a regular file')
  if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('Session skills settings is too large')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('Invalid session skills settings')
  }
  const legacy = legacySessionSkills(parsed)
  if (legacy) return legacy
  validateSessionSkills(parsed)
  return parsed
}

export function writeSessionSkills(stateDir: string, settings: unknown): SessionSkillSettings {
  validateSessionSkills(settings)
  const content = serializeSessionSkills(settings)
  const file = sessionSkillsPath(stateDir)
  const existing = existingSessionSkillsFile(file)
  if (existing?.isSymbolicLink()) throw new Error('Session skills settings is a symbolic link')
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return settings
}

export function sessionSkillsHandlers(stateDir: string) {
  return {
    get: (..._args: unknown[]) => readSessionSkills(stateDir),
    set: (settings: unknown, ..._args: unknown[]) => writeSessionSkills(stateDir, settings)
  }
}

export function registerSessionSkillsChannels(
  regHandle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void,
  stateDir: string
): void {
  const handlers = sessionSkillsHandlers(stateDir)
  regHandle('skills:get', (_e, ...args) => handlers.get(...args))
  regHandle('skills:set', (_e, value, ...args) => handlers.set(value, ...args))
}
