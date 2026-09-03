import { test, expect, describe } from "bun:test";
import {
  DECK_NO_REPLY_NOTE,
  OPERATOR_ANSWER_NOTE,
  PEER_INBOUND_NOTE,
  LEAD_DIRECTIVE_NOTE,
  renderPeerMessage,
  isDeckSender,
  isOperatorSender,
  renderDeckAnnouncement,
  renderOperatorAnswer,
  renderInbound,
} from "../shared/inbound-framing.ts";
import {
  DECK_PEER_ID,
  DECK_INSTANCE_TOKEN,
  OPERATOR_PEER_ID,
  OPERATOR_INSTANCE_TOKEN,
} from "../shared/types.ts";
import { PEER_NO_REPLY_NOTE } from "../shared/message-framing.ts";

const BODY = "Take the next card, then report to the team-lead when it lands.";

describe("sender-class predicates", () => {
  // Each predicate is compared against TWO forms on purpose. The three receive
  // paths do not all hold the same one, and dropping either comparison
  // un-frames one path silently -- no error, no failing assertion elsewhere,
  // just a message that arrives naked.
  test("each sentinel is recognised by BOTH its peer_id and its instance_token", () => {
    expect(isDeckSender(DECK_PEER_ID)).toBe(true);
    expect(isDeckSender(DECK_INSTANCE_TOKEN)).toBe(true);
    expect(isOperatorSender(OPERATOR_PEER_ID)).toBe(true);
    expect(isOperatorSender(OPERATOR_INSTANCE_TOKEN)).toBe(true);
  });

  test("an ordinary peer, an empty id and a near-miss are neither", () => {
    for (const id of ["desktop-7b2civn-koryphaios-15", "", "<dormant peer>", "decking", "operators"]) {
      expect(isDeckSender(id)).toBe(false);
      expect(isOperatorSender(id)).toBe(false);
    }
  });

  test("the two sentinel families are disjoint, so branch order cannot matter", () => {
    // renderInbound tests deck first, check_messages' display label tests
    // operator first. That divergence is harmless ONLY while no identity
    // belongs to both classes. Asserted rather than assumed, because the day a
    // third sentinel is introduced by copy-pasting one of these predicates,
    // this is the test that fires instead of one of the two orders silently
    // winning.
    for (const id of [DECK_PEER_ID, DECK_INSTANCE_TOKEN]) {
      expect(isOperatorSender(id)).toBe(false);
    }
    for (const id of [OPERATOR_PEER_ID, OPERATOR_INSTANCE_TOKEN]) {
      expect(isDeckSender(id)).toBe(false);
    }
  });
});

describe("renderInbound, the single enforcer", () => {
  test("a deck sender is framed as an announcement, in both id forms", () => {
    for (const id of [DECK_PEER_ID, DECK_INSTANCE_TOKEN]) {
      expect(renderInbound(id, BODY)).toBe(renderDeckAnnouncement(BODY));
    }
  });

  test("an operator sender is framed as an answer, in both id forms", () => {
    for (const id of [OPERATOR_PEER_ID, OPERATOR_INSTANCE_TOKEN]) {
      expect(renderInbound(id, BODY)).toBe(renderOperatorAnswer(BODY));
    }
  });

  test("an ordinary peer message keeps its body intact and gains the peer note as a suffix", () => {
    // Until spec_ec5cf671 this was the byte-identical negative control. The
    // peer class now has a note of its own, so the control becomes: body
    // first, untouched, then PEER_INBOUND_NOTE, and NOT one of the two
    // sentinel framings (a blanket deck framing would fail here).
    const out = renderInbound("desktop-7b2civn-koryphaios-15", BODY);
    expect(out).toBe(`${BODY}${PEER_INBOUND_NOTE}`);
    expect(out).toBe(renderPeerMessage(BODY));
    expect(out.startsWith(BODY)).toBe(true);
    expect(out).not.toContain("[Deck announcement");
    expect(out).not.toContain("[Operator answer]");
    expect(renderInbound("some-peer", "")).toBe(PEER_INBOUND_NOTE);
  });

  test("a dormant sender (empty id) is an ordinary peer, and no display fallback leaks in", () => {
    // check_messages substitutes the literal "<dormant peer>" for its own
    // PREFIX when the broker resolved no peer_id. That substitution must never
    // reach renderInbound: the framing keys on the real sender identity.
    //
    // "" and "<dormant peer>" both match no sentinel, so both take the peer
    // branch and a mutation exchanging them stays green. What the two cases
    // pin is narrower and still worth having -- neither spelling is
    // accidentally classified as a sentinel -- and the un-guarded half is
    // documented on renderInbound itself rather than pretended away here.
    expect(renderInbound("", BODY)).toBe(`${BODY}${PEER_INBOUND_NOTE}`);
    expect(renderInbound("<dormant peer>", BODY)).toBe(`${BODY}${PEER_INBOUND_NOTE}`);
  });
});

