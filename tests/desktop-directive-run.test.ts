import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as directiveRun from "../desktop/src/main/directive-run";
import {
  createDirectiveBindings,
  createRunDirectiveAdapter,
  executeDirectiveItem,
  parseRunDirectiveArgs,
  runClearReloadInTurn,
  runDirectiveForCaller,
  runDirectiveOn,
  sanitizeDirectivePrompt,
  DIRECTIVE_PROMPT_MAX,
  type ClearReloadHost,
  type DirectiveRunDeps
} from "../desktop/src/main/directive-run";
import {
  ContextResumeUnsupportedError,
  contextTransactionFields,
  readContextTransactionResponse,
  requireContextResumeSupport
} from "../desktop/src/main/broker-client";
import { DIRECTIVE_ACCEPTS_PROMPT, directiveCommands, isDirectiveCommand } from "../desktop/src/main/directive";
import { TOOLS } from "../server.ts";
import { extractBracedBody } from "./_braced-body";
import type { RoadmapDirective, SessionRuntime } from "../desktop/src/shared/types";

function session(id: string, peerId: string | null, status: SessionRuntime["status"] = "running"): SessionRuntime {
  return {
    id,
    name: id,
    cwd: "/proj",
    command: "",
    args: "",
    sessionId: `sid-${id}`,
    color: "#fff",
    createdAt: 0,
    status,
    exitCode: null,
    pid: 1,
    peerId,
    activity: "idle",
    expired: false,
    rateLimited: false,
    resumeAt: null
  } as SessionRuntime;
}

interface Recorder {
  deps: DirectiveRunDeps;
  journal: string[];
  typed: { tileId: string; keys: string }[];
  magic: { tileId: string; peerId: string; useMagic: boolean; mode: string }[];
  clearReload: { tileId: string; peerId: string; workstream: string; contextDepositId?: string }[];
  errors: { message: string; error: unknown }[];
  settle: () => Promise<void>;
}

function recorder(sessions: SessionRuntime[]): Recorder {
  const journal: string[] = [];
  const typed: { tileId: string; keys: string }[] = [];
  const magic: { tileId: string; peerId: string; useMagic: boolean; mode: string }[] = [];
  const clearReload: { tileId: string; peerId: string; workstream: string; contextDepositId?: string }[] = [];
  const errors: { message: string; error: unknown }[] = [];
  const pending: Promise<unknown>[] = [];
  const deps: DirectiveRunDeps = {
    listSessions: () => sessions,
    injectCommand: (tileId, keys) => {
      typed.push({ tileId, keys });
      const p = Promise.resolve("written" as const);
      pending.push(p);
      return p;
    },
    runMagicCompact: (tileId, peerId, useMagic, mode) => {
      magic.push({ tileId, peerId, useMagic, mode });
      return Promise.resolve("written" as const);
    },
    runClearReload: (tileId, peerId, workstream, contextDepositId) => {
      clearReload.push({ tileId, peerId, workstream, ...(contextDepositId ? { contextDepositId } : {}) });
      return Promise.resolve("written" as const);
    },
    resolveMagic: () => ({ useMagic: true, mode: "auto" }),
    journal: (line) => journal.push(line),
    reportError: (message, error) => errors.push({ message, error })
  };
  return {
    deps,
    journal,
    typed,
    magic,
    clearReload,
    errors,
    settle: async () => {
      await Promise.all(pending);
      await new Promise((r) => setTimeout(r, 0));
    }
  };
}

const LIVE = () => [
  session("t1", "alpha"),
  session("t2", "beta"),
  session("t3", "twin"),
  session("t4", "twin"),
  session("t5", "gone", "exited")
];

test("a directive card and deck_run_directive reach the same targets for every directive", async () => {
  const ids = ["alpha", "twin", "gone"];
  for (const directive of directiveCommands().filter((directive) => directive !== "clear_reload")) {
    const card = recorder(LIVE());
    const cardResult = await executeDirectiveItem(
      { id: "card-1", title: "reset the team", directive, target_peer_ids: ids },
      card.deps
    );
    await card.settle();

    const tool = recorder(LIVE());
    const toolResult = await runDirectiveForCaller(directive, ids, undefined, "team-lead-ab12", tool.deps);
    await tool.settle();

    expect(tool.journal.filter((line) => line.includes(" -> ")), directive).toEqual(
      card.journal.filter((line) => line.includes(" -> "))
    );
    expect(tool.typed, directive).toEqual(card.typed);
    expect(tool.magic, directive).toEqual(card.magic);
    expect(toolResult, directive).toEqual({
      injected: cardResult.injected,
      pending: [],
      refused: [],
      unreached: cardResult.unreached
    });
  }
});

test("magic_compact reports the outcome of its sequence like any other directive", async () => {
  const written = recorder([session("t1", "alpha")]);
  expect(await runDirectiveForCaller("magic_compact", ["alpha"], undefined, "lead", written.deps, { reportWaitMs: 500 })).toEqual({
    injected: [{ tileId: "t1", peerId: "alpha" }],
    refused: [],
    pending: [],
    unreached: []
  });

  const refused = recorder([session("t1", "alpha")]);
  refused.deps.runMagicCompact = () => Promise.resolve("refused-modal" as const);
  expect(await runDirectiveForCaller("magic_compact", ["alpha"], undefined, "lead", refused.deps, { reportWaitMs: 500 })).toEqual({
    injected: [],
    refused: [{ tileId: "t1", peerId: "alpha", reason: "refused-modal" }],
    pending: [],
    unreached: []
  });

  const failed = recorder([session("t1", "alpha")]);
  failed.deps.runMagicCompact = () => Promise.reject(new Error("pty gone"));
  expect(await runDirectiveForCaller("magic_compact", ["alpha"], undefined, "lead", failed.deps, { reportWaitMs: 500 })).toEqual({
    injected: [],
    refused: [{ tileId: "t1", peerId: "alpha", reason: "error" }],
    pending: [],
    unreached: []
  });
  expect(failed.errors.map((e) => e.message)).toEqual(['magic_compact failed for "alpha"']);

  const slow = recorder([session("t1", "alpha")]);
  slow.deps.runMagicCompact = () => new Promise(() => {});
  expect(
    await runDirectiveForCaller("magic_compact", ["alpha"], undefined, "lead", slow.deps, { reportWaitMs: 20 })
  ).toEqual({ injected: [], refused: [], pending: [{ tileId: "t1", peerId: "alpha" }], unreached: [] });
});

test("clear_reload serializes clear then the fixed recovery order", async () => {
  const typed: string[] = [];
  const journal: string[] = [];
  const outcome = await runClearReloadInTurn(
    { serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }) },
    (line) => journal.push(line),
    "tile-1",
    "lead-a1b2",
    "night-shift"
  );

  expect(outcome).toBe("written");
  expect(typed).toEqual([
    "/clear",
    'Reprends le workstream "night-shift". D’abord, appelle handoffs_latest(project, workstream) avec project et workstream="night-shift". Ensuite, appelle check_messages et lis tous les messages reçus. Seulement après ces deux étapes, appelle send_message. Retrouve dans le handoff la prochaine tâche puis exécute-la.'
  ]);
  expect(journal).toEqual(['clear_reload -> "lead-a1b2": written']);
});

test("internal context deposit id reaches clear_reload without widening MCP arguments", async () => {
  const recorded = recorder([session("tile-1", "alpha")]);

  await runDirectiveForCaller("clear_reload", ["alpha"], "night-shift", "lead", recorded.deps, {
    contextDepositId: "deposit-1",
    reportWaitMs: 500
  });

  expect(recorded.clearReload).toEqual([
    { tileId: "tile-1", peerId: "alpha", workstream: "night-shift", contextDepositId: "deposit-1" }
  ]);
});

test("context clear reserves, observes a new clear rotation, then releases without a recovery injection", async () => {
  const typed: string[] = [];
  const events: string[] = [];
  const errors: unknown[] = [];
  const outcome = await runClearReloadInTurn(
    {
      serializeTile: (_id, fn) => fn(async (keys) => {
        typed.push(keys);
        events.push(`inject:${keys}`);
        return "written" as const;
      }),
      checkOperatorTrust: async () => "compatible" as const,
      checkContextResumeSupport: async () => {},
      currentSessionId: () => "sid-before",
      reserveContextDeposit: async (depositId, peerId) => {
        events.push(`reserve:${depositId}:${peerId}`);
        return "attempt-1";
      },
      readClearBackchannelBaseline: () => {
        events.push("baseline");
        return "previous-clear";
      },
      waitForClearBackchannel: async (tileId, sessionId, baselineSessionId) => {
        events.push(`wait:${tileId}:${sessionId}:${baselineSessionId}`);
      },
      releaseContextDeposit: async (depositId, attemptId) => {
        events.push(`release:${depositId}:${attemptId}`);
        return "sent" as const;
      },
      reportError: (_message, error) => errors.push(error)
    },
    () => {},
    "tile-1",
    "lead-a1b2",
    "night-shift",
    undefined,
    { contextDepositId: "deposit-1" }
  );

  expect(outcome).toBe("written");
  expect(typed).toEqual(["/clear"]);
  expect(events).toEqual([
    "reserve:deposit-1:lead-a1b2",
    "baseline",
    "inject:/clear",
    "wait:tile-1:sid-before:previous-clear",
    "release:deposit-1:attempt-1"
  ]);
  expect(errors).toEqual([]);
});

