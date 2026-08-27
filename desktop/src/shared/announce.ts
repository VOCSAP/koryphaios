// Pure helpers for the Deck's outbound peer announcements (no electron/node-pty
// imports, so they can be unit-tested under `bun test`). The Deck broadcasts
// these via the broker /announce endpoint; peers receive them as one-way,
// no-reply operator messages.

import type { JoinAnnounceLevel, SessionRuntime } from './types'
import { TEAM_LEAD_ROLE } from './role'

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

/**
 * Decision only -- who (if anyone) the join-announce broadcast should reach
 * (card 8cb54a0f). 'broadcast' keeps the historical everyone-in-the-group
 * behaviour; 'targets' names the exact peer_ids to address individually;
 * 'silent' means nothing is sent at all (level 'off', or level 'lead' with
 * no live team-lead/supervisor to address -- deliberately NOT a broadcast
 * fallback, see joinAnnounceTargets).
 */
export type JoinAnnounceTargets =
  | { kind: 'broadcast' }
  | { kind: 'targets'; peerIds: string[] }
  | { kind: 'silent' }

/**
 * Resolve joinAnnounceTargets for the join-announce gate (card 8cb54a0f).
 * 'off' -> silent. 'all' -> broadcast (unchanged historical behaviour).
 * 'lead' -> every active (active = active IN THIS DECK WINDOW, i.e.
 * `service.list()`; a team-lead living in another window or on another host
 * of the same group is not a candidate and the announce is dropped, same
 * locality as `announceToSupervisor` -- non-exited, peer_id resolved)
 * session whose `role` is the team-lead role (`filter`, never `find`/`get`:
 * two active team-leads is a valid state, both must be addressed); if none,
 * every active supervisor session (same `filter`, same reasoning --
 * `supervisor` is exclusive in practice today but not by construction, see
 * card tracking the ensureSupervisor() TOCTOU); if still none, silent -- no
 * broadcast fallback, since that would reintroduce exactly the noise this
 * gate exists to remove. Any OTHER value (unknown/corrupt config -- normally
 * unreachable, store.ts clamps to a valid level on read, this is defense in
 * depth) falls through to silent as well: a gate that fails toward MORE
 * announces than requested is exactly backwards.
 */
export function joinAnnounceTargets(
  level: JoinAnnounceLevel,
  sessions: readonly SessionRuntime[]
): JoinAnnounceTargets {
  if (level === 'off') return { kind: 'silent' }
  if (level === 'all') return { kind: 'broadcast' }
  if (level === 'lead') {
    const active = (s: SessionRuntime): boolean => s.status !== 'exited' && !!s.peerId
    const leads = sessions.filter((s) => active(s) && s.role === TEAM_LEAD_ROLE)
    const pool = leads.length > 0 ? leads : sessions.filter((s) => active(s) && s.supervisor)
    if (pool.length === 0) return { kind: 'silent' }
    return { kind: 'targets', peerIds: pool.map((s) => s.peerId as string) }
  }
  return { kind: 'silent' }
}
