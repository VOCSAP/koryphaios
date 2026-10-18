import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractBracedBody } from './_braced-body'
import { inspectInjectGuard } from '../desktop/src/main/xterm-screen.ts'

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

function extractPredicate(src: string, fnName: string): (o: { result: string }) => boolean {
  const re = new RegExp(
    `function ${fnName}\\(r: StopReport\\): StopOutcome\\[\\] \\{\\s*return r\\.outcomes\\.filter\\(\\(o\\) => (.+)\\)\\s*\\n\\s*\\}`
  )
  const m = re.exec(src)
  if (!m) throw new Error(`${fnName}(): shape changed, could not extract its filter predicate`)
  return new Function('o', `return (${m[1]})`) as (o: { result: string }) => boolean
}

const RESULT_VALUES = ['interrupted', 'written', 'busy-timeout', 'no-terminal', 'error', 'refused-modal'] as const

describe("refused modal outcomes", () => {
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

  test("other outcome filters do not absorb refused-modal", () => {
    expect(filters.interrupted({ result: 'refused-modal' })).toBe(false)
    expect(filters.transmitted({ result: 'refused-modal' })).toBe(false)
    expect(filters.stragglers({ result: 'refused-modal' })).toBe(false)
    expect(filters.unreachable({ result: 'refused-modal' })).toBe(false)
  })

  test('every filter matches only its own outcome', () => {
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

test("the filter extractor detects a stragglers filter that absorbs refused-modal", () => {
  const buggySrc = `
    function stragglers(r: StopReport): StopOutcome[] {
      return r.outcomes.filter((o) => o.result === 'busy-timeout' || o.result === 'refused-modal')
    }
  `
  const buggyStragglers = extractPredicate(buggySrc, 'stragglers')
  expect(buggyStragglers({ result: 'refused-modal' })).toBe(true)
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
  const SCREEN_GUARD_CHECK = /this\.screenGuard\.read\(id\)/
  const ATTENTION_CHECK = /this\.runtime\.get\(id\)\?\.needsAttention/
  const RATE_LIMITED_CHECK = /this\.runtime\.get\(id\)\?\.rateLimited/
  const REFUSAL_RETURN = /return\s+'refused-modal'/g

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

  test('interrupt pauses before Escape when screen-state signals are present', () => {
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

  test('the gate accepts all three pause signals before the Escape write', () => {
    const body = `
      if (!this.pty.isAlive(id)) return 'no-terminal'
      if (mode === 'pause') {
        const screen = this.screenGuard.read(id)
        if (screen.status === 'unavailable') return 'refused-modal'
        if (inspectInjectGuard(screen.snapshot).state === 'modal') return 'refused-modal'
        if (this.runtime.get(id)?.needsAttention) return 'refused-modal'
        if (this.runtime.get(id)?.rateLimited) return 'refused-modal'
      }
      this.pty.write(id, '\\x1b')
      return 'interrupted'
    `
    expect(pauseIsGatedBeforeEscape(body)).toBe(true)
  })

  function makeInterruptStub(
    opts: {
      screen?: { read(id: string): unknown }
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
      screenGuard: opts.screen ?? {
        read: () => ({
          status: 'ready' as const,
          snapshot: { revision: 1, cols: 3, rows: 3, lines: ['───', '❯', '───'], cursor: { x: 0, y: 1 } }
        })
      },
      runtime: { get: () => ({ needsAttention: opts.needsAttention ?? false, rateLimited: opts.rateLimited ?? false }) }
    }
    return { self, writes }
  }

  test("a modal tile refuses pause without writes and lets hard mode write Escape", () => {
    const body = extractInterruptBody(readFileSync(SESSION_SERVICE_PATH, 'utf-8'))
    const interrupt = new Function('logInfo', 'inspectInjectGuard', 'id', 'mode', body) as (
      this: unknown,
      logInfo: (scope: string, message: string) => void,
      guardFn: typeof inspectInjectGuard,
      id: string,
      mode: 'pause' | 'hard'
    ) => string
    const logs: string[] = []
    const logInfo = (_scope: string, message: string) => logs.push(message)
    const hiddenScreenText = 'untrusted pause screen content'
    const lines = Array<string>(40).fill('')
    lines[5] = `${String.fromCodePoint(0x276f)} 1. ${hiddenScreenText}`
    const screen = {
      read: () => ({
        status: 'ready' as const,
        snapshot: { revision: 1, cols: 120, rows: 40, lines, cursor: { x: 0, y: 5 } }
      })
    }

    const pauseCase = makeInterruptStub({ screen })
    expect(interrupt.call(pauseCase.self, logInfo, inspectInjectGuard, 'tile-a', 'pause')).toBe('refused-modal')
    expect(pauseCase.writes).toEqual([])
    expect(logs).toEqual(['pause interruption refused-modal for tile-a: screen guard picker at line 6'])
    expect(logs.join('\n')).not.toContain(hiddenScreenText)

    const hardCase = makeInterruptStub({ screen })
    expect(interrupt.call(hardCase.self, logInfo, inspectInjectGuard, 'tile-a', 'hard')).toBe('interrupted')
    expect(hardCase.writes).toEqual(['\x1b'])
  })

  test("an unavailable screen refuses pause without an Escape write", () => {
    const body = extractInterruptBody(readFileSync(SESSION_SERVICE_PATH, 'utf-8'))
    const interrupt = new Function('logInfo', 'inspectInjectGuard', 'id', 'mode', body) as (
      this: unknown,
      logInfo: (scope: string, message: string) => void,
      guardFn: typeof inspectInjectGuard,
      id: string,
      mode: 'pause' | 'hard'
    ) => string
    const logs: string[] = []
    const pauseCase = makeInterruptStub({ screen: { read: () => ({ status: 'unavailable' as const, reason: 'screen-fault' as const }) } })

    expect(interrupt.call(pauseCase.self, (_scope, message) => logs.push(message), inspectInjectGuard, 'tile-a', 'pause')).toBe(
      'refused-modal'
    )
    expect(pauseCase.writes).toEqual([])
    expect(logs).toEqual(['pause interruption refused-modal for tile-a: screen unavailable screen-fault'])
  })

  test("a clear tile interrupts under pause mode", () => {
    const body = extractInterruptBody(readFileSync(SESSION_SERVICE_PATH, 'utf-8'))
    const interrupt = new Function('logInfo', 'inspectInjectGuard', 'id', 'mode', body) as (
      this: unknown,
      logInfo: (scope: string, message: string) => void,
      guardFn: typeof inspectInjectGuard,
      id: string,
      mode: 'pause' | 'hard'
    ) => string
    const logInfo = () => undefined

    const pauseCase = makeInterruptStub()
    expect(interrupt.call(pauseCase.self, logInfo, inspectInjectGuard, 'tile-a', 'pause')).toBe('interrupted')
    expect(pauseCase.writes).toEqual(['\x1b'])
  })

  function extractInjectCommandGuardPrologue(src: string): string {
    const fnMatch = /private refusal\(id: string\): DirectiveOutcome \| null \{/.exec(src)
    if (!fnMatch) throw new Error('refusal() not found in tile-injector.ts -- has it been renamed?')
    return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1)
  }

  function extractInterruptPauseBranch(src: string): string {
    const body = extractInterruptBody(src)
    const branchMatch = /mode\s*===\s*'pause'\s*\)\s*\{/.exec(body)
    if (!branchMatch) {
      throw new Error("interrupt()'s `mode === 'pause'` branch not found -- has it been restructured?")
    }
    return extractBracedBody(body, branchMatch.index + branchMatch[0].length - 1)
  }

  function extractGuardSignals(text: string): Set<string> {
    const signals = new Set<string>()
    const fieldRe = /this\.runtime\.get\(id\)\?\.(\w+)/g
    let m: RegExpExecArray | null
    while ((m = fieldRe.exec(text))) signals.add(m[1]!)
    if (/this\.screenGuard\.read\(id\)/.test(text)) signals.add('screenGuard')
    return signals
  }

  test(
    "injectCommand and interrupt pause use the same screen-state signals",
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

describe('broadcastStop forwards mode into deps.interrupt', () => {
  test("pause and hard call deps.interrupt with their requested mode", async () => {
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

  test("a refused-modal interrupt result reaches StopOutcome.result unchanged", async () => {
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
