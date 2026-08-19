// Outbound framing of a peer-to-peer message (card 3d3c7d40, volet A).
//
// WHY THIS LIVES HERE, AND NOT IN server.ts NEXT TO ITS THREE SIBLINGS.
// server.ts owned three INBOUND no-reply framings (DECK_NO_REPLY_NOTE,
// OPERATOR_ANSWER_NOTE and the renderInbound dispatcher that picks between
// them), but it has ZERO exports and calls main() at module scope, so nothing
// in it could be imported by a test -- tests/server-ask-operator.test.ts has to
// spawn `bun server.ts` and speak JSON-RPC on stdin just to observe it. The
// acceptance criterion for this feature is stated on the RENDERED TEXT rather
// than on a stored field, so the composition had to become importable.
//
// UPDATE, card e3f8065d: those three siblings have since moved out of server.ts
// too, into shared/inbound-framing.ts. The two modules stay SEPARATE on purpose
// and the split is not "old versus new": this one composes at EMISSION, keyed
// on a per-message argument, and the other frames at RECEPTION, keyed on the
// SENDER CLASS. Merging them would put one mechanism's identity in the other's
// hands. The SCOPE block below is the record of that arbitration.
//
// WHY THE FRAMING HAPPENS AT EMISSION, NOT AT RECEPTION.
// The broker's `messages` table has seven columns and zero ALTER TABLE
// statements against it, so an `expects_reply` flag has nowhere to travel: it
// cannot reach the recipient's process. Composing the final text in the
// SENDER's server.ts sidesteps that entirely, and buys three properties by
// construction rather than by care:
//   1. no schema migration and no broker change -- the broker still moves an
//      opaque string, so handleSendMessage and recordMessageTx are untouched;
//   2. backward compatibility is structural, not tested-for -- a recipient
//      running an older build receives ordinary text and renders it, because
//      the note IS the text;
//   3. the note reaches ALL THREE of the recipient's receive paths (the
//      WebSocket push and the fallback poll, which both go through
//      renderInbound, AND the check_messages tool, which re-implements that
//      branching inline and would otherwise have missed a fourth case).
//      Property 3 is a side effect worth naming: it is the reason this
//      feature does not first have to repair that divergence.
//
// HOSTILE INPUT. `expects_reply` is an agent-facing MCP tool argument (the
// fourth of CLAUDE.md's five hostile inputs), not a broker HTTP field -- it
// never crosses the network at all under the emission-time design. It is
// therefore validated HERE, by strict boolean identity, and the enforcer is
// `expectsReply !== false` in composeOutboundMessage below: no truthiness, no
// coercion, no `Boolean()`. That matters concretely because a model that
// stringifies its arguments sends the string "false", which every
// truthiness test reads as TRUE and which a `!expectsReply` test would read as
// FALSE -- inverting the meaning of the flag in one direction or the other.
// Only the CHOICE between "append the constant" and "append nothing" depends
// on the caller; the framed words themselves are the code literal below and
// can never come from the caller.
//
// SCOPE. This module deliberately did NOT touch the no-reply wordings already
// shipped, nor unify the three receive paths; both were carded separately,
// dd388182 for the DECK_NO_REPLY_NOTE-versus-dispatch-text contradiction and
// e3f8065d for the check_messages render-path divergence. Both have SHIPPED
// since: the deck and operator notes live in shared/inbound-framing.ts and the
// deck one lost its offending clause. Still untouched, and still out of scope
// here: the join note in desktop/src/shared/announce.ts, and the spawn-ack
// sentence in desktop/src/main/team-embedded.ts (deduplicated within its own
// file by e3f8065d, but not unified with the core module -- doing so needs a
// line in desktop/tsconfig.node.json's explicit include list and reopens the
// question of notes STACKING at emission and reception).
//
// RATIFIED DEVIATION FROM THE CARD, recorded here so the next reader does not
// take it for an accident. Card 3d3c7d40 said "copy the wording already
// shipped, do not invent a second one". PEER_NO_REPLY_NOTE below IS a new,
// fifth wording. The team-lead asked for it explicitly in review, and the
// reason is measured rather than stylistic: there were already FOUR wordings,
// so there was no single "the" wording to copy, and the most-cited candidate
// (DECK_NO_REPLY_NOTE) carried the very defect that card dd388182 filed as a
// bug -- a defect since FIXED, in the lot that also performed e3f8065d, which
// is why the two notes now agree on that one property while staying two
// distinct constants. Reusing it would have propagated the bug to a second
// site, and would have fused two speech situations under one string. The
// deviation is deliberate; see the constant's own doc for the semantic
// difference that motivates it.

import { OPERATOR_INSTANCE_TOKEN, OPERATOR_PEER_ID } from "./types.ts";

