import { lstatSync } from 'node:fs'
import { join } from 'node:path'

export const PROJECT_DIR_NAME = 'koryphaios'
export const LEGACY_PROJECT_DIR_NAME = 'claude-peers'

export type ProjectEntrySource = 'koryphaios' | 'legacy'

export interface ProjectEntry {
  path: string
  /** `path` relative to the project dir. */
  rel: string
  source: ProjectEntrySource
}

const FOLDERS: readonly (readonly [ProjectEntrySource, string])[] = [
  ['koryphaios', PROJECT_DIR_NAME],
  ['legacy', LEGACY_PROJECT_DIR_NAME]
]

export function projectEntryCandidates(projectDir: string, ...segments: string[]): ProjectEntry[] {
  return FOLDERS.map(([source, folder]) => {
    const rel = join('.claude', folder, ...segments)
    return { path: join(projectDir, rel), rel, source }
  })
}

// lstat, not stat: a dangling symlink in the new folder is elected, then refused by the reader, never skipped for the old file.
export function electEntry(candidates: readonly ProjectEntry[], examine: (path: string) => unknown): ProjectEntry | null {
  for (const candidate of candidates) {
    try {
      examine(candidate.path)
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return candidate
    }
  }
  return null
}

export function electProjectEntry(projectDir: string, ...segments: string[]): ProjectEntry | null {
  return electEntry(projectEntryCandidates(projectDir, ...segments), lstatSync)
}
