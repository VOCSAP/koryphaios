import { describe, expect, test } from 'bun:test'
import { Terminal } from '@xterm/xterm'
import { createSessionTerminal } from '../desktop/src/renderer/src/terminal-focus-report'
import type { TerminalLinkDeps } from '../desktop/src/renderer/src/terminal-links'

const FOCUS_OUT = '\x1b[O'
const FOCUS_IN = '\x1b[I'

const inertLinks: TerminalLinkDeps = {
  open: async () => ({ ok: true }),
  preview: async () => ({ ok: false, reason: 'unavailable' }),
  onRefused: () => {},
  report: () => {},
  fileLinks: () => true,
  label: (key) => key
}

function guardedTerminal(): { term: Terminal; sent: string[]; reports: string[] } {
  const reports: string[] = []
  const term = createSessionTerminal({ allowProposedApi: true, windowsPty: undefined }, (message) => reports.push(message), inertLinks)
  const sent: string[] = []
  term.onData((data) => sent.push(data))
  return { term, sent, reports }
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('createSessionTerminal suppresses standalone focus reporting on a real xterm Terminal', () => {
  test('an unguarded terminal reports focus-out to the pty as soon as the CLI enables mode 1004', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const sent: string[] = []
    term.onData((data) => sent.push(data))
    await write(term, '\x1b[?1004h')
    expect(term.modes.sendFocusMode).toBe(true)
    expect(sent).toContain(FOCUS_OUT)
  })

  test('the sequence Claude Code sends keeps focus reporting off and never writes ESC[O or ESC[I to the pty', async () => {
    const { term, sent, reports } = guardedTerminal()
    await write(term, '\x1b[?2004h\x1b[?2031h\x1b[?1004h')
    expect(term.modes.sendFocusMode, 'DECSET 1004 must not reach xterm: Claude Code freezes its title spinner on ESC[O').toBe(false)
    expect(sent.filter((data) => data === FOCUS_OUT || data === FOCUS_IN)).toEqual([])
    expect(term.modes.bracketedPasteMode, 'a separate DECSET 2004 keeps its default effect').toBe(true)
    expect(reports).toEqual([])
  })

  test('a sequence without mode 1004 keeps its default effect', async () => {
    const { term, reports } = guardedTerminal()
    await write(term, '\x1b[?2004h')
    expect(term.modes.bracketedPasteMode).toBe(true)
    await write(term, '\x1b[?2004l')
    expect(term.modes.bracketedPasteMode).toBe(false)
    expect(reports).toEqual([])
  })

  test('a combined sequence keeps its other modes and is reported once', async () => {
    const { term, reports } = guardedTerminal()
    await write(term, '\x1b[?2004;1004h')
    await write(term, '\x1b[?2004;1004h')
    expect(term.modes.bracketedPasteMode, 'splitting is impossible, so 2004 must win over suppressing 1004').toBe(true)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('1004')
  })

  test('DECRST 1004 passes through harmlessly', async () => {
    const { term, sent } = guardedTerminal()
    await write(term, '\x1b[?1004h\x1b[?1004l')
    expect(term.modes.sendFocusMode).toBe(false)
    expect(sent).toEqual([])
  })
})

describe('createSessionTerminal forwards windowsPty to xterm', () => {
  async function growRows(windowsPty: { backend: 'conpty'; buildNumber: number } | undefined) {
    const term = createSessionTerminal({ allowProposedApi: true, rows: 10, cols: 40, windowsPty }, () => {}, inertLinks)
    let lines = ''
    for (let i = 0; i < 50; i++) lines += `line ${i}\r\n`
    await write(term, lines)
    const before = { baseY: term.buffer.active.baseY, cursorY: term.buffer.active.cursorY }
    term.resize(40, 20)
    return { before, after: { baseY: term.buffer.active.baseY, cursorY: term.buffer.active.cursorY } }
  }

  test('a ConPTY terminal keeps its scrollback out of the viewport when rows grow', async () => {
    const { before, after } = await growRows({ backend: 'conpty', buildNumber: 26300 })
    expect(before.baseY).toBeGreaterThan(0)
    expect(after).toEqual(before)
  })

  test('without windowsPty xterm pulls scrollback down on growth, so the option is what makes the difference', async () => {
    const { before, after } = await growRows(undefined)
    expect(after.baseY).toBeLessThan(before.baseY)
  })
})

describe('createSessionTerminal installs the link gate', () => {
  test('OSC 8 links with a non-http scheme reach the handler instead of being dropped by xterm', () => {
    const { term } = guardedTerminal()
    expect(term.options.linkHandler?.allowNonHttpProtocols, 'xterm drops file: hyperlinks without this flag').toBe(true)
  })
})
