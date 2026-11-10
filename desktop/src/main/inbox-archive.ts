import { inboxEntryKey } from '../shared/types'
import type { Approval, InboxArchiveSnapshot, InboxCloseAuthority, InboxEntryState } from '../shared/types'

const STATES: ReadonlySet<unknown> = new Set(['open', 'responded', 'closed'])
const AUTHORITIES: ReadonlySet<unknown> = new Set<InboxCloseAuthority>(['author', 'lead', 'supervisor'])
const REASON_MAX_CODE_POINTS = 500
const PEER_ID_MAX = 64
const SENT_AT_MAX = 64

export interface InboxArchiveDeps {
  onChange: (snapshot: InboxArchiveSnapshot) => void
  report: (message: string, e?: unknown) => void
}

export interface InboxArchive {
  /**
   * `entries` undefined: the broker answered the run read without the field.
   * `seq` is taken when the read STARTS; a snapshot older than the last applied
   * one of the same scope is ignored.
   */
  applyMessageStates: (scopeKey: string, entries: unknown, seq: number) => void
  applyClosedQuestions: (scopeKey: string, list: readonly Approval[], seq: number) => void
  snapshot: () => InboxArchiveSnapshot
  /** Bumped on every change, so a cache keyed on the archive notices it. */
  version: () => number
}

interface EntryRow {
  key: string
  state: InboxEntryState
}

/** A broker row reduced to the display state, or null when its shape is not the contract's. */
function parseEntryRow(raw: unknown): EntryRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.message_id !== 'number' || !Number.isInteger(r.message_id)) return null
  if (typeof r.sent_at !== 'string' || r.sent_at.length < 1 || r.sent_at.length > SENT_AT_MAX) return null
  if (!STATES.has(r.state)) return null
  if (r.settled_at !== null && typeof r.settled_at !== 'string') return null
  const state: InboxEntryState = { state: r.state as InboxEntryState['state'], settledAt: r.settled_at }
  if (r.close_reason !== undefined) {
    if (typeof r.close_reason !== 'string' || [...r.close_reason].length > REASON_MAX_CODE_POINTS) return null
    state.closeReason = r.close_reason
  }
  if (r.closed_by_authority !== undefined) {
    if (!AUTHORITIES.has(r.closed_by_authority)) return null
    state.closedByAuthority = r.closed_by_authority as InboxCloseAuthority
  }
  if (r.closed_by_peer_id !== undefined) {
    if (r.closed_by_peer_id !== null && (typeof r.closed_by_peer_id !== 'string' || r.closed_by_peer_id.length > PEER_ID_MAX)) {
      return null
    }
    state.closedByPeerId = r.closed_by_peer_id
  }
  const key = inboxEntryKey({
    kind: 'message',
    message: { id: r.message_id, from: '', text: '', sentAt: r.sent_at }
  })
  return { key, state }
}

/**
 * A copy of a closed question whose agent-supplied closure fields are within
 * their bounds; an out-of-bounds field is blanked and counted.
 */
function boundClosure(a: Approval): { approval: Approval; blanked: number } {
  const approval = { ...a }
  let blanked = 0
  if (approval.close_reason !== undefined && (typeof approval.close_reason !== 'string' || [...approval.close_reason].length > REASON_MAX_CODE_POINTS)) {
    delete approval.close_reason
    blanked++
  }
  if (approval.closed_by_authority !== undefined && !AUTHORITIES.has(approval.closed_by_authority)) {
    delete approval.closed_by_authority
    blanked++
  }
  const peer = approval.closed_by_peer_id
  if (peer !== undefined && peer !== null && (typeof peer !== 'string' || peer.length > PEER_ID_MAX)) {
    delete approval.closed_by_peer_id
    blanked++
  }
  return { approval, blanked }
}

export interface ApprovalListsIo<Deps> {
  deps: () => Deps | null
  /** `epoch:groupId:runRef`, or null while no run is published. */
  scopeKey: () => string | null
  fetchClosed: (deps: Deps) => Promise<Approval[]>
  applyClosed: (scopeKey: string, list: Approval[], seq: number) => void
  nextSeq: () => number
  pending: () => Promise<void>
  report: (message: string, e: unknown) => void
}

