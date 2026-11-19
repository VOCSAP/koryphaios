import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  locateWorkspace,
  newWorkspaceId,
  saveWorkspace,
  selectPrunableWorkspaces,
  WORKSPACE_SESSION_FIELD_CLASS,
  workspaceApproval,
  workspaceHasShellFields,
  workspacesDir,
} from "../desktop/src/main/workspace-store.ts";
import { TEMPLATE_SESSION_FIELD_CLASS } from "../desktop/src/shared/template.ts";
import {
  acquireLock,
  BOOT_RECLAIM_TOLERANCE_MS,
  isLockLive,
  lockPath,
  ownsLock,
  probeSameHostLock,
  readLock,
  refreshLock,
  releaseHeldLock,
  releaseLock,
  type Lock,
} from "../desktop/src/main/workspace-lock.ts";
import type { LockConnection } from "../desktop/src/main/file-lock.ts";
import { fromWorkspaceSessions, toWorkspaceSessions } from "../desktop/src/main/workspace-session-map.ts";
import { gracefulClose } from "../desktop/src/main/session-close.ts";
// WorkspaceService's own runtime imports (node:os + the pure modules above)
// carry no electron/node-pty, so importing it directly under bun test proves
// the header comment above workspace-service.ts wrong -- see the correction
// made there alongside this test (card 438c15e3).
import {
  WorkspaceService,
  type CallerAttendance,
  type WorkspaceApprovalGateResult,
  type WorkspaceDeps,
} from "../desktop/src/main/workspace-service.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import { fromWorkspaceSessions, toWorkspaceSessions } from "../desktop/src/main/workspace-session-map.ts";
import { SPAWN_CAP } from "../desktop/src/main/spawn-cap.ts";
import type { AppConfig, SessionDef } from "../desktop/src/shared/types.ts";
import type { Scope } from "../desktop/src/main/scope.ts";
import { reachedWithin } from "./_bounded-await.ts";
const fresh = (projectDir: string, id: string) => ({ projectDir, id, source: "koryphaios" as const });
const freshRoot = (projectDir: string) => ({ projectDir, source: "koryphaios" as const });
const saveFresh = (projectDir: string, ws: { id: string }) => saveWorkspace(fresh(projectDir, ws.id), ws as never);

// A non-secret sentinel value used to prove the store strips a stray
// scopeSecret-like field; deliberately not credential-shaped.
const LEAK_MARKER = "leak-sentinel-xyz";

const tmpDirs: string[] = [];
const heldLocks = new Set<LockConnection>();
const workspaceServices = new Set<WorkspaceService>();
afterEach(() => {
  for (const service of workspaceServices) service.releaseOnQuit();
  workspaceServices.clear();
  for (const held of heldLocks) releaseHeldLock(held);
  heldLocks.clear();
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
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
  const saved = saveFresh(proj, { ...ws, scopeSecret: LEAK_MARKER } as Workspace);
  expect((saved as Record<string, unknown>).scopeSecret).toBeUndefined();

  const loaded = loadWorkspace(fresh(proj, ws.id));
  expect(loaded).not.toBeNull();
  expect(loaded!.id).toBe(ws.id);
  expect(loaded!.sessions).toEqual(ws.sessions);
  expect((loaded as Record<string, unknown>).scopeSecret).toBeUndefined();

  // The persisted bytes must not contain the sentinel anywhere.
  const raw = readFileSync(join(workspacesDir(proj, "koryphaios"), `${ws.id}.json`), "utf8");
  expect(raw).not.toContain(LEAK_MARKER);
});

// The bridge marker names the binary the tile launches and spends the
// operator's own provider quota, so a repo-cloned workspace carrying one is
// gated exactly like `args` -- and on its own, with no args at all.
test("workspaceHasShellFields fires on a bridge marker alone, with empty args", () => {
  const bridged = (bridge: unknown) => ({
    sessions: [
      {
        claudeSessionId: "sid-1",
        name: "s",
        cwd: "/p",
        args: [] as string[],
        bridge: bridge as "clodex" | undefined,
        color: "#000",
        position: 0,
      },
    ],
  });
  expect(workspaceHasShellFields(bridged(undefined))).toBe(false);
  expect(workspaceHasShellFields(bridged(""))).toBe(false);
  expect(workspaceHasShellFields(bridged("clodex"))).toBe(true);
  // An unknown value is not a reason to skip the gate: a marker this build
  // does not recognize still asked for a launch binary of its own.
  expect(workspaceHasShellFields(bridged("something-else"))).toBe(true);
  expect(workspaceHasShellFields(bridged(42))).toBe(true);
});

const lone = (extra: Record<string, unknown>): Pick<Workspace, "sessions"> => ({
  sessions: [
    { claudeSessionId: "sid-1", name: "s", cwd: "/p", args: [], color: "#000", position: 0, ...extra },
  ] as Workspace["sessions"],
});

test("a session whose only non-empty approval field is lead, disallowedTools or clodexContextTokens gates the restore", () => {
  for (const extra of [{ lead: true }, { disallowedTools: ["Bash"] }, { clodexContextTokens: 300_000 }]) {
    expect(workspaceHasShellFields(lone(extra)), `${JSON.stringify(extra)} has to ask the operator`).toBe(true);
  }
});

test("name, color, role and position alone open no dialog, and an empty approval field does not gate", () => {
  expect(workspaceHasShellFields(lone({ name: "boss", color: "#fff", role: "team-lead", position: 3 }))).toBe(false);
  expect(workspaceHasShellFields(lone({ lead: false, disallowedTools: [] }))).toBe(false);
});

test("WorkspaceService.restore(): a workspace whose only approval field is lead waits for the operator", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const base = sampleWorkspace().sessions[0]!;
  const crowned = sampleWorkspace({ id: "wsp-lead-only", sessions: [{ ...base, cwd: proj, args: [], lead: true }] });
  const plain = sampleWorkspace({ id: "wsp-role-only", sessions: [{ ...base, cwd: proj, args: [], role: "reviewer" }] });
  saveFresh(proj, crowned);
  saveFresh(proj, plain);

  for (const [verdict, reason] of [["declined", "shell-declined"], ["unattended", "unattended"]] as const) {
    let asked = 0;
    let effects = 0;
    const deps = fakeDeps(proj, { confirmShellFields: async () => { asked++; return verdict; } });
    deps.service.restoreFrom = () => { effects++; return []; };
    await expect(workspaceService(deps).restore(crowned.id, "attended"), verdict).resolves.toEqual({ ok: false, reason });
    expect(asked, `${verdict}: the lead has to be put to the operator`).toBe(1);
    expect(effects, `${verdict}: nothing is restored`).toBe(0);
  }

  let asked = 0;
  const deps = fakeDeps(proj, { confirmShellFields: async () => { asked++; return "declined"; } });
  await expect(workspaceService(deps).restore(plain.id, "attended")).resolves.toEqual({ ok: true });
  expect(asked, "a role alone opens no dialog").toBe(0);
});

const wsClassed = (wanted: string) =>
  Object.entries(WORKSPACE_SESSION_FIELD_CLASS)
    .filter(([, cls]) => cls === wanted)
    .map(([field]) => field)
    .sort();

test("the free fields are name, color, role and position, cwd keeps its own gate and claudeSessionId is validated at parse", () => {
  expect(wsClassed("free"), "the free set is the operator's decision: every other field asks for approval").toEqual([
    "color",
    "name",
    "position",
    "role",
  ]);
  expect(wsClassed("own-gate")).toEqual(["cwd"]);
  expect(wsClassed("validated")).toEqual(["claudeSessionId"]);
  expect(wsClassed("approval")).toEqual(["args", "bridge", "clodexContextTokens", "disallowedTools", "lead"]);
});

test("a field a workspace session shares with a template has the template's class", () => {
  const shared = Object.keys(WORKSPACE_SESSION_FIELD_CLASS).filter((field) => field in TEMPLATE_SESSION_FIELD_CLASS);
  expect(shared.sort()).toEqual(["args", "bridge", "clodexContextTokens", "color", "disallowedTools", "lead", "name", "role"]);
  for (const field of shared) {
    expect(
      WORKSPACE_SESSION_FIELD_CLASS[field as keyof typeof WORKSPACE_SESSION_FIELD_CLASS],
      `${field} is classed apart from the template`,
    ).toBe(TEMPLATE_SESSION_FIELD_CLASS[field as keyof typeof TEMPLATE_SESSION_FIELD_CLASS]);
  }
});

const WS_APPROVAL_SAMPLES: Record<string, { value: unknown; shown: string }> = {
  args: { value: ["--flag-x"], shown: "--flag-x" },
  bridge: { value: "clodex", shown: "[clodex]" },
  clodexContextTokens: { value: 300_000, shown: "300000" },
  lead: { value: true, shown: "lead" },
  disallowedTools: { value: ["Bash"], shown: "Bash" },
};

test("every approval field has a sample in this file, so the loop below covers it", () => {
  expect(Object.keys(WS_APPROVAL_SAMPLES).sort()).toEqual(wsClassed("approval"));
});

for (const [field, { value, shown }] of Object.entries(WS_APPROVAL_SAMPLES)) {
  test(`${field} alone gates the restore, changes the approved payload and is shown to the operator`, () => {
    const withField = lone({ [field]: value });
    expect(workspaceHasShellFields(withField), `${field} has to ask the operator`).toBe(true);
    expect(JSON.stringify(workspaceApproval(withField).hashPayload), `${field} has to be in the approved payload`).not.toBe(
      JSON.stringify(workspaceApproval(lone({})).hashPayload),
    );
    expect(workspaceApproval(withField).previewLines.join("\n"), `${field} has to be shown`).toContain(shown);
  });
}

test("a workspace that carries only args and a bridge keeps the approved payload and the preview it always had", () => {
  const hash = (extra: Record<string, unknown>) => JSON.stringify(workspaceApproval(lone(extra)).hashPayload);
  expect(hash({ args: ["--model", "opus"] })).toBe('[{"args":"--model opus"}]');
  expect(hash({ bridge: "clodex" })).toBe('[{"args":"","bridge":"clodex"}]');
  expect(hash({ args: ["--a"], bridge: "clodex" })).toBe('[{"args":"--a","bridge":"clodex"}]');
  expect(hash({})).toBe('[{"args":""}]');
  expect(workspaceApproval(lone({ args: ["--model", "opus"] })).previewLines).toEqual(["s: --model opus"]);
  expect(workspaceApproval(lone({ bridge: "clodex" })).previewLines).toEqual(["s: [clodex]"]);
});

test("a resume leaves the approved payload alone: claudeSessionId, position, name, color and role are not in it", () => {
  const before = lone({ args: ["--agent", "dev"], lead: true });
  const after = {
    sessions: [
      { ...before.sessions[0]!, claudeSessionId: "a-forked-id", position: 7, name: "renamed", color: "#fff", role: "reviewer" },
    ],
  };
  expect(JSON.stringify(workspaceApproval(after).hashPayload)).toBe(JSON.stringify(workspaceApproval(before).hashPayload));
});

test("loadWorkspace refuses the whole file when a claudeSessionId is not a plain id", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const load = (claudeSessionId: string, n: number) => {
    const ws = sampleWorkspace({ id: `wsp_id_${n}` });
    writeFileSync(
      join(workspacesDir(proj, "koryphaios"), `${ws.id}.json`),
      JSON.stringify({ ...ws, sessions: [{ ...ws.sessions[0]!, claudeSessionId }] }),
      "utf8",
    );
    return loadWorkspace(fresh(proj, ws.id));
  };
  const hostile = ["../x", "a/b", "a\\b", 'a"b', "a$(x)", "a`x`", "a b", "..", "a..b", "a;b", "a'b"];
  hostile.forEach((id, n) => expect(load(id, n), `${JSON.stringify(id)} has to be refused`).toBeNull());
  const plain = ["0f8fad5b-d9cb-469f-a165-9f7a4a3b8c11", "", "sid-1", "wsp.id_1"];
  plain.forEach((id, n) => expect(load(id, 100 + n), `${JSON.stringify(id)} has to load`).not.toBeNull());
});

test("loadWorkspace rejects a file whose session names a bridge this build does not know", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_bad_bridge" });
  const hostile = {
    ...ws,
    sessions: [{ ...ws.sessions[0]!, bridge: "clodex-evil" }],
  };
  writeFileSync(
    join(workspacesDir(proj, "koryphaios"), "wsp_bad_bridge.json"),
    JSON.stringify(hostile, null, 2),
    "utf8",
  );
  expect(loadWorkspace(fresh(proj, "wsp_bad_bridge"))).toBeNull();
  expect(listWorkspaces(proj).map((w) => w.id)).not.toContain("wsp_bad_bridge");

  // Control: the very same file with the known marker loads, so the rejection
  // above is the enum check and not the surrounding shape.
  const good = { ...ws, sessions: [{ ...ws.sessions[0]!, bridge: "clodex" }] };
  writeFileSync(
    join(workspacesDir(proj, "koryphaios"), "wsp_good_bridge.json"),
    JSON.stringify({ ...good, id: "wsp_good_bridge" }, null, 2),
    "utf8",
  );
  expect(loadWorkspace(fresh(proj, "wsp_good_bridge"))?.sessions[0]!.bridge).toBe("clodex");
});

test("clodexContextTokens round-trips def -> workspace file -> def, and a hostile value rejects the file whole", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_ctx" });
  const captured = toWorkspaceSessions([
    { id: "d", name: "n", cwd: proj, command: "", args: "", sessionId: "s", color: "#fff", createdAt: 1, bridge: "clodex", clodexContextTokens: 531_000 },
  ]);
  expect(captured[0]!.clodexContextTokens).toBe(531_000);
  saveFresh(proj, { ...ws, sessions: captured });
  const loaded = loadWorkspace(fresh(proj, "wsp_ctx"))!;
  expect(fromWorkspaceSessions(loaded.sessions)[0]!.clodexContextTokens).toBe(531_000);

  for (const bad of [199_999, 872_001, 1.5, "300000", null, Number.NaN]) {
    writeFileSync(
      join(workspacesDir(proj, "koryphaios"), "wsp_ctx_bad.json"),
      JSON.stringify({ ...loaded, id: "wsp_ctx_bad", sessions: [{ ...captured[0]!, clodexContextTokens: bad }] }),
      "utf8",
    );
    expect(loadWorkspace(fresh(proj, "wsp_ctx_bad")), `value ${String(bad)}`).toBeNull();
  }

  const unbridged = toWorkspaceSessions([
    { id: "d", name: "n", cwd: proj, command: "", args: "", sessionId: "s", color: "#fff", createdAt: 1, clodexContextTokens: 531_000 },
  ]);
  expect(unbridged[0]).not.toHaveProperty("clodexContextTokens");
});

test("a saved session keeps its tool denial through capture, file and restore, and a file with a hostile name is rejected whole", () => {
  const defs = [
    { id: "a", name: "reviewer", cwd: "/p", command: "", args: "", sessionId: "sid-r", color: "#111", createdAt: 1, disallowedTools: ["Write", "Edit"] },
    { id: "b", name: "dev", cwd: "/p", command: "", args: "", sessionId: "sid-d", color: "#222", createdAt: 2 }
  ];
  const captured = toWorkspaceSessions(defs as never);
  expect(captured[0]!.disallowedTools).toEqual(["Write", "Edit"]);
  expect(captured[1]).not.toHaveProperty("disallowedTools");

  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_denial", sessions: captured });
  saveFresh(proj, ws);
  const restored = fromWorkspaceSessions(loadWorkspace(fresh(proj, "wsp_denial"))!.sessions);
  expect(restored[0]!.disallowedTools).toEqual(["Write", "Edit"]);
  expect(restored[1]!.disallowedTools).toBeUndefined();

  writeFileSync(
    join(workspacesDir(proj, "koryphaios"), "wsp_hostile_denial.json"),
    JSON.stringify({ ...ws, id: "wsp_hostile_denial", sessions: [{ ...captured[0]!, disallowedTools: ["Write", "$(id)"] }] }),
    "utf8"
  );
  expect(loadWorkspace(fresh(proj, "wsp_hostile_denial"))).toBeNull();
});

