import { statSync } from 'node:fs'
import { validateQuestions } from '../../../shared/approval'
import {
  buildAvatarInboxSnapshot,
  inboxActionAllowed,
  MAX_INBOX_OUTCOME_REASON,
  projectAvatarInbox,
  type AvatarInboxAction,
  type AvatarInboxContent,
  type InboxOutcome,
  type InboxRelayApproval,
  type InboxRelayMessageSource,
  type InboxRelaySources
} from '../shared/avatar-inbox-protocol'
import type { AvatarDeckIdentity } from '../shared/avatar-state'
import { inboxEntryKey, type Approval, type InboxEntryState, type InboxMessage } from '../shared/types'
import {
  ackApproval,
  BrokerHttpError,
  claimApproval,
  parseApprovalAnswers,
  type ApprovalDeps
} from './approval-service'
import type { reportError } from './log'

/** At most one inbox frame per socket in this window; the latest state wins. */
export const INBOX_PUSH_INTERVAL_MS = 250

export type InboxRelaySourcesInput = Omit<InboxRelaySources, 'validateQuestions'>

/** The journal and the batches whose journal write failed, deduplicated by broker id, each with its run state. */
export function relayInboxMessages(
  history: readonly InboxMessage[],
  unjournaled: readonly InboxMessage[],
  entryStates: Readonly<Record<string, InboxEntryState>>
): InboxRelayMessageSource[] {
  const byId = new Map<number, InboxMessage>()
  for (const message of [...history, ...unjournaled]) if (!byId.has(message.id)) byId.set(message.id, message)
  return [...byId.values()].map((message) => ({ message, entry: entryStates[inboxEntryKey({ kind: 'message', message })] }))
}

/** The Deck tile an approval was raised from, by its tile_ref. */
export function approvalTileName(approval: Approval, sessions: readonly { id: string; name: string }[]): string | null {
  return sessions.find((session) => session.id === approval.origin.tile_ref)?.name ?? null
}

export interface InboxPusherOptions {
  identity: AvatarDeckIdentity
  scopeGeneration: number
  sources(): InboxRelaySourcesInput
  send(text: string): void
  after(ms: number, fire: () => void): () => void
  now(): number
  report: typeof reportError
}

export interface InboxPusher {
  /** Called on every source change; sends now, or once the push window closes. */
  changed(): void
  /** The approvals of the last snapshot this socket received, by id. */
  sentApprovals(): ReadonlyMap<string, InboxRelayApproval>
  stop(): void
}

/** Inode, nanosecond mtime and size: an atomic rewrite of the same size still changes the stamp. */
export function journalStamp(file: string): string {
  const stat = statSync(file, { bigint: true, throwIfNoEntry: false })
  return stat ? `${stat.ino}:${stat.mtimeNs}:${stat.size}` : 'absent'
}

/** Rereads the sources only when `stamp` changes: an unchanged journal is not parsed again. */
export function createStampedReader<T>(stamp: () => string, read: () => T): () => T {
  let lastStamp: string | null = null
  let last: T
  return () => {
    const current = stamp()
    if (current !== lastStamp) {
      last = read()
      lastStamp = current
    }
    return last
  }
}

