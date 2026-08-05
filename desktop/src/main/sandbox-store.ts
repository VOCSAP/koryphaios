// Sandbox mode (PLAN-SANDBOX SBX2 + M3): operator-side persistence of the
// per-project sandbox settings. Deliberately NOT an AppConfig field (the
// app-wide config.json is shared by every project window and a bare boolean
// would leak the trust decision across repos) and NEVER a repo file (hostile
// input #1: enabling the sandbox, choosing the image and deciding which
// extra files get duplicated are all operator decisions) — the store
// lives under the app state dir, keyed by computeDeckProjectKey(projectDir),
// exactly like launch-approvals.json.
//
// Node builtins only: bun-testable with a tmp file.

import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write'
import { DEFAULT_SANDBOX_PORTS, SANDBOX_IMAGE_DEFAULT } from './sandbox-command'
import { isUnboundedGlob, SANDBOX_UNBOUNDED_GLOB_ERROR } from '../shared/types'

/**
 * `mount` — the real project dir is bind-mounted: agents edit the operator's
 * tree directly (the sandbox protects the REST of the machine).
 * `copy` — a throwaway host-side clone is mounted instead: the real tree is
 * untouchable and work leaves through git (M3).
 */
export type SandboxWorkMode = 'mount' | 'copy'

export interface SandboxProjectSettings {
  enabled: boolean
  mode: SandboxWorkMode
  /** Dev-server ports published at container create (rebuild to apply changes). */
  ports: number[]
  /**
   * Globs of project files copied on top of the clone in `copy` mode
   * (planning notes, local fixtures). NOT gitignore-aware: the candidate set
   * is the whole tree minus SKIP_DIRS (sandbox-copy.ts), so a tracked file
   * matching a glob is re-copied over the clone that already holds it.
   * A hard deny-list is applied last and beats any glob, but it is a
   * DENY-list: it stops known secret shapes, it cannot promise completeness.
   */
  copyIgnored: string[]
  /**
   * Carry the operator's global Claude config (CLAUDE.md, agents, skills,
   * plugins, settings.json) into the container at start. Default true; the
   * Docker view's projection card "Remove" opts out (and scrubs the
   * container), "Generate" opts back in.
   */
  projectConfig: boolean
}

export interface SandboxStoreData {
  /** Image every sandbox container is created from (operator-editable). */
  image: string
  projects: Record<string, SandboxProjectSettings>
}

const DEFAULT_SETTINGS: SandboxProjectSettings = {
  enabled: false,
  mode: 'mount',
  ports: DEFAULT_SANDBOX_PORTS,
  copyIgnored: [],
  projectConfig: true
}

const WORK_MODES: readonly SandboxWorkMode[] = ['mount', 'copy']

/**
 * Absent (never configured) => the defaults. An explicitly EMPTY list stays
 * empty: the defaults are the same for every project, so two projects with
 * sandboxes could not both start (the second fails on an already-allocated
 * port). Clearing the list is how the operator resolves that.
 */
function sanePorts(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [...DEFAULT_SANDBOX_PORTS]
  if (!Array.isArray(raw)) return [...DEFAULT_SANDBOX_PORTS]
  return [...new Set(raw.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536))]
}

function saneGlobs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [
    ...new Set(
      raw
        .filter((g): g is string => typeof g === 'string')
        .map((g) => g.trim())
        .filter((g) => g.length > 0 && g.length < 200)
    )
  ].slice(0, 64)
}

function saneSettings(raw: unknown): SandboxProjectSettings {
  const v = (raw ?? {}) as Partial<SandboxProjectSettings>
  return {
    enabled: v.enabled === true,
    mode: WORK_MODES.includes(v.mode as SandboxWorkMode) ? (v.mode as SandboxWorkMode) : 'mount',
    ports: sanePorts(v.ports),
    copyIgnored: saneGlobs(v.copyIgnored),
    // Opt-OUT flag: absent (pre-existing stores) means "keep projecting".
    projectConfig: v.projectConfig !== false
  }
}

/** Read the whole store; missing/malformed file ⇒ defaults (hand-editable JSON). */
export function readSandboxStore(file: string): SandboxStoreData {
  const out: SandboxStoreData = { image: SANDBOX_IMAGE_DEFAULT, projects: {} }
  try {
    if (!existsSync(file)) return out
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SandboxStoreData>
    if (raw && typeof raw === 'object') {
      if (typeof raw.image === 'string' && raw.image.trim()) out.image = raw.image.trim()
      if (raw.projects && typeof raw.projects === 'object') {
        for (const [key, value] of Object.entries(raw.projects)) {
          out.projects[key] = saneSettings(value)
        }
      }
    }
    return out
  } catch {
    // Malformed store = "everything default" — same forgiving contract as
    // launch-config readConfigFile; the caller journals lifecycle errors.
    return { image: SANDBOX_IMAGE_DEFAULT, projects: {} }
  }
}

export function projectSandboxSettings(file: string, projectKey: string): SandboxProjectSettings {
  return readSandboxStore(file).projects[projectKey] ?? { ...DEFAULT_SETTINGS }
}

/**
 * Patch one project's settings (atomic — the file also carries other
 * projects). Unknown/invalid fields are clamped by saneSettings.
 *
 * Unbounded globs (`*`, `**`, `**\/*`, `.*` — see isUnboundedGlob) are
 * rejected here, at the WRITE path only, fail-closed: the whole patch is
 * refused rather than silently dropping just the offending entries (card
 * 4b668844). Deliberately NOT enforced in saneGlobs/saneSettings, which also
 * back the READ path (readSandboxStore) — an already-persisted store that
 * predates this check keeps loading as-is; only a fresh save that still
 * contains one of these gets turned away.
 */
export function writeSandboxSettings(
  file: string,
  projectKey: string,
  patch: Partial<SandboxProjectSettings>
): SandboxProjectSettings {
  if (patch.copyIgnored !== undefined) {
    const rejected = saneGlobs(patch.copyIgnored).filter(isUnboundedGlob)
    if (rejected.length > 0) {
      throw new Error(`${SANDBOX_UNBOUNDED_GLOB_ERROR}${rejected.join(',')}`)
    }
  }
  const data = readSandboxStore(file)
  const prev = data.projects[projectKey] ?? { ...DEFAULT_SETTINGS }
  const next = saneSettings({ ...prev, ...patch })
  data.projects[projectKey] = next
  writeFileAtomic(file, JSON.stringify(data, null, 2))
  return next
}

/** Persist the image every container is created from (Settings/Docker view). */
export function writeSandboxImage(file: string, image: string): string {
  const data = readSandboxStore(file)
  data.image = image.trim() || SANDBOX_IMAGE_DEFAULT
  writeFileAtomic(file, JSON.stringify(data, null, 2))
  return data.image
}
