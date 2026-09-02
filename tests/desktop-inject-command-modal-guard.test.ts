import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeScreen, classifyInjectGuard, ScreenGuard } from '../desktop/src/main/screen-model.ts'
import { extractBracedBody } from './_braced-body'

// SessionService isn't bun-test-importable (PtyManager -> node-pty, plus
// unresolved @shared/* aliases outside desktop's own tsconfig); this reads the
// real file text and asserts on injectCommand's body shape rather than
// instantiating the class.

const SESSION_SERVICE_PATH = join(import.meta.dir, '..', 'desktop', 'src', 'main', 'session-service.ts')

function extractInjectCommandBody(src: string): string {
  const fnMatch = /async injectCommand\([^)]*\)[^{]*\{/.exec(src)
  if (!fnMatch) throw new Error('injectCommand() not found in session-service.ts -- has it been renamed?')
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1)
}

const ESC_WRITE = /this\.pty\.write\(id,\s*'\\x1b'\)/
const SCREEN_GUARD_CHECK = /this\.screenGuard\.classify\(id\)\s*===\s*'modal'/
const ATTENTION_CHECK = /this\.runtime\.get\(id\)\?\.needsAttention/
// Card 63ca372f's own contract: idle AND NOT needsAttention AND NOT
// rateLimited. Added alongside ATTENTION_CHECK -- rateLimited was the one
// signal the original A2-1 guard left out (roadmap card, dev1's fix).
const RATE_LIMITED_CHECK = /this\.runtime\.get\(id\)\?\.rateLimited/
const REFUSAL_RETURN = /return\s+'refused-modal'/g

/**
 * All three signals must be checked, and EACH check must return the refusal
 * BEFORE the Escape write -- a check present but placed after the write (or
 * present without its own `return 'refused-modal'`) would compile and read
 * fine while doing nothing.
 */
function guardIsWiredBeforeEscape(body: string): boolean {
  const escIdx = body.search(ESC_WRITE)
  if (escIdx === -1) return false
  const before = body.slice(0, escIdx)
  const refusals = before.match(REFUSAL_RETURN) ?? []
  return (
    SCREEN_GUARD_CHECK.test(before) &&
    ATTENTION_CHECK.test(before) &&
    RATE_LIMITED_CHECK.test(before) &&
    refusals.length >= 3
  )
}

test("injectCommand's screen-state guard runs BEFORE the Escape write and refuses on either signal (real file)", () => {
  const body = extractInjectCommandBody(readFileSync(SESSION_SERVICE_PATH, 'utf-8'))
  expect(guardIsWiredBeforeEscape(body)).toBe(true)
})

test("'refused-modal' is a member of DirectiveOutcome (real file)", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
  const typeMatch = /export type DirectiveOutcome = ([^\n]+)/.exec(src)
  expect(typeMatch).not.toBeNull()
  expect(typeMatch![1]).toContain("'refused-modal'")
})

test("agent-stop.ts's mirrored InjectOutcome carries the same new member (real file)", () => {
  const AGENT_STOP_PATH = join(import.meta.dir, '..', 'desktop', 'src', 'main', 'agent-stop.ts')
  const src = readFileSync(AGENT_STOP_PATH, 'utf-8')
  const typeMatch = /export type InjectOutcome = ([^\n]+)/.exec(src)
  expect(typeMatch).not.toBeNull()
  expect(typeMatch![1]).toContain("'refused-modal'")
})

// ----- RED-proof: the guard function itself, exercised against synthetic
// bodies, not the real file -- mutating session-service.ts in a test is
// fragile (same convention as desktop-inject-command-write-check.test.ts).

test('the guard REJECTS a body with no screen-state check at all (the pre-A2-1 shape)', () => {
  const body = `
    if (!this.pty.isAlive(id)) return 'no-terminal'
    const idle = await this.waitIdle(id, idleWaitMs)
    if (!this.pty.isAlive(id)) return 'no-terminal'
    if (!idle) return 'busy-timeout'
    this.pty.write(id, '\\x1b')
    await new Promise((res) => setTimeout(res, DIRECTIVE_SETTLE_MS))
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    return 'written'
  `
  expect(guardIsWiredBeforeEscape(body)).toBe(false)
})

test('the guard REJECTS a body with only the geometric check, missing the attention union (half the union removed)', () => {
  const body = `
    if (!idle) return 'busy-timeout'
    if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
    this.pty.write(id, '\\x1b')
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    return 'written'
  `
  expect(guardIsWiredBeforeEscape(body)).toBe(false)
})

