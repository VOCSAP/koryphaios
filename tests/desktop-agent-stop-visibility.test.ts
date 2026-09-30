import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractBracedBody } from './_braced-body'
import { ScreenGuard } from '../desktop/src/main/screen-model.ts'

// AgentStopControls.tsx pulls in React and sibling components that don't import
// cleanly under `bun test` (no bundler/CSS loader), so this extracts each
// filter predicate from the real file text and evaluates it directly against
// synthetic StopOutcome objects.

const SRC_PATH = join(
  import.meta.dir,
  '..',
  'desktop',
  'src',
  'renderer',
  'src',
  'components',
  'AgentStopControls.tsx'
)

/**
 * Extracts the arrow-function predicate passed to `.filter()` inside
 * `function <fnName>(r: StopReport): StopOutcome[] { return r.outcomes.filter((o) => PREDICATE) }`
 * and returns it as a callable `(o) => boolean`. All five filters in this
 * file are exactly this one-line shape with no nested parentheses in their
 * predicate, so a single-line, non-multiline regex is sufficient and any
 * future reshaping (multi-line body, nested filter, helper extraction) makes
 * this throw loudly instead of silently testing nothing.
 */
function extractPredicate(src: string, fnName: string): (o: { result: string }) => boolean {
  const re = new RegExp(
    `function ${fnName}\\(r: StopReport\\): StopOutcome\\[\\] \\{\\s*return r\\.outcomes\\.filter\\(\\(o\\) => (.+)\\)\\s*\\n\\s*\\}`
  )
  const m = re.exec(src)
  if (!m) throw new Error(`${fnName}(): shape changed, could not extract its filter predicate`)
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  return new Function('o', `return (${m[1]})`) as (o: { result: string }) => boolean
}

const RESULT_VALUES = ['interrupted', 'written', 'busy-timeout', 'no-terminal', 'error', 'refused-modal'] as const

describe("refusedModal() and the negative control (team-lead's explicit ask)", () => {
  const src = readFileSync(SRC_PATH, 'utf-8')
  const filters = {
    interrupted: extractPredicate(src, 'interrupted'),
    transmitted: extractPredicate(src, 'transmitted'),
    stragglers: extractPredicate(src, 'stragglers'),
    unreachable: extractPredicate(src, 'unreachable'),
    refusedModal: extractPredicate(src, 'refusedModal')
  }

  test("refusedModal's predicate matches 'refused-modal' and nothing else", () => {
    for (const v of RESULT_VALUES) {
      expect(filters.refusedModal({ result: v })).toBe(v === 'refused-modal')
    }
  })

  test("NEGATIVE CONTROL: none of the four PRE-EXISTING filters silently absorb 'refused-modal'", () => {
    expect(filters.interrupted({ result: 'refused-modal' })).toBe(false)
    expect(filters.transmitted({ result: 'refused-modal' })).toBe(false)
    expect(filters.stragglers({ result: 'refused-modal' })).toBe(false)
    expect(filters.unreachable({ result: 'refused-modal' })).toBe(false)
  })

  test('every filter still matches exactly its own original value (no regression from the extraction)', () => {
    expect(filters.interrupted({ result: 'interrupted' })).toBe(true)
    expect(filters.transmitted({ result: 'written' })).toBe(true)
    expect(filters.stragglers({ result: 'busy-timeout' })).toBe(true)
    expect(filters.unreachable({ result: 'no-terminal' })).toBe(true)
    expect(filters.unreachable({ result: 'error' })).toBe(true)
  })
})

describe('structural wiring: escalation, tally, and own-label requirements', () => {
  test('escalatable includes refused (hard-stop escalation offered on a screen-guard refusal)', () => {
    const src = readFileSync(SRC_PATH, 'utf-8')
    expect(src).toContain('const escalatable = [...written, ...stuck, ...refused]')
  })

  test('the tally uses its OWN i18n key for refused, never one of the four existing bucket keys', () => {
    const src = readFileSync(SRC_PATH, 'utf-8')
    const tallyMatch = /\{refused\.length > 0 && \(\s*<li[^>]*>\{t\('([^']+)'/.exec(src)
    expect(tallyMatch).not.toBeNull()
    const key = tallyMatch![1]
    expect(key).toBe('roadmap.stop.refused')
    // and it must differ from the four existing bucket keys this file already uses
    expect(['roadmap.stop.notTook', 'roadmap.stop.unreachable', 'roadmap.stop.written']).not.toContain(key)
  })

  test('the escalate-hint branch has its own refused-only message, distinct from escalateUnconfirmed/escalateHint', () => {
    const src = readFileSync(SRC_PATH, 'utf-8')
    expect(src).toContain("t('roadmap.stop.escalateRefused'")
  })

  test('shared/types.ts StopOutcome.result carries refused-modal (the third mirror of the union)', () => {
    const typesSrc = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'shared', 'types.ts'), 'utf-8')
    expect(typesSrc).toContain("'refused-modal'")
  })
})

