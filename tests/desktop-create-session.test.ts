import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractBracedBody, extractParenBody, findMatchingClose } from "./_braced-body";
import type { CreateSessionInput, SessionRuntime } from "../desktop/src/shared/types";
import {
  createSessionWithWorktree,
  gateSandboxForCwds,
  restartSessionGated,
  SESSION_FIELDS,
  stripMainOnlySessionFields,
  type CreateSessionDeps
} from "../desktop/src/main/create-session";
import type { SessionService } from "../desktop/src/main/session-service";
import { LaunchAttemptRegistry, prepareLaunchModPlan, type LaunchModPlan } from "../desktop/src/main/mod-launch-plan";
import { reachedWithin } from "./_bounded-await";

const NO_SANDBOX: CreateSessionDeps = {
  sandboxGate: async () => null,
  warmSandboxTranscripts: async () => {}
};

async function rejection(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the call to reject, it resolved");
}

const PROJECT = resolve("/proj");
const CLONE = resolve("/sandbox/copy/proj");

function recordingService(sessions: Partial<SessionRuntime>[] = [], log: string[] = []) {
  const created: CreateSessionInput[] = [];
  const service = {
    create(input: CreateSessionInput) {
      log.push(`create:${input.cwd ?? ""}`);
      created.push(input);
      return {} as SessionRuntime;
    },
    list: () => sessions as SessionRuntime[],
    restart(id: string) {
      log.push(`restart:${id}`);
      return Promise.resolve({} as SessionRuntime);
    }
  } as unknown as SessionService;
  return { service, created, log };
}

function copyModeDeps(log: string[]): CreateSessionDeps {
  return {
    sandboxGate: async () => {
      log.push("gate");
      return CLONE;
    },
    warmSandboxTranscripts: async (cwd) => {
      log.push(`warm:${cwd}`);
    }
  };
}

function plan(attemptId: string): LaunchModPlan {
  return { attemptId, mode: "host", modDirs: ["/mods/readable"], diagnostics: [] };
}

test("createSessionWithWorktree forwards the trusted embedded role option", async () => {
  let receivedOpts: { teamLeadDeckBridge?: boolean; hasDeckLeadTools?: boolean } | undefined;
  const service = {
    create(_input: CreateSessionInput, opts?: { teamLeadDeckBridge?: boolean; hasDeckLeadTools?: boolean }) {
      receivedOpts = opts;
      return {} as SessionRuntime;
    }
  } as unknown as SessionService;

  await createSessionWithWorktree(service, "/project", {}, NO_SANDBOX, { hasDeckLeadTools: true });

  expect(receivedOpts).toEqual({ hasDeckLeadTools: true });
});

test("a tile spawn runs the gate, then warms the cwd the session will actually run in, then creates", async () => {
  const log: string[] = [];
  const { service } = recordingService([], log);
  await createSessionWithWorktree(service, PROJECT, { cwd: resolve("/proj-wt/x") }, copyModeDeps(log));
  expect(log).toEqual(["gate", `warm:${CLONE}`, `create:${CLONE}`]);
});

test("a cwd already inside the sandbox copy is kept and warmed as is", async () => {
  const log: string[] = [];
  const { service } = recordingService([], log);
  const inside = resolve("/sandbox/copy/proj/sub");
  await createSessionWithWorktree(service, PROJECT, { cwd: inside }, copyModeDeps(log));
  expect(log).toEqual(["gate", `warm:${inside}`, `create:${inside}`]);
});

test("the supervisor spawns without the sandbox gate or the transcript warm", async () => {
  const log: string[] = [];
  const { service } = recordingService([], log);
  await createSessionWithWorktree(service, PROJECT, { supervisor: true }, copyModeDeps(log));
  expect(log).toEqual(["create:"]);
});

test("a failing sandbox gate stops the spawn before anything is created", async () => {
  const { service, created } = recordingService();
  const deps: CreateSessionDeps = {
    sandboxGate: async () => {
      throw new Error("sandbox-auth-required");
    },
    warmSandboxTranscripts: async () => {}
  };
  expect(await rejection(createSessionWithWorktree(service, PROJECT, {}, deps))).toBe("sandbox-auth-required");
  expect(created).toEqual([]);
});

