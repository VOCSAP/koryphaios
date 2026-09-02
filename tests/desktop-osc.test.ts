// Discovers every detector fed real PTY bytes via
// `<receiver-or-alias>.feed(e.id, ...)` inside session-service.ts's one
// pty.on('data', ...) handler, from real source text with a named, reasoned
// exemption map -- not a hardcoded file list.
// Narrower than every live PTY-data consumer: magic-compact.ts reads bytes
// through a separate onData callback (own regression tests in
// desktop-magic-compact.test.ts), and this handler's own
// `this.oscParserFor(e.id).feed(e.data)` call is invisible to the discovery
// regex (method-call receiver, e.data not e.id) -- both deliberately out of
// scope rather than widening the anchor for one or two sites.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createOscParser, type OscSnapshot } from "../desktop/src/main/detect/osc.ts";
import { stripAnsi as attentionStripAnsi } from "../desktop/src/main/attention.ts";
import { stripAnsi as quotaStripAnsi } from "../desktop/src/main/quota.ts";
import { stripAnsi as startupAckStripAnsi } from "../desktop/src/main/startup-ack.ts";
import { stripAnsi as thinkingStripAnsi } from "../desktop/src/main/thinking.ts";
import { makeScreen } from "../desktop/src/main/screen-model.ts";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

function osc(ps: string, body: string, terminator: string = BEL): string {
  return `${ESC}]${ps};${body}${terminator}`;
}

// ----- 1. Behavioural tests of createOscParser() --------------------------

test("title (OSC 0) and progress (OSC 9;4) are the LAST seen, no history", () => {
  const p = createOscParser();
  p.feed(osc("0", "first title"));
  const snap = p.feed(osc("0", "second title") + osc("9", "4;42"));
  expect(snap.title).toBe("second title");
  expect(snap.progress).toBe("42");
});

test("OSC 2 also sets title, same as OSC 0", () => {
  const p = createOscParser();
  const snap = p.feed(osc("2", "window title via OSC 2"));
  expect(snap.title).toBe("window title via OSC 2");
});

// titleSeq must increment on OSC 2 exactly like OSC 0; a guard checking only ps
// === '0' would pass every prior test since none read titleSeq off an
// OSC-2-only feed.
test("titleSeq increments on OSC 2 exactly like OSC 0, not just OSC 0", () => {
  const p = createOscParser();
  const snap = p.feed(osc("2", "window title via OSC 2"));
  expect(snap.titleSeq).toBe(1);
});

// titleSeq must not increment on OSC 9;4 (progress) or OSC 777 (notify) -- only
// title (0/2) counts. The CLI emits both for real, so an unguarded increment
// would paint 'working' forever with no title ever shown.
test("titleSeq does NOT increment on OSC 9;4 (progress) or OSC 777 (notify) -- only title (0/2) counts", () => {
  const progress = createOscParser();
  expect(progress.feed(osc("9", "4;42")).titleSeq).toBe(0);

  const notify = createOscParser();
  expect(notify.feed(osc("777", "notify;Claude Code;Claude needs your permission")).titleSeq).toBe(0);
});

test("OSC 777 notify body is surfaced -- the quadruplet extension over the original title/progress pair (card 1aa69066, 2026-08-26 amendment, unblocks f8082208)", () => {
  const p = createOscParser();
  const snap = p.feed(osc("777", "notify;Claude Code;Claude needs your permission"));
  expect(snap.notify).toEqual({ body: "Claude needs your permission" });
});

test("a semicolon inside the notify body survives verbatim (only the first two fields are structural)", () => {
  const p = createOscParser();
  const snap = p.feed(osc("777", "notify;Claude Code;body; with; semicolons"));
  expect(snap.notify?.body).toBe("body; with; semicolons");
});

test("two back-to-back OSC sequences in the same chunk are both captured, not just the first", () => {
  const p = createOscParser();
  const snap = p.feed(osc("0", "busy title") + osc("9", "4;7"));
  expect(snap.title).toBe("busy title");
  expect(snap.progress).toBe("7");
});

