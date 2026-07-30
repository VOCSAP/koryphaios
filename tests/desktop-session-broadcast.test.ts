import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A `*Detector.on(...)` handler that mutates a RuntimeState field surfaced by
// toRuntime() but skips this.broadcast() leaves the renderer's snapshot stale
// (2026-07-30: the thinking badge froze this way). This is a static/textual
// guard on the whole handler family, deliberately not a pure extracted
// module: the source it scans is session-service.ts itself.
//
// Lives in tests/ (not desktop/src/main/) so it can use bun:test directly --
// desktop/tsconfig.node.json's ambient types don't include bun-types, and
// this file is outside that tsconfig's scope entirely. Named desktop-*.test.ts
// so the Windows/macOS/ubuntu CI matrix (.github/workflows/desktop-build.yml,
// explicit glob list, see TESTING.md) actually runs it.

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");

// Balances braces from just after `openIdx` (which must point at an opening
// `{`) and returns the slice up to (not including) its matching `}`.
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

const DETECTOR_HANDLER_RE = /\w+Detector\.on\(\s*'[^']+',\s*\(\{[^}]*\}[^)]*\)\s*=>\s*\{/g;

function findDetectorHandlers(src: string): Array<{ header: string; body: string }> {
  const handlers: Array<{ header: string; body: string }> = [];
  DETECTOR_HANDLER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DETECTOR_HANDLER_RE.exec(src))) {
    const body = extractBracedBody(src, m.index + m[0].length - 1);
    handlers.push({ header: m[0], body });
  }
  return handlers;
}

// A handler body ASSIGNS (not compares) a field if it contains `r.<field> =`
// not immediately followed by another `=` -- the `(?!=)` excludes `==`/`===`
// comparisons, e.g. startupAckDetector's read-only early-return guard
// `r.status === 'exited'`, which must never be flagged as a mutation.
function mutatesField(body: string, field: string): boolean {
  return new RegExp(`\\br\\.${field}\\s*=(?!=)`).test(body);
}

function findUnbroadcastMutators(src: string, fields: string[]): string[] {
  return findDetectorHandlers(src)
    .filter((h) => fields.some((f) => mutatesField(h.body, f)) && !h.body.includes("this.broadcast()"))
    .map((h) => h.header);
}

test("toRuntime()'s renderer-visible field set matches the known RuntimeState shape", () => {
  const fields = extractRuntimeFields(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  // Sorted exact match, not arrayContaining: a field renamed/added/removed in
  // toRuntime() must fail this loudly so the guard's own coverage is
  // reviewed, not silently keep scanning a stale field list.
  expect(fields.sort()).toEqual(
    ["exitCode", "expired", "needsAttention", "peerId", "pid", "rateLimited", "resumeAt", "status", "thinking"].sort()
  );
});

test("every Detector.on handler in session-service.ts that mutates a renderer-visible field calls this.broadcast()", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const fields = extractRuntimeFields(src);
  expect(findUnbroadcastMutators(src, fields)).toEqual([]);
});

// ----- proof the guard is load-bearing, via synthetic fixtures (not the real
// file -- mutating session-service.ts itself in a test is fragile) -----

const FIXTURE_FIELDS = ["status", "thinking"];

test("the guard flags an unknown handler that mutates a guarded field with no broadcast", () => {
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