/** One per bound socket: seq starts again at 1 with each bind, and the first frame leaves at once. */
export function createInboxPusher(options: InboxPusherOptions): InboxPusher {
  let seq = 0
  let lastSignature: string | null = null
  let lastSentAt = Number.NEGATIVE_INFINITY
  let cancelTimer: (() => void) | null = null
  let stopped = false
  let sent: ReadonlyMap<string, InboxRelayApproval> = new Map()
  let failing = false

  const frameText = (frameSeq: number, content: AvatarInboxContent): string =>
    JSON.stringify(buildAvatarInboxSnapshot(options.identity, options.scopeGeneration, frameSeq, content))

  const push = (): void => {
    cancelTimer = null
    if (stopped) return
    try {
      const content = projectAvatarInbox({ ...options.sources(), validateQuestions }, (candidate) =>
        frameText(Number.MAX_SAFE_INTEGER, candidate)
      )
      const signature = JSON.stringify(content)
      if (signature === lastSignature) return
      options.send(frameText(seq + 1, content))
      failing = false
      seq += 1
      lastSignature = signature
      lastSentAt = options.now()
      sent = new Map(content.approvals.map((approval) => [approval.id, approval]))
    } catch (error) {
      if (!failing) options.report('avatar-inbox', 'the inbox snapshot could not be built or sent to the Avatar', error)
      failing = true
    }
  }

  const changed = (): void => {
    if (stopped || cancelTimer) return
    const wait = lastSentAt + INBOX_PUSH_INTERVAL_MS - options.now()
    if (wait <= 0) push()
    else cancelTimer = options.after(wait, push)
  }

  changed()
  return {
    changed,
    sentApprovals: () => sent,
    stop() {
      stopped = true
      cancelTimer?.()
      cancelTimer = null
    }
  }
}

export type InboxActionResult =
  | { outcome: InboxOutcome; reason?: string }
  | { error: 'unknown_approval' | 'action_not_allowed' | 'busy' | 'invalid_inbox_action' | 'unavailable' }

export interface InboxActionDeps {
  approvalDeps(): ApprovalDeps | null
  claim?: typeof claimApproval
  ack?: typeof ackApproval
}

function refusalReason(error: BrokerHttpError): string {
  return Array.from(error.detail || `status ${error.status}`).slice(0, MAX_INBOX_OUTCOME_REASON).join('')
}

/**
 * Settles one Avatar gesture with the operator key this Deck holds, recorded
 * as answered via avatar. Only an approval of the last snapshot sent to the
 * asking socket can be targeted, with a gesture its relayed form allows, and
 * one gesture per id runs at a time. A broker error other than 409, 410 or
 * 422 is thrown for the caller to trace.
 */
export function createInboxActionHandler(deps: InboxActionDeps): (
  action: AvatarInboxAction,
  sent: ReadonlyMap<string, InboxRelayApproval>
) => Promise<InboxActionResult> {
  const claim = deps.claim ?? claimApproval
  const ack = deps.ack ?? ackApproval
  const inFlight = new Set<string>()

  const settle = (approvalDeps: ApprovalDeps, action: AvatarInboxAction): Promise<Approval | null> | null => {
    const id = action.approval_id
    switch (action.action) {
      case 'allow':
      case 'deny':
        return claim(approvalDeps, { id, via: 'avatar', answerKind: action.action })
      case 'text':
        return action.text ? claim(approvalDeps, { id, via: 'avatar', answerKind: 'text', answerText: action.text }) : null
      case 'answers': {
        const answers = parseApprovalAnswers(action.answers)
        return answers ? claim(approvalDeps, { id, via: 'avatar', answerKind: 'answers', answers }) : null
      }
      case 'acknowledge':
        return ack(approvalDeps, id, 'avatar')
    }
  }

  return async (action, sent) => {
    const relayed = sent.get(action.approval_id)
    if (!relayed) return { error: 'unknown_approval' }
    if (!inboxActionAllowed(relayed, action.action)) return { error: 'action_not_allowed' }
    if (inFlight.has(action.approval_id)) return { error: 'busy' }
    const approvalDeps = deps.approvalDeps()
    if (!approvalDeps) return { error: 'unavailable' }
    inFlight.add(action.approval_id)
    try {
      const settling = settle(approvalDeps, action)
      if (settling === null) return { error: 'invalid_inbox_action' }
      return (await settling) === null ? { outcome: 'lost' } : { outcome: 'won' }
    } catch (error) {
      if (error instanceof BrokerHttpError && (error.status === 410 || error.status === 422)) {
        return { outcome: 'refused', reason: refusalReason(error) }
      }
      throw error
    } finally {
      inFlight.delete(action.approval_id)
    }
  }
}
