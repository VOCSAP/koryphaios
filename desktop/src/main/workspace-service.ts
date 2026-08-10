// Orchestrates workspace persistence/restore on top of the pure store + lock
// modules and the SessionService. Lives in the main process (consumes electron-
// adjacent singletons via injected deps), so it is not bun-tested directly --
// its pure pieces (store, lock, session-map, scope adoption) are tested
// separately. Owns: the current workspace, its lock + heartbeat, auto-save, and
// scope adoption on restore.

import { hostname } from 'node:os'
import type { AppConfig, DisplayMode, WorkspaceSummary } from '@shared/types'
import type { Scope } from './scope'
import type { SessionService } from './session-service'
import {
  type Workspace,
  type WorkspaceDisplayMode,
  autoName,
  deleteWorkspace,
  ensureWorkspacesDir,
  listWorkspaces,
  loadWorkspace,
  newWorkspaceId,
  saveWorkspace,
  selectPrunableWorkspaces
} from './workspace-store'
import { acquireLock, isLockLive, readLock, refreshLock, releaseLock } from './workspace-lock'
import { fromWorkspaceSessions, toWorkspaceSessions } from './workspace-session-map'
import { logWarn } from './log'

const HEARTBEAT_MS = 30_000
/** Cross-host lock is stale after this without a heartbeat (best-effort, DESIGN 15). */
const LOCK_STALE_MS = 120_000
/** D6: unpinned auto-saves older than this are pruned, aligned with Claude's ~30-day session retention (DESIGN 6.7). */
const PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** How often to re-run the prune for long-lived app sessions. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** True if `pid` is a live process on this machine (EPERM still means alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function toDisplayMode(cfg: AppConfig): WorkspaceDisplayMode {
  switch (cfg.displayMode) {
    case '1x1':
      return { kind: 'carousel', x: 1, y: 1 }
    case '1x2':
      return { kind: 'grid', x: 2, y: 1 }
    case '2x2':
      return { kind: 'grid', x: 2, y: 2 }
    default:
      return { kind: 'grid', x: cfg.gridCols, y: cfg.gridRows }
  }
}

/** Map a persisted display mode back onto AppConfig fields. */
function fromDisplayMode(dm: WorkspaceDisplayMode): Partial<AppConfig> {
  if (dm.kind === 'carousel') return { displayMode: '1x1' }
  if (dm.x === 2 && dm.y === 1) return { displayMode: '1x2' as DisplayMode }
  if (dm.x === 2 && dm.y === 2) return { displayMode: '2x2' as DisplayMode }
  return { displayMode: 'custom' as DisplayMode, gridCols: dm.x, gridRows: dm.y }
}

export interface WorkspaceDeps {
  projectDir: string
  service: SessionService
  getConfig: () => AppConfig
  setConfig: (patch: Partial<AppConfig>) => void
  getScope: () => Scope
  /** Adopt a workspace's scope (no-op if a session is already running). */
  adoptScope: (ws: { groupId: string; scopeKind: 'ephemeral' | 'custom' }) => void
  pid?: number
  host?: string
}

export class WorkspaceService {
  private readonly host: string
  private readonly pid: number
  private currentId: string | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private pruneTimer: NodeJS.Timeout | null = null

  constructor(private deps: WorkspaceDeps) {
    this.host = deps.host ?? hostname()
    this.pid = deps.pid ?? process.pid
  }

  get currentWorkspaceId(): string | null {
    return this.currentId
  }

  /**
   * Lazy by design: launching empty must NOT create or clobber a workspace
   * (operator request). A workspace is only minted/locked once sessions exist
   * (created or restored) via `ensureCurrent`. The previous run's workspace stays
   * the newest restorable until the user acts.
   */
  start(): void {
    // No workspace is minted here (see ensureCurrent). Pruning only deletes
    // stale OTHER workspaces, so it is safe at startup and on a periodic timer.
    this.pruneStale()
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => this.pruneStale(), PRUNE_INTERVAL_MS)
    }
  }

  /**
   * D6: delete unpinned auto-saves older than PRUNE_MAX_AGE_MS, never touching a
   * pinned, current, or live-locked-by-another-instance workspace. Returns the
   * pruned ids. Best-effort: a delete failure is swallowed by deleteWorkspace.
   */
  pruneStale(): string[] {
    const now = Date.now()
    const keepIds = this.currentId ? [this.currentId] : []
    const candidates = selectPrunableWorkspaces(listWorkspaces(this.deps.projectDir), {
      now,
      maxAgeMs: PRUNE_MAX_AGE_MS,
      keepIds
    })
    const pruned: string[] = []
    for (const id of candidates) {
      const lock = readLock(this.deps.projectDir, id)
      const liveElsewhere =
        !!lock && isLockLive(lock, { host: this.host, now, isPidAlive: pidAlive, staleMs: LOCK_STALE_MS })
      if (liveElsewhere) continue
      deleteWorkspace(this.deps.projectDir, id)
      pruned.push(id)
    }
    return pruned
  }

  /** Own a workspace id: acquire its lock + (re)start the heartbeat. */
  private own(id: string): void {
    // The lock is written before saveWorkspace would create the tree, so a
    // fresh project dir (no .claude/claude-peers/workspaces yet) would ENOENT.
    // Create it up front -- own() is the first writer of any workspace file.
    ensureWorkspacesDir(this.deps.projectDir)
    if (this.currentId && this.currentId !== id) {
      releaseLock(this.deps.projectDir, this.currentId)
    }
    this.currentId = id
    acquireLock(this.deps.projectDir, id, {
      pid: this.pid,
      host: this.host,
      now: Date.now(),
      isPidAlive: pidAlive,
      staleMs: LOCK_STALE_MS
    })
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.currentId) refreshLock(this.deps.projectDir, this.currentId, Date.now())
      }, HEARTBEAT_MS)
    }
  }

  /** Mint + own a fresh workspace if none is current yet. */
  private ensureCurrent(): void {
    if (this.currentId) return
    this.own(newWorkspaceId())
  }

  /**
   * Persist the live state under the current workspace id (auto name kept).
   * Returns null and does NOTHING -- no mint, no overwrite -- when
   * captureSessions() is empty (e.g. the supervisor is the only session
   * alive): an empty snapshot is never a legitimate auto-save, and covering
   * this here (not at each call site) is what protects all three callers
   * (index.ts's debounced 'changed' handler, startNew, releaseOnQuit) with
   * one guard. saveNamed (explicit Save As) is NOT guarded: the operator
   * asking to save an empty workspace by name is a deliberate act.
   */
  saveAuto(): WorkspaceSummary | null {
    if (this.deps.service.captureSessions().length === 0) return null
    return this.persist(undefined, false)
  }

  /**
   * Persist under a user-chosen name and pin it (explicit Save As). Names are
   * unique per cwd: a name already used by ANOTHER workspace is rejected so the
   * list stays unambiguous.
   */
  saveNamed(name: string): WorkspaceSummary {
    const trimmed = name.trim()
    if (trimmed) {
      const norm = trimmed.toLowerCase()
      const clash = listWorkspaces(this.deps.projectDir).some(
        (w) => w.id !== this.currentId && w.name.trim().toLowerCase() === norm
      )
      if (clash) throw new Error('duplicate-workspace-name')
    }
    return this.persist(trimmed || undefined, true)
  }

  /**
   * Distinct cwds the sessions of a saved workspace will respawn into. Used by
   * the sandbox to warm its container-side transcript cache BEFORE `restore`
   * spawns them (PLAN-SANDBOX M2): the spawn path is synchronous, so anything
   * it needs to know must already be cached. Empty when the workspace is gone.
   */
  sessionCwds(id: string): string[] {
    const ws = loadWorkspace(this.deps.projectDir, id)
    if (!ws) return []
    const cwds = fromWorkspaceSessions(ws.sessions)
      .map((d) => d.cwd?.trim())
      .filter((c): c is string => !!c)
    return [...new Set(cwds)]
  }

  /**
   * Restore a workspace: adopt its scope, swap the session set, set the layout.
   * Returns false (no-op) when the workspace is missing or already owned by
   * another live instance; true after a successful restore.
   */
  restore(id: string): boolean {
    const ws = loadWorkspace(this.deps.projectDir, id)
    if (!ws) return false
    // A workspace persisted with zero sessions (a legacy empty snapshot minted
    // before saveAuto()'s empty-capture guard existed, or any future writer
    // that bypasses it) must never reach restoreFrom: restoreFrom starts with
    // pty.killAll(), so "restoring nothing" would kill every live session for
    // no replacement (b8d65b24 follow-up, mutation-tested review). The picker
    // (WorkspacesDialog.tsx) also disables Restore on sessionCount === 0; this
    // is the service-side line of defense for every other caller.
    if (ws.sessions.length === 0) return false
    // Refuse to restore a workspace another live instance already owns -- two
    // windows must not drive the same Claude sessions (the UI also disables
    // it). Exemption is by LOCK IDENTITY (the pid+host actually stamped in the
    // lock file), not by comparing `id` to `this.currentId`: currentId is only
    // this instance's own belief about what it owns, and refreshLock()
    // re-stamps whatever identity the file already holds, so a second Deck
    // could keep alive a lock this instance no longer truly matches. Resolve
    // the object (the lock) first, then ask whether THIS caller (pid+host) is
    // the one holding it.
    const lock = readLock(this.deps.projectDir, id)
    if (
      lock &&
      isLockLive(lock, { host: this.host, now: Date.now(), isPidAlive: pidAlive, staleMs: LOCK_STALE_MS }) &&
      !(lock.pid === this.pid && lock.host === this.host)
    ) {
      return false
    }
    this.deps.adoptScope({ groupId: ws.groupId, scopeKind: ws.scopeKind })
    this.deps.setConfig(fromDisplayMode(ws.displayMode))
    this.deps.service.restoreFrom(fromWorkspaceSessions(ws.sessions))
    this.own(id) // hand the lock from the old workspace to this one + heartbeat
    // Recapture right after restoring a non-empty workspace (ws.sessions.length
    // > 0, guarded above) must not itself come back empty -- that would mean
    // restoreFrom silently produced nothing, exactly the defect this card
    // fixes elsewhere. saveAuto()'s own empty-guard would otherwise swallow it
    // without a trace.
    if (this.saveAuto() === null) {
      logWarn(
        'workspace',
        `restore(${id}) recaptured 0 sessions right after restoring ${ws.sessions.length}`
      )
    }
    return true
  }

  deleteWs(id: string): void {
    if (id === this.currentId) this.currentId = null
    deleteWorkspace(this.deps.projectDir, id)
  }

  /**
   * "New (clear)": detach from the current workspace so the next created session
   * mints a fresh one. Captures a final auto-save (while sessions still exist --
   * call this BEFORE SessionService.closeAll) and releases the lock; the prior
   * workspace is kept restorable, not deleted.
   */
  startNew(): void {
    if (!this.currentId) return
    this.saveAuto()
    releaseLock(this.deps.projectDir, this.currentId)
    this.currentId = null
  }

  /** All workspaces for this project, with lock + current flags, newest first. */
  listForCwd(): WorkspaceSummary[] {
    const now = Date.now()
    return listWorkspaces(this.deps.projectDir).map((ws) => {
      const lock = readLock(this.deps.projectDir, ws.id)
      const lockedByOther =
        ws.id !== this.currentId &&
        !!lock &&
        isLockLive(lock, { host: this.host, now, isPidAlive: pidAlive, staleMs: LOCK_STALE_MS })
      return {
        id: ws.id,
        name: ws.name,
        pinned: ws.pinned,
        scopeName: ws.scopeName,
        sessionCount: ws.sessions.length,
        updatedAt: ws.updatedAt,
        locked: lockedByOther,
        current: ws.id === this.currentId
      }
    })
  }

  /** Final auto-save + lock release on quit. */
  releaseOnQuit(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.pruneTimer = null
    if (!this.currentId) return
    this.saveAuto()
    releaseLock(this.deps.projectDir, this.currentId)
  }

  // ----- internals -----

  private persist(name: string | undefined, pin: boolean): WorkspaceSummary {
    this.ensureCurrent()
    // Adopt any post-discovery session-id rotation (e.g. a /clear) before
    // snapshotting, so the saved workspace resumes the current transcript.
    this.deps.service.refreshLiveSessionIds()
    const id = this.currentId as string
    const scope = this.deps.getScope()
    const existing = loadWorkspace(this.deps.projectDir, id)
    const ws: Workspace = {
      id,
      name: name ?? existing?.name ?? autoName(scope.name, new Date()),
      pinned: pin || existing?.pinned || false,
      cwd: this.deps.projectDir,
      groupId: scope.groupId,
      scopeName: scope.name,
      scopeKind: scope.scopeKind,
      displayMode: toDisplayMode(this.deps.getConfig()),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      sessions: toWorkspaceSessions(this.deps.service.captureSessions())
    }
    const saved = saveWorkspace(this.deps.projectDir, ws)
    return {
      id: saved.id,
      name: saved.name,
      pinned: saved.pinned,
      scopeName: saved.scopeName,
      sessionCount: saved.sessions.length,
      updatedAt: saved.updatedAt,
      locked: false,
      current: true
    }
  }
}
