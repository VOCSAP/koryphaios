// Pull the sign-in URL out of a raw PTY stream.
//
// Why this exists rather than "just select the text": the login runs in a
// modal-sized terminal, so the CLI's OAuth URL is WRAPPED across several
// display rows. An xterm selection of a wrapped line yields a broken string,
// and the CLI's own "Copied!" writes to the CONTAINER's clipboard, which never
// reaches the host. Reading the URL from the stream -- before any wrapping,
// which xterm applies at render time -- is the only reliable path, and it is
// what feeds the dialog's Open / Copy buttons.

/** CSI / OSC / single-char escapes the CLI paints its boxes and colours with. */
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** Stop at whitespace and at the delimiters a URL is usually wrapped in. */
const URL_RE = /https?:\/\/[^\s"'<>`|\\)\]}]+/g

/** Trailing sentence punctuation is prose, not part of the URL. */
const TRAILING = /[.,;:!?]+$/

/**
 * A continuation row of a wrapped URL: non-empty, and made only of characters
 * URL_RE itself would have accepted. The absence of ANY whitespace is what
 * separates it from the prose the CLI prints around the link.
 */
const URL_TAIL_RE = /^[^\s"'<>`|\\)\]}]+$/

/** Runaway guards for the row-rejoining below. */
const MAX_JOIN_ROWS = 32
const MAX_URL_CHARS = 8192

/**
 * Returns the last http(s) URL in chunk, not the first: the CLI prints docs
 * links before the one to open, and a retry's URL supersedes the previous one.
 * The CLI wraps mid-token with a real newline at the terminal width, so a
 * wrapped URL is detected by ending exactly at its row's end, never by measured
 * row length (observed rows vary by a character).
 * Every following non-empty, whitespace-free row is treated as a continuation.
 */
export function extractAuthUrl(chunk: string): string | null {
  const rows = chunk
    .replace(ANSI, '')
    .split(/\r\n|\n|\r/)
    .map((r) => r.replace(/\s+$/, ''))

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    const matches = [...row.matchAll(URL_RE)]
    const last = matches[matches.length - 1]
    if (!last || last.index === undefined) continue

    let url = last[0]
    if (last.index + url.length === row.length) {
      for (let j = i + 1; j < rows.length && j - i <= MAX_JOIN_ROWS; j++) {
        const next = rows[j]!
        if (!URL_TAIL_RE.test(next) || url.length + next.length > MAX_URL_CHARS) break
        url += next
      }
    }

    url = url.replace(TRAILING, '')
    // A bare scheme is what a truncated stream looks like mid-write.
    if (url.length > 'https://'.length) return url
  }
  return null
}
