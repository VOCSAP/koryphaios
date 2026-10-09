import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");
const SHARED = join(import.meta.dir, "..", "desktop", "src", "shared");

for (const name of ["session-status", "palette", "role", "reorder", "workflow", "announce", "types"]) {
  mock.module(`@shared/${name}`, () => require(join(SHARED, `${name}.ts`)));
}

type SessionDataListener = (data: string) => void;
type SessionExitListener = (event: { exitCode: number }) => void;

interface SessionFakePty {
  pid: number;
  killCalls: number;
  output(data: string): void;
  exit(code?: number): void;
}

const sessionPtys: SessionFakePty[] = [];
let nextSessionPid = 40_000;

mock.module("node-pty", () => ({
  spawn() {
    let onData: SessionDataListener | null = null;
    let onExit: SessionExitListener | null = null;
    const proc: SessionFakePty & Record<string, unknown> = {
      pid: nextSessionPid++,
      killCalls: 0,
      output: (data: string) => onData?.(data),
      exit: (exitCode = 0) => onExit?.({ exitCode }),
      onData: (listener: SessionDataListener) => {
        onData = listener;
        return { dispose() {} };
      },
      onExit: (listener: SessionExitListener) => {
        onExit = listener;
        return { dispose() {} };
      },
      write() {},
      resize() {},
      kill() {
        this.killCalls++;
      }
    };
    sessionPtys.push(proc);
    return proc;
  }
}));

mock.module(join(import.meta.dir, "..", "desktop", "src", "main", "store.ts"), () => ({
  saveSessions: () => {},
  loadConfig: () => ({}),
  saveConfig: () => {},
  DEFAULT_CONFIG: {}
}));

const { SessionService } = await import("../desktop/src/main/session-service.ts");

function extractBody(source: string, signature: RegExp, label: string): string {
  const matches = source.match(new RegExp(signature.source, signature.flags.includes("g") ? signature.flags : signature.flags + "g")) ?? [];
  if (matches.length !== 1) throw new Error(`${label} extraction matched ${matches.length} declarations`);
  const match = signature.exec(source);
  if (!match) throw new Error(`${label} was not found`);
  return extractBracedBody(source, match.index + match[0].length - 1, true);
}

