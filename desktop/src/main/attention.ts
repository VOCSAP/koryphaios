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
   * True only when the operator dismissed the flag by hand (SessionService's
   * clearAttention). Load-bearing, not informational: the consumer in
   * index.ts reads `waiting: false` as "a turn ran, so someone answered" and
   * claims the open remote approval with answerKind 'allow'. That inference
   * holds for the automatic clearers and is FALSE for a manual dismiss,
   * which means "this flag was wrong" -- so the consumer skips claiming when
   * this is set. Declared here rather than passed as an ad-hoc property so
   * that the sites which must agree (this one, SessionAttentionEvent in
   * shared/types.ts, and the consumer's parameter in index.ts) fail to
   * compile if they drift; a typo in a bare string key would otherwise
   * reopen the approval bug in silence.
   */
  manual?: boolean
}

// Strips CSI (colours, cursor moves) AND OSC (title, progress, notify --
// card 1aa69066/H2) sequences. Combined into ONE regex rather than two
// separate ones so the fix is atomic in the source: a per-chunk strip alone
// cannot remove an OSC sequence fragmented across two PTY chunks (its first
// half has no terminator yet, so nothing matches), which is why `feed()`
// below re-runs this same function on the ACCUMULATED buffer after
// concatenation, not only on the incoming per-chunk delta -- by then both
// halves of a previously-split sequence sit adjacent and the OSC branch
// matches.
//
// THE OSC BRANCH'S CHARACTER CLASS EXCLUDES ESC (not just BEL) --
// measured regression, card 1aa69066 review round 2: `[^\x07]*?` (lazy,
// unbounded, BEL-only exclusion) is quadratic on an adversarial
// MAX_BUF-sized buffer full of unterminated "ESC ]" heads (each restarts a
// full lazy backtracking scan), 0.04ms at n=512 to 2.34ms at n=4096 -- a
// `cat` of a binary file into a tile hits this on the Electron main
// process's hot PTY-data path, x3 detectors x N sessions.
//
// FALSE POINTER, CORRECTED (review round 3, blocker T5): the FIRST fix
// attributed this to the `{0,4096}` bound. MEASURED WRONG: the same class
// made UNBOUNDED but with ESC still excluded, `[^\x07\x1b\n]*?`, is
// FASTER (0.0035ms) than the shipped bounded one (0.0216ms); a class that
// IS bounded but does NOT exclude ESC, `[^\x07]{0,4096}`, is 3.5507ms --
// WORSE than the ORIGINAL unfixed regex (2.6813ms). The bound is not what
// closes the hole. EXCLUDING ESC is: once ESC is excluded from the class,
// the next "ESC ]" head immediately halts that match attempt (backtracking
// has nowhere to grow), which is self-limiting on this adversarial shape
// regardless of any explicit cap. `{0,4096}` still matters, separately, for
// MEMORY on a pathological run containing neither ESC nor a terminator (a
// giant plain-text OSC body) -- but it is not the perf fix, and crediting
// it as one is exactly the false-pointer failure mode CLAUDE.md warns
// about: correct code, wrong stated reason, and the reason is what the
// next person trusts when they touch this line.
// tests/desktop-osc-perf.test.ts pins BOTH properties, separately.
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

