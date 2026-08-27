// Card 8cb54a0f, phase 2 (test-eng, team-lead brief desktop-7b2civn-
// koryphaios-3): the WIRING half of the three-level join-announce gate
// ('off' | 'lead' | 'all', default 'off'). tests/desktop-join-announce-gate
// .test.ts already proves the pure decision (joinAnnounceTargets, real
// import, no slicing needed -- shared/announce.ts has no electron import).
// This file proves the two properties that a pure-function test CANNOT:
//
//   B (behavioural, slice+fakes): the spawn-ack accuse to the supervisor
//   (announceToSupervisor, called from the service.on('peer-resolved', ...)
//   handler) fires UNCONDITIONALLY -- it is not gated by, or chained after,
//   sendJoinAnnounce's own gate outcome. And sendJoinAnnounce itself routes
//   correctly on each of the three decision shapes (silent/broadcast/
//   targets) it receives from joinAnnounceTargets.
//
//   C (textual PRESENCE+ABSENCE): the gate check lives ONLY inside
//   sendJoinAnnounce -- and is textually ABSENT from every OTHER function in
//   index.ts whose body calls sendAnnounce(. This is the property a
//   slice-and-fake test on the CURRENT call graph cannot catch by itself: if
//   the gate check migrated into a shared/other announce emitter, a test
//   that fakes that one function would keep passing unchanged while the real
//   function silently swallowed announces from every OTHER caller too.
//
//   REVIEW ROUND 2 (team lead + reviewer, 2026-08-27): the first version of
//   this ABSENCE check hardcoded exactly two anchor names (broadcastAnnounce,
//   announceToSupervisor). A mirror-mutation review found index.ts actually
//   has SEVEN sendAnnounce( emitters (broadcastAnnounce, announceToSupervisor,
//   sendJoinAnnounce, announceToLead, assignRoadmapItem, stopRoadmapItem, and
//   announceTo -- the last one an OBJECT-PROPERTY-SHORTHAND arrow, `announceTo:
//   async (...) => {...}`, not a `const NAME = async` declaration), and a
//   mutant planting the gate inside announceTo (mutant m7, near line 2537)
//   passed the two-anchor sweep clean: `13 pass / 0 fail`, the domain simply
//   never looked there. The ABSENCE check below is now DERIVED (regex over
//   the whole file for both declaration shapes, filtered to bodies containing
//   sendAnnounce(, excluding sendJoinAnnounce by name) instead of a hand-kept
//   list, with a cardinality floor (>=6) so the domain shrinking silently
//   (a renamed emitter, a regex that stops matching) reddens instead of
//   quietly sweeping fewer functions. See the mutation-proof section near the
//   detector self-check below for how mutant m7 is replayed against this file.
//
// index.ts imports electron and fails to resolve even before reaching it
// (measured: `bun test` on a bare `import("../desktop/src/main/index.ts")`
// throws `Cannot find module '@shared/palette'`, phase-1 report to
// desktop-7b2civn-koryphaios-3) -- so both B and C read the file as TEXT via
// slice(), never `import()` it. Same technique as
// tests/desktop-approval-defer.test.ts (slice+evaluate/register(env)) and
// tests/desktop-idle-lock-wiring-sweep.test.ts (PRESENCE+ABSENCE regex sweep).
//
// Replayable negative control, same convention as desktop-approval-defer.
// test.ts (see its own header): point INDEX at an older/mutated copy via
//   KORY_INDEX_TS=/path/to/mutated-index.ts bun test ./tests/desktop-index-join-announce-wiring.test.ts
// This is how the "gate moved into broadcastAnnounce" mutation was shown RED
// before this file was written (see the test-eng report to the team lead for
// the exact command + decisive output).

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const INDEX =
  process.env.KORY_INDEX_TS || join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");
// index.ts is CRLF on disk; normalise line endings only, mirrors
// desktop-approval-defer.test.ts.
const SRC = readFileSync(INDEX, "utf8").replace(/\r\n/g, "\n");

