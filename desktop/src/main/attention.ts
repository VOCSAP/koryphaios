// "Needs you" detection (PLAN C11). Claude Code stops and waits for the
// operator on several screens -- tool-permission prompts, plan approvals,
// trust prompts, multiple-choice questions. Nothing in the Deck surfaced
// that: with several tiles you had to eyeball them. Same pattern as quota.ts:
// a rolling ANSI-stripped buffer per session, conservative regexes, one
// episode at a time, closed as soon as a turn runs again (busy cues).

import { EventEmitter } from 'node:events'
import { detectChannelsWarning } from './startup-ack'
import { createBusyCue, type BusyCue } from './detect/busy'
import type { ScreenWitness, ScreenWitnessWindow } from './attention-screen-witness'

export interface AttentionEvent {
  id: string
  waiting: boolean
  /**
   * True only when the operator dismissed the flag by hand. Load-bearing:
   * index.ts reads `waiting: false` as "a turn ran, someone answered" and
   * claims the open remote approval, but a manual dismiss means the flag was
   * wrong, so the consumer skips claiming when this is set.
   */
  manual?: boolean
}

// Excludes ESC, not just BEL, from the OSC branch's character class: without
// it, an unterminated OSC head is quadratic on an adversarial buffer, and
// excluding ESC makes each new escape head halt the match immediately
// regardless of any length bound.
// The `{0,4096}` bound still matters separately, for memory on a plain-text OSC
// body with no ESC and no terminator.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b\n]{0,4096}(?:\x07|\x1b\\))/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Workspace trust prompt, both wordings. The current one ("Quick safety check")
// is an unnumbered chooser whose words, and on ConPTY whose rows, are placed by
// cursor moves the stripper deletes, hence `\s*` and no required line break;
// both options are required, in order, so prose saying "I trust this folder"
// does not raise. No `\b` after "folder": ConPTY glues it to the next row.
const TRUST_PATTERNS = [
  /\bdo you trust the files\b/i,
  /No,\s*exit\s*(?:\u276f\s*)?Yes,\s*I\s*trust\s*this\s*folder/i
]

// The welcome banner ("Claude Code v2.1.282"; cursor moves may eat the spaces)
// that the CLI paints once the trust prompt is accepted. Accepting runs no turn,
// so no busy cue ends that episode.
const WELCOME_BANNER_RE = /Claude\s*Code\s*v\d+\.\d+\.\d+/

/** The part of `text` after the first trust prompt in it, or null when it holds none. */
function afterTrustPrompt(text: string): string | null {
  for (const re of TRUST_PATTERNS) {
    const m = re.exec(text)
    if (m) return text.slice(m.index + m[0].length)
  }
  return null
}

// The 2.1.229 prompt numbers its options with "Yes" first and highlighted, so no
// TRUST_PATTERNS entry (which expects "No, exit" first) matches it.
const NUMBERED_TRUST_RE = /Yes,\s*I\s*trust\s*this\s*folder\s*(?:\u276f\s*)?2\.\s*No,\s*exit/i

/** Whether a trust prompt is on the screen `lines` (rows of the visible snapshot). */
export function trustPromptShown(lines: readonly string[]): boolean {
  const text = lines.join('\n')
  return TRUST_PATTERNS.some((re) => re.test(text)) || NUMBERED_TRUST_RE.test(text)
}

const SELECTOR = '\u276f'
const BORDER = '\u2500'

// A numbered chooser (tool permission, plan approval, AskUserQuestion, resume)
// raises by default: footers and questions vary too much to list. Its selected
// option shares the glyph with the echo of a submitted prompt and with the
// composer, so only the LAST glyph in the buffer counts, since the empty
// composer is painted below an echo once a turn settles. The period is not
// required: a selection repaint redraws only changed cells ("\u276f1Yes"). A
// glyph right under a border is the composer holding a numbered draft, and
// "esc to interrupt" after it is a running turn.
// Free-text questions without a menu are NOT detected (accepted v1 limit).
function detectChooser(text: string): boolean {
  const at = text.lastIndexOf(SELECTOR)
  if (at < 0) return false
  const tail = text.slice(at + 1)
  if (!/^\s*1/.test(tail) || /esc\s*to\s*interrupt/i.test(tail)) return false
  return !text.slice(0, at).trimEnd().endsWith(BORDER)
}

