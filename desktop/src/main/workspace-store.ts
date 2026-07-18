// In-repo workspace persistence for Claude Peers Desk (DESIGN 6.3/6.4).
// A workspace is a restorable snapshot stored at
//   <project>/.claude/claude-peers/workspaces/<id>.json
// It holds the GROUP ID only -- never the scope secret (DESIGN 6.8) -- so a
// leaked or cloud-synced workspace cannot join the group.
//
// Pure: node fs/path/crypto only (no electron / node-pty), so it is unit-testable
// under bun. Own types are declared here rather than imported via @shared, to
// mirror the existing pure-module pattern (scope.ts, session-command.ts).

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/** "ephemeral" scopes mint a fresh secret on restore; "custom" ones are re-supplied via the launch arg. */
export type ScopeKind = 'ephemeral' | 'custom'

export interface WorkspaceDisplayMode {
  kind: 'carousel' | 'grid'
  x: number
  y: number
}

export interface WorkspaceSession {
  /** The last claude --session-id (a new fork id is minted on each resume). */
  claudeSessionId: string
  name: string
  cwd: string
  /** Launch args kept for display + the expired-session fallback. */
  args: string[]
  color: string
  position: number
}

export interface Workspace {
  id: string
  name: string
  pinned: boolean
  cwd: string
  /** sha256 hex of the group secret -- identification only, NOT the secret. */
  groupId: string
  scopeName: string
  scopeKind: ScopeKind
  displayMode: WorkspaceDisplayMode
  createdAt: number
  updatedAt: number
  sessions: WorkspaceSession[]
}

/** `.claude/claude-peers` dir (shared with the launch-config location). */
export function peersConfigDir(projectDir: string): string {
  return join(projectDir, '.claude', 'claude-peers')
}

export function workspacesDir(projectDir: string): string {
  return join(peersConfigDir(projectDir), 'workspaces')
}

function workspacePath(projectDir: string, id: string): string {
  return join(workspacesDir(projectDir), `${id}.json`)
}

/**
 * Create the workspaces dir tree and ensure `.claude/claude-peers/.gitignore`
 * ignores `workspaces/` (session ids + layout are machine/project-local noise;
 * note there is no secret in them, DESIGN 6.4). The launch-config `config.json`
 * sitting next to it stays committable. Idempotent.
 */
export function ensureWorkspacesDir(projectDir: string): string {
  const dir = workspacesDir(projectDir)
  mkdirSync(dir, { recursive: true })

  const gitignore = join(peersConfigDir(projectDir), '.gitignore')
  const line = 'workspaces/'
  let lines: string[] = []
  if (existsSync(gitignore)) {
    lines = readFileSync(gitignore, 'utf8').split(/\r?\n/)
  }
  if (!lines.some((l) => l.trim() === line)) {
    const body = [...lines.filter((l) => l.length > 0), line].join('\n') + '\n'
    writeFileSync(gitignore, body, 'utf8')
  }
  return dir
}

export function newWorkspaceId(): string {
  return `wsp_${randomUUID().replace(/-/g, '')}`
}

function isWorkspace(value: unknown): value is Workspace {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Workspace).id === 'string' &&
    Array.isArray((value as Workspace).sessions)
  )
}

/** List workspaces for a project, newest first. Malformed files are skipped. */
export function listWorkspaces(projectDir: string): Workspace[] {
  const dir = workspacesDir(projectDir)
  if (!existsSync(dir)) return []
  const out: Workspace[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as unknown
      if (isWorkspace(parsed)) out.push(parsed)
    } catch {
      // Partial / corrupt file -> skip, do not break the whole listing.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadWorkspace(projectDir: string, id: string): Workspace | null {
  const file = workspacePath(projectDir, id)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return isWorkspace(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Persist a workspace atomically (write temp then rename), stamping `updatedAt`.
 * Strips any stray `scopeSecret` defensively so it can never leak into the repo.
 */
export function saveWorkspace(projectDir: string, ws: Workspace): Workspace {
  ensureWorkspacesDir(projectDir)
  const stamped: Workspace = { ...ws, updatedAt: Date.now() }
  // Defensive: a secret must never be persisted (DESIGN 6.8).
  delete (stamped as Workspace & { scopeSecret?: unknown }).scopeSecret
  const file = workspacePath(projectDir, ws.id)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(stamped, null, 2), 'utf8')
  renameSync(tmp, file)
  return stamped
}

/** Remove a workspace JSON and its sidecar lock (best-effort). */
export function deleteWorkspace(projectDir: string, id: string): void {
  const dir = workspacesDir(projectDir)
  for (const f of [join(dir, `${id}.json`), join(dir, `${id}.lock`)]) {
    try {
      rmSync(f, { force: true })
    } catch {
      // already gone / unreadable -> nothing to do
    }
  }
}

export interface PruneOptions {
  now: number
  /** Workspaces older than this (by updatedAt) are prune candidates. */
  maxAgeMs: number
  /** Ids to never prune (e.g. the current workspace). */
  keepIds?: Iterable<string>
}

/**
 * Pure selector for D6 auto-save pruning (DESIGN 6.7): pick the ids of
 * **unpinned** workspaces whose `updatedAt` is older than `now - maxAgeMs`,
 * excluding any id in `keepIds`. Pinned workspaces are kept regardless of age.
 * Lock-awareness (don't prune one another live instance holds) is the caller's
 * job -- this stays pure for unit testing.
 */
export function selectPrunableWorkspaces(workspaces: Workspace[], opts: PruneOptions): string[] {
  const keep = new Set(opts.keepIds ?? [])
  const cutoff = opts.now - opts.maxAgeMs
  return workspaces
    .filter((ws) => !ws.pinned && ws.updatedAt < cutoff && !keep.has(ws.id))
    .map((ws) => ws.id)
}

/** Auto-save display name, e.g. "auto · dev-pc-foo · 14:32". No em dashes. */
export function autoName(scopeName: string, date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `auto · ${scopeName} · ${hh}:${mm}`
}
