import { expect, test } from 'bun:test'
import { hasEnabledMods, LaunchAttemptRegistry, prepareLaunchModPlan, prepareRestorePlans } from '../desktop/src/main/mod-launch-plan'
import { enabledModsFromLock } from '../desktop/src/main/mods-working-copy'

const signal = () => new AbortController().signal

function deps(overrides: Partial<Parameters<typeof prepareLaunchModPlan>[0]> = {}) {
  return {
    enabledModsFromLock: () => ['alpha'],
    ensureModWorkingCopy: async () => ({ ok: true as const, dir: '/host/alpha' }),
    verifyHostCopy: () => ({ ok: true as const }),
    ...overrides
  }
}

test('disabled mods return an empty plan without I/O', async () => {
  let calls = 0
  const plan = await prepareLaunchModPlan(deps({ enabledModsFromLock: () => [], ensureModWorkingCopy: async () => { calls++; return { ok: true as const, dir: '/x' } } }), {
    sandboxed: false, config: {}, lock: new Map(), workRoot: '/work', distDir: '/dist', signal: signal(), attemptId: 'a'
  })
  expect(plan).toEqual({ attemptId: 'a', mode: 'host', modDirs: [], copies: [], diagnostics: [] })
  expect(calls).toBe(0)
})

const NOT_AN_ENABLED_RECORD: ReadonlyArray<[string, unknown]> = [
  ['absent', undefined],
  ['null', null],
  ['an array holding true', [true]],
  ['a number', 7],
  ['a string', 'true']
]

test.each(NOT_AN_ENABLED_RECORD)('enabledMods %s enables nothing and never loads the lock', async (_label, value) => {
  let loads = 0
  const plan = await prepareLaunchModPlan(deps(), {
    sandboxed: false, config: { enabledMods: value }, loadLock: () => { loads++; throw new Error('broken-lock') }, workRoot: '/work', distDir: '/dist', signal: signal(), attemptId: 'a'
  })
  expect(plan, `enabledMods=${JSON.stringify(value)} must yield the empty host plan`).toEqual({ attemptId: 'a', mode: 'host', modDirs: [], copies: [], diagnostics: [] })
  expect(loads, `enabledMods=${JSON.stringify(value)} must not read the lock`).toBe(0)
})

const NOTHING_ENABLED: ReadonlyArray<[string, unknown]> = [
  ...NOT_AN_ENABLED_RECORD,
  ['an empty record', {}],
  ['a record whose entries are not the boolean true', { alpha: false, beta: 'true', gamma: 1, delta: {} }]
]

test.each(NOTHING_ENABLED)('hasEnabledMods reads enabledMods holding %s as nothing enabled', (_label, value) => {
  expect(hasEnabledMods(value), `enabledMods=${JSON.stringify(value)} must not read as active`).toBe(false)
})

test.each([
  ['a single true', { alpha: true }],
  ['a true among false entries', { alpha: false, beta: true }]
] as Array<[string, unknown]>)('hasEnabledMods reads %s as enabled', (_label, value) => {
  expect(hasEnabledMods(value), `enabledMods=${JSON.stringify(value)} must read as active`).toBe(true)
})

test('sandbox refusal returns a structural refusal', async () => {
  const plan = await prepareLaunchModPlan(deps({ prepareMods: async () => ({ ok: false as const, reason: 'unavailable' }) }), {
    sandboxed: true, config: { enabledMods: { alpha: true } }, lock: new Map([['alpha', 'f'.repeat(64)]]), workRoot: '/work', distDir: '/dist', signal: signal(), attemptId: 'a'
  })
  expect(plan).toEqual({ attemptId: 'a', refused: 'unavailable' })
})

test('sandbox omissions become diagnostics', async () => {
  const plan = await prepareLaunchModPlan(deps({ prepareMods: async () => ({ ok: true as const, references: [], diagnostics: { omitted: [{ plugin: 'alpha', reason: 'missing' }] } }) }), {
    sandboxed: true, config: { enabledMods: { alpha: true } }, lock: new Map([['alpha', 'f'.repeat(64)]]), workRoot: '/work', distDir: '/dist', signal: signal(), attemptId: 'a'
  })
  expect(plan).toEqual({ attemptId: 'a', mode: 'sandbox', modDirs: [], diagnostics: [{ plugin: 'alpha', reason: 'missing' }] })
})

