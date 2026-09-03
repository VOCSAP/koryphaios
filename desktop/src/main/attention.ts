// "Needs you" detection (PLAN C11). Claude Code stops and waits for the
// operator on several screens -- tool-permission prompts, plan approvals,
// trust prompts, multiple-choice questions. Nothing in the Deck surfaced
// that: with several tiles you had to eyeball them. Same pattern as quota.ts:
// a rolling ANSI-stripped buffer per session, conservative regexes, one
// episode at a time, closed as soon as a turn runs again (busy cues).

import { EventEmitter } from 'node:events'
import { detectChannelsWarning } from './startup-ack'
import { createSafeStripper } from './detect/safe-strip'

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

// A running turn means the operator answered (or the wait screen is gone).
const BUSY_RE = /esc to interrupt|[⠀-⣿]/i

// Waiting screens, deliberately narrow: ONLY strong screen-level cues, since
// a running turn can stream prose/code containing question-like sentences.
// The numbered-chooser selector ("❯ 1.") covers tool-permission prompts, plan
// approvals and AskUserQuestion menus; the trust prompt has its own wording.
// Free-text questions without a menu are NOT detected (accepted v1 limit).
const WAITING_PATTERNS = [
  /❯\s*1\./, // selected first option of a numbered chooser
  /\bdo you trust the files\b/i
]

// Exempts only the dev-channels startup warning's own two-cue screen (title and
// accept-option wording, both required via detectChannelsWarning), not any
// other auto-advancing single-option chooser.
// If either cue's wording changes, the exemption silently stops matching and
// this falls back to WAITING_PATTERNS with no error.
// purgeScreenMemory, called when startup-ack answers the dialog, is the actual
// guarantee against a stuck false exemption; the re-scan fallback only bounds
// it.
export function detectWaiting(text: string): boolean {
  if (detectChannelsWarning(text)) {
    return /\bdo you trust the files\b/i.test(text)
  }
  return WAITING_PATTERNS.some((re) => re.test(text))
}

// Deliberately does not reuse detectWaiting's exemption: raising and clearing
// are opposite decisions under uncertainty, and reusing it let a real chooser's
// flag get cleared by unrelated dev-channels text entering the buffer
// afterward.
// Only clears on positive evidence the raising pattern itself is gone.
function stillWaiting(text: string): boolean {
  return WAITING_PATTERNS.some((re) => re.test(text))
}

// Load-bearing for one of four ways a raised flag clears: a busy cue,
// purgeScreenMemory on the dev-channels ack, the operator dismissing it by
// hand, or the raising pattern sliding out of this window once it fills.
// The fourth path is real but bounded and rare; comparing against the current
// screen instead of a cumulative buffer would remove it but is out of scope
// here.
const MAX_BUF = 4096

interface SessionState {
  buf: string
  waiting: boolean
  /**
   * Card 1aa69066 review, blocker F3: BUSY_RE's fast path tests the RAW
   * per-chunk delta, immediately, before the accumulated-buffer re-strip
   * (F2) even runs -- deliberately, for responsiveness. A stateless regex
   * strip on that single chunk cannot remove an escape sequence whose
   * terminator has not arrived yet, so its raw bytes (including any glyph
   * it carries, e.g. Claude Code's own OSC 0 title spinner) would otherwise
   * leak straight into BUSY_RE's input. This per-session incremental
   * stripper holds back any not-yet-resolved sequence instead -- see
   * detect/safe-strip.ts's own header comment.
   */
  safe: ReturnType<typeof createSafeStripper>
}

/**
 * Tracks per-session "waiting for the operator" episodes from PTY output.
 * Emits 'attention' (AttentionEvent) on transitions only: waiting=true when a
 * wait screen is detected, waiting=false when a turn runs again.
 */
export class AttentionDetector extends EventEmitter {
  private sessions = new Map<string, SessionState>()

  feed(id: string, data: string): void {
    let st = this.sessions.get(id)
    if (!st) {
      st = { buf: '', waiting: false, safe: createSafeStripper() }
      this.sessions.set(id, st)
    }
    const stripped = stripAnsi(data)
    // See SessionState.safe's doc comment: BUSY_RE must never read raw
    // bytes from an escape sequence that has not resolved yet.
    const busySafe = st.safe.feed(data)

    if (st.waiting) {
      if (BUSY_RE.test(busySafe)) {
        st.waiting = false
        st.buf = ''
        this.emit('attention', { id, waiting: false } satisfies AttentionEvent)
        return
      }
      // Fallback clearer (card 4f0143ff, scope b): some dismissals never
      // produce a busy cue -- e.g. startup-ack.ts auto-Enters the
      // dev-channels dialog, which just returns to an idle prompt, no turn
      // ever runs. Re-scan the retained buffer with `stillWaiting`, NOT
      // `detectWaiting` (review of 4f0143ff, team-lead's asymmetry finding):
      // clearing must never go through the dev-channels exemption, only
      // through positive evidence the raising pattern is gone. See
      // `stillWaiting`'s own comment for the measured reverse-order bug this
      // avoids.
      // Re-strip the accumulated buffer (not just `stripped`, the per-chunk
      // delta): closes the cross-chunk OSC fragmentation gap, see the
      // comment on `stripAnsi` above.
      st.buf = stripAnsi((st.buf + stripped).slice(-MAX_BUF))
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
    if (BUSY_RE.test(busySafe)) st.buf = ''
    // Re-strip the accumulated buffer, same reasoning as the branch above.
    st.buf = stripAnsi((st.buf + stripped).slice(-MAX_BUF))
    if (detectWaiting(st.buf)) {
      st.waiting = true
      // Do NOT reset buf here (BLOCKER 1, review of 4f0143ff): the re-scan
      // fallback above reads st.buf, not the raw screen, so the buffer at
      // the moment of raising IS "the retained screen" the fallback's own
      // comment promises. Wiping it made the first waiting-branch feed()
      // re-scan an empty-or-near-empty string instead -- a chunk that
      // stripped to pure ANSI (cursor moves, no visible text) cleared the
      // flag on the very next feed() while the wait screen was still fully
      // on screen, just not retransmitted. Keeping buf lets the sliding
      // MAX_BUF window carry the matched content forward exactly like it
      // does for every other feed() call.
      this.emit('attention', { id, waiting: true } satisfies AttentionEvent)
    }
  }

  clear(id: string): void {
    this.sessions.delete(id)
  }

  /**
   * Purge the retained screen buffer for a session WITHOUT touching its
   * `waiting` state (card 4f0143ff review, MAJOR 3 follow-up). Wired from
   * session-service.ts's startup-ack `ack` handler: once that dialog is
   * confirmed dismissed, its text has no further reason to sit in this
   * detector's window and influence either predicate above. Never call
   * `clear()` for this -- clear() also drops `waiting`, which would silently
   * un-raise a genuine, unrelated wait that happens to be active at the same
   * moment (rare, but dropping a real flag with no emitted event is worse
   * than leaving a few stale bytes for one more feed() cycle).
   */
  purgeScreenMemory(id: string): void {
    const st = this.sessions.get(id)
    if (st) st.buf = ''
  }

  stop(): void {
    this.sessions.clear()
  }
}
