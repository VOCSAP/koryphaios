// Card aaf4537d lot 3: multi-tile stop broadcast (Pause/Soft/Hard). Pure module,
// no electron/node-pty -- broadcastStop is exercised against a fake StopDeps.

import { test, expect } from 'bun:test'
import {
  broadcastStop,
  lockTargets,
  SOFT_STOP_MESSAGE,
  STOP_MODES,
  stopTouchesLocks,
  type StopDeps,
  type StopOutcome
} from '../desktop/src/main/agent-stop.ts'
import type { SessionRuntime } from '../desktop/src/shared/types'

function tile(over: Partial<SessionRuntime>): SessionRuntime {
  return {
    id: over.id ?? 'tile-x',
    peerId: over.peerId ?? null,
    status: over.status ?? 'running',
    ...over
  } as SessionRuntime
}

function fakeDeps(overrides: Partial<StopDeps> = {}): StopDeps {
  return {
    list: () => [
      tile({ id: 'a', peerId: 'peer-a' }),
      tile({ id: 'b', peerId: 'peer-b' }),
      tile({ id: 'c', peerId: null })
    ],
    interrupt: () => 'interrupted',
    injectCommand: async () => 'written',
    journal: () => {},
    ...overrides
  }
}

test('STOP_MODES is exactly pause/soft/hard', () => {
  expect(STOP_MODES).toEqual(['pause', 'soft', 'hard'])
})

test('SOFT_STOP_MESSAGE is a single line -- injectCommand submits via a separate \\r write, so an embedded newline would submit/truncate early', () => {
  expect(SOFT_STOP_MESSAGE).not.toContain('\n')
  expect(SOFT_STOP_MESSAGE).not.toContain('\r')
})

test('empty tile list yields an empty outcome vector, not an error', async () => {
  const deps = fakeDeps({ list: () => [] })
  const { outcomes, missing } = await broadcastStop('pause', deps)
  expect(outcomes).toEqual([])
  expect(missing).toEqual([])
})

test('pause/hard call interrupt per tile, not injectCommand', async () => {
  let injected = 0
  const deps = fakeDeps({ injectCommand: async () => { injected++; return 'written' } })
  const { outcomes } = await broadcastStop('hard', deps)
  expect(injected).toBe(0)
  expect(outcomes).toEqual([
    { id: 'a', peerId: 'peer-a', result: 'interrupted' },
    { id: 'b', peerId: 'peer-b', result: 'interrupted' },
    { id: 'c', peerId: null, result: 'interrupted' }
  ])
})

test('soft calls injectCommand with SOFT_STOP_MESSAGE per tile, not interrupt', async () => {
  let interrupted = 0
  const sentTo: string[] = []
  const deps = fakeDeps({
    interrupt: () => { interrupted++; return 'interrupted' },
    injectCommand: async (id, command) => {
      expect(command).toBe(SOFT_STOP_MESSAGE)
      sentTo.push(id)
      return 'written'
    }
  })
  const { outcomes } = await broadcastStop('soft', deps)
  expect(interrupted).toBe(0)
  expect(sentTo).toEqual(['a', 'b', 'c'])
  expect(outcomes.every((o) => o.result === 'written')).toBe(true)
})

test('one tile throwing does not block the others -- Promise.allSettled semantics, mapped to result: error', async () => {
  const deps = fakeDeps({
    injectCommand: async (id) => {
      if (id === 'b') throw new Error('pty write failed')
      return 'written'
    }
  })
  const { outcomes } = await broadcastStop('soft', deps)
  const byId = new Map(outcomes.map((o) => [o.id, o] as const))
  expect(byId.get('a')?.result).toBe('written')
  expect(byId.get('b')?.result).toBe('error')
  expect(byId.get('c')?.result).toBe('written')
})

test('a rejected target is still journaled with its peerId, not silently dropped', async () => {
  const lines: string[] = []
  const deps = fakeDeps({
    journal: (line) => lines.push(line),
    interrupt: (id) => {
      if (id === 'a') throw new Error('boom')
      return 'interrupted'
    }
  })
  const { outcomes } = await broadcastStop('pause', deps)
  expect(outcomes.find((o) => o.id === 'a')).toEqual({ id: 'a', peerId: 'peer-a', result: 'error' })
  expect(lines.some((l) => l.includes('peer-a') && l.includes('boom'))).toBe(true)
})

test('a fulfilled target is journaled too, not just rejected ones -- per-target audit trail matches executeDirective\'s template', async () => {
  const lines: string[] = []
  const deps = fakeDeps({ journal: (line) => lines.push(line) })
  await broadcastStop('hard', deps)
  expect(lines.some((l) => l.includes('peer-a') && l.includes('interrupted'))).toBe(true)
  expect(lines.some((l) => l.includes('peer-b') && l.includes('interrupted'))).toBe(true)
})

// ----- peerIds subset (aaf4537d lot 3 amendment: escalate-only-the-stragglers) -----

test('peerIds absent targets every live tile', async () => {
  const touched: string[] = []
  const deps = fakeDeps({ interrupt: (id) => { touched.push(id); return 'interrupted' } })
  await broadcastStop('hard', deps)
  expect(touched).toEqual(['a', 'b', 'c'])
})