test("context clear rejects a host missing the baseline reader before reservation", async () => {
  let reservations = 0;

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async () => "written" as const),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => {
          reservations += 1;
          return "attempt-1";
        },
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => {}
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toThrow("context clear host is incomplete");

  expect(reservations).toBe(0);
});

test("context clear reports a refused /clear and releases its reservation", async () => {
  const releases: string[] = [];
  const errors: { message: string; error: unknown }[] = [];
  const outcome = await runClearReloadInTurn(
    {
      serializeTile: (_id, fn) => fn(async () => "busy-timeout" as const),
      checkOperatorTrust: async () => "compatible" as const,
      checkContextResumeSupport: async () => {},
      currentSessionId: () => "sid-before",
      reserveContextDeposit: async () => "attempt-1",
      readClearBackchannelBaseline: () => "prior-clear",
      waitForClearBackchannel: async () => { throw new Error("must not wait after refused clear"); },
      releaseContextDeposit: async (depositId, attemptId) => { releases.push(`${depositId}:${attemptId}`); },
      reportError: (message, error) => errors.push({ message, error })
    },
    () => {},
    "tile-1",
    "lead-a1b2",
    "night-shift",
    undefined,
    { contextDepositId: "deposit-1" }
  );

  expect(outcome).toBe("busy-timeout");
  expect(releases).toEqual(["deposit-1:attempt-1"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toContain("busy-timeout");
});

test("context clear releases after a rotation wait fails and reports the failure", async () => {
  const releases: string[] = [];
  const failure = new Error("clear rotation timed out");
  const errors: { message: string; error: unknown }[] = [];

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async () => "written" as const),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => "attempt-1",
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => { throw failure; },
        releaseContextDeposit: async (depositId, attemptId) => { releases.push(`${depositId}:${attemptId}`); },
        reportError: (message, error) => errors.push({ message, error })
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toBe(failure);

  expect(releases).toEqual(["deposit-1:attempt-1"]);
  expect(errors).toEqual([{ message: 'context clear failed for "lead-a1b2"', error: failure }]);
});

test("context clear releases after an injection error and reports the failure", async () => {
  const releases: string[] = [];
  const failure = new Error("pty write failed");
  const errors: { message: string; error: unknown }[] = [];

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async () => { throw failure; }),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => "attempt-1",
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async (depositId, attemptId) => { releases.push(`${depositId}:${attemptId}`); },
        reportError: (message, error) => errors.push({ message, error })
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toBe(failure);

  expect(releases).toEqual(["deposit-1:attempt-1"]);
  expect(errors).toEqual([{ message: 'context clear failed for "lead-a1b2"', error: failure }]);
});

test("context clear reports a reservation refusal before injecting /clear", async () => {
  const typed: string[] = [];
  const failure = new Error("context transaction returned 409");
  const errors: { message: string; error: unknown }[] = [];

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => { throw failure; },
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => {},
        reportError: (message, error) => errors.push({ message, error })
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toBe(failure);

  expect(typed).toEqual([]);
  expect(errors).toEqual([{ message: 'context clear failed for "lead-a1b2"', error: failure }]);
});

test("context clear reports a release refusal after a verified rotation", async () => {
  const failure = new Error("context transaction returned 409");
  const errors: { message: string; error: unknown }[] = [];

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async () => "written" as const),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => "attempt-1",
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => { throw failure; },
        reportError: (message, error) => errors.push({ message, error })
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toBe(failure);

  expect(errors).toEqual([{ message: 'context resume status unknown for "lead-a1b2"', error: failure }]);
});

test("context clear checks operator trust before reserving the deposit", async () => {
  const events: string[] = [];
  const outcome = await runClearReloadInTurn(
    {
      serializeTile: (_id, fn) => fn(async (keys) => {
        events.push(`inject:${keys}`);
        return "written" as const;
      }),
      checkOperatorTrust: async () => {
        events.push("trust");
        return "compatible" as const;
      },
      checkContextResumeSupport: async () => {
        events.push("support");
      },
      currentSessionId: () => {
        events.push("session");
        return "sid-before";
      },
      reserveContextDeposit: async () => {
        events.push("reserve");
        return "attempt-1";
      },
      readClearBackchannelBaseline: () => null,
      waitForClearBackchannel: async () => {},
      releaseContextDeposit: async () => {
        events.push("release");
      }
    },
    () => {},
    "tile-1",
    "lead-a1b2",
    "night-shift",
    undefined,
    { contextDepositId: "deposit-1" }
  );

  expect(outcome).toBe("written");
  expect(events).toEqual(["trust", "support", "session", "reserve", "inject:/clear", "release"]);
});

test("context clear neither reserves nor types /clear when the broker does not serve context resume", async () => {
  const typed: string[] = [];
  const events: string[] = [];
  const failure = new Error("broker does not serve context resume");
  const errors: { message: string; error: unknown }[] = [];

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => { throw failure; },
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => {
          events.push("reserve");
          return "attempt-1";
        },
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => {
          events.push("release");
        },
        reportError: (message, error) => errors.push({ message, error })
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toBe(failure);

  expect(events).toEqual([]);
  expect(typed).toEqual([]);
  expect(errors).toEqual([{ message: 'context clear failed for "lead-a1b2"', error: failure }]);
});

test("context clear rejects a host missing the context resume support check before reservation", async () => {
  let reservations = 0;
  const typed: string[] = [];

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
        checkOperatorTrust: async () => "compatible" as const,
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => {
          reservations += 1;
          return "attempt-1";
        },
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => {}
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toThrow("context clear host is incomplete");

  expect(reservations).toBe(0);
  expect(typed).toEqual([]);
});

test("context clear refuses a reservation the broker names as owner_lacks_context_resume and types nothing", async () => {
  const typed: string[] = [];
  const releases: boolean[] = [];
  const failure = new Error("context transaction reserve refused: owner_lacks_context_resume");

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => { throw failure; },
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async (_depositId, _attemptId, cleared) => { releases.push(cleared); },
        reportError: () => {}
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toBe(failure);

  expect(typed).toEqual([]);
  expect(releases).toEqual([]);
});

function healthFetch(respond: () => Response | Promise<Response>, urls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    urls.push(String(input));
    return respond();
  }) as unknown as typeof fetch;
}

test("the context resume probe accepts a broker serving version 1 or later and asks /health of the transaction endpoint", async () => {
  for (const version of [1, 2]) {
    const urls: string[] = [];
    await requireContextResumeSupport(
      { url: "http://broker.local", token: "" },
      healthFetch(() => Response.json({ status: "ok", context_resume_version: version }), urls)
    );
    expect(urls).toEqual(["http://broker.local/health"]);
  }
});

test("the context resume probe refuses a missing, low, mistyped or unreadable context_resume_version", async () => {
  const endpoint = { url: "http://broker.local", token: "" };
  const bodies: unknown[] = [{ status: "ok" }, { context_resume_version: 0 }, { context_resume_version: "1" }, { context_resume_version: null }, { context_resume_version: Number.NaN }, null, []];
  const message = "broker does not serve context resume (context_resume_version missing or < 1); context clear refused";
  for (const body of bodies) {
    const refusal = await requireContextResumeSupport(endpoint, healthFetch(() => Response.json(body))).then(
      () => null,
      (error: unknown) => error
    );
    expect(refusal, JSON.stringify(body)).toBeInstanceOf(ContextResumeUnsupportedError);
    expect((refusal as Error).message, JSON.stringify(body)).toBe(message);
  }
  await expect(
    requireContextResumeSupport(endpoint, healthFetch(() => new Response("down", { status: 503 })))
  ).rejects.toBeInstanceOf(ContextResumeUnsupportedError);
});

test("the context resume probe fails closed when /health cannot be reached or read", async () => {
  const endpoint = { url: "http://broker.local", token: "" };
  const unreachable = await requireContextResumeSupport(
    endpoint,
    healthFetch(() => { throw new Error("connect ECONNREFUSED"); })
  ).then(() => null, (error: unknown) => error);
  expect((unreachable as Error).message).toBe("connect ECONNREFUSED");
  expect(unreachable).not.toBeInstanceOf(ContextResumeUnsupportedError);
  await expect(
    requireContextResumeSupport(endpoint, healthFetch(() => new Response("<html>", { status: 200 })))
  ).rejects.toThrow();
});

test("a timed out context resume probe refuses before reservation without waiting two real seconds", async () => {
  const timeout = new Error("simulated health timeout");
  const timeoutCalls: number[] = [];
  const immediateTimeout = (ms: number): AbortSignal => {
    timeoutCalls.push(ms);
    const controller = new AbortController();
    controller.abort(timeout);
    return controller.signal;
  };
  const neverRespondingHealth = ((_: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
  let reservations = 0;
  const typed: string[] = [];
  const timedOut = runClearReloadInTurn(
    {
      serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
      checkOperatorTrust: async () => "compatible" as const,
      checkContextResumeSupport: () =>
        requireContextResumeSupport({ url: "http://broker.local", token: "" }, neverRespondingHealth, immediateTimeout),
      currentSessionId: () => "sid-before",
      reserveContextDeposit: async () => { reservations += 1; return "attempt-1"; },
      readClearBackchannelBaseline: () => null,
      waitForClearBackchannel: async () => {},
      releaseContextDeposit: async () => {},
      reportError: () => {}
    },
    () => {},
    "tile-1",
    "lead-a1b2",
    "night-shift",
    undefined,
    { contextDepositId: "deposit-1" }
  );
  const result = await Promise.race([
    timedOut.then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error })
    ),
    new Promise<{ state: "test-timeout" }>((resolve) => setTimeout(() => resolve({ state: "test-timeout" }), 100))
  ]);

  expect(result).toEqual({ state: "rejected", error: timeout });
  expect({ timeoutCalls, reservations, typed }).toEqual({ timeoutCalls: [2000], reservations: 0, typed: [] });
});

