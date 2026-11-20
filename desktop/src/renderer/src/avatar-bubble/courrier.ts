import type { AvatarBubbleMessage, AvatarBubbleModel } from '@shared/avatar-bubble-view'
import type { ApprovalSenderResolution } from '../inbox-sender'
import {
  inboxEntryKey,
  type AckableInboxEntry,
  type Approval,
  type InboxAckStatus,
  type InboxArchiveSnapshot,
  type InboxMessage
} from '../../../shared/types'

/** The broker's snapshot of a purged sender: kept bare, so InboxCore still says the peer is gone. */
const GONE_PEER = '<gone>'

export interface BubbleCourrier {
  messages: InboxMessage[]
  archive: InboxArchiveSnapshot
  /** What main recorded, keyed like `archive.messages` by AvatarBubbleMessage.key. */
  readStates: Record<string, InboxAckStatus>
  /** Null for a message object the bubble did not build: a copy has no key, so it never shares another Deck's state. */
  entryKey: (entry: AckableInboxEntry) => string | null
  /** The relayed message an InboxCore entry stands for; null for an entry the bubble never listed. */
  source: (entry: AckableInboxEntry) => AvatarBubbleMessage | null
  /** AvatarBubbleClosed.key of a closed question, two Decks may close the same approval id; null as for entryKey. */
  approvalKey: (approval: Approval) => string | null
  resolveSender: (approval: Approval) => ApprovalSenderResolution
}

/**
 * The relayed Courrier in the shape InboxCore reads. Every index is the
 * message's composite key: two Decks may hold a message with the same id and
 * send time, and inboxEntryKey alone would merge them. With two Decks or more
 * the sender carries its Deck label: InboxCore has no per-entry slot for it.
 */
export function bubbleCourrier(model: AvatarBubbleModel, report: (message: string) => void): BubbleCourrier {
  const decks = new Set([...model.courrier, ...model.closed].map((entry) => entry.deckLabel))
  const many = decks.size > 1
  const messages: InboxMessage[] = []
  const states: InboxArchiveSnapshot['messages'] = {}
  const readStates: Record<string, InboxAckStatus> = {}
  const sources = new Map<InboxMessage, AvatarBubbleMessage>()
  for (const m of model.courrier) {
    const message: InboxMessage = {
      id: m.id,
      from: m.fromPeerId === GONE_PEER || !many ? m.fromPeerId : `${m.deckLabel} · ${m.fromPeerId}`,
      text: m.text,
      sentAt: m.sentAt
    }
    messages.push(message)
    sources.set(message, m)
    if (m.read !== null) readStates[m.key] = m.read
    states[m.key] = {
      state: m.closed ? 'closed' : m.answered ? 'responded' : 'open',
      settledAt: m.closedAt,
      ...(m.reason === null ? {} : { closeReason: m.reason }),
      ...(m.closedBy === null ? {} : { closedByAuthority: m.closedBy }),
      closedByPeerId: null
    }
  }
  const refused = new WeakSet<object>()
  const refuse = (what: object, text: string): null => {
    if (!refused.has(what)) {
      refused.add(what)
      report(text)
    }
    return null
  }
  const source = (entry: AckableInboxEntry): AvatarBubbleMessage | null =>
    entry.kind === 'message' ? (sources.get(entry.message) ?? null) : null
  const entryKey = (entry: AckableInboxEntry): string | null => {
    if (entry.kind === 'event') return inboxEntryKey(entry)
    return (
      sources.get(entry.message)?.key ??
      refuse(entry.message, `bubble Courrier left out message ${entry.message.id}: not one the bubble listed`)
    )
  }
  const closedKeys = new Map<Approval, string>()
  const closedSenders = new Map<string, string>()
  const closedQuestions = model.closed.map((c): Approval => {
    const approval: Approval = {
      id: c.approvalId,
      operator_id: '',
      origin: {} as Approval['origin'],
      kind: 'question',
      title: many ? `${c.deckLabel} · ${c.title}` : c.title,
      question: c.title,
      text_flags: [],
      danger: [],
      options: [],
      status: 'closed',
      reply_route: 'channel',
      mergeable: false,
      absorbed_permission: false,
      informational: false,
      answered_via: null,
      answer_kind: null,
      answer_text: null,
      questions: null,
      answers: null,
      created_at: c.closedAt,
      notif_expires_at: c.closedAt,
      answered_at: c.closedAt,
      delivered_at: null,
      ...(c.reason === null ? {} : { close_reason: c.reason }),
      ...(c.closedBy === null ? {} : { closed_by_authority: c.closedBy })
    }
    closedKeys.set(approval, c.key)
    const sender = c.tileName ?? c.fromPeerId
    if (sender) closedSenders.set(c.key, many ? `${c.deckLabel} · ${sender}` : sender)
    return approval
  })
  const approvalKey = (approval: Approval): string | null =>
    closedKeys.get(approval) ?? refuse(approval, `bubble Courrier left out question ${approval.id}: not one the bubble listed`)
  const resolveSender = (approval: Approval): ApprovalSenderResolution => {
    const key = closedKeys.get(approval)
    const name = key === undefined ? undefined : closedSenders.get(key)
    return name === undefined ? { resolved: false, raw: '' } : { resolved: true, name }
  }
  return { messages, archive: { status: 'ready', messages: states, closedQuestions }, readStates, entryKey, source, approvalKey, resolveSender }
}
