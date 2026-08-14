// Card 6e3863ef: mount-mode sub-policy (nested :ro binds closing the
// git-hooks/mcp-config host-execution evasion) — desktop/src/main/sandbox-protect.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isGitInternalRel,
  planProtectedBinds,
  PROTECTED_PATHS,
  renderProtectionNotice
} from "../desktop/src/main/sandbox-protect.ts";
import type { ProtectedKind, ProtectionPlan } from "../desktop/src/main/sandbox-protect.ts";
import { SANDBOX_WORK_DIR } from "../desktop/src/main/sandbox-command.ts";

// The full domain the criterion (A5) currently covers. A test asserts this
// SET, not just individual members, so shrinking the list (M-e) fails a
// coverage test rather than only a sensitivity test (CLAUDE.md "coverage"
// convention). Kept INDEPENDENT of PROTECTED_PATHS on purpose: deriving it
// FROM that list would make add/remove move both sides together and catch
// nothing (same reasoning as GROUND_TRUTH_KIND below).
const ALL_PROTECTED_RELS = [
  ".git/hooks",
  ".claude/agents",
  ".claude/commands",
  ".vscode",
  ".idea",
  ".mcp.json",
  ".claude/settings.json",
  ".git/config",
  ".gitmodules"
];

// What each protected path REALLY is on disk, independent of whatever
// PROTECTED_PATHS currently declares as its `kind`. Used to build the
// coverage fixture below FROM the production list's rels while keeping the
// on-disk shape as ground truth -- so a wrong `kind` in PROTECTED_PATHS
// (e.g. '.claude/settings.json' mislabelled 'dir') produces a fixture that
// disagrees with the plan's declared kind for that entry, and the assertion
// on `applied[...].kind === GROUND_TRUTH_KIND[rel]` catches it. Reclassify
// '.claude/settings.json' to 'dir' in the source and revert to prove this.
const GROUND_TRUTH_KIND: Record<string, ProtectedKind> = {
  ".git/hooks": "dir",
  ".claude/agents": "dir",
  ".claude/commands": "dir",
  ".vscode": "dir",
  ".idea": "dir",
  ".mcp.json": "file",
  ".claude/settings.json": "file",
  ".git/config": "file",
  ".gitmodules": "file"
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-sandbox-protect-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("copy mode: not-applicable, zero binds regardless of what exists on disk", () => {
  // Every protected path present on disk — copy mode must still yield zero.
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(join(dir, ".mcp.json"), "{}");

  const plan = planProtectedBinds({ workSource: dir, mode: "copy" });
  expect(plan.status).toBe("not-applicable");
  expect(plan.applied).toHaveLength(0);
  expect(plan.skipped).toHaveLength(0);
});

test(".git is a FILE (submodule/worktree form): hooks and config both skipped as git-not-a-directory", () => {
  writeFileSync(join(dir, ".git"), "gitdir: ../.git/worktrees/x\n");

  const plan = planProtectedBinds({ workSource: dir, mode: "mount" });
  expect(plan.status).toBe("applied");
  if (plan.status !== "applied") throw new Error("unreachable");
  const hooks = plan.skipped.find((s) => s.rel === ".git/hooks");
  const config = plan.skipped.find((s) => s.rel === ".git/config");
  expect(hooks?.reason).toBe("git-not-a-directory");
  expect(config?.reason).toBe("git-not-a-directory");
  expect(plan.applied.some((b) => b.rel === ".git/hooks" || b.rel === ".git/config")).toBe(false);
});

test(".git absent entirely also skips hooks and config as git-not-a-directory", () => {
  const plan = planProtectedBinds({ workSource: dir, mode: "mount" });
  expect(plan.status).toBe("applied");
  if (plan.status !== "applied") throw new Error("unreachable");
  expect(plan.skipped.filter((s) => s.reason === "git-not-a-directory")).toHaveLength(2);
});

test("protected FILE absent from workSource: skipped file-absent, never emitted as a bind", () => {
  mkdirSync(join(dir, ".git"), { recursive: true }); // real .git dir, so only file-absence is under test
  const plan = planProtectedBinds({ workSource: dir, mode: "mount" });
  expect(plan.status).toBe("applied");
  if (plan.status !== "applied") throw new Error("unreachable");
  const mcp = plan.skipped.find((s) => s.rel === ".mcp.json");
  expect(mcp?.reason).toBe("file-absent");
  expect(plan.applied.some((b) => b.rel === ".mcp.json")).toBe(false);
});

test("protected FILE present as a file: applied with the expected container path", () => {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".mcp.json"), "{}");
  const plan = planProtectedBinds({ workSource: dir, mode: "mount" });
  expect(plan.status).toBe("applied");
  if (plan.status !== "applied") throw new Error("unreachable");
  const mcp = plan.applied.find((b) => b.rel === ".mcp.json");
  expect(mcp).toBeDefined();
  expect(mcp?.kind).toBe("file");
  expect(mcp?.containerPath).toBe(`${SANDBOX_WORK_DIR}/.mcp.json`);
});