// The dev-channels startup warning (startup-ack.ts) renders its own accept
// option as "❯ 1. I am using this for local development" -- a numbered
// chooser by construction, so it matches the pattern above even though
// startup-ack.ts is about to auto-Enter past it (one keystroke, not a
// genuine "needs you" wait). Card 4f0143ff, root cause. Recognise that
// screen via `detectChannelsWarning` (startup-ack.ts's own two-cue
// detector -- title AND accept-option wording, both required) and exclude
// it, rather than broadening BUSY_RE or weakening the chooser pattern for
// every other caller. Single source of a shared literal (MAJOR 4, review of
// 4f0143ff): a title-only regex duplicated from startup-ack.ts used to live
// here; importing the real two-cue predicate instead of re-deriving a
// weaker one-cue copy removes both the duplication and most of the false
// exemption surface (MAJOR 3, below) in one move. Does NOT cover: a genuine
// numbered chooser sharing the retained BUFFER with both cues. Note the unit
// -- detectWaiting runs on st.buf, a rolling MAX_BUF window, not on a
// screen, so "the warning is full-screen and nothing overlays it" is not the
// argument. Measured: feeding the warning and then a real permission prompt
// raises nothing until roughly 2000 to 4000 bytes of later output push the
// title out of the window. What actually keeps that ordinary sequence
// working in production is purgeScreenMemory, called from session-service
// when startup-ack answers the dialog: it drops the retained text at the
// moment the warning stops being on screen. That call is the guarantee, not
// a belt-and-suspenders extra -- with it stubbed out, the next genuine
// prompt is swallowed.
//
// Two more explicit non-coverage points (asked in review, card 4f0143ff):
//  - Any OTHER auto-advancing single-option chooser (present or future,
//    outside startup-ack.ts) with different wording is not exempted here
//    and still raises the flag once -- narrow > broad exemption, by design.
//  - If this dialog's wording is ever changed on ONE of the two cues,
//    `detectChannelsWarning` silently stops matching -- it does NOT throw or
//    log, it just falls through to WAITING_PATTERNS again, i.e. the
//    flag-raise regresses to pre-4f0143ff behaviour with no error anywhere.
// Both cases are bounded, not prevented, by the feed() re-scan fallback
// (scope b, below): the flag still gets raised, but it self-clears as soon
// as the PTY stream moves past the screen (one keystroke, for an
// auto-Enter dialog) instead of staying stuck -- which is what 4f0143ff was
// actually about. This exemption is a latency/UX optimization (skip the
// flicker), not the sole correctness guarantee; the re-scan is.
//
// Used to decide whether to RAISE the flag. Deliberately conservative in
// the direction of NOT raising when unsure -- a missed raise is bounded (the
// re-scan below, or a later screen, catches most real waits eventually),
// while a false raise is only a flicker at worst. detectWaitingForClear
// below is the mirror predicate for the OPPOSITE decision, and does NOT
// reuse this exemption (see its own comment for why the two must differ).
export function detectWaiting(text: string): boolean {
  if (detectChannelsWarning(text)) {
    return /\bdo you trust the files\b/i.test(text)
  }
  return WAITING_PATTERNS.some((re) => re.test(text))
}

// Used to decide whether an ALREADY-RAISED flag should be CLEARED by the
// re-scan fallback (scope b). Review of 4f0143ff (team-lead, reverse-order
// probe): reusing detectWaiting here is wrong, not just imprecise. Raising
// and clearing are opposite decisions under uncertainty -- staying silent
// when unsure is the safe default for a raise (the operator loses nothing
// they didn't already not have), but clearing when unsure loses an
// operator who IS actually waiting. The two must not share a predicate that
// treats "saw an exempted screen go by" as evidence for both.
// Measured (card 4f0143ff review): a real chooser raises the flag, then
// unrelated dev-channels text later enters the retained buffer (reverse
// order from the original bug) -- reusing detectWaiting's exemption cleared
// the flag on that text alone, without the chooser's own "❯ 1." pattern
// ever having left the buffer. This predicate never exempts: it only
// clears on POSITIVE evidence the raising pattern itself is gone (or, in
// feed() below, an explicit busy cue). Does NOT cover a wait screen
// replaced by a DIFFERENT wait screen with no cue in between (correctly
// stays waiting, since the pattern is still present).
function stillWaiting(text: string): boolean {
  return WAITING_PATTERNS.some((re) => re.test(text))
}

// Cap on the retained screen. Four things clear a raised flag; this
// constant is load-bearing for one of them, not just a memory guard-rail
// (review of 4f0143ff, team-lead -- a comment asserting a guarantee must be
// wired to it):
//  A. a busy cue (BUSY_RE) -- immediate, feed() checks it before anything
//     else touches st.buf.
//  B. purgeScreenMemory() on the startup-ack 'ack' event (session-service.ts)
//     -- immediate, scoped to the dev-channels dialog specifically.
//  C. the operator dismissing the flag by hand -- SessionService's
//     clearAttention calls clear(id), which drops both the flag and the
//     retained buffer. Added by this card; it is the reason this list says
//     four and not three.
//  D. none of the above: the ONLY thing left is stillWaiting(st.buf)
//     turning false once the raising pattern slides out of this window.
//     Measured (card 4f0143ff review, debugger): ~4050 bytes of ordinary
//     (non-busy-cue) output with no intervening ack. Real, but bounded and
//     rare -- most sessions hit A or D long before B -- and pre-existing,
//     not introduced or worsened by this card's fixes (measured identically
//     on the pre-fix code). Not fixed here: team-lead's explicit scope call,
//     since fixing it means comparing against the current screen instead of
//     a cumulative buffer, a rework big enough to want its own card.
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
