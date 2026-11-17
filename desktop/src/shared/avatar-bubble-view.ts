import { uniqueAvatarDeckLabels } from './avatar-label'
import {
  INBOX_ACTIONS,
  inboxActionAllowed,
  type AvatarInboxAction,
  type AvatarInboxContent,
  type InboxActionKind,
  type InboxRelayApproval,
  type InboxRelayMessage,
  type InboxTruncation
} from './avatar-inbox-protocol'
import type { AvatarDeckIdentity } from './avatar-state'
import { inboxMessageDisposition } from './inbox-pending'
import type { ApprovalKind, InboxAckStatus, InboxCloseAuthority } from './types'

/** How long a card whose gesture lost the race stays visible as settled elsewhere. */
export const AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS = 2_000

const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g
const UNSAFE_CHARS_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

/**
 * Relayed text made inert for one line: line breaks become " / " so a value
 * cannot start a line that reads as the bubble's own text, and every other
 * control, bidi-override or invisible format character becomes U+FFFD.
 */
export function safeLine(text: string): string {
  return text.replace(/\r\n|\r|\n|\u2028|\u2029/g, ' / ').replace(UNSAFE_CHARS, '\ufffd')
}

/** As safeLine, but line breaks are kept as \n: a command or a question body reads line by line. */
export function safeBlock(text: string): string {
  return text.replace(/\r\n|\r|\u2028|\u2029/g, '\n').replace(UNSAFE_CHARS_BUT_NEWLINE, '\ufffd')
}

export interface AvatarBubbleOption {
  /** As the agent wrote it: what a gesture sends, never displayed. */
  value: string
  label: string
}

export interface AvatarBubbleQuestionOption extends AvatarBubbleOption {
  description: string
}

export interface AvatarBubbleQuestion {
  /** The question as the agent wrote it: the key of an answers gesture, never displayed. */
  key: string
  question: string
  header: string
  options: AvatarBubbleQuestionOption[]
  multiSelect: boolean
}

export interface AvatarBubbleCard {
  key: string
  identity: AvatarDeckIdentity
  deckLabel: string
  approvalId: string
  kind: ApprovalKind
  blocking: boolean
  title: string
  question: string
  options: AvatarBubbleOption[]
  questions: AvatarBubbleQuestion[] | null
  fromPeerId: string
  tileName: string | null
  createdAt: string
  cut: boolean
  /** Empty once the card is settled elsewhere. */
  gestures: InboxActionKind[]
  /** A cut card the operator must read in full in the Deck before approving. */
  openInDeck: boolean
  settledElsewhere: boolean
}

export interface AvatarBubbleMessage {
  key: string
  identity: AvatarDeckIdentity
  scopeGeneration: number
  deckLabel: string
  id: number
  fromPeerId: string
  text: string
  sentAt: string
  /** What this Avatar recorded; null while the operator has not read it. Never sent back to the Deck. */
  read: InboxAckStatus | null
  closed: boolean
  answered: boolean
  closedAt: string | null
  closedBy: InboxCloseAuthority | null
  reason: string | null
  cut: boolean
}

export interface AvatarBubbleClosed {
  key: string
  identity: AvatarDeckIdentity
  deckLabel: string
  approvalId: string
  title: string
  closedAt: string
  reason: string | null
}

export interface AvatarBubbleModel {
  reclame: AvatarBubbleCard[]
  courrier: AvatarBubbleMessage[]
  /** Messages of the A3 boxes that inboxMessageDisposition counts; the same number as the face's. */
  courrierPending: number
  closed: AvatarBubbleClosed[]
  truncated: InboxTruncation
  /** When a settled-elsewhere card expires and the model must be projected again; null when none is shown. */
  nextChangeAt: number | null
}

export interface AvatarBubbleBox extends AvatarInboxContent {
  identity: AvatarDeckIdentity
  scopeGeneration: number
  settledLocally: ReadonlySet<string>
  /** Read states of this Deck's messages, keyed by avatarBubbleMessageKey. */
  reads: ReadonlyMap<string, InboxAckStatus>
}

export interface AvatarBubbleDeck {
  deckRunId: string
  broker_url: string
  deckName: string
}

export interface AvatarBubbleLost {
  card: AvatarBubbleCard
  at: number
}

export interface AvatarBubbleInput {
  boxes: readonly AvatarBubbleBox[]
  decks: readonly AvatarBubbleDeck[]
  lost: readonly AvatarBubbleLost[]
  now: number
}

