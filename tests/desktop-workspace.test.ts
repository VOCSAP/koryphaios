import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  BOOT_RECLAIM_TOLERANCE_MS,
  isLockLive,
  ownsLock,
  readLock,
  refreshLock,
  releaseLock,
  type Lock,
} from "../desktop/src/main/workspace-lock.ts";
import { gracefulClose } from "../desktop/src/main/session-close.ts";
// WorkspaceService's own runtime imports (node:os + the pure modules above)
// carry no electron/node-pty, so importing it directly under bun test proves
// the header comment above workspace-service.ts wrong -- see the correction
// made there alongside this test (card 438c15e3).
import { WorkspaceService, type WorkspaceDeps } from "../desktop/src/main/workspace-service.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import type { AppConfig, SessionDef } from "../desktop/src/shared/types.ts";
import type { Scope } from "../desktop/src/main/scope.ts";

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
  startedAt: 500,
  // Machine "booted" at epoch 0 in these tests -- well before any startedAt
  // used below, so the boot-instant reclaim check (see the dedicated tests
  // further down) never fires unless a test deliberately sets it later.
  bootInstant: 0,
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
  // acquireLock stamps the OWNER's real launch time (opts.startedAt),
  // never the acquisition instant (opts.now) -- the two are deliberately
  // different values in baseLiveness (500 vs 10_000) to catch a regression
  // back to the old `startedAt: opts.now` semantics.
  expect(lock!.startedAt).toBe(500);
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

// ----- boot-instant discriminant (card 438c15e3, review round 4) -----
//
// A bare pid-alive check cannot tell a still-running owner from an
// unrelated process that reused the same pid after a reboot. Round 3's fix
// (querying the OS for a foreign pid's actual start time) was dropped in
// round 4: it needs a subprocess per check, which is either a per-30s
// spawn risk or, worse, silently fails OPEN on any machine where the query
// itself fails (missing/restricted shell -- e.g. this product's own
// sandbox). The replacement is one-way and free: no process survives a
// reboot, so a lock recorded as started before THIS machine's boot is
// provably dead regardless of pid; anything else is inconclusive and falls
// back to a bare pid-alive check -- the pre-card guarantee, never "no
// guarantee".

test("isLockLive same-host: lock startedAt provably precedes this machine's boot AND heartbeat is stale -> dead, isPidAlive not even consulted", () => {
  // Reclaim without consulting isPidAlive needs BOTH halves (review round 6):
  // startedAt precedes boot AND the heartbeat is stale (<= now - staleMs =
  // 10_000 - 5_000 = 5_000). A fresh heartbeat alone would fall back to
  // isPidAlive instead (the NTP-jump gap the AND condition closes).
  const lock: Lock = { pid: 4242, host: "this-host", startedAt: 1_000, heartbeat: 5_000 };
  let called = false;
  const opts = {
    ...baseLiveness,
    bootInstant: 5_000, // 1_000 < 5_000 - BOOT_RECLAIM_TOLERANCE_MS -> provably dead
    isPidAlive: () => {
      called = true;
      return true; // even a "confirmed alive" pid must not save it
    },
  };
  expect(isLockLive(lock, opts)).toBe(false);
  expect(called).toBe(false);
});

test("isLockLive same-host: NTP forward jump alone does not steal a live lock -- fresh heartbeat falls back to isPidAlive (review round 6)", () => {
  // Models the review-round-5 vulnerability directly: an NTP correction
  // shifts bootInstant past a live owner's startedAt, so precedesBoot alone
  // would wrongly read as dead. The heartbeat half is what saves it here --
  // the owner is still beating, so heartbeatStale is false, the AND does
  // not fire, and the check correctly falls back to isPidAlive instead of
  // declaring the live owner dead.
  const lock: Lock = { pid: 4242, host: "this-host", startedAt: 900_000, heartbeat: 899_000 };
  let called = false;
  const opts = {
    ...baseLiveness,
    now: 900_500,
    staleMs: 5_000, // heartbeat(899_000) > now(900_500) - staleMs(5_000)=895_500 -> fresh
    bootInstant: 905_000, // jumped forward past startedAt -> precedesBoot true
    isPidAlive: () => {
      called = true;
      return true;
    },
  };
  expect(isLockLive(lock, opts)).toBe(true);
  expect(called).toBe(true);
});

