// Proves the new options (isModal, isClosingForced, cleanup,
// absoluteDeadlineMs) that remove() now supplies, against the real
// gracefulClose.
// The actual call site inside remove() is verified only by a source scan below,
// since SessionService isn't bun-test-importable.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gracefulClose } from "../desktop/src/main/session-close.ts";
import { extractBracedBody } from "./_braced-body";

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

// A per-test timeout does not rescue a promise that never settles and arms no
// timer -- measured to hang past 90s regardless.
// The test races the call against its own timer and asserts the winner, so a
// missing safety net reads as HUNG instead of stalling the runner.
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

// Source scan only, since SessionService isn't bun-test-importable: proves the
// escalation is wired and awaited and the second-click state is referenced, but
// not that kill() is unreachable on the nominal path.

const SESSION_SERVICE_PATH = join(
  import.meta.dir,
  "..",
  "desktop",
  "src",
  "main",
  "session-service.ts"
);


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
 * Weak by design (source scan only): proves the escalation call is present,
 * awaited, and that the modal pre-check reads all three signals (isModal,
 * needsAttention, rateLimited) -- not that kill() is unreachable on any given
 * path.
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
