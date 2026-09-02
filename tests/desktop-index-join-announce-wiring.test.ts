// Card 8cb54a0f, phase 2 (test-eng, team-lead brief desktop-7b2civn-
// koryphaios-3): the WIRING half of the three-level join-announce gate
// ('off' | 'lead' | 'all', default 'off'). tests/desktop-join-announce-gate
// .test.ts already proves the pure decision (joinAnnounceTargets, real
// import, no slicing needed -- shared/announce.ts has no electron import).
// This file proves the two properties that a pure-function test CANNOT:
//
//   B (behavioural, slice+fakes): the spawn-ack accuse to the supervisor
//   (announceToSupervisor, called from the service.on('peer-resolved', ...)
//   handler) is not chained after the announce gate's outcome -- it fires on
//   FIRST RESOLUTION whatever the gate decided. And the gated dispatch itself
//   routes correctly on each of the three decision shapes (silent/broadcast/
//   targets) it receives from joinAnnounceTargets.
//
//   C (textual PRESENCE+ABSENCE): the gate check lives ONLY on the dedicated
//   peer-announce dispatch path -- and is textually ABSENT from every OTHER
//   function in index.ts whose body calls sendAnnounce(. This is the property
//   a slice-and-fake test on the CURRENT call graph cannot catch by itself: if
//   the gate check migrated into a shared/other announce emitter, a test that
//   fakes that one function would keep passing unchanged while the real
//   function silently swallowed announces from every OTHER caller too.
//
//   REVIEW ROUND 2 (team lead + reviewer, 2026-08-27): the first version of
//   this ABSENCE check hardcoded exactly two anchor names (broadcastAnnounce,
//   announceToSupervisor). A mirror-mutation review found index.ts actually
//   has SEVEN sendAnnounce( emitters, and a mutant planting the gate inside
//   announceTo (an OBJECT-PROPERTY-SHORTHAND arrow, `announceTo: async (...)
//   => {...}`, not a `const NAME = async` declaration) passed the two-anchor
//   sweep clean: `13 pass / 0 fail`, the domain simply never looked there. The
//   ABSENCE check below is now DERIVED (regex over the whole file for both
//   declaration shapes, filtered to bodies containing sendAnnounce(, excluding
//   the GATED names) instead of a hand-kept list, with a cardinality floor
//   (>=6) so the domain shrinking silently (a renamed emitter, a regex that
//   stops matching) reddens instead of quietly sweeping fewer functions.
//
//   REVIEW ROUND 4 (team-lead brief desktop-7b2civn-koryphaios-6, 2026-09-01)
//   -- THE EXTRACTION, and why this file grew a NEW property rather than
//   merely being repointed. A developer shared the DISPATCH half of
//   sendJoinAnnounce into `sendPeerAnnounce(peerId, text, subject)` so a new
//   peer_id ROTATION notice (card 6f59c73a L1, desktop/src/main/peer-rotation
//   .ts) goes through the SAME level gate and the SAME send path;
//   sendJoinAnnounce became a one-line delegation. This guard failed CLOSED on
//   that reshape (`sendJoinAnnounce: anchor not found -- index.ts changed
//   shape`), which is the anti-vacuity path doing its job, not a bug.
//
//   VERDICT ON THE SHARING ITSELF: the extraction PRESERVES what property C
//   protected -- but only once the guard also pins the CALLER SET of the
//   shared dispatch, which is a route the old ABSENCE sweep is blind to by
//   construction. C used to say "the gate is textually absent from every other
//   sendAnnounce emitter". After the extraction, the gate can reach a
//   general-purpose emitter WITHOUT any gate identifier ever appearing in that
//   emitter's body: it is enough for broadcastAnnounce (or announceToSupervisor,
//   or announceTo) to DELEGATE to sendPeerAnnounce. The textual sweep stays
//   green, and every announce from every other caller silently becomes
//   level-gated -- the exact defect C exists to prevent, arriving by a door C
//   does not watch. The `C CALLER SET` test below closes that door by
//   arithmetic (see its own comment), and is a strict REINFORCEMENT: nothing
//   in this file was relaxed to accommodate the reshape.
//
//   Two further consequences of the extraction, both covered below:
//     - the B dispatch tests now slice sendPeerAnnounce (which carries the
//       body they always proved) and a NEW behavioural test proves that
//       sendJoinAnnounce really DELEGATES to it, with the composed join text
//       and the 'join' subject -- coverage that could not exist while the body
//       was inline, and that a bare repointing would have dropped on the floor.
//     - the peer-resolved handler now dispatches through the real
//       decidePeerAnnounce (join / rotation / silent) and must NOT fire a
//       pending spawn ack on a rotation (an ack means "this spawn connected",
//       which a rotation is not). Asserted, including that the pending ack
//       stays pending rather than being consumed silently.
//
// index.ts imports electron and fails to resolve even before reaching it
// (measured: `bun test` on a bare `import("../desktop/src/main/index.ts")`
// throws `Cannot find module '@shared/palette'`, phase-1 report to
// desktop-7b2civn-koryphaios-3) -- so both B and C read the file as TEXT via
// slice(), never `import()` it. Same technique as
// tests/desktop-approval-defer.test.ts (slice+evaluate/register(env)) and
// tests/desktop-idle-lock-wiring-sweep.test.ts (PRESENCE+ABSENCE regex sweep).
// peer-rotation.ts, by contrast, is pure (no electron import) and is imported
// FOR REAL below, so the handler's branch dispatch is exercised against the
// real decision rather than a fake that could agree with a wrong branch.
//
// Replayable negative control, same convention as desktop-approval-defer.
// test.ts (see its own header): point INDEX at an older/mutated copy via
//   KORY_INDEX_TS=/path/to/mutated-index.ts bun test ./tests/desktop-index-join-announce-wiring.test.ts
// This is how every mutation cited in this header was shown RED on a mirror
// OUTSIDE the repo (the real desktop/src/main/index.ts is held by another
// agent and is never mutated) -- see the test-eng report to the team lead for
// the exact commands and decisive output.

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decidePeerAnnounce } from "../desktop/src/main/peer-rotation.ts";
import { extractBracedBody } from "./_braced-body";