test("isLockLive same-host: KNOWN LIMITATION -- a jump exceeding staleMs landing before the owner's next heartbeat still steals a live lock (review round 6, deliberately accepted, see Lock.startedAt doc)", () => {
  // Both AND halves can coincidentally hold for a still-alive owner when the
  // forward jump is large enough (> staleMs) and the check lands before the
  // owner's next heartbeat refreshes the clock -- documented residual, not
  // fixed here. isPidAlive is not even consulted, matching the same-host
  // early-return path a genuinely dead owner would take.
  const lock: Lock = { pid: 4242, host: "this-host", startedAt: 1_000, heartbeat: 4_000 };
  let called = false;
  const opts = {
    ...baseLiveness,
    now: 20_000, // heartbeat(4_000) <= now(20_000) - staleMs(5_000) -> stale
    bootInstant: 5_000, // startedAt(1_000) < bootInstant - tolerance -> precedes boot
    isPidAlive: () => {
      called = true;
      return true; // the owner IS still alive -- this is the accepted gap
    },
  };
  expect(isLockLive(lock, opts)).toBe(false);
  expect(called).toBe(false);
});

test("isLockLive same-host: lock startedAt at/after boot -> inconclusive, falls back to isPidAlive (both directions)", () => {
  const lock: Lock = { pid: 4242, host: "this-host", startedAt: 5_000, heartbeat: 9_000 };
  const opts = { ...baseLiveness, bootInstant: 5_000 };
  expect(isLockLive(lock, { ...opts, isPidAlive: () => true })).toBe(true);
  expect(isLockLive(lock, { ...opts, isPidAlive: () => false })).toBe(false);
});

test("isLockLive same-host: tolerance boundary fails toward 'cannot conclude', never toward 'provably dead'", () => {
  // startedAt sits EXACTLY at bootInstant - tolerance -- the comparison is
  // strict '<', so this must NOT be treated as provably dead (it must fall
  // back to isPidAlive), matching review round 4's explicit failure
  // direction: ambiguity favors the pre-card guarantee, not a reclaim.
  const lock: Lock = {
    pid: 4242,
    host: "this-host",
    startedAt: 5_000 - BOOT_RECLAIM_TOLERANCE_MS,
    heartbeat: 9_000,
  };
  const opts = { ...baseLiveness, bootInstant: 5_000 };
  expect(isLockLive(lock, { ...opts, isPidAlive: () => true })).toBe(true);
  expect(isLockLive(lock, { ...opts, isPidAlive: () => false })).toBe(false);
});

test("acquireLock: lock startedAt precedes this machine's boot, pid alive -> reclaimed (positive proof)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  acquireLock(proj, "wsp_1", { ...baseLiveness, pid: 4242, startedAt: 1_000, bootInstant: 0 });
  // A later liveness check runs on a machine that has since rebooted:
  // bootInstant now postdates the recorded owner's startedAt by more than
  // the tolerance, so the lock is provably stale even with a live pid. Also
  // advance `now` well past the first lock's heartbeat (stamped at
  // baseLiveness.now = 10_000) + staleMs (5_000) so the AND condition's
  // second half (heartbeat stale, review round 6) is satisfied too --
  // without it the reclaim would fall back to isPidAlive and stay refused.
  const reclaimed = acquireLock(proj, "wsp_1", {
    ...baseLiveness,
    now: 20_000,
    pid: 5555,
    startedAt: 6_000,
    bootInstant: 5_000,
    isPidAlive: () => true,
  });
  expect(reclaimed).toBe(true);
  const lock = readLock(proj, "wsp_1")!;
  expect(lock.pid).toBe(5555);
  expect(lock.startedAt).toBe(6_000);
});

test("acquireLock: lock startedAt at/after boot, pid alive -> refused, on-disk lock unchanged (negative proof)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  acquireLock(proj, "wsp_1", { ...baseLiveness, pid: 4242, startedAt: 6_000, bootInstant: 0 });
  const refused = acquireLock(proj, "wsp_1", {
    ...baseLiveness,
    pid: 9999,
    startedAt: 7_000,
    bootInstant: 5_000, // inconclusive: 6_000 >= 5_000 - 2_000
    isPidAlive: () => true,
  });
  expect(refused).toBe(false);
  const lock = readLock(proj, "wsp_1")!;
  expect(lock.pid).toBe(4242);
  expect(lock.startedAt).toBe(6_000);
});

