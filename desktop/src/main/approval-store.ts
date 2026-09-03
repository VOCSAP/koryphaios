// Deliberately not an AppConfig field and not in the repository: this decides
// whether an agent's blocking prompts reach a phone, an operator decision,
// keyed by project_key like sandbox-store.ts.
// A project can only restrict what the global switch allows; it can never
// enable the feature on its own.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from './atomic-write'
import { reportError } from './log'

export interface ApprovalProjectSettings {
  /** Operator opted this project OUT of remote approvals. */
  optOut: boolean
}

interface ApprovalStoreData {
  projects: Record<string, ApprovalProjectSettings>
}

const DEFAULT_SETTINGS: ApprovalProjectSettings = { optOut: false }

function readStore(file: string): ApprovalStoreData {
  try {
    if (!existsSync(file)) return { projects: {} }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ApprovalStoreData>
    return { projects: parsed?.projects && typeof parsed.projects === 'object' ? parsed.projects : {} }
  } catch (e) {
    // A hand-edited or truncated file must not disable the feature silently.
    reportError('approvals', `settings unreadable (${file}) — using defaults`, e)
    return { projects: {} }
  }
}

export function projectApprovalSettings(file: string, projectKey: string): ApprovalProjectSettings {
  return readStore(file).projects[projectKey] ?? { ...DEFAULT_SETTINGS }
}

export function writeProjectApprovalSettings(
  file: string,
  projectKey: string,
  patch: Partial<ApprovalProjectSettings>
): ApprovalProjectSettings {
  const data = readStore(file)
  const next = { ...(data.projects[projectKey] ?? DEFAULT_SETTINGS), ...patch }
  data.projects[projectKey] = next
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileAtomic(file, JSON.stringify(data, null, 2))
  return next
}

/**
 * The single place that answers "should this session produce approvals?".
 *
 * Global off wins over everything: a project cannot opt IN. That asymmetry is
 * the whole point — turning the feature off globally must be a hard stop the
 * operator can trust, not a default a project file can override.
 */
export function remoteApprovalsEnabled(opts: {
  globalEnabled: boolean
  file: string
  projectKey: string
}): boolean {
  if (!opts.globalEnabled) return false
  return !projectApprovalSettings(opts.file, opts.projectKey).optOut
}
