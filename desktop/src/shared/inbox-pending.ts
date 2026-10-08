import { inboxEntryKey, type InboxAckStatus, type InboxMessage } from './types'

/**
 * Courrier messages still in the operator's way: anything not 'acked' (absent
 * from the map is unread, 'seen' is opened but unresolved). The one rule shared
 * by the Courrier badge in the renderer and the Avatar's unread count in main.
 */
export function countPendingInboxMessages(
  messages: readonly InboxMessage[],
  ackState: Readonly<Record<string, InboxAckStatus>>
): number {
  return messages.reduce(
    (n, message) => (ackState[inboxEntryKey({ kind: 'message', message })] === 'acked' ? n : n + 1),
    0
  )
}