test("acquireLock: lock startedAt at/after boot, pid dead -> reclaimed (fallback preserves the pre-card guarantee)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  acquireLock(proj, "wsp_1", { ...baseLiveness, pid: 4242, startedAt: 6_000, bootInstant: 0 });
  const reclaimed = acquireLock(proj, "wsp_1", {
    ...baseLiveness,
    pid: 9999,
    startedAt: 7_000,
    bootInstant: 5_000, // inconclusive on the boot check alone
    isPidAlive: () => false, // ...but the fallback still catches a dead owner
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
  const owner = { pid: 4242, host: "this-host" };
  expect(refreshLock(proj, "wsp_1", 99_999, owner)).toBe(true);
  expect(readLock(proj, "wsp_1")!.heartbeat).toBe(99_999);
  expect(releaseLock(proj, "wsp_1", owner)).toBe(true);
  expect(readLock(proj, "wsp_1")).toBeNull();
  expect(releaseLock(proj, "wsp_1", owner)).toBe(true); // already gone -> no-op, still ok
});

test("ownsLock matches pid+host exactly, mismatched pid or host both refuse", () => {
  const lock: Lock = { pid: 4242, host: "this-host", startedAt: 0, heartbeat: 0 };
  expect(ownsLock(lock, { pid: 4242, host: "this-host" })).toBe(true);
  expect(ownsLock(lock, { pid: 9999, host: "this-host" })).toBe(false);
  expect(ownsLock(lock, { pid: 4242, host: "other-host" })).toBe(false);
});

test("refreshLock refuses to re-stamp a lock owned by a different identity (no heartbeat theft)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  acquireLock(proj, "wsp_1", { ...baseLiveness, pid: 4242 });
  const foreign = { pid: 9999, host: "this-host" };
  expect(refreshLock(proj, "wsp_1", 99_999, foreign)).toBe(false);
  expect(readLock(proj, "wsp_1")!.heartbeat).not.toBe(99_999);
});

test("releaseLock refuses to delete a lock owned by a different identity (no cross-instance destruction)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  acquireLock(proj, "wsp_1", { ...baseLiveness, pid: 4242 });
  const foreign = { pid: 9999, host: "this-host" };
  expect(releaseLock(proj, "wsp_1", foreign)).toBe(false);
  expect(readLock(proj, "wsp_1")).not.toBeNull();
});

// ----- WorkspaceService (own()/persist()/restore() wiring) -----
//
// WorkspaceService's own runtime imports are electron/node-pty-free (node:os
// + the pure modules above); SessionService/Scope are `import type` only, so
// no real SessionService instance is needed -- a minimal stub covering the
// 3 methods WorkspaceService actually calls is enough.

function fakeSession(overrides: Partial<SessionDef> = {}): SessionDef {
  return {
    id: "local-1",
    name: "reviewer",
    cwd: "/abs/project",
    command: "",
    args: "",
    sessionId: "sid-1",
    color: "#4488ff",
    createdAt: 1000,
    ...overrides,
  } as SessionDef;
}

function fakeScope(): Scope {
  return {
    secret: "s3cr3t",
    scopeKind: "ephemeral",
    groupId: "a".repeat(64),
    name: "dev-pc-foo",
    root: "dev-pc-foo",
  };
}

function fakeDeps(
  proj: string,
  overrides: Partial<WorkspaceDeps> = {},
): WorkspaceDeps & { sessions: SessionDef[] } {
  const state = { sessions: [fakeSession()] as SessionDef[] };
  const deps: WorkspaceDeps & { sessions: SessionDef[] } = {
    projectDir: proj,
    service: {
      captureSessions: () => state.sessions,
      refreshLiveSessionIds: () => {},
      restoreFrom: (defs: SessionDef[]) => {
        state.sessions = defs;
      },
    } as unknown as WorkspaceDeps["service"],
    getConfig: () => ({ displayMode: "2x2", gridCols: 2, gridRows: 2 }) as AppConfig,
    setConfig: () => {},
    getScope: () => fakeScope(),
    adoptScope: () => {},
    // Card 09d54a29: benign default so the ~10 pre-existing restore() tests
    // above (whose sampleWorkspace() sessions carry non-empty `args` by
    // default) keep exercising what they actually test, not this gate --
    // the gate itself is covered by the dedicated tests below that override
    // this to a spy.
    confirmShellFields: () => true,
    // Card 09d54a29 follow-up (GX-SEC, auditor finding): same reasoning --
    // sampleWorkspace()'s default session cwd ("/abs/project") never equals
    // the real tmpdir `proj` fakeDeps is constructed with, so it would trip
    // this gate too on every pre-existing test unless defaulted benign here.
    confirmUntrustedCwd: () => true,
    pid: 4242,
    host: "this-host",
    ...overrides,
    sessions: state.sessions,
  };
  Object.defineProperty(deps, "sessions", { get: () => state.sessions });
  return deps;
}

