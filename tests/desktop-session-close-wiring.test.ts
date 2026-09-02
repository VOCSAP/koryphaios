// Card 032bdeae: gracefulClose (session-close.ts) was written, tested, and
// wired to NO production call -- session-service.ts's remove() did a bare
// this.pty.kill(id). This file proves the NEW options (isModal,
// isClosingForced, cleanup, absoluteDeadlineMs) that session-service.ts's
// remove() now supplies, behaviorally, against the real exported
// gracefulClose -- not the pre-existing 4 tests in
// tests/desktop-workspace.test.ts:931-994, which only ever exercised the
// ORIGINAL write/isAlive/kill/delay shape and remain untouched by this lot.
//
// SessionService itself is not bun-test-importable (PtyManager -> node-pty),
// same constraint tests/desktop-inject-command-modal-guard.test.ts documents
// -- so the actual CALL SITE inside remove() (that it awaits gracefulClose
// with these exact options) is covered by a source scan at the bottom of
// this file, not a behavioral probe. That half is explicitly the WEAK one;
// see its own comment.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gracefulClose } from "../desktop/src/main/session-close.ts";

const EXIT = "/exit\n";
const ESC = "\x1b";
const CTRL_C = "\x03";
const noDelay = (): Promise<void> => Promise.resolve();

// ----- P1: modal pre-check, t0 only, zero writes -----

test("P1 -- isModal() true skips the whole escalation: zero writes, kill() called once", async () => {
  const writes: string[] = [];
  let killed = 0;
  const outcome = await gracefulClose({
    write: (d) => writes.push(d),
    isAlive: () => true,
    kill: () => {
      killed++;
    },
    delay: noDelay,
    isModal: () => true
  });
  expect(outcome).toBe("modal");
  expect(writes).toEqual([]);
  expect(killed).toBe(1);
});

// ----- P2: nominal, dies on the first /exit, kill() never reached -----

test("P2 -- nominal: '/exit\\n' written, isAlive false after, kill() never called", async () => {
  const writes: string[] = [];
  let alive = true;
  const outcome = await gracefulClose({
    write: (d) => {
      writes.push(d);
      if (d === EXIT) alive = false;
    },
    isAlive: () => alive,
    kill: () => {
      throw new Error("should not kill");
    },
    delay: noDelay,
    isModal: () => false
  });
  expect(outcome).toBe("exit");
  expect(writes).toEqual([EXIT]);
});

// ----- P3: never dies on its own -- both sequences, in order, then ONE kill,
// bounded real wall-clock time (small real budgets + real setTimeout delay).

test("P3 -- a tile that never dies gets both escalation sequences in order, then exactly one kill(), within budget", async () => {
  const writes: string[] = [];
  let killed = 0;
  const started = Date.now();
  const outcome = await gracefulClose({
    write: (d) => writes.push(d),
    isAlive: () => true,
    kill: () => {
      killed++;
    },
    delay: (ms) => new Promise((res) => setTimeout(res, ms)),
    exitGraceMs: 40,
    interruptGraceMs: 40,
    pollMs: 10
  });
  const elapsedMs = Date.now() - started;
  expect(outcome).toBe("sigterm");
  expect(writes).toEqual([EXIT, ESC, CTRL_C, EXIT]);
  expect(killed).toBe(1);
  // Budget is 40+40=80ms of grace; generous real-clock ceiling to absorb CI
  // jitter without being able to pass on a design that silently reverted to
  // the OLD single-check-after-full-delay shape (that would still finish
  // near the same total, so this is a sanity bound, not the load-bearing
  // assertion -- the write-order + single-kill assertions above are).
  expect(elapsedMs).toBeLessThan(2000);
});

// ----- P4: write() throws -- filet (a) still kills -----

test("P4 -- a thrown write() still reaches kill() (filet a)", async () => {
  let killed = 0;
  const outcome = await gracefulClose({
    write: () => {
      throw new Error("pty already gone");
    },
    isAlive: () => true,
    kill: () => {
      killed++;
    },
    delay: noDelay
  });
  expect(outcome).toBe("sigterm");
  expect(killed).toBe(1);
});

