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

// Spinner-row pieces as painted by the CLI's diff renderer, where cursor moves
// replace spaces (hence `\s*`): the elapsed timer "(3s ·" / "(1m 5s ·", the
// token counter "↓ 26 tokens", the "· thinking)" suffix, and the footer hint.
// The idle summary ("\u273b Worked for 2s · done") carries no parenthesised timer.
export const BUSY_TEXT_RE = /esc to interrupt|\((?:\d+m\s*)?\d+s\s*·|[↑↓]\s*\d[\d.,]*k?\s*tokens\b|·\s*thinking\)/i

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
      const text = safe.feed(chunk)
      let titleBusy = false
      if (osc) {
        const snap = osc.feed(chunk)
        if (snap.titleSeq > lastSeq) {
          lastSeq = snap.titleSeq
          titleBusy = WORKING_TITLE_RE.test(snap.title ?? '')
        }
      }
      return titleBusy || BUSY_TEXT_RE.test(text)
    }
  }
}