const INDEX =
  process.env.KORY_INDEX_TS || join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");
// index.ts is CRLF on disk; normalise line endings only, mirrors
// desktop-approval-defer.test.ts.
const SRC = readFileSync(INDEX, "utf8").replace(/\r\n/g, "\n");

/** The one dispatch function the level gate is allowed to live in. */
const GATED_DISPATCH = "sendPeerAnnounce";
/**
 * Names excluded from the ABSENCE sweep: the gated dispatch itself, and the
 * join wrapper that delegates to it. Both are SUPPOSED to be on the gate's
 * side of the line. Every other sendAnnounce( emitter is swept.
 */
const GATED_NAMES = [GATED_DISPATCH, "sendJoinAnnounce"];

/**
 * Cut one top-level statement out of index.ts, from `anchor` to the first
 * terminator listed (earliest wins). Fail CLOSED: an anchor that no longer
 * matches (rename/reshape) THROWS rather than returning an empty/vacuous
 * slice, so a test built on top of this never silently degrades to "0 checks,
 * green" -- which is exactly what happened, loudly and correctly, when the
 * dispatch was extracted (review round 4 above).
 */
function slice(anchor: string, terminators: string[], label: string): string {
  const start = SRC.indexOf(anchor);
  if (start < 0) throw new Error(`${label}: anchor not found -- index.ts changed shape`);
  const ends = terminators
    .map((t) => ({ t, i: SRC.indexOf(t, start) }))
    .filter((c) => c.i >= 0)
    .sort((a, b) => a.i - b.i);
  if (ends.length === 0) throw new Error(`${label}: no terminator after the anchor`);
  const body = SRC.slice(start, ends[0].i + ends[0].t.length - 1);
  const lineOf = (idx: number) => SRC.slice(0, idx).split("\n").length;
  console.log(
    `[${label}] index.ts lines ${lineOf(start)}..${lineOf(ends[0].i)} ` +
      `(${body.length} bytes, sha256 ${createHash("sha256").update(body).digest("hex").slice(0, 16)})`
  );
  return body;
}

// The shared dispatch: the body the B routing tests have always proved, at its
// new address.
const SEND_PEER_ANNOUNCE = slice(
  "const sendPeerAnnounce = async (peerId: string, text: string, subject: string): Promise<void> => {",
  ["\n}\n"],
  "sendPeerAnnounce"
);
// The join wrapper. It is now an EXPRESSION-bodied arrow with no braces, so a
// column-0 `\n}\n` terminator would run straight past it into
// sendPeerAnnounce's body and yield a silently MIXED slice instead of an
// error. The blank-line terminator is listed for that reason (earliest wins);
// a future reshape back into a braced body still terminates correctly, and any
// shape that produces a syntactically broken fragment dies at evaluate()-time
// rather than passing vacuously.
const SEND_JOIN_ANNOUNCE = slice(
  "const sendJoinAnnounce = async (peerId: string, intent: JoinAnnounceIntent): Promise<void> =>",
  ["\n\n", "\n}\n"],
  "sendJoinAnnounce"
);
const PEER_RESOLVED_HANDLER = slice(
  "service.on(\n  'peer-resolved',",
  ["\n)\n", "\n})\n"],
  "peer-resolved handler"
);

// Anti-vacuity floor: no slice should ever come back suspiciously short (an
// anchor matching a decoy earlier in the file, or a terminator picked too
// early, would silently produce a near-empty body instead of throwing).
for (const [label, body] of [
  ["sendPeerAnnounce", SEND_PEER_ANNOUNCE],
  ["sendJoinAnnounce", SEND_JOIN_ANNOUNCE],
  ["peer-resolved handler", PEER_RESOLVED_HANDLER]
] as const) {
  test(`slice floor: ${label} extracted at least 100 bytes`, () => {
    expect(body.length).toBeGreaterThan(100);
  });
}

interface Emitter {
  name: string;
  body: string;
}

