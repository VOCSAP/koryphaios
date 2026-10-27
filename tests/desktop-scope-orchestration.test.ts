import { expect, test } from 'bun:test'
import { createScopeWiring, scopeMayChange, type ScopeWiringDeps } from '../desktop/src/main/scope-orchestration'
import { reachedWithin } from './_bounded-await'

type Scope = { projectKey: string; groupId: string }

const published: Scope = { projectKey: 'project', groupId: 'published' }
const candidate: Scope = { projectKey: 'project', groupId: 'candidate' }

function readyPreparation(target: Scope, events: string[]) {
  const preparation = {
    state: 'ready' as const,
    target,
    canPublish: () => true,
    install: () => preparation,
    publish: () => events.push('publish'),
    abandon: async () => { events.push('abandon') }
  }
  return preparation
}

function wiringDeps(overrides: Partial<ScopeWiringDeps<Scope>> = {}): ScopeWiringDeps<Scope> {
  let live = false
  return {
    approvals: {
      prepareScope: async (target) => readyPreparation(target, []),
      whenPreparationSettled: async () => {}
    },
    currentScope: () => published,
    hasLiveSessions: () => live,
    resolveScope: () => candidate,
    toScopeTarget: (scope) => scope,
    publishScope: () => published,
    afterScopePublished: () => {},
    scopeEnvironment: () => ({ SCOPE: 'published' }),
    approvalEnvironment: () => ({ APPROVAL: 'ready' }),
    designEnvironment: () => ({ DESIGN: 'ready' }),
    onCleanupError: () => {},
    ...overrides
  }
}

test('scope changes are refused while sessions are live', () => {
  let live = true
  const mayChangeScope = scopeMayChange(() => live)

  expect(mayChangeScope()).toBe(false)
  live = false
  expect(mayChangeScope()).toBe(true)
})

test('a spawn captures the published scope and supersedes a pending adoption', async () => {
  const wiring = createScopeWiring(wiringDeps({
    approvals: {
      prepareScope: () => new Promise(() => {}),
      whenPreparationSettled: async () => {}
    }
  }))

  const adoption = wiring.adoptScope(candidate, () => true)
  expect(wiring.spawnEnvironment()).toEqual({ SCOPE: 'published', APPROVAL: 'ready', DESIGN: 'ready' })
  const result = await reachedWithin(adoption, 'spawn supersedes pending adoption', 1500)
  expect(result).toEqual({ state: 'superseded' })
})

test('a successful adoption publishes the scope before running its post-publication cleanup', async () => {
  const events: string[] = []
  const wiring = createScopeWiring(wiringDeps({
    approvals: {
      prepareScope: async (target) => readyPreparation(target, events),
      whenPreparationSettled: async () => {}
    },
    publishScope: (scope) => {
      events.push(`scope:${scope.groupId}`)
      return published
    },
    afterScopePublished: (previous) => events.push(`cleanup:${previous.groupId}`)
  }))

  await expect(wiring.adoptScope(candidate, () => true)).resolves.toEqual({ state: 'published', scope: candidate })
  expect(events).toEqual(['publish', 'scope:candidate', 'cleanup:published'])
})

test('a spawn queued by credential publication sees the newly published scope', async () => {
  let active = published
  let wiring: ReturnType<typeof createScopeWiring<Scope, Scope>>
  let captured: Record<string, string> | undefined
  const preparation = {
    state: 'ready' as const,
    target: candidate,
    canPublish: () => true,
    install: () => preparation,
    publish: () => queueMicrotask(() => { captured = wiring.spawnEnvironment() }),
    abandon: async () => {}
  }
  wiring = createScopeWiring(wiringDeps({
    approvals: {
      prepareScope: async () => preparation,
      whenPreparationSettled: async () => {}
    },
    currentScope: () => active,
    publishScope: (scope) => {
      const previous = active
      active = scope
      return previous
    },
    scopeEnvironment: () => ({ SCOPE: active.groupId })
  }))

  await expect(wiring.adoptScope(candidate, () => true)).resolves.toEqual({ state: 'published', scope: candidate })
  await Promise.resolve()
  expect(captured).toEqual({ SCOPE: 'candidate', APPROVAL: 'ready', DESIGN: 'ready' })
})

test('live sessions retain the published scope without preparing a candidate', async () => {
  const events: string[] = []
  const wiring = createScopeWiring(wiringDeps({
    hasLiveSessions: () => true,
    approvals: {
      prepareScope: async () => {
        throw new Error('candidate preparation must not run')
      },
      publishedRootStatus: (target) => target.groupId === published.groupId ? 'ready' : 'missing',
      whenPreparationSettled: async () => {}
    },
    publishScope: () => {
      events.push('scope')
      return published
    }
  }))

  await expect(wiring.adoptScope(candidate, () => true)).resolves.toEqual({ state: 'published', scope: published })
  expect(events).toEqual([])
  expect(wiring.scopeEpoch(), 'no publication, no epoch change').toBe(0)
})

test('the scope epoch advances once per publication and not otherwise', async () => {
  const wiring = createScopeWiring(wiringDeps())

  expect(wiring.scopeEpoch()).toBe(0)
  await expect(wiring.adoptScope(candidate, () => true)).resolves.toEqual({ state: 'published', scope: candidate })
  expect(wiring.scopeEpoch(), 'a published adoption bumps the epoch').toBe(1)
})

test('an adoption of the active scope does not republish or clean it up', async () => {
  const events: string[] = []
  const wiring = createScopeWiring(wiringDeps({
    resolveScope: () => published,
    approvals: {
      prepareScope: async () => {
        throw new Error('active scope preparation must not run')
      },
      publishedRootStatus: () => 'ready',
      whenPreparationSettled: async () => {}
    },
    publishScope: () => {
      events.push('scope')
      return published
    },
    afterScopePublished: () => events.push('cleanup')
  }))

  await expect(wiring.adoptScope(published, () => true)).resolves.toEqual({ state: 'published', scope: published })
  expect(events).toEqual([])
})

test('re-preparing the active scope after its root went missing neither republishes nor cleans it up', async () => {
  const events: string[] = []
  const wiring = createScopeWiring(wiringDeps({
    resolveScope: () => published,
    approvals: {
      prepareScope: async (target) => readyPreparation(target, []),
      publishedRootStatus: () => 'missing',
      whenPreparationSettled: async () => {}
    },
    publishScope: () => {
      events.push('scope')
      return published
    },
    afterScopePublished: () => events.push('cleanup')
  }))

  await expect(wiring.adoptScope(published, () => true)).resolves.toEqual({ state: 'published', scope: published })
  expect(events, 'cleaning up the previous scope here would remove the live group state').toEqual([])
  expect(wiring.scopeEpoch()).toBe(0)
})
