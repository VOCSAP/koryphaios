import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// WorkspaceService only has pure runtime imports (workspace-store / -lock /
// -session-map + node:os); everything electron-adjacent is `import type`, so
// it loads under bun. Regression guard for b8d65b24: saveAuto() kept sessions
// on ONE list (service.list(), includes the supervisor) while persist()
// serialized ANOTHER (captureSessions(), excludes it) -- a supervisor-only
// moment passed the old guard and persisted `sessions: []`, minting a phantom
// workspace and clobbering a real snapshot the same way.
import { WorkspaceService } from "../desktop/src/main/workspace-service.ts";
import { listWorkspaces, saveWorkspace, type Workspace } from "../desktop/src/main/workspace-store.ts";

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
  const d = mkdtempSync(join(tmpdir(), "cp-empty-snap-"));
  tmpDirs.push(d);
  return d;
}

interface Def {
  id: string;
  name: string;
  cwd: string;
  command: string;
  args: string;
  sessionId: string;
  color: string;
  createdAt: number;
}

// `cwd` is the real project dir (threaded in by each caller, all of which
// have it in scope as `proj`) rather than a placeholder: this file's fixtures
// must be genuinely IN-TREE so confirmUntrustedCwd (card 09d54a29 follow-up)
// has no legitimate reason to fire here -- see makeService below.
function def(name: string, cwd: string): Def {
  return {
    id: `local-${name}`,
    name,
    cwd,
    command: "",
    args: "",
    sessionId: `sid-${name}`,
    color: "#4488ff",
    createdAt: 1,
  };
}

