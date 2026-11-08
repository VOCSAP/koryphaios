import { afterEach, describe, expect, test } from "bun:test";
import { guardedInterval, type TimerLog } from "../shared/guarded-interval.ts";

const TICK_MS = 5;

interface Trace extends TimerLog {
  warnings: string[];
  errors: Array<{ message: string; error: unknown }>;
}

function trace(): Trace {
  const t: Trace = {
    warnings: [],
    errors: [],
    warn: (message) => {
      t.warnings.push(message);
    },
    error: (message, error) => {
      t.errors.push({ message, error });
    },
  };
  return t;
}

async function until(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(TICK_MS);
  }
}

const timers: Array<ReturnType<typeof setInterval>> = [];
const start = (...args: Parameters<typeof guardedInterval>): void => {
  timers.push(guardedInterval(...args));
};
afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
});

describe("guardedInterval", () => {
  test("a synchronous exception is traced with the timer name and the next tick still runs", async () => {
    const log = trace();
    let calls = 0;
    start("sync-boom", () => {
      calls += 1;
      throw new Error("sync boom");
    }, TICK_MS, log);

    await until(() => calls >= 3 && log.errors.length >= 3, "three failing ticks");
    expect(log.errors[0]?.message).toBe("timer sync-boom: iteration failed (skipped)");
    expect((log.errors[0]?.error as Error).message).toBe("sync boom");
    expect(log.warnings, "a synchronous failure never reads as an overlap").toEqual([]);
  });

  test("a rejected promise is traced, raises no unhandledRejection and frees the next tick", async () => {
    const log = trace();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      start("async-boom", () => Promise.reject(new Error("async boom")), TICK_MS, log);
      await until(() => log.errors.length >= 3, "three rejected passes");
      await Bun.sleep(4 * TICK_MS);
      expect(log.errors[0]?.message).toBe("timer async-boom: iteration failed (skipped)");
      expect((log.errors[0]?.error as Error).message).toBe("async boom");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a tick during a running pass is skipped and traced, and the next tick after the pass runs again", async () => {
    const log = trace();
    let calls = 0;
    let release: () => void = () => undefined;
    const pass = (): Promise<void> => {
      calls += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    start("slow-pass", pass, TICK_MS, log);

    await until(() => log.warnings.length >= 2, "two skipped ticks");
    expect(calls, "no second pass beside the running one").toBe(1);
    expect(log.warnings[0]).toBe("timer slow-pass: previous pass still running, tick skipped");

    release();
    await until(() => calls >= 2, "the first tick after the pass");
    release();
  });

  test("a synchronous pass is never mistaken for a running one", async () => {
    const log = trace();
    let calls = 0;
    start("sync-ok", () => {
      calls += 1;
    }, TICK_MS, log);

    await until(() => calls >= 4, "four ticks");
    expect({ warnings: log.warnings, errors: log.errors }).toEqual({ warnings: [], errors: [] });
  });
});
