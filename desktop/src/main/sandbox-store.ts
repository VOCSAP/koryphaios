// Sandbox mode (PLAN-SANDBOX SBX2): operator-side persistence of the per-
// project sandbox settings. Deliberately NOT an AppConfig field (the app-wide
// config.json is shared by every project window and a bare boolean would leak
// the trust decision across repos) and NEVER a repo file (hostile input #1:
// enabling the sandbox is an operator decision) — the store lives under the
// app state dir, keyed by computeDeckProjectKey(projectDir), exactly like
// launch-approvals.json. Node builtins only: bun-testable with a tmp file.

import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write'
import { DEFAULT_SANDBOX_PORTS, SANDBOX_IMAGE_DEFAULT } from './sandbox-command'

export interface SandboxProjectSettings {
  enabled: boolean
  /** Dev-server ports published at container create (rebuild to apply changes). */
  ports: number[]
}

export interface SandboxStoreData {
  /** Image every sandbox container is created from (operator-editable). */
  image: string
  projects: Record<string, SandboxProjectSettings>
}

const DEFAULT_SETTINGS: SandboxProjectSettings = {
  enabled: false,
  ports: DEFAULT_SANDBOX_PORTS
}

function sanePorts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SANDBOX_PORTS]
  const ports = raw.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536)
  return ports.length > 0 ? [...new Set(ports)] : [...DEFAULT_SANDBOX_PORTS]
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
          if (!value || typeof value !== 'object') continue
          out.projects[key] = {
            enabled: (value as SandboxProjectSettings).enabled === true,
            ports: sanePorts((value as SandboxProjectSettings).ports)
          }
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

/** Persist one project's enabled flag (atomic — the file also carries other projects). */
export function writeSandboxEnabled(file: string, projectKey: string, enabled: boolean): void {
  const data = readSandboxStore(file)
  const prev = data.projects[projectKey] ?? { ...DEFAULT_SETTINGS }
  data.projects[projectKey] = { ...prev, enabled }
  writeFileAtomic(file, JSON.stringify(data, null, 2))
}
