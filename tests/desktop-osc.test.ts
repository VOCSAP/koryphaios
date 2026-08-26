// Card 1aa69066 (H2, docs/DESIGN-HERDR-ADOPTION.md, amended 2026-08-26).
// spec_a0671b9d.
//
// Two independent halves in this file:
//   1. Behavioural tests of the pure OSC parser (desktop/src/main/detect/osc.ts).
//   2. A discovery-based coverage audit over ONE specific domain: every
//      detector wired into session-service.ts's own `pty.on('data', ...)`
//      handler VIA the shape `<receiver-or-alias>.feed(e.id, ...)`
//      (attention.ts, quota.ts, startup-ack.ts, thinking.ts, screen-model.ts
//      today) -- NOT literally every consumer of that handler's bytes, see
//      the named gap below. Mirrors tests/desktop-tsconfig-flags.test.ts's
//      EXEMPT_SOURCES pattern -- discovery by parsing that ONE handler's real
//      source (never a hardcoded file list), plus a named, reasoned
//      exemption map with a staleness guard.
//
//      NARROWER than "every live PTY-data consumer in the Deck" (review F5,
//      card 1aa69066): magic-compact.ts reads PTY bytes through a DIFFERENT
//      path entirely (`SessionService.waitForOutput`'s per-call `onData`
//      callback, consumed from index.ts -- not a persistent field on
//      session-service.ts, so it has no `this.<field>.feed(e.id, ...)` call
//      shape for this file's anchor to find). It carried the same class of
//      defect and was fixed directly in magic-compact.ts (own regression
//      tests in tests/desktop-magic-compact.test.ts) rather than folded into
//      this discovery mechanism -- widening the anchor to a second, shaped-
//      differently call site was judged disproportionate for one file this
//      round; if a THIRD such site appears, that is the trigger to
//      generalise this discovery beyond one named handler.
//
//      A SECOND gap, same shape, MEASURED 2026-08-26 team-lead review:
//      session-service.ts's own pty.on('data', ...) handler ALSO calls
//      `this.oscParserFor(e.id).feed(e.data)` (around line 251) -- inside
//      the very handler this file parses. It is invisible to
//      discoverFeedFields() for TWO independent reasons at once: the
//      receiver is a METHOD CALL (`this.oscParserFor(e.id)`), not a
//      `this.<field>` property access, and the call's own second argument
//      is `e.data`, not `e.id` -- neither the direct-field regex nor the
//      local-alias/destructuring passes match a shape with no `this.<field>`
//      and no `e.id` argument to `.feed(`. Widening the anchor to also catch
//      this shape was judged, same team-lead arbitration as the
//      magic-compact.ts note above, a FOURTH form on a lot already frozen
//      and measured green -- not reopened today. This file's honest claim is
//      therefore narrower than "every live PTY-data consumer": it covers
//      every consumer wired as `<receiver-or-alias>.feed(e.id, ...)`, not
//      every consumer of the handler's bytes by any call shape.

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
    notify: null
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
  let snap: OscSnapshot = { title: null, progress: null, notify: null };
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
  p.feed(`${ESC}]0;${"x".repeat(20_000)}`); // never terminated here
  p.feed(BEL); // terminates and drops the capped one
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
  expect(fn.call(self, "s1")).toEqual({ title: "a real title", progress: null, notify: null });
  // Reading again must not have mutated anything -- same snapshot, not null
  // or altered by the read itself.
  expect(fn.call(self, "s1")).toEqual({ title: "a real title", progress: null, notify: null });
});

// ----- 4. Discovery-based coverage: no live PTY-data consumer left --------
// -----    stripping ANSI without also stripping OSC -----------------------

// Pinned literal, same reasoning as DESKTOP_SOURCE_DISCOVERY_ARGS in
// tests/desktop-tsconfig-flags.test.ts: if this handler is ever renamed or
// reshaped, this test must fail LOUDLY (a thrown error naming the anchor),
// never silently discover an empty domain and report a suspiciously clean
// "0 violations".
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

