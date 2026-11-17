import type {
  AvatarInboxAction,
  AvatarInboxContent,
  AvatarInboxSnapshotFrame,
  InboxOutcome
} from '../shared/avatar-inbox-protocol'
import { avatarBubbleMessageKey, avatarBubblePendingCourrier } from '../shared/avatar-bubble-view'
import type { AvatarDeckIdentity } from '../shared/avatar-state'
import type { InboxAckStatus } from '../shared/types'
import { inboxGenerationOf, type AvatarAttachedDeck, type AvatarCommandResult, type AvatarInboxSink } from './avatar-server'
import type { reportError } from './log'

/** About ten full snapshots of messages: a mark of a message that left the snapshot is kept this long. */
export const AVATAR_READ_CAP_PER_DECK = 500

/**
 * What a gesture became. 'busy' is a second gesture on an id already in
 * flight, 'unknown' an id the Deck's last snapshot does not hold, 'failed' a
 * gesture the Deck could not carry out.
 */
export type AvatarInboxGestureResult =
  | { outcome: InboxOutcome; reason?: string }
  | { outcome: 'busy' | 'unknown' | 'failed' }

export interface AvatarInboxReadEntry {
  scopeGeneration: number
  id: number
  sentAt: string
}

export type AvatarInboxReadRefusal = 'no_box' | 'stale_generation' | 'no_message'

export type AvatarInboxReadResult = { read: InboxAckStatus } | { refused: AvatarInboxReadRefusal }

export interface AvatarInboxBox extends AvatarInboxContent {
  identity: AvatarDeckIdentity
  scopeGeneration: number
  /** Ids this Avatar settled since the snapshot; the next snapshot is authoritative. */
  settledLocally: ReadonlySet<string>
  /** Read states of this Deck's messages, keyed by avatarBubbleMessageKey. */
  reads: ReadonlyMap<string, InboxAckStatus>
}

export interface AvatarInboxServiceOptions {
  send(identity: AvatarDeckIdentity, action: AvatarInboxAction): Promise<AvatarCommandResult>
  report: typeof reportError
  changed(): void
}

export interface AvatarInboxService extends AvatarInboxSink {
  boxes(): AvatarInboxBox[]
  act(identity: AvatarDeckIdentity, action: AvatarInboxAction): Promise<AvatarInboxGestureResult>
  /** Records seen or acked for a message the Deck's current snapshot holds; acked is never lowered to seen. */
  markRead(identity: AvatarDeckIdentity, entry: AvatarInboxReadEntry, status: InboxAckStatus): AvatarInboxReadResult
  /** The Deck's Courrier messages that inboxMessageDisposition counts; 0 without a box. */
  pendingCourrier(identity: AvatarDeckIdentity): number
  /** The Avatar stops: every read state goes. */
  dispose(): void
}

interface Box {
  identity: AvatarDeckIdentity
  frame: AvatarInboxSnapshotFrame
  settledLocally: Set<string>
}

interface DeckReads {
  scopeGeneration: number
  entries: Map<string, InboxAckStatus>
}

function deckKey(identity: AvatarDeckIdentity): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url])
}

/**
 * The face's unread count of one attachment: the local Courrier count when the
 * attachment negotiated a3_inbox (0 for an empty or lost box, never a fall back
 * to the Deck's counter), undefined for a Deck on its own legacy counter.
 */
export function avatarLocalUnread(
  attached: readonly AvatarAttachedDeck[],
  inbox: Pick<AvatarInboxService, 'pendingCourrier'>,
  identity: AvatarDeckIdentity
): number | undefined {
  const deck = attached.find((candidate) => candidate.deckRunId === identity.deckRunId && candidate.broker_url === identity.broker_url)
  return inboxGenerationOf(deck) === undefined ? undefined : inbox.pendingCourrier(identity)
}

export interface AvatarInboxWiringOptions {
  send: AvatarInboxServiceOptions['send']
  report: typeof reportError
  attachedDecks(): readonly AvatarAttachedDeck[]
  bubbleChanged(): void
  dispatch(event: { kind: 'RefreshRequested' }): void
}

