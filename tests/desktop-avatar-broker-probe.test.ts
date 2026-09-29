import { expect, test } from 'bun:test'
import {
  avatarBrokerProbeUrl,
  startAvatarBrokerProbe,
  type AvatarBrokerProbeOptions
} from '../desktop/src/main/avatar-broker-probe.ts'
import { AvatarState } from '../desktop/src/shared/avatar-state.ts'

const localBroker = 'http://127.0.0.1:7899'

interface ProbeCall {
  url: string
  signal: AbortSignal
  resolve(ok: boolean): void
}

function harness(brokerUrls: string[], overrides: Partial<AvatarBrokerProbeOptions> = {}) {
  const calls: ProbeCall[] = []
  const reachability: Array<[string, boolean]> = []
  const reports: string[] = []
  const infos: string[] = []
  const timeouts: Array<{ ms: number; fire(): void; cancelled: boolean }> = []
  const clock: { ms?: number; tick?: () => void } = {}
  const live = { brokerUrls, known: [] as string[] }
  const probe = startAvatarBrokerProbe({
    brokerUrls: () => live.brokerUrls,
    knownBrokerUrls: () => live.known,
    setBrokerReachable: (brokerUrl, reachable) => reachability.push([brokerUrl, reachable]),
    probe: (url, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ url, signal, resolve })
        signal.addEventListener('abort', () => reject(signal.reason))
      }),
    every: (ms, tick) => {
      clock.ms = ms
      clock.tick = tick
      return () => {
        clock.tick = undefined
      }
    },
    after: (ms, fire) => {
      const timeout = { ms, fire, cancelled: false }
      timeouts.push(timeout)
      return () => {
        timeout.cancelled = true
      }
    },
    report: (_scope, message) => reports.push(message),
    info: (_scope, message) => infos.push(message),
    ...overrides
  })
  return { probe, calls, reachability, reports, infos, timeouts, clock, live }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function answer(context: ReturnType<typeof harness>, ok: boolean): Promise<void> {
  context.calls.at(-1)!.resolve(ok)
  await flush()
  context.clock.tick?.()
}

test('probes only loopback or the configured broker, always on the fixed /health path', () => {
  expect(avatarBrokerProbeUrl(localBroker, [])).toBe('http://127.0.0.1:7899/health')
  expect(avatarBrokerProbeUrl('http://localhost:7899/some/path?x=1#frag', [])).toBe('http://localhost:7899/health')
  expect(avatarBrokerProbeUrl('http://[::1]:7899', [])).toBe('http://[::1]:7899/health')
  expect(avatarBrokerProbeUrl('https://192.168.10.23:7899/', ['https://192.168.10.23:7899'])).toBe('https://192.168.10.23:7899/health')

  expect(avatarBrokerProbeUrl('https://192.168.10.23:7899', [])).toBeNull()
  expect(avatarBrokerProbeUrl('https://192.168.10.23:7899', ['http://192.168.10.23:7899'])).toBeNull()
  expect(avatarBrokerProbeUrl('http://evil.example:7899', [localBroker])).toBeNull()
  expect(avatarBrokerProbeUrl('http://user:secret@127.0.0.1:7899', [])).toBeNull()
  expect(avatarBrokerProbeUrl('ftp://127.0.0.1:7899', [])).toBeNull()
  expect(avatarBrokerProbeUrl('not a url', [])).toBeNull()
  for (const lookalike of [
    'http://localhost.evil.com:7899',
    'http://localhost.:7899',
    'http://127.0.0.2:7899',
    'http://0.0.0.0:7899',
    'http://[::ffff:127.0.0.1]:7899'
  ]) {
    expect(avatarBrokerProbeUrl(lookalike, [])).toBeNull()
  }
  expect(avatarBrokerProbeUrl('https://broker.example:443', ['https://broker.example'])).toBe('https://broker.example/health')
})

test('probes at most sixteen distinct targets and traces the overflow once per episode', () => {
  const brokers = (count: number) => Array.from({ length: count }, (_, index) => `http://127.0.0.1:${8000 + index}`)
  const context = harness(brokers(17))
  expect(context.calls).toHaveLength(16)
  expect(context.calls.map((call) => call.url)).not.toContain('http://127.0.0.1:8016/health')
  context.clock.tick?.()
  expect(context.reports).toEqual(['refused to probe more than 16 distinct brokers'])

  context.live.brokerUrls = brokers(16)
  context.clock.tick?.()
  context.live.brokerUrls = brokers(17)
  context.clock.tick?.()
  expect(context.reports).toHaveLength(2)
  context.probe.stop()
})

