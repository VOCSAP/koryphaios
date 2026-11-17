import type { AvatarBubbleModel } from '@shared/avatar-bubble-view'
import { inboxEntryKey, type Approval, type InboxArchiveSnapshot, type InboxMessage } from '../../../shared/types'

/** The broker's snapshot of a purged sender: kept bare, so InboxCore still says the peer is gone. */
const GONE_PEER = '<gone>'

export interface BubbleCourrier {
  messages: InboxMessage[]
  archive: InboxArchiveSnapshot
}

/**
 * The relayed Courrier in the shape InboxCore reads. With two Decks or more
 * the sender carries its Deck label: InboxCore has no per-entry slot for it.
 */
export function bubbleCourrier(model: AvatarBubbleModel): BubbleCourrier {
  const decks = new Set([...model.courrier, ...model.closed].map((entry) => entry.deckLabel))
  const many = decks.size > 1
  const messages: InboxMessage[] = []
  const states: InboxArchiveSnapshot['messages'] = {}
  for (const m of model.courrier) {
    const message: InboxMessage = {
      id: m.id,
      from: m.fromPeerId === GONE_PEER || !many ? m.fromPeerId : `${m.deckLabel} · ${m.fromPeerId}`,
      text: m.text,
      sentAt: m.sentAt
    }
    messages.push(message)
    states[inboxEntryKey({ kind: 'message', message })] = {
      state: m.closed ? 'closed' : m.answered ? 'responded' : 'open',
      settledAt: m.closedAt,
      ...(m.reason === null ? {} : { closeReason: m.reason }),
      ...(m.closedBy === null ? {} : { closedByAuthority: m.closedBy }),
      closedByPeerId: null
    }
  }
  const closedQuestions = model.closed.map(
    (c): Approval => ({
      id: c.approvalId,
      operator_id: '',
      origin: {} as Approval['origin'],
      kind: 'question',
      title: many ? `${c.deckLabel} · ${c.title}` : c.title,
      question: c.title,
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
      ...(c.reason === null ? {} : { close_reason: c.reason })
    })
  )
  return { messages, archive: { status: 'ready', messages: states, closedQuestions } }
}
