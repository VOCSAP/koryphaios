// PLAN C16: git checkpoints (desktop/src/main/checkpoint-service) on a
// throwaway repo. A checkpoint must never touch the working tree, the index
// or the stash list — only a dangling commit + a refs/claude-peers/ ref.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_REF_PREFIX,
  createCheckpoint,
  listCheckpoints,
  purgeCheckpoints,
  restoreCommand
} from "../desktop/src/main/checkpoint-service.ts";

let repo: string;

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
  return out;
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "cp-ckpt-"));
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@t"]);
  await git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("clean tree -> no checkpoint", async () => {
  expect(await createCheckpoint(repo)).toBeNull();
  expect(await listCheckpoints(repo)).toEqual([]);
});

test("dirty tree -> anchored stash commit; working tree and stash list untouched", async () => {
  writeFileSync(join(repo, "a.txt"), "modified\n");
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  const cp = await createCheckpoint(repo, () => now);
  expect(cp).not.toBeNull();
  expect(cp!.ref).toBe(`${CHECKPOINT_REF_PREFIX}${Math.floor(now / 1000)}`);
  expect(cp!.sha).toMatch(/^[0-9a-f]{40}$/);

  // Working tree untouched (still dirty with the same content).
  expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("modified\n");
  expect((await git(["status", "--porcelain"])).trim()).not.toBe("");
  // No stash entry was pushed.
  expect((await git(["stash", "list"])).trim()).toBe("");
  // The ref anchors the snapshot and the snapshot holds the change.
  const listed = await listCheckpoints(repo);
  expect(listed.length).toBe(1);
  expect(listed[0]!.sha).toBe(cp!.sha);
  const show = await git(["show", `${cp!.sha}:a.txt`]);
  expect(show).toBe("modified\n");
  expect(restoreCommand(cp!)).toBe(`git stash apply ${cp!.sha}`);
});

test("untracked-only tree -> no checkpoint (stash create cannot capture it)", async () => {
  await git(["checkout", "--", "a.txt"]);
  writeFileSync(join(repo, "brand-new.txt"), "untracked\n");
  expect(await createCheckpoint(repo)).toBeNull();
  rmSync(join(repo, "brand-new.txt"));
});

test("purge removes checkpoints older than the TTL and keeps the rest", async () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 5, 20);
  // Old + fresh checkpoints (distinct ref names via distinct timestamps).
  writeFileSync(join(repo, "a.txt"), "old change\n");
  const oldCp = await createCheckpoint(repo, () => now - 10 * day);
  writeFileSync(join(repo, "a.txt"), "fresh change\n");
  const freshCp = await createCheckpoint(repo, () => now - 1 * day);
  expect(oldCp && freshCp).toBeTruthy();
  expect((await listCheckpoints(repo)).length).toBe(3) // + the one from the earlier test

  const purged = await purgeCheckpoints(repo, 7, () => now);
  // The earlier test's checkpoint (June 1st) is also past the cutoff.
  expect(purged).toBe(2);
  const left = await listCheckpoints(repo);
  expect(left.length).toBe(1);
  expect(left[0]!.sha).toBe(freshCp!.sha);
  await git(["checkout", "--", "a.txt"]);
});
