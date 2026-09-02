// Filesystem layer for team templates. Discovers, reads and writes template
// .json files in two locations:
//   - global: <globalConfigDir>/templates  (e.g. %APPDATA%/koryphaios/templates)
//   - local:  <projectDir>/.claude/claude-peers/templates
//
// Node builtins + relative imports only (no electron, no `@shared/*` alias) so
// it stays unit-testable under bun, like launch-config.ts. The pure validation /
// shaping lives in ../shared/template.ts.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { globalConfigDir } from './launch-config'
import { parseTemplate, type SessionTemplate } from '../shared/template'
import { reportError } from './log'

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
  return join(projectDir, '.claude', 'claude-peers', 'templates')
}

/**
 * Which allowed templates dir directly contains `path`, or null when it lives
 * outside both (M-SEC-9 containment). `template:read` / `template:apply` accept
 * a caller-supplied path (renderer, supervisor, paired phone), so an arbitrary
 * absolute path must be rejected before it is read/applied. 'local' = the
 * repo-shipped (untrusted) dir; 'global' = the operator's own app-state dir.
 * Mirrors the resolve-equality guard already used by `deleteTemplate`.
 */
export function templateSource(
  path: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): 'global' | 'local' | null {
  if (!path.toLowerCase().endsWith('.json')) return null
  const dir = resolve(dirname(path))
  if (dir === resolve(globalTemplatesDir(env))) return 'global'
  if (dir === resolve(localTemplatesDir(projectDir))) return 'local'
  return null
}

/**
 * Reads and validates a template file; a multi-lead file is normalized (first
 * wins) and the repair is reported via reportError rather than happening
 * silently.
 */
export function readTemplate(path: string): SessionTemplate | null {
  try {
    if (!existsSync(path)) return null
    const parsed = parseTemplate(JSON.parse(readFileSync(path, 'utf-8')))
    if (!parsed) return null
    if (parsed.demotedLeadNames.length > 0) {
      reportError(
        'template',
        `${path}: multiple sessions had lead: true, kept only the first ` +
          `(demoted: ${parsed.demotedLeadNames.join(', ')})`
      )
    }
    return parsed.template
  } catch {
    return null
  }
}

function listDir(dir: string, source: 'global' | 'local'): TemplateSummary[] {
  try {
    if (!existsSync(dir)) return []
    const out: TemplateSummary[] = []
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.json')) continue
      const path = join(dir, f)
      const tpl = readTemplate(path)
      if (!tpl) continue // skip malformed / non-template json
      out.push({
        path,
        name: tpl.name || f.replace(/\.json$/i, ''),
        source,
        sessionCount: tpl.sessions.length
      })
    }
    return out
  } catch {
    return []
  }
}

/** All templates from the global dir then the project-local dir. */
export function listTemplates(projectDir: string, env: NodeJS.ProcessEnv = process.env): TemplateSummary[] {
  return [
    ...listDir(globalTemplatesDir(env), 'global'),
    ...listDir(localTemplatesDir(projectDir), 'local')
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

/**
 * Delete a template .json file. Guarded: the path must be a `.json` that lives
 * directly in the global or project-local templates dir (defends against an
 * arbitrary path being passed through the IPC). Returns true if a file was
 * removed.
 */
export function deleteTemplate(
  path: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    if (!path.toLowerCase().endsWith('.json')) return false
    const allowedDirs = [
      resolve(globalTemplatesDir(env)),
      resolve(localTemplatesDir(projectDir))
    ]
    if (!allowedDirs.includes(resolve(dirname(path)))) return false
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}
