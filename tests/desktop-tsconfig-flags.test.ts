// spec_4fb62fae / spec_37a29aeb: pins noUnusedLocals/noUnusedParameters across
// every desktop tsconfig, so a merge-conflict resolution or a new config
// added later can't silently drop the gate a previous card enabled
// (desktop/tsconfig.node.json, desktop/tsconfig.web.json) and this card
// extended to desktop/mobile-shell/tsconfig.json -- BEFORE this card, the
// mobile-shell config was the ONE tsconfig CI actually type-checked
// (.github/workflows/desktop-build.yml, "Typecheck the mobile shell" step).
// This same batch adds a "Typecheck desktop (node + web)" step, so as of this
// commit CI type-checks all three.
//
// Coverage requirement (the whole point of this file, per CLAUDE.md's gating-
// coverage rule): the set of configs to check is DISCOVERED by walking
// desktop/** on disk, never a fixed array of 2-3 known paths. A fourth
// tsconfig added next month is picked up automatically and must either carry
// both flags or be added to EXEMPT_CONFIGS below with a written reason --
// silence is not an option, an unhandled config fails the test. The other
// half of coverage -- a config DISAPPEARING from the walk -- is guarded
// explicitly below (see "anchors the discovered set" test): a bare length
// floor only catches wholesale breakage, not one known config quietly
// dropping out.
//
// This file's own name matches the CI collection glob
// (tests/desktop-*.test.ts, see TESTING.md "Cross-platform tests") -- a
// pin that isn't collected by CI enforces nothing where it matters.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const DESKTOP_ROOT = join(REPO_ROOT, "desktop");

// Directories that are never source: vendored dependency trees (each ships
// its own tsconfig*.json, e.g. node-pty, big-integer, hasown), the built
// Electron output (dist/win-unpacked ships a copy of node-pty's tsconfig
// inside app.asar.unpacked), and the electron-vite build output (`out`,
// gitignored alongside `dist` -- see .gitignore "# output"). Pruned during
// the walk itself (never descended into), not filtered after collection --
// so this can't accidentally include a vendored/build config that happens to
// pass and mask a real one that doesn't.
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "out"]);

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

