// PLAN-SANDBOX SBX2 + M3: per-project sandbox settings store (operator
// app-state, never a repo file) — desktop/src/main/sandbox-store.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectSandboxSettings,
  readSandboxStore,
  writeSandboxImage,
  writeSandboxSettings,
} from "../desktop/src/main/sandbox-store.ts";
import { DEFAULT_SANDBOX_PORTS, SANDBOX_IMAGE_DEFAULT } from "../desktop/src/main/sandbox-command.ts";
import { isUnboundedGlob } from "../desktop/src/shared/types.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-sandbox-store-"));
  file = join(dir, "sandbox.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("missing file yields defaults (disabled, mount mode, default image/ports)", () => {
  const s = projectSandboxSettings(file, "local:abc");
  expect(s.enabled).toBe(false);
  expect(s.mode).toBe("mount");
  expect(s.ports).toEqual(DEFAULT_SANDBOX_PORTS);
  expect(s.copyIgnored).toEqual([]);
  expect(readSandboxStore(file).image).toBe(SANDBOX_IMAGE_DEFAULT);
});

test("patches round-trip per project and keep siblings", () => {
  writeSandboxSettings(file, "local:aaa", { enabled: true, mode: "copy" });
  writeSandboxSettings(file, "local:bbb", { enabled: false });
  const a = projectSandboxSettings(file, "local:aaa");
  expect(a.enabled).toBe(true);
  expect(a.mode).toBe("copy");
  expect(projectSandboxSettings(file, "local:bbb").enabled).toBe(false);
  // A later partial patch must not reset the untouched fields.
  writeSandboxSettings(file, "local:aaa", { enabled: false });
  expect(projectSandboxSettings(file, "local:aaa").mode).toBe("copy");
  expect(Object.keys(readSandboxStore(file).projects).sort()).toEqual(["local:aaa", "local:bbb"]);
});

test("malformed file falls back to defaults instead of throwing", () => {
  writeFileSync(file, "{not json");
  expect(projectSandboxSettings(file, "k").enabled).toBe(false);
  // and a subsequent write recovers the file
  writeSandboxSettings(file, "k", { enabled: true });
  expect(projectSandboxSettings(file, "k").enabled).toBe(true);
});

test("hand-edited values are sanitized (ports, mode, globs)", () => {
  writeFileSync(
    file,
    JSON.stringify({
      image: "  custom-img  ",
      projects: {
        k: {
          enabled: true,
          mode: "remote-lxc",
          ports: [3000, 3000, 0, 99999, "x"],
          copyIgnored: ["  PLAN-*.md  ", "", "PLAN-*.md", 42],
        },
      },
    })
  );
  const s = projectSandboxSettings(file, "k");
  expect(s.ports).toEqual([3000]);
  // An unknown work mode falls back to the safe one rather than reaching the
  // service as an unhandled branch.
  expect(s.mode).toBe("mount");
  expect(s.copyIgnored).toEqual(["PLAN-*.md"]);
  expect(readSandboxStore(file).image).toBe("custom-img");
  // An EXPLICITLY empty list stays empty — the defaults are shared by every
  // project, so clearing them is how a second sandboxed project avoids a
  // "port is already allocated" failure. Only an absent key means "defaults".
  writeFileSync(file, JSON.stringify({ projects: { k: { enabled: true, ports: [] } } }));
  expect(projectSandboxSettings(file, "k").ports).toEqual([]);
  writeFileSync(file, JSON.stringify({ projects: { k: { enabled: true } } }));
  expect(projectSandboxSettings(file, "k").ports).toEqual(DEFAULT_SANDBOX_PORTS);
});

test("projectConfig is an opt-OUT: absent/garbage => true, only explicit false sticks", () => {
  // Pre-existing stores (no key) keep projecting -- the historical behavior.
  expect(projectSandboxSettings(file, "k").projectConfig).toBe(true);
  writeFileSync(file, JSON.stringify({ projects: { k: { enabled: true, projectConfig: "no" } } }));
  expect(projectSandboxSettings(file, "k").projectConfig).toBe(true);
  writeSandboxSettings(file, "k", { projectConfig: false });
  expect(projectSandboxSettings(file, "k").projectConfig).toBe(false);
  // The opt-out survives unrelated patches.
  writeSandboxSettings(file, "k", { enabled: true });
  expect(projectSandboxSettings(file, "k").projectConfig).toBe(false);
  writeSandboxSettings(file, "k", { projectConfig: true });
  expect(projectSandboxSettings(file, "k").projectConfig).toBe(true);
});

