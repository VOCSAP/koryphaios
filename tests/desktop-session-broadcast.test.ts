import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A handler wired via `<receiver>.on(...)` that mutates a RuntimeState field
// surfaced by toRuntime() but skips this.broadcast() leaves the renderer's
// snapshot stale (2026-07-30: the thinking badge froze this way). This is a
// static/textual guard on the whole handler family, deliberately not a pure
// extracted module: the source it scans is session-service.ts itself.
//
// Card 581a0d56 (2026-08-26 mutation review, measured 2026-08-27): the prior
// version of this guard anchored its handler discovery on a REGEX with two
// filters -- the receiver's NAME had to match `\w+Detector`, and the
// callback's parameter had to be a destructured object literal `({...})`.
// Both filters are accidental, not semantic: `this.pty.on('exit', ...)`
// mutates `status`/`exitCode`/`activity` and was invisible only because "pty"
// doesn't end in "Detector"; the activity tracker's `t.on((state) => ...)`
// mutates `activity` and was invisible on BOTH counts (name "t", positional
// param). Measured real-domain coverage that day: 5 mutating `.on(...)` call
// sites in session-service.ts, only 3 seen by the old regex. Worse than
// stagnant, coverage was REGRESSIVE by construction: any lot that introduces
// a differently-named or differently-shaped event emitter silently shrinks
// what this guard can see, with nothing turning red.
//
// This version discovers its domain the way toRuntime()'s own field list is
// discovered -- by SCANNING the real source, not by matching a name or a
// shape. `findOnCallSites` finds every `<expr>.on(` call in the file, full
// stop; `resolveCallbackBody` then extracts that call's callback body
// regardless of whether it is a destructured-object arrow, a positional-arg
// arrow, an `async` arrow, or a *named reference* to a method/const-arrow
// defined elsewhere in the same file (resolved by scanning for that
// definition; an UNRESOLVABLE reference throws rather than being silently
// treated as safe -- an unresolved callback is a guard blind spot, not a
// passing case, same principle as `extractRuntimeFields`'s own "not found"
// throws below).
//
// Lives in tests/ (not desktop/src/main/) so it can use bun:test directly --
// desktop/tsconfig.node.json's ambient types don't include bun-types, and
// this file is outside that tsconfig's scope entirely. Named desktop-*.test.ts
// so the Windows/macOS/ubuntu CI matrix (.github/workflows/desktop-build.yml,
// explicit glob list, see TESTING.md) actually runs it.

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");

// Comments must be stripped BEFORE the general `.on(` domain scan below, or
// the scan lies: a doc comment that mentions a call shape in prose (this
// file has one -- "inlined in the pty.on('data') handler" a few lines above
// oscParserFor) reads as a real call site once the name/shape filters that
// used to narrow the match are gone. A flat "strings|comments" alternation
// regex is unsound here (an English contraction like "doesn't" in a comment
// is an unpaired `'` that swallows real code up to the next unrelated quote)
// -- this is a single left-to-right character-state scanner instead, so a
// comment's own characters (including its apostrophes) are consumed inside
// the `line`/`block` states and never reach the string-matching logic at
// all. No regex-literal state: session-service.ts has no regex literals
// (checked), so that transition is not needed here.
function stripComments(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  let state: "code" | "line" | "block" | "str" | "tmpl" = "code";
  let strCh = "";
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; i += 2; continue; }
      if (c === "'" || c === '"') { strCh = c; state = "str"; out += c; i++; continue; }
      if (c === "`") { strCh = "`"; state = "tmpl"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; i += 2; continue; }
      if (c === "\n") out += c;
      i++; continue;
    }
    // "str" and "tmpl": copy verbatim, respect backslash escapes, close on
    // the matching quote.
    out += c;
    if (c === "\\") { out += s[i + 1] ?? ""; i += 2; continue; }
    if (c === strCh) state = "code";
    i++;
  }
  return out;
}

