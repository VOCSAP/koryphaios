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
import { ThinkingDetector } from './thinking'
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
import { gracefulClose } from './session-close'
import { createOscParser, type OscSnapshot } from './detect/osc'
import { createActivityTracker, ACTIVITY_IDLE_MS, type Activity } from './detect/activity'
import { reportError } from './log'
import { resolveMcpConfig, type MintTeamLeadBridge } from './team-lead-bridge'
import { DEFAULT_PALETTE, paletteColor } from '@shared/palette'
import { sanitizeRole } from '@shared/role'
import { reconcileOrder } from '@shared/reorder'
import type { JoinAnnounceIntent } from '@shared/announce'
import { peerToolsEnvValue } from './session-env'

interface RuntimeState {
  status: SessionStatus
  exitCode: number | null
  peerId: string | null
  /**
   * Frequency-based ternary ('working' | 'idle' | 'unknown') driven by the
   * activity tracker.
   * 'unknown' is the default and stays there forever for a session whose
   * agent-kind never paints an OSC 0 title; it never collapses into 'idle'.
   */
  activity: Activity
  /** Restore-time: persisted id had no transcript, so it was not resumed. */
  expired: boolean
  /** True while the session sits at a usage-limit screen (quota.ts). */
  rateLimited: boolean
  /** Epoch ms of the announced quota reset, or null when unknown/not limited. */
  resumeAt: number | null
  /** True while the session waits for the operator (attention.ts, PLAN C11). */
  needsAttention: boolean
  /**
   * True when this session runs the Claude Code CLI itself; frozen at spawn
   * time from the command used to build that spawn, never recomputed while the
   * session stays alive.
   * restart() recomputes it for the new instance.
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

/**
 * Card 032bdeae: remove()'s gracefulClose budgets. Deliberately SHORTER than
 * gracefulClose's own 1500/1500ms defaults -- a session tile being closed
 * has no reason to wait as long as a directive injection does, and the
 * per-stage isAlive() polling (session-close.ts's own doc) means a session
 * that dies quickly still closes quickly; these are ceilings for one that
 * does not. CLOSE_HARD_DEADLINE_MS is the absolute safety net across BOTH
 * stages combined, independent of them (see gracefulClose's own doc on why
 * it cannot be redundant with the per-stage budgets).
 */
const CLOSE_EXIT_GRACE_MS = 1200
const CLOSE_INTERRUPT_GRACE_MS = 800
const CLOSE_POLL_MS = 100
const CLOSE_HARD_DEADLINE_MS = 3000

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
   * OSC 0/2/9;4/777 extraction (card 1aa69066/H2, desktop/src/main/detect/osc.ts).
   * One createOscParser() instance per session id -- same session-keyed
   * Map<string, T> shape as ScreenGuard/the four detectors above, so two
   * sessions' continuation state can never collide (multi-identity question,
   * CLAUDE.md). No consumer wired yet (H1/H3/f8082208 are separate chantiers
   * that read oscSnapshot() later); this parser only extracts and retains
   * the last-seen snapshot per session.
   */
  private oscParsers = new Map<string, ReturnType<typeof createOscParser>>()
  /**
   * Activity predicate (card f8082208 / docs/DESIGN-ACTIVITY-PREDICATE.md),
   * one createActivityTracker() instance per session id, same session-keyed
   * Map<string, T> shape as oscParsers/the four detectors above. Fed with
   * osc.ts's own titleSeq counter, never a title string -- see that
   * module's own header for why frequency, not content, decides.
   */
  private activityTrackers = new Map<string, ReturnType<typeof createActivityTracker<NodeJS.Timeout>>>()
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

  /**
   * Card 032bdeae: session ids currently escalating through remove()'s
   * gracefulClose. Keyed by session id (the OBJECT), not by caller -- a
   * second remove() call on the SAME id while the first is still in flight
   * forces immediate cleanup instead of racing a second write onto the same
   * pty (see remove()'s own comment).
   */
  private closingInFlight = new Set<string>()
  /**
   * Card 032bdeae: ids whose in-flight escalation has been overtaken by a
   * concurrent second remove() call. Read by gracefulClose's
   * `isClosingForced` at each poll tick so the original escalation stops
   * writing further stages and exits immediately. Distinct from
   * `closingInFlight` on purpose: `closingInFlight.has(id)` is true for the
   * WHOLE duration of one's own escalation, so it cannot itself signal "a
   * DIFFERENT caller forced this."
   */
  private forcedClose = new Set<string>()

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
     * Getter, not a cached string: resolved fresh via existsSync on every
     * spawn, so a deletion of the plugin dir after construction is still
     * detected.
     * Empty return means no --plugin-dir flag is passed.
     */
    private getPluginDir: () => string = () => '',
    /** Home dir for transcript existence checks (injectable for tests). */
    private home: string = homedir(),
    /**
     * Mints the team-lead deck-control bridge when create() decides one is
     * owed; injected as a function so this module stays free of the
     * deck-control/electron import.
     * Sync and nullable: the deck-control server is started proactively by the
     * caller before create() runs; a null return means no bridge for this
     * spawn, not a fatal error.
     */
    private mintTeamLeadBridge: MintTeamLeadBridge = () => null
  ) {
    super()
    // Starts empty: the previous run is recovered explicitly through a
    // workspace restore, not by auto-restoring the legacy sessions.json.
    this.defs = []

    this.pty.on('data', (e: { id: string; data: string }) => {
      this.emit('data', e)
      this.outputAt.set(e.id, Date.now())
      this.thinkingDetector.feed(e.id, e.data)
      if (!this.quotaGateActive(e.id)) this.quotaDetector.feed(e.id, e.data)
      this.attentionDetector.feed(e.id, e.data)
      this.startupAckDetector.feed(e.id, e.data)
      this.screenGuard.feed(e.id, e.data)
      // Card f8082208: the activity tracker reads the SAME snapshot's
      // titleSeq, never the title text -- see detect/activity.ts's header.
      const oscSnap = this.oscParserFor(e.id).feed(e.data)
      this.activityTrackerFor(e.id).observe(oscSnap.titleSeq)
    })
    this.pty.on('exit', ({ id, exitCode }: { id: string; exitCode: number }) => {
      // pty-manager only emits 'exit' for a spontaneous process exit, never for
      // kill()/restart, so this handler owns the close decision.
      // Frees the double-resume guard for the id; a later restart re-registers
      // the fresh forked id.
      const def = this.defs.find((d) => d.id === id)
      if (def?.sessionId) this.registry.release(def.sessionId)
      this.thinkingDetector.clear(id)
      this.quotaDetector.clear(id)
      this.attentionDetector.clear(id)
      this.startupAckDetector.clear(id)
      this.screenGuard.clear(id)
      this.oscParsers.delete(id)
      this.activityTrackers.get(id)?.stop()
      this.activityTrackers.delete(id)
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
        // Never creates an 'idle' observation the tracker never made: a session
        // stuck at 'unknown' stays 'unknown' through exit.
        // A session that was 'working' or 'idle' at exit becomes 'idle'.
        if (r.activity !== 'unknown') r.activity = 'idle'
      }
      this.emit('exit', { id, exitCode, name: def?.name })
      this.broadcast()
    })

    // thinkingDetector.feed()/.clear()/.stop() above stays wired (BUSY_RE is
    // measured dead in production, see thinking.ts's own header and card
    // 1aa69066's EXEMPT_DETECTORS reasoning in tests/desktop-osc.test.ts) but
    // its transitions are no longer forwarded anywhere: RuntimeState.activity
    // is driven exclusively by the activity tracker below (card f8082208).
    // Deliberately NOT touching the thinkingDetector wiring itself keeps that
    // placeholder's coverage exemption valid unchanged.

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

    // Auto-acks the development-channels dialog once per process run for every
    // spawn; liveness is re-checked at send time.
    // Also the sync point for the initial-prompt keystroke injection, once the
    // dialog has cleared.
    // A launch override that omits --dangerously-load-development-channels
    // never shows the dialog, so neither the ack nor the pending-prompt
    // injection fires; falls back to manual typing.
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

  /**
   * opts.teamLeadDeckBridge is a separate function parameter, never a property
   * of input: input is forwarded verbatim from a remote-reachable channel, so a
   * boolean field on it could be set directly by a companion client.
   * This only closes the shortcut of setting the flag directly; a caller
   * requesting agent: 'team-lead' still gets the bridge through the normal
   * path.
   * Stays synchronous: an async mint would insert a yield point before
   * defs.push(def) on every create() call, breaking create()'s atomicity.
   */
  create(input: CreateSessionInput, opts?: { teamLeadDeckBridge?: boolean }): SessionRuntime {
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
    // Mirrors the mcpConfig the agent-spawned route already carries, but only
    // when the caller posed opts.teamLeadDeckBridge itself; other callers
    // (template, workspace-restore, one-shot-agent) never pass opts and fall
    // through untouched.
    // Kept in team-lead-bridge.ts, a module with no @shared import, so it stays
    // testable under a plain bun test run.
    const mcpConfig = resolveMcpConfig(
      input,
      agent,
      opts?.teamLeadDeckBridge === true,
      this.mintTeamLeadBridge,
      reportError
    )
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
      // Card 3c085f1a: undefined stays undefined (no sanitization/normalisation
      // -- see SessionDef.peerTools's own doc on why this must not collapse
      // to `[]`, unlike `role` right above it).
      peerTools: input.peerTools,
      prompt: input.prompt?.trim() || '',
      // Filled by the ipc layer after `git worktree add` (PLAN C4).
      worktree: input.worktree,
      // Supervisor session (PLAN C5/C8): main-only inputs.
      supervisor: input.supervisor || undefined,
      // Team-lead (PLAN C10): explicit flag; uniqueness enforced below.
      lead: input.lead && !input.supervisor ? true : undefined,
      mcpConfig,
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
      activity: 'unknown',
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

  /**
   * Escalates (/exit, then Esc+Ctrl+C+/exit, then SIGTERM) before the terminal
   * cleanup, rather than killing outright.
   * Skips straight to cleanup for a tile already refused for writing
   * (modal/needs-attention/rate-limited) or already closing.
   * forceCleanup is idempotent: a no-op once def is gone, since it can
   * legitimately run twice under that race.
   */
  async remove(id: string): Promise<void> {
    const forceCleanup = (): void => {
      const def = this.defs.find((d) => d.id === id)
      if (!def) return
      this.emit('removed', { id: def.id, name: def.name })
      if (def.sessionId) this.registry.release(def.sessionId)
      this.pty.kill(id)
      this.thinkingDetector.clear(id)
      this.quotaDetector.clear(id)
      this.attentionDetector.clear(id)
      this.startupAckDetector.clear(id)
      this.screenGuard.clear(id)
      this.oscParsers.delete(id)
      this.activityTrackers.get(id)?.stop()
      this.activityTrackers.delete(id)
      this.pendingPrompt.delete(id)
      this.defs = this.defs.filter((d) => d.id !== id)
      this.runtime.delete(id)
      this.outputAt.delete(id)
      this.persist()
      this.broadcast()
    }

    if (this.closingInFlight.has(id)) {
      // Second close on the same id while the first is still escalating:
      // force cleanup NOW (exactly one '/exit' ever reaches the pty) and
      // flag it so the in-flight gracefulClose notices on its next poll.
      this.forcedClose.add(id)
      forceCleanup()
      return
    }

    this.closingInFlight.add(id)
    try {
      const isModal = (): boolean =>
        this.screenGuard.classify(id) === 'modal' ||
        !!this.runtime.get(id)?.needsAttention ||
        !!this.runtime.get(id)?.rateLimited
      if (isModal()) {
        forceCleanup()
        return
      }
      await gracefulClose({
        write: (data) => this.pty.write(id, data),
        isAlive: () => this.pty.isAlive(id),
        kill: () => this.pty.kill(id),
        delay: (ms) => new Promise((res) => setTimeout(res, ms)),
        exitGraceMs: CLOSE_EXIT_GRACE_MS,
        interruptGraceMs: CLOSE_INTERRUPT_GRACE_MS,
        pollMs: CLOSE_POLL_MS,
        isClosingForced: () => this.forcedClose.has(id),
        cleanup: forceCleanup,
        absoluteDeadlineMs: CLOSE_HARD_DEADLINE_MS
      })
    } catch (e) {
      // Card 6c380073 (review round 2): the try above ALSO covers isModal(),
      // which reads screenGuard/runtime BEFORE gracefulClose is ever called --
      // so a throw there used to escape with no cleanup at all, leaving the
      // pty running and the def in place while remove() rejected. Nothing in
      // this method may leave the process alive: force the same idempotent
      // cleanup the escalation itself would have run, and leave a trace
      // (no-silent-errors) rather than swallowing.
      reportError('session', `close escalation failed for ${id}`, e)
      forceCleanup()
    } finally {
      this.closingInFlight.delete(id)
      this.forcedClose.delete(id)
    }
  }

  /**
   * Closes every session and clears the set; no-op when already empty.
   * Emits 'removed' per destroyed def so the journal entry and token revocation
   * both fire for every closed tile, not only the single-remove path.
   * Caller is expected to have detached/saved the current workspace first; the
   * auto-save guard ignores this empty broadcast.
   */
  closeAll(): void {
    if (this.defs.length === 0) return
    for (const d of this.defs) {
      this.emit('removed', { id: d.id, name: d.name })
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
   * Re-reads each live tile's back-channel and adopts a changed real session
   * id, so the persisted id after a /clear is the new one, not the stale
   * pre-clear id.
   * The one-shot discovery track closes after 30s, so a later rotation is
   * invisible to it; only picked up here at save time.
   * Adopts only when the new id actually has a transcript.
   * Kept off the template path so capturing a template never mutates live
   * session ids.
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
   * Supervisor is excluded: its token only lives for this app launch, and Home
   * re-spawns it on demand.
   * The spread here does include mcpConfig; both consumers project through
   * explicit pick-lists rather than a spread, so a live team-lead identity is
   * never captured onto a second tile. Keep those pick-lists explicit.
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
    // Card 6c380073 (second audit round): emit 'removed' for the OUTGOING defs
    // FIRST, before anything is killed or replaced -- same reason as
    // closeAll() above (a departed team-lead's minted token and its
    // --mcp-config file must not outlive its tile). Order matters: emitting
    // before `this.defs` is replaced means each revocation resolves against
    // the session that is actually going away, never against an incoming one
    // that happens to reuse an id.
    for (const d of this.defs) this.emit('removed', { id: d.id, name: d.name })
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
        activity: 'unknown',
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

  /**
   * Last-seen OSC title/progress/notify snapshot for a session, or null if
   * the session has no live parser (never spawned, or already cleared).
   * Feeding an empty chunk reads the current snapshot without mutating any
   * in-progress continuation state.
   */
  oscSnapshot(id: string): OscSnapshot | null {
    return this.oscParsers.get(id)?.feed('') ?? null
  }

  private oscParserFor(id: string): ReturnType<typeof createOscParser> {
    let p = this.oscParsers.get(id)
    if (!p) {
      p = createOscParser()
      this.oscParsers.set(id, p)
    }
    return p
  }

  /**
   * Lazy-mint, same convention as oscParserFor; the transition callback is
   * wired once here at creation, writing RuntimeState.activity and forwarding
   * session:thinking.
   */
  private activityTrackerFor(id: string): ReturnType<typeof createActivityTracker<NodeJS.Timeout>> {
    let t = this.activityTrackers.get(id)
    if (!t) {
      t = createActivityTracker<NodeJS.Timeout>({
        idleMs: ACTIVITY_IDLE_MS,
        now: Date.now,
        setTimer: (fn, ms) => {
          const timer = setTimeout(fn, ms)
          // Do not keep the event loop alive just for the idle flip (same
          // posture as ThinkingDetector.armIdle).
          if (typeof timer.unref === 'function') timer.unref()
          return timer
        },
        clearTimer: (timer) => clearTimeout(timer)
      })
      t.on((state) => {
        const r = this.runtime.get(id)
        if (!r) return
        r.activity = state
        this.emit('thinking', { id, state })
        this.broadcast()
      })
      this.activityTrackers.set(id, t)
    }
    return t
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
   * Manual escape hatch for a stuck needsAttention flag: the auto-clearers only
   * fire when the PTY stream moves past the wait screen, which never happens
   * for a false raise or a wait resolved outside the stream.
   * Drops the detector's per-session buffer so a stale partial match cannot
   * instantly re-raise it. Runtime-only, not persisted.
   * Emits manual: true so the consumer does not conflate this with the operator
   * having answered through the terminal.
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
    // CLAUDE_PEERS_TOOLS is omitted entirely when def.peerTools is undefined,
    // never exported as '', unlike CLAUDE_PEERS_ROLE just above.
    // The consumer treats absent (full surface) and an explicit empty list
    // (zero tools) as opposites.
    const peerToolsValue = peerToolsEnvValue(def.peerTools)
    // Object.assign, not a direct `sessionEnv.CLAUDE_PEERS_TOOLS = ...` write:
    // the object literal's inferred type (implicit index signature, TS's own
    // rule for object-literal-typed consts) is what lets sessionEnv satisfy
    // Record<string, string> at the two call sites below without an explicit
    // type annotation up top -- a direct property write needs that property
    // declared up front, forcing either an annotation or a key in the
    // literal, both of which would change the declaration's exact text that
    // the sibling role-env test's structural scan of startPty() depends on.
    if (peerToolsValue !== undefined) Object.assign(sessionEnv, { CLAUDE_PEERS_TOOLS: peerToolsValue })

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
    // A respawn (restart/resume) mints a fresh OSC continuation state too --
    // an unterminated fragment from the previous process must never bleed
    // into the new one's first chunk. Same reasoning for the activity
    // tracker: a stale titleSeq/timer from the previous process must not
    // bleed into the new one either.
    this.oscParsers.delete(def.id)
    this.activityTrackers.get(def.id)?.stop()
    this.activityTrackers.delete(def.id)
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
      activity: r?.activity ?? 'unknown',
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
   * True when the Deck's own quota detector+injector must stay off for a claude
   * session; gates only the default path where autoResume is undefined, never
   * an explicit per-session override.
   * An operator who explicitly sets autoResume (true or false) always wins over
   * this gate.
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
   * Injects Escape, a 100ms settle, then 'continue' + Enter, exactly what a
   * human would type.
   * Fires only when quotaGateActive(id) is false, auto-resume is enabled, the
   * PTY is alive, and the episode is still open.
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
   * Types a command the way the operator would: dismiss any open menu, settle,
   * then one write carrying the text and its submit keystroke.
   * command is always a code constant chosen by the caller, never a value from
   * the broker, a repo, or a peer.
   * Gated on the tile being idle so a directive never interrupts a live turn;
   * if it never falls idle within the deadline the command is not sent and
   * 'busy-timeout' is returned.
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
    // Refuses the whole sequence, not just the Escape, when the tile looks like
    // a modal dialog: a bare Escape can quit the CLI outright, and the paste
    // alone can silently confirm whatever option is highlighted.
    // Union of two independently-sourced signals (a geometric screen read, and
    // the text-pattern needs-attention detector), neither trusted alone: either
    // saying modal refuses, both must say non-modal to proceed.
    // A false refusal only costs one more idle cycle; the union cannot produce
    // a false negative that a single signal would have caught.
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
    // One write, bracketed-paste wrapped, with the CR inside the same string:
    // two separate writes did not submit, because ConPTY coalesces them into
    // one read and the CLI only turns a control byte into Enter when the whole
    // read is under 64 characters.
    // Do not split this back into two writes or add a delay; a delay is a race
    // that passes only on an idle machine.
    // write()'s own return value is consulted, not just the prior isAlive
    // check, since isAlive only proves liveness at that instant, not for this
    // specific write.
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    // 'written' guarantees pty.write() returned true and the bytes are the
    // shape the CLI submits at the main prompt; it does not guarantee the
    // terminal accepted them in every UI state.
    // On a modal dialog, a bare Escape quits the CLI outright, while the paste
    // alone confirms whichever option is highlighted; the screen-state guard
    // above this point is what stops both from reaching the dialog.
    // waitIdle's idleness signal is byte-recency, not RuntimeState.activity,
    // since the activity predicate is silent while the operator types.
    return 'written'
  }

  /**
   * Bare, non-idle-gated ESC write: Pause/Hard act on the process immediately
   * rather than asking the agent to wrap up.
   * Exactly one ESC, never doubled: the installed CLI has at least one screen
   * where a second Escape quits the session instead of interrupting it.
   * 'pause' routes through the same screen-state refusal injectCommand uses,
   * since pause's contract is explicitly reversible; 'hard' skips the gate
   * because ending the session by force is in its contract.
   * mode has no default, deliberately: a default here would let a future caller
   * silently get the ungated path.
   */
  interrupt(id: string, mode: 'pause' | 'hard'): 'interrupted' | 'no-terminal' | 'refused-modal' {
    if (!this.pty.isAlive(id)) return 'no-terminal'
    if (mode === 'pause') {
      if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
      if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
      // Third refusal signal: without it, a Pause landing during a quota-resume
      // window races autoResume's own raw ESC write, and a second bare ESC can
      // kill the session instead of interrupting it.
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
   * Resolves once the PTY has been quiet for at least ACTIVITY_IDLE_MS, or
   * false at the deadline.
   * Driven by byte recency, not RuntimeState.activity: OSC 0 stays silent while
   * the operator types, so gating on the activity field would open the write
   * gate exactly while a human is mid-keystroke.
   * A session with no output yet is treated as idle.
   */
  private async waitIdle(id: string, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const r = this.runtime.get(id)
      if (!r) return false
      const last = this.lastOutputAt(id)
      if (last === null || Date.now() - last >= ACTIVITY_IDLE_MS) return true
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
        // Fires for any transition to a live id, carrying the previous one,
        // rather than only on first resolution: a rotated id (e.g. after
        // /clear) now reaches the consumer instead of changing silently.
        // Nothing is emitted when a tile loses its id: there is no id to
        // announce and naming an empty one would be believed.
        // A restored tile now also reaches the consumer at its first
        // resolution; harmless because the spawn-ack path is only armed after
        // create(), so a restored tile never has an ack pending.
        if (next) {
          // `id` rides along for the supervisor spawn-ack loop (TS3), which
          // the consumer keeps pinned to first resolution.
          this.emit('peer-resolved', {
            id: def.id,
            peerId: next,
            previousPeerId: r.peerId,
            intent: r.announce
          })
          // One-shot: consume the join intent so a later rotation or set_id
          // rename re-announces as a ROTATION, never a second join.
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
