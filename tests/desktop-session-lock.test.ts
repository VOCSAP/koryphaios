import { test, expect, mock, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body.ts";
import {
  CHANNEL_TIERS,
  COMPANION_MANIFEST,
  REMOTE_BLOCKED_CHANNELS
} from "../desktop/src/shared/companion.ts";

const DESKTOP_SRC = join(import.meta.dir, "..", "desktop", "src");

// The real SessionService is driven; only its two native/electron edges are
// replaced (node-pty by an inert fake, store.ts by a no-op persist), and the
// @shared aliases bun cannot resolve from desktop/ point at the real modules.
for (const name of ["session-status", "palette", "role", "reorder", "workflow", "announce", "types"]) {
  const real = join(DESKTOP_SRC, "shared", `${name}.ts`);
  if (existsSync(real)) mock.module(`@shared/${name}`, () => require(real));
}
const ptyExitHandlers: Array<(e: { exitCode: number }) => void> = [];
mock.module("node-pty", () => ({
  spawn() {
    return {
      pid: 41000,
      onData: () => ({ dispose() {} }),
      onExit: (handler: (e: { exitCode: number }) => void) => {
        ptyExitHandlers.push(handler);
        return { dispose() {} };
      },
      write() {},
      resize() {},
      kill() {}
    };
  }
}));
mock.module(join(DESKTOP_SRC, "main", "store.ts"), () => ({ saveSessions: () => {} }));

const { SessionService } = await import("../desktop/src/main/session-service.ts");
const { toWorkspaceSessions } = await import("../desktop/src/main/workspace-session-map.ts");
const { toTemplate } = await import("../desktop/src/shared/template.ts");

const { startDeckControl } = await import("../desktop/src/main/deck-control.ts");
const { wireTeamLeadRevocation } = await import("../desktop/src/main/team-lead-bridge.ts");

const tmpDirs: string[] = [];
const services: InstanceType<typeof SessionService>[] = [];
const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const s of services.splice(0)) s.stop();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(mint?: () => { mcpConfig: string; callerId: string } | null) {
  const home = mkdtempSync(join(tmpdir(), "kory-session-lock-"));
  tmpDirs.push(home);
  const cwd = join(home, "proj");
  mkdirSync(cwd, { recursive: true });
  const config = { projectDir: cwd, shell: "/bin/sh", interactiveShell: false } as never;
  const svc = new SessionService(() => config, () => ({}), "claude", () => "", home, mint);
  services.push(svc);
  const broadcasts: Array<Array<{ id: string; locked?: boolean }>> = [];
  svc.on("changed", (list) => broadcasts.push(list));
  return { svc, broadcasts };
}

function lockedOf(svc: InstanceType<typeof SessionService>, id: string): unknown {
  const tile = svc.list().find((t) => t.id === id);
  if (!tile) throw new Error(`tile ${id} not listed`);
  return tile.locked;
}

const NON_BOOLEANS: Array<[string, unknown]> = [
  ["the string 'true'", "true"],
  ["the number 1", 1],
  ["the number 0", 0],
  ["the empty string", ""],
  ["null", null],
  ["undefined", undefined],
  ["an object", {}]
];

test("a fresh tile is unlocked", () => {
  const { svc } = setup();
  const { id } = svc.create({});
  expect(lockedOf(svc, id), "a new tile starts unlocked").toBe(false);
});

test("setLocked refuses an unknown id and leaves every tile and the broadcast stream untouched", () => {
  const { svc, broadcasts } = setup();
  const { id } = svc.create({});
  svc.setLocked(id, true);
  const before = JSON.stringify(svc.list());
  const emitted = broadcasts.length;

  expect(() => svc.setLocked("no-such-tile", true)).toThrow("unknown session: no-such-tile");

  expect(JSON.stringify(svc.list()), "state after refused unknown id").toBe(before);
  expect(broadcasts.length, "refused unknown id must not broadcast").toBe(emitted);
});

test("setLocked refuses a non-boolean value and keeps the previous lock state, without broadcasting", () => {
  for (const startLocked of [false, true]) {
    for (const [label, value] of NON_BOOLEANS) {
      const { svc, broadcasts } = setup();
      const { id } = svc.create({});
      svc.setLocked(id, startLocked);
      const emitted = broadcasts.length;

      expect(() => svc.setLocked(id, value as never), `${label} over locked=${startLocked}`).toThrow(
        "locked must be boolean"
      );

      expect(lockedOf(svc, id), `${label} must not be stored (started locked=${startLocked})`).toBe(startLocked);
      expect(broadcasts.length, `${label} refused: no broadcast`).toBe(emitted);
    }
  }
});