test("WorkspaceService.restore(): TOCTOU race lost between the top guard and own() still returns false, not silently true, and does NOT corrupt the OLD workspace's file (review correction D1, card 07134c6a)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const oldWs = sampleWorkspace({ id: "wsp_old" });
  saveWorkspace(proj, oldWs);
  // A session shape distinguishable from oldWs's default ("reviewer") so the
  // anti-corruption assertion below cannot pass by content coincidence.
  const targetWs = sampleWorkspace({
    id: "wsp_target",
    sessions: [
      {
        claudeSessionId: "sid-target",
        name: "target-peer",
        cwd: "/abs/project",
        args: ["--agent", "target"],
        color: "#4488ff",
        position: 0,
      },
    ],
  });
  saveWorkspace(proj, targetWs);

  const deps = fakeDeps(proj);
  const svc = new WorkspaceService(deps);

  // Step 1: a REAL prior restore, so currentId is non-null and its lock is
  // genuinely on disk -- the exact state the corruption bug needed to exist
  // (a service freshly constructed with currentId already null, the
  // ORIGINAL test's shape, made the fix's two lines unreachable no-ops:
  // `grep -c "lock-race" tests/desktop-workspace.test.ts` found all 3
  // mentions in this one test, none of which ever exercised a non-null
  // currentId).
  expect(svc.restore("wsp_old")).toEqual({ ok: true });
  expect(svc.currentWorkspaceId).toBe("wsp_old");
  expect(readLock(proj, "wsp_old")).not.toBeNull();

  // Step 2: race-lose the restore of wsp_target -- restore()'s own
  // top-of-function guard (readLock + isLockLive + ownsLock) passes here
  // (wsp_target has no lock yet), so pre-seeding a foreign live lock before
  // calling restore() would only exercise THAT pre-existing guard
  // (b8d65b24), not the deeper own()-return-value fix this card adds. To
  // reach own()'s OWN refusal, a foreign instance must grab wsp_target's
  // lock in the window between the guard and own(id) -- simulated
  // deterministically via adoptScope(), the first deps call restore() makes
  // after its guard and before own(). Overridden on the SAME deps object
  // restore() already holds, so only THIS call races.
  deps.adoptScope = () => {
    acquireLock(proj, "wsp_target", {
      host: "other-host",
      now: Date.now(),
      startedAt: 1_000,
      staleMs: 5_000,
      isPidAlive: () => true,
      pid: 1,
    });
  };
  const result = svc.restore("wsp_target");
  // Card 07134c6a: this is the ONE reason where the operator's sessions
  // were ALREADY swapped by restoreFrom() before the lock reclaim failed --
  // 'lock-race', never lumped with the top-guard 'locked' case (a DIFFERENT
  // test), and never silently resolved.
  expect(result).toEqual({ ok: false, reason: "lock-race" });

  // Card 07134c6a C2: currentId must be null (not "wsp_old", the id it
  // still pointed at when own() failed), and wsp_old's OWN lock must have
  // been released -- both PRECONDITIONS of the anti-corruption fix, not the
  // fix itself.
  expect(svc.currentWorkspaceId).toBeNull();
  expect(readLock(proj, "wsp_old")).toBeNull();

  // THE assertion that actually pins the anti-corruption fix, not just its
  // preconditions: without releaseLock+currentId=null above, the debounced
  // auto-save the 'changed' event (restoreFrom already emitted it) arms
  // would call saveAuto() -> ensureCurrent() -> own(currentId) -> succeed
  // against the STILL-"wsp_old" id, silently overwriting wsp_old's FILE
  // with wsp_target's already-swapped sessions. Simulated directly here (no
  // timer needed): call saveAuto() -- with currentId now null, it mints a
  // FRESH id instead -- then read wsp_old's file back from disk.
  svc.saveAuto();
  const oldFileAfter = loadWorkspace(proj, "wsp_old");
  expect(oldFileAfter).not.toBeNull();
  expect(oldFileAfter!.sessions).toEqual(oldWs.sessions);

  svc.releaseOnQuit();
});

