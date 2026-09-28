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

function extractRemoveBody(src: string): string {
  const fnMatch = /async remove\(id: string\): Promise<void> \{/.exec(src)
  if (!fnMatch) throw new Error('remove() not found in session-service.ts -- has it been renamed?')
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1)
}

function extractKillWithTraceBody(src: string): string {
  const fnMatch = /private killWithTrace\(id: string, reason: string\): void \{/.exec(src)
  if (!fnMatch) throw new Error('killWithTrace() not found in session-service.ts')
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

test('every modal refusal and SessionService kill path logs a static reason before acting (real file)', () => {
  const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
  const removeBody = extractRemoveBody(src)
  const killBody = extractKillWithTraceBody(src)
  const refusals = [...src.matchAll(/return 'refused-modal'/g)]
  const refusalBlocks = [
    ...src.matchAll(
      /if \((?:[^()]|\([^()]*\))*\) \{\s*logInfo\('session', `[^$`]*refused-modal for \$\{id\}: [^$`]+`\)\s*return 'refused-modal'/g
    )
  ]

  expect(refusals.length).toBeGreaterThan(0)
  expect(refusalBlocks).toHaveLength(refusals.length)

  expect(killBody.indexOf('logInfo')).toBeGreaterThan(-1)
  expect(killBody.indexOf('logInfo')).toBeLessThan(killBody.indexOf('this.pty.kill(id)'))
  expect([...src.matchAll(/this\.pty\.kill\(id\)/g)]).toHaveLength(1)
  expect(removeBody).toContain("this.killWithTrace(id, 'force cleanup')")
  expect(removeBody).toContain("kill: () => this.killWithTrace(id, 'close escalation')")
  expect(src).toContain("this.killWithTrace(id, 'utility terminal')")
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
test('a tile id reused after ScreenGuard.clear() gets a fresh classification', () => {
  const guard = new ScreenGuard()
  const id = 'tile-reused'
  const esc = String.fromCharCode(27)
  const chevron = String.fromCodePoint(0x276f)
  const border = String.fromCodePoint(0x2500).repeat(120)

  guard.resize(id, 120, 40)
  guard.feed(id, `${esc}[5;1H${border}${esc}[6;1H${chevron}old draft${esc}[7;1H${border}${esc}[6;10H`)
  expect(guard.classify(id)).toBe('clear')

  guard.clear(id)

  guard.resize(id, 120, 40)
  guard.feed(id, `${esc}[20;1H${border}${esc}[21;1H${chevron}new draft${esc}[22;1H${border}${esc}[21;10H`)
  expect(guard.classify(id)).toBe('clear')
})

describe('ScreenGuard.resize', () => {
  const TOP_ROW = 101
  const CHEVRON_ROW = 102
  const TALL_TOP_ROW = 250
  const TALL_CHEVRON_ROW = 251
  const esc = String.fromCharCode(27)
  const chevron = String.fromCodePoint(0x276f)
  const border = String.fromCodePoint(0x2500).repeat(120)
  const feedComposer = (feed: (data: string) => void, topRow: number, chevronRow: number): void => {
    feed(`${esc}[${topRow};1H${border}`)
    feed(`${esc}[${chevronRow};1H${chevron}draft`)
    feed(`${esc}[${chevronRow + 1};1H${border}`)
    feed(`${esc}[${chevronRow};5H`)
  }
  const feedDefaultComposer = (feed: (data: string) => void): void => feedComposer(feed, TOP_ROW, CHEVRON_ROW)
  const feedTallComposer = (feed: (data: string) => void): void => feedComposer(feed, TALL_TOP_ROW, TALL_CHEVRON_ROW)

  test('a 120x40 Screen classifies an out-of-bounds composer as modal', () => {
    const screen = makeScreen(120, 40)
    feedDefaultComposer(screen.feed)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('a composer is clear when the Screen covers its rows', () => {
    const screen = makeScreen(120, 300)
    feedDefaultComposer(screen.feed)
    expect(classifyInjectGuard(screen)).toBe('clear')
  })

  test('the default Screen refuses a composer until its terminal width is configured', () => {
    const screen = makeScreen()
    feedDefaultComposer(screen.feed)
    expect(classifyInjectGuard(screen)).toBe('modal')
  })

  test('ScreenGuard.resize classifies a composer at the configured size', () => {
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
    feedTallComposer((data) => guard.feed('tile-x', data))
    expect(guard.classify('tile-x')).toBe('clear')
    guard.resize('tile-x', Number.NaN, 300)
    guard.resize('tile-x', 120, Number.NaN)
    guard.resize('tile-x', 0, 300)
    guard.resize('tile-x', 120, -5)
    expect(guard.classify('tile-x')).toBe('clear')
  })
})