test("a valid setLocked is projected for that tile only and broadcast once per change", () => {
  const { svc, broadcasts } = setup();
  const a = svc.create({});
  const b = svc.create({});
  const emitted = broadcasts.length;

  svc.setLocked(a.id, true);
  expect(broadcasts.length - emitted, "one broadcast for one lock").toBe(1);
  const afterLock = broadcasts.at(-1)!;
  expect(afterLock.find((t) => t.id === a.id)?.locked, "broadcast carries the locked tile").toBe(true);
  expect(afterLock.find((t) => t.id === b.id)?.locked, "the sibling tile stays unlocked").toBe(false);
  expect(lockedOf(svc, a.id)).toBe(true);
  expect(lockedOf(svc, b.id)).toBe(false);

  svc.setLocked(a.id, false);
  expect(broadcasts.length - emitted, "one broadcast per change").toBe(2);
  expect(broadcasts.at(-1)!.find((t) => t.id === a.id)?.locked, "unlock is broadcast").toBe(false);
  expect(lockedOf(svc, a.id)).toBe(false);
});

test("no persisted or exported projection carries the runtime-only lock, even for a locked tile", () => {
  const { svc } = setup();
  const a = svc.create({ name: "locked-one" });
  svc.create({ name: "other" });
  svc.setLocked(a.id, true);
  expect(lockedOf(svc, a.id), "precondition: the tile is locked").toBe(true);

  const captured = svc.captureSessions();
  expect(captured.length, "both tiles captured").toBe(2);
  for (const def of captured) {
    expect(Object.keys(def), "captureSessions def keys").not.toContain("locked");
  }

  for (const session of toWorkspaceSessions(captured)) {
    expect(Object.keys(session), "workspace session keys").not.toContain("locked");
  }
  for (const session of toTemplate(captured).sessions) {
    expect(Object.keys(session), "template session keys").not.toContain("locked");
  }
});

test("the serializers project explicitly and drop a lock carried by the input def", () => {
  const { svc } = setup();
  svc.create({ name: "tile" });
  const hostile = svc.captureSessions().map((def) => ({ ...def, locked: true }));

  for (const session of toWorkspaceSessions(hostile as never)) {
    expect(Object.keys(session), "workspace serializer must not spread the def").not.toContain("locked");
  }
  for (const session of toTemplate(hostile as never).sessions) {
    expect(Object.keys(session), "template serializer must not spread the def").not.toContain("locked");
  }
});

test("a minted team-lead caller id lives in runtime state only and reaches no persisted or exported projection", () => {
  const { svc } = setup(() => ({ mcpConfig: "/state/team-lead.json", callerId: "team-lead-test" }));
  const lead = svc.create({ name: "lead-tile", agent: "team-lead" }, { teamLeadDeckBridge: true });
  svc.create({ name: "other" });
  expect(svc.mintedCallerOf(lead.id), "precondition: the runtime holds the id").toBe("team-lead-test");
  expect(Object.keys(svc.list()[0]!), "the id stays out of the renderer-visible list").not.toContain("mintedCallerId");

  const captured = svc.captureSessions();
  expect(captured.length).toBe(2);
  for (const def of captured) {
    expect(Object.keys(def), "captureSessions def keys").not.toContain("mintedCallerId");
    expect(JSON.stringify(def), "captureSessions def").not.toContain("team-lead-test");
  }
  for (const session of toWorkspaceSessions(captured)) {
    expect(Object.keys(session), "workspace session keys").not.toContain("mintedCallerId");
    expect(JSON.stringify(session), "workspace session").not.toContain("team-lead-test");
  }
  for (const session of toTemplate(captured).sessions) {
    expect(Object.keys(session), "template session keys").not.toContain("mintedCallerId");
    expect(JSON.stringify(session), "template session").not.toContain("team-lead-test");
  }
});