const isWaitingScreen = (text: string): boolean => detectChooser(text) || TRUST_PATTERNS.some((re) => re.test(text))

// Exempts only the dev-channels startup warning's own two-cue screen (title and
// accept-option wording, both required via detectChannelsWarning), not any
// other auto-advancing single-option chooser.
// If either cue's wording changes, the exemption silently stops matching and
// this falls back to the waiting-screen rule with no error.
// purgeScreenMemory, called when startup-ack answers the dialog, is the actual
// guarantee against a stuck false exemption; the re-scan fallback only bounds
// it.
export function detectWaiting(text: string): boolean {
  if (detectChannelsWarning(text)) {
    return TRUST_PATTERNS.some((re) => re.test(text))
  }
  return isWaitingScreen(text)
}

// Deliberately does not reuse detectWaiting's exemption: raising and clearing
// are opposite decisions under uncertainty, and reusing it let a real chooser's
// flag get cleared by unrelated dev-channels text entering the buffer
// afterward.
// Only clears on positive evidence the chooser is gone: a running turn, the
// composer box, or no glyph left in the window. Moving the selection off
// option 1 leaves the glyph on another option, which is still a chooser; and a
// non-manual clear settles the tile's approvals as answered in the terminal.
function stillWaiting(text: string): boolean {
  if (TRUST_PATTERNS.some((re) => re.test(text))) return true
  const at = text.lastIndexOf(SELECTOR)
  if (at < 0) return false
  if (/esc\s*to\s*interrupt/i.test(text.slice(at + 1))) return false
  return !text.slice(0, at).trimEnd().endsWith(BORDER)
}

export const screenShowsWait = (text: string): boolean => detectWaiting(text) || stillWaiting(text)

// Load-bearing for one of five ways a raised flag clears: a busy cue,
// purgeScreenMemory on the dev-channels ack, the welcome screen following a
// trust prompt, the operator dismissing it by hand, or the raising pattern
// sliding out of this window once it fills. The last path is real but bounded and rare; comparing against the current
// screen instead of a cumulative buffer would remove it but is out of scope
// here.
const MAX_BUF = 4096

// Full-screen repaints take roughly 300 ms; 1.5 s filters them before raising attention.
export const ATTENTION_CONFIRMATION_DELAY_MS = 1_500

const MAX_CONSECUTIVE_VETOES = 3

export interface AttentionDetectorOptions {
  confirmationDelayMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
  clearTimeout?: (timer: unknown) => void
  /** Can only drop a raise at its deadline; never raises and never clears. */
  screenWitness?: ScreenWitness
}

interface SessionState {
  buf: string
  waiting: boolean
  pending: object | null
  timer?: unknown
  witness?: ScreenWitnessWindow
  /** A running turn means the operator answered (or the wait screen is gone). */
  busy: BusyCue
}

/**
 * Tracks per-session "waiting for the operator" episodes from PTY output.
 * Emits 'attention' on transitions: waiting=true after a screen persists for
 * the confirmation delay, waiting=false immediately when the screen clears.
 */
export class AttentionDetector extends EventEmitter {
  private sessions = new Map<string, SessionState>()
  private readonly confirmationDelayMs: number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly screenWitness: ScreenWitness | undefined