/**
 * DOMAIN DISCOVERY (review round 2): every function-expression declaration in
 * `src` whose body calls `sendAnnounce(`, in EITHER of the two shapes this
 * file actually uses -- `const NAME = async (...) => { ... }` (module-scope
 * helpers: broadcastAnnounce, announceToSupervisor, sendPeerAnnounce,
 * announceToLead, assignRoadmapItem, stopRoadmapItem) and `NAME: async
 * (...) => { ... }` (object-property-shorthand methods on a returned API
 * object: announceTo). Matching only the first shape is exactly the gap the
 * reviewer found (mutant m7 in announceTo passed clean) -- the second
 * alternative in the regex exists specifically to close it.
 *
 * Nothing is excluded HERE: the caller decides what to exclude, so the
 * "is the gated dispatch even still in the domain" question can be asked
 * separately (a renamed sendPeerAnnounce would otherwise make the exclusion
 * vacuous without anything going red).
 */
function findSendAnnounceEmitters(src: string): Emitter[] {
  const declRe =
    /(?:const\s+(\w+)\s*=\s*async[\s\S]{0,200}?=>\s*\{|(\w+)\s*:\s*async[\s\S]{0,200}?=>\s*\{)/g;
  const out: Emitter[] = [];
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    const openIdx = m.index + m[0].length - 1;
    const body = extractBracedBody(src, openIdx);
    if (body.includes("sendAnnounce(")) out.push({ name, body });
  }
  return out;
}

async function evaluate<T>(wrapper: string, name: string): Promise<(env: Record<string, unknown>) => T> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "kory-slice-")));
  const file = join(dir, `${name}-${createHash("sha256").update(wrapper).digest("hex").slice(0, 8)}.ts`);
  writeFileSync(file, wrapper);
  const mod = (await import(pathToFileURL(file).href)) as { register: (env: Record<string, unknown>) => T };
  return mod.register;
}

const registerSendPeerAnnounce = await evaluate<{
  sendPeerAnnounce: (peerId: string, text: string, subject: string) => Promise<void>;
}>(
  `export function register(env) {
  const { getConfig, service, joinAnnounceTargets, broadcastAnnounce,
          activeScope, resolveBrokerEndpoint, sendAnnounce, journal, reportError } = env
${SEND_PEER_ANNOUNCE}
  return { sendPeerAnnounce }
}
`,
  "send-peer-announce"
);

const registerSendJoinAnnounce = await evaluate<{
  sendJoinAnnounce: (peerId: string, intent: unknown) => Promise<void>;
}>(
  `export function register(env) {
  const { sendPeerAnnounce, composeJoinAnnounce } = env
${SEND_JOIN_ANNOUNCE}
  return { sendJoinAnnounce }
}
`,
  "send-join-announce"
);

const registerPeerResolvedHandler = await evaluate<{ handler: (payload: unknown) => void }>(
  `export function register(env) {
  const { sendJoinAnnounce, sendPeerAnnounce, decidePeerAnnounce, pendingSpawnAcks, clearTimeout,
          journal, announceToSupervisor, composeSpawnAckText, service } = env
  const handler = ${PEER_RESOLVED_HANDLER.replace(/^service\.on\(\n\s*'peer-resolved',\n/, "")
    .replace(/\n\)\n?$/, "\n")}
  return { handler }
}
`,
  "peer-resolved-handler"
);

interface Call {
  fn: string;
  args: unknown[];
}

// ----- B: behavioural proof on the sliced peer-resolved handler -----

/**
 * `decidePeerAnnounce` is the REAL pure decision (peer-rotation.ts imports
 * nothing, so it loads under bun), not a fake: a fake would happily agree with
 * a handler that dispatched the wrong branch.
 */
function handlerEnv(tiles: Array<{ id: string; name: string }> = [{ id: "sess-1", name: "tile A" }]) {
  const calls: Call[] = [];
  const pendingSpawnAcks = new Map<string, { name: string; timer: NodeJS.Timeout }>();
  const env = {
    sendJoinAnnounce: async (peerId: string, intent: unknown) => {
      calls.push({ fn: "sendJoinAnnounce", args: [peerId, intent] });
    },
    sendPeerAnnounce: async (peerId: string, text: string, subject: string) => {
      calls.push({ fn: "sendPeerAnnounce", args: [peerId, text, subject] });
    },
    decidePeerAnnounce,
    service: { list: () => tiles },
    pendingSpawnAcks,
    clearTimeout: (t: NodeJS.Timeout) => {
      clearTimeout(t);
    },
    journal: { add: (...args: unknown[]) => calls.push({ fn: "journal.add", args }) },
    announceToSupervisor: async (text: string) => {
      calls.push({ fn: "announceToSupervisor", args: [text] });
    },
    composeSpawnAckText: (name: string, peerId: string) => `ack:${name}:${peerId}`
  };
  const { handler } = registerPeerResolvedHandler(env);
  return { handler, calls, pendingSpawnAcks };
}

const INTENT = { custom: null, agent: "", model: "", effort: "" };

