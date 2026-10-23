import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";
import { validPtyDimensions } from "../desktop/src/main/pty-manager.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import { LaunchAttemptRegistry } from "../desktop/src/main/mod-launch-plan.ts";

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
  args: string[];
  killCalls: number;
  writes: string[];
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
      args: Array.isArray(_args) ? _args.map(String) : [],
      killCalls: 0,
      writes: [] as string[],
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
      write(data: string) {
        this.writes.push(data);
      },
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
const { encodeProjectDir } = await import("../desktop/src/main/session-transcript.ts");

function createSessionService(
  home: string,
  cwd: string,
  config: Record<string, unknown> = {},
  getPluginDirs: (
    _lead: boolean,
    _sandboxed: boolean,
    modDirs?: readonly string[],
    modCopies?: readonly { plugin: string; hostDir: string }[],
    cwd?: string
  ) => readonly string[] = (_lead, _sandboxed, modDirs = []) => modDirs
): InstanceType<typeof SessionService> {
  const service = new SessionService(
    () => ({ projectDir: cwd, shell: "powershell.exe", interactiveShell: false, ...config }),
    () => ({}),
    "claude",
    getPluginDirs,
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

test("a quota auto-resume types into the live PTY and prepares nothing, neither a launch nor a mod plan", async () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-autoresume-no-prep-"));
  const cwd = join(home, "project");
  let pluginDirReads = 0;
  const service = createSessionService(home, cwd, {}, (_lead, _sandboxed, modDirs = []) => {
    pluginDirReads++;
    return modDirs;
  });
  const registryCalls: string[] = [];
  service.setLaunchAttemptRegistry(
    new Proxy({}, { get: (_target, method) => (..._args: unknown[]) => (registryCalls.push(String(method)), true) }) as never
  );
  let verifications = 0;
  service.setModWorkingCopyVerifier(() => (verifications++, { ok: true }));

  try {
    const { id } = service.create({});
    const pty = sessionPtys.at(-1)!;
    service.setAutoResume(id, true);
    (service as unknown as { runtime: Map<string, { rateLimited: boolean }> }).runtime.get(id)!.rateLimited = true;
    const spawned = sessionPtys.length;
    const reads = pluginDirReads;
    registryCalls.length = 0;
    const expectNothingPrepared = (when: string): void => {
      expect(sessionPtys.length, `${when}: a second PTY was spawned`).toBe(spawned);
      expect(pluginDirReads, `${when}: the plugin directories were composed again`).toBe(reads);
      expect(registryCalls, `${when}: a launch attempt was touched`).toEqual([]);
      expect(verifications, `${when}: a mod working copy was verified`).toBe(0);
    };

    (service as unknown as { autoResume(tileId: string): void }).autoResume(id);
    expect(pty.writes, "Escape is typed first").toEqual(["\x1b"]);
    expectNothingPrepared("right after Escape");

    const deadline = Date.now() + 2000;
    while (pty.writes.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(pty.writes, "the continuation is typed into the same PTY").toEqual(["\x1b", "continue", "\r"]);
    expectNothingPrepared("after the continuation");
  } finally {
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
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

test("SessionService rejects a refused launch mod plan before spawning a PTY (mutation: ignore refused plan)", () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-refused-mod-plan-"));
  const cwd = join(home, "project");
  const service = createSessionService(home, cwd);

  try {
    service.create({}, { modPlan: { refused: "sandbox namespace unavailable" } } as never);
    expect(sessionPtys).toHaveLength(0);
    expect(service.list()[0]?.status).toBe("exited");
  } finally {
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a mod directory does not count as the deck telemetry plugin (mutation: use the first plugin dir)", () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-telemetry-plugin-"));
  const cwd = join(home, "project");
  const service = createSessionService(home, cwd, {}, () => ["/mods/prosopon/fingerprint"]);
  let written = "";
  service.setHostTelemetryProvider(() => true);
  service.setStatusLineSettingsProvider(() => '{"statusLine":{"type":"command","command":"status"}}');
  service.setTileSettingsFileProvider((settings) => { written = settings; return join(home, "tile-settings.json"); });

  try {
    service.create({});
    expect(written).toContain('"statusLine"');
    expect(sessionPtys).toHaveLength(1);
  } finally {
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionService passes launch mod directories to the PTY command (mutation: ignore plan)", () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-mod-plan-"));
  const cwd = join(home, "project");
  const service = createSessionService(home, cwd, {}, (_lead, _sandboxed, modDirs = []) => ["/deck-plugin", ...modDirs]);

  try {
    service.create({}, { modPlan: { attemptId: "a", mode: "host", modDirs: ["/mods/prosopon"], diagnostics: [] } } as never);
    expect(sessionPtys.at(-1)?.args.join(" ")).toContain('--plugin-dir "/mods/prosopon"');
  } finally {
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionService rejects active mods without a launch plan (mutation: permit distribution fallback)", () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-missing-mod-plan-"));
  const cwd = join(home, "project");
  const service = createSessionService(home, cwd, { enabledMods: { prosopon: true } });

  try {
    service.create({});
    expect(sessionPtys).toHaveLength(0);
    expect(service.list()[0]?.status).toBe("exited");
  } finally {
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  ["null", null, 1],
  ["an array holding true", [true], 1],
  ["a number", 7, 1],
  ["a string", "true", 1],
  ["a record whose entries are not the boolean true", { prosopon: false, other: "true", third: 1 }, 1],
  ["a record holding true", { prosopon: true }, 0]
] as Array<[string, unknown, number]>)("a tile created with no launch plan while enabledMods holds %s", (_label, enabledMods, spawned) => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-enabled-mods-domain-"));
  const cwd = join(home, "project");
  const service = createSessionService(home, cwd, { enabledMods });

  try {
    service.create({});
    expect(sessionPtys, `enabledMods=${JSON.stringify(enabledMods)}: only a record holding the boolean true makes a launch plan mandatory`).toHaveLength(spawned);
  } finally {
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionService rejects a sandbox plugin-dir before spawning a PTY (mutation: omit sandbox guard at consumption)", () => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-sandbox-plugin-dir-"));
  const cwd = join(home, "project");
  const service = createSessionService(home, cwd);
  service.setSandboxProvider(() => ({ wrap: () => "wrapped", cleanup: async () => {} }), undefined, () => "/sandbox/peers");

  try {
    service.create({ args: "--plugin-dir=/user-plugin" });
    expect(sessionPtys).toHaveLength(0);
  } finally {
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  ["a bare flag", "--plugin-dir"],
  ["a single-quoted flag", "'--plugin-dir' /user-plugin"],
  ["a backslash inside the flag", String.raw`--plugin\-dir /user-plugin`],
  ["double quotes splitting the flag", '--plug"in-dir" /user-plugin'],
  ["a caret inside the flag", "--plugin^-dir /user-plugin"]
])("a sandboxed tile is not launched with a user plugin-dir spelled as %s, fresh or resumed, from its args or its base command", (_name, spelling) => {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-sandbox-spelling-"));
  const cwd = join(home, "project");
  const service = createSessionService(home, cwd);
  service.setSandboxProvider(
    () => ({ wrap: (_tileId: string, _sessionId: string, command: string) => command, cleanup: async () => {} }),
    undefined,
    () => "/sandbox/peers"
  );

  try {
    service.create({});
    const [def] = service.captureSessions();
    if (!def?.sessionId) throw new Error("the clean sandboxed tile has no session id to resume");
    const projects = join(home, ".claude", "projects", encodeProjectDir(def.cwd));
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${def.sessionId}.jsonl`), "{}\n", "utf-8");
    const spawned = sessionPtys.length;

    service.create({ args: spelling });
    service.create({ command: `claude ${spelling}` });
    expect(sessionPtys.length - spawned, "a fresh launch must not start a PTY for a user plugin-dir").toBe(0);

    service.restoreFrom([{ ...def, args: spelling }]);
    expect(sessionPtys.length - spawned, "a resumed launch must not start a PTY for a user plugin-dir in the args").toBe(0);
    service.restoreFrom([{ ...def, command: `claude ${spelling}` }]);
    expect(sessionPtys.length - spawned, "a resumed launch must not start a PTY for a user plugin-dir in the base command").toBe(0);

    service.restoreFrom([{ ...def }]);
    expect(sessionPtys.length - spawned, "control: the same resume without the flag does start a PTY").toBe(1);
    expect(sessionPtys.at(-1)?.args.join(" "), "control: that PTY is a real resume").toContain("--resume");
  } finally {
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
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

type ModPlanService = InstanceType<typeof SessionService>;

async function withModService(
  config: Record<string, unknown>,
  getPluginDirs: Parameters<typeof createSessionService>[3],
  body: (service: ModPlanService) => void | Promise<void>
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "kory-pty-mod-plan-case-"));
  const service = createSessionService(home, join(home, "project"), config, getPluginDirs);
  const reports: Array<[string, string]> = [];
  onDeckError((scope, text) => reports.push([scope, text]));
  (service as unknown as { reports: typeof reports }).reports = reports;
  try {
    await body(service);
  } finally {
    onDeckError(() => {});
    service.closeAll();
    for (const pty of sessionPtys.splice(0)) pty.exit();
    rmSync(home, { recursive: true, force: true });
  }
}

const reportsOf = (service: ModPlanService): Array<[string, string]> => (service as unknown as { reports: Array<[string, string]> }).reports;
const withDeckPlugin = (_lead: boolean, _sandboxed: boolean, modDirs: readonly string[] = []): readonly string[] => ["/deck-plugin", ...modDirs];
const hostPlan = (...modDirs: string[]) => ({ attemptId: "a", mode: "host" as const, modDirs, diagnostics: [] });
const sandboxPlan = (...modDirs: string[]) => ({ attemptId: "a", mode: "sandbox" as const, modDirs, diagnostics: [] });
const restoredDef = (id: string, name: string) => ({ id, name, cwd: "", command: "", args: "", sessionId: "", color: "#4488ff", createdAt: 1 });

test("a refused launch mod plan leaves a trace naming its reason", async () => {
  await withModService({}, withDeckPlugin, (service) => {
    service.create({}, { modPlan: { refused: "sandbox namespace unavailable" } } as never);
    expect(reportsOf(service).some(([scope, text]) => scope === "session" && text.includes("sandbox namespace unavailable"))).toBe(true);
  });
});

test("refused plans retain their reason when restart and restore consume them", async () => {
  await withModService({}, withDeckPlugin, async (service) => {
    const initial = service.create({});
    service.stop();
    sessionPtys.at(-1)?.exit();
    const def = (service as unknown as { defs: Array<{ id: string; sessionId: string }> }).defs.find((candidate) => candidate.id === initial.id);
    if (!def) throw new Error("restart definition missing");
    def.sessionId = "";
    const registry = new LaunchAttemptRegistry();
    service.setLaunchAttemptRegistry(registry);
    const restartAttempt = registry.begin(initial.id);

    await service.restart(initial.id, { attemptId: restartAttempt.attemptId, refused: "restart preparation refused" });

    const restoreAttempt = registry.begin("restored-tile");
    service.restoreFrom(
      [restoredDef("restored-tile", "restored")],
      new Map([["restored-tile", { attemptId: restoreAttempt.attemptId, refused: "restore preparation refused" }]])
    );

    const messages = reportsOf(service).map(([, text]) => text);
    expect(messages.some((text) => text.includes("restart preparation refused"))).toBe(true);
    expect(messages.some((text) => text.includes("restore preparation refused"))).toBe(true);
    expect(messages.some((text) => text.includes("mod launch superseded"))).toBe(false);
  });
});

test("omitted mods of a plan are reported one by one and the tile still launches", async () => {
  await withModService({}, withDeckPlugin, (service) => {
    service.create({}, { modPlan: { attemptId: "a", mode: "host", modDirs: ["/mods/a"], diagnostics: [{ plugin: "beta", reason: "drifted" }, { plugin: "gamma", reason: "collision" }] } } as never);
    expect(sessionPtys).toHaveLength(1);
    const reported = reportsOf(service).map(([, text]) => text);
    expect(reported.some((text) => text.includes("beta") && text.includes("drifted"))).toBe(true);
    expect(reported.some((text) => text.includes("gamma") && text.includes("collision"))).toBe(true);
  });
});

test.each([
  ["no mod setting at all", undefined],
  ["an empty mod setting", {}],
  ["every mod switched off", { prosopon: false, mitos: false }],
  ["a truthy value that is not true", { prosopon: 1 }],
])("a tile launches without any plan when the mods are off: %s", async (_name, enabledMods) => {
  const seen: Array<readonly string[]> = [];
  await withModService(enabledMods === undefined ? {} : { enabledMods }, (lead, sandboxed, modDirs = []) => { seen.push(modDirs); return withDeckPlugin(lead, sandboxed, modDirs); }, (service) => {
    service.create({});
    expect(sessionPtys, "a plan is required only when a mod is switched on").toHaveLength(1);
    expect(service.list()[0]?.status).toBe("running");
    expect(seen).toEqual([[]]);
  });
});

test("a host mod plan passes its copies and tile cwd to the plugin directory resolver", async () => {
  const calls: Array<{ copies: readonly { plugin: string; hostDir: string }[]; cwd: string | undefined }> = [];
  const copies = [{ plugin: "prosopon", fingerprint: "a".repeat(64), hostDir: "/mods/prosopon" }];
  await withModService(
    { enabledMods: { prosopon: true } },
    (_lead, _sandboxed, modDirs = [], seenCopies = [], cwd) => {
      calls.push({ copies: seenCopies, cwd });
      return modDirs;
    },
    (service) => {
      service.create(
        { cwd: "/tile/project" },
        { modPlan: { attemptId: "a", mode: "host", modDirs: ["/mods/prosopon"], copies, diagnostics: [] } } as never
      );
      expect(calls).toEqual([{ copies, cwd: "/tile/project" }]);
    }
  );
});

test("a restored workspace gives each tile its own mod plan", async () => {
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, (service) => {
    service.restoreFrom(
      [restoredDef("tile-one", "one"), restoredDef("tile-two", "two")],
      new Map([["tile-one", hostPlan("/mods/for-one")], ["tile-two", hostPlan("/mods/for-two")]])
    );
    expect(sessionPtys).toHaveLength(2);
    const [one, two] = sessionPtys.map((pty) => pty.args.join(" "));
    expect(one).toContain('--plugin-dir "/mods/for-one"');
    expect(one).not.toContain("/mods/for-two");
    expect(two).toContain('--plugin-dir "/mods/for-two"');
    expect(two).not.toContain("/mods/for-one");
  });
});

test("a restored workspace exits only the tile whose plan was refused", async () => {
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, (service) => {
    service.restoreFrom(
      [restoredDef("tile-one", "one"), restoredDef("tile-two", "two")],
      new Map([["tile-one", { refused: "namespace invalid" }], ["tile-two", hostPlan("/mods/for-two")]])
    );
    expect(sessionPtys, "the refused tile must not spawn").toHaveLength(1);
    expect(sessionPtys[0]!.args.join(" ")).toContain("/mods/for-two");
    const statuses = Object.fromEntries(service.list().map((runtime) => [runtime.id, runtime.status]));
    expect(statuses["tile-one"]).toBe("exited");
    expect(statuses["tile-two"]).toBe("running");
    expect(service.list().find((runtime) => runtime.id === "tile-one")?.exitCode, "a refused tile reads as failed, not as never started").toBe(-1);
  });
});

test("a restored tile missing from the plan map is refused while mods are on", async () => {
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, (service) => {
    service.restoreFrom([restoredDef("tile-one", "one"), restoredDef("tile-two", "two")], new Map([["tile-two", hostPlan("/mods/for-two")]]));
    expect(sessionPtys).toHaveLength(1);
    expect(service.list().find((runtime) => runtime.id === "tile-one")?.status).toBe("exited");
  });
});

test("a restored workspace without plans still launches its tiles when the mods are off", async () => {
  await withModService({}, withDeckPlugin, (service) => {
    service.restoreFrom([restoredDef("tile-one", "one"), restoredDef("tile-two", "two")]);
    expect(sessionPtys).toHaveLength(2);
  });
});

test("a restart carries the plan prepared for it", async () => {
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, async (service) => {
    const tile = service.create({}, { modPlan: { refused: "namespace invalid" } } as never);
    expect(sessionPtys).toHaveLength(0);

    await service.restart(tile.id, hostPlan("/mods/after-restart"));

    expect(sessionPtys).toHaveLength(1);
    expect(sessionPtys[0]!.args.join(" ")).toContain('--plugin-dir "/mods/after-restart"');
  });
});

test("a sandboxed tile hands the container mod directories of its plan to the wrapped command", async () => {
  const calls: Array<{ lead: boolean; sandboxed: boolean; modDirs: readonly string[] }> = [];
  const commands: string[] = [];
  await withModService(
    { enabledMods: { prosopon: true } },
    (lead, sandboxed, modDirs = []) => { calls.push({ lead, sandboxed, modDirs }); return [sandboxed ? "/home/kory/.claude/deck-plugin" : "/deck-plugin", ...modDirs]; },
    (service) => {
      service.setSandboxProvider(() => ({ engine: "docker", containerId: CONTAINER_A, wrap: (_tile, _session, command) => { commands.push(command); return "wrapped"; }, cleanup: async () => {} }) as never, undefined, () => "/sandbox/peers");
      service.create({}, { modPlan: pinnedSandboxPlan("docker", CONTAINER_A, "/opt/kory-mods/prosopon/fp") } as never);

      expect(calls.at(-1)).toEqual({ lead: false, sandboxed: true, modDirs: ["/opt/kory-mods/prosopon/fp"] });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('--plugin-dir "/opt/kory-mods/prosopon/fp"');
    }
  );
});

test("a sandboxed tile launches with an empty sandbox plan that has no target", async () => {
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, (service) => {
    service.setSandboxProvider(() => ({ wrap: (_tile, _session, command) => command, cleanup: async () => {} }) as never, undefined, () => "/sandbox/peers");
    service.create({}, { modPlan: sandboxPlan() } as never);

    expect(sessionPtys).toHaveLength(1);
    expect(service.list()[0]?.status).toBe("running");
  });
});

test.each([
  ["a host plan on a sandboxed tile", "/mods/host-copy/prosopon", hostPlan, true],
  ["a sandbox plan on a host tile", "/opt/kory-mods/prosopon/fp", sandboxPlan, false],
] as const)("%s is refused before any spawn", async (_name, modDir, plan, sandboxedTile) => {
  const commands: string[] = [];
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, (service) => {
    if (sandboxedTile) {
      service.setSandboxProvider(() => ({ wrap: (_tile, _session, command) => { commands.push(command); return "wrapped"; }, cleanup: async () => {} }) as never, undefined, () => "/sandbox/peers");
    }
    service.create({}, { modPlan: plan(modDir) } as never);

    expect(sessionPtys, "directories prepared for the other side must never reach this tile's command").toHaveLength(0);
    expect(commands).toEqual([]);
    expect(service.list()[0]?.status).toBe("exited");
  });
});

const CONTAINER_A = "a".repeat(64);
const CONTAINER_B = "b".repeat(64);
const pinnedSandboxPlan = (engine: string, containerId: string | undefined, ...modDirs: string[]) => ({ attemptId: "a", mode: "sandbox" as const, engine, containerId, modDirs, diagnostics: [] });

function useSandboxWrapper(service: ModPlanService, commands: string[], engine = "docker", containerId = CONTAINER_A): void {
  service.setSandboxProvider(() => ({ engine, containerId, wrap: (_tile: string, _session: string, command: string) => { commands.push(command); return "wrapped"; }, cleanup: async () => {} }) as never, undefined, () => "/sandbox/peers");
}

test("a sandbox plan prepared on the container the tile will exec into launches the tile", async () => {
  const commands: string[] = [];
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, (service) => {
    useSandboxWrapper(service, commands);
    service.create({}, { modPlan: pinnedSandboxPlan("docker", CONTAINER_A, "/opt/kory-mods/prosopon/fp") } as never);

    expect(sessionPtys, "the matching container is the only case that may spawn").toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('--plugin-dir "/opt/kory-mods/prosopon/fp"');
  });
});

test.each([
  ["another container id", "docker", CONTAINER_B],
  ["another engine", "podman", CONTAINER_A],
  ["no container id", "docker", undefined],
  ["no engine", undefined, CONTAINER_A],
] as const)("a sandbox plan prepared with %s is refused before the command is wrapped", async (_name, engine, containerId) => {
  const commands: string[] = [];
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, (service) => {
    useSandboxWrapper(service, commands);
    service.create({}, { modPlan: pinnedSandboxPlan(engine as string, containerId, "/opt/kory-mods/prosopon/fp") } as never);

    expect(sessionPtys, "mod directories published in one container must never be handed to a tile exec'd into another").toHaveLength(0);
    expect(commands, "the command must not even be wrapped for the wrong container").toEqual([]);
    const runtime = service.list()[0];
    expect(runtime?.status).toBe("exited");
    expect(runtime?.exitCode).toBe(-1);
    expect(reportsOf(service).some(([scope, text]) => scope === "session" && text.includes("container does not match"))).toBe(true);
  });
});

const hostPlanOf = (...plugins: string[]) => ({
  attemptId: "a",
  mode: "host" as const,
  modDirs: plugins.map((plugin) => `/mods/${plugin}`),
  copies: plugins.map((plugin) => ({ plugin, fingerprint: "f".repeat(64), hostDir: `/mods/${plugin}` })),
  diagnostics: []
});

test("host copies are revalidated at spawn: a failing copy is omitted with a trace and the tile still starts with the others", async () => {
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, (service) => {
    const checked: string[] = [];
    service.setModWorkingCopyVerifier((copy) => {
      checked.push(copy.plugin);
      return copy.plugin === "beta" ? { ok: false, reason: "copy drifted since preparation" } : { ok: true };
    });

    service.create({}, { modPlan: hostPlanOf("alpha", "beta", "gamma") } as never);

    expect(checked, "every host copy is checked again at the spawn, not only when the plan was built").toEqual(["alpha", "beta", "gamma"]);
    expect(sessionPtys, "a drifted copy costs the mod, never the tile").toHaveLength(1);
    const command = sessionPtys[0]!.args.join(" ");
    expect(command).toContain('--plugin-dir "/mods/alpha"');
    expect(command).toContain('--plugin-dir "/mods/gamma"');
    expect(command, "a copy that failed revalidation must not reach the command").not.toContain("/mods/beta");
    expect(reportsOf(service).some(([scope, text]) => scope === "session" && text.includes("beta") && text.includes("copy drifted since preparation"))).toBe(true);
  });
});

test("a tile whose every host copy fails revalidation still starts without any mod directory", async () => {
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, (service) => {
    service.setModWorkingCopyVerifier(() => ({ ok: false, reason: "copy drifted since preparation" }));

    service.create({}, { modPlan: hostPlanOf("alpha", "beta") } as never);

    expect(sessionPtys).toHaveLength(1);
    const command = sessionPtys[0]!.args.join(" ");
    expect(command).toContain('--plugin-dir "/deck-plugin"');
    expect(command).not.toContain("/mods/");
  });
});

test("a restart revalidates host copies against their state at that spawn", async () => {
  await withModService({ enabledMods: { prosopon: true } }, withDeckPlugin, async (service) => {
    let drifted = false;
    service.setModWorkingCopyVerifier(() => (drifted ? { ok: false, reason: "copy drifted since preparation" } : { ok: true }));
    const tile = service.create({}, { modPlan: { refused: "namespace invalid" } } as never);
    drifted = true;

    await service.restart(tile.id, hostPlanOf("alpha") as never);

    expect(sessionPtys).toHaveLength(1);
    expect(sessionPtys[0]!.args.join(" ")).not.toContain("/mods/alpha");
  });
});
