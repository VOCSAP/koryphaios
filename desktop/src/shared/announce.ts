// Pure helpers for the Deck's outbound peer announcements (no electron/node-pty
// imports, so they can be unit-tested under `bun test`). The Deck broadcasts
// these via the broker /announce endpoint; peers receive them as one-way,
// no-reply operator messages.

/** What the Deck needs, captured at create time, to compose a join announce. */
export interface JoinAnnounceIntent {
  /**
   * Operator-edited free text from the advanced create menu (pre-filled with the
   * agent/model/effort summary). Null/empty => compose the structured default.
   */
  custom: string | null
  agent: string
  model: string
  effort: string
}

/**
 * The editable default the advanced create menu pre-fills its announce field
 * with. The peer_id is unknown at create time, so it is injected later by
 * composeJoinAnnounce; this is only the agent/model/effort note.
 */
export function defaultAnnounceDraft(intent: Omit<JoinAnnounceIntent, 'custom'>): string {
  return [
    `agent: ${intent.agent || 'default'}`,
    `model: ${intent.model || 'default'}`,
    `effort: ${intent.effort || 'auto'}`
  ].join(', ')
}

/**
 * Trailer appended to every join announce (PLAN K4): the broker-side deck note
 * only forbids replying to 'deck', so without this line agents would greet the
 * NEWCOMER via send_message ("welcome!") -- a token-burning reflex the channel
 * instructions ("respond immediately to peer messages") otherwise encourages.
 */
export const JOIN_NO_REPLY_NOTE =
  'Notification only: do NOT reply, do NOT greet or message the new peer about this. Continue your current task.'

/**
 * Compose the final join-announce text broadcast once a fresh session's peer_id
 * resolves. The peer_id is always present (so peers can recognise the newcomer);
 * a custom note is appended after it, otherwise the structured default is used.
 */
export function composeJoinAnnounce(peerId: string, intent: JoinAnnounceIntent): string {
  const head = `New peer "${peerId}" joined the group`
  const custom = intent.custom?.trim()
  const body = custom ? `${head}. ${custom}` : `${head} (${defaultAnnounceDraft(intent)}).`
  return `${body}\n${JOIN_NO_REPLY_NOTE}`
}
