import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionSkillSettings } from '../shared/types'

const SESSION_SKILLS_FILE = 'session-skills.json'
const MAX_ADDENDUM_BYTES = 16 * 1024
const MAX_DOCUMENT_BYTES = 64 * 1024

export function sessionSkillsPath(stateDir: string): string {
  return join(stateDir, SESSION_SKILLS_FILE)
}

function emptySessionSkills(): SessionSkillSettings {
  return { version: 1, addendum: { start: '', end: '', stop: '' } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function validateSessionSkills(value: unknown): asserts value is SessionSkillSettings {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'addendum']) || value.version !== 1 || !isRecord(value.addendum) || !hasExactKeys(value.addendum, ['start', 'end', 'stop'])) {
    throw new Error('Invalid session skills settings')
  }
  for (const moment of ['start', 'end', 'stop'] as const) {
    const addendum = value.addendum[moment]
    if (typeof addendum !== 'string') throw new Error('Invalid session skills settings')
    if (Buffer.byteLength(addendum, 'utf8') > MAX_ADDENDUM_BYTES) throw new Error(`Session skill addendum "${moment}" is too large`)
  }
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
