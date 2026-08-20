// spec_c599a9c5 -- cards e3f8065d (extraction) and dd388182 (note content).
//
// WHY THIS MODULE EXISTS. Framing of an INBOUND message by sender class used to
// live inline in server.ts (lines 94-133 before this commit). server.ts exports
// nothing and calls main() at module scope, so nothing could import it, and the
// framing was therefore attested only through a spawned process. That is the
// smaller half of the problem. The larger half, measured on 2026-08-19: there
// are THREE receive paths, and only TWO of them called renderInbound.
//
//   server.ts:363  WS push        -> renderInbound(...)
//   server.ts:416  fallback poll  -> renderInbound(...)
//   server.ts:1242 check_messages -> RE-IMPLEMENTED the same two predicates
//                                    and the same two renderers, inline
//
// The effect was correct in all three, which is exactly what made it dangerous:
// nothing was broken, nothing could fail, and a FOURTH sender class added to
// renderInbound would simply not have applied in check_messages -- silently, no
// error, no failing test. The third path did not share the enforcer, it shared
// a COPY of it. Extracting is therefore not about testability (it buys that
// too), it is about making that third path structurally incapable of diverging:
// there is now one definition, and check_messages consumes it.
//
// WHY THE FRAMING STAYS AT RECEPTION (arbitrated, card dd388182, 2026-08-19).
// shared/message-framing.ts frames PEER-TO-PEER waivers at EMISSION, because a
// per-message field cannot travel without a migration of the 7-column `messages`
// table. The symmetric move was considered here and REFUSED, and the reason is
// worth keeping: a note chosen at emission obliges the receiver to stop adding
// its own, so an OLDER Deck emitting without a note would produce an UNFRAMED
// message. Nothing would go red; the message would simply arrive naked. The
// unconditional reception-side framing below reads like a constraint and is in
// fact the FAIL-CLOSED property of the deck path -- a message from the sentinel
// cannot escape its framing, whatever the emitter's version. It is not traded
// away for an inform-versus-request distinction nobody needs yet; that
// distinction requires a migration and lives with card 3d25073b.
//
// SENDER CLASS IS THE KEY, AND IT KEYS ON TWO FORMS. Each predicate compares
// against BOTH the public peer_id and the reserved instance_token, because the
// three paths do not all see the same one: the WS push and the fallback poll
// carry a resolved peer_id, while a token can reach these functions from the
// broker side. Dropping either comparison silently un-frames one path.

import {
  DECK_PEER_ID,
  DECK_INSTANCE_TOKEN,
  OPERATOR_PEER_ID,
  OPERATOR_INSTANCE_TOKEN,
} from "./types.ts";

// --- Deck announcements (v0.3.4) ---
// Messages whose sender is the reserved 'deck' sentinel are one-way operator
// broadcasts. They must NOT trigger the default channel behaviour ("RESPOND
// IMMEDIATELY / reply with send_message"). Since that instruction is global (not
// per-message), the no-reply guarantee is carried inside the rendered content,
// and reinforced by the sender being non-routable (send_message to 'deck' fails).
// English wording for maximum model compatibility.
//
// CARD dd388182 -- WHY THIS WORDING CHANGED. The previous text also said "do NOT
// message any other peer about this announcement (no greetings, no
// acknowledgements)". That clause forbade what the TARGETED announce path
// routinely ASKS for: a Deck dispatch aimed at one peer (broker.ts
// handleAnnounce, `to_peer_id` branch) is how an operator hands a peer a task,
// and such a task frequently ends in "report to the team-lead". One note was
// serving two opposite speech acts, and on the dispatch one it contradicted the
// payload it was attached to -- a recipient obeying the note would refuse the
// instruction, a recipient obeying the instruction would learn the note is
// negotiable. Both outcomes are worse than no note.
//
// The fix carries NO new signal and needs no migration: the note simply stops
// forbidding what it has no business forbidding, and adopts the semantics
// already in production in OPERATOR_ANSWER_NOTE below (act now, do not
// acknowledge, stay free to talk to others). The two bans that remain are the
// ones with a real referent: the acknowledgement (which would flood the
// operator) and send_message toward "deck" itself (which cannot work -- the
// sentinel row is non-routable by construction, see shared/types.ts).
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

// An ORDINARY peer message, spec_ec5cf671 (2026-08-20). Fourth note, and the
// only one that says nothing about replying. Measured on the operator's side:
// after every peer exchange the receiving agent wrote a paragraph to the
// operator ("the peer confirms, I am asking it about X, still waiting on Y"),
// which the operator never needed. None of the three existing framings could
// carry the rule: the MCP `instructions` block is read once at session start
// and loses against the most recent turn, PEER_NO_REPLY_NOTE
// (shared/message-framing.ts) only travels when the SENDER waives a reply, and
// nothing framed a plain peer message at all.
//
// The note is deliberately SILENT on whether to reply. Replying is settled
// elsewhere -- by the instructions block (reply, then resume) and by the
// emission-side waiver (do not acknowledge). A message can carry BOTH the
// waiver and this note, so this note must not contain a third opinion on the
// same question; the suite pins that it names neither "reply" nor
// "acknowledge". What it governs is the OTHER audience: what the agent tells
// the human about the exchange.
export const PEER_INBOUND_NOTE =
  "\n\n[claude-peers] Peer message: handle it, then continue your task. Do NOT report this exchange to the operator unless it needs a human decision, blocks you, or changes your plan or result; then state the conclusion in one or two sentences, never the message.";

export function renderPeerMessage(text: string): string {
  return `${text}${PEER_INBOUND_NOTE}`;
}

/**
 * Framing of an inbound message, by sender class. THE single enforcer: all
 * three receive paths in server.ts call this, so a fourth sender class is added
 * here once instead of being added here and forgotten in check_messages.
 *
 * An ordinary peer-to-peer message keeps its body intact and gains
 * PEER_INBOUND_NOTE as a suffix (it was returned byte-identical until
 * spec_ec5cf671). The dormant-sender case (empty id) is an ordinary peer.
 *
 * `fromPeerId` must be the sender identity, never a display fallback:
 * check_messages substitutes the literal "<dormant peer>" when the broker
 * resolved no peer_id, and that substitution belongs to its own prefix line.
 *
 * NOTHING ENFORCES THAT, and saying so is the point of this paragraph. The
 * parameter is a bare `string`, so no type refuses the display value, and NO
 * TEST CAN SEE THE SWAP EITHER: measured during review, a dormant sender yields
 * "" through one route and "<dormant peer>" through the other, two strings that
 * match no sentinel, so both produce the same output. The property is correct
 * by INTENTION and guarded by nothing, and it stays untestable at the behaviour
 * level for exactly as long as classification is a strict equality. It would
 * become a real defect, silently, the day a class is keyed on anything else (a
 * prefix, a normalized compare, a regex). Pinning it needs a nominal type on the
 * identity, which is carded, not done here.
 */
export function renderInbound(fromPeerId: string, text: string): string {
  if (isDeckSender(fromPeerId)) return renderDeckAnnouncement(text);
  if (isOperatorSender(fromPeerId)) return renderOperatorAnswer(text);
  return renderPeerMessage(text);
}
