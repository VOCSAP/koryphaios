import { expect, test } from 'bun:test'
import {
  avatarManualStop,
  avatarTrayBroker,
  createAvatarBrokerControl,
  type AvatarBrokerControlDeps
} from '../desktop/src/main/avatar-broker-control.ts'
import type { BrokerStopMarker } from '../shared/broker-stop-marker.ts'

const URL_ = 'http://127.0.0.1:7899'
const BROKER_PID = 4242
const SELF_PID = 1000
const BROKER_HEALTH = { status: 'ok', context_resume_version: 1, operator_trust_version: 1, operator_trust_state: 'ready', peers: 3 }

function harness(overrides: Partial<AvatarBrokerControlDeps> = {}) {
  const steps: string[] = []
  const reports: string[] = []
  const confirmations: Array<{ url: string; pid: number; decks: number }> = []
  let alive = new Set([BROKER_PID, SELF_PID])
  const deps: AvatarBrokerControlDeps = {
    url: () => URL_,
    selfPid: SELF_PID,
    listenerPid: async (port) => {
      steps.push(`netstat:${port}`)
      return BROKER_PID
    },
    isAlive: (pid) => alive.has(pid),
    brokerHealth: async () => BROKER_HEALTH,
    attachedBrokerUrls: () => ['http://127.0.0.1:7899', 'http://localhost:7900', 'https://broker.example:7899'],
    confirm: async (details) => {
      confirmations.push(details)
      return true
    },
    writeMarker: (marker: BrokerStopMarker) => steps.push(`marker:${marker.by}:${marker.killed_pid}`),
    clearMarker: () => steps.push('clear'),
    kill: (pid) => {
      steps.push(`kill:${pid}`)
      alive = new Set([...alive].filter((p) => p !== pid))
    },
    sleep: async () => {},
    now: () => '2026-10-16T20:10:00.000Z',
    health: async () => {
      steps.push('health')
      return false
    },
    ensure: async () => {
      steps.push('ensure')
      return { action: 'started', script: '/x/broker.ts', source: 'claude-json' }
    },
    refresh: () => steps.push('refresh'),
    report: (_scope, message) => reports.push(message),
    ...overrides
  }
  return { control: createAvatarBrokerControl(deps), steps, reports, confirmations }
}

test('stop writes the marker before killing the listening pid, then confirms it died', async () => {
  const { control, steps, reports, confirmations } = harness()

  expect(await control.stop()).toEqual({ ok: true })

  expect(steps).toEqual(['netstat:7899', 'netstat:7899', 'marker:avatar:4242', 'kill:4242', 'refresh'])
  expect(confirmations).toEqual([{ url: URL_, pid: BROKER_PID, decks: 1 }])
  expect(reports).toEqual([])
})

const REFUSALS: Array<[string, Partial<AvatarBrokerControlDeps>]> = [
  ['no listener', { listenerPid: async () => null }],
  ['pid 0, which a signal-0 probe reports alive', { listenerPid: async () => 0, isAlive: () => true }],
  ['its own pid', { listenerPid: async () => SELF_PID }],
  ['a pid that is not alive', { isAlive: () => false }],
  ['a netstat that fails', { listenerPid: () => Promise.reject(new Error('netstat timed out')) }],
  ['a non-loopback broker URL', { url: () => 'https://broker.example:7899' }],
  ['a broker URL without a port', { url: () => 'http://127.0.0.1' }],
  ['a listener whose /health is not a claude-peers broker', { brokerHealth: async () => ({ status: 'ok' }) }],
  ['a listener whose /health is not JSON', { brokerHealth: () => Promise.reject(new SyntaxError('Unexpected token <')) }],
  ['a listener that does not answer /health', { brokerHealth: () => Promise.reject(new Error('timed out')) }]
]

test.each(REFUSALS)('stop refuses %s before any marker, confirmation or kill', async (_name, override) => {
  const { control, steps, reports, confirmations } = harness(override)

  const result = await control.stop()

  expect(result.ok).toBe(false)
  expect(steps.filter((step) => step.startsWith('marker') || step.startsWith('kill'))).toEqual([])
  expect(confirmations).toEqual([])
  expect(reports).toHaveLength(1)
})

test('a cancelled confirmation writes nothing and kills nothing', async () => {
  const { control, steps, reports } = harness({ confirm: async () => false })

  expect(await control.stop()).toEqual({ ok: false, cancelled: true })
  expect(steps).toEqual(['netstat:7899', 'refresh'])
  expect(reports).toEqual([])
})

