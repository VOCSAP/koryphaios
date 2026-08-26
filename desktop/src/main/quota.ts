// Usage-limit (quota) detection + auto-resume scheduling (PLAN-v0.4 C1).
//
// Pattern-matches Claude Code's rate-limit messages in the PTY output stream,
// parses the reset time the message itself prints, and emits `resume-due` once
// that time passes so the session service can inject a "continue" keystroke.
// The regex families mirror henryaj/autoclaude (verified against its sources):
// old format ("limit reached ∙ resets 2pm"), new format ("You've hit your
// limit · resets 10pm (Europe/London)"), minutes remaining ("resets 8m"), plus
// conservative word-boundary fallbacks with no captured time.
//
// Unlike tmux capture-pane (which re-reads the whole screen every poll), the
// PTY stream arrives in chunks and a message can be split across two of them,
// so detection runs on a small per-session ROLLING buffer of ANSI-stripped
// text rather than chunk by chunk.
//
// Like thinking.ts, this module stays deliberately heuristic and isolated so
// the rules can be tuned per Claude Code version without touching the service.

import { EventEmitter } from 'node:events'
import { createSafeStripper } from './detect/safe-strip'

export interface QuotaLimitEvent {
  id: string
  /** Epoch ms of the printed reset time, or null when the message had none. */
  resetAt: number | null
}

export interface QuotaClearEvent {
  id: string
}

export interface QuotaResumeDueEvent {
  id: string
}

// Strips CSI (colours, cursor moves) AND OSC (title, progress, notify --
// card 1aa69066/H2) sequences, so a marker wrapped in colour codes still
// matches, AND text carried inside an OSC payload (e.g. the spinner glyph in
// Claude Code's own OSC 0 title, measured in docs/DESIGN-NOTIFY-EVENTS.md)
// cannot spuriously feed FALLBACK_PATTERNS below. One combined regex rather
// than two, deliberately: a per-chunk strip alone cannot remove an OSC
// sequence fragmented across two PTY chunks (its first half has no
// terminator yet, so nothing matches), which is why `feed()` below re-runs
// this same function on the ACCUMULATED buffer after concatenation, not
// only on the incoming per-chunk delta.
//
// OSC branch's class EXCLUDES ESC (not just BEL) -- that exclusion, not
// the `{0,4096}` bound alongside it, is what prevents the quadratic blowup
// on an adversarial buffer full of unterminated "ESC ]" heads on the main
// process's hot PTY path. Corrected false pointer, card 1aa69066 review
// round 3 (T5): the bound ALONE, without the ESC exclusion, measured
// WORSE than the original unfixed regex. Full measurement + rationale on
// attention.ts's own ANSI_RE comment; tests/desktop-osc-perf.test.ts pins
// both properties, separately, for all four files that carry this class.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b\n]{0,4096}(?:\x07|\x1b\\))/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Busy cues (thinking.ts): a running turn means the rate-limit episode is over
// -- either the user resumed manually or our injected "continue" was accepted.
const BUSY_RE = /esc to interrupt|[⠀-⣿]/i

// Time-capturing patterns, tried in order. Group 1 = clock ("2pm", "10:30am").
const TIME_PATTERNS = [
  // "You've hit your limit · resets 10pm (Europe/London)"
  /hit\s+your\s+limit.*?resets?\s+(\d{1,2}(?::\d{2})?\s*[ap]m)/i,
  // "5-hour limit reached ∙ resets 2pm"
  /limit\s+reached.*?resets?\s+(\d{1,2}(?::\d{2})?\s*[ap]m)/i
]

// "Limit reached (resets 8m)" / "resets 45m" -> minutes from now.
const MINUTES_PATTERN = /(?:hit\s+your\s+limit|limit\s+reached).*?resets?\s+(\d{1,3})m\b/i

// Limit detected but no parseable time -> periodic retry. Word boundaries keep
// prose like "the limit of my patience" or "rate your experience" from matching.
const FALLBACK_PATTERNS = [
  /you['’]ve\s+hit\s+your\s+limit/i,
  /\blimit\s+reached\b/i,
  /\brate\s+limited\b/i
]

/**
 * Parse a clock string captured by TIME_PATTERNS ("2pm", "10:30am", "3 pm")
 * into an epoch ms anchored to `now`'s day, LOCAL timezone (the timezone name
 * Claude prints is ignored -- same trade-off as autoclaude). A time more than
 * one hour in the past is assumed to mean tomorrow; within the last hour it is
 * kept as-is so the resume trigger fires immediately.
 */
export function parseResetClock(clock: string, nowMs: number): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])m$/i.exec(clock.trim())
  if (!m) return null
  let hour = parseInt(m[1] ?? '', 10)
  const minute = m[2] ? parseInt(m[2], 10) : 0
  if (hour < 1 || hour > 12 || minute > 59) return null
  const pm = (m[3] ?? '').toLowerCase() === 'p'
  if (hour === 12) hour = pm ? 12 : 0
  else if (pm) hour += 12

  const at = new Date(nowMs)
  at.setHours(hour, minute, 0, 0)
  let t = at.getTime()
  if (t < nowMs - 3600_000) t += 24 * 3600_000
  return t
}

export interface RateLimitMatch {
  /** Epoch ms to resume at, or null when the message carried no usable time. */
  resetAt: number | null
}

/**
 * Detect a rate-limit message in an ANSI-stripped text window. Returns null
 * when nothing matches. Pure function, exported for the test suite.
 */
export function detectRateLimit(text: string, nowMs: number): RateLimitMatch | null {
  for (const re of TIME_PATTERNS) {
    const m = re.exec(text)
    if (m) return { resetAt: parseResetClock(m[1] ?? '', nowMs) }
  }
  const min = MINUTES_PATTERN.exec(text)
  if (min) return { resetAt: nowMs + parseInt(min[1] ?? '', 10) * 60_000 }
  for (const re of FALLBACK_PATTERNS) {
    if (re.test(text)) return { resetAt: null }
  }
  return null
}

