import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { globalConfigDir } from './launch-config'
import { parseTemplate, type SessionTemplate } from '../shared/template'
import { reportError } from './log'
import { canonicalPath } from './worktree-service'
import {
  PROJECT_SOURCES,
  entryPresent,
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

// A cloned repo can ship the templates folder, or a level above it, as a link: the nearest level that exists decides where a write or delete lands.
export function refuseEscapingFolder(dir: string, projectDir: string, noun: 'templates' | 'snippets' = 'templates'): void {
  const refuse = (why: string): never => {
    throw new Error(`refused: the ${noun} folder ${why}`)
  }
  const folder = resolve(dir)
  let existing = folder
  while (!entryPresent(existing) && dirname(existing) !== existing) existing = dirname(existing)
  let real: string
  try {
    real = realpathSync.native(existing)
  } catch (error) {
    return refuse(`cannot be resolved (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!join(real, relative(existing, folder)).startsWith(canonicalPath(projectDir) + sep)) {
    refuse('resolves outside the project')
  }
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
  if (local) {
    const dir = localTemplatesDir(projectDir)
    refuseEscapingFolder(dir, projectDir)
    return dir
  }
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
export function writeTemplateAt(file: string, tpl: SessionTemplate): string {
  const leadNames = tpl.sessions.filter((s) => s.lead).map((s) => s.name)
  if (leadNames.length > 1) {
    throw new Error(
      `template has multiple leads (${leadNames.join(', ')}); at most one session may carry lead: true`
    )
  }
  let leaf: Stats | null = null
  try {
    leaf = lstatSync(file)
  } catch (error) {
    if (!isAbsentFileError(error)) throw error
  }
  if (leaf?.isSymbolicLink()) throw new Error('refused: the template to write is a link')
  if (leaf && !leaf.isFile()) throw new Error('refused: the template to write is not a regular file')
  if (leaf && leaf.nlink > 1) throw new Error('refused: the template to write has other hard links')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(tpl, null, 2), 'utf-8')
  return file
}

export function writeTemplate(dir: string, name: string, tpl: SessionTemplate): string {
  return writeTemplateAt(join(dir, `${safeBase(name)}.json`), tpl)
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

// A cloned repo can ship a link as the template or as its folder; neither may lead a write or a delete out of the tree.
function refuseEscapingSource(
  sourcePath: string,
  origin: 'global' | 'local',
  projectDir: string,
  env: NodeJS.ProcessEnv
): void {
  const refuse = (why: string): never => {
    throw new Error(`refused: the template to save over ${why}`)
  }
  let leaf: Stats | null = null
  try {
    leaf = lstatSync(sourcePath)
  } catch (error) {
    if (!isAbsentFileError(error)) throw error
  }
  if (leaf?.isSymbolicLink()) refuse('is a link')
  if (leaf && !leaf.isFile()) refuse('is not a regular file')
  let folder: string
  try {
    folder = realpathSync.native(dirname(sourcePath))
  } catch (error) {
    return refuse(`has a folder that cannot be resolved (${error instanceof Error ? error.message : String(error)})`)
  }
  if (origin === 'global') {
    if (folder !== canonicalPath(globalTemplatesDir(env))) refuse('is in a folder that resolves elsewhere')
  } else if (!folder.startsWith(canonicalPath(projectDir) + sep)) {
    refuse('is in a folder that resolves outside the project')
  }
}

function existingTemplateError(wanted: string): Error {
  return new Error(`refused: a template named ${wanted || 'template'} already exists in this folder`)
}

export interface TemplateSaveTarget {
  file: string
  /** The file a rename leaves behind: delete it only once `file` is written. */
  removeAfter?: string
}

/**
 * Where a composer save lands. A template opened from a file is saved back to
 * that file, legacy folder included; only a changed name moves it. `sourcePath`
 * comes from the renderer, so a refused one throws instead of falling back to the
 * default dir. A `local` that differs from the source's scope is a copy into the
 * default dir of the other scope, and the source stays.
 */
export function templateSaveTarget(
  projectDir: string,
  local: boolean,
  attendance: CallerAttendance,
  name: string,
  sourcePath?: string,
  env: NodeJS.ProcessEnv = process.env
): TemplateSaveTarget {
  if (sourcePath === undefined) {
    return { file: join(templateWriteDir(projectDir, local, attendance, env), `${safeBase(name)}.json`) }
  }
  if (typeof sourcePath !== 'string') throw new Error('refused: the template to save over is not a path')
  const origin = templateSource(sourcePath, projectDir, env)
  if (!origin) throw new Error('refused: the template to save over is not in a template folder')
  const wanted = name.trim()
  if ((origin === 'local') !== local) {
    const copy = join(templateWriteDir(projectDir, local, attendance, env), `${safeBase(name)}.json`)
    if (entryPresent(copy)) throw existingTemplateError(wanted)
    return { file: copy }
  }
  if (origin === 'global') templateWriteDir(projectDir, false, attendance, env)
  refuseEscapingSource(sourcePath, origin, projectDir, env)
  const stored = readTemplate(sourcePath)?.name?.trim() || basename(sourcePath).replace(/\.json$/i, '')
  const target = join(dirname(sourcePath), `${safeBase(name)}.json`)
  // A case-only difference is the same file on a case-insensitive disk: removing it would delete the write.
  if (wanted === '' || wanted === stored || resolve(target).toLowerCase() === resolve(sourcePath).toLowerCase()) {
    return { file: sourcePath }
  }
  if (entryPresent(target)) throw existingTemplateError(wanted)
  return { file: target, removeAfter: sourcePath }
}

export function deleteTemplate(
  path: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    const source = templateSource(path, projectDir, env)
    if (!source) return false
    if (source === 'local') refuseEscapingFolder(dirname(path), projectDir)
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  } catch (error) {
    reportError('template', `delete ${String(JSON.stringify(path)).slice(0, 300)} failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