test("ST (ESC \\\\) terminator works exactly like BEL", () => {
  const p = createOscParser();
  const snap = p.feed(osc("0", "st-terminated", ST));
  expect(snap.title).toBe("st-terminated");
});

test("plain text around an OSC sequence is not itself parsed as payload", () => {
  const p = createOscParser();
  const snap = p.feed(`before ${osc("0", "t")} after`);
  expect(snap.title).toBe("t");
});

test("nothing seen yet -> all three fields null", () => {
  const p = createOscParser();
  expect(p.feed("plain text, no escapes at all")).toEqual({
    title: null,
    progress: null,
    notify: null,
    titleSeq: 0
  } satisfies OscSnapshot);
});

// ----- 2. Fragmentation across feed() calls, at multiple offsets ----------

test("fragmented at the introducer: ESC in one chunk, ']' in the next", () => {
  const p = createOscParser();
  const whole = osc("0", "split-at-introducer");
  p.feed(whole.slice(0, 1)); // just ESC
  const snap = p.feed(whole.slice(1));
  expect(snap.title).toBe("split-at-introducer");
});

test("fragmented mid-payload, at several offsets", () => {
  const whole = osc("777", "notify;Claude Code;fragmented body text");
  for (let cut = 1; cut < whole.length - 1; cut++) {
    const p = createOscParser();
    p.feed(whole.slice(0, cut));
    const snap = p.feed(whole.slice(cut));
    expect(snap.notify?.body).toBe("fragmented body text");
  }
});

test("fragmented mid-terminator: ESC of the ST in one chunk, backslash in the next", () => {
  const whole = osc("0", "split-mid-terminator", ST);
  const escIndex = whole.length - 2; // ST is the last two bytes: ESC, '\'
  const p = createOscParser();
  p.feed(whole.slice(0, escIndex + 1)); // ends exactly on the ESC of ST
  const snap = p.feed(whole.slice(escIndex + 1)); // just the '\'
  expect(snap.title).toBe("split-mid-terminator");
});

test("a byte-at-a-time feed reconstructs the same payload as one whole feed()", () => {
  const whole = osc("777", "notify;Claude Code;byte at a time");
  const p = createOscParser();
  let snap: OscSnapshot = { title: null, progress: null, notify: null, titleSeq: 0 };
  for (const ch of whole) snap = p.feed(ch);
  expect(snap.notify?.body).toBe("byte at a time");
});

test("an ESC inside an in-progress OSC payload that is NOT followed by a backslash is literal payload content, not a false terminator", () => {
  const p = createOscParser();
  // ESC not followed by '\' mid-payload, then the real terminator.
  const snap = p.feed(`${ESC}]0;a${ESC}Xb${BEL}`);
  expect(snap.title).toBe(`a${ESC}Xb`);
});

// ----- 3. Length cap: a never-terminated sequence does not grow unbound ---

test("a never-terminated OSC sequence stops accumulating past the cap and does not apply a payload once terminated", () => {
  const p = createOscParser();
  // Well past OSC_MAX_LEN (4096), never terminated in this feed() call.
  p.feed(`${ESC}]0;${"x".repeat(20_000)}`);
  // Now terminate it -- the capped sequence must be dropped, not applied.
  const snap = p.feed(BEL);
  expect(snap.title).toBeNull();
});

test("after a capped sequence is finally terminated, the NEXT real OSC sequence is parsed normally (not swallowed)", () => {
  const p = createOscParser();
  p.feed(`${ESC}]0;${"x".repeat(20_000)}`); // never terminated here -- abandons to 'idle' as soon as the cap is exceeded
  p.feed(BEL); // arrives in 'idle' now -- a no-op, nothing left to terminate
  const snap = p.feed(osc("0", "after the cap"));
  expect(snap.title).toBe("after the cap");
});