test('abort between working copies returns no plan', async () => {
  const controller = new AbortController()
  const plan = await prepareLaunchModPlan(deps({ enabledModsFromLock: () => ['alpha', 'beta'], ensureModWorkingCopy: async ({ plugin }: { plugin: string }) => { if (plugin === 'alpha') controller.abort(); return { ok: true as const, dir: '/x' } } }), {
    sandboxed: false, config: { enabledMods: { alpha: true, beta: true } }, lock: new Map([['alpha', 'a'.repeat(64)], ['beta', 'b'.repeat(64)]]), workRoot: '/work', distDir: '/dist', signal: controller.signal, attemptId: 'a'
  })
  expect(plan).toEqual({ attemptId: 'a', refused: 'aborted' })
})

const restoredPlan = (attemptId: string) => ({ attemptId, mode: 'host' as const, modDirs: [], copies: [], diagnostics: [] })

test('a superseded restore attempt rejects the whole batch without returning a partial map', async () => {
  const registry = new LaunchAttemptRegistry()
  const result = await prepareRestorePlans(registry, async (attempt) => {
    registry.cancel('first')
    return restoredPlan(attempt.attemptId)
  }, (def) => def.supervisor !== true, [{ id: 'first' }, { id: 'second' }], signal())

  expect(result).toEqual({ ok: false, reason: 'superseded' })
})

test('an abort between restore definitions rejects the whole batch and cancels its attempts', async () => {
  const registry = new LaunchAttemptRegistry()
  const controller = new AbortController()
  let calls = 0
  const result = await prepareRestorePlans(registry, async (attempt) => {
    calls++
    controller.abort()
    return restoredPlan(attempt.attemptId)
  }, (def) => def.supervisor !== true, [{ id: 'first' }, { id: 'second' }], controller.signal)

  expect(result).toEqual({ ok: false, reason: 'aborted' })
  expect(calls).toBe(1)
})

test('a restore prepares one shared host plan for every host definition', async () => {
  const registry = new LaunchAttemptRegistry()
  let calls = 0
  const result = await prepareRestorePlans(registry, async (attempt) => {
    calls++
    return restoredPlan(attempt.attemptId)
  }, () => false, [{ id: 'first', supervisor: true }, { id: 'second', supervisor: true }, { id: 'third', supervisor: true }, { id: 'fourth', supervisor: true }, { id: 'fifth', supervisor: true }], signal())

  expect(calls).toBe(1)
  expect(result.ok).toBe(true)
  if (result.ok) expect([...result.plans.keys()]).toEqual(['first', 'second', 'third', 'fourth', 'fifth'])
})

test('a restore prepares one plan for each present mode', async () => {
  const registry = new LaunchAttemptRegistry()
  const modes: boolean[] = []
  const result = await prepareRestorePlans(registry, async (attempt, input) => {
    modes.push(input.supervisor)
    return restoredPlan(attempt.attemptId)
  }, (def) => def.supervisor !== true, [{ id: 'host-one', supervisor: true }, { id: 'sandbox-one' }, { id: 'host-two', supervisor: true }, { id: 'sandbox-two' }], signal())

  expect(modes).toEqual([true, false])
  expect(result.ok).toBe(true)
})

test('a restore keeps the mode captured before preparation when modeOf changes', async () => {
  const registry = new LaunchAttemptRegistry()
  let sandboxed = false
  const result = await prepareRestorePlans(registry, async (attempt) => {
    sandboxed = true
    return restoredPlan(attempt.attemptId)
  }, () => sandboxed, [{ id: 'first' }, { id: 'second' }], signal())

  expect(result.ok).toBe(true)
  if (result.ok) expect([...result.plans.values()]).toEqual([restoredPlan('1'), restoredPlan('1')])
})

test('a disabled sandbox groups supervisor and tile into one host preparation', async () => {
  const registry = new LaunchAttemptRegistry()
  let calls = 0
  const result = await prepareRestorePlans(registry, async (attempt) => {
    calls++
    return restoredPlan(attempt.attemptId)
  }, () => false, [{ id: 'supervisor', supervisor: true }, { id: 'tile' }], signal())

  expect(calls).toBe(1)
  expect(result.ok).toBe(true)
})