/**
 * One tick of the approval lists: the closed list is read and applied BEFORE
 * the pending one starts, so the closed copy of a question is broadcast before
 * its pending copy disappears and an open modal on it never closes in between.
 * A closed list is applied only if the scope is the one it was read for.
 * A failure is reported once until a tick succeeds again.
 */
export function createApprovalListsTick<Deps>(io: ApprovalListsIo<Deps>): () => Promise<void> {
  let failing = false
  const closed = async (): Promise<void> => {
    const seq = io.nextSeq()
    const deps = io.deps()
    const scope = io.scopeKey()
    if (!deps || scope === null) return
    try {
      const list = await io.fetchClosed(deps)
      failing = false
      if (io.scopeKey() === scope) io.applyClosed(scope, list, seq)
    } catch (e) {
      if (failing) return
      failing = true
      io.report('closed questions poll failed; closed questions may be stale in the Courrier', e)
    }
  }
  return async () => {
    await closed()
    await io.pending()
  }
}

const EMPTY: InboxArchiveSnapshot = { status: 'pending', messages: {}, closedQuestions: [] }

/**
 * The archive of the current run's settled entries. Each half is REPLACED by
 * its own read, never merged, and a read under another scope key starts from
 * an empty archive so nothing of the previous run or group survives into the
 * next one.
 */
export function createInboxArchive(deps: InboxArchiveDeps): InboxArchive {
  let scopeKey: string | null = null
  let current: InboxArchiveSnapshot = EMPTY
  let signature = JSON.stringify(current)
  let version = 0
  let unsupportedReported = false
  let messageSeq = 0
  let closedSeq = 0
  let lastMessageDropped = 0
  let lastClosedDropped = 0

  const publish = (next: InboxArchiveSnapshot): void => {
    current = next
    const nextSignature = JSON.stringify(next)
    if (nextSignature === signature) return
    signature = nextSignature
    version++
    deps.onChange(next)
  }

  const enter = (key: string): void => {
    if (scopeKey === key) return
    scopeKey = key
    unsupportedReported = false
    messageSeq = 0
    closedSeq = 0
    lastMessageDropped = 0
    lastClosedDropped = 0
    publish(EMPTY)
  }

  return {
    applyMessageStates: (key, entries, seq) => {
      enter(key)
      if (seq < messageSeq) return
      messageSeq = seq
      if (entries === undefined || !Array.isArray(entries)) {
        if (!unsupportedReported) {
          unsupportedReported = true
          deps.report(
            entries === undefined
              ? 'the broker does not report the state of Courrier entries: closures are not shown'
              : 'the broker sent Courrier entry states that are not a list: closures are not shown'
          )
        }
        publish({ status: 'unsupported', messages: {}, closedQuestions: current.closedQuestions })
        return
      }
      unsupportedReported = false
      const messages: Record<string, InboxEntryState> = {}
      let dropped = 0
      for (const raw of entries) {
        const row = parseEntryRow(raw)
        if (row) messages[row.key] = row.state
        else dropped++
      }
      if (dropped > 0 && dropped !== lastMessageDropped) {
        deps.report(`${dropped} Courrier entry state(s) from the broker had an invalid shape and were dropped`)
      }
      lastMessageDropped = dropped
      publish({ status: 'ready', messages, closedQuestions: current.closedQuestions })
    },
    applyClosedQuestions: (key, list, seq) => {
      enter(key)
      if (seq < closedSeq) return
      closedSeq = seq
      const closedQuestions: Approval[] = []
      let dropped = 0
      for (const a of list) {
        if (typeof a?.id !== 'string' || a.status !== 'closed') {
          dropped++
          continue
        }
        const bounded = boundClosure(a)
        dropped += bounded.blanked
        closedQuestions.push(bounded.approval)
      }
      if (dropped > 0 && dropped !== lastClosedDropped) {
        deps.report(`${dropped} closed-question row(s) or field(s) from the broker were invalid and were dropped`)
      }
      lastClosedDropped = dropped
      publish({ ...current, closedQuestions })
    },
    snapshot: () => current,
    version: () => version
  }
}