describe("spec_ec5cf671: the peer note governs what the agent tells the OPERATOR, nothing else", () => {
  test("the note is pinned literally", () => {
    // Same discipline as OPERATOR_ANSWER_NOTE below: an assertion that
    // re-injects the constant is blind to its own shape.
    expect(PEER_INBOUND_NOTE).toBe(
      "\n\n[claude-peers] Peer message: handle it, then continue your task. Do NOT report this exchange to the operator unless it needs a human decision, blocks you, or changes your plan or result; then state the conclusion in one or two sentences, never the message."
    );
  });

  test("it says nothing about replying, so it can stack with the emission-side waiver", () => {
    // A message sent with expects_reply=false arrives carrying BOTH
    // PEER_NO_REPLY_NOTE (emission) and PEER_INBOUND_NOTE (reception). The
    // first says "do not acknowledge"; the instructions block says "reply".
    // A third opinion here would contradict one of them, so the reception
    // note must not hold one. Asserted on the words, case-insensitively.
    const lower = PEER_INBOUND_NOTE.toLowerCase();
    expect(lower).not.toContain("reply");
    expect(lower).not.toContain("acknowledge");
    expect(lower).not.toContain("send_message");
    const stacked = renderInbound("some-peer", `${BODY}${PEER_NO_REPLY_NOTE}`);
    expect(stacked).toBe(`${BODY}${PEER_NO_REPLY_NOTE}${PEER_INBOUND_NOTE}`);
  });

  test("it names the three cases that DO reach the operator", () => {
    // The ban alone would teach silence on a real blocker. Both halves are
    // asserted, as for the deck note.
    expect(PEER_INBOUND_NOTE).toContain("Do NOT report this exchange to the operator");
    expect(PEER_INBOUND_NOTE).toContain("human decision");
    expect(PEER_INBOUND_NOTE).toContain("blocks you");
    expect(PEER_INBOUND_NOTE).toContain("changes your plan or result");
  });
});

describe("the framing is additive: the sender's own words survive", () => {
  test("the announcement prepends a header and appends the note, keeping the body intact", () => {
    const out = renderDeckAnnouncement(BODY);
    expect(out).toBe(`[Deck announcement -- operator broadcast]\n${BODY}${DECK_NO_REPLY_NOTE}`);
    expect(out).toContain(BODY);
    expect(out.startsWith("[Deck announcement")).toBe(true);
    expect(out.endsWith(DECK_NO_REPLY_NOTE)).toBe(true);
  });

  test("the operator answer prepends a header and appends the note, keeping the body intact", () => {
    const out = renderOperatorAnswer(BODY);
    expect(out).toBe(`[Operator answer]\n${BODY}${OPERATOR_ANSWER_NOTE}`);
    expect(out).toContain(BODY);
    expect(out.startsWith("[Operator answer]")).toBe(true);
    expect(out.endsWith(OPERATOR_ANSWER_NOTE)).toBe(true);
  });

  test("every reception note is separated from the body by a literal blank line", () => {
    // Asserted on the bytes rather than on a "contains": a note glued to the
    // last word of the message reads as part of it, which is exactly the
    // failure mode a `toContain` cannot see.
    expect(DECK_NO_REPLY_NOTE.startsWith("\n\n[claude-peers] ")).toBe(true);
    expect(OPERATOR_ANSWER_NOTE.startsWith("\n\n[claude-peers] ")).toBe(true);
  });
});

