import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// WorkspaceService only has pure runtime imports (workspace-store / -lock /
// -session-map + node:os); everything electron-adjacent is `import type`, so it
// loads under bun. Regression guard for the ENOENT crash where own() wrote the
// sidecar .lock before the workspaces dir existed (fresh project dir).
import { WorkspaceService } from "../desktop/src/main/workspace-service.ts";
import { workspacesDir } from "../desktop/src/main/workspace-store.ts";

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
  const d = mkdtempSync(join(tmpdir(), "cp-fresh-"));
  tmpDirs.push(d);
  return d;
}

function makeService(projectDir: string): WorkspaceService {
  // Minimal fakes: saveAuto only reaches service.refreshLiveSessionIds() +
  // captureSessions(), getConfig (display mode) and getScope
  // (name/groupId/scopeName/scopeKind).
  // captureSessions() must return a real session: this test targets the ENOENT
  // guard in own(), which is orthogonal to the empty-snapshot guard saveAuto()
  // now has (b8d65b24) -- an empty capture here would exercise THAT guard
  // instead and never reach the dir-creation path this test is pinning.
  const deps = {
    projectDir,
    service: {
      captureSessions: () => [
        {
          id: "local-fresh",
          name: "fresh",
          cwd: "/abs/project",
          command: "",
          args: "",
          sessionId: "sid-fresh",
          color: "#4488ff",
          createdAt: 1
        }
      ],
      refreshLiveSessionIds: () => {}
    },
    getConfig: () => ({ displayMode: "2x2", gridCols: 2, gridRows: 2 }),
    setConfig: () => {},
    getScope: () => ({
      secret: "s",
      scopeKind: "ephemeral",
      groupId: "a".repeat(32),
      name: "test-scope",
      root: "test",
    }),
    adoptScope: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new WorkspaceService(deps as any);
}

test("saveAuto does not ENOENT on a fresh project dir (own() ensures the dir)", () => {
  const proj = freshProject();
  // The .claude/claude-peers/workspaces tree does NOT exist yet.
  expect(existsSync(workspacesDir(proj))).toBe(false);

  const svc = makeService(proj);
  // Before the fix this threw ENOENT writing the .lock before the dir existed.
  expect(() => svc.saveAuto()).not.toThrow();

  // The dir now exists and holds a workspace json + its sidecar lock.
  expect(existsSync(workspacesDir(proj))).toBe(true);
  const files = readdirSync(workspacesDir(proj));
  expect(files.some((f) => f.endsWith(".json"))).toBe(true);
  expect(files.some((f) => f.endsWith(".lock"))).toBe(true);

  svc.releaseOnQuit();
});