test("feeding a capped sequence's overflow across MANY small chunks still bounds memory (no throw, no growth-dependent slowdown)", () => {
  const p = createOscParser();
  p.feed(`${ESC}]0;`);
  for (let i = 0; i < 50; i++) p.feed("x".repeat(1000)); // 50,000 chars total, well over the cap
  const snap = p.feed(BEL);
  expect(snap.title).toBeNull();
});

// The cap can also be exceeded from the 'in-osc-esc-seen' state: a held-back
// ESC that turns out not to be a real ST is appended via appendAndCheckCap,
// which can itself push buf past OSC_MAX_LEN on the very next feed()'s first
// character.
test("cap overflow triggered from 'in-osc-esc-seen' (a pending held-back ESC pushes buf past the cap) abandons to idle -- the next well-formed OSC sequence is parsed normally, not merged with the abandoned one's bytes", () => {
  const p = createOscParser();
  p.feed(`${ESC}]0;${"x".repeat(4094)}${ESC}`); // buf = "0;" + 4094 x's = exactly 4096 (at, not over, the cap); trailing ESC held pending
  const snap = p.feed(`A${osc("0", "after")}`); // 'A' triggers the pending-ESC append, overflowing buf by one
  expect(snap.title).toBe("after");
});

// Review round 2: a deliberate, now-documented tradeoff (see OSC_MAX_LEN's
// own doc comment) -- resuming 'idle' immediately on abandon means a
// well-formed OSC sequence EMBEDDED inside the abandoned over-length
// payload is parsed fresh and its payload APPLIED, not discarded along
// with the rest of the hostile/oversized payload. This test both PINS that
// behavior (a future change to it must be a conscious edit here) and
// documents it as intentional, same purpose as safe-strip.ts's own
// abandon-posture tests.
test("a well-formed OSC sequence embedded inside an abandoned over-length payload is applied, not discarded (documented tradeoff, same posture as safe-strip.ts)", () => {
  const p = createOscParser();
  const snap = p.feed(`${ESC}]0;${"y".repeat(9000)}${osc("0", "EVIL")}`);
  expect(snap.title).toBe("EVIL");
});

// Card 5b324e11 (roadmap): unlike safe-strip.ts's CSI/OSC abandon branches
// (card 1aa69066 review round 3, blocker T2), osc.ts's cap-overflow handling
// only set a `capped` flag and left `mode` stuck in 'in-osc'/'in-osc-esc-seen'
// -- so a wholly separate, well-formed OSC sequence arriving with NO explicit
// terminator ever sent for the abandoned head got consumed as if it were
// still part of that head's search for a terminator, and its own terminator
// then failed to apply (capped was still true). Behavioural probe, not a
// text-scan: feeds the real exported createOscParser(), requires the real
// title to come through.
test("a never-terminated, over-cap OSC head does NOT swallow the next well-formed OSC sequence that follows with no terminator sent for the abandoned one", () => {
  const p = createOscParser();
  p.feed(`${ESC}]0;${"x".repeat(20_000)}`); // never terminated, well past OSC_MAX_LEN
  // No BEL/ST sent for the abandoned head -- straight into a brand-new,
  // complete, well-formed OSC sequence in the very next feed() call.
  const snap = p.feed(osc("0", "real title"));
  expect(snap.title).toBe("real title");
});

test("the 8-bit ST (0x9C single byte) terminates an OSC sequence in osc.ts exactly like BEL", () => {
  const p = createOscParser();
  const snap = p.feed(osc("0", "st8-terminated", String.fromCharCode(0x9c)));
  expect(snap.title).toBe("st8-terminated");
});

// ----- 5. No shared state between two concurrent sessions -----------------