test('an abort during shared restore preparation rejects the whole batch', async () => {
  const registry = new LaunchAttemptRegistry()
  const controller = new AbortController()
  let calls = 0
  const result = await prepareRestorePlans(registry, async (attempt) => {
    calls++
    controller.abort()
    return restoredPlan(attempt.attemptId)
  }, () => false, [{ id: 'first', supervisor: true }, { id: 'second', supervisor: true }, { id: 'third', supervisor: true }], controller.signal)

  expect(result).toEqual({ ok: false, reason: 'aborted' })
  expect(calls).toBe(1)
})

test('cancelling a non-first shared restore target rejects the whole preparation', async () => {
  const registry = new LaunchAttemptRegistry()
  let release: (value: LaunchModPlan) => void = () => {}
  const prepared = new Promise<LaunchModPlan>((resolve) => { release = resolve })
  const result = prepareRestorePlans(registry, async () => prepared, () => false, [{ id: 'first', supervisor: true }, { id: 'second', supervisor: true }, { id: 'third', supervisor: true }], signal())

  registry.cancel('second')
  release(restoredPlan('1'))

  await expect(result).resolves.toEqual({ ok: false, reason: 'superseded' })
})

test('registry invalidates cancelled attempts and joins once', async () => {
  const registry = new LaunchAttemptRegistry()
  const attempt = registry.begin('tile')
  registry.cancel('tile')
  expect(registry.isCurrent(attempt.attemptId)).toBe(false)
  let calls = 0
  const first = registry.begin('tile')
  const one = registry.join('tile', async () => { calls++; return first.attemptId })
  const two = registry.join('tile', async () => { calls++; return 'other' })
  expect(await Promise.all([one, two])).toEqual([first.attemptId, first.attemptId])
  expect(calls).toBe(1)
})

test('cancelAllExcept preserves only the current generations named by the restore', () => {
  const registry = new LaunchAttemptRegistry()
  const stale = registry.begin('restored-tile')
  const current = registry.begin('restored-tile')
  const preserved = registry.begin('other-restored-tile')

  registry.cancelAllExcept(new Set([stale.attemptId, preserved.attemptId]))

  expect(registry.isCurrent(current.attemptId)).toBe(false)
  expect(registry.isCurrent(preserved.attemptId)).toBe(true)
})

const alphaLock = new Map([['alpha', 'a'.repeat(64)]])
const alphaBetaLock = new Map([['alpha', 'a'.repeat(64)], ['beta', 'b'.repeat(64)]])
const planInput = (overrides: Partial<Parameters<typeof prepareLaunchModPlan>[1]> = {}): Parameters<typeof prepareLaunchModPlan>[1] => ({
  sandboxed: false, config: { enabledMods: { alpha: true } }, lock: alphaLock, workRoot: '/work', distDir: '/dist', signal: signal(), attemptId: 'a', ...overrides
})

test('an empty plan carries its mode without preparing a sandbox target', async () => {
  const host = await prepareLaunchModPlan(deps({ enabledModsFromLock: () => [] }), planInput({ sandboxed: false }))
  let preparations = 0
  const sandbox = await prepareLaunchModPlan(deps({ enabledModsFromLock: () => [], prepareMods: async () => { preparations++; return { ok: true as const, engine: 'docker' as const, containerId: 'a'.repeat(64), references: [], diagnostics: { omitted: [] } } } }), planInput({ sandboxed: true }))
  expect(host).toEqual({ attemptId: 'a', mode: 'host', modDirs: [], copies: [], diagnostics: [] })
  expect(sandbox).toEqual({ attemptId: 'a', mode: 'sandbox', modDirs: [], diagnostics: [] })
  expect(preparations).toBe(0)
})

test('a host plan lists the working copies in lock order and never calls the sandbox preparation', async () => {
  let sandboxCalls = 0
  const plan = await prepareLaunchModPlan(
    deps({
      enabledModsFromLock: () => ['alpha', 'beta'],
      ensureModWorkingCopy: async ({ plugin }: { plugin: string }) => ({ ok: true as const, dir: `/host/${plugin}` }),
      prepareMods: async () => { sandboxCalls++; return { ok: true as const, references: [], diagnostics: { omitted: [] } } }
    }),
    planInput({ lock: alphaBetaLock })
  )
  expect(plan).toEqual({ attemptId: 'a', mode: 'host', modDirs: ['/host/alpha', '/host/beta'], copies: [{ plugin: 'alpha', fingerprint: 'a'.repeat(64), hostDir: '/host/alpha' }, { plugin: 'beta', fingerprint: 'b'.repeat(64), hostDir: '/host/beta' }], diagnostics: [] })
  expect(sandboxCalls).toBe(0)
})