  constructor(options: AttentionDetectorOptions = {}) {
    super()
    this.screenWitness = options.screenWitness
    this.confirmationDelayMs = options.confirmationDelayMs ?? ATTENTION_CONFIRMATION_DELAY_MS
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>))
  }

  private cancelPending(st: SessionState): void {
    if (st.pending === null) return
    if (st.timer !== undefined) this.clearTimer(st.timer)
    st.witness?.cancel()
    st.pending = null
    st.timer = undefined
    st.witness = undefined
  }

  private scheduleConfirmation(id: string, st: SessionState, vetoes = 0): void {
    const pending = {}
    st.pending = pending
    st.witness = this.screenWitness?.arm(id, this.confirmationDelayMs, { setTimeout: this.setTimer, clearTimeout: this.clearTimer })
    const timer = this.setTimer(() => {
      if (st.pending !== pending) return
      const witness = st.witness
      st.pending = null
      st.timer = undefined
      st.witness = undefined
      if (this.sessions.get(id) !== st || st.waiting || !stillWaiting(st.buf)) return
      // The buffer is kept and the check re-armed, so a wrong veto only delays the raise;
      // the bound stops a stale buffer from re-arming for ever.
      if (witness?.decide()) {
        if (vetoes + 1 < MAX_CONSECUTIVE_VETOES) this.scheduleConfirmation(id, st, vetoes + 1)
        return
      }
      st.waiting = true
      this.emit('attention', { id, waiting: true } satisfies AttentionEvent)
    }, this.confirmationDelayMs)
    if (st.pending === pending) st.timer = timer
  }

  feed(id: string, data: string): void {
    let st = this.sessions.get(id)
    if (!st) {
      st = { buf: '', waiting: false, pending: null, busy: createBusyCue({ title: false }) }
      this.sessions.set(id, st)
    }
    const stripped = stripAnsi(data)
    const busy = st.busy.feed(data)

    if (st.waiting) {
      if (busy) {
        st.waiting = false
        st.buf = ''
        this.emit('attention', { id, waiting: false } satisfies AttentionEvent)
        return
      }
      // Fallback clearer: some dismissals never produce a busy cue (the
      // dev-channels auto-ack, an accepted trust prompt), so the retained
      // buffer is re-scanned with `stillWaiting`, never `detectWaiting`:
      // clearing must never go through the dev-channels exemption.
      // Re-strip the accumulated buffer (not just `stripped`, the per-chunk
      // delta): closes the cross-chunk OSC fragmentation gap, see the
      // comment on `stripAnsi` above.
      st.buf = stripAnsi((st.buf + stripped).slice(-MAX_BUF))
      // The welcome screen painted after the trust prompt means it was
      // answered: drop the prompt's text but re-scan what followed it, so a
      // repainted prompt or a chooser drawn after the banner holds the flag.
      const afterTrust = afterTrustPrompt(st.buf)
      if (afterTrust !== null && WELCOME_BANNER_RE.test(afterTrust)) st.buf = afterTrust
      if (!stillWaiting(st.buf)) {
        st.waiting = false
        st.buf = ''
        this.emit('attention', { id, waiting: false } satisfies AttentionEvent)
      }
      return
    }

    // A busy cue invalidates the accumulated context (a wait screen never
    // coexists with a running turn) but the SAME chunk may already carry the
    // prompt that follows the turn's end -- so reset FIRST, then append.
    if (busy) st.buf = ''
    // Re-strip the accumulated buffer, same reasoning as the branch above.
    st.buf = stripAnsi((st.buf + stripped).slice(-MAX_BUF))
    const afterWelcome = afterTrustPrompt(st.buf)
    if (afterWelcome !== null && WELCOME_BANNER_RE.test(afterWelcome)) st.buf = afterWelcome
    if (st.pending !== null && (busy || !stillWaiting(st.buf))) this.cancelPending(st)
    if (st.pending === null && detectWaiting(st.buf)) this.scheduleConfirmation(id, st)
  }

  clear(id: string): void {
    const st = this.sessions.get(id)
    if (st) this.cancelPending(st)
    this.sessions.delete(id)
  }

  /** Clears retained screen data and cancels an unconfirmed raise without changing confirmed attention. */
  purgeScreenMemory(id: string): void {
    const st = this.sessions.get(id)
    if (st) {
      this.cancelPending(st)
      st.buf = ''
    }
  }

  stop(): void {
    for (const st of this.sessions.values()) this.cancelPending(st)
    this.sessions.clear()
  }
}
