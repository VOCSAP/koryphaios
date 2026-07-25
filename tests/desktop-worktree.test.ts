// PLAN-v0.4 C4: git worktree layer for the Deck (desktop/src/main/worktree-service).
// Runs against a throwaway git repo. Verifies create/list/remove, the
// branch-collision guard, the never-force / never-delete-branch rules, and the
// path helpers.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  worktreeDirName,
  worktreeStatus,
  isDeckWorktreePath,
  WORKTREES_DIR
} from "../desktop/src/main/worktree-service.ts";

let repo: string;

function git(args: string[], cwd: string = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "cp-wt-"));
  git(["init", "-q", "-b", "main"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
});

afterAll(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("worktreeDirName sanitizes branch names into safe dir fragments", () => {
  expect(worktreeDirName("agent/fix-login")).toBe("agent-fix-login");
  expect(worktreeDirName("  weird//name!  ")).toBe("weird-name");
  expect(worktreeDirName("///")).toBe("worktree");
});

test("createWorktree creates .worktrees/<name> on the new branch; list sees it", async () => {
  const wt = await createWorktree(repo, "agent/feature-x");
  expect(wt.branch).toBe("agent/feature-x");
  expect(wt.path.includes(WORKTREES_DIR)).toBe(true);

  const branches = git(["branch", "--list", "agent/feature-x"]);
  expect(branches).toContain("agent/feature-x");

  const all = await listWorktrees(repo);
  expect(all[0]!.main).toBe(true);
  const mine = all.find((w) => w.path === wt.path);
  expect(mine).toBeDefined();
  expect(mine!.branch).toBe("agent/feature-x");
  expect(mine!.main).toBe(false);
});

test("an existing branch (or path) is refused, surfaced as an error", async () => {
  await expect(createWorktree(repo, "agent/feature-x")).rejects.toThrow();
});

test("removeWorktree removes the dir but keeps the branch; main tree is refused", async () => {
  const wt = await createWorktree(repo, "agent/short-lived");
  await removeWorktree(repo, wt.path);

  const all = await listWorktrees(repo);
  expect(all.some((w) => w.path === wt.path)).toBe(false);
  // The branch survives the worktree removal (PLAN rule).
  expect(git(["branch", "--list", "agent/short-lived"])).toContain("agent/short-lived");

  await expect(removeWorktree(repo, repo)).rejects.toThrow(/main working tree/);
  await expect(removeWorktree(repo, "/nope")).rejects.toThrow(/not a worktree/);
});

test("a dirty worktree is refused (never --force): uncommitted work survives", async () => {
  const wt = await createWorktree(repo, "agent/dirty");
  writeFileSync(join(wt.path, "wip.txt"), "uncommitted", "utf-8");
  await expect(removeWorktree(repo, wt.path)).rejects.toThrow();
  // Still listed: nothing was lost.
  const all = await listWorktrees(repo);
  expect(all.some((w) => w.path === wt.path)).toBe(true);
});

test("paths survive a symlinked repo prefix (macOS /var, Windows 8.3)", async () => {
  // The runners' tmpdir is a symlink on macOS (/var -> /private/var) and an 8.3
  // short name on Windows, while git always reports the REAL path. Comparing
  // the two forms used to make removeWorktree answer "not a worktree of this
  // repo" for a worktree it had just created — invisible on Linux, where
  // tmpdirs are not symlinked, so reproduce the condition explicitly here.
  const outer = mkdtempSync(join(tmpdir(), "cp-wt-link-"));
  const real = join(outer, "real-repo");
  const link = join(outer, "via-link");
  execFileSync("git", ["init", "-q", "-b", "main", real]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit",
    "--allow-empty", "-m", "init"], { cwd: real });
  // 'junction' is the dir-symlink flavour Windows allows without privileges;
  // the type argument is ignored on POSIX.
  symlinkSync(real, link, "junction");
  expect(link).not.toBe(realpathSync(link));

  try {
    // Everything is driven through the SYMLINKED path, as a user's projectDir
    // would be.
    const wt = await createWorktree(link, "agent/via-link");
    const all = await listWorktrees(link);
    expect(all.some((w) => w.path === wt.path)).toBe(true);
    // The round-trip that used to fail: remove it by the path we were handed.
    await removeWorktree(link, wt.path);
    expect((await listWorktrees(link)).some((w) => w.path === wt.path)).toBe(false);
    // The main tree is still recognised as such through the symlink.
    await expect(removeWorktree(link, link)).rejects.toThrow(/main working tree/);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("worktreeStatus reports dirty count and last commit (PLAN C6)", async () => {
  const wt = await createWorktree(repo, "agent/status-check");
  const clean = await worktreeStatus(wt.path);
  expect(clean.dirty).toBe(0);
  expect(clean.lastCommit).toContain("init");

  writeFileSync(join(wt.path, "a.txt"), "x", "utf-8");
  writeFileSync(join(wt.path, "b.txt"), "y", "utf-8");
  const dirty = await worktreeStatus(wt.path);
  expect(dirty.dirty).toBe(2);

  const missing = await worktreeStatus(join(repo, "nope"));
  expect(missing.dirty).toBe(0);
  expect(missing.lastCommit).toBeNull();
});

test("isDeckWorktreePath flags only paths under a .worktrees dir", () => {
  expect(isDeckWorktreePath(join(repo, WORKTREES_DIR, "agent-x"))).toBe(true);
  expect(isDeckWorktreePath(repo)).toBe(false);
});