// ----- P5: delay() never resolves -- ONLY the absolute-deadline timer (filet
// b) can save this; this is the probe that catches its absence, not a
// redundant one, since the escalation's own try/finally is permanently stuck
// awaiting that promise and never runs its own cleanup.

// Card 6c380073 (review round 2, point 6): this probe must FAIL, not HANG,
// when the net it exists to prove is absent -- a hanging probe proves nothing
// and blocks a CI job instead of reddening it.
//
// A per-test timeout does NOT achieve that here. MEASURED on bun 1.3.13 with
// the deadline net removed: `test(..., 5000)` still hung past 90s, printing
// only the banner. Isolated with a 5-line control (a bare
// `await new Promise(() => {})` under a 1000ms cap, no project code, no
// imports) -- it hangs identically, so bun's per-test timeout cannot
// interrupt an await on a promise that never settles and arms no timer.
//
// So the test races the call against a REAL timer itself and asserts on the
// winner. It therefore always settles, on any bun version, and a missing net
// reads as a legible `"HUNG"` instead of a stalled runner. The `}, 5000)` cap
// stays as a second net for any future shape that CAN be interrupted.
test("P5 -- delay() that never resolves is rescued ONLY by the absolute-deadline safety net", async () => {
  let killed = 0;
  let cleaned = 0;
  const outcome = await Promise.race([
    gracefulClose({
      write: () => {},
      isAlive: () => true, // never dies on its own
      kill: () => {
        killed++;
      },
      delay: () => new Promise(() => {}), // never resolves, ever
      absoluteDeadlineMs: 40,
      cleanup: () => {
        cleaned++;
      }
    }),
    new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 1000))
  ]);
  // "HUNG" here means the escalation never settled: the deadline net is gone.
  expect(outcome).toBe("deadline");
  expect(killed).toBe(1);
  expect(cleaned).toBe(1);
}, 5000);

// ----- P6: a second, concurrent close forces immediate exit -- exactly one
// '/exit' write total, never the second stage.

test("P6 -- isClosingForced() flipping true mid-escalation stops further writes and kills immediately", async () => {
  const writes: string[] = [];
  let killed = 0;
  let forced = false;
  const outcome = await gracefulClose({
    write: (d) => writes.push(d),
    isAlive: () => true, // never dies on its own -- only the forced flag ends this
    kill: () => {
      killed++;
    },
    // Flips true the first time the poll loop actually waits, simulating a
    // second remove() call landing while this escalation is mid-flight.
    delay: async () => {
      forced = true;
    },
    isClosingForced: () => forced
  });
  expect(outcome).toBe("forced");
  expect(writes).toEqual([EXIT]);
  expect(killed).toBe(1);
});

// ----- Residual (WEAK half, explicitly labeled): remove()'s own call site in
// session-service.ts is out of reach of a behavioral probe (SessionService
// isn't bun-test-importable). This is a SOURCE SCAN, not a behavioral proof:
// it only shows the escalation is wired and AWAITED and that the
// second-click state exists in scope -- it does NOT prove kill() is
// unreachable on the nominal path, nor that isModal/cleanup are wired
// correctly (only the behavioral probes above prove the FUNCTION's own
// logic). Per this repo's convention (tests/desktop-inject-command-modal-guard.test.ts),
// the checker itself is RED-proofed against synthetic bodies below so it
// cannot pass by never actually checking anything.

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

