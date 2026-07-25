import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AppConfig,
  CreateSessionInput,
  SessionDef,
  SessionRuntime,
  SessionStatus
} from '@shared/types'
import { PtyManager } from './pty-manager'
import { resolvePeerId } from './peer-state'
import { saveSessions } from './store'
import { buildSessionCommandLine, sanitizeFlagValue, type SpawnMode } from './session-command'
import { ThinkingDetector, type ThinkingEvent } from './thinking'
import {
  QuotaDetector,
  type QuotaClearEvent,
  type QuotaLimitEvent,
  type QuotaResumeDueEvent
} from './quota'
import { AttentionDetector, type AttentionEvent } from './attention'
import { StartupAckDetector, type StartupAckEvent } from './startup-ack'
import { OpenIdRegistry } from './open-id-registry'
import {
  listTranscriptIds,
  pickDiscoveredId,
  transcriptExists,
  type TranscriptEntry
} from './session-transcript'
import { clearDeskSessionId, readDeskSessionId } from './desk-session'
import { reportError } from './log'
import { DEFAULT_PALETTE, paletteColor } from '@shared/palette'
import { reconcileOrder } from '@shared/reorder'
import type { JoinAnnounceIntent } from '@shared/announce'

interface RuntimeState {
  status: SessionStatus
  exitCode: number | null
  peerId: string | null
  thinking: boolean
  /** Restore-time: persisted id had no transcript, so it was not resumed. */
  expired: boolean
  /** True while the session sits at a usage-limit screen (quota.ts). */
  rateLimited: boolean
  /** Epoch ms of the announced quota reset, or null when unknown/not limited. */
  resumeAt: number | null
  /** True while the session waits for the operator (attention.ts, PLAN C11). */
  needsAttention: boolean
  /**
   * One-shot join-announce intent for a FRESH session. Set on create(), null on
   * restore (a resumed peer was already announced). Consumed (cleared) the first
   * time the peer_id resolves, when `peer-resolved` is emitted for the Deck to
   * broadcast. null => no announce.
   */
  announce: JoinAnnounceIntent | null
}

const PEER_POLL_MS = 4000
/** Discovery: poll cadence + deadline to capture Claude's real (minted) session id. */
const DISCOVERY_POLL_MS = 800
const DISCOVERY_DEADLINE_MS = 30_000

/**
 * Directive injection (CT3): a command is only typed into a tile that is idle,
 * so a /clear or /compact never lands mid-turn. When the tile is busy the
 * injection waits up to DIRECTIVE_IDLE_WAIT_MS (polling every
 * DIRECTIVE_IDLE_POLL_MS) for it to fall idle, else reports a skip.
 * DIRECTIVE_SETTLE_MS mirrors the autoResume settle between Escape and the text.
 */
const DIRECTIVE_IDLE_WAIT_MS = 120_000
const DIRECTIVE_IDLE_POLL_MS = 500
const DIRECTIVE_SETTLE_MS = 120

/** Dev-channels warning auto-ack: let the dialog finish painting first. */
const STARTUP_ACK_SETTLE_MS = 350
/** Rolling cap for the magic-compact output scanner (CT4). */
const OUTPUT_SCAN_CAP = 65536

/** Outcome of injectCommand, journaled by the caller (CT3). */
export type DirectiveOutcome = 'sent' | 'no-terminal' | 'busy-timeout'

/**
 * Sandbox wrapper (PLAN-SANDBOX SBX1), injected by index.ts. `wrap` receives
 * the fully-composed session command line + host cwd + session env and returns
 * the replacement PTY command (`docker exec … bash /kory-run/cmd-<id>.sh`),
 * writing the launch script as a side effect. Kept as a narrow interface so
 * this service never imports the engine service (and stays electron-lean).
 */
export interface SandboxWrapper {
  wrap(sessionId: string, command: string, cwdHost: string, env: Record<string, string>): string
}
/** null = sandbox off. MAY THROW when enabled but the container is not ready. */
export type SandboxProvider = () => SandboxWrapper | null

/**
 * Container-side transcript lookup (PLAN-SANDBOX M2 resume). In sandbox mode
 * transcripts live in the auth VOLUME (`~/.claude/projects/...` inside the
 * container), invisible to the host readers — so resume must consult this
 * instead. Returns null when the sandbox is off (host files are authoritative)
 * and NEVER throws: the spawn path stays synchronous, reading a cache the
 * sandbox service refreshes on ensure / before restore.
 */
export type SandboxTranscriptLookup = (cwdHost: string) => TranscriptEntry[] | null

/**
 * Coordinates the persisted session list, the live PTYs and the resolved
 * peer_id. Emits `data` / `exit` (forwarded to the renderer verbatim) and
 * `changed` (a fresh SessionRuntime[] whenever status/peer_id moves).
 */
