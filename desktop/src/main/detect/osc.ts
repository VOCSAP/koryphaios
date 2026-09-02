// Retains only the last title, last progress, and last OSC 777 body seen, no
// history. Classifying the 777 body is left to the caller: an unrecognised body
// must still raise a generic event, never be silently dropped.
// Per-instance state only, closed over local variables, so two sessions holding
// their own parser instance can never share a continuation buffer even with
// interleaved chunks.

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
  /**
   * Monotone count of applied OSC 0/2 payloads (card f8082208 / docs/
   * DESIGN-ACTIVITY-PREDICATE.md section 4). Increments once per
   * applyPayload() call for ps==='0'||'2', REGARDLESS of whether the title
   * text differs from the previous one -- a burst of identical titles (the
   * M4 case measured on that card: six identical emissions then silence)
   * must still register as six observations, not one, or a caller building
   * an activity predicate on this count would see no signal at all. Still
   * no clock, no rate: this module counts what it extracted, nothing more
   * (the module's own FREQUENCY DOES NOT ENTER header contract, unchanged).
   */
  titleSeq: number
}

/**
 * A pending OSC payload abandons past this length rather than accumulating
 * forever; a terminator arriving later for the abandoned sequence is just
 * ordinary input to whatever state 'idle' finds it in.
 * Fails open toward not losing data: a well-formed sequence embedded inside an
 * abandoned over-length payload is still parsed and applied, which can leak a
 * real title/progress/notify rather than staying inert.
 */
const OSC_MAX_LEN = 4096

const ESC = '\x1b'
const BEL = '\x07'
// 8-bit ST (single byte), same as safe-strip.ts's ST_8BIT: xterm in UTF-8
// mode (ConPTY, Claude Code) never emits it, but accepting it costs nothing
// and closes the same named gap safe-strip.ts already closed (card
// 1aa69066 review round 3 / card 5b324e11).
const ST_8BIT = String.fromCharCode(0x9c)

type Mode = 'idle' | 'esc-seen' | 'in-osc' | 'in-osc-esc-seen'

export function createOscParser(): { feed(chunk: string): OscSnapshot } {
  let title: string | null = null
  let progress: string | null = null
  let notify: OscNotify | null = null
  let titleSeq = 0

  let mode: Mode = 'idle'
  let buf = ''

  // payload is "<Ps>;<rest...>" per the OSC syntax all three families share.
  function applyPayload(payload: string): void {
    const firstSemi = payload.indexOf(';')
    const ps = firstSemi === -1 ? payload : payload.slice(0, firstSemi)
    const rest = firstSemi === -1 ? '' : payload.slice(firstSemi + 1)
    if (ps === '0' || ps === '2') {
      title = rest
      titleSeq++
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

  // Abandons the pending sequence immediately on overflow, clearing buf and
  // exiting to 'idle' right here, rather than leaving `mode` stuck and silently
  // dropping every subsequent legitimate sequence.
  // The caller must not consume a character it has not itself appended: the
  // 'in-osc' call site appends and advances past `c`, while 'in-osc-esc-seen'
  // appends the pending ESC and reprocesses `c` fresh, so that call site never
  // advances `i`.
  function appendAndCheckCap(s: string): boolean {
    buf += s
    if (buf.length > OSC_MAX_LEN) {
      buf = ''
      mode = 'idle'
      return true
    }
    return false
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
          if (c === BEL || c === ST_8BIT) {
            applyPayload(buf)
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
            appendAndCheckCap(c)
            i++
          }
          break

        case 'in-osc-esc-seen':
          if (c === '\\') {
            applyPayload(buf)
            mode = 'idle'
            i++
          } else if (!appendAndCheckCap(ESC)) {
            // Not a real ST: the held ESC was literal payload content, and
            // appending it did not overflow the cap -- re-enter 'in-osc'
            // and reprocess THIS character under it (do not advance i)
            // instead of assuming it is ordinary text -- it may itself be
            // BEL, or the start of a real terminator.
            mode = 'in-osc'
          }
          // else: appendAndCheckCap already abandoned to 'idle'; `i` is
          // deliberately NOT advanced either way, so this character is
          // reprocessed fresh under whichever mode is now current.
          break
      }
    }
    return { title, progress, notify, titleSeq }
  }

  return { feed }
}
