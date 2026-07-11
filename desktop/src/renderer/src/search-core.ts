// Pure buffer-search core for the cross-session search bar. Operates on a
// structural subset of xterm's IBuffer so it carries no @xterm/xterm import
// and stays unit-testable under bun from the repo root (tests/desktop-search-core).

export interface BufferLineLike {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

export interface BufferLike {
  readonly length: number
  getLine(y: number): BufferLineLike | undefined
}

export interface BufferMatch {
  /** Absolute buffer row where the match starts. */
  row: number
  /** Column within that row. Char offset, i.e. exact for single-width glyphs. */
  col: number
  /** Match length in characters. */
  length: number
  /** Full logical line (wrapped rows joined, trimmed) for result display. */
  lineText: string
  /** Match offset within `lineText`, for display-side highlighting. */
  matchIndex: number
}

export const MIN_QUERY_LENGTH = 2

export interface SearchOptions {
  maxMatches?: number
  /**
   * Skip a logical line whose text equals the previous hit's line. Claude Code
   * repaints its TUI, so the scrollback holds near-identical frames of the same
   * content; without this the list shows the same phrase many times in a row.
   */
  dedupe?: boolean
}

/**
 * Case-insensitive search across a terminal buffer. Physical rows belonging to
 * one logical (wrapped) line are joined before matching, so a phrase spanning
 * a wrap boundary is still found and positions map back to buffer rows.
 */
export function searchBuffer(buf: BufferLike, query: string, opts?: SearchOptions): BufferMatch[] {
  const maxMatches = opts?.maxMatches ?? 200
  const dedupe = opts?.dedupe ?? true
  const needle = query.toLowerCase()
  if (needle.trim().length < MIN_QUERY_LENGTH) return []

  const out: BufferMatch[] = []
  let prevLineText: string | null = null
  let y = 0
  while (y < buf.length && out.length < maxMatches) {
    // Join the logical line starting at y. Every physical row except the last
    // keeps its trailing blanks so char offsets map back to (row, col).
    const startY = y
    const rowLens: number[] = []
    let text = ''
    for (;;) {
      const line = buf.getLine(y)
      if (!line) break
      const wrappedNext = buf.getLine(y + 1)?.isWrapped === true
      const s = line.translateToString(!wrappedNext)
      text += s
      rowLens.push(s.length)
      y++
      if (!wrappedNext) break
    }
    if (rowLens.length === 0) {
      // getLine returned nothing (raced trim) -- skip the row, never stall.
      y++
      continue
    }

    const hay = text.toLowerCase()
    const display = text.trim()
    const leading = text.length - text.trimStart().length
    let matchedThisLine = false
    let from = 0
    let idx: number
    while ((idx = hay.indexOf(needle, from)) !== -1 && out.length < maxMatches) {
      from = idx + needle.length
      if (!matchedThisLine && dedupe && display === prevLineText) break
      matchedThisLine = true
      prevLineText = display

      // Map the char offset in the joined text back to a physical (row, col).
      let rowIdx = 0
      let rest = idx
      while (rowIdx < rowLens.length - 1 && rest >= rowLens[rowIdx]!) {
        rest -= rowLens[rowIdx]!
        rowIdx++
      }
      out.push({
        row: startY + rowIdx,
        col: rest,
        length: needle.length,
        lineText: display,
        matchIndex: Math.max(0, idx - leading)
      })
    }
  }
  return out
}

/**
 * Re-locate a match at jump time: buffer rows shift between the scan and the
 * double-click (new output, scrollback trim, reflow on unhide), so pick the
 * current occurrence closest to where the match used to be. Dedupe is off --
 * repaint duplicates are exactly what makes the nearest row reachable.
 */
export function findClosestMatch(
  buf: BufferLike,
  query: string,
  preferredRow: number
): BufferMatch | null {
  let best: BufferMatch | null = null
  for (const m of searchBuffer(buf, query, { maxMatches: 1000, dedupe: false })) {
    if (!best || Math.abs(m.row - preferredRow) < Math.abs(best.row - preferredRow)) best = m
  }
  return best
}