test("two context clear directives each probe the broker health", async () => {
  const urls: string[] = [];
  const endpoint = { url: "http://broker.local", token: "" };
  const fetchImpl = healthFetch(() => Response.json({ context_resume_version: 1 }), urls);
  let reservations = 0;
  const host: ClearReloadHost = {
    serializeTile: (_id, fn) => fn(async () => "written" as const),
    checkOperatorTrust: async () => "compatible" as const,
    checkContextResumeSupport: () => requireContextResumeSupport(endpoint, fetchImpl),
    currentSessionId: () => "sid-before",
    reserveContextDeposit: async () => `attempt-${++reservations}`,
    readClearBackchannelBaseline: () => null,
    waitForClearBackchannel: async () => {},
    releaseContextDeposit: async () => "sent" as const,
    reportError: () => {}
  };
  const run = () =>
    runClearReloadInTurn(host, () => {}, "tile-1", "lead-a1b2", "night-shift", undefined, { contextDepositId: "deposit-1" });

  await run();
  await run();

  expect({ urls, reservations }).toEqual({
    urls: ["http://broker.local/health", "http://broker.local/health"],
    reservations: 2
  });
});

test("the context transaction names the broker's owner_lacks_context_resume refusal instead of a generic failure", async () => {
  const request = { action: "reserve", depositId: "0123456789abcdef", targetPeerId: "alpha" } as const;
  const refusal = await readContextTransactionResponse(
    request,
    Response.json({ ok: false, reason: "owner_lacks_context_resume" }, { status: 409 })
  ).then(() => null, (error: unknown) => error);
  expect(refusal).toBeInstanceOf(ContextResumeUnsupportedError);
  expect((refusal as Error).message).toBe("context transaction reserve refused: owner_lacks_context_resume");
  const otherReason = await readContextTransactionResponse(
    request,
    Response.json({ ok: false, reason: "contested" }, { status: 409 })
  ).then(() => null, (error: unknown) => error);
  expect((otherReason as Error).message).toBe("context transaction reserve refused: contested");
  expect(otherReason).not.toBeInstanceOf(ContextResumeUnsupportedError);
  await expect(
    readContextTransactionResponse(request, Response.json({ error: "deposit_id is invalid" }, { status: 400 }))
  ).rejects.toThrow("deposit_id is invalid");
  await expect(readContextTransactionResponse(request, new Response("oops", { status: 502 }))).rejects.toThrow(
    "context transaction reserve failed: 502"
  );
});

test("the context transaction accepts the reserve attempt id and checks the state each release result implies", async () => {
  const reserve = { action: "reserve", depositId: "0123456789abcdef", targetPeerId: "alpha" } as const;
  const attemptId = "0123456789abcdef0123456789abcdef";
  expect(await readContextTransactionResponse(reserve, Response.json({ state: "reserved", attempt_id: attemptId }))).toEqual({
    attemptId
  });
  await expect(
    readContextTransactionResponse(reserve, Response.json({ state: "reserved", attempt_id: "short" }))
  ).rejects.toThrow("reserve returned an invalid response");

  const release = { action: "release", depositId: "0123456789abcdef", targetPeerId: "alpha", attemptId } as const;
  for (const resumeDelivery of ["pending", "sent"] as const) {
    expect(
      await readContextTransactionResponse(
        { ...release, cleared: true },
        Response.json({ state: "resuming", resume_delivery: resumeDelivery })
      )
    ).toEqual({ resumeDelivery });
  }
  expect(await readContextTransactionResponse({ ...release, cleared: false }, Response.json({ state: "held" }))).toEqual({});
  await expect(
    readContextTransactionResponse({ ...release, cleared: true }, Response.json({ state: "resuming" }))
  ).rejects.toThrow("release returned an invalid response");
  await expect(
    readContextTransactionResponse({ ...release, cleared: true }, Response.json({ state: "held" }))
  ).rejects.toThrow("release returned an invalid response");
  await expect(
    readContextTransactionResponse({ ...release, cleared: false }, Response.json({ state: "resuming" }))
  ).rejects.toThrow("release returned an invalid response");
});

test("the signed release fields carry the boolean cleared and the reserve fields carry none", () => {
  const attemptId = "0123456789abcdef0123456789abcdef";
  const base = { depositId: "0123456789abcdef", targetPeerId: "alpha" };
  expect(contextTransactionFields({ action: "reserve", ...base })).toEqual({
    target_peer_id: "alpha",
    deposit_id: "0123456789abcdef",
    action: "reserve"
  });
  for (const cleared of [true, false]) {
    expect(contextTransactionFields({ action: "release", ...base, attemptId, cleared })).toEqual({
      target_peer_id: "alpha",
      deposit_id: "0123456789abcdef",
      action: "release",
      attempt_id: attemptId,
      cleared
    });
  }
});

function runClearReloadHostCallback(name: string): string {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8").replace(/\r\n/g, "\n");
  const anchor = source.indexOf("const runClearReload = (");
  const marker = `      ${name}: `;
  const start = anchor < 0 ? -1 : source.indexOf(marker, anchor);
  if (start < 0) throw new Error(`index.ts: runClearReload host callback ${name} is unavailable`);
  const exprStart = start + marker.length;
  const arrow = source.indexOf("=>", exprStart);
  const blockOpen = source.indexOf("{", arrow);
  const isBlock = source.slice(arrow + 2, blockOpen).trim() === "";
  if (isBlock) return `${source.slice(exprStart, blockOpen)}{${extractBracedBody(source, blockOpen, true)}}`;
  return source.slice(exprStart, source.indexOf(",\n", exprStart));
}

function evaluateHostCallback(name: string, params: string[], args: unknown[]): unknown {
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`const hostCallback = ${runClearReloadHostCallback(name)};`);
  return new Function(...params, `${js}\nreturn hostCallback;`)(...args);
}

function indexBrokerEndpointOnce(resolve: () => unknown): () => unknown {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("function brokerEndpointOnce(");
  if (start < 0) throw new Error("index.ts: brokerEndpointOnce is unavailable");
  const open = source.indexOf("{", source.indexOf("): () =>", start));
  const fn = source.slice(start, open) + "{" + extractBracedBody(source, open, true) + "}";
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(fn);
  return new Function("resolveBrokerEndpoint", `${js}\nreturn brokerEndpointOnce();`)(resolve) as () => unknown;
}

function hostCallbacks(endpointOnce: () => unknown, transactions: unknown[][], probes: unknown[]) {
  const evaluate = evaluateHostCallback;
  const contextTransaction = async (request: unknown, endpoint: unknown) => {
    transactions.push([request, endpoint]);
    return { attemptId: "a".repeat(32) };
  };
  const requireContextResumeSupport = async (endpoint: unknown) => {
    probes.push(endpoint);
  };
  return {
    release: evaluate("releaseContextDeposit", ["contextTransaction", "peerId", "endpointOnce"], [contextTransaction, "lead-a1b2", endpointOnce]) as (
      depositId: string,
      attemptId: string,
      cleared: boolean
    ) => Promise<void>,
    reserve: evaluate("reserveContextDeposit", ["contextTransaction", "endpointOnce"], [contextTransaction, endpointOnce]) as (
      depositId: string,
      targetPeerId: string
    ) => Promise<string>,
    probe: evaluate("checkContextResumeSupport", ["requireContextResumeSupport", "endpointOnce"], [requireContextResumeSupport, endpointOnce]) as () => Promise<void>
  };
}

test("the Deck host releases with the cleared flag it was given, for the peer it cleared", async () => {
  const transactions: unknown[][] = [];
  const endpoint = { url: "http://broker.local", token: "" };
  const { release } = hostCallbacks(() => endpoint, transactions, []);

  await release("0123456789abcdef", "a".repeat(32), true);
  await release("0123456789abcdef", "a".repeat(32), false);

  expect(transactions).toEqual([
    [{ action: "release", depositId: "0123456789abcdef", targetPeerId: "lead-a1b2", attemptId: "a".repeat(32), cleared: true }, endpoint],
    [{ action: "release", depositId: "0123456789abcdef", targetPeerId: "lead-a1b2", attemptId: "a".repeat(32), cleared: false }, endpoint]
  ]);
});

test("the Deck host forwards the release delivery to clear_reload", async () => {
  const endpointOnce = () => ({ url: "http://broker.local", token: "" });
  const contextTransaction = async () => ({ resumeDelivery: "pending" as const });
  const release = evaluateHostCallback(
    "releaseContextDeposit",
    ["contextTransaction", "peerId", "endpointOnce"],
    [contextTransaction, "lead-a1b2", endpointOnce]
  ) as (depositId: string, attemptId: string, cleared: boolean) => Promise<unknown>;

  expect(await release("0123456789abcdef", "a".repeat(32), true)).toBe("pending");
});