/**
 * Appended verbatim when, and only when, the sender explicitly waived the
 * acknowledgement. A CODE CONSTANT: never assembled from caller input.
 *
 * Modelled on OPERATOR_ANSWER_NOTE, NOT on DECK_NO_REPLY_NOTE (both now in
 * shared/inbound-framing.ts), and the difference is the whole point of writing
 * a new one instead of reusing either:
 *
 *  - OPERATOR_ANSWER_NOTE separates "act on this" from "do not acknowledge
 *    it", which is exactly the semantics wanted here. A peer-to-peer `inform`
 *    is frequently actionable; what is being waived is the receipt, not the
 *    work.
 *  - DECK_NO_REPLY_NOTE, AT THE TIME, additionally forbade messaging ANY other
 *    peer about the message. That is wrong for a peer-to-peer inform -- the
 *    sender has no business restricting whom the recipient may talk to -- and
 *    it was measurably wrong where it was used: the Deck's roadmap dispatch
 *    text tells the team-lead to "brief another peer with send_message", and
 *    that note was appended right underneath it. Card dd388182 has since
 *    removed the clause there as well, so this bullet now records WHY this
 *    constant exists rather than a live difference. The two remain separate
 *    because they are keyed differently: this one on a per-message argument at
 *    emission, that one on the sender class at reception.
 *
 * The closing sentence exists to pre-empt the failure mode the whole card is
 * about: an agent that reads "no reply expected" as "say nothing to anyone"
 * and stalls, instead of one that simply skips the receipt.
 *
 * The leading "\n\n" is part of the contract, not incidental formatting: the
 * note is CONCATENATED onto arbitrary caller text, so without a blank line it
 * would run into the last sentence of the message and read as the sender's own
 * words. It is asserted literally by the suite, because assertions that
 * re-inject this constant are by construction blind to its own shape.
 */
export const PEER_NO_REPLY_NOTE =
  '\n\n[claude-peers] No reply expected -- do not acknowledge. The sender explicitly waived a response to THIS message: do NOT send back a confirmation, a thank-you or a "received" of any kind. Take it into account in your work if relevant, then continue your current task. This waives only the acknowledgement: you stay free to message any peer, including this sender, when your OWN work needs it.';

/**
 * True when a `send_message` target designates the reserved `operator`
 * sentinel, i.e. the HUMAN operator's desktop inbox rather than an agent.
 *
 * Mirrors BY SHAPE the `isOperatorSender` predicate (same two constants, same
 * `||`). The original reason for duplicating it -- server.ts had no exports --
 * DIED with card e3f8065d, which moved that predicate into
 * shared/inbound-framing.ts where it is now importable. It is still not
 * imported, for a reason that outlives the first: the two take different
 * inputs. `isOperatorSender` receives a resolved `string` from the broker;
 * this one receives an `unknown` straight off an MCP tool argument, where a
 * non-string is a case to be handled, not a type error to be cast away.
 * Sharing the predicate would mean widening the trusted one's signature to
 * accommodate the hostile one's caller. Both identities are checked even though the tool
 * argument is a `peer_id`: passing the raw sentinel token as a `to_peer_id`
 * would not deliver anything (the broker resolves it as a peer_id and 404s),
 * so accepting it here costs nothing and keeps the refusal closed on the only
 * direction that matters -- deciding NOT to frame.
 */
function isOperatorTarget(targetPeerId: unknown): boolean {
  return targetPeerId === OPERATOR_PEER_ID || targetPeerId === OPERATOR_INSTANCE_TOKEN;
}

/**
 * Compose the text a peer will actually receive.
 *
 * @param text         the caller's message. Passed through untouched, and
 *                     RE-CHECKED as a string rather than trusted: it arrives
 *                     from the same unvalidated MCP arguments object as
 *                     `expectsReply`, and the SDK enforces no `required`, so
 *                     treating one as hostile and the other as sound would be
 *                     an asymmetry with a real consequence -- interpolating a
 *                     missing `message` used to deliver the literal string
 *                     "undefined" to a peer.
 * @param expectsReply the caller's `expects_reply` argument, typed `unknown`
 *                     because this is the trust BOUNDARY, not because of
 *                     testability: the declared inputSchema states what the
 *                     caller was asked for, never what arrived. Typing it
 *                     `boolean` would make the compiler vouch for something no
 *                     runtime check had established.
 * @param targetPeerId the resolved `to_peer_id`. Present so the operator inbox
 *                     can be excluded: `send_message` accepts
 *                     `to_peer_id: "operator"`, which reaches a PERSON, and a
 *                     human inbox must not receive agent-directed instructions
 *                     like "continue your current task". For that destination
 *                     the recipient's answer is the entire purpose of the
 *                     channel, so the waiver is meaningless there by
 *                     construction -- it is refused in code rather than
 *                     documented as a caveat.
 *
 * Returns `text` UNCHANGED unless all three conditions hold: `text` really is
 * a string, `expectsReply` is strictly the boolean `false`, and the target is
 * not the operator. That asymmetry is the backward-compatibility guarantee: a
 * caller that omits the field gets the identical string it passed in, so
 * nothing about today's behaviour can shift.
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