test("two parser instances fed interleaved, fragmented chunks never leak state into each other", () => {
  const a = createOscParser();
  const b = createOscParser();

  const wholeA = osc("0", "session A title");
  const wholeB = osc("777", "notify;Claude Code;session B notify");

  const cutA = 8;
  const cutB = 12;

  // Interleave: A's first half, B's first half, A's second half, B's second half.
  a.feed(wholeA.slice(0, cutA));
  b.feed(wholeB.slice(0, cutB));
  const snapA = a.feed(wholeA.slice(cutA));
  const snapB = b.feed(wholeB.slice(cutB));

  expect(snapA.title).toBe("session A title");
  expect(snapA.notify).toBeNull();
  expect(snapB.notify?.body).toBe("session B notify");
  expect(snapB.title).toBeNull();
});

test("two instances constructed from the SAME factory function do not share the module (mint-fresh-object sanity check)", () => {
  const a = createOscParser();
  const b = createOscParser();
  a.feed(osc("0", "only in A"));
  const snapB = b.feed("no osc here at all");
  expect(snapB.title).toBeNull();
});

// ----- 3b. SessionService.oscSnapshot() -- card 1aa69066 review, nit F6 ---
// No caller and no test before this: its doc comment ASSERTS "feeding an
// empty chunk reads the snapshot without mutating any in-progress
// continuation state" -- true by reading createOscParser()'s feed()
// implementation, but wired to no proof (CLAUDE.md's own rule: a comment
// asserting a guarantee must be wired to it). session-service.ts imports
// node-pty, so it cannot be `import`ed directly under bun test -- extract
// the one-line method body and execute it against a stub `this`, same
// technique as tests/desktop-quota-gate.test.ts.

const REPO_ROOT = join(import.meta.dir, "..");
const SESSION_SERVICE_PATH = join(REPO_ROOT, "desktop/src/main/session-service.ts");

function extractOscSnapshotBody(src: string): string {
  const pattern = /oscSnapshot\(id: string\): OscSnapshot \| null \{/;
  const m = pattern.exec(src);
  if (!m) throw new Error("oscSnapshot(id) not found in session-service.ts -- has it been renamed?");
  const braceStart = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart + 1, i);
    }
  }
  throw new Error("oscSnapshot(id) found but its brace block never closed");
}

test("SessionService.oscSnapshot(id): returns null for an unknown session, and feeding an empty chunk reads without mutating", () => {
  const body = extractOscSnapshotBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("id", body) as (this: unknown, id: string) => OscSnapshot | null;

  expect(fn.call({ oscParsers: new Map() }, "unknown-session")).toBeNull();

  const parser = createOscParser();
  parser.feed(`${ESC}]0;a real title${BEL}`);
  const self = { oscParsers: new Map([["s1", parser]]) };
  expect(fn.call(self, "s1")).toEqual({
    title: "a real title",
    progress: null,
    notify: null,
    titleSeq: 1
  });
  // Reading again must not have mutated anything -- same snapshot, not null
  // or altered by the read itself.
  expect(fn.call(self, "s1")).toEqual({
    title: "a real title",
    progress: null,
    notify: null,
    titleSeq: 1
  });
});

// ----- 4. Discovery-based coverage: no live PTY-data consumer left --------
// -----    stripping ANSI without also stripping OSC -----------------------

// Pinned literal anchor: if this handler is ever renamed or reshaped, the test
// must fail loudly naming the anchor, never silently discover an empty domain
// and report a clean '0 violations'.
const PTY_DATA_HANDLER_ANCHOR = "this.pty.on('data', (e: { id: string; data: string }) => {";

function extractPtyDataHandlerBody(src: string): string {
  const start = src.indexOf(PTY_DATA_HANDLER_ANCHOR);
  if (start === -1) {
    throw new Error(
      `PTY_DATA_HANDLER_ANCHOR not found in session-service.ts -- the pty.on('data', ...) ` +
        `handler was renamed or reshaped; update the anchor in tests/desktop-osc.test.ts`
    );
  }
  const braceStart = start + PTY_DATA_HANDLER_ANCHOR.length - 1; // the "{" itself
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error("PTY_DATA_HANDLER_ANCHOR found but its brace block never closed");
}