test("cwdOutsideRoot 'refuse' throws naming both dirs instead of relocating the session", async () => {
  const log: string[] = [];
  const { service, created } = recordingService([], log);
  const hostWorktree = resolve("/proj-wt/x");
  const run = createSessionWithWorktree(service, PROJECT, { cwd: hostWorktree }, {
    ...copyModeDeps(log),
    cwdOutsideRoot: "refuse"
  });
  const message = await rejection(run);
  expect(message).toContain(hostWorktree);
  expect(message).toContain(CLONE);
  expect(created).toEqual([]);
});

test("cwdOutsideRoot 'refuse' still accepts a cwd inside the copy and leaves mount mode untouched", async () => {
  const log: string[] = [];
  const { service, created } = recordingService([], log);
  const inside = resolve("/sandbox/copy/proj/sub");
  await createSessionWithWorktree(service, PROJECT, { cwd: inside }, { ...copyModeDeps(log), cwdOutsideRoot: "refuse" });
  const outside = resolve("/elsewhere");
  await createSessionWithWorktree(service, PROJECT, { cwd: outside }, {
    sandboxGate: async () => PROJECT,
    warmSandboxTranscripts: async () => {},
    cwdOutsideRoot: "refuse"
  });
  expect(created.map((c) => c.cwd)).toEqual([inside, outside]);
});

test("createSessionWithWorktree prepares its mod plan before calling service.create", async () => {
  const log: string[] = [];
  let receivedPlan: LaunchModPlan | undefined;
  const service = {
    create(_input: CreateSessionInput, opts?: { modPlan?: LaunchModPlan }) {
      log.push("create");
      receivedPlan = opts?.modPlan;
      return {} as SessionRuntime;
    }
  } as unknown as SessionService;
  const registry = new LaunchAttemptRegistry();

  await createSessionWithWorktree(service, PROJECT, {}, {
    ...NO_SANDBOX,
    modLaunch: {
      attemptKey: "new:tile",
      registry,
      prepare: async (attempt) => {
        log.push(`prepare:${attempt.attemptId}`);
        return plan(attempt.attemptId);
      }
    }
  });

  expect(log).toEqual(["prepare:1", "create"]);
  expect(receivedPlan).toEqual(plan("1"));
});

test("a mod switch flipped while a launch prepares leaves that launch its selection, and the next launch reads the new one", async () => {
  const config = { enabledMods: { alpha: true, beta: true } as Record<string, boolean> };
  const lock = new Map([["alpha", "a".repeat(64)], ["beta", "b".repeat(64)]]);
  let releaseCopies: () => void = () => {};
  const copiesMayFinish = new Promise<void>((resolve) => { releaseCopies = resolve; });
  let markBuilding: () => void = () => {};
  const building = new Promise<void>((resolve) => { markBuilding = resolve; });
  const deps = {
    enabledModsFromLock: (current: typeof config) => Object.entries(current.enabledMods).filter(([, on]) => on === true).map(([name]) => name),
    ensureModWorkingCopy: async ({ plugin }: { plugin: string }) => {
      markBuilding();
      await copiesMayFinish;
      return { ok: true as const, dir: `/host/${plugin}` };
    },
    verifyHostCopy: () => ({ ok: true as const })
  };
  const received: Array<LaunchModPlan | undefined> = [];
  const service = {
    create(_input: CreateSessionInput, opts?: { modPlan?: LaunchModPlan }) {
      received.push(opts?.modPlan);
      return {} as SessionRuntime;
    }
  } as unknown as SessionService;
  const registry = new LaunchAttemptRegistry();
  const launchDeps = (attemptKey: string): CreateSessionDeps => ({
    ...NO_SANDBOX,
    modLaunch: {
      attemptKey,
      registry,
      prepare: (attempt) =>
        prepareLaunchModPlan(deps, { sandboxed: false, config, lock, workRoot: "/work", distDir: "/dist", signal: attempt.signal, attemptId: attempt.attemptId })
    }
  });
  const modDirsOf = (plan: LaunchModPlan | undefined): readonly string[] | undefined => (plan && "modDirs" in plan ? plan.modDirs : undefined);

  const inFlight = createSessionWithWorktree(service, PROJECT, {}, launchDeps("new:first"));
  await reachedWithin(building, "the first launch reaching its first working copy");
  config.enabledMods = { alpha: true, beta: false };
  releaseCopies();
  await inFlight;
  await createSessionWithWorktree(service, PROJECT, {}, launchDeps("new:second"));

  expect(modDirsOf(received[0]), "the launch already preparing keeps the selection it started with").toEqual(["/host/alpha", "/host/beta"]);
  expect(modDirsOf(received[1]), "the next launch reads the switched selection").toEqual(["/host/alpha"]);
});

