import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { globalConfigDir } from './launch-config'
import { parseTemplate, type SessionTemplate } from '../shared/template'
import { reportError } from './log'
import {
  PROJECT_SOURCES,
  isAbsentFileError,
  projectCreationPath,
  projectRootPath,
  traceInvalidFileOnce,
  traceScan
} from './project-files'
import type { CallerAttendance } from './workspace-service'

export interface TemplateSummary {
  /** Absolute path of the .json file; doubles as the id. */
  path: string
  /** Display name (template's own `name`, else the file basename). */
  name: string
  source: 'global' | 'local'
  sessionCount: number
}

export function globalTemplatesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), 'templates')
}

export function localTemplatesDir(projectDir: string): string {
  return projectCreationPath(projectDir, 'templates')
}

export function localTemplateDirs(projectDir: string): string[] {
  return PROJECT_SOURCES.map((source) => join(projectRootPath(projectDir, source), 'templates'))
}

/**
 * Target dir of a template write. The global dir is trusted (applying a template
 * from it asks no shell-field approval), so only the Deck window may write there;
 * any other caller throws.
 */
export function templateWriteDir(
  projectDir: string,
  local: boolean,
  attendance: CallerAttendance,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (local) return localTemplatesDir(projectDir)
  if (attendance !== 'attended') {
    throw new Error(
      'refused: a paired device cannot save a template to the global folder -- save it in this project, or use the Deck on the PC'
    )
  }
  return globalTemplatesDir(env)
}

// Both local dirs hold repo-shipped templates, so both classify as 'local' and take the approval gate.
export function templateSource(
  path: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): 'global' | 'local' | null {
  if (!path.toLowerCase().endsWith('.json')) return null
  const dir = resolve(dirname(path))
  if (dir === resolve(globalTemplatesDir(env))) return 'global'
  if (localTemplateDirs(projectDir).some((local) => dir === resolve(local))) return 'local'
  return null
}

function readTemplateFile(path: string, onInvalid: (error: unknown) => void): SessionTemplate | null {
  try {
    const parsed = parseTemplate(JSON.parse(readFileSync(path, 'utf-8')))
    if (!parsed) throw new Error('the file is not a valid template')
    if (parsed.demotedLeadNames.length > 0) {
      reportError(
        'template',
        `${path}: multiple sessions had lead: true, kept only the first ` +
          `(demoted: ${parsed.demotedLeadNames.join(', ')})`
      )
    }
    return parsed.template
  } catch (error) {
    if (!isAbsentFileError(error)) onInvalid(error)
    return null
  }
}

export function readTemplate(path: string): SessionTemplate | null {
  return readTemplateFile(path, (error) => traceInvalidFileOnce(path, error))
}

function listDir(
  dir: string,
  source: 'global' | 'local',
  readDir: (dir: string) => string[]
): TemplateSummary[] {
  try {
    const scan = traceScan(dir)
    const out: TemplateSummary[] = []
    for (const f of [...readDir(dir)].sort()) {
      if (!f.toLowerCase().endsWith('.json')) continue
      const path = join(dir, f)
      const tpl = readTemplateFile(path, (error) => scan.invalid(path, error))
      if (!tpl) continue
      out.push({
        path,
        name: tpl.name || f.replace(/\.json$/i, ''),
        source,
        sessionCount: tpl.sessions.length
      })
    }
    scan.done()
    return out
  } catch (error) {
    if (!isAbsentFileError(error)) traceInvalidFileOnce(dir, error)
    return []
  }
}

export function listTemplates(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  readDir: (dir: string) => string[] = readdirSync
): TemplateSummary[] {
  return [
    ...listDir(globalTemplatesDir(env), 'global', readDir),
    ...localTemplateDirs(projectDir).flatMap((dir) => listDir(dir, 'local', readDir))
  ]
}

/** Sanitize a label into a safe, predictable file base name. */
function safeBase(name: string): string {
  const b = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return b || 'template'
}

/**
 * Refuses (throws) a template carrying more than one lead: true session. Single
 * filesystem sink for all production writers, so the check closes the gap by
 * construction instead of enumerating call sites.
 * template:write already demotes down to one lead before reaching here via
 * parseTemplate, so this only fires as a live guard on the two routes that
 * build a template straight from live session defs.
 */
export function writeTemplate(dir: string, name: string, tpl: SessionTemplate): string {
  const leadNames = tpl.sessions.filter((s) => s.lead).map((s) => s.name)
  if (leadNames.length > 1) {
    throw new Error(
      `template has multiple leads (${leadNames.join(', ')}); at most one session may carry lead: true`
    )
  }
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${safeBase(name)}.json`)
  writeFileSync(file, JSON.stringify(tpl, null, 2), 'utf-8')
  return file
}

/** Template write of an agent-reachable caller: always the project dir, the global dir is refused. */
export function writeAgentTemplate(
  projectDir: string,
  local: boolean,
  name: string,
  tpl: SessionTemplate,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!local) {
    throw new Error(
      'refused: an agent saves templates in the project only; the operator saves global ones from the Deck'
    )
  }
  return writeTemplate(templateWriteDir(projectDir, local, 'unattended', env), name, tpl)
}

export function deleteTemplate(
  path: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    if (!path.toLowerCase().endsWith('.json')) return false
    const allowedDirs = [globalTemplatesDir(env), ...localTemplateDirs(projectDir)].map((dir) => resolve(dir))
    if (!allowedDirs.includes(resolve(dirname(path)))) return false
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}