test.each([false, true])('a Prosopon-then-Mitos configuration keeps Mitos first in the %s plan', async (sandboxed) => {
  const lock = new Map([
    ['mitos', 'a'.repeat(64)],
    ['prosopon', 'b'.repeat(64)]
  ])
  const plan = await prepareLaunchModPlan(
    deps({
      enabledModsFromLock: (config, locked) => enabledModsFromLock(config.enabledMods, locked),
      ensureModWorkingCopy: async ({ plugin }: { plugin: string }) => ({ ok: true as const, dir: `/host/${plugin}` }),
      prepareMods: async ({ copies }) => ({
        ok: true as const,
        references: copies.map((copy) => ({ plugin: copy.plugin, containerDir: `/sandbox/${copy.plugin}` })),
        diagnostics: { omitted: [] }
      })
    }),
    planInput({ sandboxed, config: { enabledMods: { prosopon: true, mitos: true } }, lock })
  )

  expect(plan).toMatchObject({ mode: sandboxed ? 'sandbox' : 'host', modDirs: sandboxed ? ['/sandbox/mitos', '/sandbox/prosopon'] : ['/host/mitos', '/host/prosopon'] })
})

test('a working copy that fails is omitted with its reason while the other mods are kept', async () => {
  const plan = await prepareLaunchModPlan(
    deps({
      enabledModsFromLock: () => ['alpha', 'beta'],
      ensureModWorkingCopy: async ({ plugin }: { plugin: string }) =>
        plugin === 'alpha' ? { ok: false as const, reason: 'drifted' } : { ok: true as const, dir: `/host/${plugin}` }
    }),
    planInput({ lock: alphaBetaLock })
  )
  expect(plan).toEqual({ attemptId: 'a', mode: 'host', modDirs: ['/host/beta'], copies: [{ plugin: 'beta', fingerprint: 'b'.repeat(64), hostDir: '/host/beta' }], diagnostics: [{ plugin: 'alpha', reason: 'drifted' }] })
})

test('a mod without a locked fingerprint refuses the whole plan', async () => {
  const plan = await prepareLaunchModPlan(deps(), planInput({ lock: new Map([['other', 'c'.repeat(64)]]) }))
  expect(plan).toEqual({ attemptId: 'a', refused: 'missing-fingerprint' })
})

test('an already aborted signal prepares nothing', async () => {
  const controller = new AbortController()
  controller.abort()
  let copies = 0
  const plan = await prepareLaunchModPlan(deps({ ensureModWorkingCopy: async () => { copies++; return { ok: true as const, dir: '/x' } } }), planInput({ signal: controller.signal }))
  expect(plan).toEqual({ attemptId: 'a', refused: 'aborted' })
  expect(copies, 'no working copy may be built for an aborted attempt').toBe(0)
})

test('an abort during the last working copy refuses the plan instead of returning a host plan', async () => {
  const controller = new AbortController()
  const plan = await prepareLaunchModPlan(
    deps({ ensureModWorkingCopy: async () => { controller.abort(); return { ok: true as const, dir: '/x' } } }),
    planInput({ signal: controller.signal })
  )
  expect(plan).toEqual({ attemptId: 'a', refused: 'aborted' })
})

test('a sandbox plan hands the verified host copies to the preparation and returns container directories, never host ones', async () => {
  let received: Parameters<NonNullable<ReturnType<typeof deps>['prepareMods']>>[0] | null = null
  const verify = () => ({ ok: true as const })
  const controller = new AbortController()
  const plan = await prepareLaunchModPlan(
    deps({
      enabledModsFromLock: () => ['alpha', 'beta'],
      ensureModWorkingCopy: async ({ plugin }: { plugin: string }) => ({ ok: true as const, dir: `/host/${plugin}` }),
      verifyHostCopy: verify,
      prepareMods: async (input: NonNullable<Parameters<NonNullable<ReturnType<typeof deps>['prepareMods']>>[0]>) => {
        received = input
        return {
          ok: true as const,
          references: [{ plugin: 'alpha', containerDir: '/opt/kory-mods/alpha/fp' }, { plugin: 'beta', containerDir: '/opt/kory-mods/beta/fp' }],
          diagnostics: { omitted: [] }
        }
      }
    } as never),
    planInput({ sandboxed: true, lock: alphaBetaLock, signal: controller.signal, attemptId: 'attempt-7' })
  )
  expect(plan).toEqual({ attemptId: 'attempt-7', mode: 'sandbox', modDirs: ['/opt/kory-mods/alpha/fp', '/opt/kory-mods/beta/fp'], diagnostics: [] })
  expect(received!.attemptId).toBe('attempt-7')
  expect(received!.signal).toBe(controller.signal)
  expect(received!.verifyHostCopy).toBe(verify)
  expect(received!.copies).toEqual([
    { plugin: 'alpha', fingerprint: 'a'.repeat(64), hostDir: '/host/alpha' },
    { plugin: 'beta', fingerprint: 'b'.repeat(64), hostDir: '/host/beta' }
  ])
})

