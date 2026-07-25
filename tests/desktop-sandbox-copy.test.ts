// PLAN-SANDBOX M3: ephemeral-copy selection (glob matching + the hard deny
// list that always wins) — desktop/src/main/sandbox-copy.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globToRegExp,
  isDeniedCopyPath,
  planIgnoredCopy,
  selectCopyPaths,
  walkProjectFiles,
} from "../desktop/src/main/sandbox-copy.ts";

test("globToRegExp: * stays inside a segment, ** crosses", () => {
  expect(globToRegExp("PLAN-*.md").test("PLAN-A.md")).toBe(true);
  expect(globToRegExp("PLAN-*.md").test("docs/PLAN-A.md")).toBe(false);
  expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
  expect(globToRegExp("docs/**/x.md").test("docs/x.md")).toBe(true);
  expect(globToRegExp("docs/**/x.md").test("docs/a/b/x.md")).toBe(true);
  expect(globToRegExp("note?.txt").test("note1.txt")).toBe(true);
  expect(globToRegExp("note?.txt").test("note12.txt")).toBe(false);
  // Regex metacharacters in a glob are literals, not operators.
  expect(globToRegExp("a+b.md").test("a+b.md")).toBe(true);
  expect(globToRegExp("a+b.md").test("aab.md")).toBe(false);
});

test("deny list covers secrets, keys and dependency bulk", () => {
  for (const p of [
    ".env",
    ".env.local",
    "sub/.env.production",
    "node_modules/x/index.js",
    ".git/config",
    ".ssh/id_rsa",
    "certs/server.pem",
    "app.key",
    ".aws/credentials",
    "id_ed25519",
  ]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
  for (const p of ["PLAN-SANDBOX.md", "docs/notes.md", "environment.md", "keys.md"]) {
    expect(isDeniedCopyPath(p)).toBe(false);
  }
});

test("selectCopyPaths: bare filename patterns match at any depth", () => {
  const all = ["PLAN-A.md", "docs/PLAN-B.md", "src/index.ts"];
  expect(selectCopyPaths(all, ["PLAN-*.md"])).toEqual(["PLAN-A.md", "docs/PLAN-B.md"]);
  // A pattern WITH a separator is anchored and does not gain the **/ variant.
  expect(selectCopyPaths(all, ["docs/PLAN-*.md"])).toEqual(["docs/PLAN-B.md"]);
});

test("selectCopyPaths: the deny list beats an explicit allow glob", () => {
  const all = [".env", ".env.local", "notes.md", "node_modules/pkg/a.js"];
  // The operator asks for EVERYTHING; secrets and bulk still stay behind.
  expect(selectCopyPaths(all, ["**"])).toEqual(["notes.md"]);
  expect(selectCopyPaths(all, [".env"])).toEqual([]);
});

test("selectCopyPaths: no globs copies nothing", () => {
  expect(selectCopyPaths(["a.md"], [])).toEqual([]);
  expect(selectCopyPaths(["a.md"], ["  "])).toEqual([]);
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-sandbox-copy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("walkProjectFiles skips heavy dirs and returns posix-relative paths", () => {
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "PLAN-A.md"), "x");
  writeFileSync(join(dir, "docs", "note.md"), "x");
  writeFileSync(join(dir, "node_modules", "pkg", "a.js"), "x");
  writeFileSync(join(dir, ".git", "config"), "x");

  const files = walkProjectFiles(dir).sort();
  expect(files).toEqual(["PLAN-A.md", "docs/note.md"]);
});

test("planIgnoredCopy reports patterns that matched nothing", () => {
  writeFileSync(join(dir, "PLAN-A.md"), "x");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  const plan = planIgnoredCopy(dir, ["PLAN-*.md", "missing-*.txt", ".env"]);
  expect(plan.files).toEqual(["PLAN-A.md"]);
  // `.env` matched a real file but is denied -> reported as unmatched, so the
  // operator sees it never travels instead of assuming it did.
  expect(plan.unmatched.sort()).toEqual([".env", "missing-*.txt"]);
});