test("the Deck host sends the probe, the reservation and the release to one endpoint resolved once per directive", async () => {
  let resolutions = 0;
  const transactions: unknown[][] = [];
  const probes: unknown[] = [];
  const endpointOnce = indexBrokerEndpointOnce(() => ({ url: `http://broker-${++resolutions}.local`, token: "" }));
  const { probe, reserve, release } = hostCallbacks(endpointOnce, transactions, probes);

  await probe();
  const attemptId = await reserve("0123456789abcdef", "lead-a1b2");
  await release("0123456789abcdef", attemptId, true);

  expect(resolutions).toBe(1);
  expect(probes).toEqual([{ url: "http://broker-1.local", token: "" }]);
  expect(transactions.map(([, endpoint]) => endpoint)).toEqual([
    { url: "http://broker-1.local", token: "" },
    { url: "http://broker-1.local", token: "" }
  ]);
  expect(endpointOnce()).toBe(probes[0]);
});

test("a directive that asks twice resolves a fresh endpoint each time", () => {
  let resolutions = 0;
  const first = indexBrokerEndpointOnce(() => ({ n: ++resolutions }));
  const second = indexBrokerEndpointOnce(() => ({ n: ++resolutions }));
  expect([first(), second()]).toEqual([{ n: 1 }, { n: 2 }]);
});

test("the Deck host probes context resume support on the endpoint it was given", async () => {
  const endpoint = { url: "http://broker.local", token: "" };
  const probes: unknown[] = [];
  const { probe } = hostCallbacks(() => endpoint, [], probes);

  await probe();

  expect(probes).toEqual([endpoint]);
});

function indexTrustCallback(approvals: unknown): () => Promise<unknown> {
  return evaluateHostCallback("checkOperatorTrust", ["approvals"], [approvals]) as () => Promise<unknown>;
}

const TRUST_VERDICTS = ["not-trusted", "unconfigured", "incompatible", "invalid", "unreachable", "compatible"] as const;

test("the Deck host answers every trust check with the approval runtime's fresh verdict, never a cached or fixed one", async () => {
  const queue = [...TRUST_VERDICTS];
  let fresh = 0;
  const approvals = {
    checkTrustNow: async () => {
      fresh += 1;
      return queue.shift();
    },
    operatorTrust: "compatible",
    status: "compatible"
  };
  const check = indexTrustCallback(approvals);

  const answers: unknown[] = [];
  for (let i = 0; i < TRUST_VERDICTS.length; i++) answers.push(await check());

  expect({ answers, fresh }, "each context clear must query the broker again and return its verdict as is").toEqual({
    answers: [...TRUST_VERDICTS],
    fresh: TRUST_VERDICTS.length
  });
});

test("the Deck host's real trust callback stops a context clear before any reservation or keystroke when the broker does not trust the Deck", async () => {
  for (const verdict of TRUST_VERDICTS.filter((candidate) => candidate !== "compatible")) {
    const calls: string[] = [];
    const check = indexTrustCallback({ checkTrustNow: async () => verdict, operatorTrust: "compatible" });

    const outcome = runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async (keys) => { calls.push(`inject ${keys}`); return "written" as const; }),
        checkOperatorTrust: check as ClearReloadHost["checkOperatorTrust"],
        checkContextResumeSupport: async () => { calls.push("probe"); },
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => { calls.push("reserve"); return "a".repeat(32); },
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => { calls.push("wait"); },
        releaseContextDeposit: async () => { calls.push("release"); },
        reportError: () => {}
      },
      () => {},
      "tile-1",
      "alpha",
      "ws",
      undefined,
      { contextDepositId: "0123456789abcdef" }
    );

    await expect(outcome, `verdict ${verdict}`).rejects.toThrow(`operator trust is ${verdict}`);
    expect({ verdict, calls }, "nothing may be probed, reserved, typed or released after a refused trust check").toEqual({ verdict, calls: [] });
  }
});

test("a trust check that fails is a refusal of the context clear, never an authorization", async () => {
  const calls: string[] = [];
  const reported: string[] = [];
  const failure = new Error("operator identity is unavailable");
  const check = indexTrustCallback({ checkTrustNow: async () => { throw failure; }, operatorTrust: "compatible" });

  await expect(check(), "the callback must let the failure through unchanged").rejects.toBe(failure);

  const outcome = runClearReloadInTurn(
    {
      serializeTile: (_id, fn) => fn(async (keys) => { calls.push(`inject ${keys}`); return "written" as const; }),
      checkOperatorTrust: check as ClearReloadHost["checkOperatorTrust"],
      checkContextResumeSupport: async () => { calls.push("probe"); },
      currentSessionId: () => "sid-before",
      reserveContextDeposit: async () => { calls.push("reserve"); return "a".repeat(32); },
      readClearBackchannelBaseline: () => null,
      waitForClearBackchannel: async () => { calls.push("wait"); },
      releaseContextDeposit: async () => { calls.push("release"); },
      reportError: (message) => { reported.push(message); }
    },
    () => {},
    "tile-1",
    "alpha",
    "ws",
    undefined,
    { contextDepositId: "0123456789abcdef" }
  );

  await expect(outcome).rejects.toThrow("operator identity is unavailable");
  expect({ calls, reported }, "no probe, reservation or keystroke after a failed check, and the failure is reported").toEqual({
    calls: [],
    reported: ['context clear failed for "alpha"']
  });
});

test("a broker without context resume support is reported to the agent as context_resume_unsupported, not as a generic error", async () => {
  const r = recorder([session("tile-1", "alpha")]);
  const typed: string[] = [];
  const errors: unknown[] = [];
  r.deps.runClearReload = (tileId, peerId, workstream, contextDepositId) =>
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: () =>
          requireContextResumeSupport({ url: "http://broker.local", token: "" }, healthFetch(() => Response.json({ status: "ok" }))),
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => { throw new Error("must not reserve"); },
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => {},
        reportError: (_message, error) => errors.push(error)
      },
      () => {},
      tileId,
      peerId,
      workstream,
      undefined,
      { contextDepositId }
    );

  const result = await runDirectiveForCaller("clear_reload", ["alpha"], "night-shift", "lead", r.deps, {
    contextDepositId: "0123456789abcdef",
    reportWaitMs: 500
  });

  expect(result.refused).toEqual([{ tileId: "tile-1", peerId: "alpha", reason: "context_resume_unsupported" }]);
  expect(result.injected).toEqual([]);
  expect(typed).toEqual([]);
  expect(errors[0]).toBeInstanceOf(ContextResumeUnsupportedError);
});

test("an owner server without context resume support is reported as context_resume_unsupported and nothing is typed", async () => {
  const r = recorder([session("tile-1", "alpha")]);
  const typed: string[] = [];
  r.deps.runClearReload = (tileId, peerId, workstream, contextDepositId) =>
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async (depositId, targetPeerId) => {
          const reserved = await readContextTransactionResponse(
            { action: "reserve", depositId, targetPeerId },
            Response.json({ ok: false, reason: "owner_lacks_context_resume" }, { status: 409 })
          );
          return reserved.attemptId as string;
        },
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => { throw new Error("must not release"); },
        reportError: () => {}
      },
      () => {},
      tileId,
      peerId,
      workstream,
      undefined,
      { contextDepositId }
    );

  const result = await runDirectiveForCaller("clear_reload", ["alpha"], "night-shift", "lead", r.deps, {
    contextDepositId: "0123456789abcdef",
    reportWaitMs: 500
  });

  expect(result.refused).toEqual([{ tileId: "tile-1", peerId: "alpha", reason: "context_resume_unsupported" }]);
  expect(typed).toEqual([]);
});

test("any other clear_reload failure stays a generic error refusal", async () => {
  const r = recorder([session("tile-1", "alpha")]);
  r.deps.runClearReload = () => Promise.reject(new Error("connect ECONNREFUSED"));

  const result = await runDirectiveForCaller("clear_reload", ["alpha"], "night-shift", "lead", r.deps, {
    contextDepositId: "0123456789abcdef",
    reportWaitMs: 500
  });

  expect(result.refused).toEqual([{ tileId: "tile-1", peerId: "alpha", reason: "error" }]);
});

test("context clear signs cleared true only after the clear rotation was observed", async () => {
  const released: boolean[] = [];
  const host = (overrides: Partial<ClearReloadHost>): ClearReloadHost => ({
    serializeTile: (_id, fn) => fn(async () => "written" as const),
    checkOperatorTrust: async () => "compatible" as const,
    checkContextResumeSupport: async () => {},
    currentSessionId: () => "sid-before",
    reserveContextDeposit: async () => "attempt-1",
    readClearBackchannelBaseline: () => null,
    waitForClearBackchannel: async () => {},
    releaseContextDeposit: async (_depositId, _attemptId, cleared) => { released.push(cleared); },
    reportError: () => {},
    ...overrides
  });
  const run = (h: ClearReloadHost) =>
    runClearReloadInTurn(h, () => {}, "tile-1", "lead-a1b2", "night-shift", undefined, { contextDepositId: "deposit-1" });

  await run(host({}));
  expect(released).toEqual([true]);

  released.length = 0;
  await run(host({ serializeTile: (_id, fn) => fn(async () => "busy-timeout" as const) }));
  expect(released).toEqual([false]);

  released.length = 0;
  await expect(
    run(host({ waitForClearBackchannel: async () => { throw new Error("clear rotation timed out"); } }))
  ).rejects.toThrow("clear rotation timed out");
  expect(released).toEqual([false]);

  released.length = 0;
  await expect(
    run(host({ serializeTile: (_id, fn) => fn(async () => { throw new Error("pty write failed"); }) }))
  ).rejects.toThrow("pty write failed");
  expect(released).toEqual([false]);
});

