// Minimal VT screen model + injectCommand's screen-state guard (Vague 10 lot
// A2-1, cards 5dbf3255 + 63ca372f). Ported from tests/pty-harness/mini-screen.cjs
// per team-lead directive (claude-peers channel, 2026-08-17): Claude Code paints
// with ABSOLUTE cursor addressing (CUP), so a stripAnsi buffer renders text in
// PAINT order, not READING order -- "is there a composer box on screen right
// now, and where is the cursor" is undecidable from stripAnsi alone. This model
// tracks a grid + cursor position instead, same subset the debugger's probe
// covers (CUP/CHA/CUF/CUB/CUU/CUD/EL/ED; SGR/OSC/DEC-private ignored).
//
// NOT a terminal emulator: no scrollback, no wrapping semantics beyond the
// naive one, no charsets. Good enough to READ a screen, never to drive one.
// Pure module -- no electron/node-pty import (BUN.md convention) -- so
// `bun test` can exercise it directly.

export interface Screen {
  feed(data: string): void
  /** Rendered rows, trailing whitespace trimmed, top to bottom. */
  lines(): string[]
  text(): string
  cursor(): { cy: number; cx: number }
}

/**
 * Defaults (400x200) are deliberately far larger than any real terminal:
 * CUP addressing is ABSOLUTE, so a grid LARGER than the real terminal
 * preserves geometry exactly (no clamp, no wrap) while a grid SMALLER than
 * it destroys geometry permanently -- once a row/column falls outside a
 * too-small grid every future CUP to that coordinate clamps to the same
 * wrong cell forever, corrupting classifyInjectGuard's cursor-vs-chevron
 * read for the rest of that tile's life (review finding, roadmap cards
 * 63ca372f/120148eb: a tile taller than the old 120x40 default froze
 * classifyInjectGuard at 'modal' permanently). This default matters for the
 * window between ANY (re)creation of a tile's Screen and the NEXT resize --
 * not just the initial spawn (PtyManager.spawn's own fixed 80x24) before
 * the renderer's first FitAddon fit. ScreenGuard.feed below builds a fresh
 * Screen at this default every time no Screen is on record for that id yet,
 * which is also true after every ScreenGuard.clear(id) call site (PTY exit,
 * remove, restart's respawn) -- each one reopens the same window until the
 * next pty:resize. Oversizing costs nothing (an unused row or column stays
 * blank), undersizing costs correctness. Do not shrink this default back
 * toward a "realistic" terminal size.
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
 * GEOMETRIC discriminant (team-lead correction over claude-peers, 2026-08-17,
 * superseding an earlier text-pattern plan; MESURE, not DEDUIT, by direct
 * replay of tests/pty-harness/fixtures/ through this same model -- see
 * tests/desktop-screen-model.test.ts, which pins these exact five files):
 *
 * Claude Code's composer box (this CLI version, no border characters -- an
 * earlier design here assumed a bordered '╭...╮' box and was WRONG, measured
 * wrong by replaying the real fixtures, not by re-reading a comment) draws as
 * two rows: the editable content row (blank, or the operator's echoed
 * draft/slash text), then a static CHEVRON marker row directly BELOW it (the
 * chevron cursor glyph, U+276F -- named here rather than painted literally;
 * the regex below matches it via a Unicode escape, not a bare character).
 * The real terminal cursor sits on the CONTENT row, i.e. exactly one row
 * ABOVE the chevron marker, in ALL THREE non-modal captures
 * (prompt-idle-with-esc.json, draft-typed-with-esc.json,
 * slash-menu-with-esc.json -- empty prompt, a draft in progress, and the
 * slash-command menu open, respectively; the menu result in particular
 * retires the "numbered chooser == modal" idea a draft of this guard nearly
 * shipped: the slash list is ALSO numbered/chevron-led content further
 * down-screen, but that is not the ROW this check inspects).
 *
 * The trust/config dialog (fixtures dialog-open-no-esc.json /
 * dialog-open-with-esc.json) replaces the whole screen with a choice panel:
 * it still paints its own chevron next to the selected option, but the real
 * cursor ends up THREE rows below that, on the "Enter to confirm · Esc to
 * cancel" footer text -- not one row above. Same glyph, different row
 * relationship to the live cursor; that relationship, not the glyph's mere
 * presence, is what this function tests.
 *
 * DEDUIT, not MESURE, on exactly two screens this rule has not been observed
 * against: the @-mention picker and the tool-permission prompt. Both are
 * treated conservatively as modal below (open item, per team-lead), since
 * neither could be captured today (the operator's global permission
 * allow-list makes tool calls execute without ever showing the prompt in a
 * disposable cwd, and overriding that config was out of scope). Both fall
 * through to the conservative default below, same as any other screen this
 * function cannot positively confirm has the cursor-on-content-row
 * relationship: no confirmed match -> 'modal'. This is the fail-closed
 * direction team-lead's brief calls D2 -- doubt costs a refused (deferred,
 * journaled, replayable) directive, never a write onto a screen this
 * function isn't sure about.
 *
 * What this function does NOT cover on its own: it is combined with a SECOND,
 * independently-sourced signal at the injectCommand call site (see that
 * method's own comment) precisely because this geometric rule is derived
 * from five captures, not a swept domain -- a screen a future CLI version
 * paints differently (e.g. moving the chevron marker to the SAME row as the
 * content, or adding a third composer row) could defeat it silently in
 * either direction. The composition is a union that only ever adds
 * refusals, never removes one this function would have raised alone.
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
 * Rolling per-session Screen instance (keyed by tile id, same convention as
 * ThinkingDetector/QuotaDetector/AttentionDetector/StartupAckDetector in
 * session-service.ts -- "keyed by what, and what happens when there are two":
 * a tile's screen belongs to that tile's PTY life, never shared, and cleared
 * at every PTY-life boundary attentionDetector is, except attentionDetector's
 * own clearAttention() (the operator's manual per-flag dismiss, not a
 * PTY-life boundary -- see tests/desktop-inject-command-modal-guard.test.ts's
 * own comment on that exact asymmetry, which this file mirrors, not a vaguer
 * "these detectors" grouping that no single shared clear-site list actually
 * matches). Fed from the SAME central pty 'data' handler as the other
 * detectors, so it stays in lockstep with them -- no separate polling: the
 * grid is a fixed cols*rows array, and VT cursor state persists correctly
 * across chunk boundaries because each chunk is fed to the SAME live Screen
 * instance, in order, exactly once.
 *
 * The grid being FIXED-SIZE is not itself a free advantage -- until
 * `resize` below existed, "fixed" meant "fixed at makeScreen's default
 * forever," which is exactly what let a tall tile permanently misclassify
 * (see makeScreen's own doc). `resize` is what makes the fixed-size grid
 * track the tile's REAL size instead of a guess: called from
 * SessionService.resize in lockstep with PtyManager.resize, fed the same
 * cols/rows the renderer's FitAddon sends through the pty:resize IPC
 * channel, so PTY and screen model never diverge in steady state.
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
   * Rebuild this tile's Screen at its real terminal size. Rebuilds rather
   * than reflows: a live TUI repaints its whole screen on a real resize
   * (Claude Code's own does -- field-proven, not assumed: pty-manager.ts's
   * CONPTY_KICK_DELAYS_MS doc records a same-dimensions resize flushing a
   * whole withheld dialog instantly, 2026-07-28 audit), so the previous
   * grid's content has no claim to survive a dimension change -- keeping it
   * around stale risks a wrong read for the one 'data' chunk between the
   * resize and the next repaint, where a fresh (blank) grid degrades toward
   * 'modal' (fail-closed, D2) instead.
   *
   * cols/rows are IPC-sourced (renderer FitAddon -> pty:resize -> here, same
   * numbers PtyManager.resize's own call receives): NaN is rejected
   * EXPLICITLY via Number.isFinite, since a bare `cols < 1` comparison
   * against NaN is `false` and would let it through silently into
   * `new Array(NaN)`, which throws.
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