test("a workspace saved with the denial inside args gets it lifted into the field at restore, and a hostile pair stays in args", () => {
  const base = sampleWorkspace().sessions[0]!;
  const restored = fromWorkspaceSessions([
    { ...base, position: 0, args: ["--agent", "reviewer", "--disallowedTools", '"Write,Edit,NotebookEdit"'] },
    { ...base, position: 1, args: ["--disallowedTools", '"Write,$(id)"'] },
    { ...base, position: 2, args: ["--disallowedTools", '"Bash"'], disallowedTools: ["Write"] }
  ]);
  expect(restored[0]!.args).toBe("--agent reviewer");
  expect(restored[0]!.disallowedTools).toEqual(["Write", "Edit", "NotebookEdit"]);
  expect(restored[1]!.args, "an invalid list is not lifted: the fresh launch keeps its current behaviour").toBe(
    '--disallowedTools "Write,$(id)"'
  );
  expect(restored[1]!.disallowedTools).toBeUndefined();
  expect(restored[2]!.args, "a session that already has the field is left as saved").toBe('--disallowedTools "Bash"');
  expect(restored[2]!.disallowedTools).toEqual(["Write"]);
});

test("listWorkspaces sorts by updatedAt desc and skips malformed files", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ name: "old", updatedAt: 1 }));
  saveFresh(proj, sampleWorkspace({ name: "newer" }));
  writeFileSync(join(workspacesDir(proj, "koryphaios"), "garbage.json"), "{ not json");

  const list = listWorkspaces(proj);
  expect(list.length).toBe(2);
  // Sorted desc by updatedAt -> non-increasing.
  expect(list[0]!.updatedAt).toBeGreaterThanOrEqual(list[1]!.updatedAt);
});

test("loadWorkspace returns null for malformed/missing", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  writeFileSync(join(workspacesDir(proj, "koryphaios"), "wsp_bad.json"), "{ partial");
  expect(loadWorkspace(fresh(proj, "wsp_bad"))).toBeNull();
  expect(loadWorkspace(fresh(proj, "wsp_absent"))).toBeNull();
});

test("ensureWorkspacesDir creates tree and adds gitignore line exactly once", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  ensureWorkspacesDir(freshRoot(proj)); // idempotent
  const gitignore = join(proj, ".claude", "koryphaios", ".gitignore");
  expect(existsSync(workspacesDir(proj, "koryphaios"))).toBe(true);
  const lines = readFileSync(gitignore, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() === "workspaces/");
  expect(lines.length).toBe(1);
});

test("ensureWorkspacesDir preserves a pre-existing gitignore (keeps config.json committable)", () => {
  const proj = freshProject();
  const cpDir = join(proj, ".claude", "koryphaios");
  ensureWorkspacesDir(freshRoot(proj));
  // Simulate a hand-written gitignore that already ignores something else.
  writeFileSync(join(cpDir, ".gitignore"), "*.local\n");
  ensureWorkspacesDir(freshRoot(proj));
  const body = readFileSync(join(cpDir, ".gitignore"), "utf8");
  expect(body).toContain("*.local");
  expect(body).toContain("workspaces/");
});

test("deleteWorkspace removes json + lock and is a no-op when already gone", () => {
  const proj = freshProject();
  const ws = sampleWorkspace();
  saveFresh(proj, ws);
  writeFileSync(join(workspacesDir(proj, "koryphaios"), `${ws.id}.lock`), "{}");
  deleteWorkspace(fresh(proj, ws.id));
  expect(existsSync(join(workspacesDir(proj, "koryphaios"), `${ws.id}.json`))).toBe(false);
  expect(existsSync(join(workspacesDir(proj, "koryphaios"), `${ws.id}.lock`))).toBe(false);
  expect(() => deleteWorkspace(fresh(proj, ws.id))).not.toThrow(); // already gone
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

/** acquireLock whose held connection stays referenced until the test ends, as the service keeps it. */
function takeLock(...args: Parameters<typeof acquireLock>): LockConnection | null {
  const held = acquireLock(...args);
  if (held) heldLocks.add(held);
  return held;
}

/**
 * The owner's OS lock is gone while its JSON lock stays: what a Deck that
 * predates the OS lock, or one on another host, leaves. Only the JSON can
 * refuse from here on.
 */
function dropOsLock(held: LockConnection | null): void {
  expect(held, "the lock being dropped was never acquired").not.toBeNull();
  heldLocks.delete(held!);
  releaseHeldLock(held!);
}

/** Hand a tracked connection to releaseLock, which gives it back itself. */
function untrack(held: LockConnection | null): LockConnection | null {
  if (held) heldLocks.delete(held);
  return held;
}

test("acquireLock writes a fresh lock when none exists", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const held = takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 4242 });
  expect(held).not.toBeNull();
  const lock = readLock(fresh(proj, "wsp_1"));
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
  ensureWorkspacesDir(freshRoot(proj));
  const first = takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 4242 });

  // The owner's OS lock refuses on its own, whatever its JSON lock says.
  expect(takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 9999, isPidAlive: () => false })).toBeNull();

  dropOsLock(first);
  // Same host, pid alive -> refuse.
  expect(takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 9999, isPidAlive: () => true })).toBeNull();

  // Same host, pid dead -> reclaim.
  const reclaimed = takeLock(fresh(proj, "wsp_1"), {
    ...baseLiveness,
    pid: 9999,
    isPidAlive: () => false,
  });
  expect(reclaimed).not.toBeNull();
  expect(readLock(fresh(proj, "wsp_1"))!.pid).toBe(9999);
});

// A bare pid-alive check cannot tell a still-running owner from an unrelated
// process that reused the same pid after reboot. Querying the OS for a foreign
// pid's start time needs a subprocess per check and fails open where the query
// itself is unavailable (e.g. this product's own sandbox).
// Instead: no process survives a reboot, so a lock recorded as started before
// this machine's boot is provably dead regardless of pid; anything else falls
// back to a bare pid-alive check.

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
  ensureWorkspacesDir(freshRoot(proj));
  dropOsLock(takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 4242, startedAt: 1_000, bootInstant: 0 }));
  // A later liveness check runs on a machine that has since rebooted:
  // bootInstant now postdates the recorded owner's startedAt by more than
  // the tolerance, so the lock is provably stale even with a live pid. Also
  // advance `now` well past the first lock's heartbeat (stamped at
  // baseLiveness.now = 10_000) + staleMs (5_000) so the AND condition's
  // second half (heartbeat stale, review round 6) is satisfied too --
  // without it the reclaim would fall back to isPidAlive and stay refused.
  const reclaimed = takeLock(fresh(proj, "wsp_1"), {
    ...baseLiveness,
    now: 20_000,
    pid: 5555,
    startedAt: 6_000,
    bootInstant: 5_000,
    isPidAlive: () => true,
  });
  expect(reclaimed).not.toBeNull();
  const lock = readLock(fresh(proj, "wsp_1"))!;
  expect(lock.pid).toBe(5555);
  expect(lock.startedAt).toBe(6_000);
});

test("acquireLock: lock startedAt at/after boot, pid alive -> refused, on-disk lock unchanged (negative proof)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  dropOsLock(takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 4242, startedAt: 6_000, bootInstant: 0 }));
  const refused = takeLock(fresh(proj, "wsp_1"), {
    ...baseLiveness,
    pid: 9999,
    startedAt: 7_000,
    bootInstant: 5_000, // inconclusive: 6_000 >= 5_000 - 2_000
    isPidAlive: () => true,
  });
  expect(refused).toBeNull();
  const lock = readLock(fresh(proj, "wsp_1"))!;
  expect(lock.pid).toBe(4242);
  expect(lock.startedAt).toBe(6_000);
});

test("acquireLock: lock startedAt at/after boot, pid dead -> reclaimed (fallback preserves the pre-card guarantee)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  dropOsLock(takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 4242, startedAt: 6_000, bootInstant: 0 }));
  const reclaimed = takeLock(fresh(proj, "wsp_1"), {
    ...baseLiveness,
    pid: 9999,
    startedAt: 7_000,
    bootInstant: 5_000, // inconclusive on the boot check alone
    isPidAlive: () => false, // ...but the fallback still catches a dead owner
  });
  expect(reclaimed).not.toBeNull();
  expect(readLock(fresh(proj, "wsp_1"))!.pid).toBe(9999);
});

test("isLockLive cross-host relies on heartbeat freshness, boundary is stale", () => {
  const lock: Lock = { pid: 1, host: "other-host", startedAt: 0, heartbeat: 5_000 };
  // now=10_000, staleMs=5_000 -> heartbeat must be > 5_000 to be live.
  expect(isLockLive(lock, { ...baseLiveness })).toBe(false); // exactly at boundary -> stale
  expect(isLockLive({ ...lock, heartbeat: 5_001 }, { ...baseLiveness })).toBe(true);
});

test("refreshLock updates heartbeat; releaseLock removes the file (no-op if gone)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const held = takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 4242 });
  const owner = { pid: 4242, host: "this-host" };
  expect(refreshLock(fresh(proj, "wsp_1"), 99_999, owner)).toBe(true);
  expect(readLock(fresh(proj, "wsp_1"))!.heartbeat).toBe(99_999);
  expect(releaseLock(fresh(proj, "wsp_1"), owner, untrack(held))).toBe(true);
  expect(readLock(fresh(proj, "wsp_1"))).toBeNull();
  expect(releaseLock(fresh(proj, "wsp_1"), owner, null)).toBe(true); // already gone -> no-op, still ok
  expect(takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 9999 }), "the release gave the OS lock back").not.toBeNull();
});

test("ownsLock matches pid+host exactly, mismatched pid or host both refuse", () => {
  const lock: Lock = { pid: 4242, host: "this-host", startedAt: 0, heartbeat: 0 };
  expect(ownsLock(lock, { pid: 4242, host: "this-host" })).toBe(true);
  expect(ownsLock(lock, { pid: 9999, host: "this-host" })).toBe(false);
  expect(ownsLock(lock, { pid: 4242, host: "other-host" })).toBe(false);
});

test("refreshLock refuses to re-stamp a lock owned by a different identity (no heartbeat theft)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 4242 });
  const foreign = { pid: 9999, host: "this-host" };
  expect(refreshLock(fresh(proj, "wsp_1"), 99_999, foreign)).toBe(false);
  expect(readLock(fresh(proj, "wsp_1"))!.heartbeat).not.toBe(99_999);
});

test("releaseLock refuses to delete a lock owned by a different identity (no cross-instance destruction)", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  takeLock(fresh(proj, "wsp_1"), { ...baseLiveness, pid: 4242 });
  const foreign = { pid: 9999, host: "this-host" };
  expect(releaseLock(fresh(proj, "wsp_1"), foreign, null)).toBe(false);
  expect(readLock(fresh(proj, "wsp_1"))).not.toBeNull();
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
    adoptScope: async (_ws, own) => own()
      ? { state: "published", scope: { projectKey: "project", groupId: fakeScope().groupId } }
      : { state: "lock-race" },
    cancelScopeAdoption: () => {},
    closeScopeAdoption: () => {},
    onCredentialFailure: () => {},
    // Card 09d54a29: benign default so the ~10 pre-existing restore() tests
    // above (whose sampleWorkspace() sessions carry non-empty `args` by
    // default) keep exercising what they actually test, not this gate --
    // the gate itself is covered by the dedicated tests below that override
    // this to a spy.
    confirmShellFields: async () => "approved",
    // Card 09d54a29 follow-up (GX-SEC, auditor finding): same reasoning --
    // sampleWorkspace()'s default session cwd ("/abs/project") never equals
    // the real tmpdir `proj` fakeDeps is constructed with, so it would trip
    // this gate too on every pre-existing test unless defaulted benign here.
    confirmUntrustedCwd: async () => "approved",
    pid: 4242,
    host: "this-host",
    ...overrides,
    sessions: state.sessions,
  };
  Object.defineProperty(deps, "sessions", { get: () => state.sessions });
  return deps;
}

function workspaceService(deps: WorkspaceDeps): WorkspaceService {
  const service = new WorkspaceService(deps);
  workspaceServices.add(service);
  return service;
}

function deferredGate(): {
  promise: Promise<WorkspaceApprovalGateResult>;
  resolve: (result: WorkspaceApprovalGateResult) => void;
} {
  let resolve!: (result: WorkspaceApprovalGateResult) => void;
  return { promise: new Promise((done) => { resolve = done; }), resolve: (result) => resolve(result) };
}

function shellOnlyWorkspace(projectDir: string, id: string): Workspace {
  return sampleWorkspace({
    id,
    sessions: [{ ...sampleWorkspace().sessions[0]!, cwd: projectDir }],
  });
}

function cwdOnlyWorkspace(id: string): Workspace {
  return sampleWorkspace({
    id,
    sessions: [{ ...sampleWorkspace().sessions[0]!, args: [] }],
  });
}

test("WorkspaceService.restore(): each approval gate rejects an invalidated request", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  for (const [name, ws, gateKey] of [
    ["shell", shellOnlyWorkspace(proj, "wsp-shell"), "confirmShellFields"],
    ["cwd", cwdOnlyWorkspace("wsp-cwd"), "confirmUntrustedCwd"],
  ] as const) {
    saveFresh(proj, ws);
    const gate = deferredGate();
    let effects = 0;
    const deps = fakeDeps(proj, {
      [gateKey]: async () => gate.promise,
      setConfig: () => { effects++; },
    });
    deps.service.restoreFrom = () => { effects++; return []; };
    const svc = workspaceService(deps);

    const restoring = svc.restore(ws.id, "attended");
    await Promise.resolve();
    svc.startNew();
    gate.resolve("approved");

    await expect(restoring, name).resolves.toEqual({ ok: false, reason: "superseded" });
    expect(effects, name).toBe(0);
  }
});

test("WorkspaceService.restore(): each approval gate rechecks a lock acquired while waiting", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  for (const [name, ws, gateKey] of [
    ["shell", shellOnlyWorkspace(proj, "wsp-shell-lock"), "confirmShellFields"],
    ["cwd", cwdOnlyWorkspace("wsp-cwd-lock"), "confirmUntrustedCwd"],
  ] as const) {
    saveFresh(proj, ws);
    const gate = deferredGate();
    let effects = 0;
    const deps = fakeDeps(proj, {
      [gateKey]: async () => gate.promise,
      setConfig: () => { effects++; },
    });
    deps.service.restoreFrom = () => { effects++; return []; };
    const svc = workspaceService(deps);

    const restoring = svc.restore(ws.id, "attended");
    await Promise.resolve();
    takeLock(fresh(proj, ws.id), { ...baseLiveness, pid: 9999, isPidAlive: () => true });
    gate.resolve("approved");

    await expect(restoring, name).resolves.toEqual({ ok: false, reason: "locked" });
    expect(effects, name).toBe(0);
  }
});