export class SessionService extends EventEmitter {
  private defs: SessionDef[]
  private runtime = new Map<string, RuntimeState>()
  private pty = new PtyManager()
  private thinkingDetector = new ThinkingDetector()
  private quotaDetector = new QuotaDetector()
  private attentionDetector = new AttentionDetector()
  private startupAckDetector = new StartupAckDetector()
  private pollTimer: NodeJS.Timeout | null = null

  /**
   * Epoch ms of the last PTY output per session (PLAN K2): the "is the agent
   * really doing something" signal the roadmap lock-release watcher reads.
   * Updated on every data event, so it is kept out of RuntimeState (no
   * broadcast churn).
   */
  private outputAt = new Map<string, number>()
  /** Sessions whose dead-PTY write was already reported once (O6, anti-spam). */
  private deadWriteReported = new Set<string>()

  /** Live (post-fork) claude session ids open in this process; double-resume guard. */
  private registry = new OpenIdRegistry()

  constructor(
    private getConfig: () => AppConfig,
    /**
     * Forced-group scope env merged into every spawned PTY (see scope.ts).
     * A getter (not a snapshot) so the app can ADOPT a different scope at restore
     * before any session has spawned (DESIGN 6.6).
     */
    private getScopeEnv: () => Record<string, string> = () => ({}),
    /** Resolved base command (launch-config) used when a session has no override. */
    private launchCommand = '',
    /**
     * Absolute path to the Deck's embedded plugin dir, injected as `--plugin-dir`
     * on every spawn so the SessionStart back-channel hook keeps each tile's
     * session id current across /clear. Empty => no plugin flag (resolved by
     * index.ts; only set when the dir exists).
     */
    private pluginDir = '',
    /** Home dir for transcript existence checks (injectable for tests). */
    private home: string = homedir()
  ) {
    super()
    // Start empty: the app no longer auto-restores the legacy sessions.json on
    // launch (operator request). The previous run is recovered explicitly via a
    // workspace restore.
    this.defs = []

    this.pty.on('data', (e: { id: string; data: string }) => {
      this.emit('data', e)
      this.outputAt.set(e.id, Date.now())
      this.thinkingDetector.feed(e.id, e.data)
      this.quotaDetector.feed(e.id, e.data)
      this.attentionDetector.feed(e.id, e.data)
      this.startupAckDetector.feed(e.id, e.data)
    })
    this.pty.on('exit', ({ id, exitCode }: { id: string; exitCode: number }) => {
      // pty-manager only emits 'exit' for a spontaneous process exit (the user
      // typed /exit, or claude crashed) -- never for a kill() / restart, which it
      // filters out. So here we own the close decision.
      // The id is no longer live -> free the double-resume guard (a later restart
      // re-registers the fresh forked id).
      const def = this.defs.find((d) => d.id === id)
      if (def?.sessionId) this.registry.release(def.sessionId)
      this.thinkingDetector.clear(id)
      this.quotaDetector.clear(id)
      this.attentionDetector.clear(id)
      this.startupAckDetector.clear(id)

      // A clean exit (/exit -> shell returns 0) auto-closes the tile, the way a
      // terminal tab closes when its shell exits, so it never lingers as a dead,
      // non-interactive zombie. A non-zero exit (crash) is kept on screen in the
      // 'exited' state so the error stays visible and the tile can be restarted.
      if (exitCode === 0) {
        this.defs = this.defs.filter((d) => d.id !== id)
        this.runtime.delete(id)
        this.persist()
        // name rides along for the journal (C14); the renderer ignores it.
        this.emit('exit', { id, exitCode, name: def?.name })
        this.broadcast()
        return
      }

      const r = this.runtime.get(id)
      if (r) {
        r.status = 'exited'
        r.exitCode = exitCode
        r.thinking = false
      }
      this.emit('exit', { id, exitCode, name: def?.name })
      this.broadcast()
    })

    // Forward busy/idle transitions as `thinking` (ipc -> session:thinking).
    this.thinkingDetector.on('thinking', ({ id, busy }: ThinkingEvent) => {
      const r = this.runtime.get(id)
      if (!r) return
      r.thinking = busy
      this.emit('thinking', { id, busy })
    })

    // Quota episodes (ipc -> session:quota). The detector observes/schedules;
    // the injection decision (enabled? alive? still limited?) is made here.
    this.quotaDetector.on('limit', ({ id, resetAt }: QuotaLimitEvent) => {
      const r = this.runtime.get(id)
      if (!r) return
      r.rateLimited = true
      r.resumeAt = resetAt
      this.emit('quota', { id, limited: true, resetAt })
      this.broadcast()
    })
    this.quotaDetector.on('clear', ({ id }: QuotaClearEvent) => {
      const r = this.runtime.get(id)
      if (!r || !r.rateLimited) return
      r.rateLimited = false
      r.resumeAt = null
      this.emit('quota', { id, limited: false, resetAt: null })
      this.broadcast()
    })
    this.quotaDetector.on('resume-due', ({ id }: QuotaResumeDueEvent) => this.autoResume(id))

    // "Needs you" transitions (PLAN C11): runtime flag + event for the system
    // notification in index.ts (ipc -> session:attention).
    this.attentionDetector.on('attention', ({ id, waiting }: AttentionEvent) => {
      const r = this.runtime.get(id)
      if (!r || r.needsAttention === waiting) return
      r.needsAttention = waiting
      this.emit('attention', { id, waiting })
      this.broadcast()
    })

    // Development-channels warning auto-ack (issue #42486): one Enter after a
    // short settle activates the dialog's highlighted accept option, for EVERY
    // session the Deck spawns (operator create, supervisor, template, restart).
    // The detector fires once per process run; liveness is re-checked at send
    // time. 'startup-ack' is journaled by index.ts so each ack leaves a trace.
    this.startupAckDetector.on('ack', ({ id }: StartupAckEvent) => {
      setTimeout(() => {
        const r = this.runtime.get(id)
        if (!r || r.status === 'exited') return
        this.pty.write(id, '\r')
        const name = this.defs.find((d) => d.id === id)?.name
        this.emit('startup-ack', { id, name })
      }, STARTUP_ACK_SETTLE_MS)
    })
  }