test('a sandbox plan keeps working-copy failures and preparation omissions, in that order', async () => {
  const plan = await prepareLaunchModPlan(
    deps({
      enabledModsFromLock: () => ['alpha', 'beta', 'gamma'],
      ensureModWorkingCopy: async ({ plugin }: { plugin: string }) =>
        plugin === 'alpha' ? { ok: false as const, reason: 'drifted' } : { ok: true as const, dir: `/host/${plugin}` },
      prepareMods: async (input: { copies: readonly { plugin: string }[] }) => ({
        ok: true as const,
        references: input.copies.filter((c) => c.plugin === 'beta').map((c) => ({ plugin: c.plugin, containerDir: '/opt/kory-mods/beta/fp' })),
        diagnostics: { omitted: [{ plugin: 'gamma', reason: 'collision' }] }
      })
    } as never),
    planInput({ sandboxed: true, lock: new Map([['alpha', 'a'.repeat(64)], ['beta', 'b'.repeat(64)], ['gamma', 'c'.repeat(64)]]) })
  )
  expect(plan).toEqual({
    attemptId: 'a',
    mode: 'sandbox',
    modDirs: ['/opt/kory-mods/beta/fp'],
    diagnostics: [{ plugin: 'alpha', reason: 'drifted' }, { plugin: 'gamma', reason: 'collision' }]
  })
})

test('a sandbox plan without a preparation service is refused rather than falling back to host paths', async () => {
  const plan = await prepareLaunchModPlan(deps(), planInput({ sandboxed: true }))
  expect(plan).toEqual({ attemptId: 'a', refused: 'sandbox-preparation-unavailable' })
})

test('an abort during the sandbox preparation refuses the plan', async () => {
  const controller = new AbortController()
  const plan = await prepareLaunchModPlan(
    deps({
      prepareMods: async () => {
        controller.abort()
        return { ok: true as const, references: [{ plugin: 'alpha', containerDir: '/opt/kory-mods/alpha/fp' }], diagnostics: { omitted: [] } }
      }
    }),
    planInput({ sandboxed: true, signal: controller.signal })
  )
  expect(plan).toEqual({ attemptId: 'a', refused: 'aborted' })
})

test('beginning a second attempt for a target cancels the first and only the second stays current', () => {
  const registry = new LaunchAttemptRegistry()
  const first = registry.begin('tile')
  const second = registry.begin('tile')
  expect(first.attemptId).not.toBe(second.attemptId)
  expect(first.signal.aborted).toBe(true)
  expect(second.signal.aborted).toBe(false)
  expect(registry.isCurrent(first.attemptId)).toBe(false)
  expect(registry.isCurrent(second.attemptId)).toBe(true)
})

test('cancelling one target leaves the attempts of the others current', () => {
  const registry = new LaunchAttemptRegistry()
  const a = registry.begin('tile-a')
  const b = registry.begin('tile-b')
  registry.cancel('tile-b')
  expect(b.signal.aborted).toBe(true)
  expect(registry.isCurrent(b.attemptId)).toBe(false)
  expect(a.signal.aborted, 'cancelling a later target must not touch the first one').toBe(false)
  expect(registry.isCurrent(a.attemptId)).toBe(true)
  registry.cancel('never-started')
  expect(registry.isCurrent(a.attemptId)).toBe(true)
})

test('cancelling all attempts aborts every signal and leaves none current', () => {
  const registry = new LaunchAttemptRegistry()
  const attempts = ['one', 'two', 'three'].map((key) => registry.begin(key))
  registry.cancelAll()
  for (const attempt of attempts) {
    expect(attempt.signal.aborted).toBe(true)
    expect(registry.isCurrent(attempt.attemptId)).toBe(false)
  }
})