test("WorkspaceService.restore(): applies the workspace captured before its approval", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const original = shellOnlyWorkspace(proj, "wsp-captured");
  const replacement = { ...original, sessions: [{ ...original.sessions[0]!, name: "rewritten", args: ["--agent", "rewritten"] }] };
  saveFresh(proj, original);
  const gate = deferredGate();
  let restored: SessionDef[] = [];
  const deps = fakeDeps(proj, { confirmShellFields: async () => gate.promise });
  deps.service.restoreFrom = (sessions) => { restored = sessions; return []; };
  const svc = workspaceService(deps);

  const restoring = svc.restore(original.id, "attended");
  await Promise.resolve();
  saveFresh(proj, replacement);
  gate.resolve("approved");

  await expect(restoring).resolves.toEqual({ ok: true });
  expect(restored.map((session) => session.name)).toEqual(["reviewer"]);
});

test("WorkspaceService.restore(): a second lead crown is dropped and named in the result, every team-lead role is kept, a lone crown is not named", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const base = sampleWorkspace().sessions[0]!;
  const twoCrowns = sampleWorkspace({
    id: "wsp-two-crowns",
    sessions: [
      { ...base, name: "boss", args: [], role: "team-lead", lead: true, position: 0 },
      { ...base, name: "deputy", args: [], role: "team-lead", lead: true, position: 1 },
    ],
  });
  const twoSubLeads = sampleWorkspace({
    id: "wsp-two-sub-leads",
    sessions: [
      { ...base, name: "boss", args: [], role: "team-lead", position: 0 },
      { ...base, name: "deputy", args: [], role: "team-lead", position: 1 },
    ],
  });
  const one = sampleWorkspace({ id: "wsp-one-lead", sessions: [{ ...base, name: "boss", args: [], role: "team-lead", lead: true, position: 0 }] });
  saveFresh(proj, twoCrowns);
  saveFresh(proj, twoSubLeads);
  saveFresh(proj, one);
  let restored: SessionDef[] = [];
  const deps = fakeDeps(proj);
  deps.service.restoreFrom = (sessions) => { restored = sessions; return []; };
  const svc = workspaceService(deps);

  await expect(svc.restore(twoCrowns.id, "attended")).resolves.toEqual({ ok: true, demotedTeamLeads: ["deputy"] });
  expect(restored.map((s) => [s.name, s.role, s.lead])).toEqual([["boss", "team-lead", true], ["deputy", "team-lead", undefined]]);

  await expect(svc.restore(twoSubLeads.id, "attended")).resolves.toEqual({ ok: true });
  expect(restored.map((s) => [s.name, s.role, s.lead])).toEqual([["boss", "team-lead", undefined], ["deputy", "team-lead", undefined]]);

  await expect(svc.restore(one.id, "attended")).resolves.toEqual({ ok: true });
  expect(restored.map((s) => [s.name, s.role, s.lead])).toEqual([["boss", "team-lead", true]]);
});

test("WorkspaceService.restore(): concurrent approval returns busy without invalidating the first request", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const first = sampleWorkspace({ id: "wsp-first" });
  const second = sampleWorkspace({ id: "wsp-second" });
  saveFresh(proj, first);
  saveFresh(proj, second);
  const gate = deferredGate();
  const deps = fakeDeps(proj, {
    confirmShellFields: (() => gate.promise) as unknown as WorkspaceDeps["confirmShellFields"],
  });
  const svc = workspaceService(deps);

  const restoring = svc.restore(first.id, "attended");
  await Promise.resolve();
  const busy = svc.restore(second.id, "attended");
  gate.resolve("approved");
  await expect(busy).resolves.toEqual({ ok: false, reason: "busy" });
  await expect(restoring).resolves.toEqual({ ok: true });
  expect(svc.currentWorkspaceId).toBe(first.id);
});

function seedRaceWorkspaces(proj: string): { oldWs: Workspace } {
  ensureWorkspacesDir(freshRoot(proj));
  const oldWs = sampleWorkspace({ id: "wsp_old" });
  saveFresh(proj, oldWs);
  // Sessions distinguishable from oldWs's default ("reviewer") so the
  // anti-corruption assertion cannot pass by content coincidence.
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
  saveFresh(proj, targetWs);
  return { oldWs };
}

function takeForeignTargetLock(proj: string): void {
  takeLock(fresh(proj, "wsp_target"), {
    host: "other-host",
    now: Date.now(),
    bootInstant: 0,
    startedAt: 1_000,
    staleMs: 5_000,
    isPidAlive: () => true,
    pid: 1,
  });
}

test("WorkspaceService.restore(): a foreign lock taken while the scope is adopted refuses as 'locked' before any session is swapped", async () => {
  const proj = freshProject();
  seedRaceWorkspaces(proj);
  const deps = fakeDeps(proj);
  const svc = workspaceService(deps);
  expect(await svc.restore("wsp_old", "attended")).toEqual({ ok: true });
  const oldLiveSessions = deps.sessions;

  deps.adoptScope = async (_ws, own) => {
    takeForeignTargetLock(proj);
    return own()
      ? { state: "published", scope: { projectKey: "project", groupId: fakeScope().groupId } }
      : { state: "lock-race" };
  };
  const result = await svc.restore("wsp_target", "attended");
  expect(result).toEqual({ ok: false, reason: "locked" });
  expect(svc.currentWorkspaceId).toBe("wsp_old");
  expect(deps.sessions).toBe(oldLiveSessions);

  svc.releaseOnQuit();
});

test("WorkspaceService.restore(): the sessions spawn only once the adopted scope's transition has settled", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_scope" }));
  let settle = (): void => {};
  const transition = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let adopted = false;
  const deps = fakeDeps(proj, {
    adoptScope: async (_ws, own) => {
      adopted = true;
      await transition;
      return own()
        ? { state: "published", scope: { projectKey: "project", groupId: fakeScope().groupId } }
        : { state: "lock-race" };
    },
  });
  const before = deps.sessions;
  const svc = workspaceService(deps);

  const restoring = svc.restore("wsp_scope", "attended");
  for (let i = 0; i < 20 && !adopted; i++) await Promise.resolve();
  expect(adopted).toBe(true);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(deps.sessions, "no session is spawned while the run credential is being re-minted").toBe(before);

  settle();
  await expect(restoring).resolves.toEqual({ ok: true });
  expect(deps.sessions).not.toBe(before);
  svc.releaseOnQuit();
});

test("WorkspaceService.restore(): a credential timeout does not acquire or replace sessions", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_credential_timeout" }));
  const deps = fakeDeps(proj, {
    adoptScope: async () => ({ state: "credential-timed-out" }),
  });
  const before = deps.sessions;
  const svc = workspaceService(deps);

  await expect(svc.restore("wsp_credential_timeout", "attended")).resolves.toEqual({ ok: false, reason: "credential-timed-out" });
  expect(svc.currentWorkspaceId).toBeNull();
  expect(deps.sessions).toBe(before);
  svc.releaseOnQuit();
});

function adoptionHarness(proj: string) {
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_a", groupId: "g-a" }));
  saveFresh(proj, sampleWorkspace({ id: "wsp_b", groupId: "g-b" }));
  const initial: Scope = { ...fakeScope(), groupId: "g-initial" };
  const state = { active: initial, restored: 0 };
  const settles: Array<() => void> = [];
  const cancelled = new Set<number>();
  let ticket = 0;
  const deps = fakeDeps(proj, {
    getScope: () => state.active,
    adoptScope: (ws, own) => {
      const current = ticket++;
      return new Promise((resolve) => settles.push(() => {
        if (cancelled.has(current)) return resolve({ state: "superseded" });
        if (!own()) return resolve({ state: "lock-race" });
        state.active = { ...fakeScope(), groupId: ws.groupId, scopeKind: ws.scopeKind };
        resolve({ state: "published", scope: { projectKey: "project", groupId: ws.groupId } });
      }));
    },
    cancelScopeAdoption: () => cancelled.add(ticket - 1),
    closeScopeAdoption: () => cancelled.add(ticket - 1),
  });
  const restoreFrom = deps.service.restoreFrom.bind(deps.service);
  deps.service.restoreFrom = ((...args: Parameters<typeof restoreFrom>) => {
    state.restored += 1;
    return restoreFrom(...args);
  }) as typeof restoreFrom;
  const adopting = async (count: number): Promise<void> => {
    for (let i = 0; i < 50 && settles.length < count; i++) await Promise.resolve();
    expect(settles.length, "the restore reached adoptScope").toBe(count);
  };
  return { deps, state, settles, reverted: [], initial, adopting, svc: workspaceService(deps) };
}

test("WorkspaceService.restore(): startNew during the scope adoption cancels the restore and returns to the previous scope", async () => {
  const h = adoptionHarness(freshProject());
  const restoring = h.svc.restore("wsp_a", "attended");
  await h.adopting(1);
  expect(h.state.active.groupId).toBe("g-initial");

  h.svc.startNew();
  expect(h.state.active.groupId, "the next session must not start in the cancelled workspace's group").toBe("g-initial");
  h.settles[0]!();
  await expect(reachedWithin(restoring, "the cancelled restore settles")).resolves.toEqual({ ok: false, reason: "superseded" });
  expect(h.state.restored).toBe(0);
  expect(h.reverted).toEqual([]);
  expect(h.state.active).toBe(h.initial);
  h.svc.releaseOnQuit();
});

test("WorkspaceService.restore(): deleting the workspace being restored during the scope adoption returns to the previous scope", async () => {
  const h = adoptionHarness(freshProject());
  const restoring = h.svc.restore("wsp_a", "attended");
  await h.adopting(1);

  h.svc.deleteWs("wsp_a");
  expect(h.state.active.groupId).toBe("g-initial");
  h.settles[0]!();
  await expect(reachedWithin(restoring, "the cancelled restore settles")).resolves.toEqual({ ok: false, reason: "superseded" });
  expect(h.state.restored).toBe(0);
  expect(h.reverted).toEqual([]);
  h.svc.releaseOnQuit();
});

test("WorkspaceService.restore(): a restore started after a cancelled one keeps its own scope when the cancelled one wakes", async () => {
  const h = adoptionHarness(freshProject());
  const first = h.svc.restore("wsp_a", "attended");
  await h.adopting(1);
  await expect(h.svc.restore("wsp_b", "attended")).resolves.toEqual({ ok: false, reason: "busy" });

  h.svc.startNew();
  const second = h.svc.restore("wsp_b", "attended");
  await h.adopting(2);
  expect(h.state.active.groupId).toBe("g-initial");

  h.settles[0]!();
  await expect(reachedWithin(first, "the cancelled restore settles")).resolves.toEqual({ ok: false, reason: "superseded" });
  expect(h.state.active.groupId, "the cancelled restore must not publish its scope").toBe("g-initial");
  h.settles[1]!();
  await expect(reachedWithin(second, "the newer restore settles")).resolves.toEqual({ ok: true });
  expect(h.state.active.groupId).toBe("g-b");
  expect(h.svc.currentWorkspaceId).toBe("wsp_b");
  expect(h.reverted).toEqual([]);
  h.svc.releaseOnQuit();
});

test("WorkspaceService.restore(): cancelling the newer restore after the older cancelled one woke still returns to the previous scope", async () => {
  const h = adoptionHarness(freshProject());
  const first = h.svc.restore("wsp_a", "attended");
  await h.adopting(1);
  h.svc.startNew();
  const second = h.svc.restore("wsp_b", "attended");
  await h.adopting(2);
  h.settles[0]!();
  await expect(reachedWithin(first, "the older restore settles")).resolves.toEqual({ ok: false, reason: "superseded" });

  h.svc.deleteWs("wsp_b");
  expect(h.state.active.groupId).toBe("g-initial");
  h.settles[1]!();
  await expect(reachedWithin(second, "the newer restore settles")).resolves.toEqual({ ok: false, reason: "superseded" });
  expect(h.reverted).toEqual([]);
  expect(h.state.restored).toBe(0);
  h.svc.releaseOnQuit();
});

test("WorkspaceService.restore(): a restore whose adoption changed nothing reverts nothing when cancelled", async () => {
  const h = adoptionHarness(freshProject());
  let settle = (): void => {};
  let cancelled = false;
  h.deps.cancelScopeAdoption = () => { cancelled = true; };
  h.deps.adoptScope = async (_ws, own) => {
    await new Promise<void>((resolve) => { settle = resolve; h.settles.push(resolve); });
    if (cancelled) return { state: "superseded" };
    return own()
      ? { state: "published", scope: { projectKey: "project", groupId: fakeScope().groupId } }
      : { state: "lock-race" };
  };
  const restoring = h.svc.restore("wsp_a", "attended");
  await h.adopting(1);

  h.svc.startNew();
  settle();
  await expect(reachedWithin(restoring, "the cancelled restore settles")).resolves.toEqual({ ok: false, reason: "superseded" });
  expect(h.reverted).toEqual([]);
  expect(h.state.active).toBe(h.initial);
});

test("WorkspaceService.startNew(): after a completed restore keeps the restored scope", async () => {
  const h = adoptionHarness(freshProject());
  const restoring = h.svc.restore("wsp_a", "attended");
  await h.adopting(1);
  h.settles[0]!();
  await expect(reachedWithin(restoring, "the restore settles")).resolves.toEqual({ ok: true });

  h.svc.startNew();
  expect(h.reverted).toEqual([]);
  expect(h.state.active.groupId).toBe("g-a");
  h.svc.releaseOnQuit();
});

test("WorkspaceService.restore(): quitting during the scope adoption does not re-mint a credential for the previous scope", async () => {
  const h = adoptionHarness(freshProject());
  const restoring = h.svc.restore("wsp_a", "attended");
  await h.adopting(1);

  h.svc.releaseOnQuit();
  h.settles[0]!();
  await expect(reachedWithin(restoring, "the cancelled restore settles")).resolves.toEqual({ ok: false, reason: "superseded" });
  expect(h.reverted).toEqual([]);
});

test("WorkspaceService.restore(): succeeds and owns the lock when nothing contends", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_target" });
  saveFresh(proj, ws);
  const deps = fakeDeps(proj);
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_target", "attended");
  expect(result).toEqual({ ok: true });
  expect(svc.currentWorkspaceId).toBe("wsp_target");
  const lock = readLock(fresh(proj, "wsp_target"));
  expect(lock).not.toBeNull();
  expect(lock!.pid).toBe(4242);
  expect(lock!.host).toBe("this-host");
});

test("WorkspaceService.restore(): operator restore is not bound by the agent spawn cap", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({
      id: "wsp_over_cap",
      sessions: Array.from({ length: SPAWN_CAP + 3 }, (_, position) => ({
        claudeSessionId: `sid-${position}`,
        name: `tile-${position}`,
        cwd: "/abs/project",
        args: ["--agent", "reviewer"],
        color: "#4488ff",
        position,
      })),
    })
  );
  const deps = fakeDeps(proj);
  const svc = workspaceService(deps);

  expect(await svc.restore("wsp_over_cap", "attended")).toEqual({ ok: true });
  expect(deps.sessions).toHaveLength(SPAWN_CAP + 3);
});

test("WorkspaceService.restore(): a workspace id with no saved file resolves to reason 'missing'", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const deps = fakeDeps(proj);
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_does_not_exist", "attended");
  expect(result).toEqual({ ok: false, reason: "missing" });
  expect(svc.currentWorkspaceId).not.toBe("wsp_does_not_exist");
});

test("WorkspaceService.restore(): a saved workspace with zero sessions resolves to reason 'empty', never reaching restoreFrom (b8d65b24 follow-up)", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_empty", sessions: [] });
  saveFresh(proj, ws);
  const deps = fakeDeps(proj);
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_empty", "attended");
  expect(result).toEqual({ ok: false, reason: "empty" });
  // restoreFrom() must never run for an empty snapshot: it starts with
  // pty.killAll(), so "restoring nothing" would kill every live session for
  // no replacement.
  expect(deps.sessions).toEqual([fakeSession()]);
});