test("B: on FIRST resolution the spawn-ack accuse to the supervisor fires -- independent of the announce gate's outcome", () => {
  const { handler, calls, pendingSpawnAcks } = handlerEnv();
  const fakeTimer = setTimeout(() => {}, 1_000_000);
  pendingSpawnAcks.set("sess-1", { name: "tile A", timer: fakeTimer });
  handler({ id: "sess-1", peerId: "peer-x", previousPeerId: null, intent: INTENT });
  expect(calls.some((c) => c.fn === "announceToSupervisor")).toBe(true);
  // Both fire: the spawn-ack accuse is not the join announce's continuation,
  // and the join announce is not conditioned on a pending spawn-ack either.
  expect(calls.some((c) => c.fn === "sendJoinAnnounce")).toBe(true);
  clearTimeout(fakeTimer);
});

test("B: with NO pending spawn-ack, the join announce still fires and the supervisor accuse does not (nothing to accuse)", () => {
  const { handler, calls } = handlerEnv([{ id: "sess-unknown", name: "tile B" }]);
  handler({ id: "sess-unknown", peerId: "peer-y", previousPeerId: null, intent: INTENT });
  expect(calls.some((c) => c.fn === "sendJoinAnnounce")).toBe(true);
  expect(calls.some((c) => c.fn === "announceToSupervisor")).toBe(false);
});

test("B: a first resolution WITHOUT a join intent announces nothing at all", () => {
  const { handler, calls } = handlerEnv();
  handler({ id: "sess-1", peerId: "peer-x", previousPeerId: null, intent: null });
  expect(calls.some((c) => c.fn === "sendJoinAnnounce")).toBe(false);
  expect(calls.some((c) => c.fn === "sendPeerAnnounce")).toBe(false);
});

test("B: a ROTATION goes out through the shared gated dispatch, naming both ids, with the 'rotation' subject -- never as a join", () => {
  const { handler, calls } = handlerEnv([{ id: "sess-1", name: "tile A" }]);
  handler({ id: "sess-1", peerId: "peer-new", previousPeerId: "peer-old", intent: null });
  expect(calls.some((c) => c.fn === "sendJoinAnnounce")).toBe(false);
  const sent = calls.filter((c) => c.fn === "sendPeerAnnounce");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.args[0]).toBe("peer-new");
  // The TEXT is the real composePeerRotationAnnounce output (the handler
  // forwards decision.text): both ids and the tile name must survive the trip,
  // which is precisely the "a scan is blind to how a caller composes a
  // message" failure peer-rotation.ts's own header names.
  expect(sent[0]!.args[1]).toContain("peer-old");
  expect(sent[0]!.args[1]).toContain("peer-new");
  expect(sent[0]!.args[1]).toContain("tile A");
  expect(sent[0]!.args[2]).toBe("rotation");
});

test("B: a ROTATION must NOT consume or fire a pending spawn ack -- an ack means a spawn CONNECTED", () => {
  const { handler, calls, pendingSpawnAcks } = handlerEnv();
  const fakeTimer = setTimeout(() => {}, 1_000_000);
  pendingSpawnAcks.set("sess-1", { name: "tile A", timer: fakeTimer });
  handler({ id: "sess-1", peerId: "peer-new", previousPeerId: "peer-old", intent: null });
  expect(calls.some((c) => c.fn === "announceToSupervisor")).toBe(false);
  // Still pending, not silently drained: a later real first-resolution ack (or
  // the timeout path) must still be able to fire.
  expect(pendingSpawnAcks.has("sess-1")).toBe(true);
  clearTimeout(fakeTimer);
});

// ----- B: the spawn-ack guard's TRUTHINESS is deliberate, and until now only
// a comment defended it (review round 5, reviewer measurement relayed by the
// team lead: swapping `if (previousPeerId)` for `if (previousPeerId !== null)`
// left the whole suite green). -----
//
// The contract is not "the field may be missing", it is a PARTITION: every
// FALSY previousPeerId degrades to the HISTORICAL behaviour -- the pending
// spawn ack FIRES -- and only a TRUTHY one (a real rotation) suppresses it.
// The table states the partition completely rather than listing the one shape
// that happens to be feared today, because each row is caught by a DIFFERENT
// plausible rewrite (all measured on the mirror, see the report):
//   - `!== null`                        -> reddens `undefined` and `absent`
//   - `!= null` (loose)                 -> reddens ONLY `empty string`
//   - `typeof previousPeerId === 'string'` -> reddens ONLY `empty string`
//   - `!== undefined`                   -> reddens `null`
// So the empty-string row is not decoration: two of the four rewrites are
// invisible to the `undefined` row alone (measured: `!= null` and the typeof
// form each redden EXACTLY ONE row, 26 pass / 1 fail, and it is that one).
//
// MEASURED CORRECTION, kept because the next reader will have the same idea I
// had: the `absent` and `undefined` rows can NOT be separated by any rewrite
// of that guard, because the handler DESTRUCTURES its parameter -- there is no
// payload object left in scope for an `in` test to reach, so both shapes are
// literally the same binding. They are kept as two rows anyway, and only for
// this reason: the day the handler takes the payload whole (a plausible change
// the moment a fifth field appears), they stop being equivalent, and a table
// that had silently dropped one would not notice.
//
// HONEST SCOPE, so nobody later deletes this as dead weight OR over-trusts it:
// the empty string is NOT reachable from today's producer. There is exactly
// ONE emitter of 'peer-resolved' (session-service.ts pollPeerIds), it ALWAYS
// sets the field, and it sets it from RuntimeState.peerId which is `string |
// null` seeded to null, fed only by resolvePeerId, whose readPeerIdFile
// returns `value || null` -- so '' never comes back. This is therefore a
// CONTRACT test on the handler's defensive posture (what the developer's own
// comment promises for "an older shape, a future second emitter"), not a test
// of a live path. That is exactly why it belongs here: the live path cannot
// exercise it, so nothing else can defend it.
//
// The ANNOUNCE half of the same payload is deliberately NOT asserted here:
// decidePeerAnnounce compares with `=== null` where index.ts uses truthiness,
// so the two halves degrade differently on an old-shape payload. That
// asymmetry is reported to the team lead as a finding; pinning it from this
// file would freeze a module another agent is editing.
const FALSY_PREVIOUS: Array<readonly [string, Record<string, unknown>]> = [
  ["the key is absent entirely (old-shape payload)", {}],
  ["the key is present but undefined", { previousPeerId: undefined }],
  ["null, the ordinary first resolution", { previousPeerId: null }],
  ["the empty string", { previousPeerId: "" }]
];

