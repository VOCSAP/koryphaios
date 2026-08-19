// spec_c599a9c5 -- cards e3f8065d (extraction) + dd388182 (note content).
//
// WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT.
// It proves the DECISION: given a sender class and a text, what does the
// recipient read. It cannot prove the WIRING -- measured yesterday on card
// 3d3c7d40, a pure suite stayed 13/13 green while the module it imported was
// connected to nothing. The wiring of the three receive paths, and above all of
// check_messages (which re-implemented the branching inline until this commit),
// is attested by tests/server-inbound-framing-delivery.test.ts, which spawns a
// real broker and real peers. The two files are not redundant, they answer two
// different questions and neither substitutes for the other.
//
// NAMING AND CI. `peer-` prefix: .github/workflows/desktop-build.yml line 79
// collects it (measured 2026-08-19: that glob line matches 134 of the 185 files
// in tests/). This file imports a pure module, binds no port and spawns nothing,
// so it belongs in that matrix. Its E2E counterpart carries `server-` and is
// deliberately NOT collected there, for the reason the workflow states itself.

import { test, expect, describe } from "bun:test";
import {
  DECK_NO_REPLY_NOTE,
  OPERATOR_ANSWER_NOTE,
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

  test("an ordinary peer message is returned BYTE-IDENTICAL", () => {
    // The negative control, and the load-bearing one for the extraction: this
    // is what makes check_messages' output for a plain peer unchanged by the
    // rewrite. A blanket framing would pass every assertion above and fail
    // only here.
    expect(renderInbound("desktop-7b2civn-koryphaios-15", BODY)).toBe(BODY);
    expect(renderInbound("some-peer", "")).toBe("");
  });

  test("a dormant sender (empty id) is not framed, and no display fallback leaks in", () => {
    // check_messages substitutes the literal "<dormant peer>" for its own
    // PREFIX when the broker resolved no peer_id. That substitution must never
    // reach renderInbound: the framing keys on the real sender identity.
    //
    // CORRECTED AFTER REVIEW. This comment used to claim that asserting both
    // spellings CATCHES the swap. It does not, and the claim was measured false:
    // "" and "<dormant peer>" both match no sentinel, so both return the text
    // unchanged and a mutation exchanging them stays green. What the two cases
    // below actually pin is narrower and still worth having -- neither spelling
    // is accidentally classified as a sentinel -- and the un-guarded half is
    // documented as such on renderInbound itself rather than pretended away
    // here.
    expect(renderInbound("", BODY)).toBe(BODY);
    expect(renderInbound("<dormant peer>", BODY)).toBe(BODY);
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

  test("both notes are separated from the body by a literal blank line", () => {
    // Asserted on the bytes rather than on a "contains": a note glued to the
    // last word of the message reads as part of it, which is exactly the
    // failure mode a `toContain` cannot see.
    expect(DECK_NO_REPLY_NOTE.startsWith("\n\n[claude-peers] ")).toBe(true);
    expect(OPERATOR_ANSWER_NOTE.startsWith("\n\n[claude-peers] ")).toBe(true);
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

  test("the three notes stay three distinct constants", () => {
    // PEER_NO_REPLY_NOTE (shared/message-framing.ts, commit 138fa6f) frames a
    // peer-to-peer waiver at EMISSION; the two here frame a sender class at
    // RECEPTION. Now that all three share the "free to message any peer"
    // property, the temptation to collapse them is real -- and collapsing them
    // would re-key one mechanism on the other's identity, which is the shape
    // CLAUDE.md warns about. They agree on a property; they are not the same
    // thing.
    const notes = [DECK_NO_REPLY_NOTE, OPERATOR_ANSWER_NOTE, PEER_NO_REPLY_NOTE];
    expect(new Set(notes).size).toBe(3);
  });
});
