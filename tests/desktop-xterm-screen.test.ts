import { describe, expect, test } from 'bun:test'
import { createXtermScreen } from '../desktop/src/main/xterm-screen'

const esc = String.fromCharCode(27)
const createScreen = (
  options: Omit<Parameters<typeof createXtermScreen>[0], 'reportError'>
): ReturnType<typeof createXtermScreen> => createXtermScreen({ ...options, reportError: () => undefined })

async function feedAtEveryBoundary(sequence: string): Promise<void> {
  for (let split = 1; split < sequence.length; split++) {
    const screen = createScreen({ cols: 20, rows: 4 })
    screen.feed(sequence.slice(0, split))
    await screen.drain()
    expect(screen.read(), `split ${split} of ${JSON.stringify(sequence)}`).toMatchObject({
      state: 'unavailable',
      reason: 'sequence-incomplete'
    })
    screen.feed(sequence.slice(split))
    await screen.drain()
    expect(screen.read(), `completed split ${split} of ${JSON.stringify(sequence)}`).toMatchObject({ state: 'ready' })
    screen.dispose()
  }
}

function deferredTerminal() {
  const callbacks: Array<() => void> = []
  let rows = 4
  let cols = 20
  const terminal = {
    write: (_data: string, callback: () => void) => callbacks.push(callback),
    resize: (nextCols: number, nextRows: number) => {
      cols = nextCols
      rows = nextRows
    },
    dispose: () => undefined,
    get buffer() {
      return {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          length: rows,
          getLine: (y: number) => (y < rows ? { translateToString: () => ''.padEnd(cols) } : undefined)
        }
      }
    },
    _core: {
      _inputHandler: {
        _parser: { currentState: 0 },
        _stringDecoder: { _interim: 0 }
      }
    }
  }
  return {
    terminal,
    flushNext: () => callbacks.shift()?.(),
    callbackCount: () => callbacks.length
  }
}