// Discovers detector fields by parsing `<receiver>.feed(e.id` inside the
// handler body -- anchored on the e.id argument, not the payload's exact shape,
// because anchoring on the literal 'e.data' text let a synthetic `feed(e.id,
// String(e.data))` call go entirely undiscovered.
// Also resolves an intermediate local variable (`const p = this.field;
// p.feed(...)`) and destructuring (`const { field } = this; field.feed(...)`)
// back to the underlying `this.<field>` before the scan.
function discoverFeedFields(handlerBody: string): string[] {
  const fields = new Set<string>();
  let m: RegExpExecArray | null;

  // Direct: this.<field>.feed(e.id, ...) or this.<field>?.feed(e.id, ...).
  const direct = /this\.(\w+)\??\.feed\(\s*e\.id\b/g;
  while ((m = direct.exec(handlerBody))) fields.add(m[1]!);

  // Local variables that alias a `this.<field>` (plain reference or a
  // method call shaped `this.<field>(...)`), and destructured names pulled
  // directly off `this` (the destructured name IS the field name -- a
  // rename via `{ field: alias }` is not a shape this repo's convention
  // produces anywhere today).
  const localToField = new Map<string, string>();
  const assign = /(?:const|let)\s+(\w+)\s*=\s*this\.(\w+)\b/g;
  while ((m = assign.exec(handlerBody))) localToField.set(m[1]!, m[2]!);
  const destructure = /(?:const|let)\s*\{\s*([^}]+?)\s*\}\s*=\s*this\b/g;
  while ((m = destructure.exec(handlerBody))) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().split(/\s*:\s*/)[0]?.trim();
      if (name) localToField.set(name, name);
    }
  }

  // Any `<localVar>.feed(e.id` (or `?.feed`) resolved through the alias map
  // above -- an unresolved local (not a `this`-derived alias) is ignored,
  // never mistaken for a field name.
  const viaLocal = /(\w+)\??\.feed\(\s*e\.id\b/g;
  while ((m = viaLocal.exec(handlerBody))) {
    const field = localToField.get(m[1]!);
    if (field) fields.add(field);
  }

  return [...fields].sort();
}

