import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Vague 10 A2-1 follow-up (cards 5dbf3255/63ca372f), team-lead blocker: the
// new SessionService.injectCommand outcome 'refused-modal' reaches the
// operator-facing stop report (AgentStopControls.tsx -> StopOutcome.result,
// shared/types.ts) but the four EXISTING filters (interrupted/transmitted/
// stragglers/unreachable) match none of it -- a screen-guard refusal was
// silently absent from both the tally and the hard-stop escalation offer.
// spec_dba4d63f.
//
// AgentStopControls.tsx pulls in React and sibling renderer components
// (icons.tsx, ConfirmDialog.tsx) that this repo does not import cleanly
// under `bun test` (no bundler/CSS loader here, same constraint BUN.md
// documents for main-process modules that touch electron/node-pty). The
// five filter functions this file checks are plain, unexported one-liners,
// so this test extracts each PREDICATE from the real file text and actually
// EVALUATES it (not just pattern-matches its shape) against synthetic
// StopOutcome objects -- real behavioural proof of the negative control
// team-lead asked for, without needing the module to import.

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

// ----- Card 120148eb: SessionService.interrupt() gates Pause (not Hard) on
// the same screen-state guard injectCommand uses. Source-scan of the real
// file (SessionService isn't bun-test-importable, same constraint as
// desktop-inject-command-modal-guard.test.ts), plus a RED-proof against
// synthetic bodies, same convention as that file.

