// Orchestrates workspace persistence/restore on top of the pure store + lock
// modules and the SessionService. Its own runtime imports (node:os + the pure
// modules below) carry no electron/node-pty -- SessionService/Scope are
// `import type` only, erased at build time -- so WorkspaceService itself is
// bun-testable directly with a stubbed `deps` object (tests/desktop-
// workspace.test.ts), not just its pure pieces (store, lock, session-map)
// in isolation. Owns: the current workspace, its lock + heartbeat, auto-save,
// and scope adoption on restore.

import { hostname, uptime as osUptime } from 'node:os'
import type { AppConfig, DisplayMode, WorkspaceSummary } from '@shared/types'
import type { WorkspaceRestoreResult } from '../shared/workspace-restore-outcome'
import type { Scope } from './scope'
import type { SessionService } from './session-service'
import type { RestorePlansResult } from './mod-launch-plan'
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
  selectPrunableWorkspaces,
  workspaceHasShellFields,
  workspaceHasUntrustedCwd
} from './workspace-store'
import {
  acquireLock,
  inspectLock,
  isLockLive,
  ownsLock,
  probeSameHostLock,
  refreshLock,
  releaseHeldLock,
  releaseLock,
  stampLock,
  type Lock
} from './workspace-lock'
import type { LockConnection, LockOpener } from './file-lock'
import { fromWorkspaceSessions, joinArgs, toWorkspaceSessions } from './workspace-session-map'
import { logWarn, reportError } from './log'
import { effectiveAgent, isTeamLeadAgent } from './team-lead-bridge'

/**
 * Whether a restore() caller has an operator at the desktop app who could
 * answer a blocking approval dialog (card 64f8f629). A literal union, never
 * a boolean, so a call site names which one it means instead of an easily
 * inverted `!` -- ipc.ts, deck-control.ts and index.ts all import this same
 * alias rather than each declaring their own union.
 */
export type CallerAttendance = 'attended' | 'unattended'

/**
 * A single shell-field/untrusted-cwd approval gate's outcome (card
 * 64f8f629): 'declined' is the operator's own deliberate refusal at the
 * dialog: 'unattended' is a caller nobody could show that dialog to in the
 * first place, which restore() must report as its own reason rather than
 * folding into 'declined'.
 */
export type WorkspaceApprovalGateResult = 'approved' | 'declined' | 'unattended'

/**
 * Whether an attendance-gated approval must refuse outright, without ever
 * opening its dialog (card ffafeea6): true only for an 'unattended' caller
 * whose payload has no separate pre-approval to fall back on. Called by
 * every index.ts site that guards confirmShellFieldApproval's dialog --
 * confirmSpawnShellFields, resolveTemplateInputs, confirmWorkspaceShellFields,
 * confirmWorkspaceUntrustedCwd (each passes its own isShellFieldPreApproved
 * check as `alreadyApproved`). One definition of 'unattended' for all four
 * sinks, rather than one copy per site that could drift.
 */
export function refusesUnattendedApproval(attendance: CallerAttendance, alreadyApproved: boolean): boolean {
  return attendance === 'unattended' && !alreadyApproved
}

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

/**
 * THIS process's own actual start time (epoch ms, rounded to the nearest
 * second to absorb clock-read drift between two calls). Computed once at
 * construction and stamped into every lock this instance writes, so a LATER
 * liveness check can rule a lock provably dead across a reboot regardless of
 * pid recycling (card 438c15e3, review round 3) -- see `initialBootInstant`
 * for the other half of that comparison.
 */
function ownProcessStartedAt(): number {
  return Math.round((Date.now() - process.uptime() * 1000) / 1000) * 1000
}

/**
 * os.uptime() is monotonic since boot and unaffected by wall-clock adjustments,
 * and needs no subprocess -- cheaper than querying another process's start
 * time.
 * Sampled once and advanced via monotonic uptime deltas rather than re-reading
 * Date.now(), so a long-lived process doesn't drift across an NTP correction
 * mid-life.
 */