// Field names fed real PTY bytes inside the handler, e.g. "thinkingDetector"
// from "this.thinkingDetector.feed(e.id, e.data)" -- discovered by parsing,
// not a hardcoded array, so a detector wired in later is picked up
// automatically. Matches both unconditional calls and quota's own
// conditionally-gated one (same call shape either way).
//
// Card 1aa69066 review, blocker F4: the FIRST cut of this anchored the
// second argument to the literal "e.data", which a synthetic
// `feed(e.id, String(e.data))` call defeated -- the field was never
// discovered at all (not "discovered and passed", genuinely invisible),
// so `auditDetectors` below never even looked at that file. Fixed by
// anchoring ONLY on "<receiver>.feed(e.id" (the id argument is what
// identifies a live PTY-data feed; the payload argument's exact shape is
// not this function's concern). Two more forms widened proactively
// (review's own ask, not separately measured as a defeat): an
// INTERMEDIATE VARIABLE (`const p = this.field; p.feed(e.id, ...)`) and
// DESTRUCTURING (`const { field } = this; field.feed(e.id, ...)`) -- both
// resolved back to the underlying `this.<field>` via a first pass over
// local-variable assignments before the `.feed(e.id` scan.
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

// Card 1aa69066 review round 2, blocker F4: the FIRST cut of this file's
// coverage check was NEGATIVE (flagged one known-bad shape). Inverted to a
// POSITIVE text-scan (two decoupled byte markers).
//
// Card 1aa69066 review round 3, blocker T3: that TEXT-SCAN positive proof
// was ALSO fail-open, on the CROWTH axis this time -- MEASURED against 8
// synthetic CSI-only sources: a JSDoc block naming both bytes, a trailing
// (non-line-leading) comment, an unrelated `BELL_RE`/`[\[\]]` pair, and a
// plain string literal ALL passed a CSI-only file that strips no OSC at
// all. End-to-end: disabling screen-model.ts's real OSC branch plus adding
// one anodyne helper left the whole suite green, zero violations, on a file
// that no longer recognised OSC.
//
// REPLACED with a BEHAVIOURAL proof, the strong form (review's own words:
// "prends la forme FORTE et pas l'adjacence"): feed `ESC]0;<marker>BEL` to
// the file's REAL mechanism and require the marker to disappear. No text
// scan survives this -- there is no comment or string literal that can make
// a function's ACTUAL RUNTIME BEHAVIOUR pass a check that only looks at
// what the function DOES.
//
// The five files discovered today do not share one calling surface
// (attention.ts/quota.ts/startup-ack.ts/thinking.ts export a `stripAnsi`
// function; screen-model.ts does the same job inside `Screen.feed()` via
// `makeScreen()`, no exported strip function at all) -- so each gets its
// own ADAPTER in DETECTOR_ADAPTERS, and per the review's explicit
// constraint, a DISCOVERED path with NO REGISTERED ADAPTER is a VIOLATION,
// never a silent skip. This is what makes the check fail CLOSED on domain
// growth: a sixth detector wired in later, with no adapter added for it,
// is reported by name instead of passing by omission.
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

// Named, written-reason exemption -- the only sanctioned way for a
// discovered detector to skip the OSC-coverage requirement. thinking.ts IS
// wired into the live PTY-data handler (measured, session-service.ts feeds
// it real bytes) and its real `stripAnsi` genuinely does not remove OSC
// (proven behaviourally below, not by text-scan) -- both true at once, and
// neither contradicts the other: it is live in WIRING and dead in SIGNAL.
// BUSY_RE (the only thing thinking.ts's stripped text feeds) has been
// measured dead in production since the CLI's 2026-08-11 update, and its
// repair (card bbc849f7) was explicitly halted by the operator on
// 2026-08-13 for insufficient product value -- cleaning OSC out of the
// input to a predicate that matches nothing is diff noise on a stopped
// workstream, not a fix. Team-lead arbitration, card 1aa69066, 2026-08-26.
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
    // 2026-08-26 team-lead review (single-predicate blind spot, MEASURED):
    // checking ONLY "does the marker survive" left a second failure mode
    // invisible -- a strip that swallows the ENTIRE chunk (a mutant
    // `return ''`) drops the marker along with everything else, so the
    // marker-only predicate reported NO violation for the exact class of
    // defect this lot already fixed elsewhere (an unresolved OSC head
    // swallowing the rest of the stream). Also require the ORDINARY text
    // around the OSC sequence to survive.
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

// Fixture proof that auditDetectors() actually BITES -- synthetic adapters,
// never the real registry or the real tree (auditConfigs' fixture tests in
// tests/desktop-tsconfig-flags.test.ts are the precedent for this shape).
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

// 2026-08-26 team-lead review, single-predicate blind spot: the marker-only
// check above is itself fail-open on a TOTAL-SWALLOW mutant. A strip that
// drops the whole chunk (`return ''`) never lets the marker through either,
// so the old predicate reported zero violations for exactly the class of
// defect this lot fixed elsewhere in the parser (an unresolved OSC head
// swallowing the rest of the stream).
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