test("WorkspaceService.restore(): succeeds and owns the lock when nothing contends", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const ws = sampleWorkspace({ id: "wsp_target" });
  saveWorkspace(proj, ws);
  const deps = fakeDeps(proj);
  const svc = new WorkspaceService(deps);
  const result = svc.restore("wsp_target");
  expect(result).toEqual({ ok: true });
  expect(svc.currentWorkspaceId).toBe("wsp_target");
  const lock = readLock(proj, "wsp_target");
  expect(lock).not.toBeNull();
  expect(lock!.pid).toBe(4242);
  expect(lock!.host).toBe("this-host");
});

// Card 07134c6a: the two remaining sink reasons -- 'missing' and 'empty' --
// had no dedicated test before this card (only inferred client-side from a
// bare boolean). Pinned directly here now that restore() names them.

test("WorkspaceService.restore(): a workspace id with no saved file resolves to reason 'missing'", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const deps = fakeDeps(proj);
  const svc = new WorkspaceService(deps);
  const result = svc.restore("wsp_does_not_exist");
  expect(result).toEqual({ ok: false, reason: "missing" });
  expect(svc.currentWorkspaceId).not.toBe("wsp_does_not_exist");
});

test("WorkspaceService.restore(): a saved workspace with zero sessions resolves to reason 'empty', never reaching restoreFrom (b8d65b24 follow-up)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const ws = sampleWorkspace({ id: "wsp_empty", sessions: [] });
  saveWorkspace(proj, ws);
  const deps = fakeDeps(proj);
  const svc = new WorkspaceService(deps);
  const result = svc.restore("wsp_empty");
  expect(result).toEqual({ ok: false, reason: "empty" });
  // restoreFrom() must never run for an empty snapshot: it starts with
  // pty.killAll(), so "restoring nothing" would kill every live session for
  // no replacement.
  expect(deps.sessions).toEqual([fakeSession()]);
});

// Card 09d54a29: a repo-hostile workspace file's `args` is joined and
// appended VERBATIM to the login-shell command line (session-command.ts:195-
// 196), no escaping, once restoreFrom() reaches startPty. restore() must gate
// that on the same operator approval templates already require for their own
// command/args (B4, templateHasShellFields + launch-approval), BEFORE
// restoreFrom() ever runs -- not merely before the mode is decided, since
// session-service.ts's spawnSession (811-813) silently downgrades a `resume`
// with no matching transcript to `fresh` (re-attaching args), which an
// attacker gets for free by supplying a claudeSessionId that never had one.
test("WorkspaceService.restore(): refuses when args are shell-bearing and confirmShellFields declines (card 09d54a29)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const ws = sampleWorkspace({
    id: "wsp_hostile",
    sessions: [
      {
        // No transcript exists anywhere for this id -- irrelevant to this
        // gate, which fires on `args` content alone, independent of mode.
        claudeSessionId: "bogus-no-transcript",
        name: "reviewer",
        cwd: "/abs/project",
        args: ["--dangerously-skip-permissions", ";", "id", ">", "/tmp/PWNED"],
        color: "#4488ff",
        position: 0,
      },
    ],
  });
  saveWorkspace(proj, ws);
  let confirmCalls = 0;
  const deps = fakeDeps(proj, {
    confirmShellFields: () => {
      confirmCalls++;
      return false;
    },
  });
  const svc = new WorkspaceService(deps);
  const result = svc.restore("wsp_hostile");
  expect(result).toEqual({ ok: false, reason: "shell-declined" });
  // The exact shape of the vulnerability: restoreFrom() (-> startPty ->
  // buildSessionCommandLine) must never run. Proven here by the stub's
  // captured session defs being untouched from before the call.
  expect(deps.sessions).toEqual([fakeSession()]);
  expect(confirmCalls).toBe(1);
});

test("WorkspaceService.restore(): proceeds when args are shell-bearing and confirmShellFields approves", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  // sampleWorkspace()'s default session already carries non-empty args.
  const ws = sampleWorkspace({ id: "wsp_approved" });
  saveWorkspace(proj, ws);
  const deps = fakeDeps(proj, { confirmShellFields: () => true });
  const svc = new WorkspaceService(deps);
  const result = svc.restore("wsp_approved");
  expect(result).toEqual({ ok: true });
});