/**
 * Cut one top-level statement out of index.ts, from `anchor` to the first
 * column-0 terminator line. Fail CLOSED: an anchor that no longer matches
 * (rename/reshape) THROWS rather than returning an empty/vacuous slice, so a
 * test built on top of this never silently degrades to "0 checks, green".
 */
function slice(anchor: string, terminators: string[], label: string): string {
  const start = SRC.indexOf(anchor);
  if (start < 0) throw new Error(`${label}: anchor not found -- index.ts changed shape`);
  const ends = terminators
    .map((t) => ({ t, i: SRC.indexOf(t, start) }))
    .filter((c) => c.i >= 0)
    .sort((a, b) => a.i - b.i);
  if (ends.length === 0) throw new Error(`${label}: no column-0 terminator after the anchor`);
  const body = SRC.slice(start, ends[0].i + ends[0].t.length - 1);
  const lineOf = (idx: number) => SRC.slice(0, idx).split("\n").length;
  console.log(
    `[${label}] index.ts lines ${lineOf(start)}..${lineOf(ends[0].i)} ` +
      `(${body.length} bytes, sha256 ${createHash("sha256").update(body).digest("hex").slice(0, 16)})`
  );
  return body;
}

const SEND_JOIN_ANNOUNCE = slice(
  "const sendJoinAnnounce = async (peerId: string, intent: JoinAnnounceIntent): Promise<void> => {",
  ["\n}\n"],
  "sendJoinAnnounce"
);
const PEER_RESOLVED_HANDLER = slice(
  "service.on(\n  'peer-resolved',",
  ["\n)\n", "\n})\n"],
  "peer-resolved handler"
);

// Anti-vacuity floor: neither slice should ever come back suspiciously short
// (an anchor matching a decoy earlier in the file, or a terminator picked too
// early, would silently produce a near-empty body instead of throwing).
for (const [label, body] of [
  ["sendJoinAnnounce", SEND_JOIN_ANNOUNCE],
  ["peer-resolved handler", PEER_RESOLVED_HANDLER]
] as const) {
  test(`slice floor: ${label} extracted at least 100 bytes`, () => {
    expect(body.length).toBeGreaterThan(100);
  });
}

/**
 * Brace-balance body extractor (same convention as
 * tests/desktop-idle-lock-wiring-sweep.test.ts and
 * tests/desktop-quota-gate.test.ts): `openIdx` must point at the opening `{`
 * of the body. Unlike `slice()`'s column-0 terminator search, this works for
 * a body at ANY indentation depth -- required for `announceTo`, which is
 * nested inside a returned object literal, never at column 0.
 */
function extractBracedBody(src: string, openIdx: number): string {
  let depth = 1;
  let i = openIdx + 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(openIdx + 1, i - 1);
}

interface Emitter {
  name: string;
  body: string;
}

/**
 * DOMAIN DISCOVERY (review round 2): every function-expression declaration in
 * `src` whose body calls `sendAnnounce(`, in EITHER of the two shapes this
 * file actually uses -- `const NAME = async (...) => { ... }` (module-scope
 * helpers: broadcastAnnounce, announceToSupervisor, sendJoinAnnounce,
 * announceToLead, assignRoadmapItem, stopRoadmapItem) and `NAME: async
 * (...) => { ... }` (object-property-shorthand methods on a returned API
 * object: announceTo). Matching only the first shape is exactly the gap the
 * reviewer found (mutant m7 in announceTo passed clean) -- the second
 * alternative in the regex exists specifically to close it.
 *
 * `sendJoinAnnounce` is excluded BY NAME: it is the one function that is
 * SUPPOSED to reference the gate.
 */
