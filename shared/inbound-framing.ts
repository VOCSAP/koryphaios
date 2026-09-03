// The single enforcer for all three receive paths in server.ts, so a fourth
// sender class is added once here instead of risking a copy that silently
// diverges.
// Framing stays at reception rather than moving to emission: emission-side
// framing would let an older Deck emit an unframed message with nothing going
// red, while reception-side framing is fail-closed regardless of the emitter's
// version.
// Each predicate compares against both the public peer_id and the reserved
// instance_token, since the three receive paths do not all see the same form.

import {
  DECK_PEER_ID,
  DECK_INSTANCE_TOKEN,
  OPERATOR_PEER_ID,
  OPERATOR_INSTANCE_TOKEN,
} from "./types.ts";

// Deck sentinel messages are one-way operator broadcasts and must not trigger
// the default reply behaviour; since that instruction is global, the no-reply
// guarantee has to be carried inside the rendered content itself.
// Only two things are actually forbidden: acknowledging (would flood the
// operator) and send_message toward "deck" (non-routable by construction).
// English wording, for maximum model compatibility.
export const DECK_NO_REPLY_NOTE =
  '\n\n[claude-peers] Operator broadcast from the Deck. Act on it now if it concerns you, then continue your current task. Do NOT acknowledge it and do NOT call send_message toward "deck": that sender is a non-routable sentinel, so any message aimed at it fails. This waives only the acknowledgement -- you stay free to message any peer, including to carry out what this announcement asks of you (if it hands you work that ends in a report to someone, send that report).';

export function isDeckSender(idOrToken: string): boolean {
  return idOrToken === DECK_PEER_ID || idOrToken === DECK_INSTANCE_TOKEN;
}

export function renderDeckAnnouncement(text: string): string {
  return `[Deck announcement -- operator broadcast]\n${text}${DECK_NO_REPLY_NOTE}`;
}

// The operator ANSWERING a question they were asked (remote approvals, C-9).
// A third framing family beside the deck one: this message is actionable --
// unlike an announcement -- but it still must not draw an acknowledgement, or
// every settled approval would drop a "ok, doing it" into the operator's
// desktop inbox. A follow-up question belongs in ask_operator, not here.
export const OPERATOR_ANSWER_NOTE =
  '\n\n[claude-peers] This is the human operator ANSWERING you. Act on it now and continue your task. Do NOT acknowledge it and do NOT call send_message toward "operator". If it leaves you blocked again, ask a NEW question with the ask_operator tool.';

export function isOperatorSender(idOrToken: string): boolean {
  return idOrToken === OPERATOR_PEER_ID || idOrToken === OPERATOR_INSTANCE_TOKEN;
}

export function renderOperatorAnswer(text: string): string {
  return `[Operator answer]\n${text}${OPERATOR_ANSWER_NOTE}`;
}

// Deliberately silent on whether to reply -- that is settled elsewhere (the
// instructions block, and the emission-side waiver). A message can carry both
// this note and the waiver, so this note must not add a third opinion on
// replying.
// Governs a different audience: what the agent tells the human operator about
// the exchange, not the peer.
export const PEER_INBOUND_NOTE =
  "\n\n[claude-peers] Peer message: handle it, then continue your task. Do NOT report this exchange to the operator unless it needs a human decision, blocks you, or changes your plan or result; then state the conclusion in one or two sentences, never the message.";

export function renderPeerMessage(text: string): string {
  return `${text}${PEER_INBOUND_NOTE}`;
}

// Read only when the recipient session's own broker-normalized role is
// 'team-lead', never a value carried by the message itself.
// Kept as a separate constant from PEER_INBOUND_NOTE, which is pinned by exact
// equality in a test, so the two guarantees stay independently editable.
export const LEAD_DIRECTIVE_NOTE =
  "\n\n[claude-peers] If the peer that just replied has finished its task and its context is now stale, consider forcing a /clear on it.";

/**
 * fromPeerId must be the sender identity, never a display fallback --
 * check_messages substitutes "<dormant peer>" only in its own prefix line,
 * never here.
 * Nothing in the type system enforces that, and no test can see the swap
 * either: a dormant sender's two possible values both fail every sentinel
 * comparison the same way.
 * recipientRole (compared by strict equality against 'team-lead' only) is
 * scoped to the ordinary-peer branch: a deck announcement or operator answer is
 * never "a peer that just replied", so those two classes ignore it entirely.
 */
export function renderInbound(fromPeerId: string, text: string, recipientRole?: string | null): string {
  if (isDeckSender(fromPeerId)) return renderDeckAnnouncement(text);
  if (isOperatorSender(fromPeerId)) return renderOperatorAnswer(text);
  const base = renderPeerMessage(text);
  return recipientRole === "team-lead" ? `${base}${LEAD_DIRECTIVE_NOTE}` : base;
}
