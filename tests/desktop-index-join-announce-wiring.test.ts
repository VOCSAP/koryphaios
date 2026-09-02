// index.ts imports electron and cannot be imported under bun; both properties
// below read it as text via slice(), not import().
// B: the spawn-ack to the supervisor fires on first peer resolution regardless
// of the join-announce gate's decision.
// C: the level gate must be textually absent from every sendAnnounce emitter
// except the gated dispatch, derived by scanning both declaration shapes with a
// floor of 6 non-gated emitters so a shrinking domain reddens instead of
// sweeping fewer functions silently.
// A caller-count check also pins both gated names: the dispatch is shared, so a
// delegating emitter can reach the gate without any gate identifier appearing
// in its own body.

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
 * Finds every function-expression declaration in src whose body calls
 * sendAnnounce(, matching both `const NAME = async (...) => {}` module-scope
 * helpers and `NAME: async (...) => {}` object-property-shorthand methods --
 * the second shape closes a gap where a shorthand method reached the gate
 * undetected.
 * Exclusions are applied by the caller, not here, so a renamed gated dispatch
 * can't silently make its own exclusion vacuous without something else going
 * red.
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

// previousPeerId is a partition, not an optional field: any falsy value
// (absent/undefined/null/empty string) means the historical behaviour
// (spawn-ack fires), only a truthy value suppresses it as a rotation.
// The handler destructures its parameter, so 'absent' and 'undefined' are the
// same binding today and only diverge once a future payload shape keeps the
// whole object in scope.
// Empty string is unreachable from today's only producer (RuntimeState.peerId
// is string|null, never ''); this is a contract test on defensive posture, not
// a live path.
// decidePeerAnnounce compares with === null where index.ts uses truthiness --
// the two halves degrade differently on an old-shape payload, deliberately not
// reconciled here.
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

// Asserts behaviourally rather than via a text-shape regex: feeds the dispatch
// sentinel getConfig()/service.list() values and requires joinAnnounceTargets
// to receive exactly those, so a local-variable hoist or reformat doesn't
// false-fail while a hardcoded/wrong-argument defect still reds.
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
 * Matches two identifier families: the gate's own vocabulary
 * (joinAnnounceLevel/JOIN_ANNOUNCE_LEVELS/joinAnnounceTargets), catching the
 * gate being copied into another emitter, and the GATED_NAMES themselves,
 * catching the gate being reached via an alias (e.g. `const g =
 * sendPeerAnnounce`) that carries no direct call for the arithmetic pin to see.
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

// 6 non-gated sendAnnounce emitters exist today; a regex that stops matching or
// a deleted emitter must redden this floor rather than silently sweep fewer
// functions.
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

// Pinned by arithmetic, not a declaration scan: the rotation call site lives
// inside an anonymous service.on('peer-resolved', ...) callback that no
// const/property declaration regex can attribute to a named function.
// Total occurrences of each gated name across the file, minus occurrences
// inside the authorized slices, must be exactly zero -- so a duplicated call
// inside an authorized site reds too, not only a call outside it.
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

// Three degradation routes are each closed by a separate test: the domain
// shrinking (floor >= 6), the exclusion becoming vacuous (gated dispatch
// renamed), and the gate reaching a general emitter by delegation (caller-set
// pin).
// One residual hole is deliberately left open: an alias bound at top level and
// called from a general emitter evades detection -- closing it textually would
// mean pinning bare name references file-wide, including this file's own prose.