for (const [label, extra] of FALSY_PREVIOUS) {
  test(`B: a FALSY previousPeerId (${label}) degrades to the HISTORICAL behaviour -- the pending spawn ack FIRES`, () => {
    const { handler, calls, pendingSpawnAcks } = handlerEnv();
    const fakeTimer = setTimeout(() => {}, 1_000_000);
    pendingSpawnAcks.set("sess-1", { name: "tile A", timer: fakeTimer });
    handler({ id: "sess-1", peerId: "peer-x", intent: INTENT, ...extra });
    const acks = calls.filter((c) => c.fn === "announceToSupervisor");
    // Asserted on the EFFECT, twice over: the accuse went out carrying the
    // composed ack text, and the pending entry was really consumed. Either one
    // alone could pass for the wrong reason (a stray announce; a delete with
    // no announce).
    expect(`${label} -> acks: ${acks.length}`).toBe(`${label} -> acks: 1`);
    expect(acks[0]!.args[0]).toBe("ack:tile A:peer-x");
    expect(pendingSpawnAcks.has("sess-1")).toBe(false);
    clearTimeout(fakeTimer);
  });
}

test("B: an UNCHANGED peer_id (the poll tick that found nothing new) announces nothing", () => {
  const { handler, calls } = handlerEnv();
  handler({ id: "sess-1", peerId: "peer-same", previousPeerId: "peer-same", intent: null });
  expect(calls.some((c) => c.fn === "sendJoinAnnounce")).toBe(false);
  expect(calls.some((c) => c.fn === "sendPeerAnnounce")).toBe(false);
});

// ----- B: behavioural proof on the sliced join wrapper (NEW, review round 4)
//
// While the dispatch was inline, "sendJoinAnnounce composes the join text and
// labels it as a join" was not a separable claim. Now it is a one-line
// delegation, i.e. exactly the shape CLAUDE.md calls out ("extracting logic
// into a pure module makes its CALL SITE invisible"): the dispatch is proved
// below, and NOTHING would prove it is called, with which arguments, in which
// order. This test is the behavioural probe that closes that -- it is red on a
// swapped argument, a hardcoded text, a wrong subject label, or a delegation
// dropped for a direct broadcast.