// Resolves a field name to its repo-root-relative source file by reading
// session-service.ts's own "private <field> = new <Class>(...)" and
// "import { <Class> } from '<path>'" lines, so a detector wired under a new
// field/class name is still followed with no test edit required.
function resolveFieldToFile(sessionServiceSrc: string, field: string): string {
  const ctorRe = new RegExp(`private ${field}(?:\\s*:\\s*\\w+)?\\s*=\\s*new\\s+(\\w+)\\(`);
  const ctorMatch = ctorRe.exec(sessionServiceSrc);
  if (!ctorMatch) {
    throw new Error(`no "private ${field} = new <Class>(...)" found in session-service.ts`);
  }
  const className = ctorMatch[1]!;
  const importRe = new RegExp(`import\\s*\\{[^}]*\\b${className}\\b[^}]*\\}\\s*from\\s*['"](\\.[^'"]+)['"]`);
  const importMatch = importRe.exec(sessionServiceSrc);
  if (!importMatch) {
    throw new Error(`no import statement found for class ${className} (field ${field})`);
  }
  const relFromMain = importMatch[1]!.replace(/^\.\//, "");
  return `desktop/src/main/${relFromMain}.ts`;
}

// Feeds `ESC]0;<marker>BEL` to each detector's real strip mechanism and
// requires the marker to disappear -- a behavioural proof, since a text scan
// for OSC-stripping bytes can be satisfied by an unrelated comment, string
// literal, or byte pair without the function ever stripping anything.
// The five detectors don't share one calling surface (four export stripAnsi;
// screen-model.ts strips inside Screen.feed() via makeScreen(), no exported
// function), so each gets its own adapter in DETECTOR_ADAPTERS, and a
// discovered path with no registered adapter is reported as a violation rather
// than silently skipped.
const OSC_PROBE_MARKER = "OSC_COVERAGE_PROBE_MARKER";
function oscProbeChunk(): string {
  return `before${ESC}]0;${OSC_PROBE_MARKER}${BEL}after`;
}

interface DetectorAdapter {
  /** Runs `chunk` through the file's REAL OSC-handling mechanism and
   * returns the resulting visible/consumed text. */
  strip(chunk: string): string;
}

const DETECTOR_ADAPTERS: Record<string, DetectorAdapter> = {
  "desktop/src/main/attention.ts": { strip: attentionStripAnsi },
  "desktop/src/main/quota.ts": { strip: quotaStripAnsi },
  "desktop/src/main/startup-ack.ts": { strip: startupAckStripAnsi },
  "desktop/src/main/screen-model.ts": {
    // No exported strip function -- the real mechanism is Screen.feed()'s
    // own OSC-skip branch, exercised via the same makeScreen()/text() pair
    // production code (ScreenGuard) uses.
    strip: (chunk) => {
      const screen = makeScreen();
      screen.feed(chunk);
      return screen.text();
    }
  }
  // thinking.ts deliberately has NO entry here -- see EXEMPT_DETECTORS
  // below. Its own staleness proof uses thinkingStripAnsi directly, not
  // this registry (an exempted file must never need an adapter to prove
  // the exemption is still necessary).
};

interface DetectorExemption {
  reason: string;
}

// thinking.ts is wired into the live PTY-data handler but its stripAnsi
// genuinely doesn't remove OSC -- live in wiring, dead in signal. The only
// predicate its stripped text feeds (BUSY_RE) has been dead in production since
// a CLI update, and its repair was explicitly halted for insufficient product
// value, so cleaning OSC out of a predicate that matches nothing is not
// pursued.
const EXEMPT_DETECTORS: Record<string, DetectorExemption> = {
  "desktop/src/main/thinking.ts": {
    reason:
      "BUSY_RE measured dead in production since the CLI's 2026-08-11 update; its repair (card " +
      "bbc849f7) was explicitly halted by the operator on 2026-08-13 for insufficient product " +
      "value. Cleaning OSC out of a predicate's input that matches nothing is noise on a stopped " +
      "workstream, not a fix."
  }
};

// `adapters` is a parameter (defaulting to the real registry) so fixture
// tests below can exercise the audit logic against SYNTHETIC adapters
// without ever touching DETECTOR_ADAPTERS itself.
function auditDetectors(
  paths: string[],
  exemptions: Record<string, DetectorExemption>,
  adapters: Record<string, DetectorAdapter> = DETECTOR_ADAPTERS
): string[] {
  const violations: string[] = [];
  const chunk = oscProbeChunk();
  for (const path of paths) {
    if (Object.hasOwn(exemptions, path)) continue;
    const adapter = adapters[path];
    if (!adapter) {
      violations.push(
        `${path}: no behavioural adapter registered in DETECTOR_ADAPTERS -- a newly discovered ` +
          `live PTY-data consumer fails CLOSED until one is added, it is never silently skipped`
      );
      continue;
    }
    const out = adapter.strip(chunk);
    if (out.includes(OSC_PROBE_MARKER)) {
      violations.push(`${path}: the OSC payload survived its real strip mechanism (behavioural probe)`);
      continue;
    }
    // Checking only whether the marker survives misses a strip that swallows
    // the entire chunk (e.g. `return ''`), which drops the marker along with
    // everything else and would report no violation. Also requires the ordinary
    // text around the OSC sequence to survive.
    if (!(out.includes("before") && out.includes("after"))) {
      violations.push(`${path}: ordinary text around the OSC sequence did not survive its real strip mechanism (behavioural probe)`);
    }
  }
  return violations;
}

test("every live PTY-data consumer shaped as `<receiver>.feed(e.id, ...)` (discovered from session-service.ts's own handler, not a hardcoded list -- NOT every consumer of that handler's bytes by any call shape, see the file header for the oscParserFor(e.id).feed(e.data) gap) either strips OSC (proven BEHAVIOURALLY, not by text-scan) or is a named, reasoned exemption", () => {
  const sessionServiceSrc = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const handlerBody = extractPtyDataHandlerBody(sessionServiceSrc);
  const fields = discoverFeedFields(handlerBody);

  // Anchor, not just a floor -- the same reasoning as tsconfig-flags.test.ts:
  // pin the fields known to be wired as of this card (all 5, including
  // `screenGuard`), so losing OR gaining one fails loudly. `toEqual` on the
  // full array already subsumes a length check, so no separate floor
  // assertion is needed (review round 3, nit T7). If this fails because a
  // NEW field legitimately joined the set: add its file to
  // DETECTOR_ADAPTERS (or EXEMPT_DETECTORS with a written reason) before
  // updating this array, not after -- the point of this test failing loudly
  // is to force that decision at review time.
  expect(fields).toEqual(["attentionDetector", "quotaDetector", "screenGuard", "startupAckDetector", "thinkingDetector"]);

  const paths = fields.map((field) => resolveFieldToFile(sessionServiceSrc, field));
  const violations = auditDetectors(paths, EXEMPT_DETECTORS);
  expect(violations).toEqual([]);
});

test("EXEMPT_DETECTORS only names a field that is actually discovered and whose REAL stripAnsi genuinely lets the OSC probe through (a stale exemption is silent, not caught elsewhere)", () => {
  const sessionServiceSrc = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const handlerBody = extractPtyDataHandlerBody(sessionServiceSrc);
  const fields = discoverFeedFields(handlerBody);
  const discoveredPaths = new Set(fields.map((f) => resolveFieldToFile(sessionServiceSrc, f)));

  for (const [path, entry] of Object.entries(EXEMPT_DETECTORS)) {
    expect(discoveredPaths.has(path), `EXEMPT_DETECTORS names ${path}, which discovery did not find wired to live PTY data`).toBe(true);
    expect(entry.reason.trim().length, `EXEMPT_DETECTORS["${path}"] reason is too short`).toBeGreaterThan(20);
  }
  // thinking.ts specifically: its real stripAnsi, run behaviourally, must
  // still let the OSC probe marker through -- if a future edit ever fixes
  // it, this assertion fails and names the exemption as unnecessary.
  expect(
    thinkingStripAnsi(oscProbeChunk()).includes(OSC_PROBE_MARKER),
    'EXEMPT_DETECTORS["desktop/src/main/thinking.ts"] is unnecessary: its stripAnsi now removes OSC'
  ).toBe(true);
});

test("auditDetectors: a synthetic file whose strip does NOT remove the OSC probe is reported unless exempted", () => {
  const fakePath = "desktop/src/main/fake-detector.ts";
  // eslint-disable-next-line no-control-regex -- CSI-only, genuinely does not touch OSC
  const csiOnly = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const adapters = { [fakePath]: { strip: csiOnly } };
  expect(auditDetectors([fakePath], {}, adapters)).toEqual([
    `${fakePath}: the OSC payload survived its real strip mechanism (behavioural probe)`
  ]);
  expect(auditDetectors([fakePath], { [fakePath]: { reason: "synthetic fixture" } }, adapters)).toEqual([]);
});

test("auditDetectors: a strip that swallows the WHOLE chunk (return '') drops the marker too, but also drops the surrounding ordinary text -- must still be reported", () => {
  const fakePath = "desktop/src/main/fake-detector.ts";
  const swallowAll: DetectorAdapter["strip"] = () => "";
  expect(auditDetectors([fakePath], {}, { [fakePath]: { strip: swallowAll } })).toEqual([
    `${fakePath}: ordinary text around the OSC sequence did not survive its real strip mechanism (behavioural probe)`
  ]);
});

// The core of T3: text tricks that defeated the OLD text-scan check
// (comment naming both bytes, unrelated regex + string literal nearby) do
// NOTHING against a behavioural probe -- there is no source text for them
// to fool, only a function call and its return value.
test("auditDetectors: no text trick (comment, unrelated regex, string literal) can pass a CSI-only strip -- only real OSC removal does", () => {
  const fakePath = "desktop/src/main/fake-detector.ts";
  // eslint-disable-next-line no-control-regex
  const csiOnlyWithDecoys = (s: string) =>
    // The decoys (JSDoc naming \x07 and \], an unrelated BELL_RE, a string
    // literal) are pure text that a RUNTIME probe never reads -- only this
    // regex's actual behaviour matters, and it is still CSI-only.
    s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const adapters = { [fakePath]: { strip: csiOnlyWithDecoys } };
  expect(auditDetectors([fakePath], {}, adapters)).toEqual([
    `${fakePath}: the OSC payload survived its real strip mechanism (behavioural probe)`
  ]);
});

test("auditDetectors: a genuinely OSC-aware strip (regex, \\x1b factored out of the alternation -- the shape attention.ts/quota.ts/startup-ack.ts actually ship) is not reported", () => {
  const fakePath = "desktop/src/main/fake-detector.ts";
  // eslint-disable-next-line no-control-regex
  const realShape = (s: string) =>
    s.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b\n]{0,4096}(?:\x07|\x1b\\))/g, "");
  expect(auditDetectors(["desktop/src/main/fake-detector.ts"], {}, { [fakePath]: { strip: realShape } })).toEqual([]);
});

