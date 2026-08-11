// Card 6aa32af4 review finding: desktop/src/main/roadmap-service.ts's
// computeDeckProjectKey was a THIRD independent derivation of the same
// project_key formula server.ts's roadmapProjectKey() and
// shared/project-key.ts's resolveProjectKey() already share -- its own
// header comment ASSERTED "MUST match what server.ts computes" while
// nothing wired that guarantee. Fixed by having computeDeckProjectKey call
// resolveProjectKey() directly for the combine step (keeping the git
// shelling, which is Node-native and desktop-appropriate, local to this
// file). This file pins that wiring, not just the output value: per
// CLAUDE.md's "comment/class that asserts a guarantee must be wired to it"
// convention, a test that only reimplements the hash formula independently
// (as tests/broker-desktop-roadmap-service.test.ts already did, and still
// does) would keep passing even if computeDeckProjectKey silently reverted
// to its own inline copy with a coincidentally-matching formula -- exactly
// the shape this card exists to close. Pure module (no electron, no
// broker spawn), so unlike its broker-desktop-roadmap-service.test.ts
// sibling this belongs in the CI-collected tests/desktop-*.test.ts family
// (see tests/desktop-ci-glob-coverage.test.ts and the
// project_ci_glob_excludes_broker_test_family memory).

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