  /**
   * Swap the resolved base launch command (PLAN C19: a PROJECT-sourced
   * launchCommand only lands here after operator approval). Affects future
   * spawns only; live PTYs keep running what they started with.
   */
  setLaunchCommand(command: string): void {
    this.launchCommand = command
  }

  // ----- sandbox mode (PLAN-SANDBOX SBX1/SBX3) -----

  /** Injected after construction (index.ts) — a setter, like setLaunchCommand. */
  private getSandboxWrapper: SandboxProvider = () => null

  /** Container-side transcript lookup; default = "sandbox off, use the host". */
  private sandboxTranscripts: SandboxTranscriptLookup = () => null
  /** Peers dir the sandbox containers write into, or null when sandbox is off. */
  private sandboxPeersDir: () => string | null = () => null

  setSandboxProvider(
    provider: SandboxProvider,
    transcripts?: SandboxTranscriptLookup,
    peersDir?: () => string | null
  ): void {
    this.getSandboxWrapper = provider
    if (transcripts) this.sandboxTranscripts = transcripts
    if (peersDir) this.sandboxPeersDir = peersDir
  }

  /**
   * Transcripts visible for a session's cwd: the container's when the sandbox
   * owns them, the host's otherwise. One accessor so every resume/discovery
   * site stays consistent (M2).
   */
  private transcriptsOf(cwd: string): TranscriptEntry[] {
    return this.sandboxTranscripts(cwd) ?? listTranscriptIds(this.home, cwd)
  }

  private hasTranscript(cwd: string, id: string): boolean {
    if (!id) return false
    const sandboxed = this.sandboxTranscripts(cwd)
    if (sandboxed) return sandboxed.some((e) => e.id === id)
    return transcriptExists(this.home, cwd, id)
  }

  /**
   * Utility PTYs (the sandbox auth terminal): same PtyManager, so pty:input /
   * pty:resize / pty:data route for free through the existing ipc channels,
   * but the id never enters `defs` — invisible to sessions:list,
   * hasLiveSessions() and workspace capture. Detector feeds on its output are
   * inert (no runtime entry for the id).
   */
  spawnUtility(id: string, cwd: string, opts: { command: string; shell: string; interactive: boolean }): void {
    this.pty.spawn(id, cwd, opts, {})
  }

  killUtility(id: string): void {
    this.pty.kill(id)
  }

  isUtilityAlive(id: string): boolean {
    return this.pty.isAlive(id)
  }

  /** Start the peer_id poll. No auto-restore: the app opens empty (see ctor). */
  start(): void {
    this.pollTimer = setInterval(() => this.pollPeerIds(), PEER_POLL_MS)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.thinkingDetector.stop()
    this.quotaDetector.stop()
    this.attentionDetector.stop()
    this.startupAckDetector.stop()
    this.pty.killAll()
  }

  list(): SessionRuntime[] {
    return this.defs.map((d) => this.toRuntime(d))
  }

  /** True if any session PTY is currently alive (scope is locked once true). */
  hasLiveSessions(): boolean {
    return this.defs.some((d) => this.pty.isAlive(d.id))
  }