test("a pending resume delivery is reported separately from a sent clear", async () => {
  for (const resumeDelivery of ["pending", "sent"] as const) {
    const lines: string[] = [];
    const reports: string[] = [];
    await runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async () => "written" as const),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => "attempt-1",
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => resumeDelivery,
        reportError: (message) => { reports.push(message); }
      },
      (line) => { lines.push(line); },
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    );

    expect({ resumeDelivery, lines, reports }).toEqual(
      resumeDelivery === "pending"
        ? {
            resumeDelivery,
            lines: ['clear_reload -> "lead-a1b2": resume delivery pending until WebSocket reconnects'],
            reports: ['context resume for "lead-a1b2" is pending until WebSocket reconnects']
          }
        : {
            resumeDelivery,
            lines: ['clear_reload -> "lead-a1b2": written'],
            reports: []
          }
    );
  }

  const barrierLines: string[] = [];
  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async () => "written" as const),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => "attempt-1",
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => { throw new Error("clear rotation timed out"); },
        releaseContextDeposit: async () => {},
        reportError: () => {}
      },
      (line) => { barrierLines.push(line); },
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toThrow("clear rotation timed out");

  const rejectedClearLines: string[] = [];
  expect(
    await runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async () => "busy-timeout" as const),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => "attempt-1",
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => {},
        reportError: () => {}
      },
      (line) => { rejectedClearLines.push(line); },
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).toBe("busy-timeout");
  expect([...barrierLines, ...rejectedClearLines]).not.toContain('clear_reload -> "lead-a1b2": written');
});

test("an unknown resume status is reported without a sent journal", async () => {
  const lines: string[] = [];
  const reports: Array<{ message: string; error: unknown }> = [];
  await runClearReloadInTurn(
    {
      serializeTile: (_id, fn) => fn(async () => "written" as const),
      checkOperatorTrust: async () => "compatible" as const,
      checkContextResumeSupport: async () => {},
      currentSessionId: () => "sid-before",
      reserveContextDeposit: async () => "attempt-1",
      readClearBackchannelBaseline: () => null,
      waitForClearBackchannel: async () => {},
      releaseContextDeposit: async () => undefined,
      reportError: (message, error) => { reports.push({ message, error }); }
    },
    (line) => { lines.push(line); },
    "tile-1",
    "lead-a1b2",
    "night-shift",
    undefined,
    { contextDepositId: "deposit-1" }
  );

  expect(lines).not.toContain('clear_reload -> "lead-a1b2": written');
  expect(reports).toEqual([
    { message: 'context resume status unknown for "lead-a1b2"', error: new Error("context resume status unknown") }
  ]);
});

test("a release failure after rotation reports an unknown resume status", async () => {
  const failure = new Error("context transaction release returned an invalid response");
  const reports: Array<{ message: string; error: unknown }> = [];
  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async () => "written" as const),
        checkOperatorTrust: async () => "compatible" as const,
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => "attempt-1",
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => { throw failure; },
        reportError: (message, error) => { reports.push({ message, error }); }
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toBe(failure);
  expect(reports).toEqual([{ message: 'context resume status unknown for "lead-a1b2"', error: failure }]);
});

test("a rotation wait still pending never lets the release claim the clear happened", async () => {
  const pending = deferred<void>();
  const released: boolean[] = [];
  const outcome = runClearReloadInTurn(
    {
      serializeTile: (_id, fn) => fn(async () => "written" as const),
      checkOperatorTrust: async () => "compatible" as const,
      checkContextResumeSupport: async () => {},
      currentSessionId: () => "sid-before",
      reserveContextDeposit: async () => "attempt-1",
      readClearBackchannelBaseline: () => null,
      waitForClearBackchannel: () => pending.promise,
      releaseContextDeposit: async (_depositId, _attemptId, cleared) => { released.push(cleared); },
      reportError: () => {}
    },
    () => {},
    "tile-1",
    "lead-a1b2",
    "night-shift",
    undefined,
    { contextDepositId: "deposit-1" }
  );

  await Bun.sleep(20);
  expect(released).toEqual([]);
  pending.resolve();
  await outcome;
  expect(released).toEqual([true]);
});

test("context clear neither reserves nor types /clear when a fresh trust check is not compatible", async () => {
  // The reservation would succeed: the identity armed at startup is still
  // there, only the broker answering now is not a compatible one.
  for (const status of ["unconfigured", "not-trusted", "incompatible", "invalid", "unreachable"] as const) {
    const typed: string[] = [];
    let reservations = 0;
    let releases = 0;
    const errors: { message: string; error: unknown }[] = [];

    await expect(
      runClearReloadInTurn(
        {
          serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
          checkOperatorTrust: async () => status,
          checkContextResumeSupport: async () => {},
          currentSessionId: () => "sid-before",
          reserveContextDeposit: async () => {
            reservations += 1;
            return "attempt-1";
          },
          readClearBackchannelBaseline: () => null,
          waitForClearBackchannel: async () => {},
          releaseContextDeposit: async () => {
            releases += 1;
          },
          reportError: (message, error) => errors.push({ message, error })
        },
        () => {},
        "tile-1",
        "lead-a1b2",
        "night-shift",
        undefined,
        { contextDepositId: "deposit-1" }
      )
    ).rejects.toThrow(`operator trust is ${status}`);

    expect([status, reservations, releases, typed]).toEqual([status, 0, 0, []]);
    expect([status, errors.map((e) => e.message)]).toEqual([status, ['context clear failed for "lead-a1b2"']]);
  }
});

test("context clear neither reserves nor types /clear when the trust check throws", async () => {
  const typed: string[] = [];
  let reservations = 0;
  let releases = 0;
  const failure = new Error("broker unreachable");
  const errors: { message: string; error: unknown }[] = [];

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
        checkOperatorTrust: async () => { throw failure; },
        checkContextResumeSupport: async () => {},
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => {
          reservations += 1;
          return "attempt-1";
        },
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => {
          releases += 1;
        },
        reportError: (message, error) => errors.push({ message, error })
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toBe(failure);

  expect(reservations).toBe(0);
  expect(releases).toBe(0);
  expect(typed).toEqual([]);
  expect(errors).toEqual([{ message: 'context clear failed for "lead-a1b2"', error: failure }]);
});

test("context clear rejects a host missing the operator trust check before reservation", async () => {
  let reservations = 0;
  const typed: string[] = [];

  await expect(
    runClearReloadInTurn(
      {
        serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "written" as const; }),
        currentSessionId: () => "sid-before",
        reserveContextDeposit: async () => {
          reservations += 1;
          return "attempt-1";
        },
        readClearBackchannelBaseline: () => null,
        waitForClearBackchannel: async () => {},
        releaseContextDeposit: async () => {}
      },
      () => {},
      "tile-1",
      "lead-a1b2",
      "night-shift",
      undefined,
      { contextDepositId: "deposit-1" }
    )
  ).rejects.toThrow("context clear host is incomplete");

  expect(reservations).toBe(0);
  expect(typed).toEqual([]);
});

test("clear_reload without a deposit does not consult operator trust", async () => {
  let checks = 0;
  const outcome = await runClearReloadInTurn(
    {
      serializeTile: (_id, fn) => fn(async () => "written" as const),
      checkOperatorTrust: async () => {
        checks += 1;
        return "not-trusted" as const;
      }
    },
    () => {},
    "tile-1",
    "lead-a1b2",
    "night-shift"
  );

  expect(outcome).toBe("written");
  expect(checks).toBe(0);
});

test("clear_reload stops before the reload instruction and announces when clear is refused", async () => {
  const typed: string[] = [];
  const journal: string[] = [];
  const failures: { peerId: string; outcome: string }[] = [];
  const errors: unknown[] = [];
  const outcome = await runClearReloadInTurn(
    {
      serializeTile: (_id, fn) => fn(async (keys) => { typed.push(keys); return "busy-timeout" as const; }),
      reportError: (_message, error) => errors.push(error)
    },
    (line) => journal.push(line),
    "tile-1",
    "lead-a1b2",
    "night-shift",
    (peerId, failure) => failures.push({ peerId, outcome: failure })
  );

  expect(outcome).toBe("busy-timeout");
  expect(typed).toEqual(["/clear"]);
  expect(journal).toEqual(['clear_reload -> "lead-a1b2": /clear not injected (busy-timeout)']);
  expect(failures).toEqual([{ peerId: "lead-a1b2", outcome: "busy-timeout" }]);
  expect(errors).toEqual([]);
});

