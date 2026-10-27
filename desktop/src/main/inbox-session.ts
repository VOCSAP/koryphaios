import { randomUUID } from 'node:crypto'
import type { RunInboxSigner } from './broker-client'
import { appendInboxHistory, clearInboxHistory, deleteInboxHistoryEntries } from './inbox-store'
import type { SessionDirAccessor } from './session-state'
import type { InboxMessage } from '../shared/types'

/**
 * The run signer for the inbox of the ACTIVE group, or undefined: a run
 * credential prepared for another group but not yet published never signs a
 * read or a purge of this one.
 */
export function createRunInboxSigner<Identity>(deps: {
  inboxRun: () => { runRef: string; groupId: string } | null
  operator: () => Identity | null
  activeGroupId: () => string
  sign: (identity: Identity, body: Record<string, unknown>, door: 'drain' | 'purge') => unknown
}): () => RunInboxSigner | undefined {
  return () => {
    const run = deps.inboxRun()
    const identity = deps.operator()
    if (!run || identity === null || run.groupId !== deps.activeGroupId()) return undefined
    return { runRef: run.runRef, sign: (body, door) => deps.sign(identity, body, door) }
  }
}

export async function purgeInboxDomains(deps: {
  purge: (run?: RunInboxSigner) => Promise<number>
  run: RunInboxSigner | undefined
  onRejection: (domain: 'legacy' | 'run', e: unknown) => void
}): Promise<number> {
  const domains: Array<['legacy' | 'run', Promise<number>]> = [['legacy', deps.purge()]]
  if (deps.run) domains.push(['run', deps.purge(deps.run)])
  const outcomes = await Promise.allSettled(domains.map(([, p]) => p))
  let deleted = 0
  outcomes.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') deleted += outcome.value
    else deps.onRejection(domains[i]![0], outcome.reason)
  })
  return deleted
}

export function createRunReadErrorSink(report: (message: string, e: unknown) => void): {
  onRunError: (e: unknown) => void
  onRunSuccess: () => void
} {
  let last: string | null = null
  return {
    onRunError: (e) => {
      const text = e instanceof Error ? e.message : String(e)
      if (text === last) return
      last = text
      report('the run-scoped Courrier read failed; messages attested for this run are not shown', e)
    },
    onRunSuccess: () => {
      last = null
    }
  }
}

/**
 * In-memory only, never persisted: a value written to disk would collide
 * between two Deck windows of the same OS account, which is a nominal case
 * here.
 * Re-minted on group change, not just at process launch, since the broker's
 * session upsert does not migrate a session_id's group_id on conflict --
 * reusing the same id across a group switch would silently read/write the wrong
 * group's cursor.
 */
export function createInboxSessionTracker(getGroupId: () => string): () => string {
  let sessionId = randomUUID()
  let sessionGroupId = getGroupId()
  return function currentInboxSessionId(): string {
    const groupId = getGroupId()
    if (sessionGroupId !== groupId) {
      sessionId = randomUUID()
      sessionGroupId = groupId
    }
    return sessionId
  }
}

export interface InboxEffectsScope {
  epoch: number
  groupId: string
  sessionId: string
  directory: string
}

/**
 * The directory is not compared: effects land in the captured one, so a
 * result is only ever applied to the context it was read for.
 */
export function applyInboxEffectsForScope<T>(
  captured: InboxEffectsScope,
  current: () => InboxEffectsScope,
  apply: (context: InboxEffectsScope) => T
): T | false {
  const active = current()
  if (
    active.epoch !== captured.epoch ||
    active.groupId !== captured.groupId ||
    active.sessionId !== captured.sessionId
  ) return false
  return apply(captured)
}

