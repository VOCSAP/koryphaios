import { expect, test } from 'bun:test'
import { runMagicCompactInTurn, type MagicCompactHost } from '../desktop/src/main/magic-compact-sequence.ts'
import { TileInjector } from '../desktop/src/main/tile-injector.ts'

const RESUME_ID = '0f0e0d0c-0b0a-4090-8070-605040302010'

/** A real TileInjector as host, a fake terminal, and a banner the test releases by hand. */
function fixture(banner: string | null) {
  const writes: string[] = []
  const injector = new TileInjector(
    {
      isAlive: () => true,
      write: (_id, data) => {
        writes.push(data === '\x1b' ? 'ESC' : (/\/(magic-compact|compact|resume|clear)/.exec(data)?.[0] ?? data))
        return true
      }
    },
    { inspect: () => ({ state: 'clear' as const }), classify: () => 'clear' },
    { get: () => ({}) },
    () => null,
    { activityIdleMs: 500, settleMs: 5, idlePollMs: 5 },
    () => {}
  )
  let showBanner!: () => void
  const bannerShown = new Promise<void>((resolve) => {
    showBanner = resolve
  })
  const host: MagicCompactHost = {
    serializeTile: (id, fn) => injector.serializeTile(id, fn),
    waitForOutput: async (_id, _timeoutMs, scan) => {
      await bannerShown
      return banner === null ? null : scan(banner)
    }
  }
  const journal: string[] = []
  return { injector, host, writes, journal, showBanner }
}

function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms))])
}

test('a banner re-enters the compacted session and the outcome is the /resume write', async () => {
  const f = fixture(`Run this to enter the compacted session:\n  /resume ${RESUME_ID}`)
  const run = runMagicCompactInTurn(f.host, (line) => f.journal.push(line), 't1', 'alpha', true, 'auto')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const directive = f.injector.inTurn('t1', () => f.injector.injectCommand('t1', '/clear'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(f.writes, 'nothing may reach the tile between /magic-compact and /resume').toEqual(['ESC', '/magic-compact'])
  f.showBanner()
  expect(await withinMs(run, 1_000, 'the magic_compact sequence')).toBe('written')
  expect(await withinMs(directive, 1_000, 'the directive queued behind it')).toBe('written')
  expect(f.writes).toEqual(['ESC', '/magic-compact', 'ESC', '/resume', 'ESC', '/clear'])
  expect(f.journal).toEqual([`magic_compact -> "alpha": compacted, re-entered ${RESUME_ID.slice(0, 8)} (written)`])
})

test('no banner falls back to /compact inside the same turn', async () => {
  const f = fixture(null)
  const run = runMagicCompactInTurn(f.host, (line) => f.journal.push(line), 't1', 'alpha', true, 'auto')
  f.showBanner()
  expect(await withinMs(run, 1_000, 'the magic_compact sequence')).toBe('written')
  expect(f.writes).toEqual(['ESC', '/magic-compact', 'ESC', '/compact'])
  expect(f.journal).toEqual(['magic_compact -> "alpha": no banner within timeout, fell back to /compact (written)'])
})

test('without the plugin it is one /compact, and its outcome is returned', async () => {
  const f = fixture(null)
  expect(await withinMs(runMagicCompactInTurn(f.host, (line) => f.journal.push(line), 't1', 'alpha', false, 'off'), 1_000, 'plain /compact')).toBe('written')
  expect(f.writes).toEqual(['ESC', '/compact'])
  expect(f.journal).toEqual(['magic_compact -> "alpha": disabled, used /compact (written)'])
})
