import { describe, expect, test } from 'bun:test'
import { Terminal } from '@xterm/xterm'
import { createSessionTerminal } from '../desktop/src/renderer/src/terminal-focus-report'

const FOCUS_OUT = '\x1b[O'
const FOCUS_IN = '\x1b[I'

function guardedTerminal(): { term: Terminal; sent: string[]; reports: string[] } {
  const reports: string[] = []
  const term = createSessionTerminal({ allowProposedApi: true }, (message) => reports.push(message))
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
