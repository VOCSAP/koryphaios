import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBeforeQuitHandler } from "../desktop/src/main/before-quit.ts";
import { SERVE_QUIT_DEADLINE_MS } from "../desktop/src/main/serve-lifecycle.ts";

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

function hasBoundedApprovalClose(source: string): boolean {
  return source.includes("{ label: 'approvals', timeoutMs: 2_000, run: () => approvals.close() }");
}

interface ServeShutdownDeps {
  serve: { quit(options: { deadlineMs?: number }): Promise<void> }
  sessionDir: { close(): void }
  removeSessionStateDir: (dir: string, groupId: string, report: unknown) => void
  appStateDir: () => string
  activeScope: { groupId: string }
  reportSessionState: unknown
  SERVE_QUIT_DEADLINE_MS: number
}

function readIndex(): string {
  return readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
}

function extractServeShutdown(source: string): (deps: ServeShutdownDeps) => Promise<void> {
  const match = /label: 'serve',\s*timeoutMs: 16_000,\s*run: async \(\) => \{([\s\S]*?)\n      \}/.exec(source)
  if (!match) throw new Error('missing Serve shutdown effect')
  return new Function(
    'deps',
    `const { serve, sessionDir, removeSessionStateDir, appStateDir, activeScope, reportSessionState, SERVE_QUIT_DEADLINE_MS } = deps; return (async () => {${match[1]!}})()`
  ) as (deps: ServeShutdownDeps) => Promise<void>
}

/** Names every mention of `name` by its enclosing top-level declaration, so a call, an alias or a helper anywhere in the file shows up. */
function referenceSites(source: string, name: string): string[] {
  const lines = source.split(/\r?\n/)
  const mention = new RegExp(`\\b${name}\\b`, 'g')
  const sites: string[] = []
  lines.forEach((line, index) => {
    const hits = line.match(mention)?.length ?? 0
    let top = index
    while (top > 0 && !/^[A-Za-z]/.test(lines[top]!)) top--
    const declaration = /^(?:export\s+)?(?:import|const|let|var|function|async function|class)\b[^=({:]*/.exec(lines[top]!)?.[0].trim() ?? lines[top]!
    for (let hit = 0; hit < hits; hit++) sites.push(declaration)
  })
  return sites
}

function serveShutdownDeps(order: string[], quit: (options: { deadlineMs?: number }) => Promise<void>): ServeShutdownDeps {
  return {
    serve: { quit },
    sessionDir: { close: () => order.push('session dir closed') },
    removeSessionStateDir: () => order.push('session state removed'),
    appStateDir: () => 'C:/state',
    activeScope: { groupId: 'group' },
    reportSessionState: undefined,
    SERVE_QUIT_DEADLINE_MS
  }
}

test("the main process bounds and awaits approval revocation at quit", () => {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
  expect(hasBoundedApprovalClose(source)).toBe(true);
  expect(hasBoundedApprovalClose(source.replace("run: () => approvals.close()", "run: () => void approvals.close()"))).toBe(false);
});

test("Serve shutdown closes the session dir, quits Serve under its deadline, then removes the session state", async () => {
  const run = extractServeShutdown(readIndex())
  const order: string[] = []
  const deadlines: Array<number | undefined> = []
  let releaseQuit = (): void => {}
  const quitted = new Promise<void>((resolve) => {
    releaseQuit = () => {
      order.push('serve quitted')
      resolve()
    }
  })

  const pending = run(serveShutdownDeps(order, (options) => {
    deadlines.push(options.deadlineMs)
    return quitted
  }))
  expect(order).toEqual(['session dir closed'])
  releaseQuit()
  await pending

  expect(order).toEqual(['session dir closed', 'serve quitted', 'session state removed'])
  expect(deadlines).toEqual([SERVE_QUIT_DEADLINE_MS])
});

test("Serve shutdown removes the session state even when the Serve quit rejects", async () => {
  const run = extractServeShutdown(readIndex())
  const order: string[] = []
  const failure = new Error('serve quit failed')

  await expect(run(serveShutdownDeps(order, () => Promise.reject(failure)))).rejects.toBe(failure)

  expect(order).toEqual(['session dir closed', 'session state removed'])
});

test("exactly one quit effect removes the session state dir", () => {
  expect(
    referenceSites(readIndex(), 'removeSessionStateDir'),
    'removeSessionStateDir must appear exactly at: its import, the group switch in adoptScope, and the serve quit effect in runBeforeQuit'
  ).toEqual(['import', 'const adoptScope', 'const runBeforeQuit'])
});

test("the Serve quit deadline expires before the quit effect bound", () => {
  expect(SERVE_QUIT_DEADLINE_MS).toBeLessThan(16_000)
});

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

test("quit waits for an approval revocation effect before exiting", async () => {
  let settleRevocation = (): void => {};
  const revoked = new Promise<void>((resolve) => {
    settleRevocation = resolve;
  });
  let quit = false;
  let resolveQuit = (): void => {};
  const quitted = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });
  const handler = createBeforeQuitHandler({
    effects: [{ label: "approvals", run: () => revoked }],
    release: async () => undefined,
    quit: () => {
      quit = true;
      resolveQuit();
    },
    onError: () => {},
  });

  handler(() => {});
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(quit).toBe(false);

  settleRevocation();
  await quitted;
  expect(quit).toBe(true);
});

test("an approval revocation timeout is reported before quit", async () => {
  const timeoutMs = 20;
  const errors: { message: string; error?: unknown }[] = [];
  let resolveQuit = (): void => {};
  const quitted = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });
  const handler = createBeforeQuitHandler({
    effects: [{ label: "approvals", timeoutMs, run: () => new Promise<void>(() => {}) }],
    release: async () => undefined,
    quit: resolveQuit,
    onError: (_scope, message, error) => errors.push({ message, error }),
  });

  const startedAt = performance.now();
  handler(() => {});
  await quitted;

  expect(performance.now() - startedAt).toBeLessThan(timeoutMs * 10);
  expect(errors).toEqual([
    expect.objectContaining({ message: "quit effect failed: approvals", error: expect.any(Error) }),
  ]);
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
