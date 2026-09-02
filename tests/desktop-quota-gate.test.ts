// Card fd1914cc correction: SessionService.quotaGateActive must gate ONLY
// the DEFAULT auto-resume path (def.autoResume === undefined) for a claude
// session, never an EXPLICIT per-session override (true or false) -- an
// operator who forces autoResume=true needs quotaDetector.feed to keep
// running for that tile, or the injection they just authorized would have
// no trigger. session-service.ts imports node-pty (native addon), so this
// extracts the real method body from the source text and executes it
// against a stubbed `this` (isClaudeSession stubbed directly: that
// collaborator's own logic is covered by tests/desktop-session-kind.test.ts),
// real behavioural proof of the true/false/undefined asymmetry rather than a
// second restatement of the same condition.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isClaudeLaunch } from "../desktop/src/main/session-kind.ts";

const SESSION_SERVICE_PATH = join(
  import.meta.dir,
  "..",
  "desktop",
  "src",
  "main",
  "session-service.ts"
);

function extractBracedBody(src: string, openIdx: number): string {
  let depth = 1;
  let i = openIdx + 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  if (depth !== 0) {
    throw new Error(
      `extractBracedBody: brace block starting at "${src.slice(Math.max(0, openIdx - 60), openIdx + 1)}" never closed -- source truncated, renamed, or reshaped?`
    );
  }
  return src.slice(openIdx + 1, i - 1);
}

// The extractors below use the FIRST regex match unconditionally
// (RegExp.prototype.exec on a non-global pattern). That is safe against a
// rename (throws, see below) or a name-containing decoy (the signature's
// literal continuation breaks contiguity) -- proven by mutation, koryphaios
// card fd1914cc audit. It is NOT safe against an exact-name duplicate
// declared earlier in the file: `.exec()` would silently grab that decoy's
// body instead of the real one, and -- because the fabricated `self` in
// this file drives assertions with genuinely different expected booleans
// per test -- that failure mode does not even show up as a clean "all
// red": some assertions coincidentally still match the decoy's output,
// producing a misleading PARTIAL pass that reads like "fix these two
// assertions" rather than "the extraction is compromised". This guard
// closes that gap by asserting the target signature appears EXACTLY once
// before any extraction is attempted.
function assertSingleDeclaration(src: string, pattern: RegExp, label: string): void {
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
  );
  const count = (src.match(globalPattern) ?? []).length;
  if (count !== 1) {
    throw new Error(
      `extraction compromised: ${label} matched ${count} time(s) in session-service.ts (expected exactly 1). ` +
        "A non-1 count means the next extractQuotaGateActiveBody()/extractIsClaudeSessionBody() call would " +
        "either find nothing (0) or silently grab the WRONG declaration (>1, first match wins) -- not a fault " +
        "in the assertions that follow."
    );
  }
}

