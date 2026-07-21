// PLAN GX4: explorer service (desktop/src/main/explorer-service) on a
// throwaway tree — containment (traversal + symlink), listing, binary/cap.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPLORER_READ_MAX,
  listExplorerDir,
  readExplorerFile,
  resolveWithin
} from "../desktop/src/main/explorer-service.ts";

let base: string;
let root: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "cp-explorer-"));
  root = join(base, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "README.md"), "# hello\n");
  writeFileSync(join(root, "src", "app.ts"), "export const x = 1\n");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0x50, 0x00, 0x4b, 0x03]));
  writeFileSync(join(base, "secret.txt"), "outside\n");
  try {
    symlinkSync(join(base, "secret.txt"), join(root, "leak.txt"));
  } catch {
    // Platforms without symlink perms skip the symlink assertions below.
  }
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

test("listExplorerDir lists dirs first, hides .git", async () => {
  const entries = await listExplorerDir(root, "");
  const names = entries.map((e) => e.name);
  expect(names).not.toContain(".git");
  expect(entries[0]).toMatchObject({ name: "src", dir: true });
  expect(names).toContain("README.md");
  const readme = entries.find((e) => e.name === "README.md")!;
  expect(readme.dir).toBe(false);
  expect(readme.size).toBeGreaterThan(0);
});

test("listExplorerDir descends into subdirectories via rel", async () => {
  const entries = await listExplorerDir(root, "src");
  expect(entries.map((e) => e.name)).toEqual(["app.ts"]);
});

test("resolveWithin rejects traversal and absolute escapes", async () => {
  await expect(resolveWithin(root, "../secret.txt")).rejects.toThrow("escapes");
  await expect(resolveWithin(root, "src/../../secret.txt")).rejects.toThrow("escapes");
  await expect(resolveWithin(root, join(base, "secret.txt"))).rejects.toThrow("escapes");
  await expect(resolveWithin(root, "bad\0name")).rejects.toThrow("invalid");
});

test("resolveWithin rejects a symlink pointing outside the root", async () => {
  // Skip silently when the platform refused the symlink in beforeAll.
  const entries = await listExplorerDir(root, "");
  if (!entries.some((e) => e.name === "leak.txt")) return;
  await expect(resolveWithin(root, "leak.txt")).rejects.toThrow("symlink");
  await expect(readExplorerFile(root, "leak.txt")).rejects.toThrow("symlink");
});

test("readExplorerFile returns text content with size", async () => {
  const f = await readExplorerFile(root, "README.md");
  expect(f.content).toBe("# hello\n");
  expect(f.binary).toBe(false);
  expect(f.truncated).toBe(false);
  expect(f.size).toBe(8);
});

test("readExplorerFile flags binary files and ships no content", async () => {
  const f = await readExplorerFile(root, "binary.bin");
  expect(f.binary).toBe(true);
  expect(f.content).toBe("");
  expect(f.size).toBe(4);
});

test("readExplorerFile caps huge files and flags truncation", async () => {
  writeFileSync(join(root, "big.txt"), "x".repeat(EXPLORER_READ_MAX + 100));
  const f = await readExplorerFile(root, "big.txt");
  expect(f.truncated).toBe(true);
  expect(f.content.length).toBe(EXPLORER_READ_MAX);
  expect(f.size).toBe(EXPLORER_READ_MAX + 100);
});

test("readExplorerFile refuses directories", async () => {
  await expect(readExplorerFile(root, "src")).rejects.toThrow("not a file");
});