// Balances delimiters from just after `openIdx` (which must point at an
// opening `openCh`) and returns the index just PAST the matching `closeCh`.
// Shared by brace and paren matching below -- string/regex-literal contents
// are not excluded (accepted pre-existing limitation of this file's whole
// regex-based approach, same as the original extractBracedBody).
function findMatchingClose(s: string, openIdx: number, openCh: string, closeCh: string): number {
  let depth = 1;
  let i = openIdx + 1;
  while (depth > 0 && i < s.length) {
    if (s[i] === openCh) depth++;
    else if (s[i] === closeCh) depth--;
    i++;
  }
  return i;
}

function extractBracedBody(src: string, openIdx: number): string {
  return src.slice(openIdx + 1, findMatchingClose(src, openIdx, "{", "}") - 1);
}

function extractParenBody(src: string, openIdx: number): string {
  return src.slice(openIdx + 1, findMatchingClose(src, openIdx, "(", ")") - 1);
}

// toRuntime() is the source of truth for which RuntimeState fields the
// renderer actually sees -- extracted from its `return { ... }` object
// literal rather than hand-listed. A hand-maintained list drifts silently as
// fields are added: a prior version of this guard hard-coded 4 field names
// and missed 4 more (status, exitCode, peerId, expired), so a future handler
// mutating one of those went undetected.
function extractRuntimeFields(src: string): string[] {
  const fnMatch = /private toRuntime\([^)]*\)[^{]*\{/.exec(src);
  if (!fnMatch) throw new Error("toRuntime() not found in session-service.ts -- has it been renamed?");
  const fnBody = extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
  const returnMatch = /return\s*\{/.exec(fnBody);
  if (!returnMatch) throw new Error("toRuntime()'s return object literal not found");
  const returnBody = extractBracedBody(fnBody, returnMatch.index + returnMatch[0].length - 1);
  return [...returnBody.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);
}

// ----- general `.on(...)` domain discovery (card 581a0d56) -----

interface OnCallSite {
  line: number;
  receiver: string;
  argsText: string;
}

// Every `<expr>.on(` call site, independent of receiver NAME (no `Detector`
// anchor) and of callback SHAPE (no destructured-object anchor) -- that
// independence is the whole point of this rewrite.
const ON_CALL_RE = /([\w.]+)\.on\(/g;

function findOnCallSites(src: string): OnCallSite[] {
  const sites: OnCallSite[] = [];
  ON_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ON_CALL_RE.exec(src))) {
    const openParenIdx = m.index + m[0].length - 1;
    const argsText = extractParenBody(src, openParenIdx);
    const line = src.slice(0, m.index).split("\n").length;
    sites.push({ line, receiver: m[1]!, argsText });
  }
  return sites;
}

// Resolves a `.on(...)` call's callback argument to its body TEXT, regardless
// of shape: inline arrow with a destructured-object param, a positional
// param, no param, `async`, or a single-expression body with no braces at
// all (`(id) => this.autoResume(id)`) -- or a NAMED REFERENCE to a class
// method / class-field arrow / local `const` arrow defined elsewhere in
// `fullSrc`, resolved by name. Throws on a reference it cannot resolve,
// rather than treating the unknown as non-mutating: a silently-skipped
// reference is exactly the kind of blind spot this rewrite exists to close.
function resolveCallbackBody(argsText: string, fullSrc: string, siteLabel: string): string {
  let rest = argsText.replace(/^\s*'[^']*'\s*,\s*/, "").trim();
  rest = rest.replace(/^async\s+/, "");

  if (rest.startsWith("(")) {
    const paramsEnd = findMatchingClose(rest, 0, "(", ")");
    const afterParams = rest.slice(paramsEnd);
    const arrowMatch = /^\s*(?::[^=]+)?=>\s*/.exec(afterParams);
    if (!arrowMatch) {
      throw new Error(`${siteLabel}: inline callback has no arrow after its parameter list -- unexpected shape`);
    }
    const bodyRest = afterParams.slice(arrowMatch[0].length);
    if (bodyRest.trimStart().startsWith("{")) {
      const braceIdx = bodyRest.indexOf("{");
      return extractBracedBody(bodyRest, braceIdx);
    }
    return bodyRest; // single-expression arrow body, e.g. `this.autoResume(id)`
  }

  // Not an inline function -- a named reference (`this.handleFoo`, `handleFoo`).
  // Resolve it against a class method, a class-field arrow, or a local `const`
  // arrow defined anywhere else in the same source.
  const name = rest.split(".").pop()?.trim();
  if (!name) throw new Error(`${siteLabel}: could not parse callback reference "${rest}"`);
  const defRe = new RegExp(
    `\\b(?:private\\s+|public\\s+|protected\\s+)?(?:const\\s+)?${name}\\s*` +
      `(?::[^=(]+)?=?\\s*(?:async\\s*)?\\(([^)]*)\\)[^{=]*(?:=>)?\\s*\\{`
  );
  const defMatch = defRe.exec(fullSrc);
  if (!defMatch) {
    throw new Error(
      `${siteLabel}: passes a named reference ("${rest}") this guard cannot resolve to a definition. ` +
        "Either convert the handler to an inline arrow, or extend resolveCallbackBody()'s definition " +
        "patterns -- an unresolved reference is a guard blind spot, not a safe default."
    );
  }
  return extractBracedBody(fullSrc, defMatch.index + defMatch[0].length - 1);
}

// A handler body ASSIGNS (not compares) a field if it contains `r.<field> =`
// not immediately followed by another `=` -- the `(?!=)` excludes `==`/`===`
// comparisons, e.g. startupAckDetector's read-only early-return guard
// `r.status === 'exited'`, which must never be flagged as a mutation.
function mutatesField(body: string, field: string): boolean {
  return new RegExp(`\\br\\.${field}\\s*=(?!=)`).test(body);
}

function findUnbroadcastMutators(src: string, fields: string[]): string[] {
  return findOnCallSites(src)
    .map((site) => {
      const label = `L${site.line} ${site.receiver}.on(...)`;
      const body = resolveCallbackBody(site.argsText, src, label);
      const mutated = fields.filter((f) => mutatesField(body, f));
      return { label, mutated, broadcasts: body.includes("this.broadcast()") };
    })
    .filter((s) => s.mutated.length > 0 && !s.broadcasts)
    .map((s) => s.label);
}

// The only external reference for "how many fields toRuntime() should expose"
// -- NOT a candidate for a derived cross-check. RuntimeState.announce is
// assigned in session-service.ts's pollPeerIds() (~line 1048) but is
// deliberately internal, never returned by toRuntime(); a check like "every
// r.<field> = must appear in toRuntime()'s return" would be red from day one.
const KNOWN_FIELDS = ["claudeLaunch", "exitCode", "expired", "needsAttention", "peerId", "pid", "rateLimited", "resumeAt", "status", "activity"];

// Independent of KNOWN_FIELDS on purpose: a hostile or careless edit that
// widens the baseline list to match a broken extractor's output (the thing
// this whole guard exists to catch) cannot silence this one, since it never
// reads the baseline at all.
function assertExtractorProducedFields(fields: string[]): void {
  if (fields.length > 0) return;
  throw new Error(
    "extractRuntimeFields() found zero fields -- the extractor is broken, not toRuntime() itself. " +
      "Most likely cause: the return object literal collapsed onto a single line."
  );
}

// A count below the known baseline is ambiguous by construction: it means
// EITHER the extractor degraded (partial match) OR a field was legitimately
// removed from toRuntime(). This can't tell which -- but naming both readings
// in the message, instead of asserting the extractor is at fault, is what
// keeps a legitimate removal from sending its author chasing a parsing bug
// that doesn't exist.
function assertNoUnexplainedShrinkage(fields: string[], known: string[]): void {
  if (fields.length >= known.length) return;
  throw new Error(
    `extractRuntimeFields() found only ${fields.length} field(s) (${JSON.stringify(fields)}), fewer than the ` +
      `known ${known.length} (${JSON.stringify(known)}). EITHER the extractor degraded -- known causes: the ` +
      "return object literal collapsed onto one line, shorthand keys (`{ thinking, expired }`), quoted keys " +
      '(`"thinking":`), or computed keys (`[key]:`) -- OR a field was deliberately removed from toRuntime(), in ' +
      "which case updating KNOWN_FIELDS below is the right move. Check which one happened before touching anything."
  );
}

test("toRuntime()'s renderer-visible field set matches the known RuntimeState shape", () => {
  const fields = extractRuntimeFields(stripComments(readFileSync(SESSION_SERVICE_PATH, "utf-8")));
  // Shrinkage guard first: on a zero-field extraction it still has a known
  // baseline to compare against and prints the full four-cause diagnostic
  // (shorthand keys degrade to zero too, not just a one-line collapse).
  // assertExtractorProducedFields runs second and only matters once the
  // baseline itself has also been emptied to 0 -- independence preserved.
  assertNoUnexplainedShrinkage(fields, KNOWN_FIELDS);
  assertExtractorProducedFields(fields);
  // Sorted exact match, not arrayContaining: a field renamed/added/removed in
  // toRuntime() must fail this loudly so the guard's own coverage is
  // reviewed, not silently keep scanning a stale field list.
  expect(fields.sort()).toEqual([...KNOWN_FIELDS].sort());
});

test("every `.on(...)` handler in session-service.ts that mutates a renderer-visible field calls this.broadcast()", () => {
  const src = stripComments(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  const fields = extractRuntimeFields(src);
  assertExtractorProducedFields(fields);
  // As of card 581a0d56's fix this sees all 5 real mutating sites (previously
  // 3 of 5): quotaDetector.on('limit'/'clear'), attentionDetector.on('attention'),
  // this.pty.on('exit') and the activity tracker's t.on((state) => ...) --
  // the last two were the guard's own blind spot, not a real bug (both do
  // call this.broadcast()). Negative control: startupAckDetector.on('ack')
  // matches the domain (it's a real `.on(...)` site) but mutates nothing, so
  // it must NOT appear here even though it's now in-scope.
  expect(findUnbroadcastMutators(src, fields)).toEqual([]);
});

// ----- proof the guard is load-bearing, via synthetic fixtures (not the real
// file -- mutating session-service.ts itself in a test is fragile) -----

const FIXTURE_FIELDS = ["status", "thinking"];

test("the guard flags a handler that mutates a guarded field with no broadcast (baseline, Detector-named + destructured)", () => {
  const src = `
    this.someNewDetector.on('event', ({ id }: any) => {
      const r = this.runtime.get(id)
      if (!r) return
      r.status = 'exited'
    })
  `;
  expect(findUnbroadcastMutators(src, FIXTURE_FIELDS)).toHaveLength(1);
});

test("the guard does not flag a handler that only reads a guarded field (startupAck-style)", () => {
  const src = `
    this.startupAckDetector.on('ack', ({ id }: any) => {
      const r = this.runtime.get(id)
      if (!r || r.status === 'exited') return
      this.pty.write(id, '\\r')
    })
  `;
  expect(findUnbroadcastMutators(src, FIXTURE_FIELDS)).toEqual([]);
});

test("the guard does not flag a handler that mutates a guarded field and also broadcasts", () => {
  const src = `
    this.thinkingDetector.on('thinking', ({ id, busy }: any) => {
      const r = this.runtime.get(id)
      if (!r) return
      r.thinking = busy
      this.broadcast()
    })
  `;
  expect(findUnbroadcastMutators(src, FIXTURE_FIELDS)).toEqual([]);
});

// ----- the four domain-growth vectors the OLD name+shape regex could never
// see (card 581a0d56, point 3): each is fed alone, each must be flagged. -----

test("vector (a) -- receiver name does NOT end in 'Detector'", () => {
  const src = `
    this.activityTracker.on('change', ({ id }: any) => {
      const r = this.runtime.get(id)
      if (!r) return
      r.status = 'exited'
    })
  `;
  expect(findUnbroadcastMutators(src, FIXTURE_FIELDS)).toHaveLength(1);
});

test("vector (b) -- handler passed by named reference, not an inline arrow", () => {
  const src = `
    class Foo {
      wire(): void {
        this.someDetector.on('event', this.handleSomeEvent)
      }
      private handleSomeEvent = ({ id }: any) => {
        const r = this.runtime.get(id)
        if (!r) return
        r.status = 'exited'
      }
    }
  `;
  expect(findUnbroadcastMutators(src, FIXTURE_FIELDS)).toHaveLength(1);
});

test("vector (c) -- async inline callback", () => {
  const src = `
    this.someDetector.on('event', async ({ id }: any) => {
      const r = this.runtime.get(id)
      if (!r) return
      r.status = 'exited'
    })
  `;
  expect(findUnbroadcastMutators(src, FIXTURE_FIELDS)).toHaveLength(1);
});

test("vector (d) -- positional (non-destructured) param on a Detector-named receiver", () => {
  const src = `
    this.someDetector.on('event', (payload: any) => {
      const r = this.runtime.get(payload.id)
      if (!r) return
      r.status = 'exited'
    })
  `;
  expect(findUnbroadcastMutators(src, FIXTURE_FIELDS)).toHaveLength(1);
});

test("negative control -- all four vectors also broadcasting are NOT flagged (no false positives introduced by the rewrite)", () => {
  const src = `
    class Foo {
      wireAll(): void {
        this.activityTracker.on('change', ({ id }: any) => {
          const r = this.runtime.get(id)
          if (!r) return
          r.status = 'exited'
          this.broadcast()
        })
        this.someDetector.on('ref-event', this.handleRefEvent)
        this.someDetector.on('async-event', async ({ id }: any) => {
          const r = this.runtime.get(id)
          if (!r) return
          r.status = 'exited'
          this.broadcast()
        })
        this.someDetector.on('positional-event', (payload: any) => {
          const r = this.runtime.get(payload.id)
          if (!r) return
          r.status = 'exited'
          this.broadcast()
        })
      }
      private handleRefEvent = ({ id }: any) => {
        const r = this.runtime.get(id)
        if (!r) return
        r.status = 'exited'
        this.broadcast()
      }
    }
  `;
  expect(findUnbroadcastMutators(src, FIXTURE_FIELDS)).toEqual([]);
});

// ----- proof the two shrink guards are load-bearing, and independent -----

test("the zero-fields guard fires on an empty extraction", () => {
  expect(() => assertExtractorProducedFields([])).toThrow(/found zero fields/);
});

test("the zero-fields guard cannot be silenced by also shrinking the known baseline", () => {
  // The failure mode this guard exists for: a broken extractor AND a
  // baseline edited down to match it. assertNoUnexplainedShrinkage alone
  // would pass here (0 >= 0) -- assertExtractorProducedFields still fires
  // because it never reads the baseline at all.
  expect(() => assertNoUnexplainedShrinkage([], [])).not.toThrow();
  expect(() => assertExtractorProducedFields([])).toThrow(/found zero fields/);
});

test("the shrink guard fires when the extractor returns fewer fields than the known baseline", () => {
  expect(() => assertNoUnexplainedShrinkage(["status", "thinking"], KNOWN_FIELDS)).toThrow(/fewer than the known/);
});

test("the shrink guard does not fire on growth or a rename (count at or above baseline)", () => {
  expect(() => assertNoUnexplainedShrinkage([...KNOWN_FIELDS, "newField"], KNOWN_FIELDS)).not.toThrow();
});
