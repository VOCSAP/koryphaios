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
import {
  buildSessionCommandLine,
  encodeInitialPromptKeystrokes,
  encodeSubmittedKeystrokes,
  sanitizeFlagValue,
  shouldInjectPrompt,
  type SpawnMode
} from './session-command'
import { ThinkingDetector, type ThinkingEvent } from './thinking'
import { isClaudeLaunch } from './session-kind'
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
import { ScreenGuard } from './screen-model'
import { reportError } from './log'
import { DEFAULT_PALETTE, paletteColor } from '@shared/palette'
import { sanitizeRole } from '@shared/role'
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
   * True when this session runs the Claude Code CLI itself (session-kind.ts).
   * FROZEN at spawn time (startPty) from the command actually used to build
   * that spawn's command line -- never recomputed afterward. Card fd1914cc
   * correction: `this.launchCommand` can change while a session stays alive
   * (setLaunchCommand's own doc comment: "Affects future spawns only; live
   * PTYs keep running what they started with"), so a live recompute would
   * let an already-running claude session flip to "non-claude" out from
   * under itself and silently re-arm the Deck's own double injector.
   * restart() re-spawns and so recomputes this for the new instance; the
   * def itself has no live-edit path for `command` (verified: no
   * `def.command =` / `session.command =` assignment anywhere under
   * desktop/src).
   */
  claudeLaunch: boolean
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

/**
 * Soft-stop's idle wait (aaf4537d lot 3), kept separate from
 * DIRECTIVE_IDLE_WAIT_MS on purpose: tuning one must never detune the other,
 * since a global stop is expected to give up on an unresponsive tile much
 * sooner than a routine /clear or /compact would.
 */
export const STOP_IDLE_WAIT_MS = 15_000

/** Dev-channels warning auto-ack: let the dialog finish painting first. */
const STARTUP_ACK_SETTLE_MS = 350
/**
 * Initial-prompt injection (150eb188): let Claude Code's own TUI finish
 * rendering after the dialog-dismiss Enter before typing into it, mirroring
 * DIRECTIVE_SETTLE_MS's role between an Escape and the text it precedes.
 */
const PROMPT_INJECT_SETTLE_MS = 400
/** Rolling cap for the magic-compact output scanner (CT4). */
const OUTPUT_SCAN_CAP = 65536

/**
 * Outcome of injectCommand, journaled by the caller (CT3). 'refused-modal'
 * (Vague 10 A2-1, cards 5dbf3255/63ca372f) means the screen-state guard
 * refused the WHOLE sequence -- neither the pre-paste Escape nor the paste
 * itself was written -- because the tile looked like a modal dialog where
 * both gestures are destructive. Mirrored in agent-stop.ts's InjectOutcome;
 * update both together.
 */
export type DirectiveOutcome = 'written' | 'no-terminal' | 'busy-timeout' | 'refused-modal'

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
  /**
   * Screen-state guard for injectCommand (Vague 10 A2-1, screen-model.ts).
   * Fed and cleared alongside the four detectors above, same convention.
   */
  private screenGuard = new ScreenGuard()
  /**
   * Initial prompt awaiting post-spawn keystroke injection (150eb188), keyed
   * by session id. Set only for a fresh spawn with a non-empty def.prompt
   * (startPty); consumed (deleted) by the startup-ack handler below once
   * injected, so it fires at most once per process run. Cleared alongside
   * the other per-session detector state whenever that state is cleared.
   */
  private pendingPrompt = new Map<string, string>()
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
     * Getter for the absolute path to the Deck's embedded plugin dir (SessionStart
     * back-channel hook, approval hook, deck-control/demo-browser MCP bridges,
     * roadmap-card skill + roadmap-scribe agent), injected as `--plugin-dir` on
     * every spawn so the whole plugin loads -- the back-channel hook is what
     * keeps each tile's session id current across /clear. Empty => no plugin
     * flag (resolved by index.ts's getDeckPluginDir).
     *
     * A GETTER, not a cached string (card d02c8e96 fix c): a prior version
     * took a plain string here, resolved once at construction, which is
     * exactly what let a mid-run deletion of resources/deck-plugin go
     * undetected for ~9h -- every spawn for the rest of the process kept
     * passing --plugin-dir toward a directory that no longer existed. Calling
     * this fresh in startPty() re-checks existsSync live on every spawn, and
     * (since index.ts funnels every deckPluginDir consumer through the same
     * function) is also where the single missing-dir report fires the first
     * time any consumer discovers it gone.
     */
    private getPluginDir: () => string = () => '',
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
      if (!this.quotaGateActive(e.id)) this.quotaDetector.feed(e.id, e.data)
      this.attentionDetector.feed(e.id, e.data)
      this.startupAckDetector.feed(e.id, e.data)
      this.screenGuard.feed(e.id, e.data)
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
      this.screenGuard.clear(id)
      this.pendingPrompt.delete(id)

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
      this.broadcast()
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
    //
    // Also the sync point for the initial-prompt keystroke injection
    // (150eb188): a fresh spawn with a pending prompt (session id present in
    // pendingPrompt, set by startPty) gets it typed in right after, once
    // Claude Code's own TUI has had a moment to render past the dialog.
    // Known residual limitation, not handled here: a launch command override
    // that omits --dangerously-load-development-channels never shows this
    // dialog, so 'ack' never fires and a pending prompt for that spawn is
    // never injected (falls back to "type it yourself" -- same as before
    // this card for that one case).
    this.startupAckDetector.on('ack', ({ id }: StartupAckEvent) => {
      // Card 4f0143ff review (MAJOR 3 follow-up): this dialog's text has no
      // further reason to sit in AttentionDetector's retained buffer once
      // it's confirmed dismissed -- purge it (buf only, not `waiting`; see
      // purgeScreenMemory's own comment). Belt-and-suspenders alongside the
      // tightened raise-side exemption: this event-driven purge ties the
      // buffer's lifetime to a real fact instead of relying solely on the
      // sliding MAX_BUF window.
      this.attentionDetector.purgeScreenMemory(id)
      setTimeout(() => {
        const r = this.runtime.get(id)
        if (!r || r.status === 'exited') return
        this.pty.write(id, '\r')
        const name = this.defs.find((d) => d.id === id)?.name
        this.emit('startup-ack', { id, name })

        const prompt = this.pendingPrompt.get(id)
        if (!prompt) return
        this.pendingPrompt.delete(id)
        setTimeout(() => {
          const r2 = this.runtime.get(id)
          if (!r2 || r2.status === 'exited') return
          this.pty.write(id, encodeInitialPromptKeystrokes(prompt))
        }, PROMPT_INJECT_SETTLE_MS)
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
    this.screenGuard.stop()
    this.pendingPrompt.clear()
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
      // Re-normalised here, not only in the popover: this is the last main-side
      // point before the value becomes an exported env var, and the renderer's
      // sanitizer is typing assistance, not a guarantee.
      role: sanitizeRole(input.role ?? '') || '',
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
      // Initial value; startPty() (called synchronously below via
      // spawnSession) overwrites it with the authoritative frozen-at-spawn
      // read, so this only avoids a structurally-missing field in the
      // window before that call.
      claudeLaunch: this.resolveClaudeLaunch(def),
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
    this.screenGuard.clear(id)
    this.pendingPrompt.delete(id)
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
    this.screenGuard.stop()
    this.pendingPrompt.clear()
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
    this.screenGuard.stop()
    this.pendingPrompt.clear()
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
        // Initial value; the spawnSession()->startPty() loop right below
        // overwrites it with the authoritative frozen-at-spawn read for
        // every def, same as create() above.
        claudeLaunch: this.resolveClaudeLaunch(d),
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
   * Manual escape hatch for a stuck "needs you" flag (card 4f0143ff): the
   * auto-clearers (a busy cue, or the re-scan in attention.ts) only fire when
   * the PTY stream itself moves past the wait screen, which never happens for
   * a false raise (e.g. the dev-channels dialog before the WAITING_PATTERNS
   * narrowing) or a wait resolved outside the stream. Also drops the
   * detector's per-session buffer so a stale partial match cannot instantly
   * re-raise it. Not persisted (runtime-only, like the rest of RuntimeState).
   *
   * `manual: true` on the emitted event (BLOCKER 2, review of 4f0143ff): the
   * `'attention'` channel had exactly one producer before this method existed
   * -- the PTY-driven auto-detector -- and index.ts's listener infers from
   * `waiting:false` that a real turn ran, so it settles any open remote/phone
   * approval as answered. This method is a SECOND, human-driven producer on
   * the same channel with a different meaning ("the operator says this flag
   * is wrong"), which the consumer must not conflate with "the operator
   * already answered via the terminal" -- see index.ts's `manual` check.
   */
  clearAttention(id: string): void {
    const r = this.runtime.get(id)
    if (!r || !r.needsAttention) return
    r.needsAttention = false
    this.attentionDetector.clear(id)
    this.emit('attention', { id, waiting: false, manual: true } satisfies AttentionEvent)
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
    // Card 63ca372f/120148eb review finding: ScreenGuard's own Screen was
    // never told about a real resize, so it stayed frozen at makeScreen's
    // default forever -- a tile taller than that froze classifyInjectGuard
    // at 'modal' permanently. ScreenGuard.resize rejects NaN/invalid dims
    // itself (cols/rows are IPC-sourced, see that method's own doc).
    this.screenGuard.resize(id, cols, rows)
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

    // Single source of truth for "is this actually a fresh line" (review nit
    // on 150eb188/ce5aacf): `mode` alone is not enough because a caller could
    // in principle pass mode='resume' with an empty def.sessionId. Today only
    // spawnSession calls startPty and it already normalizes to 'fresh' before
    // doing so, so this can't currently diverge -- but computing it once and
    // feeding the SAME value to the branch condition, buildSessionCommandLine
    // and shouldInjectPrompt means a future direct caller can't produce a
    // fresh line whose prompt injection is silently disarmed by a stale
    // 'resume' tag.
    const effective: SpawnMode = mode === 'resume' && def.sessionId ? 'resume' : 'fresh'

    // Drop any stale prompt-injection entry from a previous spawn of this id
    // before (maybe) recording a fresh one below (150eb188) -- a resume must
    // never inject one, matching "prompt lives in the transcript, never
    // re-played".
    this.pendingPrompt.delete(def.id)

    let command: string
    if (effective === 'resume') {
      // Fork the previous claude session into a fresh id (collision avoidance).
      const prev = def.sessionId
      def.sessionId = randomUUID()
      command = buildSessionCommandLine({
        baseCommand: base,
        sessionId: def.sessionId,
        prevSessionId: prev,
        effort: def.effort,
        pluginDir: this.getPluginDir(),
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
        pluginDir: this.getPluginDir(),
        mcpConfig: def.mcpConfig,
        appendSystemPromptFile: def.appendSystemPromptFile,
        mode: 'fresh'
      })
      // 150eb188: the prompt no longer rides argv (win32 CommandLineToArgvW
      // mangled it past the first embedded quote). Record it here so the
      // startup-ack handler types it into the tile once it is actually up.
      // The guard is PER SPAWN, not per session: def.prompt itself is never
      // cleared (kept for the never-launched-yet case, its own doc comment),
      // so any fresh spawn re-arms injection -- including a resume that has
      // no transcript yet and degrades to 'fresh' above (spawnSession), which
      // is exactly what restart()/restoreFrom() do for a session that was
      // opened but never had real activity recorded. That is intentional (a
      // fresh launch, degraded or not, still deserves its initial prompt);
      // what the guard actually prevents is a *resume with a real transcript*
      // re-playing a prompt the agent already saw.
      if (shouldInjectPrompt(effective, def.prompt)) this.pendingPrompt.set(def.id, def.prompt!.trim())
    }

    // Track the live (post-fork) id for the double-resume guard.
    this.registry.add(def.sessionId)

    const r = this.runtime.get(def.id)

    // Session env, also handed to the sandbox wrapper (which translates the
    // host-only transports before exporting them container-side).
    // CLAUDE_PEERS_ROLE is ALWAYS exported, empty string included (card
    // a2f61172): same neutralisation rule as the scope env, since a value
    // inherited from the process that launched the Deck would otherwise
    // re-activate a role on a session that has none. This spawn path serves
    // BOTH 'fresh' and 'resume', which is why the role lives in def rather
    // than in def.args -- a fork-resume re-exports it here for free.
    const sessionEnv = {
      ...this.getScopeEnv(),
      CLAUDE_PEERS_DESK_SESSION: def.id,
      CLAUDE_PEERS_ROLE: def.role ?? ''
    }

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
      // Frozen-at-spawn (card fd1914cc correction): `base` above is the
      // command THIS instance actually starts on -- set here, not
      // recomputed by isClaudeSession/toRuntime afterward, so a later
      // this.launchCommand change (setLaunchCommand) cannot flip an
      // already-live session's claude/non-claude answer out from under it.
      r.claudeLaunch = isClaudeLaunch(base)
    }
    // Fresh process -> fresh detector state (stale buffers/timers dropped).
    this.quotaDetector.clear(def.id)
    this.attentionDetector.clear(def.id)
    this.startupAckDetector.clear(def.id)
    this.screenGuard.clear(def.id)
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
      needsAttention: r?.needsAttention ?? false,
      // Read from RuntimeState, never recomputed here (card fd1914cc
      // correction) -- single source of truth, frozen at spawn by startPty.
      // No runtime yet: leans "it's claude" (see isClaudeSession's doc).
      claudeLaunch: r?.claudeLaunch ?? true
    }
  }

  /**
   * Resolves whether `def` runs the Claude Code CLI itself, from its OWN
   * command (falling back to the resolved base `this.launchCommand`, same
   * precedence as startPty's `base`). Used ONLY to seed the initial
   * RuntimeState.claudeLaunch at create()/restoreFrom() and by startPty to
   * set the authoritative frozen-at-spawn value -- never called afterward
   * to re-derive a live session's answer (see RuntimeState.claudeLaunch).
   */
  private resolveClaudeLaunch(def: SessionDef): boolean {
    return isClaudeLaunch(def.command.trim() || this.launchCommand)
  }

  /**
   * True when `id`'s live session runs the Claude Code CLI itself, read
   * from the value RuntimeState.claudeLaunch froze at spawn time (card
   * fd1914cc correction) -- never recomputed from the CURRENT
   * `this.launchCommand`/`def.command`, which could answer differently
   * than what this session's own PTY actually started on. No runtime state
   * yet (not spawned, or already removed): leans "it's claude, don't
   * inject" per the asymmetry documented on quotaGateActive below -- a
   * silently-skipped non-claude resume is safer than a silent double
   * injection.
   */
  private isClaudeSession(id: string): boolean {
    const r = this.runtime.get(id)
    return r ? r.claudeLaunch : true
  }

  /**
   * True when the Deck's OWN quota detector+injector must stay off for
   * `id` (card fd1914cc). Gates ONLY the DEFAULT path -- `def.autoResume`
   * left `undefined`, i.e. the session follows the global setting -- never
   * an EXPLICIT per-session override. Claude Code 2.1.235+ ships its own
   * `autoContinueAtUsageLimit` resume, but that is NOT provable active from
   * here: the /config toggle is shown only conditionally, is
   * `consentGated`, and its state is partly server-side (not present in
   * this machine's settings.json even when the CLI is current). Silencing
   * the default path without an escape hatch would trade a visible doubled
   * injection for a SILENT non-resume, which is worse -- so an operator who
   * explicitly sets `autoResume` (true OR false) on a claude session always
   * wins, restoring the pre-fd1914cc behaviour for that tile: `true` keeps
   * `quotaDetector.feed` running (it needs a trigger) and lets `autoResume`
   * below inject; `false` also keeps `feed` running (so the rate-limited
   * badge still shows) but `autoResume` no-ops on `enabled === false`, same
   * as any other explicitly-disabled session.
   */
  private quotaGateActive(id: string): boolean {
    const def = this.defs.find((d) => d.id === id)
    // No def (already removed, or a race on a dying PTY's trailing data):
    // lean gate-ACTIVE, the same "unknown -> assume claude" direction
    // isClaudeSession documents above. Functionally inert either way here
    // (autoResume() and the 'limit'/'resume-due' handlers already no-op on
    // a missing def/runtime), but kept coherent on purpose rather than
    // silently pointing the opposite way (team-lead mutation review).
    if (!def) return true
    return def.autoResume === undefined && this.isClaudeSession(id)
  }

  /**
   * Inject the resume keystrokes when a quota episode's reset time passes:
   * Escape (dismisses the /rate-limit-options menu), a 100 ms settle, then the
   * literal prompt "continue" + Enter -- exactly what a human would type. Only
   * fires when `quotaGateActive(id)` is false (this session is not on the
   * claude-default gate -- either it is not a claude launch, or the operator
   * set an explicit per-session override), auto-resume is enabled (per-session
   * override, else the global setting), the PTY is alive and the episode is
   * still open (the user may have resumed manually in the meantime). In
   * practice `quotaGateActive` guards `quotaDetector.feed` too (the pty
   * 'data' handler above), so a gated session never reaches this method at
   * all -- the check here is defense-in-depth, not the load-bearing gate.
   */
  private autoResume(id: string): void {
    const def = this.defs.find((d) => d.id === id)
    const r = this.runtime.get(id)
    if (!def || !r) return
    if (this.quotaGateActive(id)) return
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
   * Type a command (or a whole conversation turn) into a session's live
   * terminal the way the operator would (CT3 directive cards, aaf4537d soft
   * stop): dismiss any open menu (Escape), a short settle, then ONE write
   * carrying the text and its submit keystroke, encoded by
   * `encodeSubmittedKeystrokes` (session-command.ts).
   *
   * That single write is not a style choice, see the comment at the write
   * itself and the encoder's own: the previous two-write shape (text, then a
   * bare '\r') did not submit at all past ~64 bytes, which is card 6168b7f4.
   * autoResume, further up this file, still writes 'continue' then '\r'
   * separately -- that is NOT a contradiction and NOT a precedent to copy
   * from: its coalesced chunk measures 9 bytes, comfortably under the 64
   * threshold, so it submits. It is left alone deliberately (its own gap is
   * observability, diagnosed under the quota family).
   *
   * SECURITY: `command` is ALWAYS a CODE CONSTANT chosen by the caller (never a
   * value from the broker, a repo, or a peer). The tile is resolved by the
   * caller; nothing from a directive card's payload is written here verbatim.
   * The encoder strips every ESC byte anyway, so a hostile string could not
   * break out of the bracketed paste into keystrokes.
   *
   * Meant to be gated on the tile being idle so a directive never interrupts a
   * live turn: when the tile is busy it waits (bounded) for idle, then injects;
   * if it never falls idle within the deadline the command is NOT sent (a clear
   * mid-task would destroy work) and 'busy-timeout' is returned for the caller
   * to log. CAVEAT measured 2026-08-13, do not read the paragraph above as a
   * guarantee: `waitIdle` reads `r.thinking`, whose detector is currently
   * unreliable, so in practice this gate can open on a busy tile. That is a
   * separate defect on the detector, not on this method.
   */
  async injectCommand(
    id: string,
    command: string,
    idleWaitMs: number = DIRECTIVE_IDLE_WAIT_MS
  ): Promise<DirectiveOutcome> {
    if (!this.pty.isAlive(id)) return 'no-terminal'
    const idle = await this.waitIdle(id, idleWaitMs)
    if (!this.pty.isAlive(id)) return 'no-terminal'
    if (!idle) return 'busy-timeout'
    // Screen-state guard (Vague 10 A2-1, cards 5dbf3255/63ca372f): refuse the
    // WHOLE sequence -- neither the Escape below nor the paste -- when the
    // tile looks like a modal dialog. Measured (2026-08-13, see the comment
    // further down): on the trust/confirm dialog, the bare Escape quits the
    // CLI outright, and the paste alone silently confirms whatever option is
    // highlighted. Both gestures destroy; guessing which one is "safer" is
    // not an option, so this refuses instead (D2, team-lead's brief).
    //
    // UNION of two independently-sourced signals, neither trusted alone:
    //  - screenGuard (screen-model.ts): a GEOMETRIC read of the tile's
    //    current screen -- does the live cursor sit where the composer's
    //    content row puts it. MESURE against five real byte fixtures
    //    (tests/pty-harness/fixtures/), but DEDUIT (not measured) on two
    //    screens outside that set (the @-mention picker, the tool-permission
    //    prompt) -- see that function's own doc for what it actually covers.
    //  - RuntimeState.needsAttention: the text-pattern "needs you" detector
    //    already shipped and tested in attention.ts (WAITING_PATTERNS +
    //    detectWaiting, wired via the attentionDetector.on('attention')
    //    handler below in this constructor, which is what keeps this field
    //    current). Consulted read-only -- this file does not modify
    //    attention.ts. Its own doc claims coverage of tool-permission
    //    prompts, plan approvals and AskUserQuestion menus in addition to
    //    the trust prompt; that broader claim has not been independently
    //    re-verified here, which is exactly why it is not trusted alone
    //    either.
    // Team-lead's instruction (claude-peers, 2026-08-17): if EITHER signal
    // says modal, refuse -- only write when BOTH say non-modal. A closing
    // union can only ever ADD refusals relative to either signal running
    // alone, never remove one: the two false-positive surfaces are additive,
    // but there is no way for the union to produce a false NEGATIVE that a
    // single signal would have caught, since a 'modal' from either side is
    // final. That is the asymmetry that makes composing two
    // partially-verified signals safe even though neither is fully proven on
    // its own: a false refusal costs a directive that waits one more idle
    // cycle (visible in the journal, replayable); a false pass on either
    // side alone could cost a killed session or a blind accept.
    if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
    if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
    // Third refusal signal (card 63ca372f's own contract: idle AND NOT
    // needsAttention AND NOT rateLimited), closing the gap the other two
    // never covered. autoResume (this same file) writes a bare Escape then,
    // 100ms later via its own setTimeout, 'continue' + '\r' on a rateLimited
    // tile with no coordination with this method -- a directive injected
    // into that same tile during that window would interleave two
    // independent writers on one PTY. Refusing here (reusing 'refused-modal':
    // this is still "do not write into this tile right now", not a new
    // outcome) closes the window by never starting the second writer.
    if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
    this.pty.write(id, '\x1b')
    await new Promise((res) => setTimeout(res, DIRECTIVE_SETTLE_MS))
    if (!this.pty.isAlive(id)) return 'no-terminal'
    // ONE write, bracketed-paste wrapped, CR inside the same string (card
    // 6168b7f4). This used to be two writes -- the command, then a bare '\r'
    // -- and that shape did not SUBMIT: measured 2026-08-12 on a live tile,
    // the text appeared at the prompt and stayed there 12s later, and again
    // in a pty harness, where the mechanism was pinned. ConPTY coalesces two
    // back-to-back writes into one read, and Claude Code's tokenizer only
    // turns a control byte into its own token (hence into a `return` key)
    // when the whole read is under 64 characters; above that the CR is
    // swallowed into the text run. encodeSubmittedKeystrokes' own comment
    // (session-command.ts) carries the full measurement and the reason the
    // closing ESC[201~ makes this deterministic rather than timing-dependent.
    // Do NOT "simplify" this back into two writes, and do not add a delay:
    // a delay is a race that passes on an idle machine.
    //
    // write() itself reports write-silently-dropped (pty-manager.ts's own
    // doc: "Returns false when no live PTY carries this id") -- the isAlive
    // check just above only proves liveness at that instant, not that the
    // pty was still alive for THIS write. Consulting the boolean here (not
    // just the pre-check) is what actually closes that gap.
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    // 'written' guarantees that pty.write() returned true and that the bytes
    // sent are the shape the CLI submits AT THE MAIN PROMPT. It does NOT
    // guarantee the terminal accepted them in every UI state. One non-nominal
    // state was measured (2026-08-13, trust/confirm dialog open -- the
    // cheapest one reachable without spending an API turn) and RE-MEASURED
    // 2026-08-17 (an earlier version of this paragraph said the paste was
    // silently swallowed -- WRONG, corrected here): with the bare ESC below
    // sent first, the CLI quits outright; with the ESC skipped and only the
    // paste sent, the paste CONFIRMS whichever option the dialog has
    // highlighted -- not a lost command, a blind accept typed in the
    // operator's name. Two related facts from the same capture: the CLI
    // turns bracketed paste ON at startup (`CSI ?2004h`) and OFF on exit
    // (`CSI ?2004l`). The screen-state guard above this point is what now
    // stops both branches from reaching this dialog at all; see its own
    // comment for what it does and does not cover (tool-permission prompt,
    // open selection list -- DEDUIT, not measured, treated as modal).
    //
    // `waitIdle`'s own idleness signal is currently unreliable
    // (its `thinking` predicate is under separate diagnosis), so a directive
    // can land mid-turn. Nor is it guaranteed, by nature, that the agent read
    // the line, understood it, or will act on it. Turning 'written' into a
    // proof of submission needs output-side confirmation AFTER the CR --
    // waitForOutput (below in this file) is the instrument, but the activity
    // cue it would look for is itself unreliable today (the interrupt hint is
    // never emitted during a turn, and the activity label rotates), so that
    // work is deliberately a separate card, not a half-measure here.
    return 'written'
  }

  /**
   * Bare, non-idle-gated ESC write (aaf4537d lot 3: Pause/Hard Stop). Extracted
   * from autoResume's existing raw ESC write below -- same primitive, now
   * reusable outside the auto-resume flow. Unlike injectCommand this never
   * waits for idle: Pause/Hard act on the process immediately, they do not
   * ask the agent to wrap up (that's Soft Stop's job, via injectCommand).
   *
   * EXACTLY ONE '\x1b', never doubled -- do not "retry with a second ESC" if
   * this doesn't seem to bite. Measured 2026-08-12 in the installed Claude
   * Code CLI binary: it contains the string "esc to close · esc again quits",
   * i.e. at least one UI state exists where a SECOND escape QUITS the session
   * instead of interrupting it. A blind double-ESC can therefore kill a
   * session where Hard Stop only meant to interrupt it. If a single ESC
   * proves insufficient in some state, that is a real observation to make
   * later, with a different remedy -- not a reason to double this write.
   */
  /**
   * `mode` (card 120148eb): 'pause' routes through the SAME screen-state
   * refusal injectCommand uses (ScreenGuard.classify()==='modal' OR
   * needsAttention), because Pause's own contract (this method's doc above,
   * and the roadmap.stop.pauseHint i18n copy) is explicitly reversible -- a
   * bare Escape that quits the CLI on a modal-showing tile breaks that
   * promise silently: the operator believes the session paused, it is dead,
   * and the roadmap card stays locked to nothing. 'hard' deliberately skips
   * the gate: its own contract is to end the session by force, right now, so
   * the same worst case (CLI exit) is in-contract there, not a bug
   * (team-lead's read on roadmap card 120148eb, confirmed against both
   * texts before this was written). `mode` has NO default, DELIBERATELY
   * (team-lead's call, claude-peers 2026-08-18): a default would be a
   * fail-open -- a future caller added without thinking about it would
   * silently get the ungated path. That is a convention this signature
   * expresses, not a guarantee anything currently enforces: nothing stops
   * a future edit from adding `= 'hard'` back, and a source-scan test built
   * only to catch that one string is the same weak family the mutation
   * review (this same card) already flagged elsewhere -- so none exists
   * here. The asymmetry itself (pause gated, hard not) IS pinned
   * behaviorally, see the test asserting both directions on a
   * modal-classified tile.
   */
  interrupt(id: string, mode: 'pause' | 'hard'): 'interrupted' | 'no-terminal' | 'refused-modal' {
    if (!this.pty.isAlive(id)) return 'no-terminal'
    if (mode === 'pause') {
      if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
      if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
      // Third signal, same as injectCommand's own (mutation review, second
      // pass on 120148eb): without it, a Pause landing during a quota-resume
      // window races autoResume's own raw ESC write (this file, autoResume)
      // -- autoResume writes '\x1b', then 100ms later via its own setTimeout
      // writes 'continue' + '\r'. A second bare ESC from Pause inside that
      // window is not just noise: the installed CLI binary contains the
      // string "esc to close, esc again quits" (measured 2026-08-12, see
      // this method's own doc above), so a second ESC can KILL the session
      // -- the exact 120148eb contract violation, reached through the door
      // this branch itself exists to close.
      if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
    }
    this.pty.write(id, '\x1b')
    return 'interrupted'
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
