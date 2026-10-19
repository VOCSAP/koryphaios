// Pure detection of clickable targets in terminal text. Nothing here is a
// trust decision: the match is a convenience, and main re-parses and
// validates every target it is handed.

export interface DetectedLink {
  /** Offsets into the scanned text, `end` exclusive. */
  start: number
  end: number
  /** What to hand to main: the matched text without trailing punctuation or a `:line:col` suffix. */
  target: string
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi
const WINDOWS_PATH_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s<>"'`|*?]+/g
const HOME_PATH_RE = /(?<![\w.~/\\-])~[\\/][^\s<>"'`|*?]+/g
// Two segments at least, so a slash command such as `/help` is not a path.
const POSIX_PATH_RE = /(?<![\w.~:/\\-])\/[^\s<>"'`|*?/]+\/[^\s<>"'`|*?]*/g
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}>]+$/
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/

function trimmedEnd(text: string, start: number, end: number): number {
  const trailing = TRAILING_PUNCTUATION_RE.exec(text.slice(start, end))
  return trailing ? end - trailing[0].length : end
}

export function detectLinks(text: string): DetectedLink[] {
  const found: DetectedLink[] = []
  const take = (re: RegExp, isPath: boolean): void => {
    for (const m of text.matchAll(re)) {
      const start = m.index
      const end = trimmedEnd(text, start, start + m[0].length)
      if (end <= start) continue
      if (found.some((l) => start < l.end && end > l.start)) continue
      let target = text.slice(start, end)
      if (isPath) target = target.replace(LINE_SUFFIX_RE, '')
      found.push({ start, end, target })
    }
  }
  take(URL_RE, false)
  take(WINDOWS_PATH_RE, true)
  take(HOME_PATH_RE, true)
  take(POSIX_PATH_RE, true)
  return found.sort((a, b) => a.start - b.start)
}

export interface LogicalLine {
  text: string
  /** Buffer rows making up `text`, in order; `offset` is where each row starts in `text`. */
  segments: { row: number; offset: number; length: number }[]
}

const MAX_JOINED_ROWS = 16

/**
 * A row continues the previous one when xterm soft-wrapped it (`isWrapped`).
 * Claude Code also hard-wraps a long token with a real line end, which xterm
 * cannot flag: a row that fills the whole width and ends on a non-space is then
 * taken to continue into a next row that starts on a non-space. A hard wrap
 * that Claude Code indents is not reconstructible from the buffer and stays
 * split.
 * `rowText(r)` is the row without trailing blanks, undefined past the buffer.
 */
export function logicalLine(
  rowText: (row: number) => string | undefined,
  row: number,
  cols: number,
  isWrapped: (row: number) => boolean = () => false
): LogicalLine {
  const fills = (r: number): boolean => {
    const t = rowText(r)
    return t !== undefined && t.length >= cols && !/\s$/.test(t)
  }
  const startsOnText = (r: number): boolean => {
    const t = rowText(r)
    return t !== undefined && t.length > 0 && !/^\s/.test(t)
  }
  let first = row
  while (row - first < MAX_JOINED_ROWS && first > 0 && (isWrapped(first) || (fills(first - 1) && startsOnText(first)))) first--
  let last = row
  while (last - row < MAX_JOINED_ROWS && (isWrapped(last + 1) || (fills(last) && startsOnText(last + 1)))) last++
  const segments: LogicalLine['segments'] = []
  let text = ''
  for (let r = first; r <= last; r++) {
    const t = rowText(r) ?? ''
    segments.push({ row: r, offset: text.length, length: t.length })
    text += t
  }
  return { text, segments }
}

/** Buffer row and 0-based string index within that row of an offset into `line.text`. */
export function locate(line: LogicalLine, offset: number): { row: number; col: number } {
  for (let i = line.segments.length - 1; i >= 0; i--) {
    const s = line.segments[i]!
    if (offset >= s.offset) return { row: s.row, col: offset - s.offset }
  }
  return { row: line.segments[0]!.row, col: 0 }
}

export interface RowCell {
  getChars(): string
  getWidth(): number
}

/**
 * Cell column (0-based) and cell width of the character at string `index` of a
 * row. xterm ranges count cells, not string units: a wide character takes two
 * cells and the second one carries no text.
 */
export function cellOfIndex(
  getCell: (x: number) => RowCell | undefined,
  cols: number,
  index: number
): { col: number; width: number } {
  let consumed = 0
  for (let x = 0; x < cols; x++) {
    const cell = getCell(x)
    if (cell === undefined) break
    const width = cell.getWidth()
    if (width === 0) continue
    const length = Math.max(cell.getChars().length, 1)
    if (index < consumed + length) return { col: x, width }
    consumed += length
  }
  return { col: index, width: 1 }
}
