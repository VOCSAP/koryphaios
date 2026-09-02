// Claude Code paints with absolute cursor addressing, so a stripAnsi buffer
// renders in paint order, not reading order — undecidable whether a composer
// box is on screen and where the cursor sits. This model tracks a grid and
// cursor position instead.
// Not a terminal emulator: no scrollback, no wrapping beyond the naive case, no
// charsets — good enough to read a screen, never to drive one.

export interface Screen {
  feed(data: string): void
  /** Rendered rows, trailing whitespace trimmed, top to bottom. */
  lines(): string[]
  text(): string
  cursor(): { cy: number; cx: number }
}

/**
 * Default grid is far larger than any real terminal on purpose: CUP addressing
 * is absolute, so a grid larger than the terminal preserves geometry exactly,
 * while a grid smaller than it corrupts every future CUP to an out-of-range
 * cell permanently, clamping to the same wrong cell forever.
 * Matters for the window between any Screen (re)creation and the next resize,
 * not just the initial spawn. Do not shrink this default toward a 'realistic'
 * terminal size.
 */
export function makeScreen(cols = 400, rows = 200): Screen {
  const grid: string[][] = Array.from({ length: rows }, () => new Array(cols).fill(' '))
  let cy = 0
  let cx = 0
  const clampY = (y: number): number => Math.max(0, Math.min(rows - 1, y))
  const clampX = (x: number): number => Math.max(0, Math.min(cols - 1, x))

  function put(ch: string): void {
    if (ch === '\n') {
      cy = clampY(cy + 1)
      return
    }
    if (ch === '\r') {
      cx = 0
      return
    }
    if (ch === '\b') {
      cx = clampX(cx - 1)
      return
    }
    if (ch === '\t') {
      cx = clampX(cx + 8 - (cx % 8))
      return
    }
    if (ch < ' ') return
    // cy is always clamped into [0, rows-1] just above, so this row exists in
    // every real call; noUncheckedIndexedAccess still types it optional. A
    // missing row is treated as a real absence, not asserted away: skip the
    // paint (nothing corrupts) but still advance the cursor, same as a
    // successful write would -- consistent with the fail-closed spirit of
    // the guard this model feeds (an unreadable cell must never fabricate
    // plausible-looking screen content, it must degrade toward "unknown").
    const row = grid[cy]
    if (row) row[cx] = ch
    cx++
    if (cx >= cols) {
      cx = 0
      cy = clampY(cy + 1)
    }
  }

  function feed(data: string): void {
    let i = 0
    while (i < data.length) {
      const ch = data[i]
      // i < data.length just above guarantees this is a real character; the
      // guard exists only because noUncheckedIndexedAccess cannot see that.
      // Same absence-first spirit as put()'s own guard: nothing to write
      // means skip, not crash and not paint a made-up character.
      if (ch === undefined) {
        i++
        continue
      }
      if (ch !== '\x1b') {
        put(ch)
        i++
        continue
      }
      // OSC: ESC ] ... BEL | ESC \
      if (data[i + 1] === ']') {
        let j = i + 2
        while (j < data.length && data[j] !== '\x07' && !(data[j] === '\x1b' && data[j + 1] === '\\')) j++
        i = data[j] === '\x07' ? j + 1 : j + 2
        continue
      }
      if (data[i + 1] !== '[') {
        i += 2
        continue
      }
      let j = i + 2
      // j < data.length in the loop guard makes data[j] a real character on
      // every iteration that reaches the test; the '' fallback is inert (an
      // empty string never matches [A-Za-z]) and only satisfies
      // noUncheckedIndexedAccess, it never changes which byte is scanned.
      while (j < data.length && !/[A-Za-z]/.test(data[j] ?? '')) j++
      const params = data.slice(i + 2, j)
      const fin = data[j]
      i = j + 1
      if (/^[?><]/.test(params)) continue // DEC private / mode reports: ignored
      const nums = params.split(';').map((p) => (p === '' ? undefined : Number(p)))
      const n = nums[0] === undefined ? 1 : nums[0]
      switch (fin) {
        case 'H':
        case 'f':
          cy = clampY((nums[0] === undefined ? 1 : nums[0]) - 1)
          cx = clampX((nums[1] === undefined ? 1 : nums[1]) - 1)
          break
        case 'A':
          cy = clampY(cy - n)
          break
        case 'B':
          cy = clampY(cy + n)
          break
        case 'C':
          cx = clampX(cx + n)
          break
        case 'D':
          cx = clampX(cx - n)
          break
        case 'G':
          cx = clampX(n - 1)
          break
        case 'd':
          cy = clampY(n - 1)
          break
        case 'K': {
          // cy is always clamped into [0, rows-1], so this row always
          // exists; guarded (not asserted) for the same reason as put()'s
          // own row lookup above -- an unreadable row degrades to "erase
          // nothing" rather than crashing the feed.
          const row = grid[cy]
          if (row) {
            const mode = nums[0] || 0
            if (mode === 0) for (let x = cx; x < cols; x++) row[x] = ' '
            else if (mode === 1) for (let x = 0; x <= cx; x++) row[x] = ' '
            else for (let x = 0; x < cols; x++) row[x] = ' '
          }
          break
        }
        case 'J': {
          const mode = nums[0] || 0
          const from = mode === 0 ? cy : 0
          const to = mode === 1 ? cy : rows - 1
          for (let y = from; y <= to; y++) {
            const row = grid[y]
            if (row) row.fill(' ')
          }
          break
        }
        default:
          break // SGR and friends: no geometry effect
      }
    }
  }

  function lines(): string[] {
    return grid.map((r) => r.join('').replace(/\s+$/, ''))
  }

  function text(): string {
    return lines()
      .filter((l) => l.trim() !== '')
      .join('\n')
  }

  return { feed, lines, text, cursor: () => ({ cy, cx }) }
}

