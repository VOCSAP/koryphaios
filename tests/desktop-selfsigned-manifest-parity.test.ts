// A declared-range comparison alone isn't sufficient: two identical caret
// ranges can resolve to different concrete versions once their independent
// lockfiles regenerate at different times.
// The resolved-version tests read both lockfiles directly to close that gap.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const ROOT_PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");
const DESKTOP_PACKAGE_JSON_PATH = join(REPO_ROOT, "desktop", "package.json");
const BUN_LOCK_PATH = join(REPO_ROOT, "bun.lock");
const DESKTOP_PACKAGE_LOCK_PATH = join(REPO_ROOT, "desktop", "package-lock.json");

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf-8")) as PackageManifest;
}

/** 'selfsigned' lives in devDependencies at the root (test-only) and in
 * dependencies in desktop/ (shipped, production use) -- checking both
 * sections is the point, not a shortcut. */
function selfsignedRange(manifest: PackageManifest): string | undefined {
  return manifest.dependencies?.selfsigned ?? manifest.devDependencies?.selfsigned;
}

const REAL_ROOT_MANIFEST = readManifest(ROOT_PACKAGE_JSON_PATH);
const REAL_DESKTOP_MANIFEST = readManifest(DESKTOP_PACKAGE_JSON_PATH);

test("selfsigned is declared in both the root and desktop manifests (not silently missing from either)", () => {
  expect(selfsignedRange(REAL_ROOT_MANIFEST)).toBeDefined();
  expect(selfsignedRange(REAL_DESKTOP_MANIFEST)).toBeDefined();
});

test("root and desktop declare byte-identical version ranges for selfsigned", () => {
  expect(selfsignedRange(REAL_ROOT_MANIFEST)).toBe(selfsignedRange(REAL_DESKTOP_MANIFEST));
});

test("the shared range matches the exact value measured 2026-08-31 (^5.5.0) -- pins the assertion to a concrete value, not just cross-manifest equality", () => {
  expect(selfsignedRange(REAL_ROOT_MANIFEST)).toBe("^5.5.0");
});

test("mutation proof, RED-FIRST: a synthetic root manifest with a diverging selfsigned range is caught", () => {
  const mutatedRoot: PackageManifest = {
    devDependencies: { ...REAL_ROOT_MANIFEST.devDependencies, selfsigned: "^5.4.0" }
  };
  expect(selfsignedRange(mutatedRoot)).not.toBe(selfsignedRange(REAL_DESKTOP_MANIFEST));
});

// ----- Resolved versions (review round, point [C]): the range comparison
// above cannot catch two identical ranges resolving to two different
// concrete versions across two independent lockfiles -- this is the actual
// failure mode this file's header describes.

/** bun.lock's own format (not JSON-Lines, but close enough for a targeted
 * regex): `"selfsigned": ["selfsigned@5.5.0", "", {...}, "sha512-..."]`. */
function resolvedVersionFromBunLock(bunLockText: string): string | undefined {
  const m = bunLockText.match(/"selfsigned":\s*\["selfsigned@([^"]+)"/);
  return m?.[1];
}

interface NpmLockfileV3 {
  packages?: Record<string, { version?: string }>;
}

/** npm lockfileVersion 3: a flat `packages` map keyed by node_modules path,
 * each entry carrying its own resolved `version` field. */
function resolvedVersionFromNpmLock(npmLockText: string): string | undefined {
  const parsed = JSON.parse(npmLockText) as NpmLockfileV3;
  return parsed.packages?.["node_modules/selfsigned"]?.version;
}

/** The actual property under test: both lockfiles must not merely BOTH
 * carry an entry, they must resolve to the EXACT SAME version string. */
function resolvedVersionsDiverge(bunLockText: string, npmLockText: string): boolean {
  const bunVersion = resolvedVersionFromBunLock(bunLockText);
  const npmVersion = resolvedVersionFromNpmLock(npmLockText);
  return bunVersion === undefined || npmVersion === undefined || bunVersion !== npmVersion;
}

const REAL_BUN_LOCK_TEXT = readFileSync(BUN_LOCK_PATH, "utf-8");
const REAL_DESKTOP_LOCK_TEXT = readFileSync(DESKTOP_PACKAGE_LOCK_PATH, "utf-8");

test("selfsigned is present with a resolved version in both lockfiles (not silently missing from either)", () => {
  expect(resolvedVersionFromBunLock(REAL_BUN_LOCK_TEXT)).toBeDefined();
  expect(resolvedVersionFromNpmLock(REAL_DESKTOP_LOCK_TEXT)).toBeDefined();
});

test("selfsigned resolves to the SAME concrete version in bun.lock and desktop/package-lock.json (the property the range comparison above cannot see)", () => {
  expect(resolvedVersionsDiverge(REAL_BUN_LOCK_TEXT, REAL_DESKTOP_LOCK_TEXT)).toBe(false);
});

test("the resolved version matches the exact value measured 2026-08-31 (5.5.0) in both lockfiles", () => {
  expect(resolvedVersionFromBunLock(REAL_BUN_LOCK_TEXT)).toBe("5.5.0");
  expect(resolvedVersionFromNpmLock(REAL_DESKTOP_LOCK_TEXT)).toBe("5.5.0");
});

// Real red-first proof (not just "the helper discriminates" as the range
// tests above do, sharing selfsignedRange): calls the SAME
// resolvedVersionsDiverge() the real assertion uses, against a bun.lock
// mutated to a DIFFERENT resolved version while desktop/package-lock.json
// (and both manifests' declared ranges) stay untouched -- the scenario the
// range-only comparison is structurally blind to.
test("mutation proof, RED-FIRST: a synthetic bun.lock resolving to a different version is caught even though desktop/package-lock.json (and both ranges) are untouched", () => {
  const mutatedBunLockText = REAL_BUN_LOCK_TEXT.replace('"selfsigned@5.5.0"', '"selfsigned@5.6.0"');
  expect(mutatedBunLockText).not.toBe(REAL_BUN_LOCK_TEXT); // sanity: the mutation actually landed
  expect(resolvedVersionFromBunLock(mutatedBunLockText)).toBe("5.6.0");
  expect(resolvedVersionsDiverge(mutatedBunLockText, REAL_DESKTOP_LOCK_TEXT)).toBe(true);
});
