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
import { join, sep } from 'node:path'
// Relative import (not the @shared alias), like workspace-session-map.ts: this
// pulls in only the pure predicate, keeping this module resolvable under
// `bun test` without an alias tsconfig.
import { sessionsHaveShellFields } from '../shared/template'
// worktree-service.ts is itself node-builtins-only (no electron/@shared), so
// this stays a pure-module import: canonicalPath is the project's own answer
// to "comparing two paths? canonicalize both" (CLAUDE.md) -- a bare
// resolve()+startsWith comparison misses macOS symlinked tmpdirs and Windows
// 8.3 short names (worktree-service.ts's own docstring on canonicalPath).
import { canonicalPath } from './worktree-service'

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
  /**
   * The session's clodex-bridge marker (SessionDef.bridge). Persisted because
   * a workspace rebuilds `command` as '' (workspace-session-map.ts), so this
   * is the only thing that tells a restored tile to relaunch through the
   * wrapper instead of plain claude -- which would reject the `clodex:` model
   * still sitting in `args`.
   */
  bridge?: 'clodex'
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

/**
 * Structural validation of a persisted session entry, mirroring
 * `isTemplateSession` (shared/template.ts) -- before this (card 09d54a29
 * review point), `isWorkspace` checked only that `sessions` was an array,
 * not the type of anything inside it, so a malformed `args` (e.g. a bare
 * string instead of string[]) would sail through and only fail later, deep
 * in `joinArgs`/`workspace-session-map.ts`.
 */
function isWorkspaceSession(value: unknown): value is WorkspaceSession {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.claudeSessionId === 'string' &&
    typeof s.name === 'string' &&
    typeof s.cwd === 'string' &&
    typeof s.color === 'string' &&
    typeof s.position === 'number' &&
    Array.isArray(s.args) &&
    s.args.every((a) => typeof a === 'string') &&
    // Strict enum at the parse boundary, so the declared 'clodex' type stays
    // honest for every reader downstream; a file naming any other bridge is
    // rejected whole rather than silently restored without it.
    (s.bridge === undefined || s.bridge === 'clodex')
  )
}

function isWorkspace(value: unknown): value is Workspace {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Workspace).id === 'string' &&
    Array.isArray((value as Workspace).sessions) &&
    (value as Workspace).sessions.every(isWorkspaceSession)
  )
}

/**
 * True when any session in a workspace carries a shell-bearing field -- same
 * predicate templates use (`templateHasShellFields`, shared/template.ts, B4),
 * reused via `sessionsHaveShellFields` rather than reimplemented so the two
 * gates cannot drift apart (card 09d54a29: they already had, on the `lead`
 * field). Workspaces never persist `command` (workspace-session-map.ts always
 * rebuilds it as `''`); `args` is stored as string[] (`joinArgs`-shaped) and
 * joined back into the free-form string `sessionsHaveShellFields` expects, and
 * `bridge` is forwarded because it decides the launch binary on its own, with
 * no `args` needed.
 */
export function workspaceHasShellFields(ws: Pick<Workspace, 'sessions'>): boolean {
  return sessionsHaveShellFields(
    ws.sessions.map((s) => ({ args: s.args.join(' '), bridge: s.bridge }))
  )
}

/** True when `cwd` is `projectDir` itself or a path nested under it. */
function isInsideProject(cwd: string, projectDir: string): boolean {
  const root = canonicalPath(projectDir)
  const target = canonicalPath(cwd)
  return target === root || target.startsWith(root + sep)
}

/**
 * A cwd outside the project tree is a separate vulnerability class from
 * workspaceHasShellFields above -- arbitrary file read via ipc.ts's
 * workDirRoots trusting every session's cwd, not command execution -- so it
 * gets its own predicate rather than folding into the shell-fields check.
 * Git worktrees live under <projectDir>/.worktrees/<name>, so this containment
 * check also clears the multi-worktree restore case without a false positive.
 */
export function workspaceHasUntrustedCwd(
  ws: Pick<Workspace, 'sessions'>,
  projectDir: string
): boolean {
  return ws.sessions.some((s) => {
    const cwd = s.cwd?.trim()
    return !!cwd && !isInsideProject(cwd, projectDir)
  })
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