/**
 * 'clear' -> injectCommand's existing ESC+settle+paste sequence is safe to
 * run unchanged. 'modal' -> refuse the whole sequence, neither the ESC nor
 * the paste (see classifyInjectGuard's own doc for why both destroy on this
 * one).
 */
export type InjectGuardState = 'clear' | 'modal'

/**
 * Non-modal iff the cursor sits one row above the composer's chevron marker:
 * the trust/config dialog paints the same glyph but leaves the cursor three
 * rows below it, on the footer. No confirmed match defaults to modal (fail
 * closed): the @-mention picker and the tool-permission prompt could not be
 * captured. Combined at the call site with a second, independent signal,
 * since this geometric rule comes from five captures, not a swept domain,
 * and a future CLI layout could defeat it silently.
 */
export function classifyInjectGuard(screen: Screen): InjectGuardState {
  const lines = screen.lines()
  // U+276F is the chevron cursor glyph, escaped rather than painted
  // literally into this source file (see this function's own doc above).
  const chevronRow = lines.findIndex((l) => /^\s*\u276F/.test(l))
  if (chevronRow <= 0) return 'modal'
  const { cy } = screen.cursor()
  return cy === chevronRow - 1 ? 'clear' : 'modal'
}

/**
 * Keyed by tile id: a tile's screen belongs to that tile's PTY life, never
 * shared, and is cleared at every PTY-life boundary except the operator's
 * manual per-flag dismiss.
 * Fed from the same central pty data handler as the other per-tile detectors,
 * so it stays in lockstep with them with no separate polling.
 */
export class ScreenGuard {
  private screens = new Map<string, Screen>()

  feed(id: string, data: string): void {
    let s = this.screens.get(id)
    if (!s) {
      s = makeScreen()
      this.screens.set(id, s)
    }
    s.feed(data)
  }

  /**
   * Rebuilds rather than reflows: a live TUI repaints its whole screen on a
   * real resize, so the previous grid's content has no claim to survive a
   * dimension change — a fresh blank grid degrades toward modal (fail closed)
   * for the one chunk between resize and the next repaint.
   * cols/rows are IPC-sourced; NaN is rejected explicitly via Number.isFinite,
   * since cols < 1 against NaN is false and would otherwise reach new
   * Array(NaN), which throws.
   */
  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return
    this.screens.set(id, makeScreen(cols, rows))
  }

  /**
   * No Screen instance yet (no PTY output observed for this id) -> 'modal':
   * there is nothing on record to confirm the composer box is present, and
   * D2 makes that ignorance cost a refusal, not a write. This also means a
   * freshly-created session with no first paint yet is never written into
   * before the guard can see anything -- a byproduct, not a substitute for
   * the boot-grace period card 63ca372f names separately (out of scope here).
   */
  classify(id: string): InjectGuardState {
    const s = this.screens.get(id)
    if (!s) return 'modal'
    return classifyInjectGuard(s)
  }

  clear(id: string): void {
    this.screens.delete(id)
  }

  stop(): void {
    this.screens.clear()
  }
}
