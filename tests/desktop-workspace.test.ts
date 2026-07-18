import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// All three modules import only node builtins (no electron / node-pty), so they
// import cleanly under bun and cover the riskiest M6b data-layer logic.
import {
  type Workspace,
  autoName,
  deleteWorkspace,
  ensureWorkspacesDir,
  listWorkspaces,
  loadWorkspace,
  newWorkspaceId,
  saveWorkspace,
  selectPrunableWorkspaces,
  workspacesDir,
} from "../desktop/src/main/workspace-store.ts";
import {
  acquireLock,
  isLockLive,
  readLock,
  refreshLock,
  releaseLock,
  type Lock,
} from "../desktop/src/main/workspace-lock.ts";
import { gracefulClose } from "../desktop/src/main/session-close.ts";

// A non-secret sentinel value used to prove the store strips a stray
// scopeSecret-like field; deliberately not credential-shaped.
const LEAK_MARKER = "leak-sentinel-xyz";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function freshProject(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-wsp-"));
  tmpDirs.push(d);
  return d;
}

function sampleWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: newWorkspaceId(),
    name: "Team feature-X",
    pinned: false,
    cwd: "/abs/project",
    groupId: "a".repeat(64),
    scopeName: "dev-pc-foo",
    scopeKind: "ephemeral",
    displayMode: { kind: "grid", x: 2, y: 2 },
    createdAt: 1000,
    updatedAt: 1000,
    sessions: [
      {
        claudeSessionId: "sid-1",
        name: "reviewer",
        cwd: "/abs/project",
        args: ["--agent", "reviewer"],
        color: "#4488ff",
        position: 0,
      },
    ],
    ...overrides,
  };
}

// ----- workspace-store -----

test("saveWorkspace + loadWorkspace round-trips (modulo updatedAt) and stores no secret", () => {
  const proj = freshProject();
  const ws = sampleWorkspace();
  // Sneak a stray secret-like field in to prove it is stripped on save.
  const saved = saveWorkspace(proj, { ...ws, scopeSecret: LEAK_MARKER } as Workspace);
  expect((saved as Record<string, unknown>).scopeSecret).toBeUndefined();

  const loaded = loadWorkspace(proj, ws.id);
  expect(loaded).not.toBeNull();
  expect(loaded!.id).toBe(ws.id);
  expect(loaded!.sessions).toEqual(ws.sessions);
  expect((loaded as Record<string, unknown>).scopeSecret).toBeUndefined();

  // The persisted bytes must not contain the sentinel anywhere.
  const raw = readFileSync(join(workspacesDir(proj), `${ws.id}.json`), "utf8");
  expect(raw).not.toContain(LEAK_MARKER);
});

test("listWorkspaces sorts by updatedAt desc and skips malformed files", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  saveWorkspace(proj, sampleWorkspace({ name: "old", updatedAt: 1 }));
  saveWorkspace(proj, sampleWorkspace({ name: "newer" }));
  writeFileSync(join(workspacesDir(proj), "garbage.json"), "{ not json");

  const list = listWorkspaces(proj);
  expect(list.length).toBe(2);
  // Sorted desc by updatedAt -> non-increasing.
  expect(list[0]!.updatedAt).toBeGreaterThanOrEqual(list[1]!.updatedAt);
});

test("loadWorkspace returns null for malformed/missing", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  writeFileSync(join(workspacesDir(proj), "wsp_bad.json"), "{ partial");
  expect(loadWorkspace(proj, "wsp_bad")).toBeNull();
  expect(loadWorkspace(proj, "wsp_absent")).toBeNull();
});

test("ensureWorkspacesDir creates tree and adds gitignore line exactly once", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  ensureWorkspacesDir(proj); // idempotent
  const gitignore = join(proj, ".claude", "claude-peers", ".gitignore");
  expect(existsSync(workspacesDir(proj))).toBe(true);
  const lines = readFileSync(gitignore, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() === "workspaces/");
  expect(lines.length).toBe(1);
});

