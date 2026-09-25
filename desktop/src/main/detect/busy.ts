// "A turn is running" cue shared by the rate-limit (quota.ts) and "needs you"
// (attention.ts) detectors.
// The footer hint "esc to interrupt" is not enough on its own: Claude Code
// hides the footer's keyboard hints whenever a statusLine is configured (the
// Deck's own, or the operator's global one), so the spinner row and the OSC 0
// title spinner are read too. Each cue is content-based and dies silently if
// the CLI renames it, hence several independent ones.
// Title frequency alone cannot replace them: an isolated idle-glyph title is
// emitted at every UI change, including the end of the turn that prints a
// limit screen.

import { createSafeStripper } from './safe-strip'
import { createOscParser } from './osc'

// The footer hint counts anywhere on screen: nothing else prints it.
export const FOOTER_HINT_RE = /esc to interrupt/i

// Spinner-row pieces: the elapsed timer "(3s \u00b7" / "(1m 5s \u00b7", the token
// counter "\u2193 26 tokens" and the "\u00b7 thinking)" suffix. Diff content, a
// background-agent row or the operator's statusLine can print the same words,
// so they only count on a spinner row (hasSpinnerRowCue). Cursor moves replace
// spaces in a repainted row, hence `\s*`. The idle summary
// ("\u273b Worked for 2s \u00b7 done") carries no parenthesised timer.
export const SPINNER_CUE_RE = /\((?:\d+m\s*)?\d+s\s*\u00b7|[\u2191\u2193]\s*\d[\d.,]*k?\s*tokens\b|\u00b7\s*thinking\)/i

// Spinner frames painted in column 1 of the spinner row by the Linux CLI
// (\u2722 \u2736 \u273b \u273d, plus the ASCII-looking \u00b7 and "*"), and \u2733,
// the CLI's macOS stand-in for "*": taken from its per-platform frame set, no
// macOS capture confirms it. \u00b7 and "*" are ordinary punctuation (a
// markdown bullet), so they count only followed by the whole verb and its
// ellipsis.
const SPINNER_HEAD_RE = /^\s*(?:[\u2722\u2733\u2736\u273b\u273d]|[\u00b7*]\s*\p{L}+(?:\u2026|\.\.\.))/u
// The verb with its ellipsis when the glyph was not repainted in this frame.
const VERB_HEAD_RE = /^\s*\p{Lu}\p{Ll}+(?:\u2026|\.\.\.)/u
// The renderer paints the first timer frame alone at a cursor-moved position;
// that exact line is the spinner row's own tail.
const BARE_TIMER_RE = /^\s*\((?:\d+m\s*)?\d+s\s*\u00b7\s*thinking\)\s*$/i

/**
 * Stands for a cursor-forward (CSI n C) in the text given to
 * hasPartialRepaintCue; a Unicode noncharacter, never painted by a terminal program.
 */
export const CURSOR_FORWARD_MARK = '\ufdd0'
// eslint-disable-next-line no-control-regex
const CURSOR_FORWARD_RE = /\x1b\[\d*C/g
const CURSOR_FORWARD_MARK_RE = /\ufdd0/g
// A partial repaint of the spinner row: the renderer returns to column 1,
// skips the unchanged cells with a cursor-forward, and rewrites only the
// changed tail, so neither the glyph nor the verb is on the line. Accepted only
// when that tail holds the token counter closed by the "\u00b7 thinking)" suffix,
// which only the spinner row prints; the arrow is optional because it too is
// skipped when unchanged.
const PARTIAL_REPAINT_RE = /^\ufdd0[^\r\n]*?\d[\d.,]*k?\s*tokens\s*\u00b7\s*thinking\)/i

/**
 * True when `text` (escape-free) holds a spinner row carrying a running-turn
 * cue. Rows are split on CR and LF: the renderer returns to column 1 with CR
 * before repainting a row, so a line is what one row repaint wrote.
 */
export function hasSpinnerRowCue(text: string): boolean {
  for (const line of text.split(/[\r\n]/)) {
    if (!SPINNER_CUE_RE.test(line)) continue
    if (SPINNER_HEAD_RE.test(line) || VERB_HEAD_RE.test(line) || BARE_TIMER_RE.test(line)) return true
  }
  return false
}

/**
 * True when `marked` (escape-free, each cursor-forward replaced by
 * CURSOR_FORWARD_MARK) holds a partial repaint of the spinner row: a line that
 * starts with a cursor-forward right after the return to column 1.
 */
export function hasPartialRepaintCue(marked: string): boolean {
  return marked.split(/[\r\n]/).some((line) => PARTIAL_REPAINT_RE.test(line))
}

// OSC 0 title glyphs painted only while a turn runs: half-circles, and braille
// frames on older CLIs. The idle title starts with a different glyph.
export const WORKING_TITLE_RE = /^[\u25d0-\u25d3\u2800-\u28ff]/

export interface BusyCue {
  /** Feed every raw PTY chunk, unfiltered; true when this chunk shows a running turn. */
  feed(chunk: string): boolean
}

/**
 * One instance per session. The text cue reads the escape-safe delta, never
 * raw bytes: a sequence whose terminator has not arrived yet is held back, so
 * text carried inside an escape sequence cannot pass for screen content.
 * `title: true` also counts a newly applied working title; attention.ts opts
 * out because whether the title keeps animating while a chooser waits on the
 * operator is unmeasured.
 */
export function createBusyCue(opts: { title: boolean }): BusyCue {
  const safe = createSafeStripper()
  const osc = opts.title ? createOscParser() : null
  let lastSeq = 0

  return {
    feed(chunk: string): boolean {
      // A cursor-forward split across chunks stays unmarked: at worst a missed cue.
      const marked = safe.feed(chunk.replace(CURSOR_FORWARD_RE, CURSOR_FORWARD_MARK))
      const text = marked.replace(CURSOR_FORWARD_MARK_RE, '')
      let titleBusy = false
      if (osc) {
        const snap = osc.feed(chunk)
        if (snap.titleSeq > lastSeq) {
          lastSeq = snap.titleSeq
          titleBusy = WORKING_TITLE_RE.test(snap.title ?? '')
        }
      }
      return titleBusy || FOOTER_HINT_RE.test(text) || hasSpinnerRowCue(text) || hasPartialRepaintCue(marked)
    }
  }
}
