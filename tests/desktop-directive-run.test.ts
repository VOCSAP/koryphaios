import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as directiveRun from "../desktop/src/main/directive-run";
import {
  createDirectiveBindings,
  executeDirectiveItem,
  parseRunDirectiveArgs,
  runDirectiveForCaller,
  runDirectiveOn,
  sanitizeDirectivePrompt,
  DIRECTIVE_PROMPT_MAX,
  type DirectiveRunDeps
} from "../desktop/src/main/directive-run";
import { DIRECTIVE_ACCEPTS_PROMPT, directiveCommands, isDirectiveCommand } from "../desktop/src/main/directive";
import { TOOLS } from "../server.ts";
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
  errors: { message: string; error: unknown }[];
  settle: () => Promise<void>;
}

function recorder(sessions: SessionRuntime[]): Recorder {
  const journal: string[] = [];
  const typed: { tileId: string; keys: string }[] = [];
  const magic: { tileId: string; peerId: string; useMagic: boolean; mode: string }[] = [];
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
      return Promise.resolve();
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
  for (const directive of directiveCommands()) {
    const card = recorder(LIVE());
    const cardResult = executeDirectiveItem(
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
    const launched =
      directive === "magic_compact"
        ? { injected: [], pending: cardResult.injected }
        : { injected: cardResult.injected, pending: [] };
    expect(toolResult, directive).toEqual({ ...launched, refused: [], unreached: cardResult.unreached });
  }
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
  const out = runDirectiveOn("clear", ["alpha", "twin", "gone"], undefined, "x", r.deps);
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
  runDirectiveOn("compact", ["alpha"], "keep the API decisions", "x", r.deps);
  await r.settle();
  expect(r.typed).toEqual([{ tileId: "t1", keys: "/compact keep the API decisions" }]);
  expect(r.journal).toEqual(['directive /compact -> "alpha": written']);
});

test("an invalid card directive is refused before any resolution, with nothing typed", async () => {
  const r = recorder(LIVE());
  const out = executeDirectiveItem(
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

test("the accepted directive set is the one roadmap_add and roadmap_update accept for directive cards", () => {
  const schemaEnum = (name: string): string[] => {
    const tool = TOOLS.find((t) => t.name === name) as
      | { inputSchema: { properties: { directive?: { enum?: string[] } } } }
      | undefined;
    const e = tool?.inputSchema.properties.directive?.enum;
    if (!e) throw new Error(`${name} carries no directive enum`);
    return [...e].sort();
  };
  const accepted = directiveCommands().sort();
  expect(accepted).toEqual(schemaEnum("roadmap_add"));
  expect(accepted).toEqual(schemaEnum("roadmap_update"));
  for (const d of accepted) expect(parseRunDirectiveArgs({ directive: d, peer_ids: ["alpha"] }).directive).toBe(d);
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

test("runDirectiveOn returns a clean error when a dependency throws", () => {
  for (const name of ["listSessions", "resolveMagic"] as const) {
    const r = recorder(LIVE());
    const cause = new Error(`${name} failed`);
    let run: () => unknown;
    if (name === "listSessions") {
      r.deps.listSessions = () => { throw cause; };
      run = () => runDirectiveOn("clear", ["alpha"], undefined, "x", r.deps);
    } else {
      r.deps.resolveMagic = () => { throw cause; };
      run = () => runDirectiveOn("magic_compact", ["alpha"], undefined, "x", r.deps);
    }
    let result: unknown;
    expect(() => {
      result = run();
    }, name).not.toThrow();
    expect(result, name).toEqual({ injected: [], unreached: [], error: "directive execution failed" });
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

  const result = runDirectiveOn("clear", ["alpha", "beta"], undefined, "x", r.deps);
  expect(result).toEqual({
    injected: [{ tileId: "first", peerId: "alpha" }],
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

test("createDirectiveBindings invokes the card executor and deck adapter with its shared deps", () => {
  const deps = {} as DirectiveRunDeps;
  const item = { id: "card-1", title: "reset", directive: "clear", target_peer_ids: ["alpha"] };
  const cardResult = { id: "card-1", title: "reset", directive: "clear" as RoadmapDirective, injected: [], unreached: [] };
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

test("runDirectiveOn reports the original asynchronous injection rejection after dispatch", async () => {
  const r = recorder([session("t1", "alpha")]);
  const cause = new Error("terminal unavailable");
  r.deps.injectCommand = () => Promise.reject(cause);

  const result = runDirectiveOn("clear", ["alpha"], undefined, "x", r.deps);
  await r.settle();

  expect(result).toEqual({ injected: [{ tileId: "t1", peerId: "alpha" }], unreached: [] });
  expect(r.errors).toEqual([{ message: 'directive injection failed for "alpha"', error: cause }]);
});

test("runDirectiveOn reports the original asynchronous magic rejection after dispatch", async () => {
  const r = recorder([session("t1", "alpha")]);
  const cause = new Error("plugin unavailable");
  r.deps.runMagicCompact = () => Promise.reject(cause);

  const result = runDirectiveOn("magic_compact", ["alpha"], undefined, "x", r.deps);
  await r.settle();

  expect(result).toEqual({ injected: [{ tileId: "t1", peerId: "alpha" }], unreached: [] });
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