// A repo-hostile workspace file's args is joined and appended verbatim to the
// login-shell command line with no escaping. restore() must gate that on the
// same operator approval templates require, before restoreFrom() runs --
// spawnSession silently downgrades a resume with no matching transcript to
// fresh, re-attaching args, which an attacker gets for free via a
// claudeSessionId that never had one.
test("WorkspaceService.restore(): refuses when args are shell-bearing and confirmShellFields declines (card 09d54a29)", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
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
  saveFresh(proj, ws);
  let confirmCalls = 0;
  const deps = fakeDeps(proj, {
    confirmShellFields: async () => {
      confirmCalls++;
      return "declined";
    },
  });
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_hostile", "attended");
  expect(result).toEqual({ ok: false, reason: "shell-declined" });
  // The exact shape of the vulnerability: restoreFrom() (-> startPty ->
  // buildSessionCommandLine) must never run. Proven here by the stub's
  // captured session defs being untouched from before the call.
  expect(deps.sessions).toEqual([fakeSession()]);
  expect(confirmCalls).toBe(1);
});

// Same file, same class of vulnerability, no args at all: `bridge` alone
// decides which binary the restored tile launches, so it must reach the SAME
// gate before restoreFrom() runs.
test("WorkspaceService.restore(): refuses when a session carries only a bridge marker and confirmShellFields declines", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({
    id: "wsp_bridge_only",
    sessions: [
      {
        claudeSessionId: "sid-1",
        name: "bridged",
        cwd: "/abs/project",
        args: [],
        bridge: "clodex",
        color: "#4488ff",
        position: 0,
      },
    ],
  });
  saveFresh(proj, ws);
  let confirmCalls = 0;
  const deps = fakeDeps(proj, {
    confirmShellFields: async () => {
      confirmCalls++;
      return "declined";
    },
  });
  const svc = workspaceService(deps);
  expect(await svc.restore("wsp_bridge_only", "attended")).toEqual({
    ok: false,
    reason: "shell-declined",
  });
  expect(confirmCalls).toBe(1);
  // restoreFrom() must never have run: the stub's captured defs are untouched.
  expect(deps.sessions).toEqual([fakeSession()]);
});

test("WorkspaceService.restore(): proceeds when args are shell-bearing and confirmShellFields approves", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  // sampleWorkspace()'s default session already carries non-empty args.
  const ws = sampleWorkspace({ id: "wsp_approved" });
  saveFresh(proj, ws);
  const deps = fakeDeps(proj, { confirmShellFields: async () => "approved" });
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_approved", "attended");
  expect(result).toEqual({ ok: true });
});

test("WorkspaceService.restore(): an unattended caller with an unapproved shell-bearing payload gets 'unattended', not 'shell-declined' (card 64f8f629)", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_hostile_unattended" });
  saveFresh(proj, ws);
  const deps = fakeDeps(proj, { confirmShellFields: async () => "unattended" });
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_hostile_unattended", "unattended");
  expect(result).toEqual({ ok: false, reason: "unattended" });
  expect(deps.sessions).toEqual([fakeSession()]);
});

// Team-lead security audit, card 64f8f629: the two tests above only pin the
// STUB's RETURN value, not what restore() actually SENDS it -- a mutation
// that drops the threading (`this.deps.confirmShellFields(ws, attendance)`
// -> `this.deps.confirmShellFields(ws, "attended")`, hardcoded) left every
// pre-existing test green. These two observe the RECEIVED argument instead.
test("WorkspaceService.restore(): the caller's own attendance ('unattended') reaches confirmShellFields verbatim", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_seen_unattended" });
  saveFresh(proj, ws);
  const seen: CallerAttendance[] = [];
  const deps = fakeDeps(proj, {
    confirmShellFields: async (_ws, attendance) => {
      seen.push(attendance);
      return "approved";
    },
  });
  const svc = workspaceService(deps);
  await svc.restore("wsp_seen_unattended", "unattended");
  expect(seen).toEqual(["unattended"]);
});

test("WorkspaceService.restore(): the caller's own attendance ('attended') reaches confirmShellFields verbatim", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_seen_attended" });
  saveFresh(proj, ws);
  const seen: CallerAttendance[] = [];
  const deps = fakeDeps(proj, {
    confirmShellFields: async (_ws, attendance) => {
      seen.push(attendance);
      return "approved";
    },
  });
  const svc = workspaceService(deps);
  await svc.restore("wsp_seen_attended", "attended");
  expect(seen).toEqual(["attended"]);
});

test("WorkspaceService.restore(): never asks for approval when no session carries args", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
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
  saveFresh(proj, ws);
  let confirmCalls = 0;
  const deps = fakeDeps(proj, {
    confirmShellFields: async () => {
      confirmCalls++;
      return "declined";
    },
  });
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_benign", "attended");
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
test("WorkspaceService.restore(): refuses when a session's cwd is outside the project tree and confirmUntrustedCwd declines (card 09d54a29 follow-up, GX-SEC)", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
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
  saveFresh(proj, ws);
  let confirmCalls = 0;
  const deps = fakeDeps(proj, {
    confirmUntrustedCwd: async () => {
      confirmCalls++;
      return "declined";
    },
  });
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_hostile_cwd", "attended");
  expect(result).toEqual({ ok: false, reason: "cwd-declined" });
  expect(deps.sessions).toEqual([fakeSession()]);
  expect(confirmCalls).toBe(1);
});

test("WorkspaceService.restore(): an unattended caller with an unapproved untrusted cwd gets 'unattended', not 'cwd-declined' (card 64f8f629)", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const outside = mkdtempSync(join(tmpdir(), "cp-wsp-outside-"));
  tmpDirs.push(outside);
  const ws = sampleWorkspace({
    id: "wsp_hostile_cwd_unattended",
    cwd: proj,
    sessions: [
      { claudeSessionId: "sid-1", name: "reviewer", cwd: outside, args: [], color: "#4488ff", position: 0 },
    ],
  });
  saveFresh(proj, ws);
  const deps = fakeDeps(proj, { confirmUntrustedCwd: async () => "unattended" });
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_hostile_cwd_unattended", "unattended");
  expect(result).toEqual({ ok: false, reason: "unattended" });
  expect(deps.sessions).toEqual([fakeSession()]);
});

// Team-lead security audit, card 64f8f629: same threading gap as
// confirmShellFields above, on the SEPARATE untrusted-cwd gate.
test("WorkspaceService.restore(): the caller's own attendance reaches confirmUntrustedCwd verbatim, in both directions", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const outside = mkdtempSync(join(tmpdir(), "cp-wsp-outside-"));
  tmpDirs.push(outside);
  const wsFor = (id: string): Workspace =>
    sampleWorkspace({
      id,
      cwd: proj,
      sessions: [
        { claudeSessionId: "sid-1", name: "reviewer", cwd: outside, args: [], color: "#4488ff", position: 0 },
      ],
    });
  saveFresh(proj, wsFor("wsp_cwd_seen_unattended"));
  saveFresh(proj, wsFor("wsp_cwd_seen_attended"));

  const seen: CallerAttendance[] = [];
  const deps = fakeDeps(proj, {
    confirmUntrustedCwd: async (_ws, attendance) => {
      seen.push(attendance);
      return "approved";
    },
  });
  const svc = workspaceService(deps);
  await svc.restore("wsp_cwd_seen_unattended", "unattended");
  await svc.restore("wsp_cwd_seen_attended", "attended");
  expect(seen).toEqual(["unattended", "attended"]);
});

test("WorkspaceService.restore(): proceeds when cwd is outside the project tree and confirmUntrustedCwd approves", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
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
  saveFresh(proj, ws);
  const deps = fakeDeps(proj, { confirmUntrustedCwd: async () => "approved" });
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_approved_cwd", "attended");
  expect(result).toEqual({ ok: true });
});

// No false positive on the common case: a saved multi-worktree workspace
// (sessions living under <projectDir>/.worktrees/<name>, the ONLY place
// createWorktree ever places them, worktree-service.ts) must restore
// without prompting, or every ordinary restore would nag the operator.
test("WorkspaceService.restore(): never asks about cwd for the project root or a .worktrees/ path under it", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
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
  saveFresh(proj, ws);
  let confirmCalls = 0;
  const deps = fakeDeps(proj, {
    confirmUntrustedCwd: async () => {
      confirmCalls++;
      return "declined";
    },
  });
  const svc = workspaceService(deps);
  const result = await svc.restore("wsp_worktrees", "attended");
  expect(result).toEqual({ ok: true });
  expect(confirmCalls).toBe(0);
});

// heartbeatTick() is the extracted body of own()'s setInterval callback
// (card 438c15e3, review round 2): setInterval itself now contains only
// `() => this.heartbeatTick()`, a one-line, greppable, unproven remainder --
// everything ELSE the callback does is reachable and testable by calling
// heartbeatTick() directly, without an injectable timer.
test("WorkspaceService.heartbeatTick(): refreshes with THIS instance's own identity, self-ejects ONCE on mismatch (not per call)", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const deps = fakeDeps(proj); // pid: 4242, host: "this-host"
  const svc = workspaceService(deps);
  expect(svc.saveAuto()).not.toBeNull();
  const id = svc.currentWorkspaceId!;
  const tick = () => (svc as unknown as { heartbeatTick(): void }).heartbeatTick();

  // Phase 1: lock still ours -- heartbeatTick() must pass deps.pid/deps.host
  // to refreshLock() (not e.g. hardcoded/omitted values) and bump the
  // on-disk heartbeat, with no error reported.
  const before = readLock(fresh(proj, id))!.heartbeat;
  const reportedOwned: Array<{ scope: string; text: string }> = [];
  onDeckError((scope, text) => reportedOwned.push({ scope, text }));
  tick();
  onDeckError(() => {});
  expect(reportedOwned.length).toBe(0);
  expect(readLock(fresh(proj, id))!.heartbeat).toBeGreaterThanOrEqual(before);
  expect(readLock(fresh(proj, id))!.pid).toBe(4242);
  expect(readLock(fresh(proj, id))!.host).toBe("this-host");

  // Phase 2: steal the lock out from under this instance WITHOUT going
  // through WorkspaceService, so the next tick() must observe a mismatch. A
  // LIVE owner (fresh heartbeat on another host): a dead one is rewritten.
  const foreignLock: Lock = { pid: 99_999, host: "other-host", startedAt: 0, heartbeat: Date.now() };
  writeFileSync(join(workspacesDir(proj, "koryphaios"), `${id}.lock`), JSON.stringify(foreignLock));

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
  expect(readLock(fresh(proj, id))).toEqual(foreignLock);
});

test("WorkspaceService.heartbeatTick(): reports a successful repair when no failure was reported", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const svc = workspaceService(fakeDeps(proj, {
    openLock: () => ({ exec: () => {}, close: () => {} }),
  }));
  expect(svc.saveAuto()).not.toBeNull();
  const id = svc.currentWorkspaceId!;
  const tick = () => (svc as unknown as { heartbeatTick(): void }).heartbeatTick();
  const reported: Array<{ scope: string; text: string }> = [];

  rmSync(workspacesDir(proj, "koryphaios"), { recursive: true, force: true });
  ensureWorkspacesDir(freshRoot(proj));
  onDeckError((scope, text) => reported.push({ scope, text }));
  try {
    tick();
    tick();
  } finally {
    onDeckError(() => {});
  }

  expect(reported).toEqual([
    expect.objectContaining({ scope: "workspace", text: expect.stringContaining(id) }),
  ]);
  expect(readLock(fresh(proj, id))).toEqual(expect.objectContaining({ pid: 4242, host: "this-host" }));
});

test("WorkspaceService.heartbeatTick(): reports failures independently after changing workspaces", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const svc = workspaceService(fakeDeps(proj, {
    openLock: () => ({ exec: () => {}, close: () => {} }),
  }));
  expect(svc.saveAuto()).not.toBeNull();
  const firstId = svc.currentWorkspaceId!;
  const tick = () => (svc as unknown as { heartbeatTick(): void }).heartbeatTick();
  const reported: Array<{ scope: string; text: string }> = [];
  const tickWithoutThrow = () => {
    let thrown: unknown;
    try {
      tick();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
  };

  rmSync(workspacesDir(proj, "koryphaios"), { recursive: true, force: true });
  onDeckError((scope, text) => reported.push({ scope, text }));
  try {
    tickWithoutThrow();
    ensureWorkspacesDir(freshRoot(proj));
    saveFresh(proj, sampleWorkspace({ id: "wsp_b" }));
    expect(await svc.restore("wsp_b", "attended")).toEqual({ ok: true });

    rmSync(workspacesDir(proj, "koryphaios"), { recursive: true, force: true });
    tickWithoutThrow();
  } finally {
    onDeckError(() => {});
    ensureWorkspacesDir(freshRoot(proj));
  }

  expect(reported.filter(({ text }) => text.includes("heartbeat failed"))).toEqual([
    expect.objectContaining({ text: expect.stringContaining(firstId) }),
    expect.objectContaining({ text: expect.stringContaining("wsp_b") }),
  ]);
});

test("WorkspaceService.heartbeatTick(): retains the lock and retries after workspace storage disappears", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  let rollbacks = 0;
  let closes = 0;
  const svc = workspaceService(fakeDeps(proj, {
    openLock: () => ({
      exec: (sql) => {
        if (sql === "ROLLBACK") rollbacks++;
      },
      close: () => {
        closes++;
      },
    }),
  }));
  expect(svc.saveAuto()).not.toBeNull();
  const id = svc.currentWorkspaceId!;
  const tick = () => (svc as unknown as { heartbeatTick(): void }).heartbeatTick();
  const reported: Array<{ scope: string; text: string }> = [];
  const heartbeatFailures = () => reported.filter(({ text }) => text.includes("heartbeat failed"));
  const tickWithoutThrow = () => {
    let thrown: unknown;
    try {
      tick();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
  };

  rmSync(workspacesDir(proj, "koryphaios"), { recursive: true, force: true });
  onDeckError((scope, text) => reported.push({ scope, text }));
  try {
    tickWithoutThrow();
    expect(heartbeatFailures()).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(rollbacks).toBe(0);
    expect(closes).toBe(0);

    tickWithoutThrow();
    expect(heartbeatFailures()).toHaveLength(1);
    expect(reported).toHaveLength(1);

    ensureWorkspacesDir(freshRoot(proj));
    tickWithoutThrow();
    expect(reported).toHaveLength(1);
    expect(readLock(fresh(proj, id))).toEqual(expect.objectContaining({ pid: 4242, host: "this-host" }));

    rmSync(workspacesDir(proj, "koryphaios"), { recursive: true, force: true });
    tickWithoutThrow();
    expect(heartbeatFailures()).toHaveLength(2);
    expect(reported).toHaveLength(2);
  } finally {
    onDeckError(() => {});
    ensureWorkspacesDir(freshRoot(proj));
  }
});

test("WorkspaceService.restore(): re-restoring the already-current workspace does not lose the lock (own() same-id fast path)", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_target" });
  saveFresh(proj, ws);
  const deps = fakeDeps(proj);
  const svc = workspaceService(deps);
  expect(await svc.restore("wsp_target", "attended")).toEqual({ ok: true });
  const before = readLock(fresh(proj, "wsp_target"));
  expect(before).not.toBeNull();
  // A second restore() of the SAME id this instance already owns must NOT
  // route through acquireLock() again: acquireLock() refuses whenever the
  // existing lock is live, with no identity special-case, so re-acquiring
  // our OWN live lock would spuriously fail without own()'s same-id fast
  // path -- turning a harmless self-restore into a reported error over
  // nothing (flagged by review before any code changed here: "own(x) when
  // currentId already x, the lock must survive the call").
  expect(await svc.restore("wsp_target", "attended")).toEqual({ ok: true });
  expect(svc.currentWorkspaceId).toBe("wsp_target");
  expect(readLock(fresh(proj, "wsp_target"))).toEqual(before);
});

