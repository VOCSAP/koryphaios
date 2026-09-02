// Composed at emission, in the sender's server.ts, rather than at reception, so
// no schema migration is needed and the note reaches all three of the
// recipient's receive paths without depending on their build.
// expects_reply is an untrusted MCP tool argument, validated by strict boolean
// identity (expectsReply !== false) -- no truthiness or coercion, since a model
// that stringifies its arguments sends "false", which truthiness reads as true.
// Only the append/don't-append choice depends on the caller; the framed words
// themselves are a code literal.

import { OPERATOR_INSTANCE_TOKEN, OPERATOR_PEER_ID } from "./types.ts";

/**
 * Modelled on OPERATOR_ANSWER_NOTE, not DECK_NO_REPLY_NOTE: it separates "act
 * on this" from "do not acknowledge", since a peer-to-peer inform is frequently
 * actionable and only the receipt is being waived.
 * The leading "\n\n" is part of the contract, not formatting -- the note is
 * concatenated onto arbitrary caller text, so without it the note would run
 * into the caller's last sentence.
 */
export const PEER_NO_REPLY_NOTE =
  '\n\n[claude-peers] No reply expected -- do not acknowledge. The sender explicitly waived a response to THIS message: do NOT send back a confirmation, a thank-you or a "received" of any kind. Take it into account in your work if relevant, then continue your current task. This waives only the acknowledgement: you stay free to message any peer, including this sender, when your OWN work needs it.';

/**
 * Not shared with isOperatorSender despite checking the same two constants:
 * that one receives a resolved string from the broker, this one receives
 * unknown straight off an MCP tool argument, where a non-string must be
 * handled, not cast away.
 * Both OPERATOR_PEER_ID and OPERATOR_INSTANCE_TOKEN are checked even though the
 * argument is a peer_id, since accepting the raw token here costs nothing and
 * keeps the refusal closed.
 */
function isOperatorTarget(targetPeerId: unknown): boolean {
  return targetPeerId === OPERATOR_PEER_ID || targetPeerId === OPERATOR_INSTANCE_TOKEN;
}

/**
 * @param text passed through untouched but re-checked as a string rather than
 * trusted, since it arrives from the same unvalidated MCP arguments object as
 * expectsReply.
 * @param expectsReply typed unknown because this is the trust boundary -- the
 * declared inputSchema states what was asked for, never what arrived.
 * @param targetPeerId present so the operator inbox can be excluded: a human
 * inbox must not receive agent-directed text like "continue your current task",
 * so the waiver is refused in code for that destination.
 * Returns text unchanged unless text is really a string, expectsReply is
 * strictly false, and the target is not the operator -- a caller that omits the
 * field gets back the identical string it passed in.
 */
export function composeOutboundMessage(
  text: string,
  expectsReply?: unknown,
  targetPeerId?: unknown
): string {
  if (typeof text !== "string" || expectsReply !== false || isOperatorTarget(targetPeerId)) {
    return text;
  }
  return `${text}${PEER_NO_REPLY_NOTE}`;
}