test("protected DIRECTORY absent from workSource: bind still applied (anti fail-open)", () => {
  mkdirSync(join(dir, ".git"), { recursive: true });
  // .claude/agents deliberately NOT created.
  const plan = planProtectedBinds({ workSource: dir, mode: "mount" });
  expect(plan.status).toBe("applied");
  if (plan.status !== "applied") throw new Error("unreachable");
  const agents = plan.applied.find((b) => b.rel === ".claude/agents");
  expect(agents).toBeDefined();
  expect(agents?.kind).toBe("dir");
  expect(agents?.containerPath).toBe(`${SANDBOX_WORK_DIR}/.claude/agents`);
});

test("coverage: the full protected-path list is present across applied+skipped", () => {
  // Real .git dir, and every protected file present -> everything lands in
  // applied, so this is a direct coverage assertion on the list itself.
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".mcp.json"), "{}");
  writeFileSync(join(dir, ".claude", "settings.json"), "{}");
  writeFileSync(join(dir, ".git", "config"), "");
  writeFileSync(join(dir, ".gitmodules"), "");

  const plan = planProtectedBinds({ workSource: dir, mode: "mount" });
  expect(plan.status).toBe("applied");
  if (plan.status !== "applied") throw new Error("unreachable");
  const seen = [...plan.applied.map((b) => b.rel), ...plan.skipped.map((s) => s.rel)].sort();
  expect(seen).toEqual([...ALL_PROTECTED_RELS].sort());
  expect(plan.applied).toHaveLength(ALL_PROTECTED_RELS.length);
});

test("coverage: fixture built FROM PROTECTED_PATHS by GROUND-TRUTH kind -- a wrong `kind` in the source disagrees with reality", () => {
  // Every rel PROTECTED_PATHS currently declares must have a ground-truth
  // classification here, or this test itself is the one that's stale.
  for (const { rel } of PROTECTED_PATHS) {
    expect(GROUND_TRUTH_KIND[rel]).toBeDefined();
  }

  mkdirSync(join(dir, ".git"), { recursive: true }); // real .git dir for the two .git/* entries
  for (const [rel, kind] of Object.entries(GROUND_TRUTH_KIND)) {
    const segments = rel.split("/");
    if (kind === "dir") {
      mkdirSync(join(dir, ...segments), { recursive: true });
    } else {
      mkdirSync(join(dir, ...segments.slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...segments), "");
    }
  }

  const plan = planProtectedBinds({ workSource: dir, mode: "mount" });
  expect(plan.status).toBe("applied");
  if (plan.status !== "applied") throw new Error("unreachable");
  for (const { rel } of PROTECTED_PATHS) {
    const bind = plan.applied.find((b) => b.rel === rel);
    expect(bind).toBeDefined();
    // The plan's declared kind for this entry must match what it actually
    // is on disk (ground truth), not just be internally consistent with
    // itself -- this is what a `kind:'dir'` mislabel on a real file fails.
    expect(bind?.kind).toBe(GROUND_TRUTH_KIND[rel]);
  }
});

test("isGitInternalRel: structural, not enumerated -- a FICTITIOUS path nested under .git is also caught", () => {
  // The real list only holds .git/hooks and .git/config today, but the
  // guard must not be keyed on those two literals: a future entry added
  // under .git/ (e.g. .git/info/exclude) has to inherit the guard for
  // free. Test the mechanism, not today's membership.
  expect(isGitInternalRel(".git/info/exclude")).toBe(true);
  expect(isGitInternalRel(".git/hooks")).toBe(true);
  expect(isGitInternalRel(".git/config")).toBe(true);
  expect(isGitInternalRel(".git")).toBe(true);
  // Must not over-match: .gitignore starts with '.git' but is not nested
  // under a .git directory.
  expect(isGitInternalRel(".gitignore")).toBe(false);
  expect(isGitInternalRel(".claude/agents")).toBe(false);
});

test(".git as a file: a hypothetical entry sharing the .git/ prefix is skipped alongside hooks/config", () => {
  writeFileSync(join(dir, ".git"), "gitdir: ../.git/worktrees/x\n");
  const plan = planProtectedBinds({ workSource: dir, mode: "mount" });
  expect(plan.status).toBe("applied");
  if (plan.status !== "applied") throw new Error("unreachable");
  // Every actual .git-nested entry in the real list must be skipped, and
  // the mechanism (isGitInternalRel) that decides this is proven generic
  // by the test above -- not just correct for these two literal paths.
  for (const rel of [".git/hooks", ".git/config"]) {
    expect(isGitInternalRel(rel)).toBe(true);
    expect(plan.skipped.some((s) => s.rel === rel && s.reason === "git-not-a-directory")).toBe(true);
  }
});