function findSendAnnounceEmitters(src: string): Emitter[] {
  const declRe =
    /(?:const\s+(\w+)\s*=\s*async[\s\S]{0,200}?=>\s*\{|(\w+)\s*:\s*async[\s\S]{0,200}?=>\s*\{)/g;
  const out: Emitter[] = [];
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) {
    const name = m[1] ?? m[2];
    if (!name || name === "sendJoinAnnounce") continue;
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

const registerSendJoinAnnounce = await evaluate<{ sendJoinAnnounce: (peerId: string, intent: unknown) => Promise<void> }>(
  `export function register(env) {
  const { getConfig, service, joinAnnounceTargets, composeJoinAnnounce, broadcastAnnounce,
          activeScope, resolveBrokerEndpoint, sendAnnounce, journal, reportError } = env
${SEND_JOIN_ANNOUNCE}
  return { sendJoinAnnounce }
}
`,
  "send-join-announce"
);

const registerPeerResolvedHandler = await evaluate<{ handler: (payload: unknown) => void }>(
  `export function register(env) {
  const { sendJoinAnnounce, pendingSpawnAcks, clearTimeout, journal, announceToSupervisor,
          composeSpawnAckText, service } = env
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

function handlerEnv() {
  const calls: Call[] = [];
  const timers: NodeJS.Timeout[] = [];
  const pendingSpawnAcks = new Map<string, { name: string; timer: NodeJS.Timeout }>();
  const env = {
    sendJoinAnnounce: async (peerId: string, intent: unknown) => {
      calls.push({ fn: "sendJoinAnnounce", args: [peerId, intent] });
    },
    pendingSpawnAcks,
    clearTimeout: (t: NodeJS.Timeout) => {
      timers.push(t);
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

test("B: the spawn-ack accuse to the supervisor fires unconditionally when a spawn-ack is pending -- independent of sendJoinAnnounce", () => {
  const { handler, calls, pendingSpawnAcks } = handlerEnv();
  const fakeTimer = setTimeout(() => {}, 1_000_000);
  pendingSpawnAcks.set("sess-1", { name: "tile A", timer: fakeTimer });
  handler({ id: "sess-1", peerId: "peer-x", intent: { custom: null, agent: "", model: "", effort: "" } });
  expect(calls.some((c) => c.fn === "announceToSupervisor")).toBe(true);
  // Both fire: the spawn-ack accuse is not sendJoinAnnounce's continuation,
  // and sendJoinAnnounce is not conditioned on a pending spawn-ack either.
  expect(calls.some((c) => c.fn === "sendJoinAnnounce")).toBe(true);
  clearTimeout(fakeTimer);
});

test("B: with NO pending spawn-ack, the join announce still fires and the supervisor accuse does not (nothing to accuse)", () => {
  const { handler, calls } = handlerEnv();
  handler({ id: "sess-unknown", peerId: "peer-y", intent: { custom: null, agent: "", model: "", effort: "" } });
  expect(calls.some((c) => c.fn === "sendJoinAnnounce")).toBe(true);
  expect(calls.some((c) => c.fn === "announceToSupervisor")).toBe(false);
});

// ----- B: behavioural proof on the sliced sendJoinAnnounce -----

function sendJoinEnv(decisionKind: "silent" | "broadcast" | "targets", targetPeerIds: string[] = []) {
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
    composeJoinAnnounce: (peerId: string) => `joined:${peerId}`,
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
  const { sendJoinAnnounce } = registerSendJoinAnnounce(env);
  return { sendJoinAnnounce, calls };
}

test("B: 'silent' decision sends nothing at all -- no broadcastAnnounce, no sendAnnounce", async () => {
  const { sendJoinAnnounce, calls } = sendJoinEnv("silent");
  await sendJoinAnnounce("peer-new", { custom: null, agent: "", model: "", effort: "" });
  expect(calls.some((c) => c.fn === "broadcastAnnounce")).toBe(false);
  expect(calls.some((c) => c.fn === "sendAnnounce")).toBe(false);
});

test("B: 'broadcast' decision routes through broadcastAnnounce, never the per-target sendAnnounce loop", async () => {
  const { sendJoinAnnounce, calls } = sendJoinEnv("broadcast");
  await sendJoinAnnounce("peer-new", { custom: null, agent: "", model: "", effort: "" });
  expect(calls.filter((c) => c.fn === "broadcastAnnounce")).toHaveLength(1);
  expect(calls.some((c) => c.fn === "sendAnnounce")).toBe(false);
});

test("B: 'targets' decision addresses each peer individually via sendAnnounce, never broadcastAnnounce, and excludes the joiner itself", async () => {
  const { sendJoinAnnounce, calls } = sendJoinEnv("targets", ["lead-a", "lead-b", "peer-new"]);
  await sendJoinAnnounce("peer-new", { custom: null, agent: "", model: "", effort: "" });
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
// not the contract" -- text-shape locks are the weak, fail-open-on-nothing/
// fail-red-on-noise form this project keeps re-deriving). Replaced by a
// BEHAVIOURAL assertion below: feed sendJoinAnnounce a getConfig()/
// service.list() pair with DISTINCTIVE sentinel values that appear nowhere
// else in this file's fixtures, and require the REAL joinAnnounceTargets
// call to have received EXACTLY those values -- immune to a local-variable
// hoist, a reformat, or a renamed intermediate, while still catching a
// hardcoded/wrong-argument/discarded-result defect (mutation-proven below,
// scratch copy hardcoding 'off' -- see the test-eng report to the team lead
// for the exact command and decisive red).
test("B: sendJoinAnnounce reads the REAL config level and session list and forwards them to joinAnnounceTargets -- not a hardcoded or discarded value", async () => {
  const calls: Call[] = [];
  const sentinelSessions = [{ id: "sentinel-session-marker" }];
  const env = {
    getConfig: () => ({ joinAnnounceLevel: "sentinel-level-marker" }),
    service: { list: () => sentinelSessions },
    joinAnnounceTargets: (level: unknown, sessions: unknown) => {
      calls.push({ fn: "joinAnnounceTargets", args: [level, sessions] });
      return { kind: "silent" };
    },
    composeJoinAnnounce: (peerId: string) => `joined:${peerId}`,
    broadcastAnnounce: async () => 0,
    activeScope: { groupId: "g1", secret: "s1" },
    resolveBrokerEndpoint: () => "http://127.0.0.1:1",
    sendAnnounce: async () => ({ sent: 1 }),
    journal: { add: (...args: unknown[]) => calls.push({ fn: "journal.add", args }) },
    reportError: (...args: unknown[]) => calls.push({ fn: "reportError", args })
  };
  const { sendJoinAnnounce } = registerSendJoinAnnounce(env);
  await sendJoinAnnounce("peer-new", { custom: null, agent: "", model: "", effort: "" });
  const call = calls.find((c) => c.fn === "joinAnnounceTargets");
  expect(call).toBeDefined();
  expect(call?.args).toEqual(["sentinel-level-marker", sentinelSessions]);
});

// ----- C: textual ABSENCE sweep -----
//
// The PRESENCE half that used to live here (a verbatim regex on
// `joinAnnounceTargets(getConfig().joinAnnounceLevel, service.list())`) is
// RETIRED as of review round 3: it was a text-shape lock, not a wiring
// guarantee (CLAUDE.md: "presence is not the contract" -- the failure mode
// named for exactly this class of check). It forced a real developer to
// duplicate a `getConfig().joinAnnounceLevel` read rather than hoist it to a
// local variable, a semantically-equivalent refactor the regex could not
// tell apart from a genuine defect. Replaced by the behavioural B test above
// ("sendJoinAnnounce reads the REAL config level..."), which asserts on
// sentinel VALUES actually reaching joinAnnounceTargets rather than on the
// SOURCE TEXT of the call -- immune to the hoist, still red on a hardcoded
// literal or a discarded/swapped argument (mutation-proven; see the test-eng
// report to desktop-7b2civn-koryphaios-3 for the exact command + red output).
// ABSENCE stays a regex sweep: it asserts a NEGATIVE (these three identifiers
// never appear in a body that isn't supposed to reference the gate), which a
// legitimate refactor of the GATED call site itself cannot trip -- the one
// honestly-scoped risk it keeps (same as tests/desktop-idle-lock-wiring-
// sweep.test.ts's own documented limit) is a future COMMENT inside one of
// the swept bodies that happens to quote these exact identifiers; accepted
// as fail-CLOSED noise, not a missed regression.

/**
 * ABSENCE: the gate (joinAnnounceLevel / JOIN_ANNOUNCE_LEVELS / a call to
 * joinAnnounceTargets) must not appear inside broadcastAnnounce's or
 * announceToSupervisor's own bodies -- the exact shape of the mutation the
 * team lead named: "the gate moved into the shared function instead of
 * staying at the peer-resolved emission site".
 */
function findGateReferences(body: string): string[] {
  const re = /joinAnnounceLevel|JOIN_ANNOUNCE_LEVELS|joinAnnounceTargets/g;
  const hits: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    hits.push(`"${m[0]}" at offset ${m.index}`);
  }
  return hits;
}

const SEND_ANNOUNCE_EMITTERS = findSendAnnounceEmitters(SRC);

// CARDINALITY FLOOR (review round 2, requirement 2): 7 sendAnnounce( call
// sites are measured in index.ts today (broadcastAnnounce,
// announceToSupervisor, sendJoinAnnounce [excluded by name], announceToLead,
// assignRoadmapItem, stopRoadmapItem, announceTo) -- 6 after excluding
// sendJoinAnnounce. A regex that stops matching (rename, reshape) or a
// deleted emitter must redden THIS floor instead of silently sweeping fewer
// functions -- the anti-vacuity control the reviewer asked for by name.
test("C domain floor: at least 6 non-gated sendAnnounce emitters are discovered in index.ts", () => {
  expect(SEND_ANNOUNCE_EMITTERS.length).toBeGreaterThanOrEqual(6);
});

test("C domain floor: the discovered set includes announceTo (the object-property-shorthand shape the first version of this sweep missed)", () => {
  expect(SEND_ANNOUNCE_EMITTERS.map((e) => e.name)).toContain("announceTo");
});

test("C ABSENCE: no discovered sendAnnounce emitter (other than sendJoinAnnounce) references the join-announce gate", () => {
  const failures = SEND_ANNOUNCE_EMITTERS.flatMap((e) =>
    findGateReferences(e.body).map((hit) => `${e.name}: ${hit}`)
  );
  expect(failures).toEqual([]);
});

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

test("C domain-discovery self-check: findSendAnnounceEmitters catches BOTH declaration shapes and excludes sendJoinAnnounce by name", () => {
  const synthetic = `
const broadcastAnnounce = async (text: string): Promise<number> => {
  return sendAnnounce(text)
}
const sendJoinAnnounce = async (peerId: string): Promise<void> => {
  return sendAnnounce(peerId)
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

// ----- coverage-degradation answer (team lead's explicit question, review
// round 2): the DOMAIN half is now closed too, not just the SENSITIVITY half.
// -----
// slice()'s anchor-not-found path still throws for SEND_JOIN_ANNOUNCE and
// PEER_RESOLVED_HANDLER (used by the B tests), so a rename there fails the
// whole file at load time, never "0 checks, green" -- unchanged from before.
//
// For the C ABSENCE sweep specifically, the failure mode reviewed here was
// different: not a renamed ANCHOR (there is none any more) but the DOMAIN
// silently shrinking -- a regex that stops matching a reshaped declaration,
// or an emitter deleted/renamed, would previously have made
// findSendAnnounceEmitters return fewer entries and the ABSENCE test would
// have stayed a vacuous green over a smaller list. The cardinality floor
// test above (`toBeGreaterThanOrEqual(6)`) is what turns that shrinkage into
// a red, not a silent pass -- proven by mutation: see the test-eng report to
// desktop-7b2civn-koryphaios-3 for the exact command and decisive output of
// (1) replaying mutant m7 (gate planted inside announceTo) against this new
// version and (2) breaking the discovery regex itself to show the floor
// reddens instead of sweeping zero/fewer emitters.