test('sends one probe per distinct target every five seconds and writes every broker_url mapped to it', async () => {
  const context = harness([localBroker, `${localBroker}/`, 'http://127.0.0.1:7900'])
  expect(context.clock.ms).toBe(5_000)
  expect(context.calls.map((call) => call.url)).toEqual(['http://127.0.0.1:7899/health', 'http://127.0.0.1:7900/health'])

  context.calls[0]!.resolve(false)
  await flush()
  context.clock.tick?.()
  context.calls.at(-1)!.resolve(false)
  await flush()
  expect(context.reachability.slice(-2)).toEqual([
    [localBroker, false],
    [`${localBroker}/`, false]
  ])
  context.probe.stop()
})

test('flips unreachable after two failures, traces once per episode, and recovers on one success', async () => {
  const context = harness([localBroker])
  await answer(context, false)
  expect(context.reachability.at(-1)).toEqual([localBroker, true])
  await answer(context, false)
  await answer(context, false)
  expect(context.reachability.at(-2)).toEqual([localBroker, false])
  expect(context.reports).toEqual(['broker http://127.0.0.1:7899 unreachable'])

  await answer(context, true)
  expect(context.reachability.at(-1)).toEqual([localBroker, true])
  expect(context.infos).toEqual(['broker http://127.0.0.1:7899 reachable again'])

  await answer(context, false)
  await answer(context, false)
  expect(context.reports).toHaveLength(2)
  context.probe.stop()
})

test('aborts a probe at its two-second timeout, counts it as a failure, and never overlaps a pending probe', async () => {
  const context = harness([localBroker])
  context.clock.tick?.()
  expect(context.calls).toHaveLength(1)
  expect(context.timeouts[0]!.ms).toBe(2_000)

  context.timeouts[0]!.fire()
  await flush()
  expect(context.calls[0]!.signal.aborted).toBe(true)
  context.clock.tick?.()
  context.timeouts[1]!.fire()
  await flush()
  expect(context.reachability.at(-1)).toEqual([localBroker, false])
  context.probe.stop()
})

test('stops probing a broker once no attached Deck uses it, resets it, and ignores its late result', async () => {
  const context = harness([localBroker])
  const pending = context.calls[0]!
  context.live.brokerUrls = []
  context.clock.tick?.()
  await flush()
  expect(pending.signal.aborted).toBe(true)
  expect(context.reachability).toEqual([[localBroker, true]])

  context.clock.tick?.()
  expect(context.calls).toHaveLength(1)
  context.probe.stop()
})

test('stop aborts in-flight probes and ticks no more', () => {
  const context = harness([localBroker])
  context.probe.stop()
  expect(context.calls[0]!.signal.aborted).toBe(true)
  expect(context.clock.tick).toBeUndefined()
})

test('refuses a broker_url outside loopback and the configured broker, tracing it once', () => {
  const context = harness(['http://evil.example:7899'])
  context.clock.tick?.()
  expect(context.calls).toHaveLength(0)
  expect(context.reachability).toEqual([])
  expect(context.reports).toEqual(['refused to probe a broker_url outside loopback and the configured broker'])
  context.probe.stop()
})

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await Bun.sleep(10)
  expect(condition()).toBe(true)
}

test('the default probe requests only /health on the origin and counts a redirect as a failure', async () => {
  const hits: string[] = []
  let redirect = true
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname
      hits.push(path)
      if (path === '/health' && redirect) return Response.redirect(`http://127.0.0.1:${server.port}/elsewhere`, 302)
      return new Response('ok')
    }
  })
  const brokerUrl = `http://127.0.0.1:${server.port}/deck/path?x=1`
  const context = harness([brokerUrl], { probe: undefined })
  try {
    await waitFor(() => context.reachability.length === 1)
    context.clock.tick?.()
    await waitFor(() => context.reachability.length === 2)
    expect(context.reachability.at(-1)).toEqual([brokerUrl, false])

    redirect = false
    context.clock.tick?.()
    await waitFor(() => context.reachability.length === 3)
    expect(context.reachability.at(-1)).toEqual([brokerUrl, true])
    expect(hits).toEqual(['/health', '/health', '/health'])
  } finally {
    context.probe.stop()
    server.stop(true)
  }
})

test('a Deck /state heartbeat does not heal an unreachable broker', async () => {
  const state = new AvatarState({ now: () => 0 })
  const snapshot = {
    identity: { deckRunId: 'deck-run-1', broker_url: localBroker },
    counters: { working: 1, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
    unread: 0
  }
  state.receiveSnapshot(snapshot)
  const context = harness([localBroker], {
    setBrokerReachable: (brokerUrl, reachable) => state.setBrokerReachable(brokerUrl, reachable)
  })
  await answer(context, false)
  await answer(context, false)

  state.receiveSnapshot(snapshot)
  const summary = state.summary()
  expect(summary.face).toBe('panne')
  expect(summary.decks[0]).toMatchObject({ suspect: false, brokerReachable: false, torchOut: true })
  context.probe.stop()
})
