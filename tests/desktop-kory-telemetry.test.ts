import { expect, test } from 'bun:test'
import { encodeStatusFromPayload, decodeStatusFile } from '../desktop/src/shared/session-status.ts'
import { register, reportMeasuredContext, seedModelIdentity, telemetryStatusPath, type TelemetryHost } from '../desktop/hooks/kory-telemetry.ts'

function host(
  raw: string | null,
  errors: string[] = [],
  modelId = 'claude-opus-5-5',
  fallbackMarker?: string
): { value: TelemetryHost; writes: string[] } {
  const writes: string[] = []
  return {
    value: {
      env: {
        async get(name) {
          if (name === 'KORY_STATUS_FALLBACK') return fallbackMarker
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
      session: {
        async model() {
          return modelId
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

test('session.start seeds an absent report with the canonical id when the catalog has no label', async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  register(
    ((event: string, ...args: unknown[]) => {
      const handler = args.at(-1)
      if (typeof handler === 'function') handlers.set(event, handler as (...args: unknown[]) => Promise<unknown>)
    }) as never,
  )
  const probe = host(null, [], 'claude-unlisted-99-9')

  const result = await handlers.get('session.start')!(probe.value, {}, async () => ({ cwd: 'C:/repo' }))

  expect(result).toEqual({ cwd: 'C:/repo' })
  expect(decodeStatusFile(probe.writes[0]!), 'seed report is readable by the Deck').toMatchObject({
    modelId: 'claude-unlisted-99-9',
    model: 'claude-unlisted-99-9',
    contextPct: null,
    contextWindow: null,
  })
})

test('session.start uses the catalog label for a known model', async () => {
  const probe = host(null, [], 'claude-opus-4-8')

  await seedModelIdentity(probe.value)

  expect(decodeStatusFile(probe.writes[0]!)?.model).toBe('Claude Opus 4.8')
})

test('session.start never replaces a valid fallback identity', async () => {
  const fallback = encodeStatusFromPayload({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } }, 1)!
  const probe = host(fallback, [], 'claude-unlisted-99-9')

  await seedModelIdentity(probe.value)

  expect(probe.writes, 'a valid fallback identity is the source of truth').toEqual([])
})

test('session.start never seeds while the fallback writer is active', async () => {
  const probe = host(null, [], 'claude-unlisted-99-9', '1')

  await seedModelIdentity(probe.value)

  expect(probe.writes, 'the fallback marker prevents a concurrent seed writer').toEqual([])
})

test('session.start treats an empty or non-exact fallback marker as absent', async () => {
  for (const marker of ['', 'true']) {
    const probe = host(null, [], 'claude-unlisted-99-9', marker)

    await seedModelIdentity(probe.value)

    expect(probe.writes).toHaveLength(1)
  }
})

test('session.start continues after session.model fails without writing', async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  register(
    ((event: string, ...args: unknown[]) => {
      const handler = args.at(-1)
      if (typeof handler === 'function') handlers.set(event, handler as (...args: unknown[]) => Promise<unknown>)
    }) as never,
  )
  const errors: string[] = []
  const probe = host(null, errors)
  probe.value.session.model = async () => {
    throw new Error('model unavailable')
  }
  let continued = false

  await handlers.get('session.start')!(probe.value, {}, async () => {
    continued = true
    return { cwd: 'C:/repo' }
  })

  expect(continued, 'session.start calls next after telemetry fails').toBe(true)
  expect(probe.writes).toEqual([])
  expect(errors).toEqual(['Kory telemetry report failed: model unavailable'])
})

test('session.start continues after fs.write fails without a second write', async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  register(
    ((event: string, ...args: unknown[]) => {
      const handler = args.at(-1)
      if (typeof handler === 'function') handlers.set(event, handler as (...args: unknown[]) => Promise<unknown>)
    }) as never,
  )
  const errors: string[] = []
  const probe = host(null, errors)
  probe.value.fs.write = async () => {
    throw new Error('disk full')
  }
  let continued = false

  await handlers.get('session.start')!(probe.value, {}, async () => {
    continued = true
    return { cwd: 'C:/repo' }
  })

  expect(continued, 'session.start calls next after telemetry fails').toBe(true)
  expect(probe.writes).toEqual([])
  expect(errors).toEqual(['Kory telemetry report failed: disk full'])
})

test('measure telemetry keeps the fallback label for an unchanged model and updates the context', async () => {
  const fallback = encodeStatusFromPayload(
    {
      model: { id: 'claude-opus-4-1', display_name: 'Opus' },
      context_window: { context_window_size: 1_000_000, used_percentage: null },
    },
    1,
  )!
  const probe = host(fallback, [], 'claude-opus-4-1')

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

test('fallback marker suppresses every module writer', async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  register(
    ((event: string, ...args: unknown[]) => {
      const handler = args.at(-1)
      if (typeof handler === 'function') handlers.set(event, handler as (...args: unknown[]) => Promise<unknown>)
    }) as never,
  )
  const fallback = encodeStatusFromPayload({ model: { id: 'claude-opus-4-1', display_name: 'Opus' } }, 1)!
  const probe = host(fallback, [], 'claude-opus-5-5', '1')
  const compactHost = {
    ...probe.value,
    session: {
      async usage() {
        return { context: { window: 1_000_000 } }
      },
    },
  }

  await handlers.get('session.measure')!(probe.value, { context: { window: 1_000_000, percent: 7 } }, async () => 'continued')
  await handlers.get('session.compact')!(compactHost, {}, async () => ({ messages: [] }))

  expect(probe.writes, 'the fallback is the only status writer for this spawn').toEqual([])
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

function registeredHandlers(): Map<string, (...args: unknown[]) => Promise<unknown>> {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  register(
    ((event: string, ...args: unknown[]) => {
      const handler = args.at(-1)
      if (typeof handler === 'function') handlers.set(event, handler as (...args: unknown[]) => Promise<unknown>)
    }) as never,
  )
  return handlers
}

const REPORT_AT_20_PERCENT = encodeStatusFromPayload(
  {
    model: { id: 'claude-opus-4-1', display_name: 'Opus' },
    context_window: { context_window_size: 1_000_000, used_percentage: 20 },
  },
  1,
)!

test('a /clear empties the context gauge and keeps the model and window', async () => {
  const probe = host(REPORT_AT_20_PERCENT, [], 'claude-opus-4-1')
  const ended: unknown[] = []

  const result = await registeredHandlers().get('session.end')!(probe.value, { reason: 'clear' }, async (e: unknown) => {
    expect(probe.writes, 'the report is written before the engine ends the session').toHaveLength(1)
    ended.push(e)
    return { sessionId: 'old' }
  })

  expect(result).toEqual({ sessionId: 'old' })
  expect(ended).toEqual([{ reason: 'clear' }])
  expect(decodeStatusFile(probe.writes[0]!), 'the gauge reads unused after /clear').toMatchObject({
    modelId: 'claude-opus-4-1',
    contextPct: null,
    contextWindow: 1_000_000,
  })
})

test('a session ending for any other reason leaves the report alone', async () => {
  const probe = host(REPORT_AT_20_PERCENT)

  await registeredHandlers().get('session.end')!(probe.value, { reason: 'prompt_input_exit' }, async () => ({ sessionId: 'old' }))

  expect(probe.writes).toEqual([])
})

test('a /clear under the fallback status line writes nothing from the module', async () => {
  const probe = host(REPORT_AT_20_PERCENT, [], 'claude-opus-5-5', '1')

  await registeredHandlers().get('session.end')!(probe.value, { reason: 'clear' }, async () => ({ sessionId: 'old' }))

  expect(probe.writes).toEqual([])
})

test('a measure never recreates a report the Deck cleared', async () => {
  const probe = host(null, [], 'claude-unlisted-99-9')

  await reportMeasuredContext(probe.value, { window: 1_000_000, percent: 3 })

  expect(probe.writes, 'a late measure from a respawned process must not plant its model before the new seed').toEqual([])
})

test('a measure after /model reports the new model', async () => {
  const probe = host(REPORT_AT_20_PERCENT, [], 'claude-opus-4-8')

  await reportMeasuredContext(probe.value, { percent: 5 })

  expect(decodeStatusFile(probe.writes[0]!), 'the badge follows a model switched mid-session').toEqual({
    model: 'Claude Opus 4.8',
    modelId: 'claude-opus-4-8',
    contextPct: 5,
    contextWindow: 1_000_000,
    at: 2,
  })
})

test('a measure keeps the previous model when the host cannot supply one', async () => {
  const errors: string[] = []
  const failing = host(REPORT_AT_20_PERCENT, errors)
  failing.value.session.model = async () => {
    throw new Error('model unavailable')
  }
  const hostile = host(REPORT_AT_20_PERCENT, [], 'a;rm -rf')
  const empty = host(REPORT_AT_20_PERCENT, [], '')

  for (const probe of [failing, hostile, empty]) await reportMeasuredContext(probe.value, { percent: 9 })

  for (const probe of [failing, hostile, empty]) {
    expect(decodeStatusFile(probe.writes[0]!), 'an unusable model never blanks the identity nor blocks the context').toMatchObject({
      model: 'Opus',
      modelId: 'claude-opus-4-1',
      contextPct: 9,
    })
  }
  expect(errors).toEqual(['Kory telemetry report failed: model unavailable'])
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
