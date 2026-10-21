import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { classifyInjectGuard, createXtermScreen, inspectInjectGuard, ScreenGuard } from '../desktop/src/main/xterm-screen'
import { EXPECTED_FIXTURE_VERDICTS, fixtureStartSize, GEOMETRY_MARKER, RESIZE_MARKER } from './_fixture-verdicts'

const esc = String.fromCharCode(27)
const createScreen = (
  options: Omit<Parameters<typeof createXtermScreen>[0], 'reportError'>
): ReturnType<typeof createXtermScreen> => createXtermScreen({ ...options, reportError: () => undefined })

const FIXTURES = join(import.meta.dir, 'pty-harness', 'fixtures')
type Chunk = { t: number; data: string }
const loadFixture = (name: string): Chunk[] => JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'))
const isMarker = (chunk: Chunk): boolean => chunk.data.startsWith('\n########## ')

async function snapshotFromChunks(chunks: readonly Chunk[], cols = 120, rows = 40) {
  const screen = createScreen({ cols, rows })
  for (const chunk of chunks) if (!isMarker(chunk)) screen.feed(chunk.data)
  await screen.drain()
  const read = screen.read()
  screen.dispose()
  if (read.status !== 'ready') throw new Error(`xterm screen unavailable: ${read.reason}`)
  return read.snapshot
}

async function fixtureSnapshot(fixture: string, cols = 120, rows = 40) {
  return snapshotFromChunks(loadFixture(fixture), cols, rows)
}

async function screenSnapshot(data: string, cols = 120, rows = 40) {
  return snapshotFromChunks([{ t: 0, data }], cols, rows)
}

async function fixtureSnapshotAfter(fixture: string, data: string, cols = 120, rows = 40) {
  return snapshotFromChunks([...loadFixture(fixture), { t: 0, data }], cols, rows)
}

type Verdict = 'clear' | 'modal'
type CheckpointScreen = { label: string; verdict: Verdict; lines: readonly string[] }