test('peerIds absent excludes exited tiles (review round, correction 3)', async () => {
  const touched: string[] = []
  const deps = fakeDeps({
    list: () => [
      tile({ id: 'a', peerId: 'peer-a', status: 'running' }),
      tile({ id: 'dead', peerId: 'peer-dead', status: 'exited' })
    ],
    interrupt: (id) => { touched.push(id); return 'interrupted' }
  })
  const { outcomes } = await broadcastStop('hard', deps)
  expect(touched).toEqual(['a'])
  expect(outcomes.map((o) => o.id)).toEqual(['a'])
})

test('peerIds present-and-non-empty targets only that subset, leaving the rest untouched', async () => {
  const touched: string[] = []
  const deps = fakeDeps({ interrupt: (id) => { touched.push(id); return 'interrupted' } })
  const { outcomes } = await broadcastStop('hard', deps, ['peer-b'])
  expect(touched).toEqual(['b'])
  expect(outcomes).toEqual([{ id: 'b', peerId: 'peer-b', result: 'interrupted' }])
})

test('peerIds present-and-EMPTY is refused, never silently treated as "everyone"', async () => {
  const deps = fakeDeps()
  await expect(broadcastStop('hard', deps, [])).rejects.toThrow(/non-empty/)
})

test('a peerId with no matching live tile surfaces in `missing`, not silently dropped (review round, correction 4)', async () => {
  const lines: string[] = []
  const deps = fakeDeps({ journal: (line) => lines.push(line) })
  const { outcomes, missing } = await broadcastStop('hard', deps, ['peer-ghost'])
  expect(outcomes).toEqual([])
  expect(missing).toEqual(['peer-ghost'])
  expect(lines.some((l) => l.includes('peer-ghost') && l.includes('not reachable'))).toBe(true)
})

test('a tile with a null peerId can never be matched by a peerIds subset (review round, correction 6)', async () => {
  const deps = fakeDeps()
  // 'c' has peerId: null in fakeDeps. Casting a literal `null` through the
  // string[] param (a plausible fuzzed/stale-renderer value) is the version
  // that actually exercises the match-by-peerId path -- the prior version
  // compared the STRING 'null' against the null tile, which stays false
  // whether or not any guard exists (vacuous, caught in review). This one
  // goes red if peerId:null tiles were ever made matchable: 'c' would then
  // show up in outcomes instead of staying absent.
  const { outcomes, missing } = await broadcastStop('hard', deps, ['peer-a', null as unknown as string])
  expect(outcomes).toEqual([{ id: 'a', peerId: 'peer-a', result: 'interrupted' }])
  // The non-string element never reaches resolveDirectiveTargets (which would
  // throw on `null.trim()`) -- broadcastStop's own boundary guard reports it
  // in `missing` instead, same as any other unreachable peerId.
  expect(missing).toEqual(['null'])
})

test('peerIds present trims whitespace, dedupes, and rejects malformed charset via resolveDirectiveTargets (review round, correction 2)', async () => {
  const touched: string[] = []
  const deps = fakeDeps({ interrupt: (id) => { touched.push(id); return 'interrupted' } })
  const { outcomes, missing } = await broadcastStop('hard', deps, [' peer-a ', 'peer-a', 'Not Valid!'])
  expect(touched).toEqual(['a'])
  expect(outcomes).toEqual([{ id: 'a', peerId: 'peer-a', result: 'interrupted' }])
  expect(missing).toEqual(['Not Valid!'])
})

test('mixed outcome vector preserves tile identity (id + peerId) alongside result', async () => {
  const deps = fakeDeps({
    injectCommand: async (id) => (id === 'c' ? 'busy-timeout' : 'written')
  })
  const { outcomes }: { outcomes: StopOutcome[] } = await broadcastStop('soft', deps)
  expect(outcomes).toEqual([
    { id: 'a', peerId: 'peer-a', result: 'written' },
    { id: 'b', peerId: 'peer-b', result: 'written' },
    { id: 'c', peerId: null, result: 'busy-timeout' }
  ])
})

// ----- lockTargets / stopTouchesLocks (review round, correction 1) -----

test('stopTouchesLocks is true for pause/hard, false for soft', () => {
  expect(stopTouchesLocks('pause')).toBe(true)
  expect(stopTouchesLocks('hard')).toBe(true)
  expect(stopTouchesLocks('soft')).toBe(false)
})

test('lockTargets derives peer_ids from outcomes, deduped, nulls dropped', () => {
  const outcomes: StopOutcome[] = [
    { id: 'a', peerId: 'peer-a', result: 'interrupted' },
    { id: 'b', peerId: 'peer-a', result: 'interrupted' },
    { id: 'c', peerId: null, result: 'interrupted' }
  ]
  expect(lockTargets(outcomes)).toEqual(['peer-a'])
})

test('lockTargets ignores tiles never dispatched to -- reading service.list() instead of outcomes would over-target (review round, N4)', () => {
  // Simulates: 3 agents actually interrupted (outcomes), but a hypothetical
  // caller deriving peer_ids from the full live tile set would also lock-park
  // a 4th, untouched peer's card. lockTargets must never see that 4th peer at
  // all, since it only ever reads `outcomes`.
  const outcomes: StopOutcome[] = [{ id: 'a', peerId: 'peer-a', result: 'interrupted' }]
  expect(lockTargets(outcomes)).toEqual(['peer-a'])
})
