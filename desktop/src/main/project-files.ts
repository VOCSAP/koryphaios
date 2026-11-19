import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { reportError } from './log'
import { LEGACY_PROJECT_DIR_NAME, PROJECT_DIR_NAME } from '../shared/project-dirs'
import { canonicalPath } from './worktree-service'

export { LEGACY_PROJECT_DIR_NAME, PROJECT_DIR_NAME }
export const MAX_TRACED_FILES = 64
export const MAX_TRACED_PER_SCAN = 8

export type ProjectFileSource = 'koryphaios' | 'legacy'

export interface ProjectFileCandidate {
  path: string
  source: ProjectFileSource
}

export const PROJECT_SOURCES: readonly ProjectFileSource[] = ['koryphaios', 'legacy']

export interface WorkspaceRef {
  readonly projectDir: string
  readonly id: string
  readonly source: ProjectFileSource
}

export type ProjectFileReport = (scope: string, message: string, error?: unknown) => void

/** Two refs name the same stored workspace only when project, folder and id all agree. */
export function sameWorkspaceRef(a: WorkspaceRef, b: WorkspaceRef): boolean {
  return a.id === b.id && a.source === b.source && canonicalPath(a.projectDir) === canonicalPath(b.projectDir)
}

export function projectRootPath(projectDir: string, source: ProjectFileSource): string {
  return join(projectDir, '.claude', source === 'koryphaios' ? PROJECT_DIR_NAME : LEGACY_PROJECT_DIR_NAME)
}

export function projectCreationPath(projectDir: string, ...segments: string[]): string {
  return join(projectRootPath(projectDir, 'koryphaios'), ...segments)
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

function firstSeen(key: string, signature: string): boolean {
  if (traced.get(key) === signature) return false
  traced.set(key, signature)
  if (traced.size > MAX_TRACED_FILES) traced.delete(traced.keys().next().value as string)
  return true
}

export function traceInvalidFileOnce(file: string, error: unknown, report: ProjectFileReport = reportError): void {
  if (!firstSeen(canonicalPath(file), signatureOf(file))) return
  report('project-files', `Ignoring the invalid file ${file}`, error)
}

export interface TraceScan {
  invalid(file: string, error: unknown): void
  done(): void
}

// A scan that reads more invalid files than the FIFO above holds would evict each entry just before reading it again.
// Feed it the files in a stable order: the summary signature depends on it.
export function traceScan(dir: string, report: ProjectFileReport = reportError): TraceScan {
  let single = 0
  let rest = 0
  const digest = createHash('sha256')
  return {
    invalid(file, error) {
      if (single < MAX_TRACED_PER_SCAN) {
        single++
        traceInvalidFileOnce(file, error, report)
        return
      }
      rest++
      digest.update(`${canonicalPath(file)}:${signatureOf(file)}\n`)
    },
    done() {
      if (rest === 0) return
      if (!firstSeen(`${canonicalPath(dir)}#rest`, `${rest}:${digest.digest('hex')}`)) return
      report('project-files', `${rest} more invalid files in ${dir}`)
    }
  }
}