describe("SessionService.interrupt()'s pause-only screen-state gate (card 120148eb)", () => {
  const SESSION_SERVICE_PATH = join(
    import.meta.dir,
    '..',
    'desktop',
    'src',
    'main',
    'session-service.ts'
  )

  function extractBracedBody(src: string, openIdx: number): string {
    let depth = 1
    let i = openIdx + 1
    while (depth > 0 && i < src.length) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    if (depth !== 0) {
      throw new Error(
        `extractBracedBody: brace block starting at "${src.slice(Math.max(0, openIdx - 60), openIdx + 1)}" never closed -- source truncated, renamed, or reshaped?`
      )
    }
    return src.slice(openIdx + 1, i - 1)
  }

  function extractInterruptBody(src: string): string {
    const fnMatch = /interrupt\(id: string, mode:[^)]*\)[^{]*\{/.exec(src)
    if (!fnMatch) throw new Error('interrupt(id, mode) not found in session-service.ts -- has it been renamed?')
    return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1)
  }

  const ESC_WRITE = /this\.pty\.write\(id,\s*'\\x1b'\)/
  const PAUSE_BRANCH = /mode\s*===\s*'pause'/
  const SCREEN_GUARD_CHECK = /this\.screenGuard\.classify\(id\)\s*===\s*'modal'/
  const ATTENTION_CHECK = /this\.runtime\.get\(id\)\?\.needsAttention/
  // Third signal (mutation review round 2, D1): same as injectCommand's own
  // three-signal union -- without it, Pause during a quota-resume window
  // races autoResume's own raw ESC write on the same tile.
  const RATE_LIMITED_CHECK = /this\.runtime\.get\(id\)\?\.rateLimited/
  const REFUSAL_RETURN = /return\s+'refused-modal'/g

  /**
   * All three signals must be checked INSIDE a `mode === 'pause'` branch,
   * and each check must return the refusal BEFORE the Escape write --
   * exactly the injectCommand convention, applied here to interrupt(). A
   * body that gates unconditionally (no pause branch at all) would also
   * gate Hard, which the card explicitly says NOT to do -- so
   * PAUSE_BRANCH.test is required, not just the three signal checks.
   */
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

  test("the gate REJECTS the pre-120148eb shape: unconditional bare Escape, no pause branch at all", () => {
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

  test('the gate REJECTS a pause branch with screenGuard and attention but missing rateLimited (the exact D1 gap)', () => {
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
        if (this.screenGuard.classify(id) === 'modal') return 'refused-modal'
        if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
        if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
      }
      this.pty.write(id, '\\x1b')
      return 'interrupted'
    `
    expect(pauseIsGatedBeforeEscape(body)).toBe(true)
  })

  // ----- D6 (mutation review round 2): the pause-vs-hard asymmetry itself,
  // pinned BEHAVIORALLY, not just by shape. The extracted body is executed
  // for real (new Function + a stub `this`), against a MODAL-classified
  // tile: pause must refuse, hard must not. A regex on the source text
  // could not tell "gates neither" from "gates both" apart from "gates only
  // pause" without re-deriving the same logic a second time; actually
  // EXECUTING the real extracted code against both modes can.

  /**
   * Stub of the slice of `this` interrupt() reads: pty.isAlive/write,
   * screenGuard.classify, runtime.get. `writes` records every byte sent so
   * a refusal can also be checked to have written nothing.
   */
  function makeInterruptStub(opts: { classify?: 'clear' | 'modal'; needsAttention?: boolean; rateLimited?: boolean } = {}) {
    const writes: string[] = []
    const self = {
      pty: {
        isAlive: () => true,
        write: (_id: string, data: string) => {
          writes.push(data)
          return true
        }
      },
      screenGuard: { classify: () => opts.classify ?? 'clear' },
      runtime: { get: () => ({ needsAttention: opts.needsAttention ?? false, rateLimited: opts.rateLimited ?? false }) }
    }
    return { self, writes }
  }

  test("the real extracted interrupt() body: on a MODAL tile, mode='pause' refuses and writes nothing, mode='hard' still writes the bare Escape", () => {
    const body = extractInterruptBody(readFileSync(SESSION_SERVICE_PATH, 'utf-8'))
    // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
    const interrupt = new Function('id', 'mode', body) as (
      this: unknown,
      id: string,
      mode: 'pause' | 'hard'
    ) => string

    const pauseCase = makeInterruptStub({ classify: 'modal' })
    expect(interrupt.call(pauseCase.self, 'tile-a', 'pause')).toBe('refused-modal')
    expect(pauseCase.writes).toEqual([])

    const hardCase = makeInterruptStub({ classify: 'modal' })
    expect(interrupt.call(hardCase.self, 'tile-a', 'hard')).toBe('interrupted')
    expect(hardCase.writes).toEqual(['\x1b'])
  })

  test("the real extracted interrupt() body: a non-modal, non-attention, non-rateLimited tile interrupts cleanly under EITHER mode", () => {
    const body = extractInterruptBody(readFileSync(SESSION_SERVICE_PATH, 'utf-8'))
    // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
    const interrupt = new Function('id', 'mode', body) as (
      this: unknown,
      id: string,
      mode: 'pause' | 'hard'
    ) => string

    const pauseCase = makeInterruptStub({ classify: 'clear' })
    expect(interrupt.call(pauseCase.self, 'tile-a', 'pause')).toBe('interrupted')
    expect(pauseCase.writes).toEqual(['\x1b'])
  })

  // ----- Third mutation review round: the two unions (injectCommand's guard
  // prologue, interrupt()'s `mode === 'pause'` branch) are identical TODAY,
  // but each was pinned by its OWN hard-coded list of exactly three signal
  // names -- a fourth signal added to only ONE side left both lists
  // individually satisfied (reviewer's measured mutation: 69 pass/0 fail).
  // This derives the signal SET from each side generically (any
  // `this.runtime.get(id)?.<field>`, plus screenGuard.classify), with no
  // hardcoded field list, so it grows automatically with the domain and
  // catches a one-sided addition by set inequality instead of by name.

  function extractInjectCommandGuardPrologue(src: string): string {
    const fnMatch = /async injectCommand\([^)]*\)[^{]*\{/.exec(src)
    if (!fnMatch) throw new Error('injectCommand() not found in session-service.ts -- has it been renamed?')
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
   * The set of screen-state signals a guard region consults: every distinct
   * `this.runtime.get(id)?.<field>` name (generic capture, not a fixed
   * list -- adding a signal named anything grows this set automatically),
   * plus a fixed marker for the geometric `screenGuard.classify(id) ===
   * 'modal'` check (that one is a single, unnamed boolean read, not a
   * family of possible field names, so it has no field name to capture --
   * its own literal presence/absence IS the signal).
   *
   * MEASURED maintenance trap (mutation review round 3), read before adding
   * a `this.runtime.get(id)?.X` read near either guard: this derivation
   * captures EVERY such read in the region, whether or not it participates
   * in a refusal decision -- an innocent, non-gating read (e.g. `const
   * tileName = this.runtime.get(id)?.name` used only for a log line) is
   * indistinguishable here from a real signal, and makes the equality test
   * below fail. Worse, the two regions do NOT share the same extent:
   * `extractInjectCommandGuardPrologue` returns the WHOLE body before the
   * Escape write (`body.slice(0, escIdx)`), so any such read ANYWHERE in
   * that prologue is caught, while `extractInterruptPauseBranch` returns
   * ONLY the braced `mode === 'pause'` block, so the identical innocent
   * read placed in `interrupt()` OUTSIDE that branch is invisible to this
   * derivation entirely -- fatal on one side, silent on the other, by a
   * boundary this comment is the only place that names it. The correct fix
   * for a red caused by a non-gating field is to move that read OUT of the
   * guarded region (before the prologue, or outside the pause branch),
   * NEVER to add a matching-but-unused read on the other side just to
   * silence the test -- that would fabricate a fake signal to quiet a real
   * one, which is worse than the false red it "fixes".
   */
  function extractGuardSignals(text: string): Set<string> {
    const signals = new Set<string>()
    const fieldRe = /this\.runtime\.get\(id\)\?\.(\w+)/g
    let m: RegExpExecArray | null
    while ((m = fieldRe.exec(text))) signals.add(m[1])
    if (/this\.screenGuard\.classify\(id\)\s*===\s*'modal'/.test(text)) signals.add('screenGuard.classify()===modal')
    return signals
  }

  test(
    "injectCommand's guard and interrupt()'s pause branch consult the exact SAME set of screen-state signals -- no hardcoded list on either side, and a one-sided addition is caught by set inequality (real file)",
    () => {
      const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
      const injectSignals = extractGuardSignals(extractInjectCommandGuardPrologue(src))
      const interruptSignals = extractGuardSignals(extractInterruptPauseBranch(src))

      const onlyInject = [...injectSignals].filter((s) => !interruptSignals.has(s)).sort()
      const onlyInterrupt = [...interruptSignals].filter((s) => !injectSignals.has(s)).sort()

      if (onlyInject.length > 0 || onlyInterrupt.length > 0) {
        throw new Error(
          `Signal sets diverged -- injectCommand-only: [${onlyInject.join(', ')}], interrupt(pause)-only: [${onlyInterrupt.join(', ')}]`
        )
      }
      // Anti-vacuity: two EMPTY sets would also satisfy "equal" above, which
      // would make this test pass on a body that no longer checks anything
      // at all. A floor (not a fixed list -- no field name is hardcoded)
      // rules that degenerate case out.
      expect(injectSignals.size).toBeGreaterThanOrEqual(2)
    }
  )

  test('the equality check REJECTS a synthetic divergence: a signal present on only one side (the exact shape of the reviewer\'s measured mutation) is named in the failure', () => {
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
    expect(onlyLeft).toEqual(['sandboxPaused']) // proves the derivation is live and names the extra signal
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
