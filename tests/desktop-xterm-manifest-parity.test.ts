// CI's pure-modules test step runs before desktop deps install, so a file
// importing TerminalTile.tsx (which pulls in @xterm/xterm, @xterm/addon-fit,
// @xterm/addon-web-links) fails to resolve those packages unless they are also
// listed in the root package.json's devDependencies at identical version
// ranges.
// This guard goes red if the two manifests' ranges ever diverge, since two
// node_modules roots with different versions of the same package resolved
// differently by invocation cwd is a worse, silent failure mode. Scoped to
// exactly the three packages TerminalTile.tsx imports, not every @xterm/* key.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const ROOT_PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");
const DESKTOP_PACKAGE_JSON_PATH = join(REPO_ROOT, "desktop", "package.json");

// The exact set TerminalTile.tsx imports (verified against its own import
// lines) -- NOT every key desktop/package.json happens to prefix with
// "@xterm/". See header note on @xterm/addon-webgl.
const SHARED_XTERM_PACKAGES = ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-web-links"] as const;

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf-8")) as PackageManifest;
}

/**
 * Version range a package name resolves to in a manifest's devDependencies
 * (where all three shared xterm packages live in both manifests today), or
 * undefined if the key is missing entirely -- a missing key must NOT compare
 * equal to another missing key (both undefined), so callers assert presence
 * separately from equality.
 */
function devRange(manifest: PackageManifest, name: string): string | undefined {
  return manifest.devDependencies?.[name];
}

/**
 * The actual comparison this guard exists to run: every shared package name
 * present in BOTH manifests with the SAME exact range string. Returns the
 * list of package names that diverge (present in both, but with different
 * range strings) so a failing assertion can report which ones, rather than a
 * single opaque boolean.
 */
function divergentRanges(a: PackageManifest, b: PackageManifest, names: readonly string[]): string[] {
  return names.filter((name) => {
    const rangeA = devRange(a, name);
    const rangeB = devRange(b, name);
    return rangeA !== rangeB;
  });
}

const REAL_ROOT_MANIFEST = readManifest(ROOT_PACKAGE_JSON_PATH);
const REAL_DESKTOP_MANIFEST = readManifest(DESKTOP_PACKAGE_JSON_PATH);

test("every shared xterm-family package is present in the root manifest's devDependencies (not silently missing)", () => {
  for (const name of SHARED_XTERM_PACKAGES) {
    expect(devRange(REAL_ROOT_MANIFEST, name)).toBeDefined();
  }
});

test("every shared xterm-family package is present in desktop's manifest devDependencies (the manifest this fix mirrors)", () => {
  for (const name of SHARED_XTERM_PACKAGES) {
    expect(devRange(REAL_DESKTOP_MANIFEST, name)).toBeDefined();
  }
});

test("root and desktop declare byte-identical version ranges for every shared xterm-family package (the guard this card exists to add)", () => {
  const offenders = divergentRanges(REAL_ROOT_MANIFEST, REAL_DESKTOP_MANIFEST, SHARED_XTERM_PACKAGES);
  expect(offenders).toEqual([]);
});

test("the three shared ranges match the exact values measured 2026-08-28 (^5.5.0 / ^0.10.0 / ^0.11.0) -- pins the assertion to a concrete value, not just cross-manifest equality", () => {
  expect(devRange(REAL_ROOT_MANIFEST, "@xterm/xterm")).toBe("^5.5.0");
  expect(devRange(REAL_ROOT_MANIFEST, "@xterm/addon-fit")).toBe("^0.10.0");
  expect(devRange(REAL_ROOT_MANIFEST, "@xterm/addon-web-links")).toBe("^0.11.0");
});

test("mutation proof, RED-FIRST: a synthetic root manifest with one diverging range is caught by name", () => {
  const mutatedRoot: PackageManifest = {
    devDependencies: {
      ...REAL_ROOT_MANIFEST.devDependencies,
      "@xterm/xterm": "^5.4.0", // deliberately one patch/minor behind desktop's ^5.5.0
    },
  };
  const offenders = divergentRanges(mutatedRoot, REAL_DESKTOP_MANIFEST, SHARED_XTERM_PACKAGES);
  expect(offenders).toEqual(["@xterm/xterm"]);
});

test("mutation proof: a missing key (not merely a different range) is also caught, not treated as trivially equal", () => {
  const { "@xterm/addon-fit": _dropped, ...rest } = REAL_ROOT_MANIFEST.devDependencies ?? {};
  const mutatedRoot: PackageManifest = { devDependencies: rest };
  expect(devRange(mutatedRoot, "@xterm/addon-fit")).toBeUndefined();
  const offenders = divergentRanges(mutatedRoot, REAL_DESKTOP_MANIFEST, SHARED_XTERM_PACKAGES);
  expect(offenders).toContain("@xterm/addon-fit");
});

test("mutation proof: a cosmetic-looking difference (caret dropped) is treated as a real divergence, not normalized away", () => {
  const mutatedDesktop: PackageManifest = {
    devDependencies: {
      ...REAL_DESKTOP_MANIFEST.devDependencies,
      "@xterm/addon-web-links": "0.11.0", // no caret, same semver meaning to a human, different string
    },
  };
  const offenders = divergentRanges(REAL_ROOT_MANIFEST, mutatedDesktop, SHARED_XTERM_PACKAGES);
  expect(offenders).toContain("@xterm/addon-web-links");
});

test("mutation proof, positive control: identical manifests report zero divergence (the guard does not just refuse everything)", () => {
  const offenders = divergentRanges(REAL_ROOT_MANIFEST, REAL_ROOT_MANIFEST, SHARED_XTERM_PACKAGES);
  expect(offenders).toEqual([]);
});

test("out of scope by design: @xterm/addon-webgl is not asserted on here (desktop-only, no import from any pure-module test)", () => {
  expect((SHARED_XTERM_PACKAGES as readonly string[]).includes("@xterm/addon-webgl")).toBe(false);
});

test("both manifests still parse as valid JSON and this file's own imports resolve against the real repo tree (floor: a corrupted manifest must not read as a vacuous pass)", () => {
  expect(REAL_ROOT_MANIFEST.devDependencies).toBeDefined();
  expect(REAL_DESKTOP_MANIFEST.devDependencies).toBeDefined();
  expect(Object.keys(REAL_ROOT_MANIFEST.devDependencies ?? {}).length).toBeGreaterThan(0);
  expect(Object.keys(REAL_DESKTOP_MANIFEST.devDependencies ?? {}).length).toBeGreaterThan(0);
});
