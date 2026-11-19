// A workspace snapshot holds the GROUP ID only, never the scope secret, so a leaked or cloud-synced file cannot join the group.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
// Relative import (not the @shared alias), like workspace-session-map.ts: this
// pulls in only pure helpers, keeping this module resolvable under
// `bun test` without an alias tsconfig.
import { isPresent, TEMPLATE_SESSION_FIELD_CLASS } from '../shared/template'
import { isToolNameList } from '../shared/tool-names'
import { isValidClodexContextInput } from '../shared/clodex-context'
// worktree-service.ts is itself node-builtins-only (no electron/@shared), so
// this stays a pure-module import: canonicalPath is the project's own answer
// to "comparing two paths? canonicalize both" (CLAUDE.md) -- a bare
// resolve()+startsWith comparison misses macOS symlinked tmpdirs and Windows
// 8.3 short names (worktree-service.ts's own docstring on canonicalPath).
import { canonicalPath } from './worktree-service'
import { writeFileAtomic } from './atomic-write'
import {
  entryPresent,
  PROJECT_SOURCES,
  projectRootPath,
  type ProjectFileSource,
  type WorkspaceRef
} from './project-files'

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
  clodexContextTokens?: number
  /** SessionDef.disallowedTools: the only place a restored read-only tile finds its denial, `args` does not hold it. */
  disallowedTools?: string[]
  /** SessionDef.role and .lead; typed here, re-validated by fromWorkspaceSessions because the file comes from a repo. */
  role?: string
  lead?: boolean
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

export function workspacesDir(projectDir: string, source: ProjectFileSource): string {
  return join(projectRootPath(projectDir, source), 'workspaces')
}

function workspacePath(ref: WorkspaceRef): string {
  return join(workspacesDir(ref.projectDir, ref.source), `${ref.id}.json`)
}

/** A fresh id, always under the new folder. */
export function newWorkspaceRef(projectDir: string): WorkspaceRef {
  return { projectDir, id: newWorkspaceId(), source: 'koryphaios' }
}

const WORKSPACE_ID_PATTERN = /^[\w-]+$/

export type WorkspaceLocation ={ kind: 'none' } | { kind: 'one'; ref: WorkspaceRef } | { kind: 'conflict' }

/** Where the snapshot of `id` lives, by file existence in each folder; an id in both is a conflict, never a winner. */
export function locateWorkspace(projectDir: string, id: string): WorkspaceLocation {
  if (!WORKSPACE_ID_PATTERN.test(id)) return { kind: 'none' }
  const found = PROJECT_SOURCES.map((source): WorkspaceRef => ({ projectDir, id, source })).filter((ref) =>
    entryPresent(workspacePath(ref))
  )
  if (found.length === 0) return { kind: 'none' }
  const [only, other] = found
  return other || !only ? { kind: 'conflict' } : { kind: 'one', ref: only }
}

