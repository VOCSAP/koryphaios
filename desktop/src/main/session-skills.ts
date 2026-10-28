import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionSkillAddendum, SessionSkillSettings } from '../shared/types'
import { SESSION_SKILL_TEXT_MAX_BYTES as MAX_ADDENDUM_BYTES } from '../shared/session-skill-limits'

const SESSION_SKILLS_FILE = 'session-skills.json'
const MAX_DOCUMENT_BYTES = 64 * 1024

export function sessionSkillsPath(stateDir: string): string {
  return join(stateDir, SESSION_SKILLS_FILE)
}

function emptySessionSkills(): SessionSkillSettings {
  return { version: 2, addendum: { start: '', end: '', stop: '' }, storage: { mode: 'kory', instructions: '' } }
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

function legacySessionSkills(value: unknown): SessionSkillSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'addendum']) || value.version !== 1) return null
  validateAddendum(value.addendum)
  return { version: 2, addendum: value.addendum, storage: { mode: 'kory', instructions: '' } }
}

function validateSessionSkills(value: unknown): asserts value is SessionSkillSettings {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'addendum', 'storage']) || value.version !== 2) throw new Error('Invalid session skills settings')
  validateAddendum(value.addendum)
  if (!isRecord(value.storage) || !hasExactKeys(value.storage, ['mode', 'instructions']) || (value.storage.mode !== 'kory' && value.storage.mode !== 'custom') || typeof value.storage.instructions !== 'string') {
    throw new Error('Invalid session skills settings')
  }
  if (Buffer.byteLength(value.storage.instructions, 'utf8') > MAX_ADDENDUM_BYTES) throw new Error('Session skill storage instructions is too large')
  if (value.storage.mode === 'custom' && value.storage.instructions.trim() === '') throw new Error('Invalid session skills settings')
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