function deckKey(identity: AvatarDeckIdentity): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url])
}

export function avatarBubbleCardKey(identity: AvatarDeckIdentity, approvalId: string): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url, approvalId])
}

/** Two Decks, two scope generations or two sends sharing an id never share a read state. */
export function avatarBubbleMessageKey(identity: AvatarDeckIdentity, scopeGeneration: number, id: number, sentAt: string): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url, scopeGeneration, id, sentAt])
}

/**
 * The gestures the bubble offers, a subset of inboxActionAllowed narrower than
 * the Deck, which also offers allow on a permission outside the hook route.
 * Allow only on a hook permission; no deny on a hook entry with structured
 * questions, which the broker settles by answers only; free text never on a
 * hook entry nor on structured questions.
 */
export function avatarBubbleGestures(approval: InboxRelayApproval): InboxActionKind[] {
  return INBOX_ACTIONS.filter((action) => {
    if (!inboxActionAllowed(approval, action)) return false
    if (action === 'allow') return approval.kind === 'permission' && approval.reply_route === 'hook'
    if (action === 'deny') return !(approval.reply_route === 'hook' && approval.questions !== null)
    if (action === 'text') return approval.questions === null && approval.reply_route !== 'hook'
    return true
  })
}

export function avatarBubblePendingCourrier(
  identity: AvatarDeckIdentity,
  scopeGeneration: number,
  messages: readonly InboxRelayMessage[],
  reads: ReadonlyMap<string, InboxAckStatus>
): number {
  return messages.filter(
    (message) =>
      inboxMessageDisposition(message.state, reads.get(avatarBubbleMessageKey(identity, scopeGeneration, message.id, message.sent_at))).counted
  ).length
}

function projectCard(identity: AvatarDeckIdentity, deckLabel: string, approval: InboxRelayApproval): AvatarBubbleCard {
  const cut = approval.cut === true
  return {
    key: avatarBubbleCardKey(identity, approval.id),
    identity,
    deckLabel,
    approvalId: approval.id,
    kind: approval.kind,
    blocking: !approval.informational,
    title: safeLine(approval.title),
    question: safeBlock(approval.question),
    options: approval.options.map((option) => ({ value: option, label: safeLine(option) })),
    questions:
      approval.questions?.map((question) => ({
        key: question.question,
        question: safeBlock(question.question),
        header: safeLine(question.header),
        options: question.options.map((option) => ({
          value: option.label,
          label: safeLine(option.label),
          description: safeLine(option.description)
        })),
        multiSelect: question.multi_select
      })) ?? null,
    fromPeerId: safeLine(approval.from_peer_id),
    tileName: approval.tile_name === null ? null : safeLine(approval.tile_name),
    createdAt: approval.created_at,
    cut,
    gestures: avatarBubbleGestures(approval),
    openInDeck: cut,
    settledElsewhere: false
  }
}

function blockingFirst(a: AvatarBubbleCard, b: AvatarBubbleCard): number {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
}

