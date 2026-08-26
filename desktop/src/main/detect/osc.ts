// Pure incremental OSC extractor for the PTY data stream. Card 1aa69066 / H2
// of docs/DESIGN-HERDR-ADOPTION.md (amended 2026-08-26 to include OSC 777).
// No electron/node-pty import -- unit-testable directly under bun, same
// discipline as session-kind.ts and screen-model.ts.
//
// Captures three OSC families BEFORE the ANSI-stripping detectors see the
// chunk (attention.ts, quota.ts, startup-ack.ts all defined a CSI-only strip
// today, so OSC bytes survived untouched in their rolling buffers -- see the
// same card's context):
//   - OSC 0 / OSC 2 (title):  ESC ] 0 ; <text> BEL|ST   and  ESC ] 2 ; ...
//   - OSC 9;4 (progress):     ESC ] 9 ; 4 ; <state> ; <progress> BEL|ST
//   - OSC 777 (notify):       ESC ] 777 ; notify ; <title> ; <body> BEL|ST
// Retains only the LAST title and LAST progress seen (no history, per H2's
// design) and the LAST OSC 777 body. Classifying that body into one of the
// 21 kinds / 11 bodies measured on card f8082208 is deliberately left to the
// caller: DESIGN-NOTIFY-EVENTS.md section 6.4 is explicit that this table is
// ENRICHMENT, never an admission list -- an unrecognised body must still
// raise a generic level-A event, never be silently dropped. Returning the
// raw body here is what keeps that door open.
//
// FREQUENCY DOES NOT ENTER THIS MODULE, deliberately (H1's own portability
// contract in docs/DESIGN-HERDR-ADOPTION.md, "La FREQUENCE n'entre pas dans
// le moteur"). This module renders the last snapshot it saw -- never a rate,
// a timestamp or a clock. The activity predicate built on OSC 0's emission
// cadence lives entirely with the caller.
//
// INCREMENTAL AND SESSION-KEYED, BY CONSTRUCTION: an OSC sequence can be
// split across two consecutive PTY chunks, including mid-terminator (the
// ESC of an ST landing at the very end of one chunk, its backslash arriving
// at the start of the next). createOscParser() returns a per-instance state
// machine closed over its own local variables -- there is no module-level
// mutable state anywhere in this file, so two sessions that each hold their
// own instance can never share a continuation buffer even if their chunks
// arrive interleaved. session-service.ts is expected to hold one instance
// per session id in a Map, the same shape ScreenGuard (screen-model.ts) and
// the *Detector classes (attention.ts, quota.ts, startup-ack.ts) already use.
//
// NOT COVERED, deliberately (card 1aa69066 review, nit F6): the 8-bit ST
// terminator (single byte 0x9C) alongside the 7-bit two-byte form (ESC \\)
// handled below. xterm in UTF-8 mode -- what ConPTY/Claude Code emit here --
// only ever sends BEL or the 7-bit ESC \\ form, never a raw 0x9C, so this is
// a named gap, not a silent one.

/** The most recent OSC 777 notification body seen, unclassified (see header). */
export interface OscNotify {
  body: string
}

/** Last-seen snapshot of the three tracked OSC families. No history. */
export interface OscSnapshot {
  /** Last OSC 0/2 title payload, or null if none has been seen yet. */
  title: string | null
  /** Last OSC 9;4 progress payload (everything after "9;4;"), or null. */
  progress: string | null
  /** Last OSC 777 notification, or null. */
  notify: OscNotify | null
}

/**
 * A pending (over-length) OSC payload stops accumulating past this many
 * characters -- it is not silently kept forever, but its terminator is still
 * consumed when it eventually arrives, so the sequence AFTER it is not
 * itself swallowed as part of the abandoned one.
 */
const OSC_MAX_LEN = 4096

const ESC = '\x1b'
const BEL = '\x07'

type Mode = 'idle' | 'esc-seen' | 'in-osc' | 'in-osc-esc-seen'

export function createOscParser(): { feed(chunk: string): OscSnapshot } {
  let title: string | null = null
  let progress: string | null = null
  let notify: OscNotify | null = null

  let mode: Mode = 'idle'
  let buf = ''
  let capped = false

  // payload is "<Ps>;<rest...>" per the OSC syntax all three families share.
  function applyPayload(payload: string): void {
    const firstSemi = payload.indexOf(';')
    const ps = firstSemi === -1 ? payload : payload.slice(0, firstSemi)
    const rest = firstSemi === -1 ? '' : payload.slice(firstSemi + 1)
    if (ps === '0' || ps === '2') {
      title = rest
      return
    }
    if (ps === '9') {
      // "9;4;<state>;<progress>" -- keep everything after "9;4;" verbatim;
      // splitting state from progress is the caller's concern, not this
      // module's (it only extracts, per the header comment).
      if (rest.startsWith('4;')) progress = rest.slice(2)
      return
    }
    if (ps === '777') {
      // rest is "notify;<title>;<body>" -- both "notify" (the literal word,
      // constant across every kind measured on card f8082208) and <title>
      // (always "Claude Code" so far) are structural, not information; only
      // everything after the SECOND ';' is the body.
      const parts = rest.split(';')
      notify = { body: parts.length >= 3 ? parts.slice(2).join(';') : rest }
    }
  }

  function pushChar(c: string): void {
    if (capped) return
    buf += c
    if (buf.length > OSC_MAX_LEN) {
      // Drop what was accumulated: this sequence exceeded the cap and its
      // payload will never be applied, even once terminated (see 'in-osc'
      // and 'in-osc-esc-seen' below, both gated on `!capped`).
      capped = true
      buf = ''
    }
  }

  function feed(chunk: string): OscSnapshot {
    let i = 0
    while (i < chunk.length) {
      const c = chunk[i]!
      switch (mode) {
        case 'idle':
          if (c === ESC) mode = 'esc-seen'
          i++
          break

        case 'esc-seen':
          if (c === ']') {
            mode = 'in-osc'
            buf = ''
            capped = false
          } else if (c === ESC) {
            // Stay here: a second ESC could still be followed by ']'. This
            // does not need to be a general escape-sequence parser (unlike
            // screen-model.ts) -- it only has to avoid losing a genuine
            // "ESC ]" that happens to be preceded by an unrelated ESC.
          } else {
            mode = 'idle'
          }
          i++
          break

        case 'in-osc':
          if (c === BEL) {
            if (!capped) applyPayload(buf)
            mode = 'idle'
            i++
          } else if (c === ESC) {
            // Possible first half of an ST (ESC \\) terminator -- decided by
            // the NEXT character, which may only arrive in a later feed()
            // call if this ESC is the last byte of the current chunk. `mode`
            // alone carries that fact across the call boundary; no separate
            // buffering of a "maybe-terminator" byte is needed.
            mode = 'in-osc-esc-seen'
            i++
          } else {
            pushChar(c)
            i++
          }
          break

        case 'in-osc-esc-seen':
          if (c === '\\') {
            if (!capped) applyPayload(buf)
            mode = 'idle'
            i++
          } else {
            // Not a real ST: the held ESC was literal payload content.
            // Re-enter 'in-osc' and reprocess THIS character under it
            // (do not advance i) instead of assuming it is ordinary text --
            // it may itself be BEL, or the start of a real terminator.
            pushChar(ESC)
            mode = 'in-osc'
          }
          break
      }
    }
    return { title, progress, notify }
  }

  return { feed }
}
