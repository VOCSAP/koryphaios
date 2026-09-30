import { expect, test } from 'bun:test'
import { TileInjector, type InjectorScreen } from '../desktop/src/main/tile-injector.ts'
import { DIRECTIVE_IDLE_WAIT_MS } from '../desktop/src/main/directive-run.ts'
import { ScreenGuard, type InjectGuardState } from '../desktop/src/main/screen-model.ts'

const ESC = '\x1b'

function fixture(
  options: {
    classify?: InjectGuardState
    screen?: InjectorScreen
    runtime?: { needsAttention?: boolean; rateLimited?: boolean }
    lastOutputAt?: number | null
    turnCeilingMs?: number
  } = {}
) {
  const writes: string[] = []
  const reports: string[] = []
  const logs: string[] = []
  const alive = new Set(['t1'])
  const injector = new TileInjector(
    {
      isAlive: (id) => alive.has(id),
      write: (id, data) => {
        if (!alive.has(id)) return false
        writes.push(data === ESC ? 'ESC' : data)
        return true
      }
    },
    options.screen ?? {
      classify: () => options.classify ?? 'clear',
      inspect: () => (options.classify === 'modal' ? { state: 'modal', rule: 'composer-geometry' } : { state: 'clear' })
    },
    { get: (id) => (alive.has(id) ? options.runtime ?? {} : undefined) },
    () => options.lastOutputAt ?? null,
    { activityIdleMs: 500, settleMs: 5, idlePollMs: 5, ...(options.turnCeilingMs ? { turnCeilingMs: options.turnCeilingMs } : {}) },
    (message) => reports.push(message),
    (_scope, message) => logs.push(message)
  )
  return { injector, writes, reports, logs, alive }
}

/** The command text as written, whatever the bracketed-paste wrapping. */
const commands = (writes: string[]) => writes.map((w) => (w === 'ESC' ? 'ESC' : w.includes('/compact') ? '/compact' : w.includes('/clear') ? '/clear' : w.includes('/resume') ? '/resume' : w.includes('/magic-compact') ? '/magic-compact' : w))

function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms))])
}

test('a screen guard modal refusal logs its rule and line without rendered screen text', async () => {
  const hiddenScreenText = 'untrusted screen content'
  const screen = new ScreenGuard()
  screen.resize('t1', 120, 40)
  screen.feed('t1', `${ESC}[6;1H${String.fromCodePoint(0x276f)} 1. ${hiddenScreenText}`)
  const { injector, writes, logs } = fixture({ screen })

  expect(await injector.injectCommand('t1', '/clear')).toBe('refused-modal')
  expect(writes).toEqual([])
  expect(logs).toEqual(['command injection refused-modal for t1: screen guard picker at line 6'])
  expect(logs.join('\n')).not.toContain(hiddenScreenText)
})

test('two injections outside of any turn interleave their Escape and command writes', async () => {
  const { injector, writes } = fixture()
  await Promise.all([injector.injectCommand('t1', '/compact'), injector.injectCommand('t1', '/clear')])
  expect(commands(writes)).toEqual(['ESC', 'ESC', '/compact', '/clear'])
})

test('two directives on the same tile take turns: one Escape and command at a time', async () => {
  const { injector, writes } = fixture()
  const outcomes = await withinMs(
    Promise.all([
      injector.inTurn('t1', () => injector.injectCommand('t1', '/compact')),
      injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))
    ]),
    1_000,
    'the earlier turn never released'
  )
  expect(outcomes).toEqual(['written', 'written'])
  expect(commands(writes)).toEqual(['ESC', '/compact', 'ESC', '/clear'])
})

test('a turn that fails does not block the next one', async () => {
  const { injector, writes } = fixture()
  const failed = injector.inTurn('t1', () => Promise.reject(new Error('boom')))
  const next = injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))
  await expect(failed).rejects.toThrow('boom')
  expect(await withinMs(next, 1_000, 'the earlier turn never released')).toBe('written')
  expect(commands(writes)).toEqual(['ESC', '/clear'])
})

test('a directive queued during a magic_compact sequence is written only after the sequence ends', async () => {
  const { injector, writes } = fixture()
  let bannerSeen!: () => void
  const banner = new Promise<void>((resolve) => {
    bannerSeen = resolve
  })
  const magic = injector.serializeTile('t1', async (inject) => {
    expect(await inject('/magic-compact')).toBe('written')
    await banner
    return inject('/resume 0000')
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const directive = injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(commands(writes), 'nothing may reach the tile between /magic-compact and /resume').toEqual(['ESC', '/magic-compact'])
  bannerSeen()
  expect(await withinMs(magic, 1_000, 'the magic_compact sequence')).toBe('written')
  expect(await withinMs(directive, 1_000, 'the earlier turn never released')).toBe('written')
  expect(commands(writes)).toEqual(['ESC', '/magic-compact', 'ESC', '/resume', 'ESC', '/clear'])
})

test('a turn that never settles releases its tile at the ceiling, traced with the tile it held', async () => {
  const { injector, writes, reports } = fixture({ turnCeilingMs: 50 })
  void injector.inTurn('t1', () => new Promise(() => {}))
  const next = injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))
  expect(await withinMs(next, 1_000, 'the turn queued behind a stuck one')).toBe('written')
  expect(commands(writes)).toEqual(['ESC', '/clear'])
  expect(reports).toEqual(['injection turn of tile t1 still running after 50 ms; its queue is released'])
})

test('a turn that ends before the ceiling leaves no trace', async () => {
  const { injector, reports } = fixture({ turnCeilingMs: 50 })
  expect(await injector.inTurn('t1', () => injector.injectCommand('t1', '/clear'))).toBe('written')
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(reports).toEqual([])
})

test('an injection inside a sequence waits for idleness no longer than the turn ceiling is sized on', async () => {
  const { injector } = fixture()
  const idleWaits: number[] = []
  injector.injectCommand = async (_id, _command, idleWaitMs) => {
    idleWaits.push(idleWaitMs ?? -1)
    return 'written'
  }
  await withinMs(
    injector.serializeTile('t1', async (inject) => {
      await inject('/compact', 10 * DIRECTIVE_IDLE_WAIT_MS)
      await inject('/compact', 1_000)
      return inject('/compact')
    }),
    1_000,
    'the sequence'
  )
  expect(idleWaits).toEqual([DIRECTIVE_IDLE_WAIT_MS, 1_000, DIRECTIVE_IDLE_WAIT_MS])
})

test('an injection inside a sequence never waits for another turn of its own tile', async () => {
  const { injector } = fixture()
  const outcome = injector.serializeTile('t1', (inject) => inject('/compact'))
  expect(await withinMs(outcome, 1_000, 'an injection inside serializeTile')).toBe('written')
})

test('each refusal writes nothing and names its outcome', async () => {
  for (const [options, expected] of [
    [{ classify: 'modal' as const }, 'refused-modal'],
    [{ runtime: { needsAttention: true } }, 'refused-modal'],
    [{ runtime: { rateLimited: true } }, 'refused-modal'],
    [{ lastOutputAt: Date.now() + 60_000 }, 'busy-timeout']
  ] as const) {
    const { injector, writes } = fixture(options)
    expect(await injector.injectCommand('t1', '/compact', 20), JSON.stringify(options)).toBe(expected)
    expect(writes, JSON.stringify(options)).toEqual([])
  }
  const gone = fixture()
  gone.alive.clear()
  expect(await gone.injector.injectCommand('t1', '/compact')).toBe('no-terminal')
})
