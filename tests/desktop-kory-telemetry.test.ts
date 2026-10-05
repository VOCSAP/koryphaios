import { expect, test } from 'bun:test'

import { encodeStatusFromPayload, decodeStatusFile } from '../desktop/src/shared/session-status.ts'
import { register, reportMeasuredContext, telemetryStatusPath, type TelemetryHost } from '../desktop/hooks/kory-telemetry.ts'

function host(raw: string | null, errors: string[] = []): { value: TelemetryHost; writes: string[] } {
  const writes: string[] = []
  return {
    value: {
      env: {
        async get(name) {
          if (name === 'CLAUDE_PEERS_DESK_SESSION') return 'tile-1'
          if (name === 'USERPROFILE') return 'C:/Users/tester'
          return undefined
        },
      },
      fs: {
        async exists() {
          return raw !== null
        },
        async read() {
          if (raw === null) throw new Error('missing')
          return raw
        },
        async write(_path, text) {
          writes.push(text)
        },
      },
      clock: {
        async now() {
          return 2
        },
      },
      ui: {
        log(text) {
          errors.push(text)
        },
      },
    },
    writes,
  }
}

test('telemetry status path shares the fallback filename', () => {
  expect(telemetryStatusPath('a/../b', 'C:/Users/tester')).toBe('C:/Users/tester/.claude/peers/desk-status-a____b.json')
  expect(telemetryStatusPath(undefined, 'C:/Users/tester')).toBeNull()
  expect(telemetryStatusPath('tile-1', undefined)).toBeNull()
})

test('measure telemetry preserves the fallback model and updates the context', async () => {
  const fallback = encodeStatusFromPayload(
    {
      model: { id: 'claude-opus-4-1', display_name: 'Opus' },
      context_window: { context_window_size: 1_000_000, used_percentage: null },
    },
    1,
  )!
  const probe = host(fallback)

  await reportMeasuredContext(probe.value, { window: 1_000_000, percent: 7 })

  expect(probe.writes).toHaveLength(1)
  expect(decodeStatusFile(probe.writes[0]!), 'module report stays compatible with the fallback').toEqual({
    model: 'Opus',
    modelId: 'claude-opus-4-1',
    contextPct: 7,
    contextWindow: 1_000_000,
    at: 2,
  })
})

test('session.compact continues before it writes the unknown context', async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  register(
    ((event: string, ...args: unknown[]) => {
      const handler = args.at(-1)
      if (typeof handler === 'function') handlers.set(event, handler as (...args: unknown[]) => Promise<unknown>)
    }) as never,
  )
  const fallback = encodeStatusFromPayload(
    {
      model: { id: 'claude-opus-4-1', display_name: 'Opus' },
      context_window: { context_window_size: 1_000_000, used_percentage: 7 },
    },
    1,
  )!
  const probe = host(fallback)
  let continued = false
  const compactHost = {
    ...probe.value,
    session: {
      async usage() {
        expect(continued, 'compaction continues before telemetry reads usage').toBe(true)
        return { context: { window: 1_000_000 } }
      },
    },
  }
  const result = await handlers.get('session.compact')!(
    compactHost,
    {},
    async () => {
      continued = true
      return { messages: [] }
    },
  )

  expect(result).toEqual({ messages: [] })
  expect(decodeStatusFile(probe.writes[0]!), 'post-compact context is unknown').toMatchObject({
    contextPct: null,
    contextWindow: 1_000_000,
  })
})

test('telemetry does not replace the fallback report before it exists', async () => {
  const probe = host(null)

  await reportMeasuredContext(probe.value, { window: 1_000_000 })

  expect(probe.writes).toEqual([])
})

test('session.measure write failures are logged without blocking the session', async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  register(
    ((event: string, ...args: unknown[]) => {
      const handler = args.at(-1)
      if (typeof handler === 'function') handlers.set(event, handler as (...args: unknown[]) => Promise<unknown>)
    }) as never,
  )
  const fallback = encodeStatusFromPayload({ model: { id: 'claude-opus-4-1', display_name: 'Opus' } }, 1)!
  const errors: string[] = []
  const probe = host(fallback, errors)
  probe.value.fs.write = async () => {
    throw new Error('disk full')
  }

  const result = await handlers.get('session.measure')!(probe.value, { context: { window: 1_000_000, percent: 7 } }, async () => 'continued')

  expect(result).toBe('continued')
  expect(errors).toEqual(['Kory telemetry report failed: disk full'])
})
