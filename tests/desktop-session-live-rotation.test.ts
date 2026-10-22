// SessionService.refreshLiveSessionIds driven through the real class: which
// back-channel write a spawned tile adopts at save time. node-pty and store.ts
// (electron) are replaced by factories carrying their whole runtime export
// surface; the `@shared/*` aliases bun cannot resolve from desktop/ point at
// the real modules.
import { test, expect, mock, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionWithWorktree, restartSessionGated } from "../desktop/src/main/create-session.ts";
import { LaunchAttemptRegistry, type LaunchModPlan } from "../desktop/src/main/mod-launch-plan.ts";

const DESKTOP_SRC = join(import.meta.dir, "..", "desktop", "src");
for (const name of ["session-status", "palette", "role", "reorder", "workflow", "announce", "types"]) {
  const real = join(DESKTOP_SRC, "shared", `${name}.ts`);
  if (existsSync(real)) mock.module(`@shared/${name}`, () => require(real));
}

function fakePty() {
  return {
    pid: 42000,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {},
    resize() {},
    kill() {},
  };
}
mock.module("node-pty", () => ({
  spawn: fakePty,
  fork: fakePty,
  createTerminal: fakePty,
  open: () => {
    throw new Error("node-pty open is not faked");
  },
  native: null,
}));
mock.module(join(DESKTOP_SRC, "main", "store.ts"), () => ({
  saveSessions: () => {},
  loadConfig: () => ({}),
  saveConfig: () => {},
  DEFAULT_CONFIG: {},
}));

const { SessionService } = await import("../desktop/src/main/session-service.ts");
const { encodeProjectDir } = await import("../desktop/src/main/session-transcript.ts");
const { deskSessionFileName } = await import("../desktop/src/main/desk-session.ts");

const tmpDirs: string[] = [];
const services: InstanceType<typeof SessionService>[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function spawnTile(
  beforeCreate?: (service: InstanceType<typeof SessionService>) => void,
  pluginDirs: (hasDeckLeadTools: boolean, sandboxed: boolean, modDirs?: readonly string[]) => readonly string[] = () => []
) {
  const home = mkdtempSync(join(tmpdir(), "kory-live-rotation-"));
  tmpDirs.push(home);
  const cwd = join(home, "proj");
  mkdirSync(cwd, { recursive: true });
  const config = { projectDir: cwd, shell: "/bin/sh", interactiveShell: false } as never;
  const svc = new SessionService(() => config, () => ({}), "claude", pluginDirs, home);
  svc.setTileSettingsFileProvider(() => join(home, "tile-settings.json"));
  beforeCreate?.(svc);
  services.push(svc);
  const { id } = svc.create({});
  const peers = join(home, ".claude", "peers");
  mkdirSync(peers, { recursive: true });
  const projects = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(projects, { recursive: true });
  // Synchronous from the write to the refresh: the discovery poll cannot run
  // in between, so what gets adopted is refreshLiveSessionIds' decision alone.
  const writeAndRefresh = (sid: string, source: string): string => {
    writeFileSync(join(projects, `${sid}.jsonl`), "{}\n", "utf-8");
    writeFileSync(join(peers, deskSessionFileName(id)), JSON.stringify({ sid, source }), "utf-8");
    svc.refreshLiveSessionIds();
    const tile = svc.list().find((t) => t.id === id);
    if (!tile) throw new Error(`tile ${id} not listed`);
    return tile.sessionId;
  };
  return { service: svc, id, writeAndRefresh };
}

test("removing a tile prevents a pending restart plan from starting a late PTY", async () => {
  const { service, id } = spawnTile();
  const registry = new LaunchAttemptRegistry();
  service.setLaunchAttemptRegistry(registry);
  let resolvePlan: (value: LaunchModPlan) => void = () => {};
  const plan = new Promise<LaunchModPlan>((resolve) => { resolvePlan = resolve; });
  let markPrepared: () => void = () => {};
  const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });

  const restart = restartSessionGated(service, id, {
    sandboxGate: async () => null,
    warmSandboxTranscripts: async () => {},
    modLaunch: {
      registry,
      prepare: async () => {
        markPrepared();
        return plan;
      }
    }
  });
  await prepared;
  await service.remove(id);
  resolvePlan({ attemptId: "late", mode: "host", modDirs: [], diagnostics: [] });

  await expect(restart).rejects.toThrow("mod launch superseded");
});

test("stopping during restart cleanup prevents a late PTY", async () => {
  let releaseCleanup: () => void = () => {};
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let markCleanup: () => void = () => {};
  const cleanupStarted = new Promise<void>((resolve) => { markCleanup = resolve; });
  const { service, id } = spawnTile((svc) => {
    svc.setSandboxProvider(() => ({
      engine: "docker",
      containerId: "container",
      wrap: (_tileId, _sessionId, command) => command,
      cleanup: async () => {
        markCleanup();
        await cleanup;
      }
    }));
  });
  const registry = new LaunchAttemptRegistry();
  service.setLaunchAttemptRegistry(registry);

  const restart = restartSessionGated(service, id, {
    sandboxGate: async () => null,
    warmSandboxTranscripts: async () => {},
    modLaunch: { registry, prepare: async (attempt) => ({ attemptId: attempt.attemptId, mode: "host", modDirs: [], diagnostics: [] }) }
  });
  await cleanupStarted;
  service.stop();
  releaseCleanup();

  await expect(restart).rejects.toThrow("mod launch superseded");
});