function interrupt(id: string, mode: "pause" | "hard", self: object): string {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = extractBody(
    source,
    /interrupt\(id: string, mode: 'pause' \| 'hard'\): 'interrupted' \| 'no-terminal' \| 'refused-modal' \{/,
    "interrupt()"
  );
  const run = new Function("id", "mode", "logInfo", body) as (this: object, id: string, mode: "pause" | "hard", logInfo: () => void) => string;
  return run.call(self, id, mode, () => {});
}

class Timers {
  private readonly callbacks = new Map<number, Array<() => void>>();

  setTimeout(callback: () => void, delay: number): { unref(): void } {
    const scheduled = this.callbacks.get(delay) ?? [];
    scheduled.push(callback);
    this.callbacks.set(delay, scheduled);
    return { unref: () => {} };
  }

  fire(delay: number): void {
    const callbacks = this.callbacks.get(delay) ?? [];
    this.callbacks.delete(delay);
    for (const callback of callbacks) callback();
  }
}

function autoResume(id: string, self: object, timers: Timers): void {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = extractBody(source, /private autoResume\(id: string\): void \{/, "autoResume()");
  const run = new Function("id", "setTimeout", body) as (
    this: object,
    id: string,
    setTimeout: Timers["setTimeout"]
  ) => void;
  run.call(self, id, timers.setTimeout.bind(timers));
}

function startupAck(id: string, self: object, timers: Timers): void {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = extractBody(
    source,
    /this\.startupAckDetector\.on\('ack', \(\{ id \}: StartupAckEvent\) => \{/,
    "startup ack handler"
  );
  const run = new Function(
    "id",
    "setTimeout",
    "STARTUP_ACK_SETTLE_MS",
    "PROMPT_INJECT_SETTLE_MS",
    "encodeInitialPromptKeystrokes",
    body
  ) as (
    this: object,
    id: string,
    setTimeout: Timers["setTimeout"],
    startupDelay: number,
    promptDelay: number,
    encodePrompt: (prompt: string) => string
  ) => void;
  run.call(self, id, timers.setTimeout.bind(timers), 10, 20, (prompt) => `<${prompt}>`);
}

test("interrupt reports no-terminal when a live PTY rejects Escape", () => {
  const self = {
    pty: { isAlive: () => true, write: () => false },
    screenGuard: { inspect: () => ({ state: "clear" }) },
    runtime: new Map()
  };

  expect(interrupt("tile", "hard", self)).toBe("no-terminal");
});

test("SessionService.write treats a rejected write as the terminal authority", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = extractBody(source, /write\(id: string, data: string\): void \{/, "write()");
  const run = new Function("id", "data", "reportError", body) as (
    this: object,
    id: string,
    data: string,
    reportError: (_scope: string, message: string) => void
  ) => void;
  const reports: string[] = [];
  const self = {
    pty: { write: () => false, isAlive: () => true },
    deadWriteReported: new Set<string>(),
    defs: [{ id: "tile", name: "Tile" }]
  };

  run.call(self, "tile", "input", (_scope, message) => reports.push(message));

  expect(reports).toEqual(['input dropped: session "Tile" has no live terminal']);
  expect(self.deadWriteReported.has("tile")).toBe(true);
});

test("SessionService.write reports a rejected write after the PTY has exited", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = extractBody(source, /write\(id: string, data: string\): void \{/, "write()");
  const run = new Function("id", "data", "reportError", body) as (
    this: object,
    id: string,
    data: string,
    reportError: (_scope: string, message: string) => void
  ) => void;
  const reports: string[] = [];
  const self = {
    pty: { write: () => false, isAlive: () => false },
    deadWriteReported: new Set<string>(),
    defs: [{ id: "tile", name: "Tile" }]
  };

  run.call(self, "tile", "input", (_scope, message) => reports.push(message));

  expect(reports).toEqual(['input dropped: session "Tile" has no live terminal']);
  expect(self.deadWriteReported.has("tile")).toBe(true);
});

test("autoResume emits no resumed event when any required write is rejected", () => {
  const cases = [
    { outcomes: [false], writes: ["\x1b"] },
    { outcomes: [true, false], writes: ["\x1b", "continue"] },
    { outcomes: [true, true, false], writes: ["\x1b", "continue", "\r"] }
  ];

  for (const { outcomes, writes: expectedWrites } of cases) {
    const timers = new Timers();
    const events: unknown[] = [];
    const writes: string[] = [];
    const self = {
      defs: [{ id: "tile", autoResume: true }],
      runtime: new Map([["tile", { rateLimited: true, resumeAt: 42 }]]),
      quotaGateActive: () => false,
      getConfig: () => ({ autoResumeQuota: true }),
      pty: {
        isAlive: () => true,
        write: (_id: string, data: string) => {
          writes.push(data);
          return outcomes.shift() ?? false;
        }
      },
      emit: (_event: string, payload: unknown) => events.push(payload)
    };

    autoResume("tile", self, timers);
    expect(events).toEqual([]);
    timers.fire(100);
    expect(writes).toEqual(expectedWrites);
    expect(events).toEqual([]);
  }
});

test("autoResume publishes resumed after Escape, continue and Return are accepted", () => {
  const timers = new Timers();
  const events: unknown[] = [];
  const self = {
    defs: [{ id: "tile", autoResume: true }],
    runtime: new Map([["tile", { rateLimited: true, resumeAt: 42 }]]),
    quotaGateActive: () => false,
    getConfig: () => ({ autoResumeQuota: true }),
    pty: { isAlive: () => true, write: () => true },
    emit: (_event: string, payload: unknown) => events.push(payload)
  };

  autoResume("tile", self, timers);
  expect(events).toEqual([]);
  timers.fire(100);
  expect(events).toEqual([{ id: "tile", limited: true, resetAt: 42, resumed: true }]);
});

test("startup acknowledgement leaves a pending prompt when Return is rejected", () => {
  const timers = new Timers();
  const events: unknown[] = [];
  const pendingPrompt = new Map([["tile", "hello"]]);
  const self = {
    attentionDetector: { purgeScreenMemory: () => {} },
    runtime: new Map([["tile", { status: "running" }]]),
    pty: { write: () => false },
    defs: [{ id: "tile", name: "Tile" }],
    emit: (_event: string, payload: unknown) => events.push(payload),
    pendingPrompt
  };

  startupAck("tile", self, timers);
  timers.fire(10);

  expect(events).toEqual([]);
  expect(pendingPrompt.get("tile")).toBe("hello");
});

test("startup acknowledgement retains a pending prompt after its deferred write is rejected", () => {
  const timers = new Timers();
  const events: unknown[] = [];
  const pendingPrompt = new Map([["tile", "hello"]]);
  let writes = 0;
  const self = {
    attentionDetector: { purgeScreenMemory: () => {} },
    runtime: new Map([["tile", { status: "running" }]]),
    pty: { write: () => ++writes === 1 },
    defs: [{ id: "tile", name: "Tile" }],
    emit: (_event: string, payload: unknown) => events.push(payload),
    pendingPrompt
  };

  startupAck("tile", self, timers);
  timers.fire(10);
  expect(events).toEqual([{ id: "tile", name: "Tile" }]);
  expect(pendingPrompt.get("tile")).toBe("hello");
  timers.fire(20);

  expect(pendingPrompt.get("tile")).toBe("hello");
});

test("startup acknowledgement deletes a pending prompt after its deferred write is accepted", () => {
  const timers = new Timers();
  const pendingPrompt = new Map([["tile", "hello"]]);
  const self = {
    attentionDetector: { purgeScreenMemory: () => {} },
    runtime: new Map([["tile", { status: "running" }]]),
    pty: { write: () => true },
    defs: [{ id: "tile", name: "Tile" }],
    emit: () => {},
    pendingPrompt
  };

  startupAck("tile", self, timers);
  timers.fire(10);
  expect(pendingPrompt.get("tile")).toBe("hello");
  timers.fire(20);

  expect(pendingPrompt.has("tile")).toBe(false);
});

test("SessionService restart does not replace a live PTY", async () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-restart-"));
  const cwd = join(home, "project");
  const service = new SessionService(
    () => ({ projectDir: cwd, shell: "powershell.exe", interactiveShell: false }),
    () => ({}),
    "claude",
    () => [],
    home
  );

  try {
    const initial = service.create({});
    const first = sessionPtys.at(-1)!;
    const restarted = await service.restart(initial.id);

    expect(sessionPtys).toHaveLength(1);
    expect(restarted.pid).toBe(first.pid);
    expect(service.list().find((runtime) => runtime.id === initial.id)!.pid).toBe(first.pid);
  } finally {
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionService.closeAll retries a retired PTY after its final definition is removed", async () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-close-all-"));
  const cwd = join(home, "project");
  const service = new SessionService(
    () => ({ projectDir: cwd, shell: "powershell.exe", interactiveShell: false }),
    () => ({}),
    "claude",
    () => [],
    home
  );

  try {
    const initial = service.create({});
    const first = sessionPtys.at(-1)!;
    const runtime = (service as unknown as { runtime: Map<string, { needsAttention: boolean }> }).runtime.get(initial.id)!;
    runtime.needsAttention = true;

    await service.remove(initial.id);
    expect(service.list()).toHaveLength(0);
    expect(first.killCalls).toBe(1);

    service.closeAll();
    expect(first.killCalls).toBe(2);
  } finally {
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
});