test("planProtectedBinds refuses an empty workSource (fail-closed, never a plausible wrong-tree plan)", () => {
  expect(() => planProtectedBinds({ workSource: "", mode: "mount" })).toThrow();
});

test("planProtectedBinds refuses a relative workSource", () => {
  expect(() => planProtectedBinds({ workSource: "relative/path", mode: "mount" })).toThrow();
  expect(() => planProtectedBinds({ workSource: ".", mode: "mount" })).toThrow();
});

test("planProtectedBinds accepts an absolute workSource (sanity: the guard above isn't rejecting everything)", () => {
  expect(() => planProtectedBinds({ workSource: dir, mode: "mount" })).not.toThrow();
});

test("renderProtectionNotice names the git push -u / git remote add consequence when .git/config is protected", () => {
  const plan: ProtectionPlan = {
    status: "applied",
    applied: [bind(".git/config", `${SANDBOX_WORK_DIR}/.git/config`)],
    skipped: []
  };
  const notice = renderProtectionNotice(plan);
  expect(notice).toContain("git push -u");
  expect(notice).toContain("git remote add");
});

test("renderProtectionNotice omits the git push -u sentence when .git/config is not protected (e.g. worktree)", () => {
  const plan: ProtectionPlan = {
    status: "applied",
    applied: [bind(".claude/agents", `${SANDBOX_WORK_DIR}/.claude/agents`)],
    skipped: [{ rel: ".git/config", kind: "file", reason: "git-not-a-directory" }]
  };
  const notice = renderProtectionNotice(plan);
  expect(notice).not.toContain("git push -u");
});

function bind(rel: string, containerPath: string) {
  return { rel, kind: "dir" as const, hostPath: `/h/${rel}`, containerPath };
}

test("renderProtectionNotice: not-applicable plan renders an empty string", () => {
  const plan: ProtectionPlan = { status: "not-applicable", reason: "copy-mode", applied: [], skipped: [] };
  expect(renderProtectionNotice(plan)).toBe("");
});

test("renderProtectionNotice: 'applied' status with an EMPTY applied list also renders empty (not a not-applicable leak)", () => {
  // Distinct from the not-applicable case above: status IS 'applied' here,
  // just with nothing bound (e.g. every entry skipped). Rendering a notice
  // anyway would leak a bit to the agent (plan is non-empty vs empty) and
  // blur the A10 not-applicable/applied-with-zero-binds distinction.
  const plan: ProtectionPlan = {
    status: "applied",
    applied: [],
    skipped: [{ rel: ".mcp.json", kind: "file", reason: "file-absent" }]
  };
  expect(renderProtectionNotice(plan)).toBe("");
});

test("renderProtectionNotice: applied plan lists container paths, never skipped ones (A2)", () => {
  const plan: ProtectionPlan = {
    status: "applied",
    applied: [bind(".git/hooks", `${SANDBOX_WORK_DIR}/.git/hooks`)],
    skipped: [{ rel: ".mcp.json", kind: "file", reason: "file-absent" }]
  };
  const notice = renderProtectionNotice(plan);
  expect(notice).toContain(`${SANDBOX_WORK_DIR}/.git/hooks`);
  // A2: skipped paths (and the fact that anything was skipped at all) must
  // never appear -- that's a map of the remaining write surface for a
  // compromised agent, not something it needs for legitimate work.
  expect(notice).not.toContain(".mcp.json");
  expect(notice.toLowerCase()).not.toContain("skip");
});

test("renderProtectionNotice: M-g anti-drift -- adding a path to the plan changes the rendered notice", () => {
  const planN: ProtectionPlan = {
    status: "applied",
    applied: [bind(".git/hooks", `${SANDBOX_WORK_DIR}/.git/hooks`)],
    skipped: []
  };
  const planNPlus1: ProtectionPlan = {
    status: "applied",
    applied: [
      bind(".git/hooks", `${SANDBOX_WORK_DIR}/.git/hooks`),
      bind(".claude/agents", `${SANDBOX_WORK_DIR}/.claude/agents`)
    ],
    skipped: []
  };
  const noticeN = renderProtectionNotice(planN);
  const noticeNPlus1 = renderProtectionNotice(planNPlus1);
  expect(noticeNPlus1).not.toBe(noticeN);
  expect(noticeNPlus1).toContain(`${SANDBOX_WORK_DIR}/.claude/agents`);
});