// ----- RED-proof of the negative control itself: prove the extractor/test
// actually bites on a PRE-A2.2-followup shape (four filters, no refusedModal,
// no 'refused-modal' anywhere) rather than trivially passing on any input.

test("the negative control REJECTS a synthetic 'stragglers' shape that DOES absorb refused-modal (the exact bug this guards)", () => {
  const buggySrc = `
    function stragglers(r: StopReport): StopOutcome[] {
      return r.outcomes.filter((o) => o.result === 'busy-timeout' || o.result === 'refused-modal')
    }
  `
  const buggyStragglers = extractPredicate(buggySrc, 'stragglers')
  expect(buggyStragglers({ result: 'refused-modal' })).toBe(true) // proves the extractor is live
})

describe("SessionService.interrupt()'s pause-only screen-state gate", () => {
  const SESSION_SERVICE_PATH = join(
    import.meta.dir,
    '..',
    'desktop',
    'src',
    'main',
    'session-service.ts'
  )

  function extractInterruptBody(src: string): string {
    const fnMatch = /interrupt\(id: string, mode:[^)]*\)[^{]*\{/.exec(src)
    if (!fnMatch) throw new Error('interrupt(id, mode) not found in session-service.ts -- has it been renamed?')
    return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1)
  }

  const ESC_WRITE = /this\.pty\.write\(id,\s*'\\x1b'\)/
  const PAUSE_BRANCH = /mode\s*===\s*'pause'/
  const SCREEN_GUARD_CHECK = /this\.screenGuard\.inspect\(id\)/
  const ATTENTION_CHECK = /this\.runtime\.get\(id\)\?\.needsAttention/
  const RATE_LIMITED_CHECK = /this\.runtime\.get\(id\)\?\.rateLimited/
  const REFUSAL_RETURN = /return\s+'refused-modal'/g

  // Hard interrupts must always send Escape, so only the pause branch is guarded.
  function pauseIsGatedBeforeEscape(body: string): boolean {
    const escIdx = body.search(ESC_WRITE)
    if (escIdx === -1) return false
    const before = body.slice(0, escIdx)
    const refusals = before.match(REFUSAL_RETURN) ?? []
    return (
      PAUSE_BRANCH.test(before) &&
      SCREEN_GUARD_CHECK.test(before) &&
      ATTENTION_CHECK.test(before) &&
      RATE_LIMITED_CHECK.test(before) &&
      refusals.length >= 3
    )
  }

  test('interrupt() gates on both screen-state signals inside a pause branch, before the Escape write (real file)', () => {
    const body = extractInterruptBody(readFileSync(SESSION_SERVICE_PATH, 'utf-8'))
    expect(pauseIsGatedBeforeEscape(body)).toBe(true)
  })

  test('the gate rejects an unconditional Escape with no pause branch', () => {
    const body = `
      if (!this.pty.isAlive(id)) return 'no-terminal'
      this.pty.write(id, '\\x1b')
      return 'interrupted'
    `
    expect(pauseIsGatedBeforeEscape(body)).toBe(false)
  })

  test('the gate REJECTS a pause branch missing the attention check (half the union removed)', () => {
    const body = `
      if (!this.pty.isAlive(id)) return 'no-terminal'
      if (mode === 'pause') {
        if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
      }
      this.pty.write(id, '\\x1b')
      return 'interrupted'
    `
    expect(pauseIsGatedBeforeEscape(body)).toBe(false)
  })

  test('the gate rejects a pause branch missing rateLimited', () => {
    const body = `
      if (!this.pty.isAlive(id)) return 'no-terminal'
      if (mode === 'pause') {
        if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
        if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
      }
      this.pty.write(id, '\\x1b')
      return 'interrupted'
    `
    expect(pauseIsGatedBeforeEscape(body)).toBe(false)
  })

  test('the gate REJECTS a check placed AFTER the Escape write (too late to prevent it)', () => {
    const body = `
      if (!this.pty.isAlive(id)) return 'no-terminal'
      this.pty.write(id, '\\x1b')
      if (mode === 'pause') {
        if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
        if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
        if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
      }
      return 'interrupted'
    `
    expect(pauseIsGatedBeforeEscape(body)).toBe(false)
  })

  test('the gate ACCEPTS the fixed shape: all three signals checked inside the pause branch, before the Escape write', () => {
    const body = `
      if (!this.pty.isAlive(id)) return 'no-terminal'
      if (mode === 'pause') {
        const guard = this.screenGuard.inspect(id)
        if (guard.state === 'modal') return 'refused-modal'
        if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
        if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
      }
      this.pty.write(id, '\\x1b')
      return 'interrupted'
    `
    expect(pauseIsGatedBeforeEscape(body)).toBe(true)
  })

  /**
   * Stub of the slice of `this` interrupt() reads: pty.isAlive/write,
   * screenGuard.inspect, runtime.get. `writes` records every byte sent so
   * a refusal can also be checked to have written nothing.
   */
  function makeInterruptStub(
    opts: {
      screen?: { inspect(id: string): unknown }
      needsAttention?: boolean
      rateLimited?: boolean
    } = {}
  ) {
    const writes: string[] = []
    const self = {
      pty: {
        isAlive: () => true,
        write: (_id: string, data: string) => {
          writes.push(data)
          return true
        }
      },
      screenGuard: opts.screen ?? { inspect: () => ({ state: 'clear' as const }) },
      runtime: { get: () => ({ needsAttention: opts.needsAttention ?? false, rateLimited: opts.rateLimited ?? false }) }
    }
    return { self, writes }
  }

  test("the real extracted interrupt() body: on a MODAL tile, mode='pause' refuses and writes nothing, mode='hard' still writes the bare Escape", () => {
    const body = extractInterruptBody(readFileSync(SESSION_SERVICE_PATH, 'utf-8'))
    // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
    const interrupt = new Function('logInfo', 'id', 'mode', body) as (
      this: unknown,
      logInfo: (scope: string, message: string) => void,
      id: string,
      mode: 'pause' | 'hard'
    ) => string
    const logs: string[] = []
    const logInfo = (_scope: string, message: string) => logs.push(message)
    const hiddenScreenText = 'untrusted pause screen content'
    const screen = new ScreenGuard()
    screen.resize('tile-a', 120, 40)
    screen.feed('tile-a', `${String.fromCharCode(27)}[6;1H${String.fromCodePoint(0x276f)} 1. ${hiddenScreenText}`)

    const pauseCase = makeInterruptStub({ screen })
    expect(interrupt.call(pauseCase.self, logInfo, 'tile-a', 'pause')).toBe('refused-modal')
    expect(pauseCase.writes).toEqual([])
    expect(logs).toEqual(['pause interruption refused-modal for tile-a: screen guard picker at line 6'])
    expect(logs.join('\n')).not.toContain(hiddenScreenText)

    const hardCase = makeInterruptStub({ screen })
    expect(interrupt.call(hardCase.self, logInfo, 'tile-a', 'hard')).toBe('interrupted')
    expect(hardCase.writes).toEqual(['\x1b'])
  })

  test("the real extracted interrupt() body: a non-modal, non-attention, non-rateLimited tile interrupts cleanly under EITHER mode", () => {
    const body = extractInterruptBody(readFileSync(SESSION_SERVICE_PATH, 'utf-8'))
    // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
    const interrupt = new Function('logInfo', 'id', 'mode', body) as (
      this: unknown,
      logInfo: (scope: string, message: string) => void,
      id: string,
      mode: 'pause' | 'hard'
    ) => string
    const logInfo = () => undefined

    const pauseCase = makeInterruptStub()
    expect(interrupt.call(pauseCase.self, logInfo, 'tile-a', 'pause')).toBe('interrupted')
    expect(pauseCase.writes).toEqual(['\x1b'])
  })

  function extractInjectCommandGuardPrologue(src: string): string {
    const fnMatch = /async injectCommand\([^)]*\)[^{]*\{/.exec(src)
    if (!fnMatch) throw new Error('injectCommand() not found in tile-injector.ts -- has it been renamed?')
    const body = extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1)
    const escIdx = body.search(ESC_WRITE)
    if (escIdx === -1) {
      throw new Error("injectCommand()'s Escape write (`this.pty.write(id, '\\x1b')`) not found -- has its shape changed?")
    }
    return body.slice(0, escIdx)
  }

  function extractInterruptPauseBranch(src: string): string {
    const body = extractInterruptBody(src)
    const branchMatch = /mode\s*===\s*'pause'\s*\)\s*\{/.exec(body)
    if (!branchMatch) {
      throw new Error("interrupt()'s `mode === 'pause'` branch not found -- has it been restructured?")
    }
    return extractBracedBody(body, branchMatch.index + branchMatch[0].length - 1)
  }

  /**
   * Captures every distinct this.runtime.get(id)?.<field> read in the guard
   * region, whether or not it participates in a refusal decision -- an innocent
   * read used only for logging is indistinguishable here from a real signal.
   * The two regions do not share the same extent: the injectCommand prologue is
   * the whole body before the Escape write, while the interrupt(pause) region
   * is only the braced pause block, so an identical innocent read outside that
   * block is invisible on that side.
   * A red caused by a non-gating field is fixed by moving that read out of the
   * guarded region, never by adding a matching-but-unused read on the other
   * side to silence the test.
   */
  function extractGuardSignals(text: string): Set<string> {
    const signals = new Set<string>()
    const fieldRe = /this\.runtime\.get\(id\)\?\.(\w+)/g
    let m: RegExpExecArray | null
    while ((m = fieldRe.exec(text))) signals.add(m[1])
    if (/this\.screenGuard\.(?:inspect|classify)\(id\)/.test(text)) signals.add('screenGuard')
    return signals
  }

  test(
    "injectCommand's guard and interrupt()'s pause branch consult the exact SAME set of screen-state signals -- no hardcoded list on either side, and a one-sided addition is caught by set inequality (real file)",
    () => {
      const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
      const injectorSrc = readFileSync(join(SESSION_SERVICE_PATH, '..', 'tile-injector.ts'), 'utf-8')
      const injectSignals = extractGuardSignals(extractInjectCommandGuardPrologue(injectorSrc))
      const interruptSignals = extractGuardSignals(extractInterruptPauseBranch(src))

      const onlyInject = [...injectSignals].filter((s) => !interruptSignals.has(s)).sort()
      const onlyInterrupt = [...interruptSignals].filter((s) => !injectSignals.has(s)).sort()

      if (onlyInject.length > 0 || onlyInterrupt.length > 0) {
        throw new Error(
          `Signal sets diverged -- injectCommand-only: [${onlyInject.join(', ')}], interrupt(pause)-only: [${onlyInterrupt.join(', ')}]`
        )
      }
      expect(injectSignals).toContain('screenGuard')
      expect(interruptSignals).toContain('screenGuard')
      expect(injectSignals.size).toBeGreaterThanOrEqual(3)
    }
  )

  test('the equality check rejects a signal present on only one side', () => {
    const withExtra = extractGuardSignals(`
      if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
      if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
      if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
      if (this.runtime.get(id)?.sandboxPaused) return 'refused-modal'
    `)
    const withoutExtra = extractGuardSignals(`
      if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
      if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
      if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
    `)
    const onlyLeft = [...withExtra].filter((s) => !withoutExtra.has(s))
    expect(onlyLeft).toEqual(['sandboxPaused'])
  })
})

