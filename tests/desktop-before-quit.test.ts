import { expect, test } from "bun:test";
import { createBeforeQuitHandler } from "../desktop/src/main/before-quit.ts";

interface Harness {
  readonly handler: (preventDefault: () => void) => void;
  readonly ran: string[];
  readonly prevented: string[];
  readonly errors: { scope: string; message: string; error?: unknown }[];
  /** Both settle from their own sink, so no test counts microtask turns. */
  readonly quitted: Promise<void>;
  readonly reported: Promise<void>;
  quits: number;
  prevent: () => void;
}

function harness(opts: {
  release: () => Promise<unknown>;
  throwOn?: string;
  /** Stands in for Electron serving the quit the handler just asked for. */
  reenterOnQuit?: boolean;
  throwOnQuit?: boolean;
  /** Reports awaited before `reported` settles, for the passes that fail twice. */
  expectReports?: number;
}): Harness {
  const wantReports = opts.expectReports ?? 1;
  const ran: string[] = [];
  const prevented: string[] = [];
  const errors: { scope: string; message: string; error?: unknown }[] = [];
  let resolveQuit = (): void => {};
  let resolveReported = (): void => {};
  const h: Harness = {
    ran,
    prevented,
    errors,
    quits: 0,
    quitted: new Promise<void>((resolve) => {
      resolveQuit = resolve;
    }),
    reported: new Promise<void>((resolve) => {
      resolveReported = resolve;
    }),
    prevent: () => prevented.push(`pass ${prevented.length + 1}`),
    handler: createBeforeQuitHandler({
      effects: ["alpha", "beta", "gamma"].map((label) => ({
        label,
        run: () => {
          ran.push(label);
          if (label === opts.throwOn) throw new Error(`${label} exploded`);
        }
      })),
      release: opts.release,
      quit: () => {
        h.quits += 1;
        resolveQuit();
        if (opts.reenterOnQuit) h.handler(h.prevent);
        if (opts.throwOnQuit) throw new Error("quit exploded");
      },
      onError: (scope, message, error) => {
        errors.push({ scope, message, error });
        if (errors.length >= wantReports) resolveReported();
      }
    })
  };
  return h;
}

/** A release the test settles by hand, standing in for the 10 s release cap. */
function pendingRelease(): { release: () => Promise<string>; settle: () => void } {
  let settle = (): void => {};
  const pending = new Promise<string>((resolve) => {
    settle = () => resolve("expired");
  });
  return { release: () => pending, settle };
}

test("the first pass prevents the default quit, runs every effect once and quits itself", async () => {
  const h = harness({ release: async () => "idle" });
  h.handler(h.prevent);
  await h.quitted;

  expect(h.prevented, "the handler must cancel the quit it is going to call back").toEqual([
    "pass 1"
  ]);
  expect(h.ran, "every effect runs, once, in order").toEqual(["alpha", "beta", "gamma"]);
  expect(h.quits, "the cancelled quit must be called back").toBe(1);
  expect(h.errors, "a clean pass reports nothing").toEqual([]);
});

test("a re-entrant pass is cancelled while the release is pending and let through once quit has run", async () => {
  const { release, settle } = pendingRelease();
  const h = harness({ release });

  h.handler(h.prevent);
  h.handler(h.prevent);
  expect(
    h.prevented,
    "an operator who commands Quit again during the release must NOT get the default quit: it would overtake the release and strand the lease"
  ).toEqual(["pass 1", "pass 2"]);
  expect(h.ran, "a re-entrant pass must not replay the effects").toEqual([
    "alpha",
    "beta",
    "gamma"
  ]);
  expect(h.quits, "nothing quits while the release is pending").toBe(0);

  settle();
  await h.quitted;
  expect(h.quits, "the settled release quits").toBe(1);

  h.handler(h.prevent);
  expect(
    h.prevented,
    "the pass that quit() itself triggers must be let through, or the app never closes"
  ).toEqual(["pass 1", "pass 2"]);
  expect(h.ran, "the let-through pass must not replay the effects either").toEqual([
    "alpha",
    "beta",
    "gamma"
  ]);
  expect(h.quits, "the let-through pass must not re-enter the sequence").toBe(1);
});

test("a rejected release is reported and still quits", async () => {
  const boom = new Error("release rejected");
  const h = harness({ release: () => Promise.reject(boom) });
  h.handler(h.prevent);
  await Promise.all([h.quitted, h.reported]);

  expect(h.ran, "a doomed release does not skip the effects").toEqual(["alpha", "beta", "gamma"]);
  expect(h.quits, "a release that cannot finish must never hold the app open").toBe(1);
  expect(
    h.errors.map((e) => e.error),
    "the rejection reaches the error sink"
  ).toEqual([boom]);
});

test("quit waits for the release to settle, and the effects have already run", async () => {
  const { release, settle } = pendingRelease();
  const h = harness({ release });
  h.handler(h.prevent);

  expect(h.ran, "the effects do not wait on the release").toEqual(["alpha", "beta", "gamma"]);
  expect(h.quits, "the quit waits on the release").toBe(0);

  settle();
  await h.quitted;
  expect(h.quits, "settling the release is what quits").toBe(1);
});

test("an effect that throws is reported, the later effects still run and the app still quits", async () => {
  const h = harness({ release: async () => "done", throwOn: "beta" });
  h.handler(h.prevent);
  await Promise.all([h.quitted, h.reported]);

  expect(h.prevented, "the quit is already cancelled when the effect throws").toEqual(["pass 1"]);
  expect(h.ran, "a throwing effect must not skip the effects after it").toEqual([
    "alpha",
    "beta",
    "gamma"
  ]);
  expect(h.errors.length, "the throw reaches the error sink exactly once").toBe(1);
  expect(h.errors[0]?.message, "the trace names the failing effect").toContain("beta");
  expect((h.errors[0]?.error as Error).message, "the trace carries the cause").toBe(
    "beta exploded"
  );
  expect(
    h.quits,
    "a throw must not strand the app running with no window and the lease still held"
  ).toBe(1);
});

test("the latch opens before the quit call, so the pass served in answer is not cancelled", async () => {
  const h = harness({ release: async () => "idle", reenterOnQuit: true });
  h.handler(h.prevent);
  await h.quitted;

  expect(
    h.prevented,
    "the pass that quit() itself triggers must find the latch already open: cancelling it cancels the only exit the handler has left, and the app never closes"
  ).toEqual(["pass 1"]);
  expect(h.quits, "the pass quit() triggers must not ask to quit a second time").toBe(1);
  expect(h.ran, "nor replay the effects").toEqual(["alpha", "beta", "gamma"]);
  expect(h.errors, "that pass reports nothing").toEqual([]);
});

test("a quit that throws and a release that rejects are reported apart", async () => {
  const boom = new Error("release rejected");
  const h = harness({
    release: () => Promise.reject(boom),
    throwOnQuit: true,
    expectReports: 2
  });
  h.handler(h.prevent);
  await h.quitted;
  await Promise.race([h.reported, new Promise<void>((resolve) => setTimeout(resolve, 200))]);

  expect(h.quits, "the exit is attempted even though the release rejected").toBe(1);
  expect(
    h.errors.length,
    "both failures must be reported: a throwing quit folded into the release rejection loses one of the two traces"
  ).toBe(2);
  expect(
    new Set(h.errors.map((e) => e.message)).size,
    "the failing exit and the failing release must not share one message, or the trace names the release while the exit is what broke"
  ).toBe(2);
  expect(
    h.errors.map((e) => (e.error as Error).message).sort(),
    "each report carries its own cause"
  ).toEqual(["quit exploded", "release rejected"]);
});
