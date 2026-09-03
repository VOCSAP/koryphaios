// Pins that computeDeckProjectKey actually calls resolveProjectKey() for its
// combine step, not just that its output matches -- a test that only
// reimplements the hash formula independently would keep passing even if the
// wiring silently reverted to an inline copy.

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { computeDeckProjectKey, normalizeRemoteUrl } from "../desktop/src/main/roadmap-service.ts";
import { resolveProjectKey } from "../shared/project-key.ts";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-deck-pk-"));
  tmpDirs.push(d);
  return d;
}

test("computeDeckProjectKey with an origin remote equals resolveProjectKey() called with the normalized remote", () => {
  const dir = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: dir });

  const normalized = normalizeRemoteUrl("git@github.com:acme/widget.git");
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf-8" }).trim();
  expect(computeDeckProjectKey(dir)).toBe(resolveProjectKey(normalized, gitRoot, dir));
});

test("computeDeckProjectKey with no remote equals resolveProjectKey() called with the live git root", () => {
  const dir = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf-8" }).trim();
  expect(computeDeckProjectKey(dir)).toBe(resolveProjectKey(null, gitRoot, dir));
});

test("computeDeckProjectKey on a non-git dir equals resolveProjectKey() called with cwd as the anchor", () => {
  const dir = tmpDir();
  expect(computeDeckProjectKey(dir)).toBe(resolveProjectKey(null, null, dir));
});

test("computeDeckProjectKey's source calls the shared resolveProjectKey() rather than reimplementing the fallback formula", () => {
  // Static-source guard against a silent revert to an inline duplicate that
  // happens to still match the current formula (the case the three runtime
  // tests above cannot distinguish from genuine wiring): grep the actual
  // producer, per CLAUDE.md's "comment cites what actually enforces it".
  const src = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "roadmap-service.ts"), "utf-8");
  const fnStart = src.indexOf("export function computeDeckProjectKey");
  expect(fnStart).toBeGreaterThan(-1);
  const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
  expect(fnBody).toContain("resolveProjectKey(");
  expect(fnBody).not.toContain("createHash");
  // Quote style / extension / import depth are cosmetic and any of the
  // three can change under an honest refactor without losing the guarantee
  // this test exists for -- match the shape (relative path into
  // shared/project-key, any depth, either quote, optional extension), not
  // one exact string.
  expect(src).toMatch(/from ['"](\.\.\/)+shared\/project-key(\.[jt]s)?['"]/);
});