function initialBootInstant(): number {
  return Math.round((Date.now() - osUptime() * 1000) / 1000) * 1000
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
  adoptScope: (ws: { groupId: string; scopeKind: 'ephemeral' | 'custom' }) => void
  confirmShellFields: (ws: Workspace, attendance: CallerAttendance) => Promise<WorkspaceApprovalGateResult>
  confirmUntrustedCwd: (ws: Workspace, attendance: CallerAttendance) => Promise<WorkspaceApprovalGateResult>
  prepareModPlans?: (defs: ReadonlyArray<ReturnType<typeof fromWorkspaceSessions>[number]>, signal: AbortSignal) => Promise<RestorePlansResult>
  pid?: number
  host?: string
  /** THIS process's own actual start time (epoch ms). Test-injectable like
   *  `pid`/`host`; production default is `ownProcessStartedAt()`. */
  startedAt?: number
  /** Opens the same-host lock databases. Test-injectable like `pid`/`host`; production default is `openLockDatabase`. */
  openLock?: LockOpener
}

export class WorkspaceService {
  private readonly host: string
  private readonly pid: number
  private readonly startedAt: number
  /** `initialBootInstant()` sampled ONCE at construction -- see `currentBootInstant`. */
  private readonly bootAnchorInstant: number
  /** `process.uptime()` at the SAME instant as `bootAnchorInstant`, the monotonic
   *  reference `currentBootInstant` advances from afterward. */
  private readonly bootAnchorProcessUptime: number
  private currentId: string | null = null
  /** The same-host OS lock of `currentId`: this reference is what keeps it held. */
  private held: LockConnection | null = null
  private persistedName: { id: string; name: string } | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatFailureWorkspaceId: string | null = null
  private pruneTimer: NodeJS.Timeout | null = null
  private restoreOperation = 0
  private activeRestoreOperation: number | null = null
  private pendingRestoreId: string | null = null
  private restoreModPreparation: AbortController | null = null

  private invalidateRestore(): void {
    this.restoreModPreparation?.abort()
    this.restoreModPreparation = null
    this.activeRestoreOperation = null
    this.pendingRestoreId = null
  }

  constructor(private deps: WorkspaceDeps) {
    this.host = deps.host ?? hostname()
    this.pid = deps.pid ?? process.pid
    this.startedAt = deps.startedAt ?? ownProcessStartedAt()
    this.bootAnchorInstant = initialBootInstant()
    this.bootAnchorProcessUptime = process.uptime()
  }

  /**
   * This machine's boot instant, advanced from the one-time construction
   * sample via a monotonic PROCESS uptime delta rather than by re-reading
   * `Date.now()` -- immune to any wall-clock (NTP) correction that occurs
   * during this long-running instance's own lifetime (review round 5).
   * Residual, deliberately not addressed: if the wall clock was ALREADY
   * wrong at construction (before this instance's own first sample), the
   * anchor stays off for its whole lifetime; `isLockLive`'s heartbeat
   * condition is what bounds the damage in that case, not this method.
   */
  private currentBootInstant(): number {
    return this.bootAnchorInstant + Math.round((process.uptime() - this.bootAnchorProcessUptime) * 1000)
  }

  /**
   * Held by another instance: its same-host OS lock, or a live JSON lock that
   * is not ours. The one predicate behind the list badge and the restore
   * refusal. An unreadable JSON lock alone proves no owner.
   */
  private lockedByOther(id: string, now: number): boolean {
    if (this.currentId === id && this.held) return false
    if (probeSameHostLock(this.deps.projectDir, id, this.deps.openLock) !== 'free') return true
    const read = inspectLock(this.deps.projectDir, id)
    return read.kind === 'lock' && this.liveForeign(read.lock, now)
  }

  private liveForeign(lock: Lock, now: number): boolean {
    return (
      isLockLive(lock, {
        host: this.host,
        now,
        bootInstant: this.currentBootInstant(),
        isPidAlive: pidAlive,
        staleMs: LOCK_STALE_MS
      }) && !ownsLock(lock, { pid: this.pid, host: this.host })
    )
  }

  private releaseCurrent(): boolean {
    if (!this.currentId) return true
    const released = releaseLock(this.deps.projectDir, this.currentId, { pid: this.pid, host: this.host }, this.held)
    this.held = null
    return released
  }

