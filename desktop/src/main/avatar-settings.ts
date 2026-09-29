import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from './atomic-write'
import { FileLockError, withFileLock } from './file-lock'
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

function updateAvatarSettings<T>(file: string, update: (data: AvatarSettingsData) => T): T {
  try {
    mkdirSync(dirname(file), { recursive: true })
    return withFileLock(file, 'avatar-settings', () => {
      const data = readAvatarSettings(file)
      const result = update(data)
      writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
      return result
    })
  } catch (error) {
    reportError('avatar-settings', `cannot write ${file}`, error)
    throw new Error(
      error instanceof FileLockError
        ? `Avatar settings could not be written: ${error.message}`
        : 'Avatar settings could not be written'
    )
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