test("B: sendJoinAnnounce delegates to the shared dispatch with the composed join text and the 'join' subject", async () => {
  const calls: Call[] = [];
  const env = {
    sendPeerAnnounce: async (peerId: string, text: string, subject: string) => {
      calls.push({ fn: "sendPeerAnnounce", args: [peerId, text, subject] });
    },
    composeJoinAnnounce: (peerId: string, intent: { agent: string }) =>
      `composed-join-marker:${peerId}:${intent.agent}`
  };
  const { sendJoinAnnounce } = registerSendJoinAnnounce(env);
  await sendJoinAnnounce("peer-new", { ...INTENT, agent: "sentinel-agent-marker" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual([
    "peer-new",
    "composed-join-marker:peer-new:sentinel-agent-marker",
    "join"
  ]);
});

// ----- B: behavioural proof on the sliced shared dispatch -----

function sendPeerEnv(decisionKind: "silent" | "broadcast" | "targets", targetPeerIds: string[] = []) {
  const calls: Call[] = [];
  const env = {
    getConfig: () => ({ joinAnnounceLevel: "lead" }),
    service: { list: () => [] },
    joinAnnounceTargets: (level: string, sessions: unknown[]) => {
      calls.push({ fn: "joinAnnounceTargets", args: [level, sessions] });
      if (decisionKind === "silent") return { kind: "silent" };
      if (decisionKind === "broadcast") return { kind: "broadcast" };
      return { kind: "targets", peerIds: targetPeerIds };
    },
    broadcastAnnounce: async (text: string, excludePeerId?: string) => {
      calls.push({ fn: "broadcastAnnounce", args: [text, excludePeerId] });
      return 1;
    },
    activeScope: { groupId: "g1", secret: "s1" },
    resolveBrokerEndpoint: () => "http://127.0.0.1:1",
    sendAnnounce: async (payload: unknown) => {
      calls.push({ fn: "sendAnnounce", args: [payload] });
      return { sent: 1 };
    },
    journal: { add: (...args: unknown[]) => calls.push({ fn: "journal.add", args }) },
    reportError: (...args: unknown[]) => calls.push({ fn: "reportError", args })
  };
  const { sendPeerAnnounce } = registerSendPeerAnnounce(env);
  return { sendPeerAnnounce, calls };
}

test("B: 'silent' decision sends nothing at all -- no broadcastAnnounce, no sendAnnounce", async () => {
  const { sendPeerAnnounce, calls } = sendPeerEnv("silent");
  await sendPeerAnnounce("peer-new", "text", "join");
  expect(calls.some((c) => c.fn === "broadcastAnnounce")).toBe(false);
  expect(calls.some((c) => c.fn === "sendAnnounce")).toBe(false);
});

test("B: 'broadcast' decision routes through broadcastAnnounce, never the per-target sendAnnounce loop", async () => {
  const { sendPeerAnnounce, calls } = sendPeerEnv("broadcast");
  await sendPeerAnnounce("peer-new", "text", "join");
  expect(calls.filter((c) => c.fn === "broadcastAnnounce")).toHaveLength(1);
  expect(calls.some((c) => c.fn === "sendAnnounce")).toBe(false);
});

test("B: 'targets' decision addresses each peer individually via sendAnnounce, never broadcastAnnounce, and excludes the subject peer itself", async () => {
  const { sendPeerAnnounce, calls } = sendPeerEnv("targets", ["lead-a", "lead-b", "peer-new"]);
  await sendPeerAnnounce("peer-new", "text", "join");
  expect(calls.some((c) => c.fn === "broadcastAnnounce")).toBe(false);
  const sent = calls.filter((c) => c.fn === "sendAnnounce");
  expect(sent).toHaveLength(2);
  const toPeerIds = sent.map((c) => (c.args[0] as { toPeerId: string }).toPeerId).sort();
  expect(toPeerIds).toEqual(["lead-a", "lead-b"]);
});

// Review round 3 (team lead, reporting the developer's own concern): the
// PREVIOUS presence check here was a VERBATIM text-shape regex on
// `joinAnnounceTargets(getConfig().joinAnnounceLevel, service.list())`. It
// forced a real developer to duplicate a `getConfig().joinAnnounceLevel`
// call rather than hoist it to a local variable, a legitimate no-op refactor
// the regex could not tell apart from a real defect (CLAUDE.md: "presence is
// not the contract"). Replaced by the BEHAVIOURAL assertion below: feed the
// dispatch a getConfig()/service.list() pair with DISTINCTIVE sentinel values
// that appear nowhere else in this file's fixtures, and require the REAL
// joinAnnounceTargets call to have received EXACTLY those values -- immune to
// a local-variable hoist (which is precisely what the extraction then did:
// `const level = getConfig().joinAnnounceLevel` on its first line), a
// reformat, or a renamed intermediate, while still catching a hardcoded /
// wrong-argument / discarded-result defect.
test("B: the shared dispatch reads the REAL config level and session list and forwards them to joinAnnounceTargets -- not a hardcoded or discarded value", async () => {
  const calls: Call[] = [];
  const sentinelSessions = [{ id: "sentinel-session-marker" }];
  const env = {
    getConfig: () => ({ joinAnnounceLevel: "sentinel-level-marker" }),
    service: { list: () => sentinelSessions },
    joinAnnounceTargets: (level: unknown, sessions: unknown) => {
      calls.push({ fn: "joinAnnounceTargets", args: [level, sessions] });
      return { kind: "silent" };
    },
    broadcastAnnounce: async () => 0,
    activeScope: { groupId: "g1", secret: "s1" },
    resolveBrokerEndpoint: () => "http://127.0.0.1:1",
    sendAnnounce: async () => ({ sent: 1 }),
    journal: { add: (...args: unknown[]) => calls.push({ fn: "journal.add", args }) },
    reportError: (...args: unknown[]) => calls.push({ fn: "reportError", args })
  };
  const { sendPeerAnnounce } = registerSendPeerAnnounce(env);
  await sendPeerAnnounce("peer-new", "text", "join");
  const call = calls.find((c) => c.fn === "joinAnnounceTargets");
  expect(call).toBeDefined();
  expect(call?.args).toEqual(["sentinel-level-marker", sentinelSessions]);
});

// ----- C: textual ABSENCE sweep + caller-set pin -----
//
// ABSENCE stays a regex sweep: it asserts a NEGATIVE (these three identifiers
// never appear in a body that isn't supposed to reference the gate), which a
// legitimate refactor of the GATED call site itself cannot trip -- the one
// honestly-scoped risk it keeps (same as tests/desktop-idle-lock-wiring-
// sweep.test.ts's own documented limit) is a future COMMENT inside one of the
// swept bodies that happens to quote these exact identifiers; accepted as
// fail-CLOSED noise, not a missed regression.

/**
 * ABSENCE: the gate must not appear inside any other emitter's own body --
 * the exact shape of the mutation the team lead named: "the gate moved into
 * the shared function instead of staying at the peer-announce dispatch".
 *
 * TWO families of identifier, and the second one is a review-round-4 addition:
 *   - the gate's own vocabulary (joinAnnounceLevel / JOIN_ANNOUNCE_LEVELS /
 *     joinAnnounceTargets), which catches the gate being COPIED into another
 *     emitter;
 *   - the GATED_NAMES themselves, which catches the gate being REACHED from
 *     another emitter -- including through an ALIAS (`const g =
 *     sendPeerAnnounce; await g(...)`), a shape that carries no `name(` call
 *     and that the arithmetic pin below therefore cannot see. Measured: mutant
 *     m16 planted exactly that alias in broadcastAnnounce and stayed fully
 *     GREEN until this family was added.
 * A swept emitter that merely NAMES one of these in prose reddens too; that is
 * the same accepted fail-CLOSED noise the header documents, not a new cost.
 */
function findGateReferences(body: string): string[] {
  const re = new RegExp(
    ["joinAnnounceLevel", "JOIN_ANNOUNCE_LEVELS", "joinAnnounceTargets", ...GATED_NAMES].join("|"),
    "g"
  );
  const hits: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    hits.push(`"${m[0]}" at offset ${m.index}`);
  }
  return hits;
}

const ALL_EMITTERS = findSendAnnounceEmitters(SRC);
const SWEPT_EMITTERS = ALL_EMITTERS.filter((e) => !GATED_NAMES.includes(e.name));

// CARDINALITY FLOOR (review round 2, requirement 2): 6 NON-GATED
// sendAnnounce( emitters are measured in index.ts today (broadcastAnnounce,
// announceToSupervisor, announceToLead, assignRoadmapItem, stopRoadmapItem,
// announceTo). A regex that stops matching (rename, reshape) or a deleted
// emitter must redden THIS floor instead of silently sweeping fewer
// functions. Unchanged by the extraction on purpose: sendJoinAnnounce left
// the domain by CONTENT (it no longer calls sendAnnounce( at all) and
// sendPeerAnnounce entered it, so the non-gated count is the same 6 as before
// -- the floor is NOT easier to satisfy than it was.
test("C domain floor: at least 6 non-gated sendAnnounce emitters are discovered in index.ts", () => {
  expect(SWEPT_EMITTERS.length).toBeGreaterThanOrEqual(6);
});

test("C domain floor: the discovered set includes announceTo (the object-property-shorthand shape the first version of this sweep missed)", () => {
  expect(SWEPT_EMITTERS.map((e) => e.name)).toContain("announceTo");
});

// Without this, renaming the gated dispatch would make its NAME-based
// exclusion vacuous: the sweep would keep passing over a domain that no longer
// contains the gate holder, and the ABSENCE property would be asserted about
// nothing in particular.
test("C domain: the gated dispatch is itself a discovered sendAnnounce emitter, so excluding it by name is not a vacuous exclusion", () => {
  expect(ALL_EMITTERS.map((e) => e.name)).toContain(GATED_DISPATCH);
});

test("C ABSENCE: no discovered sendAnnounce emitter (other than the gated dispatch) references the join-announce gate", () => {
  const failures = SWEPT_EMITTERS.flatMap((e) =>
    findGateReferences(e.body).map((hit) => `${e.name}: ${hit}`)
  );
  expect(failures).toEqual([]);
});

// ----- C CALLER SET (NEW, review round 4): the door the ABSENCE sweep cannot
// watch. -----
//
// Since the dispatch is SHARED, the gate now reaches a general-purpose emitter
// the moment that emitter DELEGATES to it -- with no gate identifier ever
// appearing in its body, so the ABSENCE sweep above stays green while every
// announce from every other caller silently becomes level-gated. Pinned by
// ARITHMETIC rather than by a declaration scan, deliberately: the rotation
// call site lives inside an anonymous `service.on('peer-resolved', (...) =>
// {...})` callback, which no `const NAME =` / `NAME:` declaration regex can
// attribute to a named function -- a scan-based caller list would therefore
// have a hole exactly where the second legitimate caller lives, and would be
// blind to a third call planted at top level or in another callback.
//
// Total occurrences MINUS the occurrences inside the authorised slices must be
// zero. Adding a third legitimate gated announce reddens this and forces a
// conscious update here, which is the intended semantics: the gate governs a
// CLOSED set of announce paths.
//
// BOTH gated names are pinned, not just the dispatch: measured mutant m15
// planted `await sendJoinAnnounce(...)` inside broadcastAnnounce -- reaching
// the very same gate one hop further out -- and a pin on sendPeerAnnounce
// ALONE stayed fully GREEN on it. The exact-count expectations (not ">= 1")
// are what makes a duplicated call inside an authorised site red too
// (measured: mutant m13).
function countCalls(body: string, name: string): number {
  return (body.match(new RegExp(`\\b${name}\\(`, "g")) ?? []).length;
}

const AUTHORISED_CALL_SITES: Array<{ name: string; sites: Array<[string, string, number]> }> = [
  {
    name: "sendPeerAnnounce",
    sites: [
      ["sendJoinAnnounce (the join wrapper)", SEND_JOIN_ANNOUNCE, 1],
      ["service.on('peer-resolved') (the rotation branch)", PEER_RESOLVED_HANDLER, 1]
    ]
  },
  {
    name: "sendJoinAnnounce",
    sites: [
      ["sendJoinAnnounce (the join wrapper)", SEND_JOIN_ANNOUNCE, 0],
      ["service.on('peer-resolved') (the join branch)", PEER_RESOLVED_HANDLER, 1]
    ]
  }
];

for (const { name, sites } of AUTHORISED_CALL_SITES) {
  test(`C CALLER SET: every call to ${name} is inside an authorised site -- nothing else may delegate to the gate through it`, () => {
    const total = countCalls(SRC, name);
    let accounted = 0;
    for (const [label, body, expected] of sites) {
      // Each authorised site must really carry the call count it is authorised
      // for: a delegation dropped on one side is itself a defect, and would
      // otherwise make the arithmetic pass for the wrong reason.
      expect(`${label}: ${countCalls(body, name)}`).toBe(`${label}: ${expected}`);
      accounted += countCalls(body, name);
    }
    expect(`${name} calls outside the authorised sites: ${total - accounted}`).toBe(
      `${name} calls outside the authorised sites: 0`
    );
  });
}

test("C detector self-check: findGateReferences is sensitive to the named mutation and silent on unrelated text", () => {
  expect(
    findGateReferences(
      "const broadcastAnnounce = async (text) => {\n  if (getConfig().joinAnnounceLevel === 'off') return 0\n  ...\n}"
    )
  ).toHaveLength(1);
  expect(findGateReferences("const broadcastAnnounce = async (text) => {\n  return sendAnnounce(text)\n}")).toEqual(
    []
  );
});

test("C domain-discovery self-check: findSendAnnounceEmitters catches BOTH declaration shapes", () => {
  const synthetic = `
const broadcastAnnounce = async (text: string): Promise<number> => {
  return sendAnnounce(text)
}
const returned = {
  announceTo: async (toPeerId: string, text: string): Promise<number> => {
    return sendAnnounce(toPeerId, text)
  },
  unrelated: async (x: string): Promise<void> => {
    return doSomethingElse(x)
  }
}
`;
  const names = findSendAnnounceEmitters(synthetic)
    .map((e) => e.name)
    .sort();
  expect(names).toEqual(["announceTo", "broadcastAnnounce"]);
});

test("C caller-scan self-check: countCalls counts calls, not the declaration of the function itself", () => {
  const synthetic = `const sendPeerAnnounce = async (a, b, c) => { return 1 }
const x = async () => { await sendPeerAnnounce(1, 2, 3) }
const y = async () => { await sendPeerAnnounceOther(1) }
`;
  expect(countCalls(synthetic, "sendPeerAnnounce")).toBe(1);
});

// ----- coverage-degradation answer (team lead's explicit question, review
// rounds 2 and 4): the DOMAIN half is closed too, not just the SENSITIVITY
// half. -----
// slice()'s anchor-not-found path throws for all three slices, so a rename
// fails the whole file at load time, never "0 checks, green" -- that is what
// actually happened when the dispatch was extracted, and is why this file was
// rewritten by its owner rather than adjusted by the developer it blocked.
//
// For the C sweep specifically, three distinct degradation routes are now
// each answered by a test rather than by an argument:
//   1. domain SHRINKS (regex stops matching a reshaped declaration, emitter
//      deleted/renamed)              -> `C domain floor` (>= 6).
//   2. exclusion becomes VACUOUS (the gated dispatch is renamed, so excluding
//      it by name excludes nothing)  -> `C domain: the gated dispatch is
//      itself a discovered emitter`.
//   3. gate reaches a general emitter by DELEGATION, leaving the swept bodies
//      textually clean                -> `C CALLER SET` (both gated names) and
//      the GATED_NAMES family inside `findGateReferences`.
// Every one of the three was mutation-proven RED on a mirror outside the repo
// (KORY_INDEX_TS), together with the B probes; see the test-eng report to
// desktop-7b2civn-koryphaios-6 for the exact commands and the decisive lines.
//
// THE ONE MEASURED RESIDUAL HOLE, stated rather than left to be discovered:
// an alias bound at TOP LEVEL (`const gatedAlias = sendPeerAnnounce` outside
// every emitter body) and then called from a general emitter stays fully GREEN
// (mutant m17: 23 pass / 0 fail). It is deliberately NOT closed. Closing it
// textually means pinning the count of BARE `sendPeerAnnounce` references
// file-wide, which counts the PROSE of index.ts's own comments -- reintroducing
// exactly the text-shape brittleness review round 3 removed, and punishing a
// developer for editing a comment. The hole requires a deliberate indirection,
// not a plausible refactor, so the trade is: red on every accidental route,
// green on one intentional evasion, and no tax on legitimate rewording.