// Recursive walk rather than a single-level readdir: mobile-shell/tsconfig.json
// lives one directory below desktop/, so a flat scan would miss it.
function collectTsconfigs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      out.push(...collectTsconfigs(join(dir, entry.name)));
    } else if (entry.isFile() && /^tsconfig.*\.json$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// Named, written-reason exemption list -- the only sanctioned way for a
// config to skip the flag assertion below. Adding a path here requires a
// human to state why; the alternative (an implicit "no compilerOptions key ->
// skip" check) would silently exempt anything shaped like a solution file,
// including a future real program that happened to be misconfigured, which
// is exactly the fail-open shape CLAUDE.md's gating-coverage rule warns
// about. Keys are repo-root-relative, forward-slash-normalized paths. Values
// are enforced (see "exemption list" test below) to be more than a token
// placeholder -- an empty or trivial string defeats the "written reason"
// requirement just as silently as no check at all.
const EXEMPT_CONFIGS: Record<string, string> = {
  "desktop/tsconfig.json":
    "Solution file only (files: [], references: [tsconfig.node.json, tsconfig.web.json]) -- " +
    "no compilerOptions of its own, nothing for tsc to type-check directly under this config.",
};

// Strips `// line` comments from JSONC while leaving double-quoted string
// contents untouched, so a `"https://..."` value (or any other string
// containing "//") survives intact. JSON has no single-quoted or template
// string literals and no regex literals, so (unlike the react/react-dom/
// zustand hygiene scanner in tests/desktop-test-hygiene.test.ts, which has to
// track eight states for real JS/TS source) tracking exactly one piece of
// state -- "currently inside a double-quoted string" -- is sufficient for
// `//` comments specifically. It does NOT handle `/* */` block comments --
// none of the tsconfigs in this tree use them today, and auditConfigs()
// below fails closed (a named, attributable violation) rather than silently
// passing if one ever does, so the gap is safe but real.
function stripJsonComments(src: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        // Preserve the escaped char verbatim (handles `\"` so it doesn't
        // prematurely end the string) and skip past it.
        out += src[i + 1];
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      // Not inside a string -- this really is a comment. Drop to end of
      // line, keep the newline itself so JSON.parse still sees valid syntax
      // around it.
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

function parseJsonc(src: string): unknown {
  return JSON.parse(stripJsonComments(src));
}

interface TsconfigLike {
  compilerOptions?: {
    noUnusedLocals?: unknown;
    noUnusedParameters?: unknown;
  };
}

// Pure audit: given a list of ABSOLUTE tsconfig paths, returns violation
// strings for every one that is neither exempted nor carrying both flags.
// Extracted so the real-repo walk and the fixture-backed tests below share
// one implementation -- otherwise the two could drift and a fixture "proving"
// the gate works would stop reflecting what the real test actually runs.
//
// baseDir controls how paths are rendered relative to in the returned
// violation strings (REPO_ROOT for the real walk, the fixture's own root for
// the synthetic tests) -- both use toRepoRelative-shaped forward-slash paths
// via `relative`.
function auditConfigs(paths: string[], baseDir: string): string[] {
  const violations: string[] = [];
  for (const abs of paths) {
    const rel = relative(baseDir, abs).split(sep).join("/");
    if (Object.hasOwn(EXEMPT_CONFIGS, rel)) continue;
    let parsed: TsconfigLike;
    try {
      parsed = parseJsonc(readFileSync(abs, "utf-8")) as TsconfigLike;
    } catch (e) {
      // Fail closed: an unparseable config is a violation, not a silent
      // skip. Name the file and the actual parse error, and call out
      // stripJsonComments' known limitation so a future reader doesn't reach
      // for EXEMPT_CONFIGS as the "fix" for what is really a JSONC syntax
      // gap (block comments, trailing commas) this stripper doesn't cover.
      violations.push(
        `${rel}: unparseable (${(e as Error).message}) -- stripJsonComments handles // only, not /* */ or trailing commas`
      );
      continue;
    }
    const opts = parsed.compilerOptions;
    if (!opts || opts.noUnusedLocals !== true || opts.noUnusedParameters !== true) {
      violations.push(
        `${rel}: noUnusedLocals=${JSON.stringify(opts?.noUnusedLocals)} ` +
          `noUnusedParameters=${JSON.stringify(opts?.noUnusedParameters)} ` +
          `(expected both true, or add this path to EXEMPT_CONFIGS with a written reason)`
      );
    }
  }
  return violations;
}

test("every desktop tsconfig (discovered by walking the tree, not a hardcoded list) enforces noUnusedLocals + noUnusedParameters", () => {
  const configs = collectTsconfigs(DESKTOP_ROOT);
  const discovered = configs.map(toRepoRelative);

  // Sanity floor: if the walk root or the exclusion logic is ever broken (a
  // typo pruning everything, a wrong root), `configs` collapses toward 0 and
  // the loop below would trivially pass with nothing checked -- fail loudly
  // on that instead of reporting a suspiciously clean "0 violations".
  expect(configs.length).toBeGreaterThanOrEqual(3);

  // Anchor, not just a floor: the floor above only catches wholesale
  // breakage (walk root wrong, exclusion set swallowing everything). It does
  // NOT catch one specific known config quietly disappearing -- e.g.
  // desktop/mobile-shell/tsconfig.json being deleted still leaves 3+ other
  // vendored/real configs on disk, so the length check alone stays green.
  // Pin the three configs this card and its predecessors are known to carry
  // the flags on, so losing any one of them fails loudly instead of just
  // shrinking the checked set.
  expect(discovered).toEqual(
    expect.arrayContaining([
      "desktop/tsconfig.node.json",
      "desktop/tsconfig.web.json",
      "desktop/mobile-shell/tsconfig.json",
    ])
  );

  const violations = auditConfigs(configs, REPO_ROOT);
  expect(violations).toEqual([]);
});

test("the exemption list only names configs that actually exist on disk, with a real written reason", () => {
  // Guards the OTHER direction: a stale exemption for a deleted/renamed file
  // would silently narrow future coverage (the path just never matches
  // anything collectTsconfigs finds) without ever failing loudly on its own.
  const configs = new Set(collectTsconfigs(DESKTOP_ROOT).map(toRepoRelative));
  for (const [rel, reason] of Object.entries(EXEMPT_CONFIGS)) {
    expect(configs.has(rel), `EXEMPT_CONFIGS names ${rel}, which collectTsconfigs did not find`).toBe(true);
    // The exemption's whole justification is "a written reason" (see the
    // comment above EXEMPT_CONFIGS and the header comment at the top of this
    // file) -- but nothing previously read the string's CONTENT, so `""`
    // would have passed silently. Require something more than a token
    // placeholder.
    expect(
      reason.trim().length,
      `EXEMPT_CONFIGS["${rel}"] reason is too short to be a real written explanation: ${JSON.stringify(reason)}`
    ).toBeGreaterThan(20);
  }
});

// ----- auditConfigs fixture tests ---------------------------------------
//
// These are the mutations a reviewer measured by hand (new config without
// exemption -> red; flag flipped to false -> red) and then discarded. Shipped
// here as permanent fixture-backed guards so they can't silently stop firing
// -- a temp dir outside the repo, built and torn down per test, exercising
// auditConfigs() directly (the same function the real-repo test above uses,
// so the two paths cannot drift).

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  }
});