async function fixtureReplay(fixture: string): Promise<{ checkpoints: CheckpointScreen[]; final: Verdict }> {
  const chunks = loadFixture(fixture)
  const screen = createScreen(fixtureStartSize(chunks))
  const checkpoints: CheckpointScreen[] = []
  for (const chunk of chunks) {
    if (isMarker(chunk)) {
      if (GEOMETRY_MARKER.test(chunk.data)) continue
      await screen.drain()
      const read = screen.read()
      if (read.status !== 'ready') throw new Error(`${fixture}: xterm screen unavailable: ${read.reason}`)
      const label = chunk.data.trim().replace(/^#+\s*|\s*#+$/g, '')
      checkpoints.push({ label, verdict: classifyInjectGuard(read.snapshot), lines: read.snapshot.lines })
      const resize = RESIZE_MARKER.exec(chunk.data)
      if (resize) screen.resize(Number(resize[1]), Number(resize[2]))
      continue
    }
    screen.feed(chunk.data)
  }
  await screen.drain()
  const read = screen.read()
  screen.dispose()
  if (read.status !== 'ready') throw new Error(`${fixture}: xterm screen unavailable: ${read.reason}`)
  return { checkpoints, final: classifyInjectGuard(read.snapshot) }
}

async function fixtureVerdicts(fixture: string): Promise<{ checkpoints: readonly Verdict[]; final: Verdict }> {
  const replay = await fixtureReplay(fixture)
  return { checkpoints: replay.checkpoints.map((checkpoint) => checkpoint.verdict), final: replay.final }
}

async function feedAtEveryBoundary(sequence: string): Promise<void> {
  for (let split = 1; split < sequence.length; split++) {
    const screen = createScreen({ cols: 20, rows: 4 })
    screen.feed(sequence.slice(0, split))
    await screen.drain()
    expect(screen.read(), `split ${split} of ${JSON.stringify(sequence)}`).toMatchObject({
      status: 'unavailable',
      reason: 'sequence-incomplete'
    })
    screen.feed(sequence.slice(split))
    await screen.drain()
    expect(screen.read(), `completed split ${split} of ${JSON.stringify(sequence)}`).toMatchObject({ status: 'ready' })
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
      coreService: { isCursorHidden: false },
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
    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-pending' })

    await screen.drain()
    expect(screen.read()).toMatchObject({
      status: 'ready',
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

  test('strips trailing terminal whitespace from snapshots', async () => {
    const screen = createScreen({ cols: 20, rows: 4 })

    screen.feed('permission dialog ')
    await screen.drain()
    expect(screen.read()).toMatchObject({ status: 'ready', snapshot: { lines: ['permission dialog', '', '', ''] } })
    screen.dispose()
  })

  test('keeps a high surrogate unavailable until its low surrogate is processed', async () => {
    const screen = createScreen({ cols: 20, rows: 4 })

    screen.feed('\ud83d')
    await screen.drain()
    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'sequence-incomplete' })

    screen.feed('\ude00')
    await screen.drain()
    expect(screen.read()).toMatchObject({ status: 'ready', snapshot: { lines: ['😀', '', '', ''] } })
    screen.dispose()
  })

  test('does not throw on a decimal IL parameter', async () => {
    const screen = createScreen({ cols: 20, rows: 4 })

    expect(() => screen.feed(`${esc}[1.5L`)).not.toThrow()
    await screen.drain()
    expect(screen.read()).toMatchObject({ status: 'ready' })
    screen.dispose()
  })

  test('requires a non-empty post-resize write after draining pre-resize work', () => {
    const deferred = deferredTerminal()
    const screen = createScreen({ cols: 20, rows: 4, terminalFactory: () => deferred.terminal as never })

    screen.feed('before')
    screen.resize(10, 3)
    deferred.flushNext()
    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'resize-pending' })

    screen.feed('')
    deferred.flushNext()
    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'resize-pending' })

    screen.feed('after')
    deferred.flushNext()
    expect(deferred.callbackCount()).toBe(0)
    expect(screen.read()).toMatchObject({ status: 'ready', snapshot: { cols: 10, rows: 3 } })
    screen.dispose()
  })

  test('keeps reads closed after a second resize until a post-second-resize write settles', () => {
    const deferred = deferredTerminal()
    const screen = createScreen({ cols: 20, rows: 4, terminalFactory: () => deferred.terminal as never })

    screen.resize(19, 4)
    screen.feed('after first resize')
    screen.resize(18, 4)
    deferred.flushNext()

    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'resize-pending' })
    screen.dispose()
  })

  test('preserves alternate and normal buffers across a resize', async () => {
    const screen = createScreen({ cols: 20, rows: 10 })

    screen.feed(`${esc}[3;1Hnormal${esc}[?1049h${esc}[4;1Halternate`)
    await screen.drain()
    screen.resize(15, 8)
    screen.feed(`${esc}[?25h`)
    await screen.drain()

    const alternate = screen.read()
    expect(alternate).toMatchObject({ status: 'ready' })
    if (alternate.status !== 'ready') throw new Error('alternate screen did not become ready')
    expect(alternate.snapshot.lines[3]).toBe('alternate')

    screen.feed(`${esc}[?1049l`)
    await screen.drain()
    const normal = screen.read()
    expect(normal).toMatchObject({ status: 'ready' })
    if (normal.status !== 'ready') throw new Error('normal screen did not become ready')
    expect(normal.snapshot.lines[2]).toBe('normal')
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
    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'disposed' })
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
    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-fault' })
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

    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-pending' })
    expect(reports).toHaveLength(0)
    deferred.flushNext()
    deferred.flushNext()
    expect(screen.read()).toMatchObject({ status: 'ready' })
    screen.dispose()
  })

  test('ignores a retired life callback after a replacement life is ready', () => {
    const retired = deferredTerminal()
    const replacement = deferredTerminal()
    const retiredScreen = createScreen({ cols: 20, rows: 4, terminalFactory: () => retired.terminal as never })
    const replacementScreen = createScreen({ cols: 20, rows: 4, terminalFactory: () => replacement.terminal as never })

    retiredScreen.feed('obsolete')
    retiredScreen.dispose()
    let retiredParserReads = 0
    const retiredCore = retired.terminal._core
    Object.defineProperty(retired.terminal, '_core', {
      get: () => {
        retiredParserReads++
        return retiredCore
      }
    })
    replacementScreen.feed('current')
    replacement.flushNext()
    const before = replacementScreen.read()
    retired.flushNext()

    expect(retiredParserReads).toBe(0)
    expect(replacementScreen.read()).toEqual(before)
    expect(retiredScreen.read()).toMatchObject({ status: 'unavailable', reason: 'disposed' })
    replacementScreen.dispose()
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

    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-fault' })
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

    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-fault' })
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
    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-fault' })
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
    expect(rejectedScreen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-fault' })
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
    expect(missingScreen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-fault' })
    expect(missingReports).toHaveLength(1)
    missingScreen.dispose()
  })

  // mutation: return `hidden` without the `typeof hidden !== 'boolean'` fault in cursorIsHidden
  test.each([
    ['missing', undefined],
    ['a string', 'false'],
    ['a number', 0]
  ] as const)('faults the screen when the private cursor visibility is %s', (_shape, value) => {
    const deferred = deferredTerminal()
    deferred.terminal._core.coreService.isCursorHidden = value as never
    const reports: string[] = []
    const screen = createXtermScreen({
      cols: 20,
      rows: 4,
      terminalFactory: () => deferred.terminal as never,
      reportError: (_scope: string, message: string) => reports.push(message)
    })

    screen.feed('data')
    deferred.flushNext()

    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-fault' })
    expect(reports).toEqual(['xterm private cursor visibility has an unsupported shape'])
    screen.dispose()
  })

  // mutation: drop the `chars === CHEVRON` test, or `if (!cell) return null`, in chevronStyle
  test.each([
    ['a missing cell', undefined],
    ['only blank cells', ' '],
    ['another character first', 'x']
  ] as const)('leaves the chevron style unresolved for %s', async (_shape, chars) => {
    const getCell = () => (chars === undefined ? undefined : { getChars: () => chars, isBgDefault: () => false, isInverse: () => 0 })
    const deferred = deferredTerminal()
    const screen = createScreen({ cols: 20, rows: 4, terminalFactory: () => deferred.terminal as never })
    screen.feed('data')
    deferred.flushNext()
    Object.defineProperty(deferred.terminal, 'buffer', {
      get: () => ({
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          getLine: () => ({ translateToString: () => '❯ 1. Yes', getCell })
        }
      })
    })

    const read = screen.read()
    expect(read).toMatchObject({ status: 'ready' })
    if (read.status !== 'ready') throw new Error('screen did not become ready')
    expect(read.snapshot.lines[0]).toBe('❯ 1. Yes')
    expect(read.snapshot.chevrons).toEqual([null, null, null, null])
    screen.dispose()
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
    expect(screen.read()).toMatchObject({ status: 'unavailable', reason: 'screen-fault' })
    expect(reports).toHaveLength(1)
    screen.dispose()
  })

  test('preserves the appropriate row portion for ED0 and ED1', async () => {
    const ed0 = createScreen({ cols: 20, rows: 10 })
    ed0.feed(`${esc}[3;1H❯ 1. Yes${esc}[3;9H${esc}[J`)
    await ed0.drain()
    const ed0Read = ed0.read()
    expect(ed0Read).toMatchObject({ status: 'ready' })
    if (ed0Read.status !== 'ready') throw new Error('ED0 screen did not become ready')
    expect(ed0Read.snapshot.lines[2]).toBe('❯ 1. Yes')
    ed0.dispose()

    const ed1 = createScreen({ cols: 20, rows: 10 })
    ed1.feed(`${esc}[3;4H❯ 1. Yes${esc}[3;2H${esc}[1J`)
    await ed1.drain()
    const ed1Read = ed1.read()
    expect(ed1Read).toMatchObject({ status: 'ready' })
    if (ed1Read.status !== 'ready') throw new Error('ED1 screen did not become ready')
    expect(ed1Read.snapshot.lines[2]).toContain('❯ 1. Yes')
    ed1.dispose()
  })

  test('moves rows for IL and DL in the active terminal buffer', async () => {
    const insertion = createScreen({ cols: 20, rows: 10 })
    insertion.feed(`${esc}[6;1Hcomposer${esc}[5;1H${esc}[L`)
    await insertion.drain()
    const insertionRead = insertion.read()
    expect(insertionRead).toMatchObject({ status: 'ready' })
    if (insertionRead.status !== 'ready') throw new Error('IL screen did not become ready')
    expect(insertionRead.snapshot.lines[6]).toBe('composer')
    insertion.dispose()

    const deletion = createScreen({ cols: 20, rows: 10 })
    deletion.feed(`${esc}[7;1Hcomposer${esc}[5;1H${esc}[M`)
    await deletion.drain()
    const deletionRead = deletion.read()
    expect(deletionRead).toMatchObject({ status: 'ready' })
    if (deletionRead.status !== 'ready') throw new Error('DL screen did not become ready')
    expect(deletionRead.snapshot.lines[5]).toBe('composer')
    deletion.dispose()
  })

  test('restores the primary buffer after leaving the alternate screen', async () => {
    const screen = createScreen({ cols: 20, rows: 10 })
    screen.feed(`${esc}[3;1H❯ 1. Yes${esc}[?1049h${esc}[6;1Halternate${esc}[?1049l`)
    await screen.drain()

    const read = screen.read()
    expect(read).toMatchObject({ status: 'ready' })
    if (read.status !== 'ready') throw new Error('alternate screen did not become ready')
    expect(read.snapshot.lines[2]).toBe('❯ 1. Yes')
    screen.dispose()
  })

  test('matches the immutable guard verdicts for every capture', async () => {
    const fixtureNames = readdirSync(FIXTURES)
      .filter((name) => name.endsWith('.json') && name !== 'composer-2.1.285-agent-explorer-reduced.json')
      .sort()
    expect(fixtureNames).toEqual(Object.keys(EXPECTED_FIXTURE_VERDICTS).sort())

    for (const fixture of fixtureNames) {
      const expected = EXPECTED_FIXTURE_VERDICTS[fixture]
      if (!expected) throw new Error(`missing baseline verdict for ${fixture}`)
      expect(await fixtureVerdicts(fixture), fixture).toEqual(expected)
    }
  })

  const stateCapturedColumns = (name: string): number | null => {
    const stated = /-(\d+)c-/.exec(name)
    return stated ? Number(stated[1]) : null
  }
  const PROSOPON_CAPTURES = Object.keys(EXPECTED_FIXTURE_VERDICTS)
    .filter((name) => name.startsWith('prosopon-'))
    .sort()
  const FRAME_TOP = /^┌─ (You|Claude) /

  test('every capture whose name states a width declares that width as its start geometry', () => {
    const named = Object.keys(EXPECTED_FIXTURE_VERDICTS).flatMap((name) => {
      const stated = stateCapturedColumns(name)
      return stated === null ? [] : [{ name, stated }]
    })
    expect(named.length, 'no fixture states its capture width: the geometry guard would check nothing').toBeGreaterThan(0)
    for (const { name, stated } of named) {
      expect(
        fixtureStartSize(loadFixture(name)).cols,
        `${name} must open with a GEOMETRY marker of the width its name states: replayed at the legacy 120 columns it reflows into a screen that never existed`
      ).toBe(stated)
    }
  })

  test.each(PROSOPON_CAPTURES.filter((name) => /-(flow|permission)-/.test(name)))(
    'keeps every real dialog of %s modal with the working copy frames above it',
    async (name) => {
      const replay = await fixtureReplay(name)
      const dialogs = replay.checkpoints.filter((checkpoint) => ['PERMISSION', 'ASK-QUESTION', 'MODEL-PICKER'].includes(checkpoint.label))
      expect(dialogs.length, `${name} holds no dialog checkpoint`).toBeGreaterThan(0)
      for (const dialog of dialogs) {
        expect(dialog.verdict, `${name} ${dialog.label}: a real dialog is modal whatever is drawn above it`).toBe('modal')
        if (dialog.label === 'MODEL-PICKER' && (stateCapturedColumns(name) ?? 0) < 80) continue
        expect(
          dialog.lines.some((line) => FRAME_TOP.test(line)),
          `${name} ${dialog.label}: no frame is on screen, so this checkpoint does not prove the guard under frames`
        ).toBe(true)
      }
    }
  )

  test.each(PROSOPON_CAPTURES.filter((name) => /-(flow|resume)-/.test(name)))(
    'keeps an idle composer clear under the working copy frames in %s',
    async (name) => {
      const replay = await fixtureReplay(name)
      const settled = replay.checkpoints.filter((checkpoint) => ['AFTER-TURN', 'AFTER-RESUMED-TURN', 'AFTER-PAUSE', 'AFTER-INTERRUPT', 'AFTER-ASK'].includes(checkpoint.label))
      expect(settled.length, `${name} holds no settled-composer checkpoint`).toBeGreaterThan(0)
      for (const checkpoint of settled) {
        expect(checkpoint.verdict, `${name} ${checkpoint.label}: an idle composer under frames is clear`).toBe('clear')
        expect(
          checkpoint.lines.some((line) => FRAME_TOP.test(line)),
          `${name} ${checkpoint.label}: no frame is on screen, so this checkpoint does not prove the guard under frames`
        ).toBe(true)
      }
    }
  )

  test.each(['prosopon-432ab5e-quota-80c-2.1.306.json', 'stock-quota-80c-2.1.306.json'])(
    'the settled screen of %s paints the session-limit line natively, outside any frame',
    async (name) => {
      const replay = await fixtureReplay(name)
      const settled = replay.checkpoints.find((checkpoint) => checkpoint.label === 'QUOTA')
      expect(settled, `${name} holds no QUOTA checkpoint`).toBeDefined()
      const limit = settled!.lines.find((line) => line.includes('hit your session limit'))
      expect(limit, `${name}: the session-limit line is not on the settled screen`).toBeDefined()
      expect(limit!.trimStart().startsWith('⎿'), `${name}: the limit line is wrapped in a frame instead of starting with the CLI marker`).toBe(true)
      expect(
        settled!.lines.some((line) => /^┌─ Claude /.test(line)),
        `${name}: the quota message sits in an assistant frame`
      ).toBe(false)
    }
  )

  test.each(PROSOPON_CAPTURES)('%s was captured with a plugin copy that draws the user frame', async (name) => {
    const replay = await fixtureReplay(name)
    const turn = replay.checkpoints.find((checkpoint) => ['AFTER-TURN', 'RESUMED', 'QUOTA'].includes(checkpoint.label))
    expect(turn, `${name} holds no turn checkpoint`).toBeDefined()
    expect(
      turn!.lines.some((line) => /^┌─ You /.test(line)),
      `${name}: no user frame at ${turn!.label}; the capture loaded another copy of the plugin than the plugin copy at choregos 432ab5e these captures were taken with`
    ).toBe(true)
  })

  // mutation: drop `!style.bgDefault` from isEchoRow; this capture's selector row is then skipped and the rule becomes composer-geometry
  test('classifies the selector of a captured dialog on the picker rule', async () => {
    expect(inspectInjectGuard(await fixtureSnapshot('dialog-open-with-esc.json'))).toMatchObject({ state: 'modal', rule: 'picker' })
  })
})