test("restoreFrom preserves its plans while cancelling replaced tile attempts", () => {
  let receivedModDirs: readonly string[] | undefined;
  const { service, id } = spawnTile(undefined, (_hasDeckLeadTools, _sandboxed, modDirs) => {
    receivedModDirs = modDirs;
    return [];
  });
  const registry = new LaunchAttemptRegistry();
  service.setLaunchAttemptRegistry(registry);
  const replaced = registry.begin(service.create({}).id);
  const restored = registry.begin(id);
  const [restoredDef] = service.captureSessions();
  if (!restoredDef) throw new Error("restored definition missing");
  restoredDef.sessionId = undefined;

  service.restoreFrom([restoredDef], new Map([[id, { attemptId: restored.attemptId, mode: "host", modDirs: ["/mods/restored"], diagnostics: [] }]]));

  expect(replaced.signal.aborted).toBe(true);
  expect(restored.signal.aborted).toBe(false);
  expect(receivedModDirs).toEqual(["/mods/restored"]);
});

test("restoreFrom unregisters the attempt of every tile it launched, so the registry keeps nothing for a launched tile", () => {
  const { service, id } = spawnTile();
  const registry = new LaunchAttemptRegistry();
  service.setLaunchAttemptRegistry(registry);
  const restored = registry.begin(id);
  const [restoredDef] = service.captureSessions();
  if (!restoredDef) throw new Error("restored definition missing");
  restoredDef.sessionId = undefined;

  service.restoreFrom([restoredDef], new Map([[id, { attemptId: restored.attemptId, mode: "host", modDirs: [], diagnostics: [] }]]));

  expect(registry.isCurrent(restored.attemptId), "a launched tile's attempt must be completed, not left registered").toBe(false);
  registry.cancelAll();
  expect(restored.signal.aborted, "cancelAll must find nothing left to abort after restoreFrom launched the tile").toBe(false);
});

test("restoreFrom launches every definition sharing one restore attempt before completing it", () => {
  const receivedModDirs: readonly string[][] = [];
  const { service, id } = spawnTile(undefined, (_hasDeckLeadTools, _sandboxed, modDirs) => {
    receivedModDirs.push(modDirs ?? []);
    return [];
  });
  const second = service.create({}).id;
  const third = service.create({}).id;
  const registry = new LaunchAttemptRegistry();
  service.setLaunchAttemptRegistry(registry);
  const restored = registry.begin(id);
  registry.share(restored.attemptId, new Set([id, second, third]));
  const defs = service.captureSessions();
  for (const def of defs) def.sessionId = undefined;
  const plan = { attemptId: restored.attemptId, mode: "host" as const, modDirs: ["/mods/shared"], diagnostics: [] };
  const startsBeforeRestore = receivedModDirs.length;

  service.restoreFrom(defs, new Map([[id, plan], [second, plan], [third, plan]]));

  expect(receivedModDirs.slice(startsBeforeRestore)).toEqual([["/mods/shared"], ["/mods/shared"], ["/mods/shared"]]);
  expect(registry.isCurrent(restored.attemptId)).toBe(false);
});

test("restoreFrom cancels a pending fresh creation while retaining its own plan", async () => {
  const { service, id } = spawnTile();
  const registry = new LaunchAttemptRegistry();
  service.setLaunchAttemptRegistry(registry);
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  let markGate: () => void = () => {};
  const enteredGate = new Promise<void>((resolve) => { markGate = resolve; });
  const create = createSessionWithWorktree(service, service.list()[0]!.cwd, {}, {
    sandboxGate: async () => { markGate(); await gate; return null; },
    warmSandboxTranscripts: async () => {},
    modLaunch: {
      attemptKey: "new:pending",
      registry,
      prepare: async (attempt) => ({ attemptId: attempt.attemptId, mode: "host", modDirs: [], diagnostics: [] })
    }
  });
  await enteredGate;
  const [restoredDef] = service.captureSessions();
  if (!restoredDef) throw new Error("restored definition missing");
  restoredDef.sessionId = undefined;
  const restored = registry.begin(id);

  service.restoreFrom([restoredDef], new Map([[id, { attemptId: restored.attemptId, mode: "host", modDirs: [], diagnostics: [] }]]));
  releaseGate();

  await expect(create).rejects.toThrow("mod launch superseded");
  expect(service.list()).toHaveLength(1);
});

test("closeAll cancels every pending launch attempt", () => {
  const { service, id } = spawnTile();
  const registry = new LaunchAttemptRegistry();
  service.setLaunchAttemptRegistry(registry);
  const tileAttempt = registry.begin(id);
  const otherAttempt = registry.begin("pending-other");

  service.closeAll();

  expect(tileAttempt.signal.aborted).toBe(true);
  expect(otherAttempt.signal.aborted).toBe(true);
});

test("a tile with no real id yet adopts its first write at save time, even a late register", () => {
  const { writeAndRefresh } = spawnTile();
  expect(writeAndRefresh("tile-real-x", "register")).toBe("tile-real-x");
});

test("once a real id is adopted, a later register write is ignored and a /clear rotation is adopted", () => {
  const { writeAndRefresh } = spawnTile();
  expect(writeAndRefresh("tile-real-x", "register"), "first write").toBe("tile-real-x");
  expect(writeAndRefresh("child-probe-y", "register"), "a child's register after adoption").toBe("tile-real-x");
  expect(writeAndRefresh("rotated-z", "clear"), "the tile's own /clear").toBe("rotated-z");
});
