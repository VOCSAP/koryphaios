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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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

/** Bounds for the signature walk: this runs on the agent-spawn path. */
const SIG_MAX_DEPTH = 6
const SIG_MAX_ENTRIES = 5000

/**
 * A cheap fingerprint of what WOULD be projected, so the copy can be skipped
 * when nothing changed.
 *
 * Why it exists: the projection is one `docker cp` per entry, and re-running it
 * on every agent spawn cost the operator about fifteen silent seconds each
 * time. Caching on "already projected once" alone would have been worse than
 * the slowness -- it would silently ignore an edit to the global CLAUDE.md
 * until the container was rebuilt. So the skip is conditional on this
 * signature, which walks the projected entries (following symlinks: many
 * operators keep them as links into a config repo) and folds in every file's
 * size and mtime. Bounded by depth and count, and any unreadable path folds in
 * as a marker rather than throwing -- a signature that changes too often only
 * costs a copy, one that throws would break spawning.
 */
export function projectionSignature(claudeHomeDir: string): string {
  const parts: string[] = []
  let budget = SIG_MAX_ENTRIES

  const visit = (path: string, label: string, depth: number): void => {
    if (budget-- <= 0) return
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(path) // follows symlinks, like the `docker cp -L` we issue
    } catch {
      parts.push(`${label}:?`)
      return
    }
    if (stat.isDirectory()) {
      if (depth >= SIG_MAX_DEPTH) {
        parts.push(`${label}:deep`)
        return
      }
      let names: string[]
      try {
        names = readdirSync(path).sort()
      } catch {
        parts.push(`${label}:?`)
        return
      }
      parts.push(`${label}/${names.length}`)
      for (const name of names) visit(join(path, name), `${label}/${name}`, depth + 1)
      return
    }
    parts.push(`${label}:${stat.size}:${Math.round(stat.mtimeMs)}`)
  }

  for (const entry of planProjection(claudeHomeDir)) visit(entry.hostPath, entry.name, 0)
  return parts.join('|')
}

/**
 * Hook commands that cannot work in the Linux container (PowerShell, cmd,
 * drive-letter paths, .ps1/.bat/.exe). Reported to the operator so they can
 * drop a Linux equivalent in sandbox-overrides/settings.json rather than
 * discovering the breakage inside an agent's terminal.
 */
// The drive-letter branch is anchored at a word START. Unanchored,
// `[A-Za-z]:[\\/]` also matches the `s:/` inside `https://`, so every hook
// containing a URL was falsely reported as un-runnable in the container.
//
// Windows-only ENV VARS are host-only too: `bash "$USERPROFILE/.claude/…"`
// is a perfectly Linux-looking command, but $USERPROFILE is empty in the
// container, so the hook resolves to `/.claude/…` and fails on every
// session start — that exact shape shipped unreported. The %VAR% branch is
// a NAMED list, not `%\w+%`: a generic pattern would flag the `%s%N` inside
// an innocent `date +%s%N`.
const WIN_VARS = 'USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|PROGRAMFILES|SYSTEMROOT|WINDIR'
const HOST_ONLY = new RegExp(
  /(^|[\s"'=/\\])(powershell(\.exe)?|pwsh|cmd\.exe)([\s"']|$)|\.(ps1|bat|cmd|exe)([\s"']|$)|(^|[\s"'=])[A-Za-z]:[\\/]/
    .source + `|\\$\\{(${WIN_VARS})\\}|\\$(${WIN_VARS})\\b|%(${WIN_VARS})%`,
  'i'
)

export function detectHostOnlyHooks(settingsJson: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(settingsJson)
  } catch {
    return [] // unreadable settings: the copy still happens, nothing to warn about
  }
  const suspicious: string[] = []
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

/**
 * Build the sandbox overlay settings from the HOST settings.json: same JSON,
 * minus every hook command the container cannot run (HOST_ONLY above), minus
 * the hook groups/events that end up empty. This is the sane alternative to
 * auto-translating Windows hooks to Linux: a translated hook whose runtime
 * dependency is missing in the container (agent-forge, kleos-cli — Windows
 * binaries) would go from "fails non-blocking at session start" to "BLOCKS
 * every Write/Edit of the sandboxed agent". Removal is deterministic and the
 * removed commands are returned so the operator sees exactly what the sandbox
 * loses.
 *
 * Returns null when the input is not a JSON object — the caller must then
 * write NOTHING (an empty overlay would silently replace the whole config).
 */
export function stripHostOnlyHooks(
  settingsJson: string
): { settings: Record<string, unknown>; removed: string[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(settingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const settings = parsed as Record<string, unknown>
  const removed: string[] = []
  const hooks = settings.hooks
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    const keptEvents: Record<string, unknown> = {}
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) {
        keptEvents[event] = groups // unknown shape: keep untouched
        continue
      }
      const keptGroups: unknown[] = []
      for (const group of groups) {
        const inner = (group as { hooks?: unknown } | null)?.hooks
        if (!Array.isArray(inner)) {
          keptGroups.push(group)
          continue
        }
        const keptInner = inner.filter((h) => {
          const cmd = (h as { command?: unknown } | null)?.command
          if (typeof cmd === 'string' && HOST_ONLY.test(cmd)) {
            removed.push(cmd)
            return false
          }
          return true
        })
        if (keptInner.length > 0) keptGroups.push({ ...(group as object), hooks: keptInner })
      }
      if (keptGroups.length > 0) keptEvents[event] = keptGroups
    }
    if (Object.keys(keptEvents).length > 0) settings.hooks = keptEvents
    else delete settings.hooks
  }
  return { settings, removed }
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
 * Persisted projection marker (sandbox-service projectedMarkerFile). The
 * `key` decides whether ensure() re-projects; `summary`/`hookWarnings` ride
 * along so the Docker view can say WHAT is inside the container after an app
 * restart -- the in-memory summary alone reset to "nothing projected" on
 * every launch while the container still carried the config.
 */
export interface ProjectedMarker {
  key: string
  summary: string | null
  hookWarnings: string[]
}

/** Parse a marker file. A pre-JSON marker (plain signature) is just a key. */
export function parseProjectedMarker(raw: string): ProjectedMarker {
  try {
    const v = JSON.parse(raw) as Partial<ProjectedMarker>
    if (v && typeof v === 'object' && typeof v.key === 'string') {
      return {
        key: v.key,
        summary: typeof v.summary === 'string' && v.summary ? v.summary : null,
        hookWarnings: Array.isArray(v.hookWarnings)
          ? v.hookWarnings.filter((w): w is string => typeof w === 'string')
          : []
      }
    }
  } catch {
    // Legacy marker: the raw signature string, no summary to recover.
  }
  return { key: raw, summary: null, hookWarnings: [] }
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