test("ensureWorkspacesDir preserves a pre-existing gitignore (keeps config.json committable)", () => {
  const proj = freshProject();
  const cpDir = join(proj, ".claude", "claude-peers");
  ensureWorkspacesDir(proj);
  // Simulate a hand-written gitignore that already ignores something else.
  writeFileSync(join(cpDir, ".gitignore"), "*.local\n");
  ensureWorkspacesDir(proj);
  const body = readFileSync(join(cpDir, ".gitignore"), "utf8");
  expect(body).toContain("*.local");
  expect(body).toContain("workspaces/");
});

test("deleteWorkspace removes json + lock and is a no-op when already gone", () => {
  const proj = freshProject();
  const ws = sampleWorkspace();
  saveWorkspace(proj, ws);
  writeFileSync(join(workspacesDir(proj), `${ws.id}.lock`), "{}");
  deleteWorkspace(proj, ws.id);
  expect(existsSync(join(workspacesDir(proj), `${ws.id}.json`))).toBe(false);
  expect(existsSync(join(workspacesDir(proj), `${ws.id}.lock`))).toBe(false);
  expect(() => deleteWorkspace(proj, ws.id)).not.toThrow(); // already gone
});

test("autoName has a fixed prefix, no em dash, and the HH:MM", () => {
  const name = autoName("dev-pc-foo", new Date(2026, 5, 1, 14, 32));
  expect(name).toContain("auto");
  expect(name).toContain("dev-pc-foo");
  expect(name).toContain("14:32");
  expect(name).not.toContain("—"); // em dash banned
});

// ----- selectPrunableWorkspaces (D6) -----

test("selectPrunableWorkspaces picks only unpinned workspaces past the age cutoff", () => {
  const now = 1_000_000_000;
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
  const fresh = sampleWorkspace({ id: "wsp_fresh", updatedAt: now - 1000 });
  const old = sampleWorkspace({ id: "wsp_old", updatedAt: now - maxAgeMs - 1 });
  const ids = selectPrunableWorkspaces([fresh, old], { now, maxAgeMs });
  expect(ids).toEqual(["wsp_old"]);
});

test("selectPrunableWorkspaces never prunes a pinned workspace however old", () => {
  const now = 1_000_000_000;
  const maxAgeMs = 1000;
  const oldPinned = sampleWorkspace({ id: "wsp_pin", pinned: true, updatedAt: 0 });
  expect(selectPrunableWorkspaces([oldPinned], { now, maxAgeMs })).toEqual([]);
});

test("selectPrunableWorkspaces excludes keepIds (the current workspace) even if old", () => {
  const now = 1_000_000_000;
  const maxAgeMs = 1000;
  const a = sampleWorkspace({ id: "wsp_a", updatedAt: 0 });
  const b = sampleWorkspace({ id: "wsp_b", updatedAt: 0 });
  const ids = selectPrunableWorkspaces([a, b], { now, maxAgeMs, keepIds: ["wsp_a"] });
  expect(ids).toEqual(["wsp_b"]);
});

test("selectPrunableWorkspaces is a no-op on an empty list and respects the exact boundary", () => {
  const now = 1_000_000_000;
  const maxAgeMs = 1000;
  expect(selectPrunableWorkspaces([], { now, maxAgeMs })).toEqual([]);
  // updatedAt exactly at the cutoff is NOT older-than -> kept.
  const atCutoff = sampleWorkspace({ id: "wsp_edge", updatedAt: now - maxAgeMs });
  expect(selectPrunableWorkspaces([atCutoff], { now, maxAgeMs })).toEqual([]);
});

// ----- workspace-lock -----

const baseLiveness = {
  host: "this-host",
  now: 10_000,
  staleMs: 5_000,
  isPidAlive: () => true,
};

