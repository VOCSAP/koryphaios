import {
  inboxEntryKey,
  type InboxAckStatus,
  type InboxArchiveSnapshot,
  type InboxEntryState,
  type InboxMessage
} from './types'

/**
 * Courrier messages still in the operator's way: anything not 'acked' (absent
 * from the map is unread, 'seen' is opened but unresolved) and not closed by an
 * agent. A 'responded' message keeps counting until acknowledged. The one rule
 * shared by the Courrier badge in the renderer and the Avatar's unread count in
 * main; `entryStates` is required so a caller cannot forget closed entries.
 */
export function countPendingInboxMessages(
  messages: readonly InboxMessage[],
  ackState: Readonly<Record<string, InboxAckStatus>>,
  entryStates: Readonly<Record<string, InboxEntryState>>
): number {
  return messages.reduce((n, message) => {
    const key = inboxEntryKey({ kind: 'message', message })
    if (ackState[key] === 'acked' || entryStates[key]?.state === 'closed') return n
    return n + 1
  }, 0)
}

export type MessageReplyability = 'open' | 'responded' | 'closed' | 'not-this-run' | 'unknown' | 'legacy-broker'

/** What the Courrier may offer on a message, from the archive of the current run. */
export function messageReplyability(archive: InboxArchiveSnapshot, message: InboxMessage): MessageReplyability {
  if (archive.status === 'pending') return 'unknown'
  if (archive.status === 'unsupported') return 'legacy-broker'
  const entry = archive.messages[inboxEntryKey({ kind: 'message', message })]
  return entry ? entry.state : 'not-this-run'
}