/** Creates the workspaces folder of `ref`'s root and keeps `workspaces/` in that root's own .gitignore. Idempotent. */
export function ensureWorkspacesDir(ref: Pick<WorkspaceRef, 'projectDir' | 'source'>): string {
  const dir = workspacesDir(ref.projectDir, ref.source)
  mkdirSync(dir, { recursive: true })

  const gitignore = join(projectRootPath(ref.projectDir, ref.source), '.gitignore')
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
function isPlainSessionId(value: unknown): boolean {
  return typeof value === 'string' && /^[\w.-]*$/.test(value) && !value.includes('..')
}

function isWorkspaceSession(value: unknown): value is WorkspaceSession {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    isPlainSessionId(s.claudeSessionId) &&
    typeof s.name === 'string' &&
    typeof s.cwd === 'string' &&
    typeof s.color === 'string' &&
    typeof s.position === 'number' &&
    Array.isArray(s.args) &&
    s.args.every((a) => typeof a === 'string') &&
    // Strict enum at the parse boundary, so the declared 'clodex' type stays
    // honest for every reader downstream; a file naming any other bridge is
    // rejected whole rather than silently restored without it.
    (s.bridge === undefined || s.bridge === 'clodex') &&
    isValidClodexContextInput(s.clodexContextTokens) &&
    // A list holding a name outside the allow-list rejects the file whole: dropping
    // the offender would silently allow that tool.
    (s.disallowedTools === undefined || isToolNameList(s.disallowedTools))
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

export type WorkspaceFieldClass = 'free' | 'approval' | 'own-gate' | 'validated'

export const WORKSPACE_SESSION_FIELD_CLASS = {
  args: TEMPLATE_SESSION_FIELD_CLASS.args,
  bridge: TEMPLATE_SESSION_FIELD_CLASS.bridge,
  clodexContextTokens: TEMPLATE_SESSION_FIELD_CLASS.clodexContextTokens,
  lead: TEMPLATE_SESSION_FIELD_CLASS.lead,
  disallowedTools: TEMPLATE_SESSION_FIELD_CLASS.disallowedTools,
  name: TEMPLATE_SESSION_FIELD_CLASS.name,
  color: TEMPLATE_SESSION_FIELD_CLASS.color,
  role: TEMPLATE_SESSION_FIELD_CLASS.role,
  position: 'free',
  cwd: 'own-gate',
  claudeSessionId: 'validated'
} as const satisfies Record<keyof WorkspaceSession, WorkspaceFieldClass>

const APPROVAL_FIELDS = (Object.keys(WORKSPACE_SESSION_FIELD_CLASS) as (keyof WorkspaceSession)[]).filter(
  (field) => WORKSPACE_SESSION_FIELD_CLASS[field] === 'approval'
)

function approvalValue(s: WorkspaceSession, field: keyof WorkspaceSession): unknown {
  return field === 'args' ? s.args.join(' ') : s[field]
}

export function workspaceHasShellFields(ws: Pick<Workspace, 'sessions'>): boolean {
  return ws.sessions.some((s) => APPROVAL_FIELDS.some((field) => isPresent(approvalValue(s, field))))
}

export function workspaceApproval(ws: Pick<Workspace, 'sessions'>): {
  hashPayload: Array<Record<string, unknown>>
  previewLines: string[]
} {
  return {
    hashPayload: ws.sessions.map((s) => {
      // args stays unconditional and bridge stays right after it to preserve existing approval hashes.
      const entry: Record<string, unknown> = { args: s.args.join(' ') }
      for (const field of APPROVAL_FIELDS) {
        if (field !== 'args' && isPresent(approvalValue(s, field))) entry[field] = s[field]
      }
      return entry
    }),
    previewLines: ws.sessions.flatMap((s) => {
      const lines: string[] = []
      if (s.args.length > 0 || s.bridge) {
        lines.push(`${s.name}: ${[s.bridge && `[${s.bridge}]`, ...s.args].filter(Boolean).join(' ')}`)
      }
      for (const field of APPROVAL_FIELDS) {
        if (field === 'args' || field === 'bridge' || !isPresent(s[field])) continue
        const value = s[field]
        lines.push(`${s.name}: ${value === true ? field : `${field} ${Array.isArray(value) ? value.join(',') : String(value)}`}`)
      }
      return lines
    })
  }
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

export type StoredWorkspace = Workspace & { readonly ref: WorkspaceRef; readonly conflict: boolean }

function readWorkspacesIn(projectDir: string, source: ProjectFileSource): StoredWorkspace[] {
  const dir = workspacesDir(projectDir, source)
  if (!existsSync(dir)) return []
  const out: StoredWorkspace[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as unknown
      if (isWorkspace(parsed)) {
        out.push({ ...parsed, ref: { projectDir, id: entry.slice(0, -'.json'.length), source }, conflict: false })
      }
    } catch {
      // Partial / corrupt file -> skip, do not break the whole listing.
    }
  }
  return out
}

/** Workspaces of both folders, newest first; an id held by both appears once, flagged `conflict`. Malformed files are skipped. */
export function listWorkspaces(projectDir: string): StoredWorkspace[] {
  const byId = new Map<string, StoredWorkspace>()
  for (const source of PROJECT_SOURCES) {
    for (const ws of readWorkspacesIn(projectDir, source)) {
      const seen = byId.get(ws.ref.id)
      byId.set(ws.ref.id, seen ? { ...(ws.updatedAt > seen.updatedAt ? ws : seen), conflict: true } : ws)
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadWorkspace(ref: WorkspaceRef): Workspace | null {
  const file = workspacePath(ref)
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
export function saveWorkspace(ref: WorkspaceRef, ws: Workspace): Workspace {
  ensureWorkspacesDir(ref)
  const stamped: Workspace = { ...ws, updatedAt: Date.now() }
  delete (stamped as Workspace & { scopeSecret?: unknown }).scopeSecret
  writeFileAtomic(workspacePath(ref), JSON.stringify(stamped, null, 2))
  return stamped
}

/** Remove a workspace JSON and its two lock files, in the folder of `ref` only (best-effort). */
export function deleteWorkspace(ref: WorkspaceRef): void {
  const dir = workspacesDir(ref.projectDir, ref.source)
  for (const f of [join(dir, `${ref.id}.json`), join(dir, `${ref.id}.lock`), join(dir, `${ref.id}.lock.sqlite`)]) {
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
