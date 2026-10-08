import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { extractBracedBody } from "./_braced-body";

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");
const PTY_MANAGER_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "pty-manager.ts");
const INDEX_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");
const PTY_RUN_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "pty-run.ts");

function methodBody(source: string, signature: RegExp): string {
  const match = signature.exec(source);
  if (!match) throw new Error(`session-service lifecycle method not found: ${signature.source}`);
  return extractBracedBody(source, match.index + match[0].length - 1);
}

function revokesBefore(body: string, revocation: string, termination: string): boolean {
  const revokeAt = body.indexOf(revocation);
  const terminateAt = body.indexOf(termination);
  return revokeAt >= 0 && terminateAt >= 0 && revokeAt < terminateAt;
}

function executeUtilitySpawn(source: string): Record<string, string> {
  const run = new Function(
    "id",
    "cwd",
    "opts",
    methodBody(source, /spawnUtility\(id: string, cwd: string, opts: \{ command: string; shell: string; interactive: boolean \}\): void \{/)
  ) as (id: string, cwd: string, opts: { command: string; shell: string; interactive: boolean }) => void;
  let received: Record<string, string> | null = null;
  const context = {
    pty: {
      spawn: (_id: string, _cwd: string, _opts: unknown, env: Record<string, string>) => {
        received = env;
      },
    },
  };

  run.call(context, "utility", "C:/repo", { command: "bash", shell: "bash", interactive: false });
  if (!received) throw new Error("utility spawn environment not captured");
  return received;
}

test("utility PTYs receive an empty permission lease environment", () => {
  expect(executeUtilitySpawn(readFileSync(SESSION_SERVICE_PATH, "utf8"))).toEqual({ KORY_PERMISSION_LEASE: "" });
});

test("one-shot PTY commands clear an inherited permission lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "permission-lease-pty-run-"));
  const probe = join(dir, "pty-run.test.ts");
  writeFileSync(
    probe,
    `import { expect, mock, test } from "bun:test";
let lease = "unset";
mock.module("node-pty", () => ({
  spawn: (_file: string, _args: string[], options: { env: Record<string, string> }) => {
    lease = options.env.KORY_PERMISSION_LEASE;
    return { onData: () => {}, onExit: (callback: (event: { exitCode: number }) => void) => callback({ exitCode: 0 }) };
  },
}));
const { runPtyCommand } = await import(${JSON.stringify(pathToFileURL(PTY_RUN_PATH).href)});
test("clears inherited lease", async () => {
  await runPtyCommand({ command: "true", shell: "bash", cwd: process.cwd(), timeoutMs: 1_000 });
  expect(lease).toBe("");
});
`
  );
  try {
    const result = Bun.spawnSync(["bun", "test", probe], {
      cwd: process.cwd(),
      env: { ...process.env, KORY_PERMISSION_LEASE: "hostile-descriptor" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all destructive SessionService lifecycle paths revoke a lease before replacing or killing a PTY", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");

  expect(revokesBefore(methodBody(source, /stop\(\): void \{/), "this.revokeAllPermissionLeases()", "this.pty.killAll()")).toBe(true);
  expect(revokesBefore(methodBody(source, /closeAll\(\): void \{/), "this.revokeAllPermissionLeases()", "this.pty.killAll()")).toBe(true);
  expect(revokesBefore(methodBody(source, /restoreFrom\(defs: SessionDef\[\]\): SessionRuntime\[\] \{/), "this.revokeAllPermissionLeases()", "this.pty.killAll()")).toBe(true);
  expect(revokesBefore(methodBody(source, /restart\(id: string\): Promise<SessionRuntime> \{/), "this.revokePermissionLease(id)", "await this.cleanupSandbox")).toBe(true);
  expect(revokesBefore(methodBody(source, /async remove\(id: string\): Promise<void> \{/), "this.revokePermissionLease(id)", "await gracefulClose")).toBe(true);
  const startPty = methodBody(source, /private startPty\(def: SessionDef, mode: SpawnMode\): void \{/);
  expect(revokesBefore(startPty, "this.revokePermissionLease(def.id)", "this.pty.spawn(")).toBe(true);
  const spawnCatch = startPty.indexOf("} catch (e) {", startPty.indexOf("this.pty.spawn("));
  if (spawnCatch < 0) throw new Error("spawn failure handler not found");
  const cleanup = extractBracedBody(startPty, startPty.indexOf("{", spawnCatch));
  expect(revokesBefore(cleanup, "this.revokePermissionLeaseHandle(permissionLease)", "void this.cleanupSandbox")).toBe(true);
});

test("force cleanup revokes the current lease before killing a tile", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");
  const remove = methodBody(source, /async remove\(id: string\): Promise<void> \{/);
  const forceCleanupAt = remove.indexOf("const forceCleanup = (): void => {");
  if (forceCleanupAt < 0) throw new Error("force cleanup callback not found");
  const forceCleanup = extractBracedBody(remove, forceCleanupAt + "const forceCleanup = (): void => ".length);

  expect(revokesBefore(forceCleanup, "this.revokePermissionLease(id)", "this.killWithTrace(id, 'force cleanup')")).toBe(true);
});

type TestLeaseHandle = { tileId: string };

function executeLeaseRevocation(source: string) {
  const revokeHandle = new Function(
    "handle",
    methodBody(source, /private revokePermissionLeaseHandle\(handle: PermissionLeaseHandle \| null\): void \{/)
  ) as (handle: TestLeaseHandle | null) => void;
  const revokeByTile = new Function(
    "id",
    methodBody(source, /private revokePermissionLease\(id: string\): PermissionLeaseHandle \| null \{/)
  ) as (id: string) => TestLeaseHandle | null;
  const calls: TestLeaseHandle[] = [];
  const context = {
    permissionLeaseHandles: new Map<string, TestLeaseHandle>(),
    permissionLeases: { revoke: (handle: TestLeaseHandle) => calls.push(handle) },
    revokePermissionLeaseHandle: (_handle: TestLeaseHandle | null) => {},
  };
  context.revokePermissionLeaseHandle = (handle) => revokeHandle.call(context, handle);
  return { calls, context, revokeHandle, revokeByTile };
}

function executeLeaseSetup(source: string, sandboxed: boolean, base: string) {
  const declaration = source.indexOf("let permissionLease: PermissionLeaseHandle | null = null");
  const start = source.indexOf("if (", declaration);
  const open = source.indexOf("{", start);
  if (start < 0 || open < 0) throw new Error("permission lease setup not found");
  const run = new Function(
    "sandboxed",
    "base",
    "def",
    "sessionEnv",
    "isClaudeLaunch",
    `let permissionLease = null;\n${source.slice(start, open + 1)}${extractBracedBody(source, open)}\n}\nreturn { permissionLease, sessionEnv };`
  ) as (
    sandboxed: boolean,
    base: string,
    def: { id: string },
    sessionEnv: Record<string, string>,
    isClaudeLaunch: (value: string) => boolean
  ) => { permissionLease: { tileId: string } | null; sessionEnv: Record<string, string> };
  const handle = { tileId: "tile-1" };
  const calls: string[] = [];
  const context = {
    permissionLeases: {
      createLease: (tileId: string) => {
        calls.push(`create:${tileId}`);
        return handle;
      },
      descriptor: () => "lease-descriptor",
    },
    permissionLeaseHandles: new Map<string, typeof handle>(),
  };
  const result = run.call(context, sandboxed, base, { id: "tile-1" }, { KORY_PERMISSION_LEASE: "" }, (value) => value === "claude");
  return { calls, context, result };
}

function executeLeaseCreationFailure(source: string) {
  const body = methodBody(source, /private startPty\(def: SessionDef, mode: SpawnMode\): void \{/);
  const start = body.indexOf("let permissionLease: PermissionLeaseHandle | null = null");
  if (start < 0) throw new Error("permission lease spawn setup not found");
  const run = new Function(
    "sandboxed",
    "base",
    "def",
    "cfg",
    "command",
    "sessionEnv",
    "isClaudeLaunch",
    "reportError",
    `let r = null;\n${body
      .slice(start)
      .replace("let permissionLease: PermissionLeaseHandle | null = null", "let permissionLease = null")}\nreturn sessionEnv;`
  ) as (
    sandboxed: boolean,
    base: string,
    def: { id: string; cwd: string; name: string },
    cfg: { shell: string; interactiveShell: boolean },
    command: string,
    sessionEnv: Record<string, string>,
    isClaudeLaunch: (value: string) => boolean,
    reportError: (scope: string, message: string, error: unknown) => void
  ) => Record<string, string>;
  const failure = new Error("lease write failed");
  const calls: string[] = [];
  const reports: unknown[] = [];
  const context = {
    permissionLeases: {
      createLease: () => {
        throw failure;
      },
      descriptor: () => "lease-descriptor",
    },
    permissionLeaseHandles: new Map<string, TestLeaseHandle>(),
    pty: {
      spawn: (_id: string, _cwd: string, _opts: unknown, env: Record<string, string>) => {
        calls.push(`spawn:${env.KORY_PERMISSION_LEASE}`);
      },
    },
    revokePermissionLeaseHandle: () => {},
    cleanupSandbox: () => Promise.resolve(),
    deadWriteReported: { delete: () => {} },
  };
  const sessionEnv = { KORY_PERMISSION_LEASE: "" };
  run.call(
    context,
    false,
    "claude",
    { id: "tile-1", cwd: "C:/repo", name: "Tile" },
    { shell: "bash", interactiveShell: false },
    "claude",
    sessionEnv,
    (value) => value === "claude",
    (_scope, _message, error) => reports.push(error)
  );
  return { calls, reports, failure };
}

test("a failed lease write still launches the host Claude tile without a descriptor", () => {
  const result = executeLeaseCreationFailure(readFileSync(SESSION_SERVICE_PATH, "utf8"));

  expect(result.calls).toEqual(["spawn:"]);
  expect(result.reports).toEqual([result.failure]);
});

test("a tile lease revocation removes its mapped handle and revokes that exact handle", () => {
  const setup = executeLeaseRevocation(readFileSync(SESSION_SERVICE_PATH, "utf8"));
  const current = { tileId: "tile-1" };
  const replacement = { tileId: "tile-1" };
  setup.context.permissionLeaseHandles.set(current.tileId, current);

  expect(setup.revokeByTile.call(setup.context, current.tileId)).toBe(current);
  expect(setup.context.permissionLeaseHandles.has(current.tileId)).toBe(false);
  expect(setup.calls).toEqual([current]);

  setup.context.permissionLeaseHandles.set(replacement.tileId, replacement);
  setup.revokeHandle.call(setup.context, current);
  expect(setup.context.permissionLeaseHandles.get(replacement.tileId)).toBe(replacement);
  expect(setup.calls).toEqual([current, current]);
});

test("the lease revocation harness detects a missing runtime revoke", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");
  const setup = executeLeaseRevocation(source.replace("this.permissionLeases?.revoke(handle)", ""));
  const handle = { tileId: "tile-1" };
  setup.context.permissionLeaseHandles.set(handle.tileId, handle);

  setup.revokeByTile.call(setup.context, handle.tileId);
  expect(setup.calls).toEqual([]);
});

test("only host Claude spawns receive a permission lease descriptor", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");
  const hostClaude = executeLeaseSetup(source, false, "claude");
  const nonClaude = executeLeaseSetup(source, false, "bash");
  const sandboxed = executeLeaseSetup(source, true, "claude");

  expect(hostClaude.calls).toEqual(["create:tile-1"]);
  expect(hostClaude.result.permissionLease).not.toBeNull();
  expect(hostClaude.context.permissionLeaseHandles.get("tile-1")).toBe(hostClaude.result.permissionLease ?? undefined);
  expect(hostClaude.result.sessionEnv.KORY_PERMISSION_LEASE).toBe("lease-descriptor");
  expect(nonClaude.calls).toEqual([]);
  expect(nonClaude.result.sessionEnv.KORY_PERMISSION_LEASE).toBe("");
  expect(sandboxed.calls).toEqual([]);
  expect(sandboxed.result.sessionEnv.KORY_PERMISSION_LEASE).toBe("");
});

test("the lease setup harness rejects a sandbox gate removed from the real source", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");
  const mutated = source.replace(
    "if (!sandboxed && isClaudeLaunch(base) && this.permissionLeases) {",
    "if (isClaudeLaunch(base) && this.permissionLeases) {"
  );
  const sandboxed = executeLeaseSetup(mutated, true, "claude");

  expect(sandboxed.calls).toEqual(["create:tile-1"]);
});

test("the spontaneous PTY exit callback revokes the matching lease before it emits exit", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");
  const listener = source.indexOf("this.pty.on('exit'");
  const open = source.indexOf("=> {", listener);
  if (listener < 0 || open < 0) throw new Error("spontaneous PTY exit callback not found");
  const handler = extractBracedBody(source, open + 3);

  expect(revokesBefore(handler, "this.revokePermissionLease(id)", "this.emit('exit'")).toBe(true);
});

test("utility PTYs discard any inherited permission lease", () => {
  const source = readFileSync(PTY_MANAGER_PATH, "utf8");
  expect(source).toContain("env.KORY_PERMISSION_LEASE = ''");
});

test("the Deck gives SessionService a lease runtime bound to its approval run", () => {
  const source = readFileSync(INDEX_PATH, "utf8");
  const runtimeAt = source.indexOf("const permissionLeases = new PermissionLeaseRuntime({");
  const serviceAt = source.indexOf("const service = new SessionService(");

  expect(runtimeAt).toBeGreaterThanOrEqual(0);
  expect(source.slice(runtimeAt, serviceAt)).toContain("runId: approvalRunId");
  expect(source.slice(serviceAt)).toContain("permissionLeases");
});

test("the lifecycle checker rejects a kill that has no preceding revocation", () => {
  expect(revokesBefore("this.pty.killAll()", "this.revokeAllPermissionLeases()", "this.pty.killAll()")).toBe(false);
});