test("createSessionWithWorktree rejects a plan cancelled while the sandbox gate awaits", async () => {
  const { service, created } = recordingService();
  const registry = new LaunchAttemptRegistry();
  let releaseGate: (value: string | null) => void = () => {};
  const gate = new Promise<string | null>((resolve) => { releaseGate = resolve; });

  const run = createSessionWithWorktree(service, PROJECT, {}, {
    sandboxGate: async () => gate,
    warmSandboxTranscripts: async () => {},
    modLaunch: { registry, prepare: async (attempt) => plan(attempt.attemptId) }
  });
  registry.cancelAll();
  releaseGate(null);

  expect(await rejection(run)).toBe("mod launch superseded");
  expect(created).toEqual([]);
});

test("createSessionWithWorktree rejects a plan cancelled while beforeSpawn awaits", async () => {
  const { service, created } = recordingService();
  const registry = new LaunchAttemptRegistry();
  let releaseBeforeSpawn: () => void = () => {};
  const beforeSpawn = new Promise<void>((resolve) => { releaseBeforeSpawn = resolve; });
  let markBeforeSpawn: () => void = () => {};
  const reachedBeforeSpawn = new Promise<void>((resolve) => { markBeforeSpawn = resolve; });

  const run = createSessionWithWorktree(service, PROJECT, {}, {
    sandboxGate: async () => null,
    warmSandboxTranscripts: async () => {},
    beforeSpawn: async () => {
      markBeforeSpawn();
      await beforeSpawn;
    },
    modLaunch: { registry, prepare: async (attempt) => plan(attempt.attemptId) }
  });
  await reachedBeforeSpawn;
  registry.cancelAll();
  releaseBeforeSpawn();

  expect(await rejection(run)).toBe("mod launch superseded");
  expect(created).toEqual([]);
});

test("createSessionWithWorktree rejects a plan superseded while preparation awaited", async () => {
  const { service, created } = recordingService();
  const registry = {
    begin: () => ({ attemptId: "1", signal: new AbortController().signal }),
    isCurrent: () => false,
    complete: () => {}
  } as unknown as LaunchAttemptRegistry;
  const run = createSessionWithWorktree(service, PROJECT, {}, {
    ...NO_SANDBOX,
    modLaunch: {
      attemptKey: "new:tile",
      registry,
      prepare: async () => plan("1")
    }
  });

  expect(await rejection(run)).toBe("mod launch superseded");
  expect(created).toEqual([]);
});

test("restartSessionGated joins concurrent mod plan preparation for one tile", async () => {
  const log: string[] = [];
  const { service } = recordingService([{ id: "t1", cwd: "/wt/t1" }], log);
  const registry = new LaunchAttemptRegistry();
  let prepares = 0;
  const deps = {
    ...copyModeDeps(log),
    modLaunch: {
      registry,
      prepare: async (attempt: { attemptId: string }) => {
        prepares += 1;
        await Promise.resolve();
        return plan(attempt.attemptId);
      }
    }
  };

  await Promise.all([restartSessionGated(service, "t1", deps), restartSessionGated(service, "t1", deps)]);

  expect(prepares).toBe(1);
});

test("restartSessionGated keeps concurrent restarts joined through restart cleanup", async () => {
  let prepares = 0;
  let releaseRestart: (value: SessionRuntime) => void = () => {};
  const restarted = new Promise<SessionRuntime>((resolve) => { releaseRestart = resolve; });
  let markRestart: () => void = () => {};
  const restartStarted = new Promise<void>((resolve) => { markRestart = resolve; });
  const service = {
    list: () => [{ id: "t1", cwd: "/wt/t1", supervisor: true }] as SessionRuntime[],
    restart: async () => {
      markRestart();
      return restarted;
    }
  } as unknown as SessionService;
  const registry = new LaunchAttemptRegistry();
  const deps = {
    ...NO_SANDBOX,
    modLaunch: {
      registry,
      prepare: async (attempt: { attemptId: string }) => {
        prepares += 1;
        return plan(attempt.attemptId);
      }
    }
  };

  const first = restartSessionGated(service, "t1", deps);
  await restartStarted;
  const second = restartSessionGated(service, "t1", deps);
  expect(prepares).toBe(1);
  releaseRestart({} as SessionRuntime);
  await Promise.all([first, second]);
});

