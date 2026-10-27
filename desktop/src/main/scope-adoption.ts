import type { PublishedRootStatus, RootPreparation, ScopeRefusalCause, ScopeTarget } from "./approval-runtime.ts"

export const RESCOPE_WAIT_MS = 5_000

export interface ScopeApprovalRuntime {
  prepareScope(target: ScopeTarget): Promise<RootPreparation>
  recoverPublishedScope?(target: ScopeTarget): Promise<boolean>
  publishedRootStatus?(target: ScopeTarget): PublishedRootStatus
  whenPreparationSettled(signal?: AbortSignal): Promise<void>
}

export interface ScopeAdoptionOptions {
  approvals: ScopeApprovalRuntime
  publishedScope: ScopeTarget
  mayChangeScope?: () => boolean
  now?: () => number
  waitUntil?: (deadline: number) => Promise<void>
  onCleanupError(error: unknown): void
}

export class ScopeCommitInvariantError extends Error {
  constructor(readonly cause: unknown) {
    super("prepared root could not publish after workspace acquisition")
  }
}

export type ScopeAdoptionResult =
  | { state: "published"; scope: ScopeTarget }
  | { state: "busy" }
  | { state: "superseded" }
  | { state: "closed" }
  | { state: "lock-race" }
  | { state: "credential-timed-out" }
  | { state: "credential-unavailable"; cause: ScopeRefusalCause }

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

type Invalidation = Extract<ScopeAdoptionResult, { state: "superseded" | "closed" | "credential-timed-out" }>

interface Ticket {
  target: Readonly<ScopeTarget>
  stop: Deferred<Invalidation>
  invalidated: Invalidation | null
  preparation: RootPreparation | null
  cleanup: Promise<void> | null
  published: boolean
  recoverPublishedRoot: boolean
}

type WaitResult =
  | { kind: "preparation"; preparation: RootPreparation }
  | { kind: "settled" }
  | { kind: "deadline" }
  | { kind: "stopped"; result: Invalidation }

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function snapshot(scope: ScopeTarget): Readonly<ScopeTarget> {
  return Object.freeze({ projectKey: scope.projectKey, groupId: scope.groupId })
}

function sameScope(left: ScopeTarget, right: ScopeTarget): boolean {
  return left.projectKey === right.projectKey && left.groupId === right.groupId
}

function defaultWaitUntil(deadline: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))
}

export class ScopeAdoption {
  private scopeSnapshot: Readonly<ScopeTarget>
  private active: Ticket | null = null
  private closed = false

  constructor(private readonly options: ScopeAdoptionOptions) {
    this.scopeSnapshot = snapshot(options.publishedScope)
  }

  scope(): ScopeTarget {
    return { ...this.scopeSnapshot }
  }

  captureSpawnContext(): ScopeTarget {
    const ticket = this.active
    if (ticket && !sameScope(ticket.target, this.scopeSnapshot)) this.invalidate(ticket, { state: "superseded" })
    return this.scope()
  }

  cancel(): void {
    if (this.active) this.invalidate(this.active, { state: "superseded" })
  }

  close(): void {
    this.closed = true
    if (this.active) this.invalidate(this.active, { state: "closed" })
  }