  create(input: CreateSessionInput): SessionRuntime {
    const cfg = this.getConfig()
    // B6: agent/model are structured identifiers that get interpolated into the
    // login-shell command line, so they are allow-listed (sanitizeFlagValue) and
    // double-quoted — a template- or companion-supplied `model: "x$(cmd)"` can no
    // longer reach the shell. The double quotes also suppress `[1m]` glob
    // expansion of the 1M-context model form. `input.args` stays a free-form
    // shell fragment: after B4 (template approval) / B5 every path that reaches
    // here is operator-authorized (advanced menu, approved template, trusted
    // companion cred), so it is not further escaped.
    const agent = sanitizeFlagValue(input.agent ?? '')
    const model = sanitizeFlagValue(input.model ?? '')
    const args = [
      agent ? `--agent "${agent}"` : '',
      model ? `--model "${model}"` : '',
      input.args?.trim() || ''
    ]
      .filter(Boolean)
      .join(' ')
    const def: SessionDef = {
      id: randomUUID(),
      name: input.name?.trim() || this.defaultName(agent),
      cwd: input.cwd?.trim() || cfg.projectDir,
      // Empty => the resolved launchCommand; a non-empty value overrides it.
      command: input.command?.trim() || '',
      args,
      sessionId: '',
      color: input.color?.trim() || paletteColor(cfg.palette ?? DEFAULT_PALETTE, this.defs.length),
      effort: input.effort?.trim() || '',
      prompt: input.prompt?.trim() || '',
      // Filled by the ipc layer after `git worktree add` (PLAN C4).
      worktree: input.worktree,
      // Supervisor session (PLAN C5/C8): main-only inputs.
      supervisor: input.supervisor || undefined,
      // Team-lead (PLAN C10): explicit flag; uniqueness enforced below.
      lead: input.lead && !input.supervisor ? true : undefined,
      mcpConfig: input.mcpConfig?.trim() || undefined,
      appendSystemPromptFile: input.appendSystemPromptFile?.trim() || undefined,
      createdAt: Date.now()
    }
    // Single team-lead per window: designating a new one demotes the previous.
    if (def.lead) {
      for (const d of this.defs) delete d.lead
    }
    this.defs.push(def)
    this.runtime.set(def.id, {
      status: 'starting',
      exitCode: null,
      peerId: null,
      thinking: false,
      expired: false,
      rateLimited: false,
      resumeAt: null,
      needsAttention: false,
      // Fresh session -> announce its arrival once the peer_id resolves. The
      // advanced menu may supply a custom note; otherwise the agent/model/effort
      // default is composed downstream.
      announce: {
        custom: input.announce?.trim() || null,
        agent,
        model,
        effort: def.effort ?? ''
      }
    })
    this.spawnSession(def, 'fresh')
    this.broadcast()
    // Journal hook (PLAN C14): index.ts narrates spawns without diffing lists.
    this.emit('created', this.toRuntime(def))
    return this.toRuntime(def)
  }

  remove(id: string): void {
    const def = this.defs.find((d) => d.id === id)
    if (def) this.emit('removed', { id: def.id, name: def.name })
    if (def?.sessionId) this.registry.release(def.sessionId)
    this.pty.kill(id)
    this.thinkingDetector.clear(id)
    this.quotaDetector.clear(id)
    this.attentionDetector.clear(id)
    this.startupAckDetector.clear(id)
    this.defs = this.defs.filter((d) => d.id !== id)
    this.runtime.delete(id)
    this.outputAt.delete(id)
    this.persist()
    this.broadcast()
  }

  /**
   * Close every session (graceful PTY kill) and clear the set -- the "New
   * (clear)" action. No-op when already empty. Broadcasts an empty list; the
   * caller is expected to have detached/saved the current workspace first
   * (WorkspaceService.startNew), and the index.ts auto-save guard ignores the
   * empty broadcast so the prior workspace stays restorable.
   */
  closeAll(): void {
    if (this.defs.length === 0) return
    for (const d of this.defs) {
      if (d.sessionId) this.registry.release(d.sessionId)
    }
    this.pty.killAll()
    this.thinkingDetector.stop()
    this.quotaDetector.stop()
    this.attentionDetector.stop()
    this.startupAckDetector.stop()
    this.defs = []
    this.runtime.clear()
    this.outputAt.clear()
    this.persist()
    this.broadcast()
  }

  /**
   * Re-read each live tile's back-channel and adopt a changed REAL session id.
   * The discovery track (discoverRealId) is a one-shot that closes after 30s, so
   * an in-process rotation that happens later -- notably a `/clear`, which mints a
   * fresh transcript without re-registering the MCP -- is invisible to it. The
   * SessionStart hook keeps desk-session-<token>.txt current across those
   * rotations; this picks the new id up at save time so the persisted (and thus
   * restorable) id is the post-/clear one, not the stale pre-/clear id. Adopts
   * only when the new id actually has a transcript (i.e. it is resumable).
   *
   * Called by WorkspaceService before captureSessions(); kept off the template
   * path (ipc.ts) so capturing a template never mutates live session ids.
   */
  refreshLiveSessionIds(): void {
    for (const def of this.defs) {
      if (!this.pty.isAlive(def.id)) continue
      const back = readDeskSessionId(def.id, this.peersDirFor(def))
      if (back && back !== def.sessionId && this.hasTranscript(def.cwd, back)) {
        this.adoptRealId(def, def.sessionId, back)
      }
    }
  }