test("gateSandboxForCwds fails before warming anything when the sandbox is not authenticated", async () => {
  const warmed: string[] = [];
  const run = gateSandboxForCwds(["/a", "/b"], {
    sandboxGate: async () => {
      throw new Error("sandbox-auth-required");
    },
    warmSandboxTranscripts: async (cwd) => {
      warmed.push(cwd);
    }
  });
  expect(await rejection(run)).toBe("sandbox-auth-required");
  expect(warmed).toEqual([]);
});

test("restartSessionGated gates and warms the tile's cwd before the respawn", async () => {
  const log: string[] = [];
  const { service } = recordingService([{ id: "t1", cwd: "/wt/t1" }], log);
  await restartSessionGated(service, "t1", copyModeDeps(log));
  expect(log).toEqual(["gate", "warm:/wt/t1", "restart:t1"]);
});

test("restartSessionGated does not respawn when the gate refuses", async () => {
  const log: string[] = [];
  const { service } = recordingService([{ id: "t1", cwd: "/wt/t1" }], log);
  const run = restartSessionGated(service, "t1", {
    sandboxGate: async () => {
      throw new Error("sandbox: container not ready");
    },
    warmSandboxTranscripts: async () => {}
  });
  expect(await rejection(run)).toBe("sandbox: container not ready");
  expect(log).toEqual([]);
});

test("restartSessionGated restarts the supervisor without the sandbox gate", async () => {
  const log: string[] = [];
  const { service } = recordingService([{ id: "sup", cwd: "/proj", supervisor: true }], log);
  await restartSessionGated(service, "sup", copyModeDeps(log));
  expect(log).toEqual(["restart:sup"]);
});

test("gateSandboxForCwds warms every cwd it is given, in order", async () => {
  const warmed: string[] = [];
  await gateSandboxForCwds(["/a", "/b"], {
    sandboxGate: async () => null,
    warmSandboxTranscripts: async (cwd) => {
      warmed.push(cwd);
    }
  });
  expect(warmed).toEqual(["/a", "/b"]);
});

const MAIN_DIR = join(import.meta.dir, "..", "desktop", "src", "main");
const IPC_SRC = readFileSync(join(MAIN_DIR, "ipc.ts"), "utf-8");
const INDEX_SRC = readFileSync(join(MAIN_DIR, "index.ts"), "utf-8");

function ipcHandler(channel: string): string {
  const anchor = `regHandle('${channel}'`;
  const at = IPC_SRC.indexOf(anchor);
  if (at < 0) throw new Error(`ipc.ts: ${anchor} not found -- renamed or reshaped?`);
  return extractParenBody(IPC_SRC, at + "regHandle".length, true);
}

function ipcCode(source: string): string {
  return new Bun.Transpiler({ loader: "ts" }).transformSync(source);
}

function workspaceRestoreDeps(source: string): string {
  const code = ipcCode(source);
  const anchor = "registerWorkspaceRestoreHandler(regHandle,";
  const at = code.indexOf(anchor);
  if (at < 0) throw new Error("ipc.ts: workspace restore registration is unavailable");
  const open = code.indexOf("{", at + anchor.length);
  if (open < 0) throw new Error("ipc.ts: workspace restore dependencies are unavailable");
  return extractBracedBody(code, open, true);
}

function registerIpcParts(source: string): { params: string; body: string } {
  const code = ipcCode(source);
  const at = code.indexOf("function registerIpc(");
  if (at < 0) throw new Error("ipc.ts: registerIpc is unavailable");
  const openParams = code.indexOf("(", at);
  const closeParams = findMatchingClose(code, openParams, "(", ")", true);
  const openBody = code.indexOf("{", closeParams);
  if (openBody < 0) throw new Error("ipc.ts: registerIpc body is unavailable");
  return { params: extractParenBody(code, openParams, true), body: extractBracedBody(code, openBody, true) };
}