/** Rolling-buffer cap: comfortably holds one redrawn screen of context. */
const MAX_BUF = 4096
/** Retry cadence when the reset time could not be parsed (autoclaude: 15 min). */
const DEFAULT_PERIODIC_MS = 15 * 60_000

interface SessionState {
  buf: string
  limited: boolean
  resetAt: number | null
  /** One-shot guard for the known-reset case (re-armed per episode). */
  sent: boolean
  timer: NodeJS.Timeout | null
  /**
   * Card 1aa69066 review, blocker F3: BUSY_RE's fast path (feed()'s
   * `st.limited` branch) tests the RAW per-chunk delta immediately, before
   * the accumulated-buffer re-strip (F2) runs -- a stateless regex strip on
   * a single chunk cannot remove an escape sequence whose terminator has
   * not arrived yet, so its raw bytes (e.g. a braille glyph carried by
   * Claude Code's own OSC 0 title) would otherwise leak straight into
   * BUSY_RE's input and falsely end an open episode. See
   * detect/safe-strip.ts's own header comment.
   */
  safe: ReturnType<typeof createSafeStripper>
}

/**
 * Tracks per-session rate-limit episodes from PTY output. Emits:
 * - 'limit'      (QuotaLimitEvent)     new episode detected
 * - 'clear'      (QuotaClearEvent)     episode over (a turn is running again)
 * - 'resume-due' (QuotaResumeDueEvent) time to inject the continue keystroke
 *
 * The detector only observes and schedules; the actual PTY write (and the
 * enabled/alive checks) belong to the session service.
 */
export class QuotaDetector extends EventEmitter {
  private sessions = new Map<string, SessionState>()

  constructor(
    private now: () => number = Date.now,
    private periodicMs: number = DEFAULT_PERIODIC_MS
  ) {
    super()
  }

  feed(id: string, data: string): void {
    const st = this.state(id)
    const stripped = stripAnsi(data)
    // Card 1aa69066 review round 3, blocker T1: `st.safe` MUST be fed on
    // EVERY chunk, unconditionally, not only while `st.limited` is true --
    // an incremental state machine fed a SUB-SAMPLED stream is no longer
    // incremental. The chunk that OPENS an episode (this one, seen before
    // `st.limited` flips true below) can itself carry an unterminated OSC
    // head; skipping it here left `st.safe` desynchronised from the real
    // byte stream, reopening F3 exactly where it had been measured closed.
    // attention.ts already has this right (`busySafe` computed before its
    // `if (st.waiting)` branch) -- this hoists quota.ts to match.
    const busySafe = st.safe.feed(data)

    if (st.limited) {
      // A running turn (spinner / interrupt hint) means the episode is over --
      // manual resume or accepted auto-continue. Detection stays quiet while
      // limited so a redrawn limit screen cannot re-trigger a fresh episode.
      // BUSY_RE reads the escape-safe delta, not raw `stripped` -- see
      // SessionState.safe's doc comment.
      if (BUSY_RE.test(busySafe)) this.endEpisode(id, st)
      return
    }

    // Re-strip the accumulated buffer (not just `stripped`, the per-chunk
    // delta): closes the cross-chunk OSC fragmentation gap, see the comment
    // on `stripAnsi` above.
    st.buf = stripAnsi((st.buf + stripped).slice(-MAX_BUF))
    const match = detectRateLimit(st.buf, this.now())
    if (!match) return

    st.limited = true
    st.resetAt = match.resetAt
    st.sent = false
    st.buf = '' // stale text must not re-trigger after the episode ends
    this.armTimer(id, st)
    this.emit('limit', { id, resetAt: st.resetAt } satisfies QuotaLimitEvent)
  }

  /** Forget a session (exit/remove/respawn): cancel timer, drop state. */
  clear(id: string): void {
    const st = this.sessions.get(id)
    if (st?.timer) clearTimeout(st.timer)
    this.sessions.delete(id)
  }

  /** Cancel every pending timer and drop all state (app shutdown / closeAll). */
  stop(): void {
    for (const id of [...this.sessions.keys()]) this.clear(id)
  }

  private state(id: string): SessionState {
    let st = this.sessions.get(id)
    if (!st) {
      st = { buf: '', limited: false, resetAt: null, sent: false, timer: null, safe: createSafeStripper() }
      this.sessions.set(id, st)
    }
    return st
  }

  private endEpisode(id: string, st: SessionState): void {
    if (st.timer) clearTimeout(st.timer)
    st.timer = null
    st.limited = false
    st.resetAt = null
    st.buf = ''
    this.emit('clear', { id } satisfies QuotaClearEvent)
  }

  private armTimer(id: string, st: SessionState): void {
    if (st.timer) clearTimeout(st.timer)
    if (st.resetAt !== null) {
      // Known reset time -> a single resume-due at (or immediately past) it.
      const delay = Math.max(0, st.resetAt - this.now())
      st.timer = setTimeout(() => {
        st.timer = null
        if (st.limited && !st.sent) {
          st.sent = true
          this.emit('resume-due', { id } satisfies QuotaResumeDueEvent)
        }
      }, delay)
    } else {
      // Unknown reset time -> keep retrying every periodicMs while limited.
      st.timer = setTimeout(() => {
        st.timer = null
        if (!st.limited) return
        this.emit('resume-due', { id } satisfies QuotaResumeDueEvent)
        this.armTimer(id, st)
      }, this.periodicMs)
    }
    if (typeof st.timer.unref === 'function') st.timer.unref()
  }
}