test('the guard REJECTS a body with only the attention check, missing the geometric signal (the other half removed)', () => {
  const body = `
    if (!idle) return 'busy-timeout'
    if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
    this.pty.write(id, '\\x1b')
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    return 'written'
  `
  expect(guardIsWiredBeforeEscape(body)).toBe(false)
})

test('the guard REJECTS a body with screenGuard and attention but missing rateLimited (the exact gap card 63ca372f/120148eb closes)', () => {
  const body = `
    if (!idle) return 'busy-timeout'
    if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
    if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
    this.pty.write(id, '\\x1b')
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    return 'written'
  `
  expect(guardIsWiredBeforeEscape(body)).toBe(false)
})

test('the guard REJECTS a check placed AFTER the Escape write (too late to prevent it)', () => {
  const body = `
    if (!idle) return 'busy-timeout'
    this.pty.write(id, '\\x1b')
    if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
    if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
    if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    return 'written'
  `
  expect(guardIsWiredBeforeEscape(body)).toBe(false)
})

test('the guard ACCEPTS the fixed shape: all three signals checked, all refusing before the Escape write', () => {
  const body = `
    if (!idle) return 'busy-timeout'
    if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
    if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
    if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
    this.pty.write(id, '\\x1b')
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    return 'written'
  `
  expect(guardIsWiredBeforeEscape(body)).toBe(true)
})

// ----- ScreenGuard lifecycle: fed and cleared alongside the sibling
// detectors (thinking/quota/attention/startupAck), same convention -- source
// scan of the whole file, since the wiring spans multiple methods.

test('screenGuard.feed is wired into the central pty data handler alongside the other four detectors', () => {
  const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
  const feedBlockMatch =
    /this\.thinkingDetector\.feed\(e\.id, e\.data\)[\s\S]{0,400}?this\.screenGuard\.feed\(e\.id, e\.data\)/.exec(src)
  expect(feedBlockMatch).not.toBeNull()
  expect(feedBlockMatch![0]).toContain('this.startupAckDetector.feed(e.id, e.data)')
})

// Exercises ScreenGuard.clear()'s own contract directly rather than scanning
// session-service.ts, because an occurrence count of screenGuard.clear/stop
// calls detects a call disappearing but not relocating: a deleted call from a
// real boundary plus an unrelated call added elsewhere leaves the count
// unchanged.
// Whether session-service.ts's remove() (or any other boundary) actually calls
// screenGuard.clear(id) at runtime is not verified here: SessionService isn't
// bun-test-importable, so that wiring gap is a separate open item.
test('a tile id reused after ScreenGuard.clear() gets a fresh classification, never the dead grid a leaked entry would produce', () => {
  const guard = new ScreenGuard()
  const id = 'tile-reused'

  // First PTY life: a composer painted low on the screen (content row 5,
  // chevron row 6) -- classifies correctly while this life is live.
  guard.feed(id, '\x1b[5;1Hold draft\x1b[6;1H❯\x1b[5;10H')
  expect(guard.classify(id)).toBe('clear')

  // The boundary call every PTY-life end must make (remove(), stop(),
  // closeAll(), restoreFrom(), the pty-exit handler, restart's fresh spawn).
  guard.clear(id)

  // The reused id's composer paints lower (row 20/21) than the original (row 6)
  // on purpose: if clear() were skipped, the leaked screen's stale chevron at
  // row 6 would win the topmost-match search and flip the verdict to 'modal',
  // so same-position composers would prove nothing either way.
  guard.feed(id, '\x1b[20;1Hnew draft\x1b[21;1H❯\x1b[20;10H')
  expect(guard.classify(id)).toBe('clear')
})

// ----- Review-round finding on 63ca372f/120148eb: ScreenGuard.feed built its
// Screen at makeScreen's fixed default and was never told about a real
// resize, so a tile taller than that default froze classifyInjectGuard at
// 'modal' forever (CUP addressing is absolute -- once content/cursor rows
// clamp to the same last row, cy===chevronRow-1 becomes structurally
// impossible). screen-model.ts is a pure module (no electron/node-pty
// import, per its own header comment) -- these are real behavioural tests
// against makeScreen/classifyInjectGuard/ScreenGuard, not a source scan.

