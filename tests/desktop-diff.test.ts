// PLAN C13: diff service (desktop/src/main/diff-service) on a throwaway repo.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectDiff,
  collectFileDiff,
  composeDiffReviewPrompt,
  isRepoRelative,
  parseNumstat,
  parseUntracked
} from "../desktop/src/main/diff-service.ts";

let repo: string;

async function git(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "cp-diff-"));
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@t"]);
  await git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("parseNumstat handles counts, binary markers and tabs in output", () => {
  const files = parseNumstat("3\t1\tsrc/app.ts\n-\t-\tlogo.png\n");
  expect(files).toEqual([
    { path: "src/app.ts", additions: 3, deletions: 1, untracked: false },
    { path: "logo.png", additions: null, deletions: null, untracked: false }
  ]);
  expect(parseNumstat("")).toEqual([]);
});

test("parseUntracked keeps only ?? lines", () => {
  expect(parseUntracked(" M a.txt\n?? new.txt\n?? dir/other.ts\n")).toEqual([
    "new.txt",
    "dir/other.ts"
  ]);
});

test("collectDiff sees modified + untracked files as uncommitted", async () => {
  writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
  writeFileSync(join(repo, "new.txt"), "hello\n");

  const diff = await collectDiff(repo, null);
  expect(diff.base).toBeNull();
  expect(diff.branch).toBeNull();
  const modified = diff.uncommitted.find((f) => f.path === "a.txt");
  expect(modified).toBeDefined();
  expect(modified!.additions).toBe(2); // TWO + four
  expect(modified!.deletions).toBe(1); // two
  const untracked = diff.uncommitted.find((f) => f.path === "new.txt");
  expect(untracked?.untracked).toBe(true);
  expect(diff.text).toContain("+TWO");
  expect(diff.truncated).toBe(false);
});

test("collectDiff with a base lists branch commits separately (merge-base)", async () => {
  // Clean up the previous test's working tree, then branch and commit there.
  await git(["checkout", "--", "a.txt"]);
  rmSync(join(repo, "new.txt"));
  await git(["checkout", "-b", "feature"]);
  writeFileSync(join(repo, "b.txt"), "feature work\n");
  await git(["add", "b.txt"]);
  await git(["commit", "-m", "feat: b"]);
  // Plus one uncommitted change on top.
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nuncommitted\n");

  const diff = await collectDiff(repo, "main");
  expect(diff.base).toBe("main");
  expect(diff.branch).not.toBeNull();
  expect(diff.branch!.map((f) => f.path)).toEqual(["b.txt"]);
  expect(diff.uncommitted.some((f) => f.path === "a.txt")).toBe(true);
  // Both sections are present in the raw text, branch first.
  expect(diff.text).toContain("# --- branch vs main ---");
  expect(diff.text).toContain("# --- uncommitted ---");
  expect(diff.text.indexOf("feature work")).toBeLessThan(diff.text.indexOf("+uncommitted"));
});

test("collectDiff on a clean tree returns empty sections", async () => {
  await git(["checkout", "--", "a.txt"]);
  const diff = await collectDiff(repo, "main");
  expect(diff.uncommitted.length).toBe(0);
  // The feature commit is still there.
  expect(diff.branch!.length).toBe(1);
});

// ----- PLAN GX1: per-file diff -----
// Repo state here: branch 'feature' (b.txt committed), clean working tree.

test("isRepoRelative rejects absolute, traversal and empty paths", () => {
  expect(isRepoRelative(repo, "a.txt")).toBe(true);
  expect(isRepoRelative(repo, "dir/sub.ts")).toBe(true);
  expect(isRepoRelative(repo, "../outside.txt")).toBe(false);
  expect(isRepoRelative(repo, "dir/../../outside.txt")).toBe(false);
  expect(isRepoRelative(repo, "/etc/passwd")).toBe(false);
  expect(isRepoRelative(repo, "")).toBe(false);
  expect(isRepoRelative(repo, ".")).toBe(false);
});

test("collectFileDiff shows only the asked file's uncommitted changes", async () => {
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nfile-diff\n");
  writeFileSync(join(repo, "other.txt"), "noise\n");
  await git(["add", "other.txt"]);

  const diff = await collectFileDiff(repo, "a.txt", null);
  expect(diff.path).toBe("a.txt");
  expect(diff.text).toContain("+file-diff");
  expect(diff.text).not.toContain("noise");
  expect(diff.truncated).toBe(false);

  await git(["reset", "HEAD", "other.txt"]);
  rmSync(join(repo, "other.txt"));
  await git(["checkout", "--", "a.txt"]);
});

test("collectFileDiff includes the branch section when a base is given", async () => {
  const diff = await collectFileDiff(repo, "b.txt", "main");
  expect(diff.text).toContain("# --- branch vs main ---");
  expect(diff.text).toContain("+feature work");
});

test("collectFileDiff renders an untracked file as additions (--no-index)", async () => {
  writeFileSync(join(repo, "fresh.txt"), "brand new\n");
  const diff = await collectFileDiff(repo, "fresh.txt", null);
  expect(diff.text).toContain("# --- untracked ---");
  expect(diff.text).toContain("+brand new");
  rmSync(join(repo, "fresh.txt"));
});

test("collectFileDiff refuses a path escaping the repo", async () => {
  await expect(collectFileDiff(repo, "../secret.txt", null)).rejects.toThrow(
    "not a repo-relative"
  );
});

test("composeDiffReviewPrompt targets the lead when given, tile otherwise", () => {
  const withLead = composeDiffReviewPrompt({ dir: "/wt/x", base: "main", leadPeerId: "boss-1" });
  expect(withLead).toContain("send_message to peer 'boss-1'");
  expect(withLead).toContain("git diff main...HEAD");
  expect(withLead).toContain("Do not modify, stage, commit or push anything.");

  const noLead = composeDiffReviewPrompt({ dir: "/wt/x", base: null, leadPeerId: null });
  expect(noLead).toContain("print the full review here");
  expect(noLead).not.toContain("send_message");
});