export async function pollInboxForCapturedScope<T>(deps: {
  context: () => InboxEffectsScope
  read: (captured: InboxEffectsScope) => Promise<T>
  apply: (result: T, captured: InboxEffectsScope) => void
  onDiscard: (captured: InboxEffectsScope, current: InboxEffectsScope) => void
}): Promise<void> {
  const captured = deps.context()
  const result = await deps.read(captured)
  const applied = applyInboxEffectsForScope(captured, deps.context, (context) => {
    deps.apply(result, context)
    return true
  })
  if (applied === false) deps.onDiscard(captured, deps.context())
}

export function mergeInboxReads<T extends { id: number }>(legacy: readonly T[], run: readonly T[]): T[] {
  const byId = new Map<number, T>()
  for (const message of legacy) byId.set(message.id, message)
  for (const message of run) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

export async function readOperatorInboxBoth<T extends { id: number }>(deps: {
  readLegacy: () => Promise<T[]>
  readRun?: () => Promise<T[]>
  onRunError: (e: unknown) => void
}): Promise<T[]> {
  const legacy = await deps.readLegacy()
  if (!deps.readRun) return legacy
  try {
    return mergeInboxReads(legacy, await deps.readRun())
  } catch (e) {
    deps.onRunError(e)
    return legacy
  }
}

export async function purgeInboxSessionCore(deps: {
  context: () => InboxEffectsScope
  purgeBroker: () => Promise<void>
  clearLocal: (captured: InboxEffectsScope) => void
  onPurgeError: (e: unknown) => void
}): Promise<void> {
  const captured = deps.context()
  try {
    await deps.purgeBroker()
  } catch (e) {
    deps.onPurgeError(e)
  }
  deps.clearLocal(captured)
}

/** Returns the broker-side delete count; the local removal always runs, on the context read before the await. */
export async function deleteInboxEntriesCore(deps: {
  context: () => InboxEffectsScope
  deleteBroker: () => Promise<number>
  deleteLocal: (captured: InboxEffectsScope) => void
  onDeleteError: (e: unknown) => void
}): Promise<number> {
  const captured = deps.context()
  let deleted = 0
  try {
    deleted = await deps.deleteBroker()
  } catch (e) {
    deps.onDeleteError(e)
  }
  deps.deleteLocal(captured)
  return deleted
}

/**
 * Filters to Number.isInteger elements: a non-integer id would otherwise no-op
 * silently both broker-side (deleted: 0) and locally (Set membership never
 * matches).
 * A non-empty input that filters down to nothing is `rejected: true`,
 * distinguishable from a genuinely empty input (`valid: [], rejected: false`).
 */
export function classifyInboxDeleteIds(raw: unknown): { valid: number[]; rejected: boolean } {
  if (!Array.isArray(raw)) return { valid: [], rejected: false }
  const valid = raw.filter((id): id is number => Number.isInteger(id))
  return { valid, rejected: raw.length > 0 && valid.length === 0 }
}

export interface InboxWireRow {
  id: number
  from_peer_id: string
  text: string
  sent_at: string
}

export interface InboxEffectsDeps {
  sessionDir: SessionDirAccessor
  epoch: () => number
  groupId: () => string
  sessionId: () => string
  purgeBroker: () => Promise<void>
  deleteBroker: (ids: number[]) => Promise<number>
  broadcast: (channel: 'inbox:new' | 'inbox:cleared', payload?: unknown) => void
  notify: (batch: InboxMessage[]) => void
  info: (message: string) => void
  error: (message: string, e: unknown) => void
}

export interface InboxEffects {
  poll: (read: (captured: InboxEffectsScope) => Promise<InboxWireRow[]>) => Promise<void>
  purge: () => Promise<void>
  delete: (ids: number[]) => Promise<number>
  /** Journal-write retries that belong to the current scope. */
  pendingMessages: () => InboxMessage[]
}

/**
 * Composition of the Courrier poll, session purge and manual delete. The
 * scope, directory included, is captured before each broker await, and the
 * store is only written while that scope is still the live one.
 */
export function createInboxEffects(deps: InboxEffectsDeps): InboxEffects {
  const retry: Array<{ epoch: number; message: InboxMessage }> = []

  const context = (): InboxEffectsScope => ({
    epoch: deps.epoch(),
    groupId: deps.groupId(),
    sessionId: deps.sessionId(),
    directory: deps.sessionDir.isClosed() ? '' : deps.sessionDir()
  })

  const writable = (sink: string): boolean => {
    if (!deps.sessionDir.isClosed()) return true
    deps.info(`Courrier ${sink} skipped: the session state is closed`)
    return false
  }

  const dropRetry = (epoch: number, ids?: ReadonlySet<number>): void => {
    for (let i = retry.length - 1; i >= 0; i--) {
      const q = retry[i]!
      if (q.epoch === epoch && (ids === undefined || ids.has(q.message.id))) retry.splice(i, 1)
    }
  }

  const writeInCapturedScope = (captured: InboxEffectsScope, sink: string, write: () => void): void => {
    if (!writable(sink)) return
    const applied = applyInboxEffectsForScope(captured, context, () => {
      write()
      return true
    })
    if (applied === false) {
      deps.info(`Courrier ${sink} skipped: the scope changed during the broker call (epoch ${captured.epoch} -> ${deps.epoch()})`)
    }
  }

  const poll: InboxEffects['poll'] = (read) =>
    pollInboxForCapturedScope({
      context,
      read,
      apply: (rows, captured) => {
        if (rows.length === 0 && retry.length === 0) return
        if (!writable('history append')) return
        const batch: InboxMessage[] = rows.map((m) => ({ id: m.id, from: m.from_peer_id, text: m.text, sentAt: m.sent_at }))
        const queued = retry.splice(0)
        const replay = queued.filter((q) => q.epoch === captured.epoch)
        if (replay.length < queued.length) {
          deps.info(`Courrier retry queue: ${queued.length - replay.length} entries queued under another scope dropped`)
        }
        const messages = [...replay.map((q) => q.message), ...batch]
        if (messages.length === 0) return
        let failed = false
        appendInboxHistory(captured.directory, messages, undefined, (e) => {
          failed = true
          deps.error(`history write failed (${messages.length} message(s) queued for retry)`, e)
        })
        if (failed) retry.push(...messages.map((message) => ({ epoch: captured.epoch, message })))
        if (batch.length === 0) return
        deps.broadcast('inbox:new', batch)
        deps.notify(batch)
      },
      onDiscard: (captured, current) =>
        deps.info(
          `Courrier poll result dropped: published context changed during the read (epoch ${captured.epoch} -> ${current.epoch}, group ${captured.groupId} -> ${current.groupId})`
        )
    })

  const purge = async (): Promise<void> => {
    await purgeInboxSessionCore({
      context,
      purgeBroker: deps.purgeBroker,
      clearLocal: (captured) => {
        dropRetry(captured.epoch)
        writeInCapturedScope(captured, 'history truncate', () =>
          clearInboxHistory(captured.directory, (e) => deps.error('local history truncate failed after session purge', e))
        )
      },
      onPurgeError: (e) => deps.error('session purge failed (broker-side Courrier may keep stale rows)', e)
    })
    deps.broadcast('inbox:cleared')
  }

  const remove = async (ids: number[]): Promise<number> => {
    const deleted = await deleteInboxEntriesCore({
      context,
      deleteBroker: () => deps.deleteBroker(ids),
      deleteLocal: (captured) => {
        dropRetry(captured.epoch, new Set(ids))
        writeInCapturedScope(captured, 'history entry removal', () =>
          deleteInboxHistoryEntries(captured.directory, ids, (e) => deps.error('local history entry removal failed after manual delete', e))
        )
      },
      onDeleteError: (e) => deps.error(`manual delete failed for ${ids.length} id(s)`, e)
    })
    deps.broadcast('inbox:cleared')
    return deleted
  }

  return {
    poll,
    purge,
    delete: remove,
    pendingMessages: () => {
      const epoch = deps.epoch()
      return retry.filter((q) => q.epoch === epoch).map((q) => q.message)
    }
  }
}