function importsProductionGate(source: string): boolean {
  return /import\s*\{[^}]*\bgateSandboxForCwds\b(?!\s+as\s+\w+)[^}]*\}\s*from\s*['"]\.\/create-session['"]/.test(source);
}

function hasGateShadow(source: string): boolean {
  const { params, body } = registerIpcParts(source);
  return /\bgateSandboxForCwds\b/.test(params) ||
    /\b(?:const|let|var|function)\s+gateSandboxForCwds\b/.test(body) ||
    /\bfunction(?:\s+\w+)?\s*\([^()\n]*\bgateSandboxForCwds\b[^()\n]*\)|\([^()\n]*\bgateSandboxForCwds\b[^()\n]*\)\s*=>|\bgateSandboxForCwds\s*=>/.test(body);
}

function indexBracedBody(anchor: RegExp, label: string): string {
  const m = anchor.exec(INDEX_SRC);
  if (!m) throw new Error(`index.ts: ${label} not found -- renamed or reshaped?`);
  return extractBracedBody(INDEX_SRC, m.index + m[0].length - 1, true);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("sessions:restart respawns through restartSessionGated, never service.restart directly", () => {
  const body = ipcHandler("sessions:restart");
  expect(body.includes("restartSessionGated("), "sessions:restart must go through the sandbox gate").toBe(true);
  expect(body.includes("service.restart("), "sessions:restart bypasses the sandbox gate").toBe(false);
});

test("deck-control's restartSession respawns through restartSessionGated", () => {
  const body = indexBracedBody(/restartSession:\s*async\s*\(id\)\s*=>\s*\{/, "restartSession");
  expect(body.includes("restartSessionGated("), "deck_restart_session must go through the sandbox gate").toBe(true);
});

test("no spawn path calls service.restart( outside ensureSupervisor (the one sandbox-exempt tile)", () => {
  const supervisorBody = indexBracedBody(
    /const ensureSupervisor = async \([^)]*\): Promise<SessionRuntime \| null> => \{/,
    "ensureSupervisor"
  );
  expect(count(IPC_SRC, "service.restart("), "ipc.ts restarts a tile without the sandbox gate").toBe(0);
  expect(
    count(INDEX_SRC, "service.restart("),
    "index.ts restarts a tile without the sandbox gate outside ensureSupervisor"
  ).toBe(count(supervisorBody, "service.restart("));
});

test("workspace:restore gates the sandbox before restoring any session", () => {
  const productionGate = (deps: string) => /^\s*gateSandboxForCwds\s*,?$/m.test(deps);
  const registerIpc = (params = "", body = "") => `function registerIpc(${params}) { ${body} }`;
  expect(importsProductionGate(IPC_SRC)).toBe(true);
  expect(hasGateShadow(IPC_SRC)).toBe(false);
  expect(productionGate(workspaceRestoreDeps(IPC_SRC))).toBe(true);
  expect(productionGate(workspaceRestoreDeps("registerWorkspaceRestoreHandler(regHandle, { gateSandboxForCwds })"))).toBe(true);
  expect(productionGate(workspaceRestoreDeps("registerWorkspaceRestoreHandler(regHandle, { /* gateSandboxForCwds */ })"))).toBe(false);
  expect(productionGate(workspaceRestoreDeps("registerWorkspaceRestoreHandler(regHandle, { gateSandboxForCwds: async () => {} })"))).toBe(false);
  expect(hasGateShadow(registerIpc("", "const gateSandboxForCwds = async () => {}"))).toBe(true);
  expect(hasGateShadow(registerIpc("gateSandboxForCwds", ""))).toBe(true);
});

test("diff:review refuses a cwd outside the sandbox copy instead of relocating the reviewer", () => {
  expect(
    /cwdOutsideRoot:\s*'refuse'/.test(ipcHandler("diff:review")),
    "diff:review would silently review the clone root instead of the requested dir"
  ).toBe(true);
});

test("template:apply gates once with the real sandboxGate, before 'replace' clears the grid, and hands that root to every tile", () => {
  const body = ipcHandler("template:apply");
  const gateCall = /const sandboxRoot = [^\n]*await sandboxGate\(\)/.exec(body);
  expect(gateCall, "template:apply no longer runs the real sandbox gate for the batch").not.toBeNull();
  expect(
    gateCall!.index < body.indexOf("if (mode === 'replace')"),
    "template:apply clears the grid before the sandbox gate can refuse"
  ).toBe(true);
  expect(
    /sandboxGate:\s*async \(\) => sandboxRoot\b/.test(body),
    "template:apply tiles do not receive the batch's gated root"
  ).toBe(true);
});

test("stripMainOnlySessionFields removes the six main-only fields, keeps the rest and keeps an adopted worktree", () => {
  const hostile: CreateSessionInput = {
    name: "tile",
    agent: "team-lead",
    prompt: "p",
    args: "--x",
    worktree: { path: "C:/repo/.worktrees/feature", branch: "feature" },
    supervisor: true,
    strictMcpConfig: true,
    disallowedTools: ["Bash"],
    mcpConfig: "C:/elsewhere/mcp.json",
    appendSystemPromptFile: "C:/elsewhere/prompt.md",
    peerTools: ["list_peers"]
  };
  const stripped = stripMainOnlySessionFields(hostile);
  for (const field of ["supervisor", "strictMcpConfig", "disallowedTools", "mcpConfig", "appendSystemPromptFile", "peerTools"]) {
    expect(stripped, `${field} survived the strip`).not.toHaveProperty(field);
  }
  expect(stripped, "WorktreesView adopts an existing worktree by sending it").toEqual({
    name: "tile",
    agent: "team-lead",
    prompt: "p",
    args: "--x",
    worktree: { path: "C:/repo/.worktrees/feature", branch: "feature" }
  });
  expect(hostile.mcpConfig, "the caller's own object was mutated").toBe("C:/elsewhere/mcp.json");
  expect(stripMainOnlySessionFields(undefined)).toEqual({});
});

test("the fields stripped from a session request are exactly the CreateSessionInput fields the shared types annotate as main-only", () => {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "shared", "types.ts"), "utf-8");
  const head = source.indexOf("export interface CreateSessionInput");
  expect(head, "CreateSessionInput is no longer declared in the shared types").toBeGreaterThanOrEqual(0);
  const body = extractBracedBody(source, source.indexOf("{", head));
  const documented = new Map<string, string>();
  let comment: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const field = /^ {2}(\w+)\??:/.exec(line);
    if (field) {
      documented.set(field[1]!, comment.join(" "));
      comment = [];
    } else if (/^\s*(\/\*\*|\*)/.test(line)) {
      comment.push(line.trim());
    }
  }
  expect(
    [...documented.keys()].sort(),
    "the scan of CreateSessionInput in types.ts missed a field (declared as readonly or at another indentation) or SESSION_FIELD_ORIGIN lists one the interface lacks"
  ).toEqual([...SESSION_FIELDS].sort());
  const annotated = [...documented]
    .filter(([, text]) => /MAIN-only|strips it from the renderer's request/.test(text))
    .map(([name]) => name)
    .sort();
  expect(annotated.length, "no field is annotated main-only: the scan matches nothing").toBeGreaterThan(0);
  const everyField = Object.fromEntries([...documented.keys()].map((name) => [name, "x"]));
  const kept = Object.keys(stripMainOnlySessionFields(everyField as unknown as CreateSessionInput));
  const stripped = [...documented.keys()].filter((name) => !kept.includes(name)).sort();
  expect(
    stripped,
    "a field is stripped but not annotated main-only in types.ts, or annotated main-only but still passes the strip"
  ).toEqual(annotated);
});

test("sessions:create spawns from the stripped input", () => {
  const body = ipcHandler("sessions:create");
  const strip = /const (\w+) = stripMainOnlySessionFields\(input\)/.exec(body);
  expect(strip, "sessions:create forwards the whole input").not.toBeNull();
  expect(
    new RegExp(`createSessionWithWorktree\\(\\s*service,\\s*getConfig\\(\\)\\.projectDir,\\s*${strip![1]}\\s*,`).test(body),
    "sessions:create spawns from the unstripped input"
  ).toBe(true);
});