  get currentWorkspaceId(): string | null {
    return this.currentId
  }

  /** Name last persisted for the CURRENT workspace; null when none is current or it was never persisted under that id. */
  get currentWorkspaceName(): string | null {
    if (!this.persistedName || this.persistedName.id !== this.currentId) return null
    return typeof this.persistedName.name === 'string' ? this.persistedName.name : null
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
      if (inspectLock(this.deps.projectDir, id).kind === 'unreadable') continue
      if (this.lockedByOther(id, now)) continue
      deleteWorkspace(this.deps.projectDir, id)
      pruned.push(id)
    }
    return pruned
  }

  /**
   * Own a workspace id: acquire its lock + (re)start the heartbeat. Returns
   * whether the lock was actually acquired -- `this.currentId` and the
   * heartbeat are only committed on success, never on the strength of the
   * caller's intent alone (card 438c15e3: the previous ordering stamped
   * `this.currentId = id` BEFORE knowing acquireLock()'s result, so a lost
   * race was invisible).
   */
  private own(id: string): boolean {
    // Not calling acquireLock() again while the OS lock is ours: it would wait
    // on that very lock. this.currentId is only an in-memory belief; the held
    // connection and the on-disk JSON decide.
    if (this.currentId === id && this.held) {
      const read = inspectLock(this.deps.projectDir, id)
      const mine = read.kind === 'lock' && ownsLock(read.lock, { pid: this.pid, host: this.host })
      if (mine || !(read.kind === 'lock' && this.liveForeign(read.lock, Date.now()))) {
        // A missing, unreadable or dead JSON lock is ours to rewrite: the OS
        // lock says no one else on this host can hold the workspace.
        if (!mine) this.stampCurrent(id)
        if (!this.heartbeatTimer) {
          this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_MS)
        }
        return true
      }
      // A live foreign JSON lock (another host, or a Deck without the OS
      // lock) took it: give ours back, the acquire below then refuses.
      releaseHeldLock(this.held)
      this.held = null
    }
    // The lock is written before saveWorkspace would create the tree, so a
    // fresh project dir (no .claude/claude-peers/workspaces yet) would ENOENT.
    // Create it up front -- own() is the first writer of any workspace file.
    ensureWorkspacesDir(this.deps.projectDir)
    const acquired = acquireLock(this.deps.projectDir, id, {
      pid: this.pid,
      host: this.host,
      startedAt: this.startedAt,
      now: Date.now(),
      bootInstant: this.currentBootInstant(),
      isPidAlive: pidAlive,
      staleMs: LOCK_STALE_MS,
      open: this.deps.openLock
    })
    if (!acquired) return false
    // Only release the PREVIOUS workspace's lock once the new one is
    // actually ours -- releasing it first (the old ordering) would strand
    // this instance owning neither workspace if the new acquire then failed.
    if (this.currentId && this.currentId !== id) this.releaseCurrent()
    this.held = acquired
    this.currentId = id
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_MS)
    }
    return true
  }

  private heartbeatTick(): void {
    if (!this.currentId || !this.heartbeatTimer) return
    const id = this.currentId
    try {
      const refreshed = refreshLock(this.deps.projectDir, id, Date.now(), {
        pid: this.pid,
        host: this.host
      })
      if (!refreshed) {
        const read = inspectLock(this.deps.projectDir, id)
        if (this.held && !(read.kind === 'lock' && this.liveForeign(read.lock, Date.now()))) {
          this.stampCurrent(id, false)
          if (this.heartbeatFailureWorkspaceId !== id) {
            reportError('workspace', `rewriting the missing, unreadable or dead JSON lock of the owned workspace ${id}`)
          }
        } else {
          // A foreign owner cannot be refreshed by this instance.
          reportError('workspace', `heartbeat lost ownership of workspace ${id}, stopping`)
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
          if (this.held) releaseHeldLock(this.held)
          this.held = null
        }
      }
      this.heartbeatFailureWorkspaceId = null
    } catch (error) {
      if (this.heartbeatFailureWorkspaceId !== id) {
        reportError('workspace', `heartbeat failed for workspace ${id}`, error)
        this.heartbeatFailureWorkspaceId = id
      }
    }
  }

  private stampCurrent(id: string, report = true): void {
    if (report) reportError('workspace', `rewriting the missing, unreadable or dead JSON lock of the owned workspace ${id}`)
    stampLock(this.deps.projectDir, id, { pid: this.pid, host: this.host, startedAt: this.startedAt, now: Date.now() })
  }

  /** Mint + own a fresh workspace if none is current yet, or reconfirm
   *  ownership of the current one. Returns whether a workspace is current
   *  AND still actually ours afterwards. `this.currentId` alone is an
   *  IN-MEMORY belief (review round 7): every persist() call (saveAuto,
   *  saveNamed) reaches this method, so an early `if (this.currentId) return
   *  true` here -- not just in own()'s own fast path -- is exactly the gap a
   *  third-party reclaim of the on-disk lock file would walk through
   *  unnoticed. Route through own(), which re-reads the lock and confirms
   *  identity via ownsLock before writing. */
  private ensureCurrent(): boolean {
    return this.own(this.currentId ?? newWorkspaceId())
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
    const result = this.persist(trimmed || undefined, true)
    // persist() only returns null when the workspace lock could not be
    // acquired (reportError() already traced it there) -- saveNamed's
    // contract is a non-null WorkspaceSummary or a thrown error, same shape
    // as the duplicate-name rejection above.
    if (!result) throw new Error('workspace-lock-unavailable')
    return result
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
   * Card 6363bd69: peeks at a not-yet-restored workspace's own sessions with
   * the SAME signal `restoreFrom()` itself recovers post-restore, so a caller
   * can start the deck-control endpoint proactively -- mirrors
   * template:apply's own `inputs.some(isTeamLeadAgent)` pre-check.
   */
  hasTeamLeadAgentSession(id: string): boolean {
    const ws = loadWorkspace(this.deps.projectDir, id)
    if (!ws) return false
    return ws.sessions.some((s) => isTeamLeadAgent(effectiveAgent(undefined, joinArgs(s.args)).agent))
  }

  async restore(id: string, attendance: CallerAttendance): Promise<WorkspaceRestoreResult> {
    if (this.activeRestoreOperation !== null) return { ok: false, reason: 'busy' }
    const operation = ++this.restoreOperation
    this.activeRestoreOperation = operation
    this.pendingRestoreId = id
    try {
      const ws = loadWorkspace(this.deps.projectDir, id)
      if (!ws) return { ok: false, reason: 'missing' }
      // restoreFrom replaces live sessions, so an empty snapshot is never applicable.
      if (ws.sessions.length === 0) return { ok: false, reason: 'empty' }
      if (this.lockedByOther(id, Date.now())) {
        return { ok: false, reason: 'locked' }
      }
      if (workspaceHasShellFields(ws)) {
        const gate = await this.deps.confirmShellFields(ws, attendance)
        if (this.activeRestoreOperation !== operation) return { ok: false, reason: 'superseded' }
        if (this.lockedByOther(id, Date.now())) return { ok: false, reason: 'locked' }
        if (gate === 'declined') return { ok: false, reason: 'shell-declined' }
        if (gate === 'unattended') return { ok: false, reason: 'unattended' }
      }
      if (workspaceHasUntrustedCwd(ws, this.deps.projectDir)) {
        const gate = await this.deps.confirmUntrustedCwd(ws, attendance)
        if (this.activeRestoreOperation !== operation) return { ok: false, reason: 'superseded' }
        if (this.lockedByOther(id, Date.now())) return { ok: false, reason: 'locked' }
        if (gate === 'declined') return { ok: false, reason: 'cwd-declined' }
        if (gate === 'unattended') return { ok: false, reason: 'unattended' }
      }
      const defs = fromWorkspaceSessions(ws.sessions)
      this.restoreModPreparation?.abort()
      const controller = new AbortController()
      this.restoreModPreparation = controller
      const prepared = this.deps.prepareModPlans
        ? await this.deps.prepareModPlans(defs, controller.signal)
        : { ok: true as const, plans: new Map() }
      if (!prepared.ok) return { ok: false, reason: 'superseded' }
      if (this.activeRestoreOperation !== operation) return { ok: false, reason: 'superseded' }
      if (this.lockedByOther(id, Date.now())) return { ok: false, reason: 'locked' }
      this.deps.adoptScope({ groupId: ws.groupId, scopeKind: ws.scopeKind })
      this.deps.setConfig(fromDisplayMode(ws.displayMode))
      this.deps.service.restoreFrom(defs, prepared.plans)
      if (!this.own(id)) {
        reportError(
          'workspace',
          `restore(${id}) lost the lock race after swapping sessions -- ownership unresolved`
        )
        // When own() fails here after restoreFrom() already swapped sessions,
        // this.currentId would otherwise still point at the OLD workspace while
        // the live sessions belong to the NEW one, letting a debounced auto-save
        // silently overwrite the OLD workspace's file with the NEW workspace's
        // sessions.
        // The currentId reset below closes that path; releaseLock's result is
        // still checked and traced rather than ignored.
        if (this.currentId && !this.releaseCurrent()) {
          reportError(
            'workspace',
            `restore(${id}) skipped releaseLock for ${this.currentId}: on-disk lock owned by another identity`
          )
        }
        this.currentId = null
        return { ok: false, reason: 'lock-race' }
      }
      this.persistedName = { id, name: ws.name }
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
      return { ok: true }
    } finally {
      if (this.activeRestoreOperation === operation) {
        this.restoreModPreparation = null
        this.activeRestoreOperation = null
        this.pendingRestoreId = null
      }
    }
  }

  deleteWs(id: string): void {
    if (id === this.pendingRestoreId) this.invalidateRestore()
    if (id === this.currentId) {
      if (this.held) releaseHeldLock(this.held)
      this.held = null
      this.currentId = null
    }
    deleteWorkspace(this.deps.projectDir, id)
  }

  /**
   * "New (clear)": detach from the current workspace so the next created session
   * mints a fresh one. Captures a final auto-save (while sessions still exist --
   * call this BEFORE SessionService.closeAll) and releases the lock; the prior
   * workspace is kept restorable, not deleted.
   */
  startNew(): void {
    this.invalidateRestore()
    if (!this.currentId) return
    this.saveAuto()
    if (!this.releaseCurrent()) {
      reportError(
        'workspace',
        `startNew() skipped releaseLock for ${this.currentId}: on-disk lock owned by another identity`
      )
    }
    this.currentId = null
  }

  /** All workspaces for this project, with lock + current flags, newest first. */
  listForCwd(): WorkspaceSummary[] {
    const now = Date.now()
    return listWorkspaces(this.deps.projectDir).map((ws) => {
      const lockedByOther = ws.id !== this.currentId && this.lockedByOther(ws.id, now)
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
    this.invalidateRestore()
    // A failed final save still propagates to the quit effect that traces it,
    // but must not leave the lock behind.
    let saveFailed = false
    let saveError: unknown
    if (this.currentId) {
      try {
        this.saveAuto()
      } catch (e) {
        saveFailed = true
        saveError = e
      }
    }
    try {
      if (this.currentId && !this.releaseCurrent()) {
        // Lost the acquire race earlier without this instance noticing (or a
        // second Deck reclaimed after this one went stale): deleting the lock
        // file here would tear down a live instance's ownership.
        reportError(
          'workspace',
          `releaseOnQuit skipped releaseLock for ${this.currentId}: on-disk lock owned by another identity`
        )
      }
    } catch (releaseError) {
      if (!saveFailed) throw releaseError
      reportError('workspace', 'releaseOnQuit: lock release failed after a failed final save', releaseError)
    } finally {
      // Stopped after the save, which restarts the heartbeat through own().
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      if (this.pruneTimer) clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    if (saveFailed) throw saveError
  }

  // ----- internals -----

  private persist(name: string | undefined, pin: boolean): WorkspaceSummary | null {
    if (!this.ensureCurrent()) {
      reportError('workspace', 'persist() skipped: could not acquire the workspace lock')
      return null
    }
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
    this.persistedName = { id: saved.id, name: saved.name }
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