describe('ScreenGuard.resize (card 120148eb review finding: the grid must track the real terminal size, not a fixed default)', () => {
  // 1-indexed CUP rows for a composer taller than the OLD 120x40 default
  // but still within the NEW 400x200 default. Used by the three tests below
  // that are specifically about that default's own generosity.
  const CONTENT_ROW = 101 // 0-indexed 100
  const CHEVRON_ROW = 102 // 0-indexed 101
  const feedComposer = (feed: (data: string) => void): void => {
    feed(`\x1b[${CONTENT_ROW};1Hsome draft text`)
    feed(`\x1b[${CHEVRON_ROW};1H❯`)
    // Real captures show the terminal cursor back on the CONTENT row (one
    // above the chevron), not left on the chevron row -- see
    // classifyInjectGuard's own doc for why that relationship, not the
    // glyph's mere presence, is what it tests.
    feed(`\x1b[${CONTENT_ROW};5H`)
  }

  // TALL_CONTENT_ROW/TALL_CHEVRON_ROW sit past ScreenGuard's default 400x200
  // grid reach, used only by the resize/NaN-rejection tests: an inert resize()
  // clamps both rows to the default's last row and misclassifies, while a real
  // resize() covers them -- only this composer can tell whether resize()
  // actually ran.
  const TALL_CONTENT_ROW = 250 // 0-indexed 249, beyond the default's rows-1=199
  const TALL_CHEVRON_ROW = 251 // 0-indexed 250
  const feedTallComposer = (feed: (data: string) => void): void => {
    feed(`\x1b[${TALL_CONTENT_ROW};1Hsome draft text`)
    feed(`\x1b[${TALL_CHEVRON_ROW};1H❯`)
    feed(`\x1b[${TALL_CONTENT_ROW};5H`)
  }

  test('a Screen fixed at the pre-fix 120x40 default misclassifies this composer as modal (the exact defect the review found)', () => {
    const screen = makeScreen(120, 40)
    feedComposer(screen.feed)
    // Both the content row (101) and the chevron row (102) clamp to the
    // last real row (39), landing the chevron on TOP of the content and the
    // final cursor CUP on that same clamped row -- cy(39) !== chevronRow(39)-1.
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('the SAME composer classifies correctly once the Screen is built at its real size', () => {
    const screen = makeScreen(120, 300)
    feedComposer(screen.feed)
    expect(classifyInjectGuard(screen)).toBe('clear')
  })

  test("makeScreen()'s own default (no args -- what ScreenGuard.feed builds before any resize() call has ever happened) is now generous enough to cover this composer between any (re)creation of a tile's Screen and the next resize", () => {
    const screen = makeScreen()
    feedComposer(screen.feed)
    expect(classifyInjectGuard(screen)).toBe('clear')
  })

  test('ScreenGuard.resize rebuilds the tracked Screen at the real size, so classify() sees the fixed geometry (RED-proof target: strip resize() to a no-op and this goes red)', () => {
    const guard = new ScreenGuard()
    guard.resize('tile-tall', 120, 300)
    feedTallComposer((data) => guard.feed('tile-tall', data))
    expect(guard.classify('tile-tall')).toBe('clear')
  })

  test('SessionService.resize forwards its cols/rows into screenGuard.resize (real file) -- without this call, PtyManager and ScreenGuard silently diverge the moment the renderer ever resizes a tile', () => {
    const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
    const fnMatch = /resize\(id: string, cols: number, rows: number\): void \{([\s\S]*?)\n  \}/.exec(src)
    expect(fnMatch).not.toBeNull()
    expect(fnMatch![1]).toContain('this.pty.resize(id, cols, rows)')
    expect(fnMatch![1]).toContain('this.screenGuard.resize(id, cols, rows)')
  })

  test('resize() rejects non-finite/invalid dims explicitly, leaving the tracked Screen untouched (cols/rows are IPC-sourced -- a bare `cols < 1` comparison against NaN is false and would let it through into `new Array(NaN)`, which throws)', () => {
    const guard = new ScreenGuard()
    guard.resize('tile-x', 120, 300)
    // Tall composer (past the 400x200 default's own reach, D7): if an
    // invalid resize() silently replaced the tracked Screen with a fresh
    // default-sized one instead of leaving it untouched, this composer
    // would misclassify too, same as the resize-RED-proof above -- the
    // 101/102 composer could not tell "untouched" from "replaced by a
    // generous-enough default" apart.
    feedTallComposer((data) => guard.feed('tile-x', data))
    expect(guard.classify('tile-x')).toBe('clear')
    // None of these may crash (proves NaN is rejected before `new Array`)
    // or silently replace the tracked Screen with a blank one (proves the
    // real composer survives -- a replaced/blank Screen has no chevron
    // painted at all, which classifies 'modal', not 'clear').
    guard.resize('tile-x', Number.NaN, 300)
    guard.resize('tile-x', 120, Number.NaN)
    guard.resize('tile-x', 0, 300)
    guard.resize('tile-x', 120, -5)
    expect(guard.classify('tile-x')).toBe('clear')
  })
})