describe('xterm injection guard rules', () => {
  const chevron = String.fromCodePoint(0x276f)
  const horizontal = String.fromCodePoint(0x2500)

  test('keeps the captured composers clear and rejects an unpainted or unclassifiable screen', async () => {
    expect(classifyInjectGuard(await fixtureSnapshot('composer-2.1.283-reduced.json'))).toBe('clear')
    expect(classifyInjectGuard(await fixtureSnapshot('composer-2.1.285-agent-explorer-reduced.json', 100, 30))).toBe('clear')
    expect(classifyInjectGuard(await screenSnapshot('', 120, 40))).toBe('modal')
    expect(classifyInjectGuard(await screenSnapshot('plain text\r\n', 120, 40))).toBe('modal')
    expect(classifyInjectGuard(await screenSnapshot(`${esc}[1;1H${chevron}`, 120, 40))).toBe('modal')
    expect(classifyInjectGuard(await screenSnapshot(`${esc}[6;1H${chevron}${esc}[11;1H`, 120, 40))).toBe('modal')
  })

  const composerWithTop = async (top: string, bottom = horizontal.repeat(100), cursor = `${esc}[9;3H`) =>
    screenSnapshot(`${esc}[8;1H${top}${esc}[9;1H${chevron}${esc}[10;1H${bottom}${cursor}`, 100, 30)

  test('recognizes a complete labelled composer geometry', async () => {
    expect(classifyInjectGuard(await composerWithTop(`${horizontal.repeat(40)} explorer ${horizontal.repeat(50)}`))).toBe('clear')
  })

  test.each([
    ['a second labelled border segment', 'permits-horizontal-label', `${horizontal.repeat(40)} explorer ${horizontal.repeat(40)} worker ${horizontal.repeat(2)}`, horizontal.repeat(100), `${esc}[9;3H`],
    ['a non-horizontal character before the label', 'permits-non-horizontal-leading-border', `${horizontal.repeat(39)}x explorer ${horizontal.repeat(50)}`, horizontal.repeat(100), `${esc}[9;3H`],
    ['a non-horizontal character after the label', 'permits-non-horizontal-trailing-border', `${horizontal.repeat(40)} explorer ${horizontal.repeat(49)}x`, horizontal.repeat(100), `${esc}[9;3H`],
    ['no leading border segment', 'permits-empty-leading-border', ` explorer ${horizontal.repeat(90)}`, horizontal.repeat(100), `${esc}[9;3H`],
    ['no trailing border segment', 'permits-empty-trailing-border', `${horizontal.repeat(90)} explorer `, horizontal.repeat(100), `${esc}[9;3H`],
    ['an empty label', 'permits-empty-label', `${horizontal.repeat(40)}  ${horizontal.repeat(58)}`, horizontal.repeat(100), `${esc}[9;3H`],
    ['a label with leading whitespace', 'permits-leading-label-whitespace', `${horizontal.repeat(40)}  explorer ${horizontal.repeat(49)}`, horizontal.repeat(100), `${esc}[9;3H`],
    ['a label with trailing whitespace', 'permits-trailing-label-whitespace', `${horizontal.repeat(40)} explorer  ${horizontal.repeat(49)}`, horizontal.repeat(100), `${esc}[9;3H`],
    ['a short upper border', 'permits-short-upper-border', horizontal.repeat(99), horizontal.repeat(100), `${esc}[9;3H`],
    ['a short lower border', 'permits-short-lower-border', `${horizontal.repeat(40)} explorer ${horizontal.repeat(50)}`, horizontal.repeat(99), `${esc}[9;3H`],
    ['a cursor outside the composer', 'ignores-cursor-row', `${horizontal.repeat(40)} explorer ${horizontal.repeat(50)}`, horizontal.repeat(100), `${esc}[16;3H`]
  ])('rejects %s [%s]', async (_shape, _mutant, top, bottom, cursor) => {
    expect(classifyInjectGuard(await composerWithTop(top, bottom, cursor))).toBe('modal')
  })

  test.each([
    ['a captured composer after scroll', 'rejects-scrolled-composer', 'clear', () => fixtureSnapshot('scroll-context-2.1.284-reduced.json', 80, 14)],
    ['a picker after scroll', 'ignores-picker-after-scroll', 'modal', () =>
      fixtureSnapshotAfter('scroll-context-2.1.284-reduced.json', `${esc}[14;1H\r\n${chevron} 1. Yes`, 80, 14)]
  ] as const)('classifies %s [%s]', async (_shape, _mutant, expected, snapshot) => {
    expect(classifyInjectGuard(await snapshot())).toBe(expected)
  })

  test('rejects a picker or dialog anywhere beside a captured composer', async () => {
    const picker = await fixtureSnapshotAfter('composer-2.1.283-reduced.json', `${esc}[6;1H${chevron} 5. Haiku${esc}[15;3H`)
    expect(classifyInjectGuard(picker)).toBe('modal')

    const dialog = await fixtureSnapshotAfter(
      'composer-2.1.283-reduced.json',
      `${esc}[2;1H╭${horizontal.repeat(118)}╮${esc}[4;1H╰${horizontal.repeat(118)}╯${esc}[15;3H`
    )
    expect(classifyInjectGuard(dialog)).toBe('modal')
  })

  test.each([
    [
      'keeps the composer at the cursor when a historical chevron remains above it',
      'selects-first-chevron',
      'clear',
      () =>
        screenSnapshot(
          `${esc}[4;1H${chevron} historical output${esc}[8;1H${horizontal.repeat(40)} explorer ${horizontal.repeat(50)}${esc}[9;1H${chevron}${esc}[10;1H${horizontal.repeat(100)}${esc}[9;3H`,
          100,
          30
        )
    ],
    [
      'rejects a picker below the current composer when a prior composer remains above it',
      'limits-picker-search-to-cursor',
      'modal',
      () =>
        screenSnapshot(
          `${esc}[4;1H${horizontal.repeat(40)} explorer ${horizontal.repeat(50)}${esc}[5;1H${chevron}${esc}[6;1H${horizontal.repeat(100)}${esc}[14;1H${horizontal.repeat(40)} explorer ${horizontal.repeat(50)}${esc}[15;1H${chevron}${esc}[16;1H${horizontal.repeat(100)}${esc}[24;1H${chevron} 1. Yes${esc}[15;3H`,
          100,
          30
        )
    ]
  ] as const)('guard %s [%s]', async (_shape, _mutant, expected, snapshot) => {
    expect(classifyInjectGuard(await snapshot())).toBe(expected)
  })

  const composerFixture = 'composer-2.1.283-reduced.json'
  const echoPaint = `${esc}[48;2;55;55;55m${esc}[38;2;153;153;153m`
  const selectorPaint = `${esc}[38;2;177;185;249m`
  const reset = `${esc}[0m`
  const parkOnComposer = `${esc}[15;3H`
  const hideCursor = `${esc}[?25l`
  const numberedRow = (row: number, paint: string, text = '1. Yes', indent = '') =>
    `${esc}[${row};1H${indent}${paint}${chevron} ${text}${reset}`
  const aboveComposer = (data: string) => fixtureSnapshotAfter(composerFixture, `${data}${parkOnComposer}`)
  const withoutNumberedRows = (snapshot: Awaited<ReturnType<typeof fixtureSnapshot>>) => ({
    ...snapshot,
    lines: snapshot.lines.map((line) => (/^\s*❯\s+\d+\./.test(line) ? '' : line))
  })

  // mutation: delete the `!isEchoRow(y)` term of the picker search
  test('exempts the echo of a submitted prompt painted above the composer', async () => {
    const snapshot = await aboveComposer(numberedRow(6, echoPaint))
    expect(snapshot.cursor.y).toBe(14)
    expect(snapshot.cursorHidden).toBe(false)
    expect(snapshot.chevrons).toHaveLength(snapshot.lines.length)
    expect(snapshot.chevrons?.[5]).toEqual({ bgDefault: false, inverse: false })
    expect(inspectInjectGuard(snapshot)).toEqual({ state: 'clear' })
  })

  const echoThenSelector = (hidden: string) =>
    aboveComposer(`${numberedRow(6, echoPaint, '1. hi')}${numberedRow(10, selectorPaint, '2. second', '   ')}${hidden}`)

  // Each row names the edit of xterm-screen.ts that turns it red:
  //   echo-ignores-background          drop `!style.bgDefault` from isEchoRow
  //   echo-ignores-cursor-visibility   drop `snapshot.cursorHidden === false` from isEchoRow
  //   echo-ignores-row-position        drop `y < cursor.y - 1` from isEchoRow
  //   echo-ignores-inverse             drop `!style.inverse` from isEchoRow
  //   chevron-column-from-string-index read the style at the string index of the chevron instead of walking cells
  test.each([
    ['a plain picker above the composer', 'echo-ignores-background', () => aboveComposer(numberedRow(6, '')), { bgDefault: true, inverse: false }, false, 6],
    [
      'a plain picker below a full border',
      'echo-ignores-background',
      () => aboveComposer(`${esc}[5;1H${horizontal.repeat(120)}${numberedRow(6, '')}`),
      { bgDefault: true, inverse: false },
      false,
      6
    ],
    [
      'a plain picker followed by a body write on the composer row',
      'echo-ignores-background',
      () => fixtureSnapshotAfter(composerFixture, `${numberedRow(6, '')}${esc}[15;3Hx`),
      { bgDefault: true, inverse: false },
      false,
      6
    ],
    ['a picker in the selection foreground', 'echo-ignores-background', () => aboveComposer(numberedRow(6, selectorPaint)), { bgDefault: true, inverse: false }, false, 6],
    [
      'a picker in the selection foreground with the cursor hidden',
      'echo-ignores-background',
      () => aboveComposer(`${numberedRow(6, selectorPaint)}${hideCursor}`),
      { bgDefault: true, inverse: false },
      true,
      6
    ],
    [
      'the same picker painted again after the composer',
      'echo-ignores-background',
      () =>
        snapshotFromChunks([
          { t: 0, data: numberedRow(6, '') },
          ...loadFixture(composerFixture),
          { t: 0, data: `${numberedRow(6, '')}${parkOnComposer}` }
        ]),
      { bgDefault: true, inverse: false },
      false,
      6
    ],
    [
      'an echo painted while the cursor is hidden',
      'echo-ignores-cursor-visibility',
      () => aboveComposer(`${numberedRow(6, echoPaint)}${hideCursor}`),
      { bgDefault: false, inverse: false },
      true,
      6
    ],
    ['an echo painted below the composer', 'echo-ignores-row-position', () => aboveComposer(numberedRow(20, echoPaint)), { bgDefault: false, inverse: false }, false, 20],
    ['an inverse echo', 'echo-ignores-inverse', () => aboveComposer(numberedRow(6, `${esc}[7m${echoPaint}`)), { bgDefault: false, inverse: true }, false, 6],
    [
      'a plain picker and a styled echo above the composer',
      'echo-ignores-background',
      () => aboveComposer(`${numberedRow(6, '')}${numberedRow(8, echoPaint)}`),
      { bgDefault: true, inverse: false },
      false,
      6
    ],
    [
      'a real selector under a styled echo',
      'echo-ignores-background',
      () => echoThenSelector(''),
      { bgDefault: true, inverse: false },
      false,
      10
    ],
    [
      'a real selector under a styled echo with the cursor hidden',
      'echo-ignores-cursor-visibility',
      () => echoThenSelector(hideCursor),
      { bgDefault: false, inverse: false },
      true,
      6
    ],
    [
      'a plain chevron after a double-width character on the echo background',
      'chevron-column-from-string-index',
      () => aboveComposer(`${esc}[6;1H${echoPaint}${String.fromCodePoint(0x3000)}${reset}${chevron} 1. Yes${reset}`),
      { bgDefault: true, inverse: false },
      false,
      6
    ]
  ] as const)('keeps %s on the picker rule [%s]', async (_shape, _mutant, snapshotOf, style, hidden, line) => {
    const snapshot = await snapshotOf()
    expect(snapshot.cursorHidden).toBe(hidden)
    expect(snapshot.chevrons?.[line - 1]).toEqual(style)
    expect(inspectInjectGuard(snapshot)).toEqual({ state: 'modal', rule: 'picker', line })
    expect(inspectInjectGuard(withoutNumberedRows(snapshot))).toEqual({ state: 'clear' })
  })

  // mutation: drop `!style.bgDefault` from isEchoRow; the picker row is then skipped and the verdict becomes a geometry or empty-grid one
  const smallComposer = (row: number) =>
    `${esc}[${row};1H${horizontal.repeat(20)}${esc}[${row + 1};1H${chevron}${esc}[${row + 2};1H${horizontal.repeat(20)}`
  const smallPicker = `${esc}[3;1H${chevron} 1. Yes`
  test.each([
    ['ED0', [smallComposer(6), `${smallPicker}${esc}[3;9H${esc}[J${esc}[7;3H`]],
    ['ED1', [smallComposer(6), `${esc}[3;4H${chevron} 1. Yes${esc}[3;2H${esc}[1J${esc}[7;3H`]],
    ['IL', [smallPicker, smallComposer(6), `${esc}[5;1H${esc}[L${esc}[7;3H`]],
    ['DL', [smallPicker, smallComposer(7), `${esc}[5;1H${esc}[M${esc}[8;3H`]],
    ['the alternate screen', [`${smallPicker}${esc}[?1049h`, smallComposer(6), `${esc}[7;3H${esc}[?1049l`]]
  ] as const)('keeps a plain picker on the picker rule after %s', async (_operation, feeds) => {
    const snapshot = await snapshotFromChunks(feeds.map((data) => ({ t: 0, data })), 20, 10)
    expect(snapshot.lines[2]).toContain('❯ 1. Yes')
    expect(snapshot.chevrons?.[2]).toEqual({ bgDefault: true, inverse: false })
    expect(inspectInjectGuard(snapshot)).toEqual({ state: 'modal', rule: 'picker', line: 3 })
  })

  // mutation: exempt the row at the cursor (`y === cursor.y`) in isEchoRow
  test.each(['typing-numbered-2.1.301.json', 'resize-numbered-draft-2.1.301.json'])(
    'keeps a numbered draft typed in the composer on the picker rule (%s)',
    async (fixture) => {
      const snapshot = await fixtureSnapshot(fixture)
      expect(snapshot.chevrons?.[snapshot.cursor.y]).toEqual({ bgDefault: true, inverse: false })
      expect(snapshot.cursorHidden).toBe(false)
      expect(inspectInjectGuard(snapshot)).toEqual({ state: 'modal', rule: 'picker', line: snapshot.cursor.y + 1 })
    }
  )
})