// ----- Card 120148eb, second half: broadcastStop must actually FORWARD its
// own `mode` into deps.interrupt so the real SessionService.interrupt can
// tell pause from hard -- a dispatch that dropped the argument would compile
// (interrupt(id) is still callable with an extra unused arg) while silently
// leaving both modes ungated in production. agent-stop.ts is a pure module
// (no electron/node-pty import, per its own header comment), so this is a
// real behavioural test against the actual broadcastStop, not a source scan.

describe('broadcastStop forwards mode into deps.interrupt (card 120148eb)', () => {
  test("pause and hard each call deps.interrupt with their OWN mode, not a shared/hardcoded one", async () => {
    const { broadcastStop } = await import('../desktop/src/main/agent-stop.ts')
    const calls: Array<{ id: string; mode: string }> = []
    const deps = {
      list: () => [{ id: 'a', peerId: 'peer-a', status: 'running' as const }],
      interrupt: (id: string, mode: string) => {
        calls.push({ id, mode })
        return 'interrupted' as const
      },
      injectCommand: async () => 'written' as const,
      journal: () => {}
    }
    await broadcastStop('pause', deps as never)
    await broadcastStop('hard', deps as never)
    expect(calls).toEqual([
      { id: 'a', mode: 'pause' },
      { id: 'a', mode: 'hard' }
    ])
  })

  test("a 'refused-modal' from deps.interrupt reaches StopOutcome.result unchanged (the honest-tally path the card requires, not a silent skip)", async () => {
    const { broadcastStop } = await import('../desktop/src/main/agent-stop.ts')
    const deps = {
      list: () => [{ id: 'a', peerId: 'peer-a', status: 'running' as const }],
      interrupt: () => 'refused-modal' as const,
      injectCommand: async () => 'written' as const,
      journal: () => {}
    }
    const { outcomes } = await broadcastStop('pause', deps as never)
    expect(outcomes).toEqual([{ id: 'a', peerId: 'peer-a', result: 'refused-modal' }])
  })
})
