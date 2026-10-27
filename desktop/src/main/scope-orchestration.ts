import type { ScopeTarget } from './approval-runtime'
import { ScopeAdoption, type ScopeAdoptionResult, type ScopeApprovalRuntime } from './scope-adoption'

export interface ScopeRestoreRequest {
  groupId: string
  scopeKind: 'ephemeral' | 'custom'
}

export interface ScopeWiringDeps<Scope, Published = Scope> {
  approvals: ScopeApprovalRuntime
  currentScope: () => Scope
  hasLiveSessions: () => boolean
  resolveScope: (workspace: ScopeRestoreRequest) => Scope
  toScopeTarget: (scope: Scope) => ScopeTarget
  publishScope: (scope: Scope, previous: Scope) => Published
  afterScopePublished: (previous: Published) => void
  scopeEnvironment: () => Record<string, string>
  approvalEnvironment: () => Record<string, string>
  designEnvironment: () => Record<string, string>
  onCleanupError: (error: unknown) => void
}

export function publishScopeAfterAdoption<T>(
  result: ScopeAdoptionResult,
  next: T,
  publish: (scope: T) => void
): boolean {
  if (result.state !== 'published') return false
  publish(next)
  return true
}

export function captureSpawnEnvironment<T>(capture: () => void, environment: () => T): () => T {
  return () => {
    capture()
    return environment()
  }
}

export function scopeMayChange(hasLiveSessions: () => boolean): () => boolean {
  return () => !hasLiveSessions()
}

export function createScopeWiring<Scope, Published>(deps: ScopeWiringDeps<Scope, Published>) {
  const scopeAdoption = new ScopeAdoption({
    approvals: deps.approvals,
    publishedScope: deps.toScopeTarget(deps.currentScope()),
    mayChangeScope: scopeMayChange(deps.hasLiveSessions),
    onCleanupError: deps.onCleanupError
  })
  const spawnEnvironment = captureSpawnEnvironment(
    () => scopeAdoption.captureSpawnContext(),
    () => ({ ...deps.scopeEnvironment(), ...deps.approvalEnvironment(), ...deps.designEnvironment() })
  )
  let epoch = 0
  const adoptScope = async (workspace: ScopeRestoreRequest, own: () => boolean): Promise<ScopeAdoptionResult> => {
    const previous = deps.currentScope()
    const previousTarget = deps.toScopeTarget(previous)
    const next = deps.resolveScope(workspace)
    const nextTarget = deps.toScopeTarget(next)
    let published: Published | null = null
    const result = await scopeAdoption.adopt(nextTarget, own, (adopted) => {
      if (
        (adopted.projectKey === previousTarget.projectKey && adopted.groupId === previousTarget.groupId) ||
        adopted.projectKey !== nextTarget.projectKey ||
        adopted.groupId !== nextTarget.groupId
      ) return
      published = deps.publishScope(next, previous)
      epoch += 1
    })
    if (published !== null) deps.afterScopePublished(published)
    return result
  }

  return {
    spawnEnvironment,
    adoptScope,
    scopeEpoch: () => epoch,
    cancelScopeAdoption: () => scopeAdoption.cancel(),
    closeScopeAdoption: () => scopeAdoption.close()
  }
}