test("image write is global and falls back to the default when blanked", () => {
  expect(writeSandboxImage(file, "my-image")).toBe("my-image");
  expect(readSandboxStore(file).image).toBe("my-image");
  expect(writeSandboxImage(file, "   ")).toBe(SANDBOX_IMAGE_DEFAULT);
});

// Card 4b668844: globs that don't constrain the file name (*, **, **/*, .*)
// are functionally equivalent to a whole-tree match (selectCopyPaths dedupes
// any slash-free glob into [g, "**/"+g]) and must be refused at the WRITE
// path, fail-closed -- the whole patch rejected, nothing partially saved.
test("writeSandboxSettings rejects unbounded globs one at a time", () => {
  for (const bad of ["*", "**", "**/*", ".*"]) {
    expect(() => writeSandboxSettings(file, "k", { copyIgnored: [bad] })).toThrow(
      /sandbox-unbounded-glob:/
    );
  }
  // Fail-closed: nothing from the rejected patch was persisted.
  expect(projectSandboxSettings(file, "k").copyIgnored).toEqual([]);
});

test("writeSandboxSettings rejection message names every offending glob, not just the first", () => {
  expect(() =>
    writeSandboxSettings(file, "k", { copyIgnored: ["*.md", "**", "docs/*", "*"] })
  ).toThrow("sandbox-unbounded-glob:**,*");
});

test("writeSandboxSettings catches an unbounded glob padded with whitespace", () => {
  expect(() => writeSandboxSettings(file, "k", { copyIgnored: [" * "] })).toThrow(
    "sandbox-unbounded-glob:*"
  );
});

// One row per glob form, not one assertion per form, so a newly-discovered
// unbounded idiom is a line to add rather than a test to rewrite.
// Includes narrow-glob counter-examples so the table measures specificity, not
// just sensitivity.
// Nested-only witness rows are required: an unnested form like "*/**" never
// trips the at-least-one-segment nesting check.
test.each([
  ["*.*", true],
  ["**/**", true],
  ["?*", true],
  ["**/*.*", true],
  ["**\\*", true], // literal backslash, as a Windows-typed operator would enter it
  [".*", true], // sweeps every dotfile at every depth, not literally every file
  ["*/**", true], // requires >=1 nested segment -- flat witnesses alone miss this
  ["**/*/*", true], // same nesting-floor shape, two segments deep
  ["*.md", false],
  ["docs/*", false],
  ["*.env", false], // extension-narrowed, even though it targets dotfile-adjacent names
  ["src/**", false], // nested-looking but rooted at a real dir -- must stay bounded
])("isUnboundedGlob(%p) === %p", (glob, expected) => {
  expect(isUnboundedGlob(glob)).toBe(expected);
});

test("writeSandboxSettings still accepts globs that constrain the file name", () => {
  const narrow = ["*.md", "PLAN-*.md", "*.local.json", "docs/*", "notes/**", ".claude/agent-memory/**"];
  writeSandboxSettings(file, "k", { copyIgnored: narrow });
  expect(projectSandboxSettings(file, "k").copyIgnored).toEqual(narrow);
});

test("a patch without copyIgnored never triggers the unbounded-glob check", () => {
  expect(() => writeSandboxSettings(file, "k", { enabled: true })).not.toThrow();
});

test("migration: a hand-edited store with an unbounded glob still loads, and keeps it until the next explicit copyIgnored save", () => {
  writeFileSync(
    file,
    JSON.stringify({ projects: { k: { enabled: true, copyIgnored: ["**"] } } })
  );
  // Load path (readSandboxStore/saneSettings) is untouched by this card --
  // refusing silently at load would be the "worst of both worlds" the audit
  // called out. The pre-existing value survives as-is.
  expect(projectSandboxSettings(file, "k").copyIgnored).toEqual(["**"]);
  // An unrelated patch that doesn't touch copyIgnored must not be blocked by
  // -- or silently scrub -- the legacy value.
  writeSandboxSettings(file, "k", { enabled: false });
  expect(projectSandboxSettings(file, "k").copyIgnored).toEqual(["**"]);
  // Only an explicit re-submission of copyIgnored is checked, and rejected.
  expect(() => writeSandboxSettings(file, "k", { copyIgnored: ["**"] })).toThrow(
    "sandbox-unbounded-glob:**"
  );
});
