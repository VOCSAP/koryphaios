import {
  inboxEntryKey,
  type InboxAckStatus,
  type InboxArchiveSnapshot,
  type InboxEntryState,
  type InboxMessage
} from './types'

/**
 * What the Courrier does with a message, from its business state and the local
 * read state ('seen' is opened but unresolved, absent is unread): an answered
 * message is gone, a closed one stays listed without counting, an acknowledged
 * one stays listed (ticked) without counting. An unknown state (archive not
 * ready) reads as open.
 */
export function inboxMessageDisposition(
  state: InboxEntryState['state'] | undefined,
  read: InboxAckStatus | undefined
): { visible: boolean; counted: boolean } {
  if (state === 'responded') return { visible: false, counted: false }
  return { visible: true, counted: state !== 'closed' && read !== 'acked' }
}

/**
 * Courrier messages still in the operator's way, by inboxMessageDisposition.
 * The one rule shared by the Courrier badge in the renderer and the Avatar's
 * unread count in main; `entryStates` is required so a caller cannot forget
 * closed or answered entries.
 */
export function countPendingInboxMessages(
  messages: readonly InboxMessage[],
  ackState: Readonly<Record<string, InboxAckStatus>>,
  entryStates: Readonly<Record<string, InboxEntryState>>
): number {
  return messages.reduce((n, message) => {
    const key = inboxEntryKey({ kind: 'message', message })
    return inboxMessageDisposition(entryStates[key]?.state, ackState[key]).counted ? n + 1 : n
  }, 0)
}

export type MessageReplyability = 'open' | 'responded' | 'closed' | 'not-this-run' | 'unknown' | 'legacy-broker'

/** What the Courrier may offer on a message, from the archive of the current run, indexed by `key` when the host gives one. */
export function messageReplyability(
  archive: InboxArchiveSnapshot,
  message: InboxMessage,
  key: string = inboxEntryKey({ kind: 'message', message })
): MessageReplyability {
  if (archive.status === 'pending') return 'unknown'
  if (archive.status === 'unsupported') return 'legacy-broker'
  const entry = archive.messages[key]
  return entry ? entry.state : 'not-this-run'
}