function extractRemoveBody(src: string): string {
  const fnMatch = /async remove\(id: string\): Promise<void> \{/.exec(src);
  if (!fnMatch) {
    throw new Error(
      "remove() not found in session-service.ts with its expected async signature -- has it been renamed, or reverted to sync?"
    );
  }
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
}

/**
 * WEAK by design (see the block comment above): only proves the escalation
 * is present, AWAITED (not fire-and-forget), that the second-click state
 * (`closingInFlight`) is referenced, and that the modal pre-check reads ALL
 * THREE of its signals. Does not, and cannot by source scan alone, prove
 * kill() is unreachable on any particular path.
 *
 * Card 6c380073 (review round 2, point 7): the three-signal half is here
 * because the COMPOSITION of the pre-check was guarded by nothing. Measured:
 * reducing the real predicate to `classify(id) === 'modal'` alone -- dropping
 * needsAttention and rateLimited -- left this file at 10 pass / 0 fail. P1
 * only exercises the isModal callback that the TEST injects, so it is blind
 * to which signals the production caller actually composes; only naming the
 * three here closes that.
 */
function removeIsWiredToEscalation(body: string): boolean {
  return (
    /await gracefulClose\(/.test(body) &&
    /closingInFlight/.test(body) &&
    /screenGuard\.classify\(id\) === 'modal'/.test(body) &&
    /needsAttention/.test(body) &&
    /rateLimited/.test(body)
  );
}

test("remove() awaits gracefulClose, holds the second-click state, and composes all three modal signals (real file)", () => {
  const body = extractRemoveBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  expect(removeIsWiredToEscalation(body)).toBe(true);
});

// RED-proof: the checker itself, against synthetic bodies -- immune to
// source drift in session-service.ts.

test("the checker REJECTS the pre-fix shape (bare pty.kill, no escalation, no second-click state)", () => {
  const oldBody = `
    const def = this.defs.find((d) => d.id === id)
    if (def) this.emit('removed', { id: def.id, name: def.name })
    if (def?.sessionId) this.registry.release(def.sessionId)
    this.pty.kill(id)
    this.thinkingDetector.clear(id)
    this.defs = this.defs.filter((d) => d.id !== id)
    this.runtime.delete(id)
    this.persist()
    this.broadcast()
  `;
  expect(removeIsWiredToEscalation(oldBody)).toBe(false);
});

test("the checker REJECTS a fire-and-forget call (gracefulClose present but not awaited)", () => {
  const notAwaited = `
    if (this.closingInFlight.has(id)) { return }
    this.closingInFlight.add(id)
    gracefulClose({ write: () => {}, isAlive: () => true, kill: () => {}, delay: async () => {} })
  `;
  expect(removeIsWiredToEscalation(notAwaited)).toBe(false);
});

// The full shape the checker must accept, reused by the three rejection
// probes below so each one differs from it by exactly ONE removed signal --
// otherwise a probe could go green for the wrong reason.
const WIRED_BODY = `
  if (this.closingInFlight.has(id)) { forceCleanup(); return }
  this.closingInFlight.add(id)
  try {
    const isModal = (): boolean =>
      this.screenGuard.classify(id) === 'modal' ||
      !!this.runtime.get(id)?.needsAttention ||
      !!this.runtime.get(id)?.rateLimited
    if (isModal()) { forceCleanup(); return }
    await gracefulClose({ write: () => {}, isAlive: () => true, kill: () => {}, delay: async () => {} })
  } finally {
    this.closingInFlight.delete(id)
  }
`;

test("the checker ACCEPTS the new shape (awaited gracefulClose + closingInFlight + all three modal signals)", () => {
  expect(removeIsWiredToEscalation(WIRED_BODY)).toBe(true);
});

// Card 6c380073 (review round 2, point 7): one probe per DROPPED signal.
// This is the exact mutation measured as leaving the whole file green before
// the checker was extended.

test("the checker REJECTS a modal pre-check reduced to the screen guard alone", () => {
  const screenOnly = WIRED_BODY.replace(/\|\|\s*!!this\.runtime\.get\(id\)\?\.needsAttention\s*\|\|\s*!!this\.runtime\.get\(id\)\?\.rateLimited/, "");
  expect(screenOnly).not.toContain("needsAttention");
  expect(removeIsWiredToEscalation(screenOnly)).toBe(false);
});

test("the checker REJECTS a modal pre-check that drops needsAttention only", () => {
  const noAttention = WIRED_BODY.replace("!!this.runtime.get(id)?.needsAttention ||", "");
  expect(noAttention).not.toContain("needsAttention");
  expect(removeIsWiredToEscalation(noAttention)).toBe(false);
});

test("the checker REJECTS a modal pre-check that drops rateLimited only", () => {
  const noRateLimit = WIRED_BODY.replace("||\n      !!this.runtime.get(id)?.rateLimited", "");
  expect(noRateLimit).not.toContain("rateLimited");
  expect(removeIsWiredToEscalation(noRateLimit)).toBe(false);
});