test("WorkspaceService.saveNamed(): a third party reclaiming the lock file out from under a held currentId must refuse the write (review round 7)", async () => {
  // Reviewer's probe (review round 7): hold wsp_target, have a THIRD PARTY
  // (not this instance) reclaim the on-disk lock file directly, then call
  // saveNamed() -- persist()'s ensureCurrent() must re-confirm ownership via
  // own()/ownsLock before writing, not trust the in-memory currentId. Before
  // this fix: threw=false, write went through under a foreign live lock.
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = sampleWorkspace({ id: "wsp_target" });
  saveFresh(proj, ws);
  const deps = fakeDeps(proj); // pid: 4242, host: "this-host"
  const svc = workspaceService(deps);
  expect(await svc.restore("wsp_target", "attended")).toEqual({ ok: true });
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
  writeFileSync(join(workspacesDir(proj, "koryphaios"), "wsp_target.lock"), JSON.stringify(foreignLock));

  expect(() => svc.saveNamed("renamed")).toThrow("workspace-lock-unavailable");
  // The foreign lock must be UNCHANGED -- this instance must not have
  // re-stamped it with its own identity while "writing".
  expect(readLock(fresh(proj, "wsp_target"))).toEqual(foreignLock);
  // this instance still (wrongly, in its own memory) believes it owns
  // wsp_target -- own()'s fast path answers that on the NEXT call by
  // re-reading the file, not by caching this refusal, but the refusal
  // itself is what matters here: the write must not have happened.
  expect(svc.currentWorkspaceId).toBe("wsp_target");
});

test("WorkspaceService.restore(): failing to acquire the NEW lock leaves the OLD lock intact (never lose both)", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_a" }));
  saveFresh(proj, sampleWorkspace({ id: "wsp_b" }));
  const deps = fakeDeps(proj);
  const svc = workspaceService(deps);
  expect(await svc.restore("wsp_a", "attended")).toEqual({ ok: true });
  const lockABefore = readLock(fresh(proj, "wsp_a"));
  expect(lockABefore).not.toBeNull();
  // wsp_b is already held live by a foreign instance -- own("wsp_b") must
  // refuse (acquireLock() returns false), and restore() must fail WITHOUT
  // touching wsp_a's lock: own() only releases the OLD lock AFTER the NEW
  // one is confirmed acquired (workspace-service.ts), so a failed
  // acquisition of the new id must never cost the old one.
  takeLock(fresh(proj, "wsp_b"), {
    host: "other-host",
    now: Date.now(),
    bootInstant: 0,
    startedAt: 1_000,
    staleMs: 5_000,
    isPidAlive: () => true,
    pid: 1,
  });
  // Card 07134c6a: this failure fires at restore()'s TOP guard (the lock is
  // already held live by 'other-host' before restore() is even called) --
  // reason 'locked', distinct from the TOCTOU 'lock-race' test above (which
  // loses the race INSIDE own(), after sessions were already swapped).
  expect(await svc.restore("wsp_b", "attended")).toEqual({ ok: false, reason: "locked" });
  expect(svc.currentWorkspaceId).toBe("wsp_a");
  expect(readLock(fresh(proj, "wsp_a"))).toEqual(lockABefore);
});

test("WorkspaceService.saveAuto(): reclaims a lock left by a dead pid after the own()/persist() reordering (blocking measurement, service level)", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const deps = fakeDeps(proj);
  const svc = workspaceService(deps);
  const summary = svc.saveAuto();
  expect(summary).not.toBeNull();
  const id = svc.currentWorkspaceId!;
  // Kill this "instance" from the lock file's point of view by writing a
  // lock stamped with a pid nothing will answer for, then let a SECOND
  // WorkspaceService (fresh instance, same host, different pid) try to
  // restore the same workspace -- it must reclaim, not be permanently
  // refused, exactly the concern raised before writing any of this code.
  // A dead instance holds no OS lock: releaseOnQuit stands for its exit.
  svc.releaseOnQuit();
  const deadLock: Lock = { pid: 777_777, host: "this-host", startedAt: 0, heartbeat: 0 };
  writeFileSync(join(workspacesDir(proj, "koryphaios"), `${id}.lock`), JSON.stringify(deadLock));
  const deps2 = fakeDeps(proj, { pid: 5555 });
  const svc2 = workspaceService(deps2);
  const result = await svc2.restore(id, "attended");
  expect(result).toEqual({ ok: true });
  expect(readLock(fresh(proj, id))!.pid).toBe(5555);
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

const settled = <T>(promise: Promise<T>): Promise<T> => reachedWithin(promise, "the restore settles", 1500);

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function projectSessionsWorkspace(proj: string, id: string): Workspace {
  const base = sampleWorkspace().sessions[0]!;
  return sampleWorkspace({
    id,
    sessions: [
      { ...base, name: "first", claudeSessionId: "sid-first", cwd: proj, args: [], position: 0 },
      { ...base, name: "second", claudeSessionId: "sid-second", cwd: proj, args: [], position: 1 },
    ],
  });
}

interface PendingPreparation {
  defs: SessionDef[];
  signal: AbortSignal;
  release(): void;
  fail(error: Error): void;
}

function modRestoreRig(proj: string, overrides: Partial<WorkspaceDeps> = {}, events: string[] = []) {
  const pending: PendingPreparation[] = [];
  const restored: Array<{ defs: SessionDef[]; plans: unknown }> = [];
  const deps = fakeDeps(proj, {
    adoptScope: async (_ws, own) => {
      events.push("adopt");
      return own()
        ? { state: "published", scope: { projectKey: "project", groupId: fakeScope().groupId } }
        : { state: "lock-race" };
    },
    setConfig: () => { events.push("config"); },
    prepareModPlans: (defs, signal) => {
      events.push("prepare");
      return new Promise((resolve, reject) => {
        pending.push({
          defs: [...defs],
          signal,
          release: () => resolve({ ok: true, plans: new Map(defs.map((d) => [d.id, { attemptId: d.id, mode: "host" as const, modDirs: [`/mods/${d.name}`], diagnostics: [] }])) }),
          fail: (error) => reject(error),
        });
      });
    },
    ...overrides,
  });
  const applySessions = deps.service.restoreFrom.bind(deps.service);
  deps.service.restoreFrom = ((defs: SessionDef[], plans?: unknown) => {
    events.push("restore");
    restored.push({ defs, plans });
    return applySessions(defs);
  }) as WorkspaceDeps["service"]["restoreFrom"];
  return { deps, events, pending, restored, svc: workspaceService(deps) };
}

test("WorkspaceService.restore(): mod plans are prepared only after the approval, in that order", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = shellOnlyWorkspace(proj, "wsp-prep-order");
  saveFresh(proj, ws);
  const gate = deferredGate();
  const events: string[] = [];
  const rig = modRestoreRig(proj, { confirmShellFields: async () => { events.push("gate"); return gate.promise; } }, events);

  const restoring = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();
  expect(rig.events, "no preparation while the operator has not approved").toEqual(["gate"]);

  gate.resolve("approved");
  await flushMicrotasks();
  expect(rig.events).toEqual(["gate", "prepare"]);
  rig.pending[0]!.release();
  await expect(settled(restoring)).resolves.toEqual({ ok: true });
  expect(rig.events).toEqual(["gate", "prepare", "adopt", "config", "restore"]);
});

test.each([
  ["shell", "confirmShellFields"],
  ["cwd", "confirmUntrustedCwd"],
] as const)("WorkspaceService.restore(): a restore declined at the %s approval prepares nothing", async (_name, gateKey) => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = gateKey === "confirmShellFields" ? shellOnlyWorkspace(proj, "wsp-prep-declined-shell") : cwdOnlyWorkspace("wsp-prep-declined-cwd");
  saveFresh(proj, ws);
  const rig = modRestoreRig(proj, { [gateKey]: async () => "declined" });

  const result = await settled(rig.svc.restore(ws.id, "attended"));

  expect(result.ok).toBe(false);
  expect(rig.events, "a declined restore must not build or copy anything").toEqual([]);
});

test("WorkspaceService.restore(): restoreFrom receives the very defs that were prepared, with their plans keyed by def id", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = projectSessionsWorkspace(proj, "wsp-prep-plans");
  saveFresh(proj, ws);
  const rig = modRestoreRig(proj);

  const restoring = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();
  saveFresh(proj, { ...ws, sessions: ws.sessions.map((s) => ({ ...s, name: "rewritten" })) });
  rig.pending[0]!.release();
  await expect(settled(restoring)).resolves.toEqual({ ok: true });

  const ids = rig.pending[0]!.defs.map((d) => d.id);
  expect(rig.restored).toHaveLength(1);
  expect(rig.restored[0]!.defs.map((d) => d.id), "ids are minted per call: a recomputation orphans every plan").toEqual(ids);
  expect(rig.restored[0]!.defs.map((d) => d.name)).toEqual(["first", "second"]);
  const plans = rig.restored[0]!.plans as Map<string, { attemptId: string; modDirs: string[] }>;
  expect(plans, "the plans must reach restoreFrom").toBeInstanceOf(Map);
  expect([...plans.keys()]).toEqual(ids);
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
  expect(plans.get(ids[0]!)!.modDirs).toEqual(["/mods/first"]);
  expect(plans.get(ids[1]!)!.modDirs).toEqual(["/mods/second"]);
});

test("WorkspaceService.restore(): the live tiles, scope and config stay untouched while the mods are being prepared", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = projectSessionsWorkspace(proj, "wsp-prep-wait");
  saveFresh(proj, ws);
  const rig = modRestoreRig(proj);
  const liveBefore = rig.deps.sessions.map((s) => s.id);

  const restoring = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();

  expect(rig.events, "nothing may be swapped before the preparation settles").toEqual(["prepare"]);
  expect(rig.deps.sessions.map((s) => s.id)).toEqual(liveBefore);

  rig.pending[0]!.release();
  await settled(restoring);
  expect(rig.deps.sessions.map((s) => s.name)).toEqual(["first", "second"]);
});

test("WorkspaceService.restore(): a restore superseded while mods prepare applies nothing", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = projectSessionsWorkspace(proj, "wsp-prep-superseded");
  saveFresh(proj, ws);
  const rig = modRestoreRig(proj);

  const restoring = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();
  rig.svc.startNew();
  rig.pending[0]!.release();

  await expect(settled(restoring)).resolves.toEqual({ ok: false, reason: "superseded" });
  expect(rig.events.filter((e) => e !== "prepare"), "no scope, config or tile effect after a superseded preparation").toEqual([]);
});

test("WorkspaceService.restore(): a lock taken by another instance while mods prepare refuses the restore", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = projectSessionsWorkspace(proj, "wsp-prep-locked");
  saveFresh(proj, ws);
  const rig = modRestoreRig(proj);

  const restoring = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();
  takeLock(fresh(proj, ws.id), { ...baseLiveness, pid: 9999, isPidAlive: () => true });
  rig.pending[0]!.release();

  await expect(settled(restoring)).resolves.toEqual({ ok: false, reason: "locked" });
  expect(rig.events.filter((e) => e !== "prepare")).toEqual([]);
});

test("WorkspaceService.restore(): a second restore aborts the previous preparation and only it is applied", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const first = projectSessionsWorkspace(proj, "wsp-prep-first");
  const second = projectSessionsWorkspace(proj, "wsp-prep-second");
  saveFresh(proj, first);
  saveFresh(proj, second);
  const rig = modRestoreRig(proj);

  const restoringFirst = rig.svc.restore(first.id, "attended");
  await flushMicrotasks();
  rig.svc.deleteWs(first.id);
  const restoringSecond = rig.svc.restore(second.id, "attended");
  await flushMicrotasks();

  expect(rig.pending).toHaveLength(2);
  expect(rig.pending[0]!.signal.aborted, "the replaced restore must stop preparing").toBe(true);
  expect(rig.pending[1]!.signal.aborted, "the new restore must keep its own preparation alive").toBe(false);

  rig.pending[0]!.release();
  await expect(settled(restoringFirst)).resolves.toEqual({ ok: false, reason: "superseded" });
  rig.pending[1]!.release();
  await expect(settled(restoringSecond)).resolves.toEqual({ ok: true });

  expect(rig.restored, "exactly one restore reaches the tiles").toHaveLength(1);
  expect(rig.restored[0]!.defs.map((d) => d.id)).toEqual(rig.pending[1]!.defs.map((d) => d.id));
  expect(rig.svc.currentWorkspaceId).toBe(second.id);
});

test("WorkspaceService.restore(): a failing preparation swaps nothing and leaves the service ready for the next restore", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = projectSessionsWorkspace(proj, "wsp-prep-failing");
  saveFresh(proj, ws);
  const rig = modRestoreRig(proj);

  const failing = rig.svc.restore(ws.id, "attended").then(() => "resolved", () => "rejected");
  await flushMicrotasks();
  rig.pending[0]!.fail(new Error("copy failed"));
  await settled(failing);

  expect(rig.events.filter((e) => e !== "prepare"), "a failed preparation must not replace the tiles").toEqual([]);
  const again = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();
  expect(rig.pending, "the service is not stuck busy").toHaveLength(2);
  rig.pending[1]!.release();
  await expect(settled(again)).resolves.toEqual({ ok: true });
});

test.each([
  ["deleting the workspace being restored", "delete", (svc: ReturnType<typeof workspaceService>, id: string) => svc.deleteWs(id)],
  ["starting a new workspace", "new", (svc: ReturnType<typeof workspaceService>) => svc.startNew()],
  ["quitting", "quit", (svc: ReturnType<typeof workspaceService>) => svc.releaseOnQuit()],
] as const)("WorkspaceService: %s aborts the mod preparation of a pending restore and no tile is swapped", async (_name, slug, act) => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = projectSessionsWorkspace(proj, `wsp-abort-${slug}`);
  saveFresh(proj, ws);
  const rig = modRestoreRig(proj);

  const restoring = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();
  expect(rig.pending, "the restore must be waiting on its mod preparation").toHaveLength(1);
  act(rig.svc, ws.id);

  expect(rig.pending[0]!.signal.aborted, "the preparation keeps copying into a container nobody will use").toBe(true);
  rig.pending[0]!.release();
  await expect(settled(restoring)).resolves.toEqual({ ok: false, reason: "superseded" });
  expect(rig.restored, "an invalidated restore must never reach the tiles").toHaveLength(0);
  expect(rig.events.filter((e) => e !== "prepare")).toEqual([]);
});

test("WorkspaceService.deleteWs: deleting another workspace leaves the pending restore preparation running", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const restored = projectSessionsWorkspace(proj, "wsp-abort-bystander-restored");
  const other = projectSessionsWorkspace(proj, "wsp-abort-bystander-other");
  saveFresh(proj, restored);
  saveFresh(proj, other);
  const rig = modRestoreRig(proj);

  const restoring = rig.svc.restore(restored.id, "attended");
  await flushMicrotasks();
  rig.svc.deleteWs(other.id);

  expect(rig.pending[0]!.signal.aborted, "an unrelated deletion must not cancel the restore").toBe(false);
  rig.pending[0]!.release();
  await expect(settled(restoring)).resolves.toEqual({ ok: true });
  expect(rig.restored).toHaveLength(1);
});