async function leadRig() {
  let mintedCallerId = "";
  const { svc } = setup(() => ({ mcpConfig: "/state/team-lead.json", callerId: mintedCallerId }));
  const srv = await startDeckControl({
    listSessions: () => svc.list().map((s) => ({ ...s, mintedCallerId: svc.mintedCallerOf(s.id) }))
  } as never);
  servers.push(srv);
  const minted = srv.mintCaller("team-lead", null);
  mintedCallerId = minted.callerId;
  const cleaned: string[] = [];
  wireTeamLeadRevocation(svc, {
    revokeCallerForSession: (id: string) => srv.revokeCallerForSession(id),
    cleanupMcpFile: (callerId: string) => cleaned.push(callerId)
  });
  ptyExitHandlers.length = 0;
  const lead = svc.create({ name: "lead-tile", agent: "team-lead" }, { teamLeadDeckBridge: true });
  const tokenStatus = async (): Promise<number> =>
    (
      await fetch(`${srv.url}/call`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${minted.token}` },
        body: JSON.stringify({ tool: "deck_list_sessions", args: {} })
      })
    ).status;
  return { svc, lead, minted, cleaned, tokenStatus };
}

test("a clean PTY exit revokes the tile's team-lead token and asks for its MCP file cleanup", async () => {
  const { svc, lead, minted, cleaned, tokenStatus } = await leadRig();
  expect(await tokenStatus(), "token before the exit").toBe(200);

  ptyExitHandlers.at(-1)!({ exitCode: 0 });

  expect(svc.list().some((t) => t.id === lead.id), "the tile is gone").toBe(false);
  expect(await tokenStatus(), "token after the exit").toBe(401);
  expect(cleaned).toEqual([minted.callerId]);
});

test("an explicit remove revokes the tile's team-lead token and asks for its MCP file cleanup", async () => {
  const { svc, lead, minted, cleaned, tokenStatus } = await leadRig();
  expect(await tokenStatus(), "token before the remove").toBe(200);

  await svc.remove(lead.id);

  expect(svc.list().some((t) => t.id === lead.id), "the tile is gone").toBe(false);
  expect(await tokenStatus(), "token after the remove").toBe(401);
  expect(cleaned).toEqual([minted.callerId]);
});

test("a throwing exit listener does not leave a clean-exited tile listed as running", () => {
  const { svc } = setup();
  const survivor = svc.create({ name: "survivor" });
  ptyExitHandlers.length = 0;
  svc.create({ name: "exits-cleanly" });
  svc.on("exit", () => {
    throw new Error("listener failed");
  });

  expect(() => ptyExitHandlers.at(-1)!({ exitCode: 0 })).toThrow("listener failed");

  expect(svc.list().map((t) => t.id)).toEqual([survivor.id]);
});

test("a crashed PTY (non-zero exit) keeps the token: the tile stays restartable", async () => {
  const { svc, lead, cleaned, tokenStatus } = await leadRig();

  ptyExitHandlers.at(-1)!({ exitCode: 1 });

  expect(svc.list().find((t) => t.id === lead.id)?.status).toBe("exited");
  expect(await tokenStatus()).toBe(200);
  expect(cleaned).toEqual([]);
});

const types = readFileSync(join(DESKTOP_SRC, "shared", "types.ts"), "utf8");
const ipc = readFileSync(join(DESKTOP_SRC, "main", "ipc.ts"), "utf8");
const preload = readFileSync(join(DESKTOP_SRC, "preload", "index.ts"), "utf8");

function interfaceBody(source: string, name: string): string {
  const pattern = new RegExp(`interface\\s+${name}(?:\\s+extends[^\\{]+)?\\s*\\{`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`missing ${pattern.source}`);
  return extractBracedBody(source, source.indexOf("{", match.index));
}

test("the renderer runtime type declares the lock and the persisted session def does not", () => {
  expect(interfaceBody(types, "SessionRuntime")).toContain("locked?: boolean");
  expect(interfaceBody(types, "SessionDef")).not.toMatch(/\blocked\b/);
});

test("the local IPC chain exposes the lock channel and paired companions are refused", () => {
  expect(ipc).toMatch(
    /regHandle\('sessions:set-locked',\s*\(_e, id: string, locked: boolean\)\s*=>\s*service\.setLocked\(id, locked\)\s*\)/
  );
  expect(preload).toContain("setSessionLocked: (id: string, locked: boolean) =>");
  expect(interfaceBody(types, "DeckApi")).toContain(
    "setSessionLocked(id: string, locked: boolean): Promise<void>"
  );
  expect(COMPANION_MANIFEST.setSessionLocked).toEqual({
    kind: "invoke",
    channel: "sessions:set-locked"
  });
  expect(CHANNEL_TIERS["sessions:set-locked"]).toBe(2);
  expect(REMOTE_BLOCKED_CHANNELS.has("sessions:set-locked")).toBe(true);
});