test('a port no longer served by a claude-peers broker after the confirmation is not killed', async () => {
  let checks = 0
  const { control, steps, reports } = harness({
    brokerHealth: async () => (++checks === 1 ? BROKER_HEALTH : { status: 'ok', service: 'something else' })
  })

  expect((await control.stop()).ok).toBe(false)
  expect(checks).toBe(2)
  expect(steps.filter((step) => step.startsWith('marker') || step.startsWith('kill'))).toEqual([])
  expect(reports).toHaveLength(1)
})

test('/health is asked on the port of the inspected listener, even for a localhost broker URL', async () => {
  const healthPorts: number[] = []
  const { control } = harness({
    url: () => 'http://localhost:7899',
    brokerHealth: async (port) => {
      healthPorts.push(port)
      return BROKER_HEALTH
    }
  })

  expect(await control.stop()).toEqual({ ok: true })
  expect(healthPorts).toEqual([7899, 7899])
})

test('the refusal for a missing listener names bind_host, the case the tray cannot stop', async () => {
  const { control, reports } = harness({ listenerPid: async () => null })

  await control.stop()

  expect(reports[0]).toContain('bind_host')
})

test('a broker replaced while the confirmation was open is not killed', async () => {
  let reads = 0
  const { control, steps, reports } = harness({
    listenerPid: async () => (++reads === 1 ? BROKER_PID : 5151)
  })

  expect((await control.stop()).ok).toBe(false)
  expect(steps.filter((step) => step.startsWith('marker') || step.startsWith('kill'))).toEqual([])
  expect(reports).toHaveLength(1)
})

test('a marker that cannot be written leaves the broker running', async () => {
  const { control, steps, reports } = harness({
    writeMarker: () => {
      throw new Error('EACCES')
    }
  })

  expect((await control.stop()).ok).toBe(false)
  expect(steps.filter((step) => step.startsWith('kill'))).toEqual([])
  expect(reports).toHaveLength(1)
})

test('a refused kill rolls the marker back and reports', async () => {
  const { control, steps, reports } = harness({
    kill: () => {
      throw new Error('EPERM')
    }
  })

  expect((await control.stop()).ok).toBe(false)
  expect(steps).toEqual(['netstat:7899', 'netstat:7899', 'marker:avatar:4242', 'clear', 'refresh'])
  expect(reports).toHaveLength(1)
})

test('a process still alive after the wait keeps the marker, so no Deck relaunches, and reports it', async () => {
  const { control, steps, reports } = harness({ kill: (pid) => void steps.push(`kill:${pid}`) })

  expect((await control.stop()).ok).toBe(false)
  expect(steps).toEqual(['netstat:7899', 'netstat:7899', 'marker:avatar:4242', 'kill:4242', 'refresh'])
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain('kill sent, death not confirmed')
})

test('start clears the marker, asks /health, then ensures the broker', async () => {
  const { control, steps, reports } = harness()

  expect(await control.start()).toEqual({ ok: true })
  expect(steps).toEqual(['clear', 'health', 'ensure', 'refresh'])
  expect(reports).toEqual([])
})

test('a failed start is reported and returned', async () => {
  const { control, reports } = harness({ ensure: async () => ({ action: 'not-found' }) })

  const result = await control.start()

  expect(result.ok).toBe(false)
  expect(reports).toHaveLength(1)
})

test('the tray offers the broker entry only for a local or replica broker, labelled by its state', () => {
  expect(avatarTrayBroker('remote', false, true)).toBeNull()
  expect(avatarTrayBroker('remote', true, false)).toBeNull()
  expect(avatarTrayBroker('local', false, true)).toEqual({ running: true })
  expect(avatarTrayBroker('replica', false, true)).toEqual({ running: true })
  expect(avatarTrayBroker('local', true, true)).toEqual({ running: false })
  expect(avatarTrayBroker('local', false, false)).toEqual({ running: false })
})

test('the panne face follows the stop marker, corrupted included, but never for a remote broker', () => {
  const marker = { stopped_at: '2026-10-16T20:10:00.000Z', by: 'avatar', killed_pid: 4242 }
  expect(avatarManualStop('local', { stopped: true, marker })).toBe(true)
  expect(avatarManualStop('replica', { stopped: true, marker: null, problem: 'not valid JSON' })).toBe(true)
  expect(avatarManualStop('local', { stopped: false })).toBe(false)
  expect(avatarManualStop('remote', { stopped: true, marker })).toBe(false)
})