test("WorkspaceService.restore(): a superseded mod preparation swaps nothing and releases the operation", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = projectSessionsWorkspace(proj, "wsp-prep-batch-superseded");
  saveFresh(proj, ws);
  let preparations = 0;
  const events: string[] = [];
  const rig = modRestoreRig(proj, {
    prepareModPlans: async (defs) => {
      preparations++;
      if (preparations === 1) return { ok: false as const, reason: "superseded" as const };
      return { ok: true as const, plans: new Map(defs.map((def) => [def.id, { attemptId: def.id, mode: "host" as const, modDirs: [], copies: [], diagnostics: [] }])) };
    },
  }, events);

  await expect(settled(rig.svc.restore(ws.id, "attended"))).resolves.toEqual({ ok: false, reason: "superseded" });
  expect(events).toEqual([]);
  expect(rig.restored).toHaveLength(0);

  await expect(settled(rig.svc.restore(ws.id, "attended"))).resolves.toEqual({ ok: true });
  expect(rig.restored).toHaveLength(1);
});

test("WorkspaceService.restore(): a restore started after an invalidation prepares on a fresh signal", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = projectSessionsWorkspace(proj, "wsp-abort-fresh-signal");
  saveFresh(proj, ws);
  const rig = modRestoreRig(proj);

  const first = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();
  rig.svc.startNew();
  const second = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();

  expect(rig.pending).toHaveLength(2);
  expect(rig.pending[0]!.signal.aborted).toBe(true);
  expect(rig.pending[1]!.signal.aborted, "the replacement restore must not inherit the aborted signal").toBe(false);
  rig.pending[0]!.release();
  rig.pending[1]!.release();
  await expect(settled(first)).resolves.toEqual({ ok: false, reason: "superseded" });
  await expect(settled(second)).resolves.toEqual({ ok: true });
  expect(rig.restored).toHaveLength(1);
});

function credentialRig(proj: string, adopt: WorkspaceDeps["adoptScope"], overrides: Partial<WorkspaceDeps> = {}) {
  const failures: unknown[] = [];
  const events: string[] = [];
  const counts = { cancel: 0, close: 0, restoreFrom: 0 };
  const deps = fakeDeps(proj, {
    adoptScope: adopt,
    onCredentialFailure: (result) => { failures.push(result); },
    setConfig: () => { events.push("config"); },
    cancelScopeAdoption: () => { counts.cancel++; },
    closeScopeAdoption: () => { counts.close++; },
    ...overrides,
  });
  const applySessions = deps.service.restoreFrom.bind(deps.service);
  deps.service.restoreFrom = ((defs: SessionDef[], plans?: unknown) => {
    counts.restoreFrom++;
    events.push("restore");
    return applySessions(defs, plans as never);
  }) as WorkspaceDeps["service"]["restoreFrom"];
  return { deps, failures, events, counts, svc: workspaceService(deps) };
}

test("WorkspaceService.restore(): each refused adoption state maps to its own reason and opens nothing", async () => {
  const table: Array<[Awaited<ReturnType<WorkspaceDeps["adoptScope"]>>, { ok: false; reason: string }, boolean]> = [
    [{ state: "credential-timed-out" }, { ok: false, reason: "credential-timed-out" }, true],
    [{ state: "lock-race" }, { ok: false, reason: "lock-race" }, false],
    [{ state: "superseded" }, { ok: false, reason: "superseded" }, false],
    [{ state: "closed" }, { ok: false, reason: "superseded" }, false],
    [{ state: "busy" }, { ok: false, reason: "busy" }, false],
  ];
  for (const [adoption, expected, reported] of table) {
    const proj = freshProject();
    ensureWorkspacesDir(freshRoot(proj));
    saveFresh(proj, sampleWorkspace({ id: "wsp_refused" }));
    const rig = credentialRig(proj, async () => adoption);
    await expect(rig.svc.restore("wsp_refused", "attended"), adoption.state).resolves.toEqual(expected);
    expect(rig.events, `${adoption.state}: no config and no session may follow a refused adoption`).toEqual([]);
    expect(rig.svc.currentWorkspaceId, `${adoption.state}: the workspace must not become current`).toBeNull();
    expect(readLock(fresh(proj, "wsp_refused")), `${adoption.state}: no lock may be left behind`).toBeNull();
    expect(rig.failures.length, `${adoption.state}: failure sink calls`).toBe(reported ? 1 : 0);
  }
});

test("WorkspaceService.restore(): a credential refusal reaches the failure sink with its typed cause and keeps that cause", async () => {
  for (const cause of ["trust", "identity", "capability", "local-file", "mint-refused"] as const) {
    const proj = freshProject();
    ensureWorkspacesDir(freshRoot(proj));
    saveFresh(proj, sampleWorkspace({ id: "wsp_cause" }));
    const rig = credentialRig(proj, async () => ({ state: "credential-unavailable", cause }));
    await expect(rig.svc.restore("wsp_cause", "attended"), cause).resolves.toEqual({ ok: false, reason: "credential-unavailable", cause });
    expect(rig.failures, `${cause}: the sink receives the adoption result`).toEqual([{ state: "credential-unavailable", cause }]);
    expect(rig.events, `${cause}: nothing is applied`).toEqual([]);
    expect(rig.svc.currentWorkspaceId).toBeNull();
  }
});

test("WorkspaceService.restore(): a preparation refused as busy or closed is a quiet result, not a credential failure", async () => {
  const table: Array<["busy" | "closed", string]> = [
    ["busy", "busy"],
    ["closed", "superseded"],
  ];
  for (const [cause, reason] of table) {
    const proj = freshProject();
    ensureWorkspacesDir(freshRoot(proj));
    saveFresh(proj, sampleWorkspace({ id: "wsp_quiet_refusal" }));
    const rig = credentialRig(proj, async () => ({ state: "credential-unavailable", cause }));
    await expect(rig.svc.restore("wsp_quiet_refusal", "attended"), cause).resolves.toEqual({ ok: false, reason });
    expect(rig.failures, `${cause}: a quiet refusal must not reach the credential failure sink`).toEqual([]);
    expect(rig.events, `${cause}: nothing is applied`).toEqual([]);
    expect(rig.svc.currentWorkspaceId).toBeNull();
  }
});

test("WorkspaceService.restore(): a preparation refused as invalid-target keeps its own cause and reaches the failure sink", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_invalid_target" }));
  const rig = credentialRig(proj, async () => ({ state: "credential-unavailable", cause: "invalid-target" }));
  await expect(rig.svc.restore("wsp_invalid_target", "attended")).resolves.toEqual({ ok: false, reason: "credential-unavailable", cause: "invalid-target" });
  expect(rig.failures).toEqual([{ state: "credential-unavailable", cause: "invalid-target" }]);
  expect(rig.events).toEqual([]);
});

test("WorkspaceService.restore(): an adoption target carries the saved workspace's own group and scope kind", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_target_scope", groupId: "g-custom-saved", scopeKind: "custom" }));
  const targets: unknown[] = [];
  const rig = credentialRig(proj, async (ws, own) => {
    targets.push(ws);
    return own() ? { state: "published", scope: { projectKey: "project", groupId: ws.groupId } } : { state: "lock-race" };
  }, { getScope: () => ({ ...fakeScope(), groupId: "g-live-other", scopeKind: "ephemeral" }) });
  await expect(rig.svc.restore("wsp_target_scope", "attended")).resolves.toEqual({ ok: true });
  expect(targets).toEqual([{ groupId: "g-custom-saved", scopeKind: "custom" }]);
});

test("WorkspaceService.restore(): a workspace locked by another instance is refused before any approval is asked", async () => {
  const proj = freshProject();
  seedRaceWorkspaces(proj);
  takeForeignTargetLock(proj);
  const asked: string[] = [];
  let adopted = 0;
  const rig = credentialRig(proj, async () => { adopted++; return { state: "lock-race" }; }, {
    confirmShellFields: async () => { asked.push("shell"); return "approved"; },
    confirmUntrustedCwd: async () => { asked.push("cwd"); return "approved"; },
  });
  await expect(rig.svc.restore("wsp_target", "attended")).resolves.toEqual({ ok: false, reason: "locked" });
  expect(asked, "no approval dialog for a workspace another instance holds").toEqual([]);
  expect(adopted).toBe(0);
});

test("WorkspaceService.restore(): an adoption error after acquisition releases the target workspace", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_adoption_error" }));
  const boom = new Error("scope publication failed");
  const rig = credentialRig(proj, async (_ws, own) => {
    own();
    throw boom;
  });

  await expect(rig.svc.restore("wsp_adoption_error", "attended")).rejects.toBe(boom);
  expect(rig.svc.currentWorkspaceId).toBeNull();
  expect(readLock(fresh(proj, "wsp_adoption_error"))).toBeNull();
});

test("WorkspaceService.restore(): a setConfig error after acquisition releases the target workspace", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_config_error" }));
  const boom = new Error("configuration failed");
  const rig = credentialRig(proj, async (_ws, own) => own()
    ? { state: "published", scope: { projectKey: "project", groupId: "scope" } }
    : { state: "lock-race" }, {
      setConfig: () => { throw boom; }
    });

  await expect(rig.svc.restore("wsp_config_error", "attended")).rejects.toBe(boom);
  expect(rig.svc.currentWorkspaceId).toBeNull();
  expect(readLock(fresh(proj, "wsp_config_error"))).toBeNull();
  expect(rig.counts.restoreFrom).toBe(0);
});

test("WorkspaceService.restore(): an error while applying the sessions keeps the new tiles and scope, releases the workspace and writes no snapshot", async () => {
  const proj = freshProject();
  seedRaceWorkspaces(proj);
  const rig = credentialRig(proj, async (ws, own) => own()
    ? { state: "published", scope: { projectKey: "project", groupId: ws.groupId } }
    : { state: "lock-race" });
  await expect(rig.svc.restore("wsp_old", "attended")).resolves.toEqual({ ok: true });
  const oldBefore = loadWorkspace(fresh(proj, "wsp_old"));
  const targetBefore = loadWorkspace(fresh(proj, "wsp_target"));
  const applied = rig.counts.restoreFrom;
  const cancelled = rig.counts.cancel;

  const boom = new Error("tile spawn failed");
  const realRestoreFrom = rig.deps.service.restoreFrom;
  let closeAllCalls = 0;
  (rig.deps.service as unknown as { closeAll: () => void }).closeAll = () => { closeAllCalls++; };
  rig.deps.service.restoreFrom = ((...args: Parameters<typeof realRestoreFrom>) => {
    realRestoreFrom(...args);
    throw boom;
  }) as typeof realRestoreFrom;

  await expect(rig.svc.restore("wsp_target", "attended")).rejects.toBe(boom);
  expect(rig.counts.restoreFrom - applied, "no compensating restoreFrom after the failure").toBe(1);
  expect(closeAllCalls, "the tiles opened before the failure are not closed").toBe(0);
  expect(rig.deps.sessions.map((s) => s.name), "the partial application stays in place").toEqual(["target-peer"]);
  expect(rig.counts.cancel - cancelled, "the scope adoption is not cancelled or rolled back").toBe(0);
  expect(rig.svc.currentWorkspaceId, "the failed workspace must not stay current").toBeNull();
  expect(readLock(fresh(proj, "wsp_target")), "the target workspace lock is released").toBeNull();
  expect(loadWorkspace(fresh(proj, "wsp_target")), "no partial snapshot is written into the target").toEqual(targetBefore);
  expect(loadWorkspace(fresh(proj, "wsp_old")), "no partial snapshot is written into the previous workspace").toEqual(oldBefore);
});

test("WorkspaceService.restore(): a release refused after an application failure is traced and the original error still propagates", async () => {
  const proj = freshProject();
  seedRaceWorkspaces(proj);
  const rig = credentialRig(proj, async (ws, own) => own()
    ? { state: "published", scope: { projectKey: "project", groupId: ws.groupId } }
    : { state: "lock-race" });
  const boom = new Error("tile spawn failed");
  rig.deps.service.restoreFrom = (() => {
    const foreign: Lock = { pid: 99_999, host: "other-host", startedAt: 0, heartbeat: Date.now() };
    writeFileSync(join(workspacesDir(proj, "koryphaios"), "wsp_target.lock"), JSON.stringify(foreign));
    throw boom;
  }) as WorkspaceDeps["service"]["restoreFrom"];

  const reported: Array<{ scope: string; text: string }> = [];
  onDeckError((scope, text) => reported.push({ scope, text }));
  try {
    await expect(rig.svc.restore("wsp_target", "attended")).rejects.toBe(boom);
  } finally {
    onDeckError(() => {});
  }
  expect(reported.filter((r) => r.text.includes("wsp_target") && r.text.includes("release")), "the refused release is traced with the workspace id").toHaveLength(1);
});

test("WorkspaceService.restore(): re-saves the restored workspace under the live scope right after applying it", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_recapture", scopeName: "scope-label-saved-earlier" }));
  const rig = credentialRig(proj, async (ws, own) => own()
    ? { state: "published", scope: { projectKey: "project", groupId: ws.groupId } }
    : { state: "lock-race" });
  await expect(rig.svc.restore("wsp_recapture", "attended")).resolves.toEqual({ ok: true });
  expect(loadWorkspace(fresh(proj, "wsp_recapture"))!.scopeName, "the file records the scope the restored tiles now run under").toBe(fakeScope().name);
});

test("WorkspaceService.restore(): the restored workspace's name stays current even when no tile could be re-captured", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_nameless", name: "Named before restore" }));
  const rig = credentialRig(proj, async (ws, own) => own()
    ? { state: "published", scope: { projectKey: "project", groupId: ws.groupId } }
    : { state: "lock-race" });
  rig.deps.service.restoreFrom = (() => {}) as WorkspaceDeps["service"]["restoreFrom"];
  (rig.deps.service as unknown as { captureSessions: () => SessionDef[] }).captureSessions = () => [];
  await expect(rig.svc.restore("wsp_nameless", "attended")).resolves.toEqual({ ok: true });
  expect(rig.svc.currentWorkspaceId).toBe("wsp_nameless");
  expect(rig.svc.currentWorkspaceName).toBe("Named before restore");
});

test("WorkspaceService.restore(): without a mod preparer, restoreFrom still receives a plans map", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_noplans" }));
  const rig = credentialRig(proj, async (ws, own) => own()
    ? { state: "published", scope: { projectKey: "project", groupId: ws.groupId } }
    : { state: "lock-race" });
  const received: unknown[] = [];
  const realRestoreFrom = rig.deps.service.restoreFrom;
  rig.deps.service.restoreFrom = ((defs: SessionDef[], plans?: unknown) => {
    received.push(plans);
    return realRestoreFrom(defs, plans as never);
  }) as typeof realRestoreFrom;
  await expect(rig.svc.restore("wsp_noplans", "attended")).resolves.toEqual({ ok: true });
  expect(received).toHaveLength(1);
  expect(received[0]).toBeInstanceOf(Map);
  expect((received[0] as Map<unknown, unknown>).size).toBe(0);
});

test("WorkspaceService.deleteWs: deleting a workspace whose restore already finished does not cancel the scope adoption", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  saveFresh(proj, sampleWorkspace({ id: "wsp_finished" }));
  const rig = credentialRig(proj, async (ws, own) => own()
    ? { state: "published", scope: { projectKey: "project", groupId: ws.groupId } }
    : { state: "lock-race" });
  await expect(rig.svc.restore("wsp_finished", "attended")).resolves.toEqual({ ok: true });
  expect(rig.counts.cancel).toBe(0);
  rig.svc.deleteWs("wsp_finished");
  expect(rig.counts.cancel, "no restore is pending for that id any more").toBe(0);
});

test("WorkspaceService.startNew(): a finished restore's mod preparation signal is not aborted afterwards", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const ws = projectSessionsWorkspace(proj, "wsp-finished-signal");
  saveFresh(proj, ws);
  const rig = modRestoreRig(proj);
  const restoring = rig.svc.restore(ws.id, "attended");
  await flushMicrotasks();
  rig.pending[0]!.release();
  await expect(settled(restoring)).resolves.toEqual({ ok: true });
  rig.svc.startNew();
  expect(rig.pending[0]!.signal.aborted, "a completed preparation has nothing left to cancel").toBe(false);
});