  async adopt(
    target: ScopeTarget,
    own: () => boolean,
    onPublished?: (scope: ScopeTarget) => void
  ): Promise<ScopeAdoptionResult> {
    if (this.closed) return { state: "closed" }
    if (this.active) return { state: "busy" }
    const effectiveTarget = this.options.mayChangeScope?.() === false ? this.scopeSnapshot : snapshot(target)
    const rootStatus = this.options.approvals.publishedRootStatus?.(effectiveTarget)
    const publishedRootStatus = this.options.approvals.publishedRootStatus?.(this.scopeSnapshot)
    if (sameScope(effectiveTarget, this.scopeSnapshot) && rootStatus === "ready") {
      return own() ? { state: "published", scope: this.scope() } : { state: "lock-race" }
    }

    const ticket: Ticket = {
      target: effectiveTarget,
      stop: deferred<Invalidation>(),
      invalidated: null,
      preparation: null,
      cleanup: null,
      published: false,
      recoverPublishedRoot: publishedRootStatus === "ready",
    }
    this.active = ticket
    const deadline = (this.options.now ?? Date.now)() + RESCOPE_WAIT_MS
    const waitUntil = this.options.waitUntil ?? defaultWaitUntil
    const deadlineWait: Promise<WaitResult> = waitUntil(deadline).then(() => ({ kind: "deadline" }))
    const stopped: Promise<WaitResult> = ticket.stop.promise.then((result) => ({ kind: "stopped", result }))

    if (sameScope(ticket.target, this.scopeSnapshot) && rootStatus === "pending") {
      const controller = new AbortController()
      void ticket.stop.promise.then(() => controller.abort())
      let result: WaitResult
      try {
        result = await Promise.race<WaitResult>([
          this.options.approvals.whenPreparationSettled(controller.signal).then(() => ({ kind: "settled" })),
          deadlineWait,
          stopped,
        ])
      } catch (error) {
        this.options.onCleanupError(error)
        return this.finish(ticket, { state: "credential-unavailable", cause: "mint-refused" })
      }
      if (result.kind === "deadline") {
        this.invalidate(ticket, { state: "credential-timed-out" })
        return this.finish(ticket, { state: "credential-timed-out" })
      }
      if (result.kind === "stopped") return this.finish(ticket, result.result)

      const current = this.current(ticket, deadline)
      if (current) return this.finish(ticket, current)
      const settledStatus = this.options.approvals.publishedRootStatus?.(ticket.target)
      if (settledStatus === "ready") {
        return this.finish(ticket, own() ? { state: "published", scope: this.scope() } : { state: "lock-race" })
      }
      if (settledStatus !== "missing") return this.finish(ticket, { state: "credential-unavailable", cause: "mint-refused" })
    }

    const preparation = this.options.approvals.prepareScope(ticket.target).then(
      (prepared) => {
        ticket.preparation = prepared
        if (ticket.invalidated) this.cleanup(ticket)
        return prepared
      },
      (error: unknown) => {
        this.options.onCleanupError(error)
        throw error
      },
    )

    let result: WaitResult
    try {
      result = await Promise.race<WaitResult>([
        preparation.then((prepared) => ({ kind: "preparation", preparation: prepared })),
        deadlineWait,
        stopped,
      ])
    } catch (error) {
      if (this.active === ticket) this.active = null
      throw error
    }

    if (result.kind === "deadline") {
      this.invalidate(ticket, { state: "credential-timed-out" })
      return this.finish(ticket, { state: "credential-timed-out" })
    }
    if (result.kind === "stopped") return this.finish(ticket, result.result)
    if (result.kind === "settled") return this.finish(ticket, { state: "credential-unavailable", cause: "mint-refused" })

    if (result.preparation.state === "refused") {
      this.invalidate(ticket, { state: "superseded" })
      return this.finish(ticket, { state: "credential-unavailable", cause: result.preparation.cause })
    }

    const current = this.current(ticket, deadline)
    if (current) return this.finish(ticket, current)
    if (!sameScope(ticket.target, this.scopeSnapshot) && this.options.mayChangeScope?.() === false) {
      this.invalidate(ticket, { state: "superseded" })
      return this.finish(ticket, { state: "superseded" })
    }
    if (!result.preparation.canPublish()) return this.finish(ticket, { state: "credential-unavailable", cause: "mint-refused" })

    const installed = result.preparation.install()
    if (installed.state === "refused") {
      this.invalidate(ticket, { state: "superseded" })
      return this.finish(ticket, { state: "credential-unavailable", cause: installed.cause })
    }

    const afterInstall = this.current(ticket, deadline)
    if (afterInstall) return this.finish(ticket, afterInstall)
    if (!own()) return this.finish(ticket, { state: "lock-race" })

    try {
      result.preparation.publish()
      ticket.published = true
      onPublished?.(ticket.target)
    } catch (error) {
      this.options.onCleanupError(error)
      this.cleanup(ticket)
      if (this.active === ticket) this.active = null
      throw new ScopeCommitInvariantError(error)
    }
    this.scopeSnapshot = ticket.target
    if (this.active === ticket) this.active = null
    return { state: "published", scope: this.scope() }
  }

  private current(ticket: Ticket, deadline: number): Invalidation | null {
    if (this.closed) return { state: "closed" }
    if (ticket.invalidated) return ticket.invalidated
    if ((this.options.now ?? Date.now)() >= deadline) return { state: "credential-timed-out" }
    return null
  }

  private invalidate(ticket: Ticket, result: Invalidation): void {
    if (ticket.invalidated) return
    ticket.invalidated = result
    ticket.stop.resolve(result)
  }

  private finish(ticket: Ticket, result: ScopeAdoptionResult): ScopeAdoptionResult {
    this.cleanup(ticket)
    if (this.active === ticket) this.active = null
    return result
  }

  private cleanup(ticket: Ticket): void {
    if (ticket.published || ticket.cleanup || !ticket.preparation) return
    ticket.cleanup = ticket.preparation.abandon().then(async () => {
      if (this.closed || this.active || !ticket.recoverPublishedRoot || sameScope(ticket.target, this.scopeSnapshot)) return
      await this.options.approvals.recoverPublishedScope?.(this.scopeSnapshot)
    })
    void ticket.cleanup.catch((error: unknown) => this.options.onCleanupError(error))
  }
}
