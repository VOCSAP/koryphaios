// Minimal VT screen model -- just enough of the subset Claude Code actually
// emits (CUP, CHA, CUF/CUB/CUU/CUD, EL, ED, SGR/OSC/DEC-private ignored) to
// render a pty transcript back into readable LINES.
//
// It exists because the probes in this folder ask questions of the form "what
// is ON SCREEN after this keystroke" (is the draft still there, did the menu
// close, did the paste land in the box) and raw stripAnsi output cannot answer
// them: the CLI paints with absolute cursor addressing, so stripped text comes
// out in paint order, not in reading order.
//
// NOT a terminal emulator: no scrollback, no wrapping semantics beyond the
// naive one, no charsets. Good enough to READ a screen, never to drive one.
'use strict'

function makeScreen(cols = 120, rows = 40) {
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(' '))
  let cy = 0
  let cx = 0
  const clampY = (y) => Math.max(0, Math.min(rows - 1, y))
  const clampX = (x) => Math.max(0, Math.min(cols - 1, x))

  function put(ch) {
    if (ch === '\n') { cy = clampY(cy + 1); return }
    if (ch === '\r') { cx = 0; return }
    if (ch === '\b') { cx = clampX(cx - 1); return }
    if (ch === '\t') { cx = clampX(cx + 8 - (cx % 8)); return }
    if (ch < ' ') return
    grid[cy][cx] = ch
    cx++
    if (cx >= cols) { cx = 0; cy = clampY(cy + 1) }
  }

  function feed(data) {
    let i = 0
    while (i < data.length) {
      const ch = data[i]
      if (ch !== '\x1b') { put(ch); i++; continue }
      // OSC: ESC ] ... BEL | ESC \
      if (data[i + 1] === ']') {
        let j = i + 2
        while (j < data.length && data[j] !== '\x07' && !(data[j] === '\x1b' && data[j + 1] === '\\')) j++
        i = data[j] === '\x07' ? j + 1 : j + 2
        continue
      }
      if (data[i + 1] !== '[') { i += 2; continue }
      let j = i + 2
      while (j < data.length && !/[A-Za-z]/.test(data[j])) j++
      const params = data.slice(i + 2, j)
      const fin = data[j]
      i = j + 1
      if (/^[?><]/.test(params)) continue // DEC private / mode reports: ignored
      const nums = params.split(';').map((p) => (p === '' ? undefined : Number(p)))
      const n = nums[0] === undefined ? 1 : nums[0]
      switch (fin) {
        case 'H': case 'f':
          cy = clampY((nums[0] === undefined ? 1 : nums[0]) - 1)
          cx = clampX((nums[1] === undefined ? 1 : nums[1]) - 1)
          break
        case 'A': cy = clampY(cy - n); break
        case 'B': cy = clampY(cy + n); break
        case 'C': cx = clampX(cx + n); break
        case 'D': cx = clampX(cx - n); break
        case 'G': cx = clampX(n - 1); break
        case 'd': cy = clampY(n - 1); break
        case 'K': {
          const mode = nums[0] || 0
          if (mode === 0) for (let x = cx; x < cols; x++) grid[cy][x] = ' '
          else if (mode === 1) for (let x = 0; x <= cx; x++) grid[cy][x] = ' '
          else for (let x = 0; x < cols; x++) grid[cy][x] = ' '
          break
        }
        case 'J': {
          const mode = nums[0] || 0
          const from = mode === 0 ? cy : 0
          const to = mode === 1 ? cy : rows - 1
          for (let y = from; y <= to; y++) grid[y].fill(' ')
          break
        }
        default: break // SGR and friends: no geometry effect
      }
    }
  }

  function lines() {
    return grid.map((r) => r.join('').replace(/\s+$/, ''))
  }

  function text() {
    return lines().filter((l) => l.trim() !== '').join('\n')
  }

  return { feed, lines, text, cursor: () => ({ cy, cx }) }
}

module.exports = { makeScreen }