test("WorkspaceService.restore(): never asks for approval when no session carries args", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const ws = sampleWorkspace({
    id: "wsp_benign",
    sessions: [
      {
        claudeSessionId: "sid-1",
        name: "reviewer",
        cwd: "/abs/project",
        args: [],
        color: "#4488ff",
        position: 0,
      },
    ],
  });
  saveWorkspace(proj, ws);
  let confirmCalls = 0;
  const deps = fakeDeps(proj, {
    confirmShellFields: () => {
      confirmCalls++;
      return false;
    },
  });
  const svc = new WorkspaceService(deps);
  const result = svc.restore("wsp_benign");
  expect(result).toEqual({ ok: true });
  expect(confirmCalls).toBe(0);
});

// Card 09d54a29 follow-up (auditor finding, GX-SEC class): a hostile
// workspace with EMPTY args does not trip the shell-fields gate above, but
// its `cwd` is copied verbatim by fromWorkspaceSessions with zero
// containment. Once the restored session is live, ipc.ts's workDirRoots()
// (line 799) adds every live session's cwd to the allow-set requireWorkDir
// checks by exact match, so the attacker-chosen directory becomes readable
// via the diff/explorer IPC channels -- a SEPARATE vulnerability class
// (arbitrary file read, not command execution) from the args gate, hence a
// SEPARATE named predicate/callback rather than folded into the same one.
test("WorkspaceService.restore(): refuses when a session's cwd is outside the project tree and confirmUntrustedCwd declines (card 09d54a29 follow-up, GX-SEC)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const outside = mkdtempSync(join(tmpdir(), "cp-wsp-outside-"));
  tmpDirs.push(outside);
  const ws = sampleWorkspace({
    id: "wsp_hostile_cwd",
    cwd: proj,
    sessions: [
      {
        claudeSessionId: "sid-1",
        name: "reviewer",
        cwd: outside, // attacker-chosen read target, NOT inside `proj`
        args: [], // empty -- proves this is independent of the args gate
        color: "#4488ff",
        position: 0,
      },
    ],
  });
  saveWorkspace(proj, ws);
  let confirmCalls = 0;
  const deps = fakeDeps(proj, {
    confirmUntrustedCwd: () => {
      confirmCalls++;
      return false;
    },
  });
  const svc = new WorkspaceService(deps);
  const result = svc.restore("wsp_hostile_cwd");
  expect(result).toEqual({ ok: false, reason: "cwd-declined" });
  expect(deps.sessions).toEqual([fakeSession()]);
  expect(confirmCalls).toBe(1);
});

test("WorkspaceService.restore(): proceeds when cwd is outside the project tree and confirmUntrustedCwd approves", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const outside = mkdtempSync(join(tmpdir(), "cp-wsp-outside-"));
  tmpDirs.push(outside);
  const ws = sampleWorkspace({
    id: "wsp_approved_cwd",
    cwd: proj,
    sessions: [
      {
        claudeSessionId: "sid-1",
        name: "reviewer",
        cwd: outside,
        args: [],
        color: "#4488ff",
        position: 0,
      },
    ],
  });
  saveWorkspace(proj, ws);
  const deps = fakeDeps(proj, { confirmUntrustedCwd: () => true });
  const svc = new WorkspaceService(deps);
  const result = svc.restore("wsp_approved_cwd");
  expect(result).toEqual({ ok: true });
});

// No false positive on the common case: a saved multi-worktree workspace
// (sessions living under <projectDir>/.worktrees/<name>, the ONLY place
// createWorktree ever places them, worktree-service.ts) must restore
// without prompting, or every ordinary restore would nag the operator.
test("WorkspaceService.restore(): never asks about cwd for the project root or a .worktrees/ path under it", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const wt = join(proj, ".worktrees", "feature-x");
  mkdirSync(wt, { recursive: true });
  const ws = sampleWorkspace({
    id: "wsp_worktrees",
    cwd: proj,
    sessions: [
      { claudeSessionId: "sid-1", name: "root", cwd: proj, args: [], color: "#4488ff", position: 0 },
      { claudeSessionId: "sid-2", name: "wt", cwd: wt, args: [], color: "#4488ff", position: 1 },
    ],
  });
  saveWorkspace(proj, ws);
  let confirmCalls = 0;
  const deps = fakeDeps(proj, {
    confirmUntrustedCwd: () => {
      confirmCalls++;
      return false;
    },
  });
  const svc = new WorkspaceService(deps);
  const result = svc.restore("wsp_worktrees");
  expect(result).toEqual({ ok: true });
  expect(confirmCalls).toBe(0);
});