test("clear_reload reports its sequence outcome without a second direct injection", async () => {
  const r = recorder([session("t1", "alpha")]);
  r.deps.runClearReload = (tileId, peerId, workstream) => {
    r.clearReload.push({ tileId, peerId, workstream });
    return Promise.resolve("refused-modal");
  };

  const result = await runDirectiveForCaller("clear_reload", ["alpha"], "night-shift", "lead", r.deps);

  expect(result).toEqual({
    injected: [],
    refused: [{ tileId: "t1", peerId: "alpha", reason: "refused-modal" }],
    pending: [],
    unreached: []
  });
  expect(r.clearReload).toEqual([{ tileId: "t1", peerId: "alpha", workstream: "night-shift" }]);
  expect(r.typed).toEqual([]);
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("deck_run_directive lists a refused injection under refused with its outcome, never under injected", async () => {
  const r = recorder([session("t1", "alpha"), session("t2", "beta")]);
  r.deps.injectCommand = (tileId) => Promise.resolve(tileId === "t1" ? "refused-modal" : "written");
  const out = await runDirectiveForCaller("clear", ["alpha", "beta"], undefined, "team-lead-ab12", r.deps);
  expect(out).toEqual({
    injected: [{ tileId: "t2", peerId: "beta" }],
    refused: [{ tileId: "t1", peerId: "alpha", reason: "refused-modal" }],
    pending: [],
    unreached: []
  });
  expect(r.journal).toContain('directive /clear -> "alpha": refused-modal');
});

test("deck_run_directive reports a target still busy at the report cap as pending, and journals its later outcome", async () => {
  const r = recorder([session("t1", "alpha")]);
  const busy = deferred<string>();
  r.deps.injectCommand = () => busy.promise;
  let guard: ReturnType<typeof setTimeout> | undefined;
  const out = await Promise.race([
    runDirectiveForCaller("clear", ["alpha"], undefined, "team-lead-ab12", r.deps, { reportWaitMs: 20 }),
    new Promise((resolve) => {
      guard = setTimeout(() => resolve("the report cap was not honoured"), 1_000);
    })
  ]);
  clearTimeout(guard);
  expect(out).toEqual({ injected: [], refused: [], pending: [{ tileId: "t1", peerId: "alpha" }], unreached: [] });
  busy.resolve("written");
  await busy.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(r.journal).toContain('directive /clear -> "alpha": written');
});

test("deck_run_directive lists an asynchronously rejected injection as refused with reason error", async () => {
  const r = recorder([session("t1", "alpha")]);
  const cause = new Error("terminal unavailable");
  r.deps.injectCommand = () => Promise.reject(cause);
  const out = await runDirectiveForCaller("clear", ["alpha"], undefined, "team-lead-ab12", r.deps);
  expect(out.refused).toEqual([{ tileId: "t1", peerId: "alpha", reason: "error" }]);
  expect(out.injected).toEqual([]);
  expect(r.errors).toEqual([{ message: 'directive injection failed for "alpha"', error: cause }]);
});

test("every non-written outcome is refused with that reason and nothing is listed injected", async () => {
  for (const reason of ["refused-modal", "busy-timeout", "no-terminal", "error"] as const) {
    const r = recorder([session("t1", "alpha")]);
    r.deps.injectCommand = () => (reason === "error" ? Promise.reject(new Error("boom")) : Promise.resolve(reason));
    const out = await runDirectiveForCaller("clear", ["alpha"], undefined, "team-lead-ab12", r.deps);
    expect(out, reason).toEqual({
      injected: [],
      refused: [{ tileId: "t1", peerId: "alpha", reason }],
      pending: [],
      unreached: []
    });
  }
});

test("with one written target and one slow target, the written one is injected and the slow one pending", async () => {
  const r = recorder([session("t1", "alpha"), session("t2", "beta")]);
  const slow = deferred<"written">();
  r.deps.injectCommand = (tileId) => (tileId === "t1" ? Promise.resolve("written") : slow.promise);
  const out = await runDirectiveForCaller("clear", ["alpha", "beta"], undefined, "team-lead-ab12", r.deps, {
    reportWaitMs: 20
  });
  expect(out).toEqual({
    injected: [{ tileId: "t1", peerId: "alpha" }],
    refused: [],
    pending: [{ tileId: "t2", peerId: "beta" }],
    unreached: []
  });
  slow.resolve("written");
});

test("a journal that throws on the outcome line leaves a written target injected and reports the journal failure", async () => {
  const r = recorder([session("t1", "alpha")]);
  const cause = new Error("journal sink down");
  r.deps.journal = (line) => {
    if (line.includes(" -> ")) throw cause;
  };
  const out = await runDirectiveForCaller("clear", ["alpha"], undefined, "team-lead-ab12", r.deps);
  expect(out).toEqual({ injected: [{ tileId: "t1", peerId: "alpha" }], refused: [], pending: [], unreached: [] });
  expect(r.errors).toEqual([{ message: 'directive journal failed for "alpha"', error: cause }]);
});

test("the report cap is far below the 120 s idle wait so a caller targeting its own busy tile is answered", () => {
  expect(directiveRun.DIRECTIVE_REPORT_WAIT_MS).toBeGreaterThan(0);
  expect(directiveRun.DIRECTIVE_REPORT_WAIT_MS * 10).toBeLessThanOrEqual(directiveRun.DIRECTIVE_IDLE_WAIT_MS);
});

test("runDirectiveOn reaches only single live tiles and reports the absent and the ambiguous", async () => {
  const r = recorder(LIVE());
  const out = await runDirectiveOn("clear", ["alpha", "twin", "gone"], undefined, "x", r.deps);
  await r.settle();
  expect(out.injected).toEqual([{ tileId: "t1", peerId: "alpha" }]);
  expect(out.unreached).toEqual([
    { peerId: "gone", reason: "no-live-target" },
    { peerId: "twin", reason: "ambiguous" }
  ]);
  expect(r.typed).toEqual([{ tileId: "t1", keys: "/clear" }]);
  expect(r.journal).toContain('directive /clear -> "alpha": written');
});

test("a compact prompt is typed after /compact, the journal keeps the bare command", async () => {
  const r = recorder(LIVE());
  await runDirectiveOn("compact", ["alpha"], "keep the API decisions", "x", r.deps);
  await r.settle();
  expect(r.typed).toEqual([{ tileId: "t1", keys: "/compact keep the API decisions" }]);
  expect(r.journal).toEqual(['directive /compact -> "alpha": written']);
});

test("an invalid card directive is refused before any resolution, with nothing typed", async () => {
  const r = recorder(LIVE());
  const out = await executeDirectiveItem(
    { id: "c", title: "bad", directive: "hello" as never, target_peer_ids: ["alpha"] },
    r.deps
  );
  await r.settle();
  expect(out).toEqual({ id: "c", title: "bad", directive: null, injected: [], unreached: [] });
  expect(r.typed).toEqual([]);
  expect(r.errors).toHaveLength(1);
});

test("runDirectiveForCaller journals the sanitized prompt as one quoted JSON string before per-target lines", async () => {
  const r = recorder(LIVE());
  const raw = `focus${String.fromCharCode(0x0a)}on${String.fromCodePoint(0xe0001)} "the API"`;
  const out = await runDirectiveForCaller("compact", ["alpha"], sanitizeDirectivePrompt(raw), "team-lead-ab12", r.deps);
  await r.settle();
  expect(r.journal[0]).toBe('directive /compact requested by team-lead-ab12 for alpha with prompt "focus on \\"the API\\""');
  expect(r.journal).toContain('directive /compact -> "alpha": written');
  expect(out.injected).toEqual([{ tileId: "t1", peerId: "alpha" }]);
});

test("clear_reload journals its workstream rather than a prompt", async () => {
  const r = recorder(LIVE());
  await runDirectiveForCaller("clear_reload", ["alpha"], "night-shift", "team-lead-ab12", r.deps);
  await r.settle();

  expect(r.journal[0]).toBe('directive /clear requested by team-lead-ab12 for alpha with workstream "night-shift"');
});

test("clear_reload is accepted only by deck_run_directive, not roadmap cards", () => {
  const schemaEnum = (name: string): string[] => {
    const tool = TOOLS.find((t) => t.name === name) as
      | { inputSchema: { properties: { directive?: { enum?: string[] } } } }
      | undefined;
    const e = tool?.inputSchema.properties.directive?.enum;
    if (!e) throw new Error(`${name} carries no directive enum`);
    return [...e].sort();
  };
  const cardCommands = directiveCommands().filter((directive) => directive !== "clear_reload").sort();
  expect(cardCommands).toEqual(schemaEnum("roadmap_add"));
  expect(cardCommands).toEqual(schemaEnum("roadmap_update"));
  expect(schemaEnum("roadmap_add")).not.toContain("clear_reload");
  for (const directive of directiveCommands()) {
    const args = directive === "clear_reload" ? { directive, peer_ids: ["alpha"], workstream: "night-shift" } : { directive, peer_ids: ["alpha"] };
    expect(parseRunDirectiveArgs(args).directive).toBe(directive);
  }
});

test("parseRunDirectiveArgs refuses a directive outside the enum, and a non-string one", () => {
  for (const directive of ["hello", "CLEAR", "", 3, null, undefined, ["clear"]]) {
    expect(() => parseRunDirectiveArgs({ directive, peer_ids: ["alpha"] }), String(directive)).toThrow(
      "directive must be one of"
    );
  }
});

test("parseRunDirectiveArgs canonicalizes peer_ids and refuses empty, malformed, duplicate, or oversized lists", () => {
  expect(parseRunDirectiveArgs({ directive: "clear", peer_ids: [" alpha ", "beta"] }).peerIds).toEqual(["alpha", "beta"]);
  const bad: unknown[] = [
    undefined,
    [],
    "alpha",
    [1],
    ["alpha", null],
    [""],
    ["Bad Id"],
    ["alpha", " alpha "],
    Array.from({ length: 17 }, (_, i) => `p${i}`)
  ];
  for (const peer_ids of bad) {
    expect(() => parseRunDirectiveArgs({ directive: "clear", peer_ids }), JSON.stringify(peer_ids)).toThrow("peer_ids");
  }
});

test("a prompt is refused on every directive that does not declare it accepts one", () => {
  for (const d of directiveCommands()) {
    const call = () => parseRunDirectiveArgs({ directive: d, peer_ids: ["alpha"], prompt: "focus on X" });
    if (DIRECTIVE_ACCEPTS_PROMPT[d]) expect(call().prompt).toBe("focus on X");
    else expect(call, d).toThrow(`does not accept a prompt`);
  }
  expect(DIRECTIVE_ACCEPTS_PROMPT.clear).toBe(false);
});

test("a non-string prompt is refused, a blank one is treated as absent", () => {
  expect(() => parseRunDirectiveArgs({ directive: "compact", peer_ids: ["a"], prompt: 42 })).toThrow("prompt");
  expect(parseRunDirectiveArgs({ directive: "clear", peer_ids: ["a"], prompt: "   " }).prompt).toBeUndefined();
});

test("clear_reload accepts only a bounded lowercase workstream and no caller prompt", () => {
  expect(parseRunDirectiveArgs({ directive: "clear_reload", peer_ids: ["alpha"], workstream: "night-shift-1" })).toEqual({
    directive: "clear_reload",
    peerIds: ["alpha"],
    prompt: undefined,
    workstream: "night-shift-1"
  });
  for (const workstream of [undefined, "", "UPPER", "two\nlines", "has space", "x".repeat(65), `a${String.fromCodePoint(0x200b)}b`]) {
    expect(() => parseRunDirectiveArgs({ directive: "clear_reload", peer_ids: ["alpha"], workstream }), String(workstream)).toThrow(
      "workstream"
    );
  }
  expect(() =>
    parseRunDirectiveArgs({ directive: "clear_reload", peer_ids: ["alpha"], workstream: "night-shift", prompt: "peer prose" })
  ).toThrow("does not accept a prompt");
  expect(() => parseRunDirectiveArgs({ directive: "clear", peer_ids: ["alpha"], workstream: "night-shift" })).toThrow(
    "workstream"
  );
});

test("parseRunDirectiveArgs hands on a well-formed context_deposit_id for one clear_reload peer and omits the key otherwise", () => {
  const base = { directive: "clear_reload", peer_ids: ["alpha"], workstream: "night-shift" };
  expect(parseRunDirectiveArgs({ ...base, context_deposit_id: "0123456789abcdef" })).toEqual({
    directive: "clear_reload",
    peerIds: ["alpha"],
    prompt: undefined,
    workstream: "night-shift",
    contextDepositId: "0123456789abcdef"
  });
  expect("contextDepositId" in parseRunDirectiveArgs(base)).toBe(false);
  expect("contextDepositId" in parseRunDirectiveArgs({ directive: "clear", peer_ids: ["alpha"] })).toBe(false);
});

test("parseRunDirectiveArgs refuses both context deposit aliases, alone or beside the canonical name", () => {
  const base = { directive: "clear_reload", peer_ids: ["alpha"], workstream: "night-shift" };
  for (const alias of ["contextDepositId", "deposit_id"]) {
    for (const value of ["0123456789abcdef", null, "", 7]) {
      expect(() => parseRunDirectiveArgs({ ...base, [alias]: value }), `${alias}=${String(value)}`).toThrow(
        `${alias} is not accepted; use context_deposit_id`
      );
      expect(
        () => parseRunDirectiveArgs({ ...base, context_deposit_id: "0123456789abcdef", [alias]: value }),
        `${alias}=${String(value)} with canonical`
      ).toThrow(`${alias} is not accepted; use context_deposit_id`);
    }
  }
});

test("parseRunDirectiveArgs refuses a context_deposit_id that is mistyped, malformed, on another directive or on several peers", () => {
  const base = { directive: "clear_reload", peer_ids: ["alpha"], workstream: "night-shift" };
  for (const value of [null, "", 12, true, ["0123456789abcdef"], { id: "0123456789abcdef" }, "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", " 0123456789abcdef"]) {
    expect(() => parseRunDirectiveArgs({ ...base, context_deposit_id: value }), JSON.stringify(value)).toThrow(
      "context_deposit_id is not a valid deposit id"
    );
  }
  for (const directive of ["clear", "compact", "magic_compact"]) {
    expect(() =>
      parseRunDirectiveArgs({ directive, peer_ids: ["alpha"], context_deposit_id: "0123456789abcdef" }), directive
    ).toThrow("context_deposit_id is only valid for clear_reload");
  }
  expect(() =>
    parseRunDirectiveArgs({ ...base, peer_ids: ["alpha", "beta"], context_deposit_id: "0123456789abcdef" })
  ).toThrow("context_deposit_id requires exactly one peer_id");
});

test("sanitizeDirectivePrompt folds line breaks to spaces and strips C0, C1, bidi and zero-width characters", () => {
  const c = String.fromCharCode;
  const raw = [
    "first",
    c(0x0a),
    "second",
    c(0x0d, 0x0a),
    "third",
    c(0x2028),
    "fourth ",
    c(0x1b),
    "[31mred",
    c(0x07),
    c(0x9b),
    " rtl",
    c(0x202e),
    "x",
    c(0x2066),
    c(0x200b),
    c(0xfeff),
    c(0x061c),
    c(0x00ad),
    c(0x034f),
    c(0x115f),
    c(0x180e),
    c(0x3164),
    String.fromCodePoint(0xe0001),
    "y",
    c(0x09),
    "z"
  ].join("");
  const out = sanitizeDirectivePrompt(raw);
  expect(out).toBe("first second third fourth [31mred rtlxy z");
  for (const ch of out) {
    const cp = ch.codePointAt(0)!;
    expect(cp >= 0x20 && cp !== 0x7f, `code point ${cp.toString(16)}`).toBe(true);
  }
});

test("parseRunDirectiveArgs hands on the sanitized prompt, never the raw one", () => {
  const c = String.fromCharCode;
  const raw = `keep${c(0x0a)}the API${c(0x1b)}[2J decisions${c(0x202e)}`;
  const parsed = parseRunDirectiveArgs({ directive: "compact", peer_ids: ["a"], prompt: raw });
  expect(parsed.prompt).toBe(sanitizeDirectivePrompt(raw));
  expect(parsed.prompt).toBe("keep the API[2J decisions");
});

test("a prompt over the cap in Unicode code points is refused, not truncated", () => {
  const glyph = String.fromCodePoint(0x1f642);
  expect(parseRunDirectiveArgs({ directive: "compact", peer_ids: ["a"], prompt: glyph.repeat(DIRECTIVE_PROMPT_MAX) }).prompt).toBe(
    glyph.repeat(DIRECTIVE_PROMPT_MAX)
  );
  expect(() =>
    parseRunDirectiveArgs({ directive: "compact", peer_ids: ["a"], prompt: glyph.repeat(DIRECTIVE_PROMPT_MAX + 1) })
  ).toThrow(`${DIRECTIVE_PROMPT_MAX}`);
});

test("the tool's directive check is the card's own predicate", () => {
  for (const d of ["clear", "compact", "magic_compact", "hello"]) {
    let accepted = true;
    try {
      parseRunDirectiveArgs({ directive: d, peer_ids: ["a"] });
    } catch {
      accepted = false;
    }
    expect(accepted, d).toBe(isDirectiveCommand(d));
  }
});

test("runDirectiveOn returns a clean error when a dependency throws", async () => {
  for (const name of ["listSessions", "resolveMagic"] as const) {
    const r = recorder(LIVE());
    const cause = new Error(`${name} failed`);
    if (name === "listSessions") {
      r.deps.listSessions = () => { throw cause; };
      expect(await runDirectiveOn("clear", ["alpha"], undefined, "x", r.deps), name).toEqual({
        injected: [], refused: [], pending: [], unreached: [], error: "directive execution failed"
      });
    } else {
      r.deps.resolveMagic = () => { throw cause; };
      expect(await runDirectiveOn("magic_compact", ["alpha"], undefined, "x", r.deps), name).toEqual({
        injected: [], refused: [], pending: [], unreached: [], error: "directive execution failed"
      });
    }
    expect(r.errors, name).toEqual([{ message: "directive execution failed", error: cause }]);
  }
});

test("runDirectiveForCaller resolves to a clean error when the journal throws", async () => {
  const r = recorder(LIVE());
  const cause = new Error("journal failed");
  r.deps.journal = () => { throw cause; };
  const result = await runDirectiveForCaller("clear", ["alpha"], undefined, "caller", r.deps);
  expect(result).toEqual({ injected: [], refused: [], pending: [], unreached: [], error: "directive execution failed" });
  expect(r.errors).toEqual([{ message: "directive execution failed", error: cause }]);
});

test("runDirectiveForCaller excludes supervisor targets only for a restricted caller", async () => {
  const supervisor = { ...session("sup-tile", "sup"), supervisor: true };
  const restricted = recorder([supervisor]);
  const restrictedResult = await runDirectiveForCaller("clear", ["sup"], undefined, "team-lead-ab12", restricted.deps, {
    excludeSupervisor: true
  });
  await restricted.settle();
  expect(restrictedResult).toEqual({
    injected: [],
    refused: [],
    pending: [],
    unreached: [{ peerId: "sup", reason: "no-live-target" }]
  });
  expect(restricted.typed).toEqual([]);

  const unrestricted = recorder([supervisor]);
  const unrestrictedResult = await runDirectiveForCaller("clear", ["sup"], undefined, "supervisor", unrestricted.deps);
  await unrestricted.settle();
  expect(unrestrictedResult).toEqual({
    injected: [{ tileId: "sup-tile", peerId: "sup" }],
    refused: [],
    pending: [],
    unreached: []
  });
  expect(unrestricted.typed).toEqual([{ tileId: "sup-tile", keys: "/clear" }]);
});

test("runDirectiveOn retains targets injected before a synchronous later failure", async () => {
  const r = recorder([session("first", "alpha"), session("second", "beta")]);
  let calls = 0;
  r.deps.injectCommand = () => {
    calls += 1;
    if (calls === 2) throw new Error("second injection failed");
    return Promise.resolve("written");
  };

  const result = await runDirectiveOn("clear", ["alpha", "beta"], undefined, "x", r.deps);
  expect(result).toEqual({
    injected: [{ tileId: "first", peerId: "alpha" }],
    refused: [],
    pending: [],
    unreached: [],
    error: "directive execution failed"
  });
  expect(r.errors).toHaveLength(1);
});

test("createRunDirectiveAdapter forwards the directive, ids, prompt and caller then returns the runner result", () => {
  const calls: unknown[][] = [];
  const result = { injected: [{ tileId: "tile-a", peerId: "alpha" }], unreached: [] };
  const create = (directiveRun as unknown as {
    createRunDirectiveAdapter?: (
      deps: DirectiveRunDeps,
      run: (...args: [
        RoadmapDirective,
        string[],
        string | undefined,
        string,
        DirectiveRunDeps,
        { excludeSupervisor?: boolean }?
      ]) => typeof result
    ) => (
      directive: RoadmapDirective,
      peerIds: string[],
      prompt: string | undefined,
      callerId: string,
      excludeSupervisor?: boolean
    ) => typeof result;
  }).createRunDirectiveAdapter;
  expect(create).toBeFunction();
  if (!create) throw new Error("createRunDirectiveAdapter is required");
  const adapter = create({} as DirectiveRunDeps, (...args) => {
    calls.push(args);
    return result;
  });
  expect(adapter("compact", ["alpha", "beta"], "keep the API", "team-lead-a1b2")).toBe(result);
  expect(adapter("compact", ["alpha"], undefined, "team-lead-a1b2", true)).toBe(result);
  expect(calls).toEqual([
    ["compact", ["alpha", "beta"], "keep the API", "team-lead-a1b2", {}, { excludeSupervisor: false }],
    ["compact", ["alpha"], undefined, "team-lead-a1b2", {}, { excludeSupervisor: true }]
  ]);
});

test("createRunDirectiveAdapter carries the context deposit id to the runner and omits it otherwise", () => {
  const calls: unknown[][] = [];
  const result = { injected: [], refused: [], pending: [], unreached: [] };
  const adapter = createRunDirectiveAdapter({} as DirectiveRunDeps, (...args) => {
    calls.push(args);
    return Promise.resolve(result);
  });

  void adapter("clear_reload", ["alpha"], "night-shift", "lead", false, { contextDepositId: "0123456789abcdef" });
  void adapter("clear_reload", ["alpha"], "night-shift", "lead", true);

  expect(calls).toEqual([
    ["clear_reload", ["alpha"], "night-shift", "lead", {}, { excludeSupervisor: false, contextDepositId: "0123456789abcdef" }],
    ["clear_reload", ["alpha"], "night-shift", "lead", {}, { excludeSupervisor: true }]
  ]);
});

test("createDirectiveBindings invokes the card executor and deck adapter with its shared deps", () => {
  const deps = {} as DirectiveRunDeps;
  const item = { id: "card-1", title: "reset", directive: "clear", target_peer_ids: ["alpha"] };
  const cardResult = Promise.resolve({
    id: "card-1", title: "reset", directive: "clear" as RoadmapDirective, injected: [], unreached: []
  });
  const deckResult = Promise.resolve({ injected: [], refused: [], pending: [], unreached: [] });
  const cardCalls: unknown[][] = [];
  const adapterDeps: DirectiveRunDeps[] = [];
  const deckCalls: unknown[][] = [];
  const execute: typeof executeDirectiveItem = (receivedItem, receivedDeps) => {
    cardCalls.push([receivedItem, receivedDeps]);
    return cardResult;
  };
  const createAdapter: typeof directiveRun.createRunDirectiveAdapter = (receivedDeps) => {
    adapterDeps.push(receivedDeps);
    return (...args) => {
      deckCalls.push(args);
      return deckResult;
    };
  };

  const bindings = createDirectiveBindings(deps, execute, createAdapter);

  expect(bindings.executeDirective(item)).toBe(cardResult);
  expect(bindings.runDirective("clear", ["alpha"], undefined, "team-lead-a1b2", true)).toBe(deckResult);
  expect(cardCalls).toEqual([[item, deps]]);
  expect(adapterDeps).toEqual([deps]);
  expect(deckCalls).toEqual([["clear", ["alpha"], undefined, "team-lead-a1b2", true]]);
});

test("runDirectiveOn excludes an asynchronously rejected injection from its injected targets", async () => {
  const r = recorder([session("t1", "alpha")]);
  const cause = new Error("terminal unavailable");
  r.deps.injectCommand = () => Promise.reject(cause);

  const result = await runDirectiveOn("clear", ["alpha"], undefined, "x", r.deps);

  expect(result).toEqual({
    injected: [],
    refused: [{ tileId: "t1", peerId: "alpha", reason: "error" }],
    pending: [],
    unreached: []
  });
  expect(r.errors).toEqual([{ message: 'directive injection failed for "alpha"', error: cause }]);
});

test("executeDirectiveItem rejects direct-only clear_reload cards before they can type /clear", async () => {
  const r = recorder([session("t1", "alpha")]);

  const result = await executeDirectiveItem(
    { id: "card-1", title: "Reload the lead", directive: "clear_reload", target_peer_ids: ["alpha"] },
    r.deps
  );

  expect(result).toEqual({ id: "card-1", title: "Reload the lead", directive: null, injected: [], unreached: [] });
  expect(r.typed).toEqual([]);
  expect(r.clearReload).toEqual([]);
  expect(r.errors).toEqual([{ message: 'directive card "Reload the lead" carries no valid command; skipped', error: undefined }]);
});

test("executeDirectiveItem reports a card injection refusal instead of an injected target", async () => {
  const r = recorder([session("t1", "alpha")]);
  r.deps.injectCommand = async () => "refused-modal";

  const result = await executeDirectiveItem(
    { id: "card-1", title: "Clear the team", directive: "clear", target_peer_ids: ["alpha"] },
    r.deps
  );

  expect(result).toEqual({
    id: "card-1",
    title: "Clear the team",
    directive: "clear",
    injected: [],
    refused: [{ tileId: "t1", peerId: "alpha", reason: "refused-modal" }],
    pending: [],
    unreached: []
  });
});

test("executeDirectiveItem reports an unresolved card injection as pending", async () => {
  const r = recorder([session("t1", "alpha")]);
  r.deps.injectCommand = () => new Promise<"written">(() => {});

  const result = await executeDirectiveItem(
    { id: "card-1", title: "Clear the team", directive: "clear", target_peer_ids: ["alpha"] },
    r.deps,
    { reportWaitMs: 20 }
  );

  expect(result).toEqual({
    id: "card-1",
    title: "Clear the team",
    directive: "clear",
    injected: [],
    refused: [],
    pending: [{ tileId: "t1", peerId: "alpha" }],
    unreached: []
  });
}, 500);

test("runDirectiveOn reports an unresolved injection as pending at the report deadline", async () => {
  const r = recorder([session("t1", "alpha")]);
  r.deps.injectCommand = () => new Promise<"written">(() => {});

  const result = await runDirectiveOn("clear", ["alpha"], undefined, "x", r.deps, { reportWaitMs: 20 });

  expect(result).toEqual({
    injected: [],
    refused: [],
    pending: [{ tileId: "t1", peerId: "alpha" }],
    unreached: []
  });
}, 500);

test("runDirectiveOn reports an asynchronous magic rejection as refused", async () => {
  const r = recorder([session("t1", "alpha")]);
  const cause = new Error("plugin unavailable");
  r.deps.runMagicCompact = () => Promise.reject(cause);

  const result = await runDirectiveOn("magic_compact", ["alpha"], undefined, "x", r.deps);

  expect(result).toEqual({
    injected: [],
    refused: [{ tileId: "t1", peerId: "alpha", reason: "error" }],
    pending: [],
    unreached: []
  });
  expect(r.errors).toEqual([{ message: 'magic_compact failed for "alpha"', error: cause }]);
});

test("index consumes both production directive bindings", () => {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf-8");
  expect(
    source,
    "index executeDirective must consume directiveBindings.executeDirective(item)"
  ).toContain("const executeDirective = async (item: RoadmapItem): Promise<DirectiveDispatch> => directiveBindings.executeDirective(item)");
  expect(source, "controlDeps.runDirective must consume directiveBindings.runDirective").toContain(
    "runDirective: directiveBindings.runDirective,"
  );
});