test("acquireLock writes a fresh lock when none exists", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const ok = acquireLock(proj, "wsp_1", { ...baseLiveness, pid: 4242 });
  expect(ok).toBe(true);
  const lock = readLock(proj, "wsp_1");
  expect(lock).not.toBeNull();
  expect(lock!.pid).toBe(4242);
  expect(lock!.host).toBe("this-host");
});

test("acquireLock refuses a live same-host owner, reclaims a dead one", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  acquireLock(proj, "wsp_1", { ...baseLiveness, pid: 4242 });

  // Same host, pid alive -> refuse.
  expect(
    acquireLock(proj, "wsp_1", { ...baseLiveness, pid: 9999, isPidAlive: () => true }),
  ).toBe(false);

  // Same host, pid dead -> reclaim.
  const reclaimed = acquireLock(proj, "wsp_1", {
    ...baseLiveness,
    pid: 9999,
    isPidAlive: () => false,
  });
  expect(reclaimed).toBe(true);
  expect(readLock(proj, "wsp_1")!.pid).toBe(9999);
});

test("isLockLive cross-host relies on heartbeat freshness, boundary is stale", () => {
  const lock: Lock = { pid: 1, host: "other-host", startedAt: 0, heartbeat: 5_000 };
  // now=10_000, staleMs=5_000 -> heartbeat must be > 5_000 to be live.
  expect(isLockLive(lock, { ...baseLiveness })).toBe(false); // exactly at boundary -> stale
  expect(isLockLive({ ...lock, heartbeat: 5_001 }, { ...baseLiveness })).toBe(true);
});

test("refreshLock updates heartbeat; releaseLock removes the file (no-op if gone)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  acquireLock(proj, "wsp_1", { ...baseLiveness, pid: 4242 });
  refreshLock(proj, "wsp_1", 99_999);
  expect(readLock(proj, "wsp_1")!.heartbeat).toBe(99_999);
  releaseLock(proj, "wsp_1");
  expect(readLock(proj, "wsp_1")).toBeNull();
  expect(() => releaseLock(proj, "wsp_1")).not.toThrow();
});

// ----- session-close -----

const noDelay = (): Promise<void> => Promise.resolve();

test("gracefulClose returns 'exit' when the process dies after /exit", async () => {
  const writes: string[] = [];
  let alive = true;
  const outcome = await gracefulClose({
    write: (d) => {
      writes.push(d);
      if (d === "/exit\n") alive = false; // dies on the clean exit
    },
    isAlive: () => alive,
    kill: () => {
      throw new Error("should not kill");
    },
    delay: noDelay,
  });
  expect(outcome).toBe("exit");
  expect(writes).toEqual(["/exit\n"]);
});

test("gracefulClose returns 'interrupt' when it dies only after Esc/Ctrl+C", async () => {
  const writes: string[] = [];
  let alive = true;
  const outcome = await gracefulClose({
    write: (d) => {
      writes.push(d);
      if (d === "\x03") alive = false; // dies on Ctrl+C
    },
    isAlive: () => alive,
    kill: () => {
      throw new Error("should not kill");
    },
    delay: noDelay,
  });
  expect(outcome).toBe("interrupt");
  expect(writes).toContain("\x1b");
  expect(writes).toContain("\x03");
});

test("gracefulClose escalates to 'sigterm' when nothing else stops it", async () => {
  let killed = false;
  const outcome = await gracefulClose({
    write: () => {},
    isAlive: () => true, // never dies on its own
    kill: () => {
      killed = true;
    },
    delay: noDelay,
  });
  expect(outcome).toBe("sigterm");
  expect(killed).toBe(true);
});

test("gracefulClose returns 'exit' immediately when already dead", async () => {
  let wrote = false;
  const outcome = await gracefulClose({
    write: () => {
      wrote = true;
    },
    isAlive: () => false,
    kill: () => {},
    delay: noDelay,
  });
  expect(outcome).toBe("exit");
  expect(wrote).toBe(false); // no /exit written to a dead session
});