test("WorkspaceService.releaseOnQuit(): closes the scope adoption for good rather than only cancelling it", async () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  const rig = credentialRig(proj, async () => ({ state: "closed" }));
  rig.svc.releaseOnQuit();
  expect(rig.counts.close, "quit closes admission").toBe(1);
  expect(rig.counts.cancel, "quit is not a re-armable cancel").toBe(0);
});

// ----- two project folders: a new workspace goes to .claude/koryphaios, an old one stays in .claude/claude-peers -----

const legacy = (projectDir: string, id: string) => ({ projectDir, id, source: "legacy" as const });
const legacyRoot = (projectDir: string) => ({ projectDir, source: "legacy" as const });
const newFolder = (proj: string) => join(proj, ".claude", "koryphaios");
const oldFolder = (proj: string) => join(proj, ".claude", "claude-peers");
const foreignOwner = {
  host: "other-host",
  now: Date.now(),
  bootInstant: 0,
  startedAt: 1_000,
  staleMs: 5_000,
  isPidAlive: () => true,
  pid: 1,
};

function saveInOldFolder(proj: string, ws: Workspace): void {
  saveWorkspace(legacy(proj, ws.id), ws);
}

function ageSnapshot(ref: ReturnType<typeof legacy> | ReturnType<typeof fresh>): void {
  const file = join(workspacesDir(ref.projectDir, ref.source), `${ref.id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), updatedAt: 1000 }));
}

test("a new workspace and its two locks are created under .claude/koryphaios and nothing under .claude/claude-peers", () => {
  const proj = freshProject();
  const svc = workspaceService(fakeDeps(proj));
  svc.saveAuto();
  const id = svc.currentWorkspaceId!;
  for (const file of [`${id}.json`, `${id}.lock`, `${id}.lock.sqlite`]) {
    expect(existsSync(join(newFolder(proj), "workspaces", file)), file).toBe(true);
  }
  expect(existsSync(oldFolder(proj)), "the old folder is never created").toBe(false);
});

test("a restored workspace of .claude/claude-peers is saved in place with its two locks and nothing appears under .claude/koryphaios", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_old", name: "kept in place" }));
  const svc = workspaceService(fakeDeps(proj));
  expect(await svc.restore("wsp_old", "attended")).toEqual({ ok: true });
  svc.saveAuto();
  for (const file of ["wsp_old.json", "wsp_old.lock", "wsp_old.lock.sqlite"]) {
    expect(existsSync(join(oldFolder(proj), "workspaces", file)), file).toBe(true);
  }
  expect(loadWorkspace(legacy(proj, "wsp_old"))!.updatedAt, "the snapshot was rewritten where it was").toBeGreaterThan(1000);
  expect(existsSync(newFolder(proj)), "the new folder is never created for an old workspace").toBe(false);
});

test("releaseOnQuit frees the two locks of an old workspace in its own folder", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_old" }));
  const svc = workspaceService(fakeDeps(proj));
  expect(await svc.restore("wsp_old", "attended")).toEqual({ ok: true });
  expect(probeSameHostLock(legacy(proj, "wsp_old")), "held while open").toBe("held");
  svc.releaseOnQuit();
  expect(existsSync(lockPath(legacy(proj, "wsp_old"))), "the JSON lock is gone").toBe(false);
  expect(probeSameHostLock(legacy(proj, "wsp_old")), "the OS lock is given back").toBe("free");
  expect(existsSync(newFolder(proj))).toBe(false);
});

test("deleteWs removes the snapshot and both locks of an old workspace and leaves a new one alone", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_old" }));
  saveFresh(proj, sampleWorkspace({ id: "wsp_new" }));
  const svc = workspaceService(fakeDeps(proj));
  expect(await svc.restore("wsp_old", "attended")).toEqual({ ok: true });
  svc.deleteWs("wsp_old");
  for (const file of ["wsp_old.json", "wsp_old.lock", "wsp_old.lock.sqlite"]) {
    expect(existsSync(join(oldFolder(proj), "workspaces", file)), file).toBe(false);
  }
  expect(existsSync(join(newFolder(proj), "workspaces", "wsp_new.json"))).toBe(true);
  expect(svc.currentWorkspaceId).toBeNull();
});

test("deleteWorkspace removes the snapshot, the JSON lock and the OS lock file of that folder only", () => {
  const proj = freshProject();
  for (const ref of [fresh(proj, "wsp_a"), legacy(proj, "wsp_a")]) {
    ensureWorkspacesDir(ref);
    const dir = workspacesDir(proj, ref.source);
    for (const suffix of [".json", ".lock", ".lock.sqlite"]) writeFileSync(join(dir, `wsp_a${suffix}`), "x");
  }
  deleteWorkspace(legacy(proj, "wsp_a"));
  for (const suffix of [".json", ".lock", ".lock.sqlite"]) {
    expect(existsSync(join(workspacesDir(proj, "legacy"), `wsp_a${suffix}`)), `old ${suffix}`).toBe(false);
    expect(existsSync(join(workspacesDir(proj, "koryphaios"), `wsp_a${suffix}`)), `new ${suffix}`).toBe(true);
  }
});

test("pruneStale prunes old workspaces of both folders in place, keeping a pinned one and one another Deck holds", () => {
  const proj = freshProject();
  const entries: Array<[ReturnType<typeof legacy> | ReturnType<typeof fresh>, Partial<Workspace>]> = [
    [legacy(proj, "wsp_old_free"), {}],
    [legacy(proj, "wsp_old_pinned"), { pinned: true }],
    [legacy(proj, "wsp_old_held"), {}],
    [legacy(proj, "wsp_old_os_only"), {}],
    [fresh(proj, "wsp_new_free"), {}],
  ];
  for (const [ref, overrides] of entries) {
    saveWorkspace(ref, sampleWorkspace({ id: ref.id, ...overrides }));
    ageSnapshot(ref);
  }
  takeLock(legacy(proj, "wsp_old_held"), foreignOwner);
  takeLock(legacy(proj, "wsp_old_os_only"), foreignOwner);
  rmSync(lockPath(legacy(proj, "wsp_old_os_only")));
  const svc = workspaceService(fakeDeps(proj));
  expect(svc.pruneStale().sort()).toEqual(["wsp_new_free", "wsp_old_free"]);
  const remains = (dir: string, id: string) => existsSync(join(workspacesDir(proj, dir as "legacy"), `${id}.json`));
  expect(remains("legacy", "wsp_old_free")).toBe(false);
  expect(remains("koryphaios", "wsp_new_free")).toBe(false);
  expect(remains("legacy", "wsp_old_pinned")).toBe(true);
  expect(remains("legacy", "wsp_old_held")).toBe(true);
  expect(remains("legacy", "wsp_old_os_only"), "only its OS lock in the old folder says it is held").toBe(true);
});

test("listForCwd lists the workspaces of both folders and flags an old one another Deck holds", () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_old" }));
  saveFresh(proj, sampleWorkspace({ id: "wsp_new" }));
  takeLock(legacy(proj, "wsp_old"), foreignOwner);
  const list = workspaceService(fakeDeps(proj)).listForCwd();
  expect(list.map((w) => w.id).sort()).toEqual(["wsp_new", "wsp_old"]);
  expect(list.find((w) => w.id === "wsp_old")!.locked).toBe(true);
  expect(list.find((w) => w.id === "wsp_new")!.locked).toBe(false);
});

test("a workspace of either folder is restored through the same approval gate", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, shellOnlyWorkspace(proj, "wsp_old"));
  saveFresh(proj, shellOnlyWorkspace(proj, "wsp_new"));
  const asked: string[] = [];
  const svc = workspaceService(
    fakeDeps(proj, {
      confirmShellFields: async (ws) => {
        asked.push(ws.id);
        return "declined";
      },
    }),
  );
  expect(await svc.restore("wsp_old", "attended")).toEqual({ ok: false, reason: "shell-declined" });
  expect(await svc.restore("wsp_new", "attended")).toEqual({ ok: false, reason: "shell-declined" });
  expect(asked).toEqual(["wsp_old", "wsp_new"]);
});

test("ensureWorkspacesDir keeps workspaces/ in the .gitignore of the folder of its ref and never touches the other folder", () => {
  const proj = freshProject();
  ensureWorkspacesDir(freshRoot(proj));
  expect(readFileSync(join(newFolder(proj), ".gitignore"), "utf8")).toContain("workspaces/");
  expect(existsSync(oldFolder(proj)), "a new workspace never creates the old folder").toBe(false);

  const other = freshProject();
  mkdirSync(oldFolder(other), { recursive: true });
  writeFileSync(join(oldFolder(other), ".gitignore"), "*.local\n");
  ensureWorkspacesDir(legacyRoot(other));
  const body = readFileSync(join(oldFolder(other), ".gitignore"), "utf8");
  expect(body).toContain("*.local");
  expect(body).toContain("workspaces/");
  expect(existsSync(newFolder(other)), "an old workspace never creates the new folder").toBe(false);
});

test("locateWorkspace tells none, one folder and both folders apart, and refuses an id that is not a plain name", () => {
  const proj = freshProject();
  expect(locateWorkspace(proj, "wsp_x")).toEqual({ kind: "none" });
  saveWorkspace(fresh(proj, "wsp_x"), sampleWorkspace({ id: "wsp_x" }));
  expect(locateWorkspace(proj, "wsp_x")).toEqual({ kind: "one", ref: fresh(proj, "wsp_x") });
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_y" }));
  expect(locateWorkspace(proj, "wsp_y")).toEqual({ kind: "one", ref: legacy(proj, "wsp_y") });
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_x" }));
  expect(locateWorkspace(proj, "wsp_x"), "an id in both folders has no winner").toEqual({ kind: "conflict" });

  writeFileSync(join(newFolder(proj), "outside.json"), "{}");
  for (const hostile of ["../outside", "..\\outside", "a/b", "", ".", ".."]) {
    expect(locateWorkspace(proj, hostile), JSON.stringify(hostile)).toEqual({ kind: "none" });
  }
});

test("a lock lives next to the snapshot of its own folder", () => {
  const proj = freshProject();
  expect(lockPath(fresh(proj, "wsp_x"))).toBe(join(newFolder(proj), "workspaces", "wsp_x.lock"));
  expect(lockPath(legacy(proj, "wsp_x"))).toBe(join(oldFolder(proj), "workspaces", "wsp_x.lock"));
  ensureWorkspacesDir(legacyRoot(proj));
  takeLock(legacy(proj, "wsp_x"), { ...baseLiveness, pid: 4242 });
  expect(existsSync(join(oldFolder(proj), "workspaces", "wsp_x.lock.sqlite"))).toBe(true);
  expect(existsSync(newFolder(proj))).toBe(false);
});

test("a restore of an id whose snapshot moved to the other folder takes over that folder's lock and gives back the old one", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_moved" }));
  const svc = workspaceService(fakeDeps(proj));
  expect(await svc.restore("wsp_moved", "attended")).toEqual({ ok: true });
  rmSync(join(workspacesDir(proj, "legacy"), "wsp_moved.json"));
  saveFresh(proj, sampleWorkspace({ id: "wsp_moved" }));
  expect(await svc.restore("wsp_moved", "attended")).toEqual({ ok: true });
  svc.saveAuto();
  expect(locateWorkspace(proj, "wsp_moved"), "no snapshot was rewritten in the old folder").toEqual({ kind: "one", ref: fresh(proj, "wsp_moved") });
  expect(existsSync(lockPath(legacy(proj, "wsp_moved"))), "the old JSON lock is gone").toBe(false);
  expect(probeSameHostLock(legacy(proj, "wsp_moved")), "the old OS lock is given back").toBe("free");
  expect(probeSameHostLock(fresh(proj, "wsp_moved")), "the new folder's lock is ours").toBe("held");
});

test("a Deck that owns an id in one folder cannot take the copy another Deck holds in the other folder, and stops saving its own", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_both" }));
  const first = workspaceService(fakeDeps(proj));
  expect(await first.restore("wsp_both", "attended")).toEqual({ ok: true });
  const oldSnapshot = join(workspacesDir(proj, "legacy"), "wsp_both.json");
  rmSync(oldSnapshot);
  saveFresh(proj, sampleWorkspace({ id: "wsp_both" }));
  const second = workspaceService(fakeDeps(proj, { pid: 4343 }));
  expect(await second.restore("wsp_both", "attended")).toEqual({ ok: true });

  const traces: string[] = [];
  onDeckError((_scope, text) => traces.push(text));
  try {
    expect(first.saveAuto()).toBeNull();
  } finally {
    onDeckError(() => {});
  }
  expect(existsSync(oldSnapshot), "the first Deck does not recreate its snapshot").toBe(false);
  expect(locateWorkspace(proj, "wsp_both")).toEqual({ kind: "one", ref: fresh(proj, "wsp_both") });
  expect(traces.some((text) => text.includes("saving stopped")), "the refusal is traced").toBe(true);
  expect(probeSameHostLock(legacy(proj, "wsp_both")), "the first Deck keeps its own lock").toBe("held");
  expect(await first.restore("wsp_both", "attended"), "the other copy belongs to the second Deck").toEqual({ ok: false, reason: "locked" });
});

test("deleteWs removes the copy the list shows, not the owned one of the same id in the other folder", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_moved" }));
  const svc = workspaceService(fakeDeps(proj));
  expect(await svc.restore("wsp_moved", "attended")).toEqual({ ok: true });
  rmSync(join(workspacesDir(proj, "legacy"), "wsp_moved.json"));
  saveFresh(proj, sampleWorkspace({ id: "wsp_moved" }));
  svc.deleteWs("wsp_moved");
  expect(existsSync(join(workspacesDir(proj, "koryphaios"), "wsp_moved.json")), "the listed copy is deleted").toBe(false);
  expect(svc.currentWorkspaceId, "the owned workspace stays owned").toBe("wsp_moved");
  expect(probeSameHostLock(legacy(proj, "wsp_moved"))).toBe("held");
});

test("a copy appearing in the other folder after the restore stops the saves, traced once, and quit frees the right lock", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_old" }));
  const svc = workspaceService(fakeDeps(proj));
  expect(await svc.restore("wsp_old", "attended")).toEqual({ ok: true });
  const oldSnapshot = join(workspacesDir(proj, "legacy"), "wsp_old.json");
  const copy = join(workspacesDir(proj, "koryphaios"), "wsp_old.json");
  saveFresh(proj, sampleWorkspace({ id: "wsp_old" }));
  const keptOld = readFileSync(oldSnapshot, "utf8");
  const keptCopy = readFileSync(copy, "utf8");

  const traces: string[] = [];
  onDeckError((_scope, text) => traces.push(text));
  try {
    expect(svc.saveAuto()).toBeNull();
    expect(svc.saveAuto()).toBeNull();
    expect(() => svc.saveNamed("explicit")).toThrow("workspace-duplicate-id");
  } finally {
    onDeckError(() => {});
  }
  expect(traces.filter((text) => text.includes("saving stopped")), "traced once, not per save").toHaveLength(1);
  expect(readFileSync(oldSnapshot, "utf8"), "the owned snapshot is not rewritten").toBe(keptOld);
  expect(readFileSync(copy, "utf8"), "the copy is not rewritten").toBe(keptCopy);

  svc.releaseOnQuit();
  expect(existsSync(lockPath(legacy(proj, "wsp_old"))), "the lock of the owned folder is released").toBe(false);
  expect(probeSameHostLock(legacy(proj, "wsp_old"))).toBe("free");
  expect(existsSync(lockPath(fresh(proj, "wsp_old"))), "no lock appears in the other folder").toBe(false);
});

test("the saves resume once the extra copy is removed, and a later copy is traced again", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_old" }));
  const svc = workspaceService(fakeDeps(proj));
  expect(await svc.restore("wsp_old", "attended")).toEqual({ ok: true });
  const traces: string[] = [];
  onDeckError((_scope, text) => traces.push(text));
  try {
    saveFresh(proj, sampleWorkspace({ id: "wsp_old" }));
    expect(svc.saveAuto()).toBeNull();
    deleteWorkspace(fresh(proj, "wsp_old"));
    expect(svc.saveAuto(), "the extra copy is gone").not.toBeNull();
    saveFresh(proj, sampleWorkspace({ id: "wsp_old" }));
    expect(svc.saveAuto()).toBeNull();
  } finally {
    onDeckError(() => {});
  }
  expect(traces.filter((text) => text.includes("saving stopped"))).toHaveLength(2);
});

test("restore refuses an id held by both folders as 'duplicate', opens nothing and takes no lock", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_twice" }));
  saveFresh(proj, sampleWorkspace({ id: "wsp_twice" }));
  const deps = fakeDeps(proj);
  const svc = workspaceService(deps);
  expect(await svc.restore("wsp_twice", "attended")).toEqual({ ok: false, reason: "duplicate" });
  expect(deps.sessions).toEqual([fakeSession()]);
  expect(svc.currentWorkspaceId).toBeNull();
  for (const ref of [legacy(proj, "wsp_twice"), fresh(proj, "wsp_twice")]) {
    expect(existsSync(lockPath(ref)), `no lock under ${ref.source}`).toBe(false);
  }
});

test("listForCwd flags an id held by both folders as a conflict, and only that id", () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_twice" }));
  saveFresh(proj, sampleWorkspace({ id: "wsp_twice" }));
  saveFresh(proj, sampleWorkspace({ id: "wsp_fresh" }));
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_old" }));
  const rows = workspaceService(fakeDeps(proj)).listForCwd();
  const conflictById = Object.fromEntries(rows.map((row) => [row.id, row.conflict]));
  expect(conflictById, "one row per id, conflict true only for the id stored in both folders").toEqual({
    wsp_twice: true,
    wsp_fresh: false,
    wsp_old: false
  });
});

test("deleteWs of the owned workspace deletes nothing and keeps it owned once its id is held by both folders", async () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_old" }));
  const svc = workspaceService(fakeDeps(proj));
  expect(await svc.restore("wsp_old", "attended")).toEqual({ ok: true });
  saveFresh(proj, sampleWorkspace({ id: "wsp_old" }));
  svc.deleteWs("wsp_old");
  expect(existsSync(join(workspacesDir(proj, "legacy"), "wsp_old.json"))).toBe(true);
  expect(existsSync(join(workspacesDir(proj, "koryphaios"), "wsp_old.json"))).toBe(true);
  expect(svc.currentWorkspaceId).toBe("wsp_old");
});

test("an id held by both folders is listed once, unlocked, and never pruned", () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_twice" }));
  saveFresh(proj, sampleWorkspace({ id: "wsp_twice" }));
  ageSnapshot(legacy(proj, "wsp_twice"));
  ageSnapshot(fresh(proj, "wsp_twice"));
  const svc = workspaceService(fakeDeps(proj));
  const listed = svc.listForCwd().filter((w) => w.id === "wsp_twice");
  expect(listed).toHaveLength(1);
  expect(listed[0]!.locked).toBe(false);
  expect(svc.pruneStale()).toEqual([]);
  expect(existsSync(join(workspacesDir(proj, "legacy"), "wsp_twice.json"))).toBe(true);
  expect(existsSync(join(workspacesDir(proj, "koryphaios"), "wsp_twice.json"))).toBe(true);
});

test("an id whose second copy is malformed is still held by both folders and never pruned", () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_half" }));
  ageSnapshot(legacy(proj, "wsp_half"));
  ensureWorkspacesDir(freshRoot(proj));
  writeFileSync(join(workspacesDir(proj, "koryphaios"), "wsp_half.json"), "{not json");
  expect(locateWorkspace(proj, "wsp_half")).toEqual({ kind: "conflict" });
  const svc = workspaceService(fakeDeps(proj));
  expect(svc.pruneStale()).toEqual([]);
  expect(existsSync(join(workspacesDir(proj, "legacy"), "wsp_half.json")), "the only valid copy survives").toBe(true);
});

test("a dangling link under .claude/koryphaios makes its id a conflict, never a lone legacy copy", () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_link" }));
  ageSnapshot(legacy(proj, "wsp_link"));
  ensureWorkspacesDir(freshRoot(proj));
  symlinkSync(join(proj, "gone.json"), join(workspacesDir(proj, "koryphaios"), "wsp_link.json"), "file");
  expect(locateWorkspace(proj, "wsp_link")).toEqual({ kind: "conflict" });
  expect(workspaceService(fakeDeps(proj)).pruneStale()).toEqual([]);
  expect(existsSync(join(workspacesDir(proj, "legacy"), "wsp_link.json"))).toBe(true);
});

test("an id held by both folders shows unlocked whichever copy another Deck holds", () => {
  const proj = freshProject();
  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_older_held" }));
  ageSnapshot(legacy(proj, "wsp_older_held"));
  saveFresh(proj, sampleWorkspace({ id: "wsp_older_held" }));
  takeLock(legacy(proj, "wsp_older_held"), foreignOwner);

  saveInOldFolder(proj, sampleWorkspace({ id: "wsp_shown_held" }));
  saveFresh(proj, sampleWorkspace({ id: "wsp_shown_held" }));
  ageSnapshot(fresh(proj, "wsp_shown_held"));
  takeLock(legacy(proj, "wsp_shown_held"), foreignOwner);

  const list = workspaceService(fakeDeps(proj)).listForCwd();
  expect(list.find((w) => w.id === "wsp_older_held")!.locked, "the held copy is the older one").toBe(false);
  expect(list.find((w) => w.id === "wsp_shown_held")!.locked, "the held copy is the one the list shows").toBe(false);
});

type CopyChange = "appears" | "vanishes" | "moves";
const copyChanges: Record<CopyChange, { run: (proj: string, id: string) => void; result: { ok: false; reason: "duplicate" | "missing" } }> = {
  appears: { run: (proj, id) => void saveFresh(proj, sampleWorkspace({ id })), result: { ok: false, reason: "duplicate" } },
  vanishes: { run: (proj, id) => rmSync(join(workspacesDir(proj, "legacy"), `${id}.json`)), result: { ok: false, reason: "missing" } },
  moves: {
    run: (proj, id) => {
      rmSync(join(workspacesDir(proj, "legacy"), `${id}.json`));
      saveFresh(proj, sampleWorkspace({ id }));
    },
    result: { ok: false, reason: "missing" },
  },
};

type WaitPoint = "shell approval" | "cwd approval" | "mod preparation" | "scope adoption";
const waitPoints: WaitPoint[] = ["shell approval", "cwd approval", "mod preparation", "scope adoption"];

async function restoreChangedWhileWaiting(proj: string, id: string, point: WaitPoint, change: () => void) {
  const published = { state: "published" as const, scope: { projectKey: "project", groupId: fakeScope().groupId } };
  const later = { steps: 0 };
  const adopt: WorkspaceDeps["adoptScope"] = async (_ws, own) => {
    later.steps++;
    return own() ? published : { state: "lock-race" };
  };
  if (point === "shell approval" || point === "cwd approval") {
    const shell = point === "shell approval";
    saveInOldFolder(proj, shell ? sampleWorkspace({ id }) : cwdOnlyWorkspace(id));
    const gate = deferredGate();
    const asked = async (): Promise<WorkspaceApprovalGateResult> => {
      later.steps++;
      return "approved";
    };
    const deps = fakeDeps(proj, {
      ...(shell ? { confirmShellFields: async () => gate.promise, confirmUntrustedCwd: asked } : { confirmUntrustedCwd: async () => gate.promise }),
      prepareModPlans: async () => {
        later.steps++;
        return { ok: true, plans: new Map() };
      },
      adoptScope: adopt,
    });
    const svc = workspaceService(deps);
    const restoring = svc.restore(id, "attended");
    await flushMicrotasks();
    change();
    gate.resolve("approved");
    return { result: await settled(restoring), deps, svc, later };
  }
  saveInOldFolder(proj, projectSessionsWorkspace(proj, id));
  if (point === "mod preparation") {
    const rig = modRestoreRig(proj, { adoptScope: adopt });
    const restoring = rig.svc.restore(id, "attended");
    await flushMicrotasks();
    change();
    rig.pending[0]!.release();
    return { result: await settled(restoring), deps: rig.deps, svc: rig.svc, later };
  }
  const deps = fakeDeps(proj, {
    adoptScope: async (_ws, own) => {
      change();
      return own() ? published : { state: "lock-race" };
    },
  });
  const svc = workspaceService(deps);
  return { result: await settled(svc.restore(id, "attended")), deps, svc, later };
}

for (const point of waitPoints) {
  for (const [name, change] of Object.entries(copyChanges) as Array<[CopyChange, (typeof copyChanges)[CopyChange]]>) {
    test(`WorkspaceService.restore(): a stored copy that ${name} during the ${point} refuses as '${change.result.reason}' and opens nothing`, async () => {
      const proj = freshProject();
      const id = "wsp_wait";
      const { result, deps, svc, later } = await restoreChangedWhileWaiting(proj, id, point, () => change.run(proj, id));
      expect(result).toEqual(change.result);
      expect(later.steps, "no step after the wait ran for the stale copy").toBe(0);
      expect(deps.sessions, "no session was swapped").toEqual([fakeSession()]);
      expect(svc.currentWorkspaceId).toBeNull();
      expect(probeSameHostLock(legacy(proj, id)), "no lock was taken").toBe("free");
    });
  }
}

// ----- a workspace id of the wrong shape never reaches a path -----

const HOSTILE_WORKSPACE_IDS: Array<[string, string]> = [
  ["a parent step", "../x"],
  ["a backslash parent step", "..\\x"],
  ["a posix absolute path", "/tmp/x"],
  ["a drive absolute path", "C:\\x"],
  ["an empty id", ""],
  ["65 characters", "a".repeat(65)],
  ["a trailing newline", "wsp_ok\n"],
];

for (const source of ["koryphaios", "legacy"] as const) {
  for (const [what, id] of HOSTILE_WORKSPACE_IDS) {
    test(`an id with ${what} is refused with a trace by every path builder of the ${source} folder, and nothing is created`, () => {
      const proj = freshProject();
      const root = { projectDir: proj, source };
      const workspaces = ensureWorkspacesDir(root);
      const ref = { projectDir: proj, id, source };
      const traces: string[] = [];
      onDeckError((_scope, text) => traces.push(text));
      try {
        expect(() => saveWorkspace(ref, sampleWorkspace())).toThrow("refused workspace id");
        expect(() => loadWorkspace(ref)).toThrow("refused workspace id");
        expect(() => lockPath(ref)).toThrow("refused workspace id");
        expect(() => readLock(ref)).toThrow("refused workspace id");
        expect(() => acquireLock(ref, { ...baseLiveness, pid: 4242 })).toThrow("refused workspace id");
      } finally {
        onDeckError(() => {});
      }
      expect(traces.filter((text) => text.includes("refused workspace id")), "one trace per refusal").toHaveLength(5);
      expect(readdirSync(workspaces), "nothing was written beside the snapshots").toEqual([]);
      expect(readdirSync(join(workspaces, "..")).sort(), "nothing was written one level up").toEqual([".gitignore", "workspaces"]);
    });
  }
}

test("a minted id and an id of 64 characters keep their snapshot and lock files", () => {
  const proj = freshProject();
  for (const id of [newWorkspaceId(), "a".repeat(64)]) {
    saveFresh(proj, sampleWorkspace({ id }));
    expect(loadWorkspace(fresh(proj, id))!.id).toBe(id);
    expect(lockPath(fresh(proj, id))).toBe(join(newFolder(proj), "workspaces", `${id}.lock`));
    expect(locateWorkspace(proj, id)).toEqual({ kind: "one", ref: fresh(proj, id) });
  }
});

test("locateWorkspace answers none for an id of 65 characters and traces the refusal", () => {
  const proj = freshProject();
  const traces: string[] = [];
  onDeckError((_scope, text) => traces.push(text));
  try {
    expect(locateWorkspace(proj, "a".repeat(65))).toEqual({ kind: "none" });
  } finally {
    onDeckError(() => {});
  }
  expect(traces.filter((text) => text.includes("refused workspace id"))).toHaveLength(1);
});

test("saving under an id of the wrong shape creates no project folder at all", () => {
  const proj = freshProject();
  expect(() => saveWorkspace(fresh(proj, "../x"), sampleWorkspace())).toThrow("refused workspace id");
  expect(existsSync(join(proj, ".claude")), "not even the workspaces folder was made").toBe(false);
});

for (const [what, id] of HOSTILE_WORKSPACE_IDS) {
  test(`deleting an id with ${what} is refused with a trace and removes nothing beside or above the snapshots`, () => {
    const proj = freshProject();
    const workspaces = ensureWorkspacesDir(freshRoot(proj));
    const witnesses = [
      join(workspaces, "..", "x.json"),
      join(workspaces, "..", "x.lock"),
      join(workspaces, "..", "x.lock.sqlite"),
      join(workspaces, ".json"),
      join(workspaces, ".lock"),
    ];
    for (const witness of witnesses) writeFileSync(witness, "kept");
    const traces: string[] = [];
    onDeckError((_scope, text) => traces.push(text));
    try {
      expect(() => deleteWorkspace(fresh(proj, id))).toThrow("refused workspace id");
    } finally {
      onDeckError(() => {});
    }
    expect(traces.filter((text) => text.includes("refused workspace id"))).toHaveLength(1);
    for (const witness of witnesses) expect(existsSync(witness), witness).toBe(true);
  });
}

test("deleteWorkspace of a minted id still removes its snapshot and both locks", () => {
  const proj = freshProject();
  const id = newWorkspaceId();
  saveFresh(proj, sampleWorkspace({ id }));
  const dir = workspacesDir(proj, "koryphaios");
  for (const suffix of [".lock", ".lock.sqlite"]) writeFileSync(join(dir, `${id}${suffix}`), "x");
  deleteWorkspace(fresh(proj, id));
  expect(readdirSync(dir)).toEqual([]);
});

test("a snapshot file whose name is not a workspace id is skipped, traced once, and neither the list nor the prune fails", () => {
  const proj = freshProject();
  const minted = newWorkspaceId();
  saveFresh(proj, sampleWorkspace({ id: minted }));
  const odd = join(workspacesDir(proj, "koryphaios"), "my ws.v2.json");
  writeFileSync(odd, JSON.stringify(sampleWorkspace({ id: "my ws.v2", updatedAt: 1000 })));
  const svc = workspaceService(fakeDeps(proj));
  const traces: string[] = [];
  onDeckError((_scope, text) => traces.push(text));
  try {
    expect(svc.listForCwd().map((w) => w.id)).toEqual([minted]);
    expect(listWorkspaces(proj).map((w) => w.id)).toEqual([minted]);
    expect(svc.pruneStale()).toEqual([]);
    expect(svc.pruneStale()).toEqual([]);
  } finally {
    onDeckError(() => {});
  }
  expect(traces.filter((text) => text.includes("my ws.v2.json")), "one trace for the file, not one per call").toHaveLength(1);
  expect(existsSync(odd), "the file is left alone").toBe(true);
});
