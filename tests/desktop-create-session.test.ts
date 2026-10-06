import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractBracedBody, extractParenBody } from "./_braced-body";
import type { CreateSessionInput, SessionRuntime } from "../desktop/src/shared/types";
import {
  createSessionWithWorktree,
  gateSandboxForCwds,
  restartSessionGated,
  type CreateSessionDeps
} from "../desktop/src/main/create-session";
import type { SessionService } from "../desktop/src/main/session-service";

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

// ----- call-site wiring: the type makes the deps required, these scans pin
// WHICH deps each spawn site hands over.

const MAIN_DIR = join(import.meta.dir, "..", "desktop", "src", "main");
const IPC_SRC = readFileSync(join(MAIN_DIR, "ipc.ts"), "utf-8");
const INDEX_SRC = readFileSync(join(MAIN_DIR, "index.ts"), "utf-8");

function ipcHandler(channel: string): string {
  const anchor = `regHandle('${channel}'`;
  const at = IPC_SRC.indexOf(anchor);
  if (at < 0) throw new Error(`ipc.ts: ${anchor} not found -- renamed or reshaped?`);
  return extractParenBody(IPC_SRC, at + "regHandle".length, true);
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
    /const ensureSupervisor = async \(\): Promise<SessionRuntime> => \{/,
    "ensureSupervisor"
  );
  expect(count(IPC_SRC, "service.restart("), "ipc.ts restarts a tile without the sandbox gate").toBe(0);
  expect(
    count(INDEX_SRC, "service.restart("),
    "index.ts restarts a tile without the sandbox gate outside ensureSupervisor"
  ).toBe(count(supervisorBody, "service.restart("));
});

test("workspace:restore gates the sandbox before restoring any session", () => {
  const body = ipcHandler("workspace:restore");
  const gate = body.indexOf("gateSandboxForCwds(");
  const restore = body.indexOf("workspaces.restore(");
  expect(gate, "workspace:restore no longer calls gateSandboxForCwds").toBeGreaterThanOrEqual(0);
  expect(restore, "workspace:restore no longer calls workspaces.restore").toBeGreaterThanOrEqual(0);
  expect(gate < restore, "workspace:restore respawns sessions before the sandbox gate").toBe(true);
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

test("sessions:create strips a caller-supplied supervisor flag before spawning", () => {
  const body = ipcHandler("sessions:create");
  const strip = /const \{\s*supervisor:\s*\w+,\s*\.\.\.(\w+)\s*\}\s*=\s*input/.exec(body);
  expect(strip, "sessions:create forwards input.supervisor, which exempts a tile from the sandbox").not.toBeNull();
  expect(
    new RegExp(`createSessionWithWorktree\\(\\s*service,\\s*getConfig\\(\\)\\.projectDir,\\s*${strip![1]}\\s*,`).test(body),
    "sessions:create spawns from the unstripped input"
  ).toBe(true);
});
