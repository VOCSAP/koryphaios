import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from './atomic-write'
import { reportError } from './log'

export const AVATAR_SETTINGS_FILE = 'avatar-settings.json'

export interface AvatarProjectSettings {
  optOut: boolean
}

interface AvatarSettingsData {
  autoAttach?: boolean
  projects: Record<string, AvatarProjectSettings>
}

const DEFAULT_PROJECT_SETTINGS: AvatarProjectSettings = { optOut: false }
const SETTINGS_LOCK_STALE_MS = 10_000
const SETTINGS_LOCK_ATTEMPTS = 20
const SETTINGS_LOCK_RETRY_MS = 50
const SETTINGS_LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4))

function emptyProjects(): Record<string, AvatarProjectSettings> {
  return Object.create(null) as Record<string, AvatarProjectSettings>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readAvatarSettings(file: string): AvatarSettingsData {
  try {
    if (!existsSync(file)) return { projects: emptyProjects() }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!isRecord(parsed)) return { projects: emptyProjects() }
    const projects = emptyProjects()
    if (isRecord(parsed.projects)) {
      for (const [projectKey, value] of Object.entries(parsed.projects)) {
        projects[projectKey] = { optOut: isRecord(value) && value.optOut === true }
      }
    }
    return { autoAttach: typeof parsed.autoAttach === 'boolean' ? parsed.autoAttach : undefined, projects }
  } catch (error) {
    reportError('avatar-settings', `settings unreadable (${file})`, error)
    return { projects: emptyProjects() }
  }
}

function settingsProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readAvatarSettingsLock(lockFile: string): { pid: number | null; at: number } | null {
  let raw: string
  let mtime: number
  try {
    raw = readFileSync(lockFile, 'utf8')
    mtime = statSync(lockFile).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      reportError('avatar-settings', `cannot inspect the lock file ${lockFile}`, error)
    }
    return null
  }
  if (raw.trim() === '') return { pid: null, at: mtime }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    reportError('avatar-settings', `${lockFile} is not valid JSON`, error)
    return { pid: null, at: mtime }
  }
  const record = isRecord(parsed) ? parsed : {}
  return {
    pid: typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0
      ? record.pid
      : null,
    at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : mtime
  }
}

function takeOverStaleAvatarSettingsLock(lockFile: string): boolean {
  const holder = readAvatarSettingsLock(lockFile)
  if (holder === null || Date.now() - holder.at < SETTINGS_LOCK_STALE_MS) return false
  if (holder.pid !== null && holder.pid !== process.pid && settingsProcessIsAlive(holder.pid)) return false
  try {
    rmSync(lockFile, { force: true })
    return true
  } catch (error) {
    reportError('avatar-settings', `cannot remove stale lock ${lockFile}`, error)
    return false
  }
}

function acquireAvatarSettingsLock(file: string): string {
  const lockFile = `${file}.lock`
  for (let attempt = 0; attempt < SETTINGS_LOCK_ATTEMPTS; attempt += 1) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 })
      return lockFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        reportError('avatar-settings', `cannot create lock ${lockFile}`, error)
        throw new Error('Avatar settings could not be locked')
      }
    }
    if (!takeOverStaleAvatarSettingsLock(lockFile)) {
      Atomics.wait(SETTINGS_LOCK_WAIT_ARRAY, 0, 0, SETTINGS_LOCK_RETRY_MS)
    }
  }
  reportError('avatar-settings', `${lockFile} remained locked after ${SETTINGS_LOCK_ATTEMPTS} attempts`)
  throw new Error('Avatar settings could not be locked')
}

function releaseAvatarSettingsLock(lockFile: string): void {
  try {
    rmSync(lockFile, { force: true })
  } catch (error) {
    reportError('avatar-settings', `cannot release lock ${lockFile}`, error)
  }
}

function updateAvatarSettings<T>(file: string, update: (data: AvatarSettingsData) => T): T {
  let lockFile: string | undefined
  try {
    mkdirSync(dirname(file), { recursive: true })
    lockFile = acquireAvatarSettingsLock(file)
    const data = readAvatarSettings(file)
    const result = update(data)
    writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    return result
  } catch (error) {
    reportError('avatar-settings', `cannot write ${file}`, error)
    throw new Error('Avatar settings could not be written')
  } finally {
    if (lockFile) releaseAvatarSettingsLock(lockFile)
  }
}

export function projectAvatarSettings(file: string, projectKey: string): AvatarProjectSettings {
  const projects = readAvatarSettings(file).projects
  return projects[projectKey] ?? { ...DEFAULT_PROJECT_SETTINGS }
}

export function writeAvatarAutoAttach(file: string, autoAttach: unknown): void {
  if (typeof autoAttach !== 'boolean') throw new Error('avatar.autoAttach must be a boolean')
  updateAvatarSettings(file, (data) => {
    data.autoAttach = autoAttach
  })
}

export function writeProjectAvatarSettings(
  file: string,
  projectKey: string,
  patch: Partial<AvatarProjectSettings>
): AvatarProjectSettings {
  if (patch.optOut !== undefined && typeof patch.optOut !== 'boolean') {
    throw new Error('avatar project optOut must be a boolean')
  }
  return updateAvatarSettings(file, (data) => {
    const current = data.projects[projectKey] ?? DEFAULT_PROJECT_SETTINGS
    const next = { optOut: patch.optOut ?? current.optOut }
    data.projects[projectKey] = next
    return next
  })
}

export function avatarAutoAttachEnabled(file: string, projectKey: string): boolean {
  const data = readAvatarSettings(file)
  return (data.autoAttach ?? true) && !data.projects[projectKey]?.optOut
}