// heartbeatTick() is the extracted body of own()'s setInterval callback
// (card 438c15e3, review round 2): setInterval itself now contains only
// `() => this.heartbeatTick()`, a one-line, greppable, unproven remainder --
// everything ELSE the callback does is reachable and testable by calling
// heartbeatTick() directly, without an injectable timer.
test("WorkspaceService.heartbeatTick(): refreshes with THIS instance's own identity, self-ejects ONCE on mismatch (not per call)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const deps = fakeDeps(proj); // pid: 4242, host: "this-host"
  const svc = new WorkspaceService(deps);
  expect(svc.saveAuto()).not.toBeNull();
  const id = svc.currentWorkspaceId!;
  const tick = () => (svc as unknown as { heartbeatTick(): void }).heartbeatTick();

  // Phase 1: lock still ours -- heartbeatTick() must pass deps.pid/deps.host
  // to refreshLock() (not e.g. hardcoded/omitted values) and bump the
  // on-disk heartbeat, with no error reported.
  const before = readLock(proj, id)!.heartbeat;
  const reportedOwned: Array<{ scope: string; text: string }> = [];
  onDeckError((scope, text) => reportedOwned.push({ scope, text }));
  tick();
  onDeckError(() => {});
  expect(reportedOwned.length).toBe(0);
  expect(readLock(proj, id)!.heartbeat).toBeGreaterThanOrEqual(before);
  expect(readLock(proj, id)!.pid).toBe(4242);
  expect(readLock(proj, id)!.host).toBe("this-host");

  // Phase 2: steal the lock out from under this instance WITHOUT going
  // through WorkspaceService, so the next tick() must observe a mismatch.
  const foreignLock: Lock = { pid: 99_999, host: "this-host", startedAt: 0, heartbeat: 0 };
  writeFileSync(join(workspacesDir(proj), `${id}.lock`), JSON.stringify(foreignLock));

  const reported: Array<{ scope: string; text: string }> = [];
  onDeckError((scope, text) => reported.push({ scope, text }));
  try {
    tick();
    tick(); // second call must NOT re-trace -- a periodic error flood is
    // equivalent to no trace at all (a flood gets ignored).
  } finally {
    onDeckError(() => {});
  }
  expect(reported.length).toBe(1);
  expect(reported[0]!.text).toContain(id);
  // The foreign lock must be UNCHANGED: refreshLock() refused to re-stamp
  // it with our identity, proving the comparison actually ran against
  // deps.pid/deps.host rather than always succeeding regardless of who
  // calls it (which would silently keep a foreign lock alive forever --
  // the exact failure this card exists to close).
  expect(readLock(proj, id)).toEqual(foreignLock);
});

test("WorkspaceService.restore(): re-restoring the already-current workspace does not lose the lock (own() same-id fast path)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const ws = sampleWorkspace({ id: "wsp_target" });
  saveWorkspace(proj, ws);
  const deps = fakeDeps(proj);
  const svc = new WorkspaceService(deps);
  expect(svc.restore("wsp_target")).toEqual({ ok: true });
  const before = readLock(proj, "wsp_target");
  expect(before).not.toBeNull();
  // A second restore() of the SAME id this instance already owns must NOT
  // route through acquireLock() again: acquireLock() refuses whenever the
  // existing lock is live, with no identity special-case, so re-acquiring
  // our OWN live lock would spuriously fail without own()'s same-id fast
  // path -- turning a harmless self-restore into a reported error over
  // nothing (flagged by review before any code changed here: "own(x) when
  // currentId already x, the lock must survive the call").
  expect(svc.restore("wsp_target")).toEqual({ ok: true });
  expect(svc.currentWorkspaceId).toBe("wsp_target");
  expect(readLock(proj, "wsp_target")).toEqual(before);
});

