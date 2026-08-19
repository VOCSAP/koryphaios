// spec_d7cd3308 / spec_258af6eb -- card 3d3c7d40 volet A: the `expects_reply`
// waiver on send_message, and the text it makes a peer receive.
//
// WHAT THIS FILE COVERS, AND WHAT IT DELIBERATELY DOES NOT.
// This suite is PURE: it imports shared/message-framing.ts and spawns nothing,
// which is why it carries the `peer-` prefix (a CI-collected glob) rather than
// `broker-`/`server-` (the daemon-spawning families exempted from that glob).
// Whether that naming actually holds is NOT re-checked here: the repo-wide
// guard tests/desktop-ci-glob-coverage.test.ts already audits every
// tests/*.test.ts against the globs parsed out of the workflow, so a local copy
// would only duplicate it -- and the local copy that first shipped here also
// asserted "exactly ONE `run: bun test` line", a brand-new coupling that would
// have gone red the day the workflow gained a second legitimate job without any
// file having stopped being collected.
//
// It covers the pure DECISION only. The WIRING of that decision into
// server.ts's send_message case is attested by
// tests/broker-expects-reply-delivery.test.ts, which spawns a broker plus two
// peers and asserts on what the recipient really receives. That split is not
// tidiness: review measured that removing the second argument at the server.ts
// call site left THIS suite fully green, so a pure suite cannot be the proof
// that the feature is connected to anything.
//
// Every assertion below is on the RENDERED TEXT, never on a stored field.
// That is the card's acceptance criterion and it is also the only thing an
// agent actually reacts to.

import { expect, test } from "bun:test";
import { OPERATOR_INSTANCE_TOKEN, OPERATOR_PEER_ID } from "../shared/types.ts";
import { composeOutboundMessage, PEER_NO_REPLY_NOTE } from "../shared/message-framing.ts";

const SAMPLE = "Card 3d3c7d40 is done, the suite is green.";

// --- Backward compatibility: the absent field ---

test("expects_reply absent returns the caller's text byte for byte", () => {
  // Strict equality, not toContain: "unchanged" is the whole guarantee, and a
  // substring check would still pass if a note had been appended.
  expect(composeOutboundMessage(SAMPLE)).toBe(SAMPLE);
  expect(composeOutboundMessage(SAMPLE, undefined)).toBe(SAMPLE);
});

test("expects_reply true returns the caller's text byte for byte", () => {
  expect(composeOutboundMessage(SAMPLE, true)).toBe(SAMPLE);
});

// --- The waiver itself ---

test("expects_reply false appends the no-reply note to the caller's text", () => {
  const out = composeOutboundMessage(SAMPLE, false);
  expect(out).toContain(SAMPLE);
  expect(out).toContain(PEER_NO_REPLY_NOTE);
  expect(out).not.toBe(SAMPLE);
});

test("the note carries the phrasing an agent has to act on", () => {
  // Pinned on the words, not just on "some constant was appended": the
  // feature's whole effect is that a model reads these and skips its turn.
  // If the wording is reworded away from this intent, that is a decision, and
  // it should have to be taken here explicitly.
  const out = composeOutboundMessage(SAMPLE, false);
  expect(out).toContain("No reply expected");
  expect(out).toContain("do not acknowledge");
});

test("the framed portion is a code constant, independent of the caller's text", () => {
  // POINTER CORRECTED after review measured it. The suffix comparison below is
  // NOT the enforcer: an implementation that interpolated the caller's text
  // UNIFORMLY into the note would produce equal suffixes for these two inputs
  // and sail through it. The assertion that actually bites is the last one,
  // against the literal `text + PEER_NO_REPLY_NOTE` shape. The comparison is
  // kept because it fails on a NON-uniform leak (a note that embeds the
  // message once), which is the cheaper mistake to make -- but the load-bearing
  // check is the exact-shape one.
  const a = composeOutboundMessage("first message", false);
  const b = composeOutboundMessage("a completely different second message", false);
  expect(a.slice("first message".length)).toBe(b.slice("a completely different second message".length));
  expect(a).toBe(`first message${PEER_NO_REPLY_NOTE}`);
});

test("the note opens with a blank line, asserted literally", () => {
  // Every other assertion in this file re-injects PEER_NO_REPLY_NOTE, so all of
  // them are blind to the constant's OWN shape: deleting its leading "\n\n"
  // left the whole suite green (measured in review). Without that separator the
  // note runs into the last sentence of the caller's message and reads as the
  // sender's own words, so the separator is contract, not formatting.
  expect(PEER_NO_REPLY_NOTE.startsWith("\n\n")).toBe(true);
  expect(composeOutboundMessage("ends here.", false)).toBe(
    `ends here.\n\n[claude-peers] ${PEER_NO_REPLY_NOTE.slice("\n\n[claude-peers] ".length)}`
  );
});

test("the waiver does not restrict whom the recipient may contact", () => {
  // The arbitrage that made this a NEW constant instead of a reuse of
  // DECK_NO_REPLY_NOTE. At the time (card 3d3c7d40) that note ALSO forbade
  // messaging any other peer about the message, which is wrong for a
  // peer-to-peer inform -- and already contradicted the Deck's own dispatch
  // text, which tells the team-lead to brief another peer with send_message.
  //
  // UPDATED, cards e3f8065d + dd388182: that note has since moved to
  // shared/inbound-framing.ts AND lost the offending clause, so the
  // contradiction described above no longer exists there. The assertions below
  // are unchanged and keep their point: they pin THIS constant's own property,
  // so that a later "harmonisation" collapsing the three notes -- now that they
  // agree on it -- cannot silently re-key one mechanism on another's identity.
  // The counterpart assertion on the deck note lives in
  // tests/peer-inbound-framing.test.ts.
  expect(PEER_NO_REPLY_NOTE).not.toContain("do NOT message any other peer");
  expect(PEER_NO_REPLY_NOTE).toContain("free to message any peer");
});