function extractQuotaGateActiveBody(src: string): string {
  const pattern = /private quotaGateActive\(id: string\): boolean \{/;
  assertSingleDeclaration(src, pattern, "quotaGateActive()");
  const fnMatch = pattern.exec(src);
  if (!fnMatch) {
    throw new Error("quotaGateActive() not found in session-service.ts -- has it been renamed?");
  }
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
}

function extractIsClaudeSessionBody(src: string): string {
  const pattern = /private isClaudeSession\(id: string\): boolean \{/;
  assertSingleDeclaration(src, pattern, "isClaudeSession()");
  const fnMatch = pattern.exec(src);
  if (!fnMatch) {
    throw new Error("isClaudeSession() not found in session-service.ts -- has it been renamed?");
  }
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
}

type Def = { id: string; autoResume?: boolean };

function makeGate(defs: Def[], claudeSession: boolean) {
  const body = extractQuotaGateActiveBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("id", body) as (this: unknown, id: string) => boolean;
  const self = {
    defs,
    isClaudeSession: () => claudeSession
  };
  return (id: string): boolean => fn.call(self, id);
}

test("unknown session id => gate ACTIVE (no def: leans claude, coherent with isClaudeSession's own default, mutation review)", () => {
  const gate = makeGate([], true);
  expect(gate("missing")).toBe(true);
});

test("non-claude session, default path => gate inactive regardless of claudeSession-independent default", () => {
  const gate = makeGate([{ id: "a" }], false);
  expect(gate("a")).toBe(false);
});

test("claude session, default path (autoResume undefined) => gate ACTIVE", () => {
  const gate = makeGate([{ id: "a" }], true);
  expect(gate("a")).toBe(true);
});

test("claude session, explicit autoResume=true => gate inactive (override wins, feed must keep running)", () => {
  const gate = makeGate([{ id: "a", autoResume: true }], true);
  expect(gate("a")).toBe(false);
});

test("claude session, explicit autoResume=false => gate inactive (override wins, matches pre-card disabled behaviour)", () => {
  const gate = makeGate([{ id: "a", autoResume: false }], true);
  expect(gate("a")).toBe(false);
});

// ----- Regression: isClaudeSession must answer from a value FROZEN at spawn
// (RuntimeState.claudeLaunch), never recompute live from this.launchCommand.
// setLaunchCommand's own doc comment says "Affects future spawns only; live
// PTYs keep running what they started with" -- a live recompute contradicts
// that for THIS exact field. Both real bodies (isClaudeSession AND
// quotaGateActive) are extracted and wired together for real, not stubbed:
// stubbing isClaudeSession (as the tests above do, deliberately, to isolate
// quotaGateActive's own precedence logic) would hide this exact defect,
// since the bug lives inside isClaudeSession itself.

function makeRealGate(initialLaunchCommand: string, frozenClaudeLaunchAtSpawn: boolean) {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const isClaudeSessionBody = extractIsClaudeSessionBody(src);
  const quotaGateActiveBody = extractQuotaGateActiveBody(src);
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const isClaudeSessionFn = new Function("id", "isClaudeLaunch", isClaudeSessionBody) as (
    this: unknown,
    id: string,
    isClaudeLaunchArg: (command: string) => boolean
  ) => boolean;
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const quotaGateActiveFn = new Function("id", quotaGateActiveBody) as (
    this: unknown,
    id: string
  ) => boolean;

  const self = {
    defs: [{ id: "a", command: "" }],
    launchCommand: initialLaunchCommand,
    // Simulates the RuntimeState entry startPty() would have set at spawn
    // time, once the fix lands (harmless/unread by today's pre-fix body).
    runtime: new Map([["a", { claudeLaunch: frozenClaudeLaunchAtSpawn }]]),
    isClaudeSession: (id: string): boolean => isClaudeSessionFn.call(self, id, isClaudeLaunch)
  };

  return {
    quotaGateActive: (id: string): boolean => quotaGateActiveFn.call(self, id),
    setLaunchCommand: (cmd: string): void => {
      self.launchCommand = cmd;
    }
  };
}

test("REGRESSION (card fd1914cc correction): a session spawned on the default claude command stays gated after the GLOBAL launch command later changes to a non-claude CLI", () => {
  const svc = makeRealGate(
    "claude --dangerously-load-development-channels server:claude-peers",
    true
  );
  expect(svc.quotaGateActive("a")).toBe(true);

  // The operator changes the global launch command while session "a" is
  // still alive, running claude. Only FUTURE spawns should be affected.
  svc.setLaunchCommand("codex --flag");

  // If this fails, the already-live claude session flipped to "non-claude"
  // out from under itself: the Deck's own detector+injector re-arm on a
  // live Claude Code terminal, which is exactly the double-injector this
  // whole card exists to prevent.
  expect(svc.quotaGateActive("a")).toBe(true);
});

// =============================================================================
// Team-lead mutation review (2026-08-19): six findings below. Three MAJOR
// (a load-bearing line with no test, a frozen-at-spawn assignment with no
// test, and a Sidebar escape hatch with no test), three MINOR (branch
// defaults on isClaudeSession/resolveClaudeLaunch/toRuntime). Reviewer's
// own measurement: mutating each of the six previously left 187 pass, 0
// fail. See tests/desktop-sidebar-autoresume-dom.test.ts for the Sidebar
// (third MAJOR) proof -- that one needs a real DOM, out of this file's
// reach.
// =============================================================================

function extractPtyDataHandlerBody(src: string): string {
  const pattern = /this\.pty\.on\('data', \(e: \{ id: string; data: string \}\) => \{/;
  assertSingleDeclaration(src, pattern, "pty.on('data', ...) handler");
  const fnMatch = pattern.exec(src);
  if (!fnMatch) {
    throw new Error(
      "pty.on('data', ...) handler not found in session-service.ts -- has it been renamed?"
    );
  }
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
}

function makeDataHandler(gateActive: boolean) {
  const body = extractPtyDataHandlerBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("e", body) as (this: unknown, e: { id: string; data: string }) => void;
  const feedCalls: string[] = [];
  const self = {
    emit: () => {},
    outputAt: new Map<string, number>(),
    thinkingDetector: { feed: () => {} },
    // Directly controllable: this test targets ONLY the `if
    // (!this.quotaGateActive(e.id))` line, not quotaGateActive's own
    // precedence logic (covered by the earlier tests in this file).
    quotaGateActive: () => gateActive,
    quotaDetector: { feed: (id: string) => feedCalls.push(id) },
    attentionDetector: { feed: () => {} },
    startupAckDetector: { feed: () => {} },
    screenGuard: { feed: () => {} },
    // Card 1aa69066/H2: the real handler now also routes through
    // this.oscParserFor(e.id).feed(e.data) -- stubbed directly, same
    // reasoning as quotaGateActive above (this test targets only the gate
    // condition, not the OSC parser's own behaviour, covered by
    // tests/desktop-osc.test.ts). Returns a real-shaped snapshot (not `{}`)
    // because the handler now reads `.titleSeq` off it unconditionally.
    oscParserFor: () => ({ feed: () => ({ title: null, progress: null, notify: null, titleSeq: 0 }) }),
    // Card f8082208: the handler also routes titleSeq into
    // this.activityTrackerFor(e.id).observe(...) -- stubbed directly, same
    // reasoning (covered for real by tests/desktop-activity.test.ts).
    activityTrackerFor: () => ({ observe: () => {} })
  };
  return {
    run: (e: { id: string; data: string }): void => fn.call(self, e),
    feedCalls
  };
}

// MAJOR 1: mutating away the `if (!this.quotaGateActive(e.id))` condition
// (leaving quotaDetector.feed unconditional) left every prior test green --
// nothing exercised this exact handler. This is the SOLE load-bearing gate
// (autoResume()'s own quotaGateActive check is unreachable defense-in-depth,
// since autoResume only fires from 'resume-due', which only fires if feed
// ran in the first place -- see quotaGateActive's doc comment above).
test("MAJOR (mutation review): the pty data handler does NOT feed quotaDetector when the gate is active", () => {
  const h = makeDataHandler(true);
  h.run({ id: "a", data: "some output" });
  expect(h.feedCalls).toEqual([]);
});

test("MAJOR (mutation review): the pty data handler DOES feed quotaDetector when the gate is not active", () => {
  const h = makeDataHandler(false);
  h.run({ id: "a", data: "some output" });
  expect(h.feedCalls).toEqual(["a"]);
});

function extractStartPtyBody(src: string): string {
  const pattern = /private startPty\(def: SessionDef, mode: SpawnMode\): void \{/;
  assertSingleDeclaration(src, pattern, "startPty()");
  const fnMatch = pattern.exec(src);
  if (!fnMatch) {
    throw new Error("startPty() not found in session-service.ts -- has it been renamed?");
  }
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
}

/**
 * Locates the SPECIFIC `if (r) { r.status = 'running' ... }` block inside
 * startPty's body (there are two other `if (r) { ... }` blocks in the same
 * method, both on the spawn-FAILURE paths, setting `r.status = 'exited'` --
 * disambiguated by anchoring on the 'running' reset, which is unique to the
 * success path this test targets).
 */
function extractRunningResetBlock(body: string): string {
  const statusIdx = body.indexOf("r.status = 'running'");
  if (statusIdx === -1) {
    throw new Error(
      "startPty()'s r.status = 'running' reset not found -- has the per-spawn reset shape changed?"
    );
  }
  const ifIdx = body.lastIndexOf('if (r) {', statusIdx);
  if (ifIdx === -1) {
    throw new Error("startPty()'s enclosing if (r) { ... } block for the running reset not found");
  }
  return extractBracedBody(body, ifIdx + 'if (r) {'.length - 1);
}

// MAJOR 2: mutating away `r.claudeLaunch = isClaudeLaunch(base)` from
// startPty left every prior test green -- RuntimeState.claudeLaunch then
// falls back to the value create()/restoreFrom() SEEDED, and the exact
// staleness this whole freeze-at-spawn fix exists to remove comes back.
// startPty spawns a REAL PTY (node-pty, no bun-test-friendly seams), so
// extract-and-execute is not reasonable here -- this PINNED SOURCE SCAN
// proves the assignment is WIRED at the right spot, not the full contract
// (i.e. it would not catch `isClaudeLaunch(base)` being computed correctly
// but assigned to the wrong field, only its outright absence/removal).
test("MAJOR (mutation review, PINNED SOURCE SCAN): startPty freezes r.claudeLaunch from `base` alongside its other per-spawn resets", () => {
  const body = extractStartPtyBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  const resetBlock = extractRunningResetBlock(body);
  expect(resetBlock).toContain("r.claudeLaunch = isClaudeLaunch(base)");
});

// ----- MINOR branch-coverage gaps: each of these three defaults reads
// "true" today; a mutant flipping it to "false" left every prior test
// green because the fallback branch was never actually exercised.

test("MINOR (mutation review): isClaudeSession leans claude (true) when there is no runtime entry for id", () => {
  const body = extractIsClaudeSessionBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("id", "isClaudeLaunch", body) as (
    this: unknown,
    id: string,
    isClaudeLaunchArg: (command: string) => boolean
  ) => boolean;
  const self = { runtime: new Map<string, { claudeLaunch: boolean }>() }; // no entry for "missing"
  expect(fn.call(self, "missing", isClaudeLaunch)).toBe(true);
});

function extractResolveClaudeLaunchBody(src: string): string {
  const pattern = /private resolveClaudeLaunch\(def: SessionDef\): boolean \{/;
  assertSingleDeclaration(src, pattern, "resolveClaudeLaunch()");
  const fnMatch = pattern.exec(src);
  if (!fnMatch) {
    throw new Error("resolveClaudeLaunch() not found in session-service.ts -- has it been renamed?");
  }
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
}

test("MINOR (mutation review): resolveClaudeLaunch falls back to this.launchCommand when def.command is empty", () => {
  const body = extractResolveClaudeLaunchBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("def", "isClaudeLaunch", body) as (
    this: unknown,
    def: { command: string },
    isClaudeLaunchArg: (command: string) => boolean
  ) => boolean;
  const self = { launchCommand: "codex --flag" };
  // The named mutant (isClaudeLaunch(def.command), dropping the `||`
  // fallback) would call isClaudeLaunch('') -> true (empty-string default);
  // asserting `false` here is exactly what that mutant fails.
  expect(fn.call(self, { command: "" }, isClaudeLaunch)).toBe(false);
});

function extractToRuntimeBody(src: string): string {
  const pattern = /private toRuntime\(def: SessionDef\): SessionRuntime \{/;
  assertSingleDeclaration(src, pattern, "toRuntime()");
  const fnMatch = pattern.exec(src);
  if (!fnMatch) {
    throw new Error("toRuntime() not found in session-service.ts -- has it been renamed?");
  }
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
}

test("MINOR (mutation review): toRuntime leans claude (true) for claudeLaunch when there is no runtime entry", () => {
  const body = extractToRuntimeBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("def", body) as (
    this: unknown,
    def: { id: string }
  ) => { claudeLaunch: boolean };
  const self = {
    runtime: new Map<string, { claudeLaunch: boolean }>(), // no entry for "missing"
    pty: { isAlive: () => false, pid: () => null }
  };
  const result = fn.call(self, { id: "missing" });
  expect(result.claudeLaunch).toBe(true);
});
