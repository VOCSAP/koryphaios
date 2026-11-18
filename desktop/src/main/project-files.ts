import { statSync } from 'node:fs'
import { join } from 'node:path'
import { reportError } from './log'
import { canonicalPath } from './worktree-service'

export const PROJECT_DIR_NAME = 'koryphaios'
export const LEGACY_PROJECT_DIR_NAME = 'claude-peers'
export const MAX_TRACED_FILES = 64

export type ProjectFileSource = 'koryphaios' | 'legacy'

export interface ProjectFileCandidate {
  path: string
  source: ProjectFileSource
}

export type ProjectFileReport = (scope: string, message: string, error?: unknown) => void

export function projectCreationPath(projectDir: string, ...segments: string[]): string {
  return join(projectDir, '.claude', PROJECT_DIR_NAME, ...segments)
}

export function isAbsentFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function existsOnDisk(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    return !isAbsentFileError(error)
  }
}

/** Selection is by the FILE existing, never by its folder or its content. */
export function selectProjectFile(projectDir: string, ...segments: string[]): ProjectFileCandidate | null {
  const candidates: ProjectFileCandidate[] = [
    { path: projectCreationPath(projectDir, ...segments), source: 'koryphaios' },
    { path: join(projectDir, '.claude', LEGACY_PROJECT_DIR_NAME, ...segments), source: 'legacy' }
  ]
  return candidates.find((candidate) => existsOnDisk(candidate.path)) ?? null
}

const traced = new Map<string, string>()

function signatureOf(file: string): string {
  try {
    const stats = statSync(file)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return 'gone'
  }
}

export function traceInvalidFileOnce(file: string, error: unknown, report: ProjectFileReport = reportError): void {
  const key = canonicalPath(file)
  const signature = signatureOf(file)
  if (traced.get(key) === signature) return
  traced.set(key, signature)
  if (traced.size > MAX_TRACED_FILES) traced.delete(traced.keys().next().value as string)
  report('project-files', `Ignoring the invalid file ${file}`, error)
}