// --- Strict boolean at the boundary (hostile input #4: an MCP tool arg) ---

test("only the boolean false waives the reply; every other value does not", () => {
  // expects_reply arrives from an MCP tool call, so the inputSchema is a claim
  // about the caller, not a guarantee about the value. Each case below breaks
  // a DIFFERENT plausible-but-wrong implementation:
  //   "false"  -> a truthiness test (`if (!expectsReply)`) reads this as TRUE,
  //               so it would keep the reply expected... while `Boolean()`
  //               coercion reads the STRING as truthy too. The string is the
  //               case a model that stringifies its arguments actually sends,
  //               and it must not silently waive anything.
  //   0 / "" / null -> a truthiness test reads these as falsy and WOULD waive
  //               the reply, inverting the meaning for a loosely-typed client.
  for (const value of ["false", "true", 0, 1, "", null, NaN, [], {}]) {
    expect(composeOutboundMessage(SAMPLE, value)).toBe(SAMPLE);
  }
});

test("an empty message with the waiver does not turn the note into the payload", () => {
  // MEASURED, because the obvious comment here would be wrong: broker.ts's
  // handleSendMessage has NO empty-text guard at all (unlike handleAnnounce,
  // which returns {sent: 0} on empty text), so an empty message is already
  // accepted today. There is therefore no upstream refusal for this to
  // preserve. What is pinned instead is that composing never manufactures
  // content out of an empty message on the DEFAULT path, which would make an
  // accidental empty send look deliberate.
  expect(composeOutboundMessage("")).toBe("");
  expect(composeOutboundMessage("   ")).toBe("   ");
  // With the waiver, the note is appended as for any other text: the decision
  // is on the FIELD only, never on the content. Accepted consequence, pinned
  // here rather than left implicit: an EMPTY message plus the waiver becomes a
  // non-empty payload (the note alone). Since there is no empty-text refusal
  // on this path to begin with, that turns a silent empty send into a visible
  // one, which is the better of the two outcomes -- but it IS a delta, so it
  // is asserted rather than discovered later.
  expect(composeOutboundMessage("", false)).toBe(PEER_NO_REPLY_NOTE);
});

test("a message that already quotes the note is not treated specially", () => {
  // The decision never inspects the text, so quoting the note inside a
  // message (e.g. an agent discussing this very feature) cannot suppress or
  // duplicate the framing by itself.
  const quoting = `I read this in the docs: ${PEER_NO_REPLY_NOTE}`;
  expect(composeOutboundMessage(quoting)).toBe(quoting);
  expect(composeOutboundMessage(quoting, false)).toBe(`${quoting}${PEER_NO_REPLY_NOTE}`);
});

// --- The operator inbox is a PERSON, never framed ---

test("a message to the operator is never framed, whatever expects_reply says", () => {
  // send_message accepts to_peer_id 'operator', and server.ts does not special-
  // case it, so the waiver used to apply there too: an agent passing
  // expects_reply:false would drop ~250 characters of AGENT-directed
  // instructions ("continue your current task") into a HUMAN's desktop inbox.
  // Worse than noise: for that destination the recipient's answer IS the point
  // of the channel, so a waiver is meaningless there by construction.
  expect(composeOutboundMessage(SAMPLE, false, OPERATOR_PEER_ID)).toBe(SAMPLE);
  // The raw sentinel token too. It cannot actually deliver anything (the broker
  // resolves to_peer_id as a peer_id and 404s on it), but the refusal to FRAME
  // is the direction that costs nothing to keep closed.
  expect(composeOutboundMessage(SAMPLE, false, OPERATOR_INSTANCE_TOKEN)).toBe(SAMPLE);
});

test("an ordinary peer target is still framed, so the exclusion is not blanket", () => {
  // Negative control for the test above: without this, an implementation that
  // suppressed the framing for EVERY target would pass the operator test while
  // silently disabling the whole feature.
  expect(composeOutboundMessage(SAMPLE, false, "desktop-7b2civn-koryphaios-15")).toBe(
    `${SAMPLE}${PEER_NO_REPLY_NOTE}`
  );
  // Target absent (the shape every pre-existing caller has) must behave like an
  // ordinary peer, not like the operator.
  expect(composeOutboundMessage(SAMPLE, false)).toBe(`${SAMPLE}${PEER_NO_REPLY_NOTE}`);
  expect(composeOutboundMessage(SAMPLE, false, undefined)).toBe(`${SAMPLE}${PEER_NO_REPLY_NOTE}`);
});

// --- The text argument is as hostile as the flag ---

test("a non-string message is returned unchanged instead of coerced", () => {
  // Asymmetry closed in review: `expects_reply` was treated as hostile while
  // `message` was trusted, yet BOTH come from the same unvalidated MCP
  // arguments object and the SDK enforces no `required`. Interpolating a
  // missing message used to deliver the literal string "undefined" to a peer,
  // turning a malformed call that should fail into a message that ships.
  for (const bad of [undefined, null, 42, {}, []]) {
    const out = composeOutboundMessage(bad as unknown as string, false);
    expect(out).toBe(bad as unknown as string);
    expect(String(out)).not.toContain("[claude-peers]");
  }
});