test("auditDetectors: the REAL screen-model.ts adapter (char comparisons, no regex) genuinely removes the OSC probe", () => {
  expect(auditDetectors(["desktop/src/main/screen-model.ts"], {})).toEqual([]);
});

// The point of T3: a discovered path with NO registered adapter fails
// CLOSED (named, reported), never silently skipped -- this is what makes
// the check hold under DOMAIN GROWTH (a sixth detector added later).
test("auditDetectors: a discovered path with no registered adapter is reported by name, not silently skipped", () => {
  const newPath = "desktop/src/main/a-brand-new-detector.ts";
  expect(auditDetectors([newPath], {})).toEqual([
    `${newPath}: no behavioural adapter registered in DETECTOR_ADAPTERS -- a newly discovered live PTY-data consumer fails CLOSED until one is added, it is never silently skipped`
  ]);
  // An exemption also satisfies it -- the two sanctioned outcomes are
  // "adapter proves it strips OSC" or "named, reasoned exemption", nothing
  // else.
  expect(auditDetectors([newPath], { [newPath]: { reason: "not a real detector, test fixture" } })).toEqual([]);
});

// ----- discoverFeedFields: the three evasions/widenings from review F4 ----

test("discoverFeedFields: a transformed second argument (String(e.data)) no longer makes the field invisible to discovery (the third evasion measured in review)", () => {
  const handlerBody = "this.fakeDetector.feed(e.id, String(e.data))\n";
  expect(discoverFeedFields(handlerBody)).toEqual(["fakeDetector"]);
});

test("discoverFeedFields: optional chaining (?.feed) is discovered", () => {
  const handlerBody = "this.fakeDetector?.feed(e.id, e.data)\n";
  expect(discoverFeedFields(handlerBody)).toEqual(["fakeDetector"]);
});

test("discoverFeedFields: a field aliased through an intermediate local variable is discovered", () => {
  const handlerBody = "const p = this.fakeDetector\np.feed(e.id, e.data)\n";
  expect(discoverFeedFields(handlerBody)).toEqual(["fakeDetector"]);
});

test("discoverFeedFields: a field pulled off `this` via destructuring is discovered", () => {
  const handlerBody = "const { fakeDetector } = this\nfakeDetector.feed(e.id, e.data)\n";
  expect(discoverFeedFields(handlerBody)).toEqual(["fakeDetector"]);
});

test("discoverFeedFields: an unresolved local variable (not derived from `this`) is never mistaken for a field", () => {
  const handlerBody = "const p = makeSomething()\np.feed(e.id, e.data)\n";
  expect(discoverFeedFields(handlerBody)).toEqual([]);
});