  /**
   * Snapshot the current persisted session defs (for a workspace save). The
   * supervisor is excluded: its deck-control token only lives for this app
   * launch, and Home re-spawns it on demand -- restoring it as a normal tile
   * would resurrect a dead bridge.
   */
  captureSessions(): SessionDef[] {
    return this.defs.filter((d) => !d.supervisor).map((d) => ({ ...d }))
  }

  /**
   * Replace the session set with a restored one and spawn them in parallel
   * (ids known up front, DESIGN 6.2). Each def is resume-forked unless its
   * transcript is missing (expired -> flagged, not spawned) or its id is already
   * open in this process (double-resume guard).
   */
  restoreFrom(defs: SessionDef[]): SessionRuntime[] {
    // Tear down whatever is currently live.
    this.pty.killAll()
    this.thinkingDetector.stop()
    this.quotaDetector.stop()
    this.attentionDetector.stop()
    this.startupAckDetector.stop()
    for (const d of this.defs) {
      if (d.sessionId) this.registry.release(d.sessionId)
    }
    this.runtime.clear()
    this.outputAt.clear()
    this.defs = defs.map((d, i) => ({
      ...d,
      color: d.color || paletteColor(this.getConfig().palette ?? DEFAULT_PALETTE, i)
    }))
    // Restored data may carry several leads (hand-edited file): keep the first.
    let leadSeen = false
    for (const d of this.defs) {
      if (d.lead && leadSeen) delete d.lead
      if (d.lead) leadSeen = true
    }
    for (const d of this.defs) {
      this.runtime.set(d.id, {
        status: 'exited',
        exitCode: null,
        peerId: null,
        thinking: false,
        expired: false,
        rateLimited: false,
        resumeAt: null,
        needsAttention: false,
        // Restored peers were already announced on their original join -> no
        // re-announce on restore.
        announce: null
      })
    }
    this.persist()
    for (const d of this.defs) this.spawnSession(d, 'resume')
    this.broadcast()
    return this.list()
  }

  rename(id: string, name: string): void {
    const def = this.defs.find((d) => d.id === id)
    if (!def) return
    def.name = name.trim() || def.name
    this.persist()
    this.broadcast()
  }

  setColor(id: string, color: string): void {
    const def = this.defs.find((d) => d.id === id)
    if (!def || !color.trim()) return
    def.color = color.trim()
    this.persist()
    this.broadcast()
  }

  /**
   * Designate `id` as the window's team-lead (PLAN C10). Explicit and unique:
   * the previous lead is demoted; the supervisor can never be the lead.
   */
  setLead(id: string): void {
    const def = this.defs.find((d) => d.id === id)
    if (!def || def.supervisor) return
    for (const d of this.defs) delete d.lead
    def.lead = true
    this.persist()
    this.broadcast()
  }

  /** The current team-lead runtime, if any. */
  getLead(): SessionRuntime | null {
    const def = this.defs.find((d) => d.lead)
    return def ? this.toRuntime(def) : null
  }

  /**
   * Epoch ms of the last PTY output for a session, or null if it never wrote
   * (PLAN K2: idleness signal for the roadmap lock-release watcher).
   */
  lastOutputAt(id: string): number | null {
    return this.outputAt.get(id) ?? null
  }

  /** Per-session quota auto-resume override (context menu). Persisted. */
  setAutoResume(id: string, enabled: boolean): void {
    const def = this.defs.find((d) => d.id === id)
    if (!def) return
    def.autoResume = enabled
    this.persist()
    this.broadcast()
  }

  /**
   * Reorder the session list to match `orderedIds` (drag-and-drop). The new order
   * drives both the sidebar and the tile grid (they map the same list) and is
   * persisted, so it survives restart/restore. Unknown ids are dropped and any
   * live def missing from the list is kept at the end (stale-renderer safety).
   */
  reorder(orderedIds: string[]): void {
    this.defs = reconcileOrder(this.defs, orderedIds)
    this.persist()
    this.broadcast()
  }

  /**
   * Restart a session. A normal session fork-resumes its last id; an EXPIRED one
   * (no transcript) starts fresh with the stored args (the "start new" action of
   * the expired overlay) by clearing its dead id first.
   */
  restart(id: string): SessionRuntime {
    const def = this.defs.find((d) => d.id === id)
    if (!def) throw new Error(`unknown session ${id}`)
    // spawnSession downgrades to a fresh launch automatically when there is no
    // transcript to resume, so a single 'resume' request covers both cases.
    this.spawnSession(def, 'resume')
    this.broadcast()
    return this.toRuntime(def)
  }

  write(id: string, data: string): void {
    // Writing into a dead PTY is a silent no-op at the pty layer; leave one
    // trace per session so "I type and nothing happens" is diagnosable (O6).
    if (!this.pty.write(id, data) && !this.deadWriteReported.has(id)) {
      this.deadWriteReported.add(id)
      const name = this.defs.find((d) => d.id === id)?.name ?? id.slice(0, 8)
      reportError('session', `input dropped: session "${name}" has no live terminal`)
    }
  }

