import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gracefulClose } from "../desktop/src/main/session-close.ts";
import { extractBracedBody } from "./_braced-body";

const EXIT = "/exit\n";
const ESC = "\x1b";
const CTRL_C = "\x03";
const noDelay = (): Promise<void> => Promise.resolve();

test("a modal screen kills without PTY writes", async () => {
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

test("a session exiting after /exit is not killed", async () => {
  const writes: string[] = [];
  let alive = true;
  let isModalCalls = 0;
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
    isModal: () => {
      isModalCalls++;
      return false;
    }
  });
  expect(outcome).toBe("exit");
  expect(writes).toEqual([EXIT]);
  expect(isModalCalls).toBe(1);
});

test("a live session receives the exit and interrupt sequence before one kill", async () => {
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
  expect(elapsedMs).toBeLessThan(2000);
});

test("a screen that becomes modal after /exit receives no deferred bytes", async () => {
  const writes: string[] = [];
  let modal = false;
  let killed = 0;
  const outcome = await gracefulClose({
    write: (data) => writes.push(data),
    isAlive: () => true,
    kill: () => {
      killed++;
    },
    delay: async () => {
      modal = true;
    },
    isModal: () => modal,
    exitGraceMs: 1,
    interruptGraceMs: 1,
    pollMs: 1
  });

  expect(outcome).toBe("modal");
  expect(writes).toEqual([EXIT]);
  expect(killed).toBe(1);
});

test("a write failure forces a kill", async () => {
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

test("an unresolved delay reaches the absolute deadline", async () => {
  let killed = 0;
  let cleaned = 0;
  const outcome = await Promise.race([
    gracefulClose({
      write: () => {},
      isAlive: () => true,
      kill: () => {
        killed++;
      },
      delay: () => new Promise(() => {}),
      absoluteDeadlineMs: 40,
      cleanup: () => {
        cleaned++;
      }
    }),
    new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 1000))
  ]);
  expect(outcome).toBe("deadline");
  expect(killed).toBe(1);
  expect(cleaned).toBe(1);
}, 5000);

test("a forced close stops deferred writes and kills the PTY", async () => {
  const writes: string[] = [];
  let killed = 0;
  let forced = false;
  const outcome = await gracefulClose({
    write: (d) => writes.push(d),
    isAlive: () => true,
    kill: () => {
      killed++;
    },
    delay: async () => {
      forced = true;
    },
    isClosingForced: () => forced
  });
  expect(outcome).toBe("forced");
  expect(writes).toEqual([EXIT]);
  expect(killed).toBe(1);
});

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

function removeIsWiredToEscalation(body: string): boolean {
  return (
    /await gracefulClose\(/.test(body) &&
    /closingInFlight/.test(body) &&
    /screenGuard\.read\(id\)/.test(body) &&
    /screen\.status === 'unavailable'/.test(body) &&
    /classifyInjectGuard\(screen\.snapshot\) === 'modal'/.test(body) &&
    /needsAttention/.test(body) &&
    /rateLimited/.test(body)
  );
}

test("remove waits for closing while all modal signals are present", () => {
  const body = extractRemoveBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  expect(removeIsWiredToEscalation(body)).toBe(true);
});

test("the remove wiring check rejects a bare PTY kill", () => {
  const bareKillBody = `
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
  expect(removeIsWiredToEscalation(bareKillBody)).toBe(false);
});

test("the remove wiring check requires awaiting gracefulClose", () => {
  const notAwaited = `
    if (this.closingInFlight.has(id)) { return }
    this.closingInFlight.add(id)
    gracefulClose({ write: () => {}, isAlive: () => true, kill: () => {}, delay: async () => {} })
  `;
  expect(removeIsWiredToEscalation(notAwaited)).toBe(false);
});

const CLOSING_BODY = `
  if (this.closingInFlight.has(id)) { forceCleanup(); return }
  this.closingInFlight.add(id)
  try {
    const isModal = (): boolean => {
      const screen = this.screenGuard.read(id)
      if (screen.status === 'unavailable') return true
      return (
        classifyInjectGuard(screen.snapshot) === 'modal' ||
        !!this.runtime.get(id)?.needsAttention ||
        !!this.runtime.get(id)?.rateLimited
      )
    }
    if (isModal()) { forceCleanup(); return }
    await gracefulClose({ write: () => {}, isAlive: () => true, kill: () => {}, delay: async () => {} })
  } finally {
    this.closingInFlight.delete(id)
  }
`;

test("the remove wiring check accepts awaited closing with all modal signals", () => {
  expect(removeIsWiredToEscalation(CLOSING_BODY)).toBe(true);
});

test("the remove wiring check requires attention and rate-limit signals", () => {
  const screenOnly = CLOSING_BODY.replace(/\|\|\s*!!this\.runtime\.get\(id\)\?\.needsAttention\s*\|\|\s*!!this\.runtime\.get\(id\)\?\.rateLimited/, "");
  expect(screenOnly).not.toContain("needsAttention");
  expect(removeIsWiredToEscalation(screenOnly)).toBe(false);
});

test("the remove wiring check requires the attention signal", () => {
  const noAttention = CLOSING_BODY.replace("!!this.runtime.get(id)?.needsAttention ||", "");
  expect(noAttention).not.toContain("needsAttention");
  expect(removeIsWiredToEscalation(noAttention)).toBe(false);
});

test("the remove wiring check requires the rate-limit signal", () => {
  const noRateLimit = CLOSING_BODY.replace(/\|\|\s*!!this\.runtime\.get\(id\)\?\.rateLimited/, "");
  expect(noRateLimit).not.toContain("rateLimited");
  expect(removeIsWiredToEscalation(noRateLimit)).toBe(false);
});