test('an attempt is no longer current once its own signal is aborted', () => {
  const registry = new LaunchAttemptRegistry()
  const attempt = registry.begin('tile')
  expect(registry.isCurrent(attempt.attemptId)).toBe(true)
  registry.cancel('tile')
  expect(registry.isCurrent(attempt.attemptId)).toBe(false)
})

test('joined preparation is per target and runs again once the previous one settled', async () => {
  const registry = new LaunchAttemptRegistry()
  registry.begin('tile-a')
  registry.begin('tile-b')
  const runs: string[] = []
  const viaA = registry.join('tile-a', async () => { runs.push('a'); return 'a' })
  const viaB = registry.join('tile-b', async () => { runs.push('b'); return 'b' })
  expect(await Promise.all([viaA, viaB])).toEqual(['a', 'b'])
  expect(runs).toEqual(['a', 'b'])

  const again = await registry.join('tile-a', async () => { runs.push('a2'); return 'a2' })
  expect(again, 'a settled preparation must not be replayed to a later caller').toBe('a2')
  expect(runs).toEqual(['a', 'b', 'a2'])
})

test('a new attempt for a target does not inherit the preparation joined by the cancelled one', async () => {
  const registry = new LaunchAttemptRegistry()
  registry.begin('tile')
  let release!: (value: string) => void
  const stale = registry.join('tile', () => new Promise<string>((resolve) => { release = resolve }))
  registry.begin('tile')
  const fresh = await registry.join('tile', async () => 'fresh')
  release('stale')
  expect(await stale).toBe('stale')
  expect(fresh).toBe('fresh')
})

test('completing with a superseded attempt id removes nothing and the current attempt stays cancellable', () => {
  const registry = new LaunchAttemptRegistry()
  const stale = registry.begin('tile')
  const current = registry.begin('tile')

  registry.complete('tile', stale.attemptId)

  expect(registry.isCurrent(current.attemptId), 'a late finally of the replaced attempt must not unregister its successor').toBe(true)
  registry.cancel('tile')
  expect(current.signal.aborted, 'the successor must still be reachable by cancel after the stale complete').toBe(true)
})

test('completing the current attempt unregisters it, so repeated launches do not grow the registry', () => {
  const registry = new LaunchAttemptRegistry()
  const attempts = Array.from({ length: 50 }, (_, i) => registry.begin(`new:${i}`))
  for (const [i, attempt] of attempts.entries()) registry.complete(`new:${i}`, attempt.attemptId)

  expect((registry as unknown as { attempts: Map<string, unknown> }).attempts.size, 'a finished attempt must leave no entry behind').toBe(0)
  registry.cancelAll()
  expect(attempts.some((attempt) => attempt.signal.aborted), 'cancelAll must find nothing left to abort').toBe(false)
  expect(registry.isCurrent(attempts[0]!.attemptId)).toBe(false)
})

test('a join arriving while a multi-stage preparation is running gets the same promise, and one arriving after it settled starts a new run', async () => {
  const registry = new LaunchAttemptRegistry()
  const stages: Array<() => void> = []
  let runs = 0
  const prepare = async () => {
    runs++
    registry.begin('tile')
    await new Promise<void>((resolve) => stages.push(resolve))
    await new Promise<void>((resolve) => stages.push(resolve))
    return `run-${runs}`
  }

  const first = registry.join('tile', prepare)
  stages.shift()!()
  for (let i = 0; i < 20 && stages.length === 0; i++) await Promise.resolve()
  expect(stages.length, 'the preparation must have reached its second stage').toBe(1)
  const second = registry.join('tile', prepare)

  expect(second, 'the entry must outlive the first stage of the preparation').toBe(first)
  expect(runs).toBe(1)
  stages.shift()!()
  expect(await first).toBe('run-1')

  const third = registry.join('tile', async () => { runs++; registry.begin('tile'); return `run-${runs}` })
  expect(await third, 'a settled preparation must not be replayed').toBe('run-2')
})

test('a join after a preparation that failed starts a new run instead of replaying the failure', async () => {
  const registry = new LaunchAttemptRegistry()
  const failing = registry.join('tile', async () => {
    registry.begin('tile')
    throw new Error('copy failed')
  })
  await expect(failing).rejects.toThrow('copy failed')

  const next = await registry.join('tile', async () => {
    registry.begin('tile')
    return 'ok'
  })

  expect(next).toBe('ok')
})