/** The inbox and the face's unread source, both fed by the same attachments; a change of the inbox redraws the bubble and the face. */
export function createAvatarInboxWiring(options: AvatarInboxWiringOptions): {
  inbox: AvatarInboxService
  localUnread(identity: AvatarDeckIdentity): number | undefined
} {
  const inbox = createAvatarInboxService({
    send: options.send,
    report: options.report,
    changed: () => {
      options.bubbleChanged()
      options.dispatch({ kind: 'RefreshRequested' })
    }
  })
  return { inbox, localUnread: (identity) => avatarLocalUnread(options.attachedDecks(), inbox, identity) }
}

/**
 * In memory only, nothing reaches the disk. A box lives while its Deck's socket
 * is bound; a read state lives while the Deck stays attached on the same scope
 * generation, so a socket that drops and rebinds keeps what was read.
 */
export function createAvatarInboxService(options: AvatarInboxServiceOptions): AvatarInboxService {
  const boxes = new Map<string, Box>()
  const reads = new Map<string, DeckReads>()
  const inFlight = new Set<string>()

  const pending = (key: string): number => {
    const box = boxes.get(key)
    if (!box) return 0
    return avatarBubblePendingCourrier(box.identity, box.frame.scope_generation, box.frame.messages, reads.get(key)?.entries ?? new Map())
  }

  return {
    receive(identity, frame) {
      const key = deckKey(identity)
      if (reads.get(key)?.scopeGeneration !== frame.scope_generation) reads.delete(key)
      boxes.set(key, { identity, frame, settledLocally: new Set() })
      options.changed()
    },
    clear(identity) {
      if (boxes.delete(deckKey(identity))) options.changed()
    },
    detach(identity) {
      reads.delete(deckKey(identity))
      options.changed()
    },
    dispose() {
      reads.clear()
    },
    pendingCourrier(identity) {
      return pending(deckKey(identity))
    },
    markRead(identity, entry, status) {
      const key = deckKey(identity)
      const box = boxes.get(key)
      if (!box) return { refused: 'no_box' }
      if (box.frame.scope_generation !== entry.scopeGeneration) return { refused: 'stale_generation' }
      if (!box.frame.messages.some((message) => message.id === entry.id && message.sent_at === entry.sentAt)) {
        return { refused: 'no_message' }
      }
      const before = pending(key)
      let deck = reads.get(key)
      if (!deck) {
        deck = { scopeGeneration: entry.scopeGeneration, entries: new Map() }
        reads.set(key, deck)
      }
      const messageKey = avatarBubbleMessageKey(identity, entry.scopeGeneration, entry.id, entry.sentAt)
      const read = deck.entries.get(messageKey) === 'acked' ? 'acked' : status
      deck.entries.delete(messageKey)
      deck.entries.set(messageKey, read)
      for (const oldest of deck.entries.keys()) {
        if (deck.entries.size <= AVATAR_READ_CAP_PER_DECK) break
        deck.entries.delete(oldest)
      }
      if (pending(key) !== before) options.changed()
      return { read }
    },
    boxes() {
      return [...boxes.values()].map((box) => ({
        identity: box.identity,
        scopeGeneration: box.frame.scope_generation,
        approvals: box.frame.approvals,
        messages: box.frame.messages,
        closed: box.frame.closed,
        truncated: box.frame.truncated,
        settledLocally: new Set(box.settledLocally),
        reads: new Map(reads.get(deckKey(box.identity))?.entries)
      }))
    },
    async act(identity, action) {
      const key = deckKey(identity)
      const box = boxes.get(key)
      if (!box || !box.frame.approvals.some((approval) => approval.id === action.approval_id)) return { outcome: 'unknown' }
      const flight = JSON.stringify([key, action.approval_id])
      if (inFlight.has(flight)) return { outcome: 'busy' }
      inFlight.add(flight)
      try {
        const result = await options.send(identity, action)
        if (!result.ok || result.outcome === undefined) {
          options.report('avatar-inbox', `the Deck could not carry out the ${action.action} gesture (${result.error ?? 'no outcome'})`)
          return { outcome: 'failed' }
        }
        if (result.outcome === 'won') {
          boxes.get(key)?.settledLocally.add(action.approval_id)
          options.changed()
        }
        return { outcome: result.outcome, ...(result.reason === undefined ? {} : { reason: result.reason }) }
      } catch (error) {
        options.report('avatar-inbox', `the ${action.action} gesture did not reach the Deck`, error)
        return { outcome: 'failed' }
      } finally {
        inFlight.delete(flight)
      }
    }
  }
}