describe('ScreenGuard xterm lifecycle', () => {
  test('starts a blank screen, closes reads for resize, and disposes cleared lives', () => {
    const guard = new ScreenGuard(() => undefined)

    guard.start('tile', 120, 40)
    const initial = guard.read('tile')
    expect(initial.status).toBe('ready')
    if (initial.status === 'ready') expect(inspectInjectGuard(initial.snapshot)).toEqual({ state: 'modal', rule: 'empty-grid' })

    guard.resize('tile', 100, 30)
    expect(guard.read('tile')).toEqual({ status: 'unavailable', reason: 'resize-pending' })

    guard.clear('tile')
    expect(guard.read('tile')).toEqual({ status: 'unavailable', reason: 'disposed' })
  })

  test('faults only the life exceeding the global pending reserve and frees cleared life capacity', () => {
    const first = deferredTerminal()
    const second = deferredTerminal()
    const third = deferredTerminal()
    const terminals = [first, second, third]
    const reports: Array<{ scope: string; message: string }> = []
    const guard = new ScreenGuard(
      (scope, message) => reports.push({ scope, message }),
      {
        globalBudgets: { pendingCodeUnits: 3, pendingChunks: 2 },
        screenOptions: {
          budgets: { pendingCodeUnits: 3, pendingChunks: 2, unsettledCodeUnits: 3 },
          terminalFactory: () => terminals.shift()!.terminal as never
        }
      }
    )

    guard.start('first', 20, 4)
    guard.start('second', 20, 4)
    guard.feed('first', 'aa')
    guard.feed('second', 'bb')

    expect(guard.read('first')).toMatchObject({ status: 'unavailable', reason: 'screen-pending' })
    expect(guard.read('second')).toEqual({ status: 'unavailable', reason: 'screen-fault' })
    expect(reports).toEqual([{ scope: 'screen', message: 'xterm screen global input budget exceeded' }])

    guard.clear('first')
    guard.start('third', 20, 4)
    guard.feed('third', 'bbb')
    expect(guard.read('third')).toMatchObject({ status: 'unavailable', reason: 'screen-pending' })
    third.flushNext()
    expect(guard.read('third')).toMatchObject({ status: 'ready' })
    guard.stop()
  })

  test('enforces the default global code-unit capacity across eight lives', () => {
    const terminals = Array.from({ length: 9 }, deferredTerminal)
    const guard = new ScreenGuard(() => undefined, {
      screenOptions: { terminalFactory: () => terminals.shift()!.terminal as never }
    })

    for (let index = 0; index < 8; index++) {
      const id = `life-${index}`
      guard.start(id, 20, 4)
      guard.feed(id, 'a'.repeat(1024 * 1024))
      expect(guard.read(id)).toMatchObject({ status: 'unavailable', reason: 'screen-pending' })
    }

    guard.start('ninth', 20, 4)
    guard.feed('ninth', 'a')
    expect(guard.read('ninth')).toEqual({ status: 'unavailable', reason: 'screen-fault' })
    guard.stop()
  })

  test('enforces the default global chunk capacity across eight lives', () => {
    const terminals = Array.from({ length: 9 }, deferredTerminal)
    const guard = new ScreenGuard(() => undefined, {
      screenOptions: { terminalFactory: () => terminals.shift()!.terminal as never }
    })

    for (let index = 0; index < 8; index++) {
      const id = `life-${index}`
      guard.start(id, 20, 4)
      for (let chunk = 0; chunk < 4096; chunk++) guard.feed(id, 'a')
      expect(guard.read(id)).toMatchObject({ status: 'unavailable', reason: 'screen-pending' })
    }

    guard.start('ninth', 20, 4)
    guard.feed('ninth', 'a')
    expect(guard.read('ninth')).toEqual({ status: 'unavailable', reason: 'screen-fault' })
    guard.stop()
  })

  test.each([
    ['a terminal callback', (_guard: ScreenGuard, terminal: ReturnType<typeof deferredTerminal>) => terminal.flushNext()],
    ['a life replacement', (guard: ScreenGuard) => guard.start('first', 20, 4)],
    ['stop', (guard: ScreenGuard) => guard.stop()],
    ['a screen fault', (guard: ScreenGuard) => guard.invalidate('first', 'test fault')],
    [
      'a failed resize',
      (guard: ScreenGuard, terminal: ReturnType<typeof deferredTerminal>) => {
        terminal.terminal.resize = () => {
          throw new Error('resize failed')
        }
        guard.resize('first', 19, 4)
      }
    ]
  ] as const)('releases a global reservation after %s', (_event, release) => {
    const first = deferredTerminal()
    const replacement = deferredTerminal()
    const second = deferredTerminal()
    const terminals = [first, replacement, second]
    const guard = new ScreenGuard(() => undefined, {
      globalBudgets: { pendingCodeUnits: 1, pendingChunks: 1 },
      screenOptions: {
        budgets: { pendingCodeUnits: 1, pendingChunks: 1, unsettledCodeUnits: 1 },
        terminalFactory: () => terminals.shift()!.terminal as never
      }
    })

    guard.start('first', 20, 4)
    guard.feed('first', 'a')
    release(guard, first)
    guard.start('second', 20, 4)
    guard.feed('second', 'a')

    expect(guard.read('second')).toMatchObject({ status: 'unavailable', reason: 'screen-pending' })
    guard.stop()
  })

  test('keeps the global reservation balance when a cleared life callback settles late', () => {
    const first = deferredTerminal()
    const terminals = [first, deferredTerminal(), deferredTerminal()]
    const guard = new ScreenGuard(() => undefined, {
      globalBudgets: { pendingCodeUnits: 1, pendingChunks: 1 },
      screenOptions: { terminalFactory: () => terminals.shift()!.terminal as never }
    })

    guard.start('first', 20, 4)
    guard.feed('first', 'a')
    guard.clear('first')
    first.flushNext()
    guard.start('second', 20, 4)
    guard.start('third', 20, 4)
    guard.feed('second', 'a')
    guard.feed('third', 'a')

    expect(guard.read('second')).toMatchObject({ status: 'unavailable', reason: 'screen-pending' })
    expect(guard.read('third'), 'a late callback of a cleared life released its reservation a second time').toEqual({
      status: 'unavailable',
      reason: 'screen-fault'
    })
    guard.stop()
  })
})

