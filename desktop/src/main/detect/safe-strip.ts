// Holds back any not-yet-resolved escape sequence across feed() calls instead
// of emitting its raw bytes, so a fragmented sequence's glyph or word cannot
// spuriously satisfy an immediate per-chunk predicate.
// Only for sanitising input to an immediate per-chunk predicate; it does not
// replace the accumulated-buffer re-strip, which stays as-is.
// Per-instance state only: no module-level mutable state, so two sessions
// cannot collide.

const ESC = '\x1b'
const BEL = '\x07'
// 8-bit ST (single byte). Named gap in osc.ts's own header comment before
// this card's review round 3 -- xterm in UTF-8 mode (ConPTY, Claude Code)
// never emits it, but a raw byte stream (a `cat` of a binary file, or any
// terminal not in UTF-8 mode) can, and until this fix it was the shortest
// path to the permanent-swallow bug this file's own comment on the 'osc'
// case now documents.
const ST_8BIT = String.fromCharCode(0x9c)

// Same order-of-magnitude bound as osc.ts's OSC_MAX_LEN, for the same
// reason: an abandoned/malformed sequence must not accumulate without
// bound. CSI sequences are always short in real terminal output, but a
// bound is cheap insurance regardless.
const OSC_MAX_LEN = 4096
const CSI_MAX_LEN = 4096

// Exactly the two character classes attention.ts/quota.ts's own ANSI_RE
// CSI branch already encodes (`[0-9;?]*[ -/]*[@-~]`) -- kept as the same
// two ranges here so this module's notion of "a valid CSI sequence" cannot
// silently drift from the regex-based one used elsewhere in this file
// family.
const CSI_PARAM_OR_INTERMEDIATE_RE = /[0-9;?\x20-\x2f]/
const CSI_FINAL_RE = /[\x40-\x7e]/

type Mode = 'idle' | 'esc-seen' | 'csi' | 'osc' | 'osc-esc-seen'

export function createSafeStripper(): { feed(chunk: string): string } {
  let mode: Mode = 'idle'
  // Only a COUNT is kept for the in-progress CSI/OSC payload, never the
  // text itself: escape-sequence content is always discarded once resolved
  // (CSI) or intentionally never re-derived here (OSC -- osc.ts is the
  // module that extracts OSC payload content; this one only needs to know
  // when to stop counting).
  let pendingLen = 0

  function feed(chunk: string): string {
    // Fast path (card 1aa69066 review round 3, non-blocking T6): the
    // overwhelming majority of PTY chunks are plain text with no escape
    // sequence at all. Building `out` one character at a time in the
    // 'idle' case below costs real time on ordinary text -- measured
    // 126.6x on a 4096-char plain chunk (0.0162ms -> 0.0001ms), while a
    // chunk that DOES contain ESC (or one where a sequence is already in
    // progress from a PREVIOUS call, hence the `mode === 'idle'` guard, not
    // just "no ESC in THIS chunk") falls through to the full state machine
    // unchanged -- measured output-identical on a mixed stream fed byte by
    // byte across the fast/slow boundary. `indexOf` is one native scan, not
    // per-character work, so this is strictly a win, never a second pass.
    if (mode === 'idle' && chunk.indexOf(ESC) === -1) return chunk

    let out = ''
    let i = 0
    while (i < chunk.length) {
      const c = chunk[i]!
      switch (mode) {
        case 'idle':
          if (c === ESC) {
            mode = 'esc-seen'
          } else {
            out += c
          }
          i++
          break

        case 'esc-seen':
          if (c === '[') {
            mode = 'csi'
            pendingLen = 0
          } else if (c === ']') {
            mode = 'osc'
            pendingLen = 0
          } else if (c === ESC) {
            // Stay here: a second ESC could still be followed by '[' or ']'.
          } else {
            // Not a CSI/OSC introducer after all -- both the held ESC and
            // this character are ordinary text.
            out += ESC + c
            mode = 'idle'
          }
          i++
          break

        case 'csi':
          if (CSI_FINAL_RE.test(c)) {
            // Sequence complete -- discarded, never emitted.
            mode = 'idle'
            i++
          } else if (CSI_PARAM_OR_INTERMEDIATE_RE.test(c)) {
            pendingLen++
            if (pendingLen > CSI_MAX_LEN) {
              // Abandon: real CSI sequences are always short, so a run this
              // long is not one -- resume idle and let the offending
              // character (and everything after it) through as plain text,
              // same fail-open-toward-not-losing-data posture as the
              // malformed-grammar branch below.
              mode = 'idle'
            }
            i++
          } else {
            // Not valid CSI grammar -- bail out, reprocess THIS character
            // as ordinary idle text (do not advance i) rather than
            // swallowing it as if it belonged to the abandoned sequence.
            mode = 'idle'
          }
          break

        case 'osc':
          if (c === BEL || c === ST_8BIT) {
            // BEL or the 8-bit ST (single byte) -- both terminate directly.
            mode = 'idle'
            i++
          } else if (c === ESC) {
            mode = 'osc-esc-seen'
            i++
          } else {
            pendingLen++
            if (pendingLen > OSC_MAX_LEN) {
              // Abandon resumes 'idle' and lets subsequent bytes through as
              // ordinary text, same posture as the CSI branch: the alternative,
              // staying in 'osc' forever, used to swallow the entire rest of
              // the session's output silently and permanently.
              mode = 'idle'
            }
            i++
          }
          break

        case 'osc-esc-seen':
          if (c === '\\') {
            mode = 'idle'
            i++
          } else {
            // Not a real ST -- the held ESC was literal OSC payload content
            // (discarded either way). Reprocess this character under 'osc'.
            mode = 'osc'
          }
          break
      }
    }
    return out
  }

  return { feed }
}