  resize(id: string, cols: number, rows: number): void {
    this.pty.resize(id, cols, rows)
  }

  // ----- internals -----

  /**
   * Spawn a session's PTY IMMEDIATELY (terminal visible at once), then discover
   * Claude's real (minted) session id in the BACKGROUND -- it ignores our
   * --session-id in an interactive PTY + MCP context (see session-transcript).
   * The spawn is never gated behind another session's discovery, so adding /
   * restoring multiple sessions is instant and parallel. A resume whose stored
   * REAL id has no transcript is flagged expired and not spawned.
   */
  private spawnSession(def: SessionDef, mode: SpawnMode): void {
    const r = this.runtime.get(def.id)
    if (!r) return // removed before we got here

    let effectiveMode: SpawnMode = mode
    if (mode === 'resume') {
      if (def.sessionId && this.registry.has(def.sessionId)) return // already live
      // Resume only if there is actually a transcript to resume. A session that
      // was opened but never used leaves no transcript -> there is nothing to
      // resume, so start it FRESH (a working terminal) rather than show a scary
      // "expired" overlay. Claude writes the transcript only after real activity.
      if (!def.sessionId || !this.hasTranscript(def.cwd, def.sessionId)) {
        effectiveMode = 'fresh'
        def.sessionId = '' // -> startPty mints a new id
      }
    }
    r.expired = false

    const before = new Set(this.transcriptsOf(def.cwd).map((e) => e.id))
    this.startPty(def, effectiveMode) // INSTANT
    // Fire-and-forget: discovery must never block terminal visibility.
    void this.discoverRealId(def, before)
  }

  /**
   * Poll the project's transcript dir until the new (Claude-minted) id appears,
   * then adopt it as def.sessionId so the next resume targets the right transcript.
   * Aborts if the PTY dies first or the deadline passes.
   */
  /** ~/.claude/peers dir, derived from the injected home so tests can redirect it. */
  private peersDir(): string {
    return join(this.home, '.claude', 'peers')
  }

  /**
   * Where THIS session's back-channel / peer cache lives. A sandboxed session
   * writes inside its container, into the Deck-owned dir mounted there — never
   * the host `~/.claude/peers`, which stays out of every container's reach
   * (sandbox-command.ts peersDirHost explains why). The supervisor is never
   * sandboxed, so it keeps the host dir.
   */
  private peersDirFor(def: SessionDef): string {
    if (def.supervisor) return this.peersDir()
    return this.sandboxPeersDir() ?? this.peersDir()
  }

