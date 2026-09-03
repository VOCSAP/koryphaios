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
    screen.feed('\x1b[1;1H❯')
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('a chevron row present but the cursor sitting elsewhere (not one row above it) -> modal', () => {
    const screen = makeScreen(COLS, ROWS)
    // Row 5 (0-indexed): the chevron. Cursor left on row 10, far from row 4.
    screen.feed('\x1b[6;1H❯\x1b[11;1H')
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('a fresh, empty screen (nothing painted yet) -> modal', () => {
    const screen = makeScreen(COLS, ROWS)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })
})

describe('classifyInjectGuard synthetic composer shape (hand-authored bytes, not a live CLI -- team-lead: deterministic fixtures only)', () => {
  test('cursor exactly one row above the chevron -> clear, the minimal shape the real fixtures share', () => {
    const screen = makeScreen(COLS, ROWS)
    // Row 5: content row (cursor lands here after the write). Row 6: chevron.
    screen.feed('\x1b[6;3Hhello\x1b[7;1H❯\x1b[6;8H')
    expect(classifyInjectGuard(screen)).toBe('clear')
  })

  test('cursor one row BELOW the chevron (not above) -> modal, the relation is directional', () => {
    const screen = makeScreen(COLS, ROWS)
    screen.feed('\x1b[6;1H❯\x1b[7;1Hx')
    expect(classifyInjectGuard(screen)).toBe('modal')
  })
})