/** One queue over every attached Deck; a box without an attached Deck is dropped, since no gesture could reach it. */
export function projectAvatarBubble(input: AvatarBubbleInput): AvatarBubbleModel {
  const labels = uniqueAvatarDeckLabels(input.decks.map((deck) => deck.deckName))
  const labelOf = new Map(input.decks.map((deck, index) => [deckKey(deck), safeLine(labels[index] ?? deck.deckName)]))
  const lost = input.lost.filter((entry) => input.now - entry.at < AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS)
  const lostKeys = new Set(lost.map((entry) => entry.card.key))
  const cards: AvatarBubbleCard[] = lost.map((entry) => ({ ...entry.card, gestures: [], openInDeck: false, settledElsewhere: true }))
  const courrier: AvatarBubbleMessage[] = []
  const closed: AvatarBubbleClosed[] = []
  const truncated: InboxTruncation = { approvals: 0, messages: 0, closed: 0 }
  let courrierPending = 0

  for (const box of input.boxes) {
    const deckLabel = labelOf.get(deckKey(box.identity))
    if (deckLabel === undefined) continue
    const identity = { deckRunId: box.identity.deckRunId, broker_url: box.identity.broker_url }
    for (const approval of box.approvals) {
      if (box.settledLocally.has(approval.id)) continue
      const card = projectCard(identity, deckLabel, approval)
      if (!lostKeys.has(card.key)) cards.push(card)
    }
    courrierPending += avatarBubblePendingCourrier(identity, box.scopeGeneration, box.messages, box.reads)
    for (const message of box.messages) {
      const key = avatarBubbleMessageKey(identity, box.scopeGeneration, message.id, message.sent_at)
      courrier.push({
        key,
        identity,
        scopeGeneration: box.scopeGeneration,
        read: box.reads.get(key) ?? null,
        deckLabel,
        id: message.id,
        fromPeerId: safeLine(message.from_peer_id),
        text: safeBlock(message.text),
        sentAt: message.sent_at,
        closed: message.state === 'closed',
        answered: message.state === 'responded',
        closedAt: message.closed_at,
        closedBy: message.closed_by,
        reason: message.reason === null ? null : safeLine(message.reason),
        cut: message.cut === true
      })
    }
    for (const entry of box.closed) {
      closed.push({
        key: avatarBubbleCardKey(identity, entry.id),
        identity,
        deckLabel,
        approvalId: entry.id,
        title: safeLine(entry.title),
        closedAt: entry.closed_at,
        reason: entry.reason === null ? null : safeLine(entry.reason)
      })
    }
    truncated.approvals += box.truncated.approvals
    truncated.messages += box.truncated.messages
    truncated.closed += box.truncated.closed
  }

  cards.sort(blockingFirst)
  courrier.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0))
  closed.sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : 0))
  const nextChangeAt = lost.length === 0 ? null : Math.min(...lost.map((entry) => entry.at)) + AVATAR_BUBBLE_SETTLED_ELSEWHERE_MS
  return { reclame: cards, courrier, courrierPending, closed, truncated, nextChangeAt }
}

export type AvatarBubbleTheme = 'dark' | 'light'

/** The side of the bubble window the mask sits against. */
export type AvatarBubbleAnchor = 'left' | 'right'

export interface AvatarBubbleState {
  generation: number
  theme: AvatarBubbleTheme
  lang: 'en' | 'fr'
  /** Only the avatarBubble.* and inbox.* keys, user locale overrides applied. */
  dict: Record<string, string>
  anchor: AvatarBubbleAnchor
  model: AvatarBubbleModel
}

/** What a gesture became, as the bubble shows it. */
export type AvatarBubbleActOutcome = 'won' | 'lost' | 'refused' | 'busy' | 'unknown' | 'failed'

export interface AvatarBubbleActIntent {
  generation: number
  deckRunId: string
  broker_url: string
  action: AvatarInboxAction
}

export interface AvatarBubbleFocusIntent {
  generation: number
  deckRunId: string
  broker_url: string
}

export interface AvatarBubbleReadIntent {
  generation: number
  deckRunId: string
  broker_url: string
  scopeGeneration: number
  id: number
  sentAt: string
}

export const AVATAR_BUBBLE_CHANNELS = {
  getState: 'avatar-bubble:get-state',
  state: 'avatar-bubble:state',
  act: 'avatar-bubble:act',
  markSeen: 'avatar-bubble:mark-seen',
  ack: 'avatar-bubble:ack',
  focusDeck: 'avatar-bubble:focus-deck',
  close: 'avatar-bubble:close',
  reportError: 'avatar-bubble:report-error'
} as const

export function avatarBubbleReadApi(
  invoke: (channel: string, intent: AvatarBubbleReadIntent) => Promise<unknown>
): Pick<AvatarBubbleApi, 'markSeen' | 'ack'> {
  return {
    markSeen: (intent) => invoke(AVATAR_BUBBLE_CHANNELS.markSeen, intent) as Promise<InboxAckStatus>,
    ack: (intent) => invoke(AVATAR_BUBBLE_CHANNELS.ack, intent) as Promise<InboxAckStatus>
  }
}

export interface AvatarBubbleApi {
  getState(): Promise<AvatarBubbleState>
  onState(callback: (state: AvatarBubbleState) => void): () => void
  act(intent: AvatarBubbleActIntent): Promise<{ outcome: AvatarBubbleActOutcome; reason?: string }>
  markSeen(intent: AvatarBubbleReadIntent): Promise<InboxAckStatus>
  ack(intent: AvatarBubbleReadIntent): Promise<InboxAckStatus>
  focusDeck(intent: AvatarBubbleFocusIntent): Promise<void>
  close(): Promise<void>
  reportError(message: string): void
}