test("WorkspaceService.saveNamed(): a third party reclaiming the lock file out from under a held currentId must refuse the write (review round 7)", () => {
  // Reviewer's probe (review round 7): hold wsp_target, have a THIRD PARTY
  // (not this instance) reclaim the on-disk lock file directly, then call
  // saveNamed() -- persist()'s ensureCurrent() must re-confirm ownership via
  // own()/ownsLock before writing, not trust the in-memory currentId. Before
  // this fix: threw=false, write went through under a foreign live lock.
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const ws = sampleWorkspace({ id: "wsp_target" });
  saveWorkspace(proj, ws);
  const deps = fakeDeps(proj); // pid: 4242, host: "this-host"
  const svc = new WorkspaceService(deps);
  expect(svc.restore("wsp_target")).toEqual({ ok: true });
  expect(svc.currentWorkspaceId).toBe("wsp_target");

  // Third party reclaims the file WITHOUT going through this WorkspaceService.
  // Uses THIS test process's own real pid so the production isPidAlive
  // (a genuine process.kill(pid, 0) check, wired unmocked through own() via
  // ensureCurrent()) sees a truly live foreign owner -- an arbitrary made-up
  // pid would very likely be dead on the test runner's machine and get
  // reclaimed instead of refused, which would pass this test for the wrong
  // reason. startedAt is "now" so it can never precede this machine's boot.
  const foreignLock: Lock = {
    pid: process.pid,
    host: "this-host",
    startedAt: Date.now(),
    heartbeat: Date.now(),
  };
  writeFileSync(join(workspacesDir(proj), "wsp_target.lock"), JSON.stringify(foreignLock));

  expect(() => svc.saveNamed("renamed")).toThrow("workspace-lock-unavailable");
  // The foreign lock must be UNCHANGED -- this instance must not have
  // re-stamped it with its own identity while "writing".
  expect(readLock(proj, "wsp_target")).toEqual(foreignLock);
  // this instance still (wrongly, in its own memory) believes it owns
  // wsp_target -- own()'s fast path answers that on the NEXT call by
  // re-reading the file, not by caching this refusal, but the refusal
  // itself is what matters here: the write must not have happened.
  expect(svc.currentWorkspaceId).toBe("wsp_target");
});

test("WorkspaceService.restore(): failing to acquire the NEW lock leaves the OLD lock intact (never lose both)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  saveWorkspace(proj, sampleWorkspace({ id: "wsp_a" }));
  saveWorkspace(proj, sampleWorkspace({ id: "wsp_b" }));
  const deps = fakeDeps(proj);
  const svc = new WorkspaceService(deps);
  expect(svc.restore("wsp_a")).toEqual({ ok: true });
  const lockABefore = readLock(proj, "wsp_a");
  expect(lockABefore).not.toBeNull();
  // wsp_b is already held live by a foreign instance -- own("wsp_b") must
  // refuse (acquireLock() returns false), and restore() must fail WITHOUT
  // touching wsp_a's lock: own() only releases the OLD lock AFTER the NEW
  // one is confirmed acquired (workspace-service.ts), so a failed
  // acquisition of the new id must never cost the old one.
  acquireLock(proj, "wsp_b", {
    host: "other-host",
    now: Date.now(),
    startedAt: 1_000,
    staleMs: 5_000,
    isPidAlive: () => true,
    pid: 1,
  });
  // Card 07134c6a: this failure fires at restore()'s TOP guard (the lock is
  // already held live by 'other-host' before restore() is even called) --
  // reason 'locked', distinct from the TOCTOU 'lock-race' test above (which
  // loses the race INSIDE own(), after sessions were already swapped).
  expect(svc.restore("wsp_b")).toEqual({ ok: false, reason: "locked" });
  expect(svc.currentWorkspaceId).toBe("wsp_a");
  expect(readLock(proj, "wsp_a")).toEqual(lockABefore);
});

test("WorkspaceService.saveAuto(): reclaims a lock left by a dead pid after the own()/persist() reordering (blocking measurement, service level)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(proj);
  const deps = fakeDeps(proj);
  const svc = new WorkspaceService(deps);
  const summary = svc.saveAuto();
  expect(summary).not.toBeNull();
  const id = svc.currentWorkspaceId!;
  // Kill this "instance" from the lock file's point of view by writing a
  // lock stamped with a pid nothing will answer for, then let a SECOND
  // WorkspaceService (fresh instance, same host, different pid) try to
  // restore the same workspace -- it must reclaim, not be permanently
  // refused, exactly the concern raised before writing any of this code.
  const deadLock: Lock = { pid: 777_777, host: "this-host", startedAt: 0, heartbeat: 0 };
  writeFileSync(join(workspacesDir(proj), `${id}.lock`), JSON.stringify(deadLock));
  const deps2 = fakeDeps(proj, { pid: 5555 });
  const svc2 = new WorkspaceService(deps2);
  const result = svc2.restore(id);
  expect(result).toEqual({ ok: true });
  expect(readLock(proj, id)!.pid).toBe(5555);
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
