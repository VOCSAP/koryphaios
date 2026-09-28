import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeScreen, classifyInjectGuard } from '../desktop/src/main/screen-model'

// Marker chunks inserted by the capture harness are synthetic, never emitted by
// the real CLI; isMarker filters them out before feed(), or they'd paint into
// the grid and corrupt the screen under test.
// Screen size is fixed at 120x40 explicitly -- replaying at another size
// doesn't fail, it silently reflows into a screen that never existed.

const FIXTURES = join(import.meta.dir, 'pty-harness', 'fixtures')
const COLS = 120
const ROWS = 40

type Chunk = { t: number; data: string }
const load = (name: string): Chunk[] => JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'))

const isMarker = (c: Chunk): boolean => c.data.startsWith('\n########## ')
const markerText = (c: Chunk): string => c.data.trim().replace(/^#+\s*|\s*#+$/g, '')

/**
 * Replays a fixture up to (not including) the chunk whose marker text matches
 * `stopAtMarker`, returning the reconstructed Screen at that point -- i.e.
 * the screen injectCommand's guard would see BEFORE its own write. Synthetic
 * marker chunks are never fed to the model (PIEGE 1).
 */
function screenBeforeMarker(fixture: string, stopAtMarker: RegExp) {
  const screen = makeScreen(COLS, ROWS)
  for (const c of load(fixture)) {
    if (isMarker(c)) {
      if (stopAtMarker.test(markerText(c))) return screen
      continue
    }
    screen.feed(c.data)
  }
  return screen
}

function screenFromFixture(fixture: string) {
  const screen = makeScreen(COLS, ROWS)
  for (const c of load(fixture)) screen.feed(c.data)
  return screen
}

describe('classifyInjectGuard against real captures (tests/pty-harness/fixtures)', () => {
  test('trust dialog, ESC branch: modal, evaluated on the screen BEFORE injectCommand writes anything', () => {
    const screen = screenBeforeMarker('dialog-open-with-esc.json', /injectCommand sequence/)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('trust dialog, no-ESC branch: modal (same screen state, the two fixtures diverge only AFTER this point)', () => {
    const screen = screenBeforeMarker('dialog-open-no-esc.json', /injectCommand sequence/)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('empty prompt, no overlay: clear', () => {
    const screen = screenBeforeMarker('prompt-idle-with-esc.json', /^SNAPSHOT prompt$/)
    expect(classifyInjectGuard(screen)).toBe('clear')
  })

  test('operator draft in progress: clear (the guard must not treat a draft as a reason to refuse)', () => {
    const screen = screenBeforeMarker('draft-typed-with-esc.json', /^SNAPSHOT draft-typed$/)
    expect(classifyInjectGuard(screen)).toBe('clear')
  })

  test('slash-command menu open: clear -- the menu is ALSO chevron/number-led content further down-screen, proving the guard does not key on that glyph alone', () => {
    const screen = screenBeforeMarker('slash-menu-with-esc.json', /^SNAPSHOT menu-open$/)
    expect(classifyInjectGuard(screen)).toBe('clear')
  })

  test('after-esc snapshots stay stable in both directions (ESC does not flip the classification)', () => {
    expect(classifyInjectGuard(screenBeforeMarker('prompt-idle-with-esc.json', /^SNAPSHOT after-esc$/))).toBe(
      'clear'
    )
    expect(classifyInjectGuard(screenBeforeMarker('draft-typed-with-esc.json', /^SNAPSHOT after-esc$/))).toBe(
      'clear'
    )
    expect(classifyInjectGuard(screenBeforeMarker('slash-menu-with-esc.json', /^SNAPSHOT after-esc$/))).toBe(
      'clear'
    )
  })
})

describe('classifyInjectGuard fail-closed defaults (D2: unclassifiable = modal, never a guess)', () => {
  test('a screen with no chevron row at all -> modal', () => {
    const screen = makeScreen(COLS, ROWS)
    screen.feed('just some plain text with no composer glyph\r\n')
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('a chevron on the very first row (no row above it to hold the cursor) -> modal, not a crash', () => {
    const screen = makeScreen(COLS, ROWS)
    screen.feed(`\x1b[1;1H${String.fromCodePoint(0x276f)}`)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('a chevron row present but the cursor elsewhere -> modal', () => {
    const screen = makeScreen(COLS, ROWS)
    screen.feed(`\x1b[6;1H${String.fromCodePoint(0x276f)}\x1b[11;1H`)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('a fresh, empty screen (nothing painted yet) -> modal', () => {
    const screen = makeScreen(COLS, ROWS)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })
})

describe('classifyInjectGuard reduced ConPTY composer fixture', () => {
  const chevron = String.fromCodePoint(0x276f)
  const horizontal = String.fromCodePoint(0x2500)
  const border = horizontal.repeat(COLS)
  const esc = String.fromCharCode(27)
  const composer = () => screenFromFixture('composer-2.1.283-reduced.json')

  const feedComposer = (screen: ReturnType<typeof makeScreen>, row: number): void => {
    screen.feed(`${esc}[${row};1H${border}${esc}[${row + 1};1H${chevron}${esc}[${row + 2};1H${border}`)
  }

  test('replays the captured full-width composer as clear', () => {
    expect(classifyInjectGuard(composer())).toBe('clear')
  })

  test('recognizes the captured composer below a historical chevron', () => {
    const screen = composer()
    screen.feed(`${esc}[6;1H${chevron} historical prompt${esc}[15;3H`)
    expect(classifyInjectGuard(screen)).toBe('clear')
  })

  test('rejects a short upper border around the captured composer', () => {
    const screen = composer()
    screen.feed(`${esc}[14;1H${horizontal.repeat(COLS - 1)}${esc}[K${esc}[15;3H`)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('rejects a short lower border around the captured composer', () => {
    const screen = composer()
    screen.feed(`${esc}[16;1H${horizontal.repeat(COLS - 1)}${esc}[K${esc}[15;3H`)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('rejects a picker above the captured composer', () => {
    const screen = composer()
    screen.feed(`${esc}[6;1H${chevron} 5. Haiku${esc}[15;3H`)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('rejects a dialog alongside the captured composer', () => {
    const screen = composer()
    screen.feed(`${esc}[2;1H╭${horizontal.repeat(COLS - 2)}╮${esc}[4;1H╰${horizontal.repeat(COLS - 2)}╯${esc}[15;3H`)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('rejects a lower picker when an older composer remains above it', () => {
    const screen = composer()
    feedComposer(screen, 5)
    screen.feed(`${esc}[31;1H${chevron} 5. Haiku${esc}[15;3H`)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('rejects the captured composer when its cursor is on the lower border', () => {
    const screen = composer()
    screen.feed(`${esc}[16;3H`)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })
})

describe('makeScreen deferred wrap after erasure', () => {
  for (const [name, sequence] of [
    ['EL default', '\x1b[K'],
    ['EL mode 1', '\x1b[1K'],
    ['EL mode 2', '\x1b[2K'],
    ['ED default', '\x1b[J'],
    ['ED mode 1', '\x1b[1J'],
    ['ED mode 2', '\x1b[2J']
  ]) {
    test(`${name} clears a pending wrap`, () => {
      const screen = makeScreen(3, 2)
      screen.feed(`abc${sequence}X`)
      expect(screen.cursor().cy).toBe(0)
    })
  }

  test('ED mode 3 preserves a pending wrap', () => {
    const screen = makeScreen(3, 2)
    screen.feed('abc\x1b[3JX')
    expect(screen.cursor().cy).toBe(1)
  })
})