function makeService(projectDir: string, capture: () => Def[], restored: Def[][]) {
  const deps = {
    projectDir,
    service: {
      captureSessions: capture,
      refreshLiveSessionIds: () => {},
      restoreFrom: (defs: Def[]) => {
        restored.push(defs);
        return [];
      },
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
    // Card 09d54a29 (+ follow-up): NONE of this file's fixtures carry
    // shell-bearing args or an out-of-project cwd (def() above always uses
    // the real `proj`), so restore() must never even ask. Throwing here
    // (rather than returning a fixed value) turns an unexpected call into a
    // visible test failure instead of silently rubber-stamping the gate --
    // the team-lead's explicit ask when this mock was found incomplete.
    confirmShellFields: () => {
      throw new Error("confirmShellFields must not be called: no fixture in this file carries args");
    },
    confirmUntrustedCwd: () => {
      throw new Error("confirmUntrustedCwd must not be called: no fixture in this file has an out-of-project cwd");
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new WorkspaceService(deps as any);
}

test("saveAuto on an empty captureSessions() mints nothing", () => {
  const proj = freshProject();
  const restored: Def[][] = [];
  // Supervisor-only moment: captureSessions() (what persist() serializes)
  // is empty, unlike service.list() which would still include the supervisor.
  const svc = makeService(proj, () => [], restored);

  const result = svc.saveAuto();

  expect(result).toBeNull();
  expect(listWorkspaces(proj)).toHaveLength(0);

  svc.releaseOnQuit();
});

test("restoring a workspace is not a silent no-op success", () => {
  const proj = freshProject();
  const restored: Def[][] = [];
  let live: Def[] = [def("team-lead", proj)];
  const svc = makeService(proj, () => live, restored);

  svc.saveAuto();
  const saved = svc.listForCwd()[0]!;
  expect(saved.sessionCount).toBe(1);

  svc.releaseOnQuit();
  live = [];
  const next = makeService(proj, () => live, restored);
  const ok = next.restore(saved.id);

  expect(ok).toBe(true);
  // fromWorkspaceSessions mints a fresh local id/createdAt on restore, so
  // compare on the fields the round-trip actually preserves.
  expect(restored.at(-1)).toHaveLength(1);
  expect(restored.at(-1)![0]).toMatchObject({ name: "team-lead", sessionId: "sid-team-lead" });

  next.releaseOnQuit();
});

test("a real snapshot is NOT clobbered by a later supervisor-only saveAuto", () => {
  const proj = freshProject();
  const restored: Def[][] = [];
  let live: Def[] = [def("team-lead", proj), def("reviewer", proj)];
  const svc = makeService(proj, () => live, restored);

  svc.saveAuto();
  expect(listWorkspaces(proj)[0]!.sessions).toHaveLength(2);

  // Operator closes the agent tiles; the supervisor stays alive -> captureSessions()
  // now returns empty, and this must NOT overwrite the 2-session snapshot.
  live = [];
  const result = svc.saveAuto();

  expect(result).toBeNull();
  const after = listWorkspaces(proj);
  expect(after).toHaveLength(1);
  expect(after[0]!.sessions).toHaveLength(2);

  svc.releaseOnQuit();
});

test("restoring the workspace this instance already owns succeeds (lock self-exemption)", () => {
  const proj = freshProject();
  const restored: Def[][] = [];
  const live: Def[] = [def("team-lead", proj)];
  const svc = makeService(proj, () => live, restored);

  svc.saveAuto(); // mints + owns + locks the workspace
  const current = svc.listForCwd()[0]!;
  expect(current.current).toBe(true);

  expect(svc.restore(current.id)).toBe(true);
  expect(restored.at(-1)).toHaveLength(1);
  expect(restored.at(-1)![0]).toMatchObject({ name: "team-lead", sessionId: "sid-team-lead" });

  svc.releaseOnQuit();
});

test("restore() refuses a workspace persisted with zero sessions, never touching restoreFrom", () => {
  const proj = freshProject();
  const restored: Def[][] = [];
  const live: Def[] = [def("team-lead", proj)];
  const svc = makeService(proj, () => live, restored);

  // A legacy empty snapshot on disk (minted before saveAuto()'s empty-capture
  // guard existed, or by any future writer that bypasses it): 0 sessions.
  const empty: Workspace = {
    id: "legacy-empty",
    name: "legacy",
    pinned: false,
    cwd: proj,
    groupId: "a".repeat(32),
    scopeName: "test-scope",
    scopeKind: "ephemeral",
    displayMode: { kind: "grid", x: 2, y: 2 },
    createdAt: 1,
    updatedAt: 1,
    sessions: [],
  };
  saveWorkspace(proj, empty);

  const ok = svc.restore("legacy-empty");

  expect(ok).toBe(false);
  // restoreFrom starts with pty.killAll() in the real service -- proving it
  // was never called is what makes this "refuses to kill for nothing", not
  // just "returns false".
  expect(restored).toHaveLength(0);

  svc.releaseOnQuit();
});

test("empty deck + a non-empty current workspace is NOT caught by the zero-session refusal (b8d65b24 interaction)", () => {
  const proj = freshProject();
  const restored: Def[][] = [];
  const live: Def[] = [def("team-lead", proj)];
  const svc = makeService(proj, () => live, restored);

  svc.saveAuto(); // mints + owns + locks a 1-session workspace
  const current = svc.listForCwd()[0]!;
  expect(current.current).toBe(true);
  expect(current.sessionCount).toBe(1);

  // Renderer side (TileArea.tsx's pickRestorable, covered separately in
  // tests/desktop-tile-area.test.ts): once the deck's live AGENT count drops
  // to 0, `current` becomes a valid restore candidate again -- but
  // pickRestorable only ever offers workspaces with sessionCount > 0. This
  // test pins the OTHER half of that contract: restore()'s zero-SESSIONS
  // refusal (point 1) counts PERSISTED sessions, not live agents, so it must
  // not also swallow this case -- the two guards count different things and
  // must not collide.
  expect(svc.restore(current.id)).toBe(true);
  expect(restored.at(-1)).toHaveLength(1);

  svc.releaseOnQuit();
});