describe('xterm main-process screen adapter', () => {
  test('waits for the real terminal callback before publishing a snapshot', async () => {
    const screen = createScreen({ cols: 20, rows: 4 })

    screen.feed('hello')
    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'screen-pending' })

    await screen.drain()
    expect(screen.read()).toMatchObject({
      state: 'ready',
      snapshot: { lines: ['hello', '', '', ''], cursor: { x: 5, y: 0 } }
    })
    screen.dispose()
  })

  test.each([
    ['ESC', `${esc}7`],
    ['CSI', `${esc}[2J`],
    ['OSC BEL', `${esc}]0;title${String.fromCharCode(7)}`],
    ['OSC ST', `${esc}]0;title${esc}\\`],
    ['DCS BEL then ST', `${esc}P$qm${String.fromCharCode(7)}${esc}\\`]
  ])('keeps %s fragments unavailable at every boundary', async (_name, sequence) => {
    await feedAtEveryBoundary(sequence)
  })

  test('keeps a high surrogate unavailable until its low surrogate is processed', async () => {
    const screen = createScreen({ cols: 20, rows: 4 })

    screen.feed('\ud83d')
    await screen.drain()
    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'sequence-incomplete' })

    screen.feed('\ude00')
    await screen.drain()
    expect(screen.read()).toMatchObject({ state: 'ready', snapshot: { lines: ['😀', '', '', ''] } })
    screen.dispose()
  })

  test('does not throw on a decimal IL parameter', async () => {
    const screen = createScreen({ cols: 20, rows: 4 })

    expect(() => screen.feed(`${esc}[1.5L`)).not.toThrow()
    await screen.drain()
    expect(screen.read()).toMatchObject({ state: 'ready' })
    screen.dispose()
  })

  test('requires a non-empty post-resize write after draining pre-resize work', () => {
    const deferred = deferredTerminal()
    const screen = createScreen({ cols: 20, rows: 4, terminalFactory: () => deferred.terminal as never })

    screen.feed('before')
    screen.resize(10, 3)
    deferred.flushNext()
    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'resize-pending' })

    screen.feed('')
    deferred.flushNext()
    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'resize-pending' })

    screen.feed('after')
    deferred.flushNext()
    expect(deferred.callbackCount()).toBe(0)
    expect(screen.read()).toMatchObject({ state: 'ready', snapshot: { cols: 10, rows: 3 } })
    screen.dispose()
  })

  test('resolves a pending drain when disposal revokes the terminal', async () => {
    const deferred = deferredTerminal()
    const screen = createScreen({ cols: 20, rows: 4, terminalFactory: () => deferred.terminal as never })

    screen.feed('pending')
    const drain = screen.drain().then(() => 'resolved')
    screen.dispose()

    expect(await Promise.race([drain, Bun.sleep(20).then(() => 'timed-out')])).toBe('resolved')
  })

  test('settles a pending drain when terminal disposal rejects', async () => {
    const deferred = deferredTerminal()
    const reports: Array<{ scope: string; message: string }> = []
    deferred.terminal.dispose = () => {
      throw new Error('dispose rejected')
    }
    const screen = createXtermScreen({
      cols: 20,
      rows: 4,
      terminalFactory: () => deferred.terminal as never,
      reportError: (scope, message) => reports.push({ scope, message })
    })

    screen.feed('pending')
    const drain = screen.drain().then(() => 'resolved')

    expect(() => screen.dispose()).not.toThrow()
    expect(await Promise.race([drain, Bun.sleep(20).then(() => 'timed-out')])).toBe('resolved')
    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'disposed' })
    expect(reports).toHaveLength(1)
  })

  test('resolves a pending drain when the screen faults', async () => {
    const deferred = deferredTerminal()
    const reports: Array<{ scope: string; message: string }> = []
    const screen = createXtermScreen({
      cols: 20,
      rows: 4,
      terminalFactory: () => deferred.terminal as never,
      reportError: (scope, message) => reports.push({ scope, message })
    })

    screen.feed('pending')
    const drain = screen.drain().then(() => 'resolved')
    deferred.terminal.write = () => {
      throw new Error('write rejected')
    }
    screen.feed('fault')

    expect(await Promise.race([drain, Bun.sleep(20).then(() => 'timed-out')])).toBe('resolved')
    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'screen-fault' })
    expect(reports).toHaveLength(1)
    screen.dispose()
  })

  test('resets the unsettled input budget at parser rest during a backlog', () => {
    const deferred = deferredTerminal()
    const reports: Array<{ scope: string; message: string }> = []
    const screen = createXtermScreen({
      cols: 20,
      rows: 4,
      budgets: { pendingCodeUnits: 10, pendingChunks: 4, unsettledCodeUnits: 3 },
      terminalFactory: () => deferred.terminal as never,
      reportError: (scope, message) => reports.push({ scope, message })
    })

    screen.feed('a')
    screen.feed('b')
    deferred.flushNext()
    screen.feed('cd')

    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'screen-pending' })
    expect(reports).toHaveLength(0)
    deferred.flushNext()
    deferred.flushNext()
    expect(screen.read()).toMatchObject({ state: 'ready' })
    screen.dispose()
  })

  test('ignores a retired life callback after a replacement life is ready', () => {
    const retired = deferredTerminal()
    const replacement = deferredTerminal()
    const oldScreen = createScreen({ cols: 20, rows: 4, terminalFactory: () => retired.terminal as never })
    const newScreen = createScreen({ cols: 20, rows: 4, terminalFactory: () => replacement.terminal as never })

    oldScreen.feed('obsolete')
    oldScreen.dispose()
    let retiredParserReads = 0
    const retiredCore = retired.terminal._core
    Object.defineProperty(retired.terminal, '_core', {
      get: () => {
        retiredParserReads++
        return retiredCore
      }
    })
    newScreen.feed('current')
    replacement.flushNext()
    const before = newScreen.read()
    retired.flushNext()

    expect(retiredParserReads).toBe(0)
    expect(newScreen.read()).toEqual(before)
    expect(oldScreen.read()).toMatchObject({ state: 'unavailable', reason: 'disposed' })
    newScreen.dispose()
  })

  test('faults once when a chunk exceeds its admitted input budget', () => {
    const reports: Array<{ scope: string; message: string }> = []
    const screen = createXtermScreen({
      cols: 20,
      rows: 4,
      budgets: { pendingCodeUnits: 3, pendingChunks: 1, unsettledCodeUnits: 3 },
      reportError: (scope: string, message: string) => reports.push({ scope, message })
    })

    screen.feed('four')
    screen.feed('later')

    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'screen-fault' })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ scope: 'screen' })
    screen.dispose()
  })

  test('faults when xterm exposes an unknown private parser shape', () => {
    const deferred = deferredTerminal()
    Object.defineProperty(deferred.terminal, '_core', { value: {} })
    const reports: Array<{ scope: string; message: string }> = []
    const screen = createXtermScreen({
      cols: 20,
      rows: 4,
      terminalFactory: () => deferred.terminal as never,
      reportError: (scope: string, message: string) => reports.push({ scope, message })
    })

    screen.feed('data')
    deferred.flushNext()

    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'screen-fault' })
    expect(reports).toHaveLength(1)
    screen.dispose()
  })

  test('faults without throwing when a terminal callback cannot inspect the parser', () => {
    const deferred = deferredTerminal()
    Object.defineProperty(deferred.terminal, '_core', {
      get: () => {
        throw new Error('parser unavailable')
      }
    })
    const reports: Array<{ scope: string; message: string }> = []
    const screen = createXtermScreen({
      cols: 20,
      rows: 4,
      terminalFactory: () => deferred.terminal as never,
      reportError: (scope: string, message: string) => reports.push({ scope, message })
    })

    screen.feed('data')
    expect(() => deferred.flushNext()).not.toThrow()
    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'screen-fault' })
    expect(reports).toHaveLength(1)
    screen.dispose()
  })

  test('faults without throwing when xterm rejects a buffer read or omits an active row', () => {
    const rejected = deferredTerminal()
    const rejectedReports: Array<{ scope: string; message: string }> = []
    const rejectedScreen = createXtermScreen({
      cols: 20,
      rows: 4,
      terminalFactory: () => rejected.terminal as never,
      reportError: (scope: string, message: string) => rejectedReports.push({ scope, message })
    })

    rejectedScreen.feed('data')
    rejected.flushNext()
    Object.defineProperty(rejected.terminal, 'buffer', {
      get: () => {
        throw new Error('buffer unavailable')
      }
    })

    expect(() => rejectedScreen.read()).not.toThrow()
    expect(rejectedScreen.read()).toMatchObject({ state: 'unavailable', reason: 'screen-fault' })
    expect(rejectedReports).toHaveLength(1)
    rejectedScreen.dispose()

    const missing = deferredTerminal()
    const missingReports: Array<{ scope: string; message: string }> = []
    const missingScreen = createXtermScreen({
      cols: 20,
      rows: 4,
      terminalFactory: () => missing.terminal as never,
      reportError: (scope: string, message: string) => missingReports.push({ scope, message })
    })

    missingScreen.feed('data')
    missing.flushNext()
    Object.defineProperty(missing.terminal, 'buffer', {
      get: () => ({
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          getLine: () => undefined
        }
      })
    })

    expect(() => missingScreen.read()).not.toThrow()
    expect(missingScreen.read()).toMatchObject({ state: 'unavailable', reason: 'screen-fault' })
    expect(missingReports).toHaveLength(1)
    missingScreen.dispose()
  })

  test('faults without throwing when xterm rejects a write synchronously', () => {
    const deferred = deferredTerminal()
    deferred.terminal.write = () => {
      throw new Error('write rejected')
    }
    const reports: Array<{ scope: string; message: string }> = []
    const screen = createXtermScreen({
      cols: 20,
      rows: 4,
      terminalFactory: () => deferred.terminal as never,
      reportError: (scope: string, message: string) => reports.push({ scope, message })
    })

    expect(() => screen.feed('data')).not.toThrow()
    expect(screen.read()).toMatchObject({ state: 'unavailable', reason: 'screen-fault' })
    expect(reports).toHaveLength(1)
    screen.dispose()
  })

  test('preserves the appropriate row portion for ED0 and ED1', async () => {
    const ed0 = createScreen({ cols: 20, rows: 10 })
    ed0.feed(`${esc}[3;1H❯ 1. Yes${esc}[3;9H${esc}[J`)
    await ed0.drain()
    const ed0Read = ed0.read()
    expect(ed0Read).toMatchObject({ state: 'ready' })
    if (ed0Read.state !== 'ready') throw new Error('ED0 screen did not become ready')
    expect(ed0Read.snapshot.lines[2]).toBe('❯ 1. Yes')
    ed0.dispose()

    const ed1 = createScreen({ cols: 20, rows: 10 })
    ed1.feed(`${esc}[3;4H❯ 1. Yes${esc}[3;2H${esc}[1J`)
    await ed1.drain()
    const ed1Read = ed1.read()
    expect(ed1Read).toMatchObject({ state: 'ready' })
    if (ed1Read.state !== 'ready') throw new Error('ED1 screen did not become ready')
    expect(ed1Read.snapshot.lines[2]).toContain('❯ 1. Yes')
    ed1.dispose()
  })

  test('moves rows for IL and DL in the active terminal buffer', async () => {
    const insertion = createScreen({ cols: 20, rows: 10 })
    insertion.feed(`${esc}[6;1Hcomposer${esc}[5;1H${esc}[L`)
    await insertion.drain()
    const insertionRead = insertion.read()
    expect(insertionRead).toMatchObject({ state: 'ready' })
    if (insertionRead.state !== 'ready') throw new Error('IL screen did not become ready')
    expect(insertionRead.snapshot.lines[6]).toBe('composer')
    insertion.dispose()

    const deletion = createScreen({ cols: 20, rows: 10 })
    deletion.feed(`${esc}[7;1Hcomposer${esc}[5;1H${esc}[M`)
    await deletion.drain()
    const deletionRead = deletion.read()
    expect(deletionRead).toMatchObject({ state: 'ready' })
    if (deletionRead.state !== 'ready') throw new Error('DL screen did not become ready')
    expect(deletionRead.snapshot.lines[5]).toBe('composer')
    deletion.dispose()
  })

  test('restores the primary buffer after leaving the alternate screen', async () => {
    const screen = createScreen({ cols: 20, rows: 10 })
    screen.feed(`${esc}[3;1H❯ 1. Yes${esc}[?1049h${esc}[6;1Halternate${esc}[?1049l`)
    await screen.drain()

    const read = screen.read()
    expect(read).toMatchObject({ state: 'ready' })
    if (read.state !== 'ready') throw new Error('alternate screen did not become ready')
    expect(read.snapshot.lines[2]).toBe('❯ 1. Yes')
    screen.dispose()
  })
})