describe("card 7defe381 lot B1: LEAD_DIRECTIVE_NOTE, gated on recipientRole === 'team-lead'", () => {
  // spec_6037ee5f. renderInbound's third argument is the RECIPIENT's own
  // normalized role (broker's `myRole`, never the sender's), so a team-lead
  // session reading its inbox gets one extra short instruction the other
  // roles never see. Restricted to the ordinary-peer branch only: a deck
  // announcement or an operator answer is not "an agent that just responded"
  // whose session a team-lead could sensibly /clear, so those two branches
  // stay byte-identical to today regardless of recipientRole.
  test("LEAD_DIRECTIVE_NOTE is its own constant: short, distinct from PEER_INBOUND_NOTE, blank-line separated", () => {
    expect(typeof LEAD_DIRECTIVE_NOTE).toBe("string");
    expect(LEAD_DIRECTIVE_NOTE).not.toBe(PEER_INBOUND_NOTE);
    expect(LEAD_DIRECTIVE_NOTE.length).toBeLessThan(PEER_INBOUND_NOTE.length);
    expect(LEAD_DIRECTIVE_NOTE.startsWith("\n\n[claude-peers] ")).toBe(true);
  });

  test("recipientRole 'team-lead' appends LEAD_DIRECTIVE_NOTE after PEER_INBOUND_NOTE on an ordinary peer message", () => {
    const out = renderInbound("some-peer", BODY, "team-lead");
    expect(out).toBe(`${BODY}${PEER_INBOUND_NOTE}${LEAD_DIRECTIVE_NOTE}`);
  });

  test("any other non-empty role does not receive the directive", () => {
    for (const role of ["developer", "reviewer", "release-engineer"]) {
      expect(renderInbound("some-peer", BODY, role)).toBe(`${BODY}${PEER_INBOUND_NOTE}`);
    }
  });

  test("an empty string role -- the operator-unset default (session-service.ts:529), the majority case measured live -- does not receive the directive", () => {
    expect(renderInbound("some-peer", BODY, "")).toBe(`${BODY}${PEER_INBOUND_NOTE}`);
  });

  test("a null or omitted role does not receive the directive, and omitting the argument entirely is byte-identical to before this lot", () => {
    expect(renderInbound("some-peer", BODY, null)).toBe(`${BODY}${PEER_INBOUND_NOTE}`);
    expect(renderInbound("some-peer", BODY)).toBe(`${BODY}${PEER_INBOUND_NOTE}`);
  });

  test("a deck announcement or an operator answer to a team-lead recipient is untouched: the directive is scoped to the ordinary-peer branch only", () => {
    expect(renderInbound(DECK_PEER_ID, BODY, "team-lead")).toBe(renderDeckAnnouncement(BODY));
    expect(renderInbound(OPERATOR_PEER_ID, BODY, "team-lead")).toBe(renderOperatorAnswer(BODY));
  });
});

describe("card dd388182: the deck note stops forbidding what a dispatch asks for", () => {
  test("it no longer bans messaging other peers, and says so explicitly", () => {
    // THE DEFECT. The previous wording carried "do NOT message any other peer
    // about this announcement (no greetings, no acknowledgements)". A TARGETED
    // announce (broker.ts handleAnnounce, `to_peer_id` branch) is how an
    // operator hands one peer a task, and such a task routinely ends in
    // "report to X". One note served two opposite speech acts, and on the
    // dispatch one it contradicted the payload it was attached to.
    //
    // Both halves are asserted. The negative alone would pass on a note that
    // simply says nothing about the subject, which would leave the model to
    // guess; the positive alone would pass on a note that grants and forbids
    // in the same breath.
    expect(DECK_NO_REPLY_NOTE).not.toContain("do NOT message any other peer");
    expect(DECK_NO_REPLY_NOTE).not.toContain("no greetings");
    expect(DECK_NO_REPLY_NOTE).toContain("free to message any peer");
  });

  test("it still bans the acknowledgement and still bans replying to the deck itself", () => {
    // What was REMOVED must not take these with it. The acknowledgement ban has
    // a real referent (it would flood the operator), and the "deck" ban has an
    // even harder one: that sentinel row is non-routable, so a message aimed at
    // it FAILS. Loosening the note into a general permission would send agents
    // at a target that cannot receive.
    expect(DECK_NO_REPLY_NOTE).toContain("Do NOT acknowledge");
    expect(DECK_NO_REPLY_NOTE).toContain('send_message toward "deck"');
  });

  test("it now carries the semantics already in production in OPERATOR_ANSWER_NOTE", () => {
    // The arbitration was "adopt the wording family that already works", not
    // "invent a third one". Both notes must therefore agree on the two shared
    // properties: act now, do not acknowledge.
    for (const note of [DECK_NO_REPLY_NOTE, OPERATOR_ANSWER_NOTE]) {
      expect(note).toContain("Act on it now");
      expect(note).toContain("Do NOT acknowledge");
    }
  });

  test("OPERATOR_ANSWER_NOTE is untouched by this lot", () => {
    // Regression pin. The lot changes ONE note; this is the assertion that
    // fails if a later "harmonisation" rewrites the one that was already
    // correct, which is how a fix to A silently becomes a change to B.
    expect(OPERATOR_ANSWER_NOTE).toBe(
      '\n\n[claude-peers] This is the human operator ANSWERING you. Act on it now and continue your task. Do NOT acknowledge it and do NOT call send_message toward "operator". If it leaves you blocked again, ask a NEW question with the ask_operator tool.'
    );
  });

  test("the four notes stay four distinct constants", () => {
    // PEER_NO_REPLY_NOTE (shared/message-framing.ts, commit 138fa6f) frames a
    // peer-to-peer waiver at EMISSION; the two here frame a sender class at
    // RECEPTION. Now that all three share the "free to message any peer"
    // property, the temptation to collapse them is real -- and collapsing them
    // would re-key one mechanism on the other's identity, which is the shape
    // CLAUDE.md warns about. They agree on a property; they are not the same
    // thing.
    const notes = [DECK_NO_REPLY_NOTE, OPERATOR_ANSWER_NOTE, PEER_NO_REPLY_NOTE, PEER_INBOUND_NOTE];
    expect(new Set(notes).size).toBe(4);
  });
});
