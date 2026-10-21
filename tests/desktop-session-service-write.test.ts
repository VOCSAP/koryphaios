import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";
import { validPtyDimensions } from "../desktop/src/main/pty-manager.ts";

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");
const SHARED = join(import.meta.dir, "..", "desktop", "src", "shared");

for (const name of ["session-status", "palette", "role", "reorder", "workflow", "announce", "types"]) {
  mock.module(`@shared/${name}`, () => require(join(SHARED, `${name}.ts`)));
}

type SessionDataListener = (data: string) => void;
type SessionExitListener = (event: { exitCode: number }) => void;

interface SessionFakePty {
  pid: number;
  env: Record<string, string>;
  killCalls: number;
  output(data: string): void;
  exit(code?: number): void;
}

const sessionPtys: SessionFakePty[] = [];
let nextSessionPid = 40_000;

mock.module("node-pty", () => ({
  spawn(_file?: string, _args?: unknown, options?: { env?: Record<string, string> }) {
    let onData: SessionDataListener | null = null;
    let onExit: SessionExitListener | null = null;
    const proc: SessionFakePty & Record<string, unknown> = {
      pid: nextSessionPid++,
      env: { ...(options?.env ?? {}) },
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

function createSessionService(home: string, cwd: string): InstanceType<typeof SessionService> {
  const service = new SessionService(
    () => ({ projectDir: cwd, shell: "powershell.exe", interactiveShell: false }),
    () => ({}),
    "claude",
    () => [],
    home
  );
  service.setTileSettingsFileProvider(() => join(home, "tile-settings.json"));
  return service;
}

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

function resize(
  id: string,
  cols: number,
  rows: number,
  self: object,
  reportError: (scope: string, message: string) => void,
  validate: (cols: number, rows: number) => boolean = validPtyDimensions
): void {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const body = extractBody(source, /resize\(id: string, cols: number, rows: number\): void \{/, "resize()");
  const run = new Function("id", "cols", "rows", "reportError", "validPtyDimensions", body) as (
    this: object,
    id: string,
    cols: number,
    rows: number,
    reportError: (scope: string, message: string) => void,
    validPtyDimensions: (cols: number, rows: number) => boolean
  ) => void;
  run.call(
    self,
    id,
    cols,
    rows,
    reportError,
    validate
  );
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
    screenGuard: { read: () => ({ status: "ready" }) },
    runtime: new Map()
  };

  expect(interrupt("tile", "hard", self)).toBe("no-terminal");
});

test("resize rejects every invalid dimension before resizing the screen or PTY", () => {
  const validations: Array<[number, number]> = [];
  const reports: Array<[string, string]> = [];
  let screenResizes = 0;
  let ptyResizes = 0;
  const self = {
    screenGuard: {
      resize: () => screenResizes++,
      invalidate: () => {}
    },
    pty: { resize: () => (ptyResizes++, true) }
  };
  const invalid: Array<[number, number]> = [
    [Number.NaN, 24],
    [80, Number.NaN],
    [0, 24],
    [80, 0],
    [1025, 1024]
  ];
  const validate = (cols: number, rows: number): boolean => {
    validations.push([cols, rows]);
    return validPtyDimensions(cols, rows);
  };

  for (const [cols, rows] of invalid) resize("tile", cols, rows, self, (scope, message) => reports.push([scope, message]), validate);

  expect(validations).toEqual(invalid);
  expect(screenResizes).toBe(0);
  expect(ptyResizes).toBe(0);
  expect(reports).toEqual(invalid.map(() => ["session", 'ignored invalid terminal dimensions for tile "tile"']));
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
  const service = createSessionService(home, cwd);

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

test("a launched tile exports its supervisor bit as 1 or 0 whatever the Deck's own environment holds", async () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-supervisor-bit-"));
  const cwd = join(home, "project");
  const service = createSessionService(home, cwd);
  const inherited = process.env.CLAUDE_PEERS_SUPERVISOR;
  process.env.CLAUDE_PEERS_SUPERVISOR = "1";

  try {
    service.create({});
    expect(sessionPtys.at(-1)!.env.CLAUDE_PEERS_SUPERVISOR).toBe("0");
    service.create({ supervisor: true });
    expect(sessionPtys.at(-1)!.env.CLAUDE_PEERS_SUPERVISOR).toBe("1");
    service.create({ lead: true });
    expect(sessionPtys.at(-1)!.env.CLAUDE_PEERS_SUPERVISOR).toBe("0");
  } finally {
    if (inherited === undefined) delete process.env.CLAUDE_PEERS_SUPERVISOR;
    else process.env.CLAUDE_PEERS_SUPERVISOR = inherited;
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionService.closeAll retries a retired PTY after its final definition is removed", async () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-close-all-"));
  const cwd = join(home, "project");
  const service = createSessionService(home, cwd);

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