  private async discoverRealId(def: SessionDef, before: Set<string>): Promise<void> {
    const placeholder = def.sessionId
    const deadline = Date.now() + DISCOVERY_DEADLINE_MS
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, DISCOVERY_POLL_MS))
      if (!this.pty.isAlive(def.id)) return // died before writing anything

      // Preferred: the deterministic back-channel file keyed by this tile's token
      // (CLAUDE_PEERS_DESK_SESSION = def.id). server.ts writes the real minted id
      // there at /register, so there is no same-cwd ambiguity (D1/D2/D10).
      const back = readDeskSessionId(def.id, this.peersDirFor(def))
      if (back && back !== def.sessionId) {
        this.adoptRealId(def, placeholder, back)
        return
      }

      // Fallback for an older core without the back-channel writer: pick the
      // newest unclaimed transcript that appeared since spawn.
      const claimed = this.registry.snapshot()
      claimed.delete(placeholder) // our own placeholder must not block the match
      const realId = pickDiscoveredId(this.transcriptsOf(def.cwd), before, claimed)
      if (realId && realId !== def.sessionId) {
        this.adoptRealId(def, placeholder, realId)
        return
      }
    }
  }

  /** Swap a session's placeholder id for the discovered real one + persist/notify. */
  private adoptRealId(def: SessionDef, placeholder: string, realId: string): void {
    this.registry.release(placeholder)
    def.sessionId = realId
    this.registry.add(realId)
    this.persist()
    this.broadcast()
  }

  private startPty(def: SessionDef, mode: SpawnMode): void {
    const cfg = this.getConfig()
    const base = def.command.trim() || this.launchCommand

    let command: string
    if (mode === 'resume' && def.sessionId) {
      // Fork the previous claude session into a fresh id (collision avoidance).
      const prev = def.sessionId
      def.sessionId = randomUUID()
      command = buildSessionCommandLine({
        baseCommand: base,
        sessionId: def.sessionId,
        prevSessionId: prev,
        effort: def.effort,
        pluginDir: this.pluginDir,
        mcpConfig: def.mcpConfig,
        appendSystemPromptFile: def.appendSystemPromptFile,
        mode: 'resume'
      })
    } else {
      // Fresh launch (or a session that has never spawned yet).
      if (!def.sessionId) def.sessionId = randomUUID()
      command = buildSessionCommandLine({
        baseCommand: base,
        sessionId: def.sessionId,
        args: def.args,
        effort: def.effort,
        pluginDir: this.pluginDir,
        prompt: def.prompt,
        mcpConfig: def.mcpConfig,
        appendSystemPromptFile: def.appendSystemPromptFile,
        mode: 'fresh'
      })
    }

    // Track the live (post-fork) id for the double-resume guard.
    this.registry.add(def.sessionId)

    const r = this.runtime.get(def.id)

    // Session env, also handed to the sandbox wrapper (which translates the
    // host-only transports before exporting them container-side).
    const sessionEnv = { ...this.getScopeEnv(), CLAUDE_PEERS_DESK_SESSION: def.id }

    // Sandbox mode (SBX1): wrap the composed command in a `docker exec` into
    // the project container. The supervisor is exempt — it pilots the Deck
    // from the host and its MCP harness (Electron binary + loopback control
    // url) does not exist container-side. The gated create path (sandboxGate
    // in create-session.ts) has already ensured the container + auth; a
    // throw here only happens on ungated paths (workspace restore with a
    // cold container) where a visibly-exited tile beats a login prompt in
    // every tile (SBX3).
    if (!def.supervisor) {
      try {
        const wrapper = this.getSandboxWrapper()
        if (wrapper) command = wrapper.wrap(def.sessionId, command, def.cwd, sessionEnv)
      } catch (e) {
        reportError('sandbox', `sandboxed spawn refused for "${def.name}"`, e)
        if (r) {
          r.status = 'exited'
          r.exitCode = -1
        }
        this.persist()
        return
      }
    }
    if (r) {
      r.status = 'running'
      r.exitCode = null
      r.expired = false
      r.rateLimited = false
      r.resumeAt = null
      r.needsAttention = false
    }
    // Fresh process -> fresh detector state (stale buffers/timers dropped).
    this.quotaDetector.clear(def.id)
    this.attentionDetector.clear(def.id)
    this.startupAckDetector.clear(def.id)
    // sessionId may have just changed (fork-resume) -> persist before/after spawn.
    this.persist()
    // Drop any stale back-channel file from a previous run so discovery cannot
    // read an old id; the core rewrites it with the fresh minted id at register.
    clearDeskSessionId(def.id, this.peersDirFor(def))
    try {
      this.pty.spawn(
        def.id,
        def.cwd,
        { command, shell: cfg.shell, interactive: cfg.interactiveShell },
        // Per-tile token: server.ts writes the real session id keyed by it (D1/D2/D10).
        sessionEnv
      )
      this.deadWriteReported.delete(def.id)
    } catch (e) {
      // node-pty throws synchronously on a bad cwd / missing shell binary.
      // Without this catch the def was already pushed but never broadcast: an
      // invisible zombie (O6). Mark the tile exited so the operator sees a
      // dead tile whose Restart retries the spawn.
      reportError('session', `spawn failed for "${def.name}" (cwd: ${def.cwd})`, e)
      if (r) {
        r.status = 'exited'
        r.exitCode = -1
      }
    }
  }

  private toRuntime(def: SessionDef): SessionRuntime {
    const r = this.runtime.get(def.id)
    const alive = this.pty.isAlive(def.id)
    return {
      ...def,
      status: alive ? (r?.status === 'starting' ? 'starting' : 'running') : 'exited',
      exitCode: r?.exitCode ?? null,
      pid: this.pty.pid(def.id),
      peerId: r?.peerId ?? null,
      thinking: r?.thinking ?? false,
      expired: r?.expired ?? false,
      rateLimited: r?.rateLimited ?? false,
      resumeAt: r?.resumeAt ?? null,
      needsAttention: r?.needsAttention ?? false
    }
  }

  /**
   * Inject the resume keystrokes when a quota episode's reset time passes:
   * Escape (dismisses the /rate-limit-options menu), a 100 ms settle, then the
   * literal prompt "continue" + Enter -- exactly what a human would type. Only
   * fires when auto-resume is enabled for this session (per-session override,
   * else the global setting), the PTY is alive and the episode is still open
   * (the user may have resumed manually in the meantime).
   */
  private autoResume(id: string): void {
    const def = this.defs.find((d) => d.id === id)
    const r = this.runtime.get(id)
    if (!def || !r) return
    const enabled = def.autoResume ?? this.getConfig().autoResumeQuota
    if (!enabled || !r.rateLimited || !this.pty.isAlive(id)) return

    this.pty.write(id, '\x1b')
    const t = setTimeout(() => {
      if (!this.pty.isAlive(id)) return
      this.pty.write(id, 'continue')
      this.pty.write(id, '\r')
    }, 100)
    if (typeof t.unref === 'function') t.unref()
    // The episode itself clears via the detector once the new turn's busy cues
    // appear; this event only lets the renderer toast the injection.
    this.emit('quota', { id, limited: true, resetAt: r.resumeAt, resumed: true })
  }

  /**
   * Type a slash-command into a session's live terminal the way the operator
   * would (CT3 directive cards): dismiss any open menu (Escape), a short settle,
   * the command text, then Enter -- the exact working precedent is autoResume.
   *
   * SECURITY: `command` is ALWAYS a CODE CONSTANT chosen by the caller (never a
   * value from the broker, a repo, or a peer). The tile is resolved by the
   * caller; nothing from a directive card's payload is written here verbatim.
   *
   * Gated on the tile being idle so a directive never interrupts a live turn:
   * when the tile is busy it waits (bounded) for idle, then injects; if it never
   * falls idle within the deadline the command is NOT sent (a clear mid-task
   * would destroy work) and 'busy-timeout' is returned for the caller to log.
   */
  async injectCommand(id: string, command: string): Promise<DirectiveOutcome> {
    if (!this.pty.isAlive(id)) return 'no-terminal'
    const idle = await this.waitIdle(id, DIRECTIVE_IDLE_WAIT_MS)
    if (!this.pty.isAlive(id)) return 'no-terminal'
    if (!idle) return 'busy-timeout'
    this.pty.write(id, '\x1b')
    await new Promise((res) => setTimeout(res, DIRECTIVE_SETTLE_MS))
    if (!this.pty.isAlive(id)) return 'no-terminal'
    this.pty.write(id, command)
    this.pty.write(id, '\r')
    return 'sent'
  }

  /**
   * Watch a tile's terminal output until `test` returns a non-null value or the
   * timeout/PTY-death ends the wait (CT4, magic-compact capture). `test` runs on
   * a rolling, length-capped buffer of recent output; the first non-null result
   * resolves the promise. Read-only: it only observes the 'data' stream, never
   * writes. Returns null on timeout or if the PTY exits first.
   */
  async waitForOutput<T>(
    id: string,
    timeoutMs: number,
    test: (buf: string) => T | null
  ): Promise<T | null> {
    if (!this.pty.isAlive(id)) return null
    return new Promise<T | null>((resolve) => {
      let buf = ''
      let done = false
      const finish = (val: T | null): void => {
        if (done) return
        done = true
        this.off('data', onData)
        this.off('exit', onExit)
        clearTimeout(timer)
        resolve(val)
      }
      const onData = (e: { id: string; data: string }): void => {
        if (e.id !== id) return
        buf += e.data
        if (buf.length > OUTPUT_SCAN_CAP) buf = buf.slice(-OUTPUT_SCAN_CAP)
        const r = test(buf)
        if (r !== null && r !== undefined) finish(r)
      }
      const onExit = (e: { id: string }): void => {
        if (e.id === id) finish(null)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.on('data', onData)
      this.on('exit', onExit)
    })
  }

  /**
   * Resolve once the tile reports idle (thinking=false), or false at the
   * deadline. An already-idle tile resolves on the first tick.
   */
  private async waitIdle(id: string, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const r = this.runtime.get(id)
      if (!r) return false
      if (!r.thinking) return true
      if (Date.now() >= deadline) return false
      await new Promise((res) => setTimeout(res, DIRECTIVE_IDLE_POLL_MS))
    }
  }

  private pollPeerIds(): void {
    let changed = false
    for (const def of this.defs) {
      const r = this.runtime.get(def.id)
      if (!r) continue
      const next = this.pty.isAlive(def.id)
        ? resolvePeerId(def.cwd, def.sessionId, this.peersDirFor(def))
        : null
      if (next !== r.peerId) {
        // First resolution of a fresh session -> emit a one-shot join announce
        // for the Deck to broadcast, then consume the intent so it never repeats
        // (a later set_id rename must not re-announce).
        if (next && r.peerId === null && r.announce) {
          // `id` rides along for the supervisor spawn-ack loop (TS3).
          this.emit('peer-resolved', { id: def.id, peerId: next, intent: r.announce })
          r.announce = null
        }
        r.peerId = next
        changed = true
      }
    }
    if (changed) this.broadcast()
  }

  /**
   * Default tile name. With an agent it reads as the agent name ("developer"),
   * otherwise "peer". Collisions take the smallest free numeric suffix among the
   * current sessions ("developer", then "developer 2", "developer 3"...).
   */
  private defaultName(agent?: string): string {
    const base = agent && agent.trim() ? agent.trim() : 'peer'
    const taken = new Set(this.defs.map((d) => d.name))
    if (!taken.has(base)) return base
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base} ${n}`
      if (!taken.has(candidate)) return candidate
    }
    return `${base} ${Date.now()}`
  }

  /** Colour the next auto-assigned session would get (create-menu preview). */
  peekNextColor(): string {
    return paletteColor(this.getConfig().palette ?? DEFAULT_PALETTE, this.defs.length)
  }

  private persist(): void {
    saveSessions(this.defs)
  }

  private broadcast(): void {
    this.emit('changed', this.list())
  }
}