function makeFixture(name: string, compilerOptions: Record<string, unknown>): { dir: string; abs: string } {
  const dir = mkdtempSync(join(tmpdir(), `cp-tsconfig-audit-${name}-`));
  fixtureDir = dir;
  const abs = join(dir, "tsconfig.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, JSON.stringify({ compilerOptions }, null, 2));
  return { dir, abs };
}

test("auditConfigs: both flags true -> no violation", () => {
  const { dir, abs } = makeFixture("both-true", { noUnusedLocals: true, noUnusedParameters: true });
  expect(auditConfigs([abs], dir)).toEqual([]);
});

test("auditConfigs: noUnusedLocals false -> a violation naming the file", () => {
  const { dir, abs } = makeFixture("locals-false", { noUnusedLocals: false, noUnusedParameters: true });
  const violations = auditConfigs([abs], dir);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("tsconfig.json");
  expect(violations[0]).toContain("noUnusedLocals=false");
});

test("auditConfigs: neither flag set -> a violation naming the file", () => {
  const { dir, abs } = makeFixture("neither-flag", {});
  const violations = auditConfigs([abs], dir);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("tsconfig.json");
  expect(violations[0]).toContain("noUnusedLocals=undefined");
  expect(violations[0]).toContain("noUnusedParameters=undefined");
});

// ----- stripJsonComments unit tests -------------------------------------

test("stripJsonComments: a // line comment is removed", () => {
  const src = '{\n  // a comment\n  "a": 1\n}';
  expect(parseJsonc(src)).toEqual({ a: 1 });
});

test("stripJsonComments: a \"https://...\" string value survives untouched", () => {
  const src = '{ "url": "https://example.com/path" }';
  expect(parseJsonc(src)).toEqual({ url: "https://example.com/path" });
});

test("stripJsonComments: a real comment on the line AFTER an https:// string value is still stripped", () => {
  const src = '{\n  "url": "https://example.com",\n  // note: not a URL\n  "b": 2\n}';
  expect(parseJsonc(src)).toEqual({ url: "https://example.com", b: 2 });
});

test("stripJsonComments: an escaped quote inside a string does not end the string early", () => {
  const src = '{ "s": "a \\"quoted\\" // not-a-comment b" }';
  expect(parseJsonc(src)).toEqual({ s: 'a "quoted" // not-a-comment b' });
});

test("stripJsonComments: a trailing // comment on the same line as a real value is stripped", () => {
  const src = '{ "a": true // enable it\n}';
  expect(parseJsonc(src)).toEqual({ a: true });
});
