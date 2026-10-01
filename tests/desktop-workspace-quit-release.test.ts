import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceService } from "../desktop/src/main/workspace-service.ts";
import { lockPath } from "../desktop/src/main/workspace-lock.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshProject(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-quit-release-"));
  tmpDirs.push(d);
  return d;
}

/**
 * `failSave` makes the next persist() throw after the lock is taken, through
 * the refreshLiveSessionIds dependency it calls right before saveWorkspace.
 */
function makeService(projectDir: string): { svc: WorkspaceService; failSave: (e: Error) => void } {
  let failure: Error | null = null;
  const deps = {
    projectDir,
    service: {
      captureSessions: () => [
        {
          id: "local-quit",
          name: "quit",
          cwd: "/abs/project",
          command: "",
          args: "",
          sessionId: "sid-quit",
          color: "#4488ff",
          createdAt: 1,
        },
      ],
      refreshLiveSessionIds: () => {
        if (failure) throw failure;
      },
    },
    getConfig: () => ({ displayMode: "2x2", gridCols: 2, gridRows: 2 }),
    setConfig: () => {},
    getScope: () => ({
      secret: "s",
      scopeKind: "ephemeral",
      groupId: "b".repeat(32),
      name: "quit-scope",
      root: "test",
    }),
    adoptScope: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new WorkspaceService(deps as any);
  return { svc, failSave: (e) => (failure = e) };
}

test("a final save that throws still releases the workspace lock, and the error still reaches the caller", () => {
  const proj = freshProject();
  const { svc, failSave } = makeService(proj);
  const summary = svc.saveAuto();
  expect(summary).not.toBeNull();
  const lock = lockPath(proj, summary!.id);
  expect(["lock held before quit", existsSync(lock)]).toEqual(["lock held before quit", true]);

  const boom = new Error("disk full");
  failSave(boom);
  expect(() => svc.releaseOnQuit()).toThrow(boom);
  expect(["lock released despite the failed save", existsSync(lock)]).toEqual([
    "lock released despite the failed save",
    false,
  ]);
});

test("a final save that succeeds releases the lock", () => {
  const proj = freshProject();
  const { svc } = makeService(proj);
  const summary = svc.saveAuto();
  const lock = lockPath(proj, summary!.id);
  svc.releaseOnQuit();
  expect(existsSync(lock)).toBe(false);
});

test("no interval started by the service survives releaseOnQuit, so no heartbeat ticks on a released lock", () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const active = new Set<unknown>();
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSet(...args);
    active.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
    active.delete(handle);
    realClear(handle);
  }) as typeof clearInterval;
  try {
    const proj = freshProject();
    const { svc } = makeService(proj);
    svc.saveAuto();
    expect(active.size).toBeGreaterThan(0);
    svc.releaseOnQuit();
    expect(["intervals still running after releaseOnQuit", active.size]).toEqual([
      "intervals still running after releaseOnQuit",
      0,
    ]);
  } finally {
    for (const handle of active) realClear(handle as Parameters<typeof clearInterval>[0]);
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});
