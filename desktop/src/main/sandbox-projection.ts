// Sandbox mode (PLAN-SANDBOX M2): projection of the OPERATOR's Claude config
// into the sandbox container, so agents keep the global CLAUDE.md, agents,
// skills and plugins that shape the operator's workflow.
//
// SECURITY — why a COPY and never a mount (CLAUDE.md hostile input #5): the host
// `~/.claude` carries `settings.json`, whose hooks execute on the HOST in
// every non-sandboxed session. A read-write mount would let a compromised
// agent write a hook inside the sandbox and have it run outside — a clean
// sandbox escape. A read-only mount is not an option either (the CLI writes
// to ~/.claude in normal operation). So: an explicit ALLOW-LIST of entries is
// copied in at container start; the agent may wreck its copy, it dies with
// the container.
//
// The projection also honours an OVERLAY dir (`~/.claude/sandbox-overrides/`):
// a same-named entry there wins, which is how a Windows operator supplies
// Linux equivalents of PowerShell hooks.
//
// Node builtins only (no electron, no @shared alias) so it is bun-testable.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Overlay dir (inside the host ~/.claude) whose entries win over the base. */
export const SANDBOX_OVERRIDES_DIR = 'sandbox-overrides'

/**
 * The ONLY entries projected into the container. Everything else in
 * `~/.claude` stays on the host — in particular `.credentials.json` (the
 * container has its own, in the auth volume), `projects/` (transcripts),
 * `todos/`, `shell-snapshots/` and any telemetry/state file.
 */
export const PROJECTED_ENTRIES = ['CLAUDE.md', 'agents', 'skills', 'plugins', 'settings.json'] as const

export interface ProjectionEntry {
  /** Entry name as it lands in the container's ~/.claude. */
  name: string
  /** Absolute host path to copy. */
  hostPath: string
  /** True when it came from the sandbox-overrides overlay. */
  override: boolean
}

/**
 * Resolve what to copy: each allow-listed entry, preferring the overlay copy.
 * Missing entries are simply skipped (a fresh operator has no agents/ dir).
 */
export function planProjection(claudeHomeDir: string): ProjectionEntry[] {
  const overlayDir = join(claudeHomeDir, SANDBOX_OVERRIDES_DIR)
  const out: ProjectionEntry[] = []
  for (const name of PROJECTED_ENTRIES) {
    const overlay = join(overlayDir, name)
    if (existsSync(overlay)) {
      out.push({ name, hostPath: overlay, override: true })
      continue
    }
    const base = join(claudeHomeDir, name)
    if (existsSync(base)) out.push({ name, hostPath: base, override: false })
  }
  return out
}

/**
 * Hook commands that cannot work in the Linux container (PowerShell, cmd,
 * drive-letter paths, .ps1/.bat/.exe). Reported to the operator so they can
 * drop a Linux equivalent in sandbox-overrides/settings.json rather than
 * discovering the breakage inside an agent's terminal.
 */
export function detectHostOnlyHooks(settingsJson: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(settingsJson)
  } catch {
    return [] // unreadable settings: the copy still happens, nothing to warn about
  }
  const suspicious: string[] = []
  const HOST_ONLY = /(^|[\s"'=/\\])(powershell(\.exe)?|pwsh|cmd\.exe)([\s"']|$)|\.(ps1|bat|cmd|exe)([\s"']|$)|[A-Za-z]:[\\/]/i
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'command' && typeof value === 'string' && HOST_ONLY.test(value)) {
        suspicious.push(value.length > 120 ? `${value.slice(0, 117)}…` : value)
      } else {
        walk(value)
      }
    }
  }
  walk((parsed as { hooks?: unknown })?.hooks ?? parsed)
  return [...new Set(suspicious)]
}

/** Convenience: read settings.json (base or overlay) and list its host-only hooks. */
export function projectionHookWarnings(entries: ProjectionEntry[]): string[] {
  const settings = entries.find((e) => e.name === 'settings.json')
  if (!settings) return []
  try {
    return detectHostOnlyHooks(readFileSync(settings.hostPath, 'utf8'))
  } catch {
    return []
  }
}

/**
 * Summary line for the Docker view: what was projected, and whether an
 * overlay was involved. Pure so the wording stays testable.
 */
export function describeProjection(entries: ProjectionEntry[]): string {
  if (entries.length === 0) return 'none'
  return entries.map((e) => (e.override ? `${e.name} (override)` : e.name)).join(', ')
}

/**
 * List the overlay entries present but NOT allow-listed — a silent no-op the
 * operator would otherwise never notice (they dropped a file in
 * sandbox-overrides/ expecting it to travel).
 */
export function unknownOverrides(claudeHomeDir: string): string[] {
  const overlayDir = join(claudeHomeDir, SANDBOX_OVERRIDES_DIR)
  let names: string[]
  try {
    names = readdirSync(overlayDir)
  } catch {
    return []
  }
  return names.filter((n) => !(PROJECTED_ENTRIES as readonly string[]).includes(n))
}
