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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ----- desktop/tsconfig.node.json include coverage over mcp/ and hooks/ ---
//
// Card d07ab3f0: desktop/tsconfig.node.json's `include` array carries
// "hooks/**/*.ts" and "mcp/**/*.ts" alongside named-file entries for
// desktop/../shared/*.ts, but nothing previously read that array's CONTENT --
// only its two compilerOptions flags, asserted above. A one-character
// regression (deleting "mcp/**/*.ts" from include) would silently drop
// desktop/mcp/deck-control-mcp.ts and desktop/mcp/demo-browser-mcp.ts (the
// two production MCP servers card a7822bc4 just brought under typecheck)
// back out of tsc's program, with this suite and CI both staying green.
//
// This closes the gap by DISCOVERING the real tracked file set (`git
// ls-files desktop/mcp desktop/hooks`, never a hardcoded list -- so a new
// file dropped into either directory is covered automatically) and asserting
// every path is matched by at least one glob in the parsed include array.
// Fails closed in both directions per CLAUDE.md's gating-coverage rule: glob
// removed from include -> known file now unmatched; new source directory
// added under desktop/ with nothing in include naming it -> also unmatched.

// Translates one tsconfig `include` glob entry to a RegExp, using the same
// ** and * semantics tsc itself applies (`**/` matches zero or more full
// path segments, a lone `*` matches within one segment, everything else is
// matched literally). An entry with no wildcard at all (e.g.
// "../shared/approval.ts") degrades to a literal, exact-match regex -- it
// cannot accidentally match an unrelated path the way a naive substring or
// prefix check could.
function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      // "**/" -- zero or more full path segments, including zero (so
      // "mcp/**/*.ts" also matches "mcp/deck-control-mcp.ts" directly, not
      // only files one level deeper).
      out += "(?:.*/)?";
      i += 2;
      continue;
    }
    if (c === "*" && glob[i + 1] === "*") {
      // A trailing "**" with nothing after it -- match anything, including
      // path separators.
      out += ".*";
      i += 1;
      continue;
    }
    if (c === "*") {
      out += "[^/]*";
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
      continue;
    }
    out += c;
  }
  out += "$";
  return new RegExp(out);
}

function matchesAnyGlob(relPath: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(relPath));
}

// ----- desktop/**/*.ts(x) source coverage across ALL desktop tsconfigs ----
//
// Card d07ab3f0, widened during review (team-lead desktop-7b2civn-koryphaios-2):
// the first cut of this test scoped its domain to `git ls-files desktop/mcp
// desktop/hooks`, i.e. two directory names written into the test itself. That
// is the exact fail-open shape the card exists to close, just with a smaller
// N -- MEASURED directly: dropping a probe file under a brand-new
// desktop/agents/ directory left that narrower test green. The domain must
// instead be "every tracked .ts/.tsx file anywhere under desktop/", walked
// via `git ls-files desktop` (never a directory allow-list), checked against
// every desktop tsconfig's own include array (also walked, not just
// tsconfig.node.json).
//
// A domain this wide immediately surfaces real files covered by NOTHING:
// MEASURED via a disposable audit script against the three real configs
// before writing this test, exactly two kinds of pre-existing gap turned up
// (never three, never zero -- this comment is not a guess about what the
// exemption list below will contain, it is what was found):
//   - desktop/tests-support/{hygiene-fixtures.ts,react-test-harness.ts}: no
//     tsconfig, no CI step, no comment anywhere names them -- an UNDECLARED
//     gap, tracked by roadmap card f4125a11, expected to disappear.
//   - desktop/mobile-shell/capacitor.config.ts: deliberately excluded by
//     mobile-shell/tsconfig.json's own written comment next to
//     `"include": ["src/**/*.ts"]` (imports @capacitor/cli, a dev-only
//     Android-tooling dependency, carries no logic worth checking) -- a
//     DELIBERATE, already-documented exclusion, expected to stay.
//
// EXEMPT_SOURCES exists to let exactly those two kinds through, and no
// others: an entry is only admitted with a written reason AND one of the two
// `nature` values below, so a future reader can't extend the list by
// analogy alone -- they must say which kind of exception they are adding.
// Citing "path + symbol" for the deliberate case (never a line number): a
// line-numbered pointer rots the moment the file reflows (this repo has
// precedent -- a laurel badge moved 35 lines while its CSS class stayed
// put), while `desktop/mobile-shell/tsconfig.json`'s capacitor.config.ts
// comment is found by grepping the filename, not a number.
type SourceExemptionNature =
  | "undeclared-gap" // no tsconfig, no CI step, no comment names it anywhere; tracked by a dedicated roadmap card; expected to disappear.
  | "deliberate"; // excluded on purpose, already documented in the product itself (a written comment next to some tsconfig's own include/exclude); expected to stay.

interface SourceExemption {
  reason: string;
  nature: SourceExemptionNature;
}

const EXEMPT_SOURCES: Record<string, SourceExemption> = {
  "desktop/tests-support/hygiene-fixtures.ts": {
    reason:
      "Test-only support module, never shipped, covered by no desktop tsconfig today. Pre-existing gap " +
      "outside card d07ab3f0's scope -- tracked by roadmap card f4125a11.",
    nature: "undeclared-gap",
  },
  "desktop/tests-support/react-test-harness.ts": {
    reason:
      "Test-only support module, never shipped, covered by no desktop tsconfig today. Pre-existing gap " +
      "outside card d07ab3f0's scope -- tracked by roadmap card f4125a11.",
    nature: "undeclared-gap",
  },
  "desktop/mobile-shell/capacitor.config.ts": {
    reason:
      "Already excluded on purpose, with a written reason in the product itself: the capacitor.config.ts " +
      "exclusion comment in desktop/mobile-shell/tsconfig.json, next to that file's own \"include\": " +
      "[\"src/**/*.ts\"] (imports @capacitor/cli, a dev-only dependency that only exists on a machine with " +
      "the Android tooling; carries no logic worth checking).",
    nature: "deliberate",
  },
};

// The desktop tsconfigs that between them are meant to cover every desktop/
// TypeScript source file. DISCOVERED via the same collectTsconfigs walk the
// flags test above uses (minus EXEMPT_CONFIGS -- desktop/tsconfig.json is a
// files-less solution file with no include of its own), never a hardcoded
// array: this file's own flags-coverage half already answers "what happens
// when a tsconfig is added" by walking disk, and the source-coverage half
// must answer the identical question the identical way, or a genuinely new
// tsconfig (with its own real include) would be invisible to source
// coverage while still passing the flags test. baseDir is where that
// config's OWN include/exclude globs are relative to, repo-root-relative
// with a trailing slash (the empty string for a hypothetical config at
// REPO_ROOT itself, though none exists today).
function discoverDesktopTsConfigs(): { path: string; baseDir: string }[] {
  return collectTsconfigs(DESKTOP_ROOT)
    .map(toRepoRelative)
    .filter((rel) => !Object.hasOwn(EXEMPT_CONFIGS, rel))
    .map((rel) => {
      const slash = rel.lastIndexOf("/");
      const dir = slash === -1 ? "" : rel.slice(0, slash);
      return { path: rel, baseDir: dir === "" ? "" : `${dir}/` };
    });
}

const DESKTOP_TS_CONFIGS: { path: string; baseDir: string }[] = discoverDesktopTsConfigs();

// Reads BOTH include and exclude -- a config that only consulted include
// would treat exclude as inert, so a one-line `"exclude": ["mcp/**/*.ts"]`
// addition would silently drop the same two production MCP servers card
// a7822bc4 brought under typecheck back out of tsc's program, with every
// assertion below still green (MEASURED against a disposable git-archive
// mirror of desktop/, never the real tree: the unfixed include-only logic
// reported zero uncovered files even with exclude covering mcp/**/*.ts).
function loadIncludeGlobs(spec: {
  path: string;
  baseDir: string;
}): { baseDir: string; include: string[]; exclude: string[] } {
  const src = readFileSync(join(REPO_ROOT, spec.path), "utf-8");
  const parsed = parseJsonc(src) as { include?: string[]; exclude?: string[] };
  return { baseDir: spec.baseDir, include: parsed.include ?? [], exclude: parsed.exclude ?? [] };
}

// The exact git ls-files invocation the real-repo test below relies on for
// its domain, pinned to a literal array rather than inlined at the call
// site, so a future edit reviving `--others --exclude-standard` (which this
// file carried for one round, see git history around card d07ab3f0) fails
// this pin closed instead of silently changing behaviour again.
//
// `--cached` ONLY, deliberately NOT `--others`. Decision (team-lead
// desktop-7b2civn-koryphaios-2): `--cached` reads the INDEX, i.e. exactly
// what is staged -- a source file that is actually about to ship has been
// `git add`-ed, so it already appears in `--cached` by the time this gate
// would matter for real. `--others` would instead also enumerate untracked
// working-tree files, which in this repo's 12-concurrent-session shared
// checkout means ANY session's uncommitted, unrelated WIP file under
// desktop/ can turn this test red for everyone -- a failure that is not
// attributable to whoever is running the suite, and one CI can never
// reproduce (CI never has untracked content), which is exactly the
// local-vs-CI divergence other cards in this repo exist to close. The
// residual gap this choice accepts: the narrow window between a file's
// creation and its `git add` is not covered -- nothing can land through
// that window, so nothing is lost by not checking it.
const DESKTOP_SOURCE_DISCOVERY_ARGS = ["ls-files", "--cached", "desktop"];

// Extracted so the real-repo test below and its fixture-backed counterparts
// share one implementation (same reasoning as auditConfigs above: otherwise
// a fixture "proving" the coverage check works could drift from what the
// real test actually runs). `files` are repo-root-relative (as returned by
// `git ls-files`). A file matches if EITHER it is named in `exemptions`, OR
// at least one config whose baseDir prefixes it has an include glob that
// matches the remainder.
function findUncoveredDesktopSources(
  files: string[],
  configs: { baseDir: string; include: string[]; exclude?: string[] }[],
  exemptions: Record<string, SourceExemption>
): string[] {
  const unmatched: string[] = [];
  for (const f of files) {
    if (Object.hasOwn(exemptions, f)) continue;
    let covered = false;
    for (const c of configs) {
      if (!f.startsWith(c.baseDir)) continue;
      const rel = f.slice(c.baseDir.length);
      if (matchesAnyGlob(rel, c.include) && !matchesAnyGlob(rel, c.exclude ?? [])) {
        covered = true;
        break;
      }
    }
    if (!covered) unmatched.push(f);
  }
  return unmatched;
}

test("globToRegExp: \"mcp/**/*.ts\" matches both a direct child and a nested file", () => {
  const re = globToRegExp("mcp/**/*.ts");
  expect(re.test("mcp/deck-control-mcp.ts")).toBe(true);
  expect(re.test("mcp/sub/nested.ts")).toBe(true);
  expect(re.test("mcp/deck-control-mcp.mts")).toBe(false);
  expect(re.test("other/deck-control-mcp.ts")).toBe(false);
});

test("globToRegExp: a plain path with no wildcard only matches itself", () => {
  const re = globToRegExp("../shared/approval.ts");
  expect(re.test("../shared/approval.ts")).toBe(true);
  expect(re.test("../shared/approval.ts.bak")).toBe(false);
  expect(re.test("mcp/approval.ts")).toBe(false);
});

// A path-shaped token inside a prose `reason` string, e.g.
// "desktop/mobile-shell/tsconfig.json" -- used only to VALIDATE a
// "deliberate" exemption's reason against the file it claims documents it,
// never to invent one: the reason's author still writes the sentence.
const REASON_PATH_REFERENCE = /[\w.-]+(?:\/[\w.-]+)+\.(?:json|ts|tsx|md)\b/;

// Checks that `nature` is not just a label but a claim the reason text can
// actually be held to (fix for team-lead review round 2 on card d07ab3f0:
// MEASURED that swapping "undeclared-gap" and "deliberate" on an existing
// entry left every prior assertion green -- nothing depended on which value
// was there). "undeclared-gap" must cite a tracking roadmap card id (an
// 8-hex-char id, this repo's own id shape) so the entry is attributable and
// so a future reader knows which card's completion should delete it.
// "deliberate" must name a file that (a) exists and (b) itself mentions the
// exempted file's basename -- i.e. the claimed documentation is real, not an
// invented pointer (this repo's own file:line-rot precedent is exactly why
// this checks CONTENT, not just that some path-shaped substring is present).
function validateExemptionNature(rel: string, entry: SourceExemption): string | undefined {
  if (entry.nature === "undeclared-gap") {
    if (!/\b[0-9a-f]{8}\b/.test(entry.reason)) {
      return `EXEMPT_SOURCES["${rel}"] is "undeclared-gap" but its reason cites no roadmap card id (expected an 8-hex-char id)`;
    }
    return undefined;
  }
  const referenced = entry.reason.match(REASON_PATH_REFERENCE)?.[0];
  if (!referenced) {
    return `EXEMPT_SOURCES["${rel}"] is "deliberate" but its reason names no file path to verify against`;
  }
  const abs = join(REPO_ROOT, referenced);
  if (!existsSync(abs)) {
    return `EXEMPT_SOURCES["${rel}"] is "deliberate" but its reason's referenced file "${referenced}" does not exist on disk`;
  }
  const basenameOfExempted = rel.split("/").pop()!;
  if (!readFileSync(abs, "utf-8").includes(basenameOfExempted)) {
    return `EXEMPT_SOURCES["${rel}"] is "deliberate" but "${referenced}" never mentions "${basenameOfExempted}"`;
  }
  return undefined;
}

test("EXEMPT_SOURCES only names files that actually exist on disk, are genuinely uncovered without their exemption, with a real written reason and a behavior-backed nature", () => {
  const configs = DESKTOP_TS_CONFIGS.map(loadIncludeGlobs);
  for (const [rel, entry] of Object.entries(EXEMPT_SOURCES)) {
    expect(existsSync(join(REPO_ROOT, rel)), `EXEMPT_SOURCES names ${rel}, which does not exist on disk`).toBe(true);
    expect(
      entry.reason.trim().length,
      `EXEMPT_SOURCES["${rel}"] reason is too short to be a real written explanation: ${JSON.stringify(entry.reason)}`
    ).toBeGreaterThan(20);
    expect(["undeclared-gap", "deliberate"]).toContain(entry.nature);

    // Staleness guard: if `rel` is ALREADY covered by a real tsconfig on its
    // own (e.g. the day roadmap card f4125a11 lands and covers tests-support),
    // the exemption became dead weight -- an "undeclared-gap" entry is meant
    // to die the moment its gap closes, and nothing should let an exemption
    // linger unnoticed regardless of nature.
    expect(
      findUncoveredDesktopSources([rel], configs, {}),
      `EXEMPT_SOURCES["${rel}"] is unnecessary: ${rel} is already covered by a real tsconfig without it`
    ).toEqual([rel]);

    const violation = validateExemptionNature(rel, entry);
    expect(violation, violation).toBeUndefined();
  }
});

test("desktop source discovery uses git ls-files --cached (staged/committed only), never --others", () => {
  // Static pin against a literal, independent of DESKTOP_SOURCE_DISCOVERY_ARGS's
  // own definition -- if someone edits the array (e.g. reviving `--others
  // --exclude-standard`), this literal does not move with it, so the
  // mismatch is caught here rather than only being visible as a diff to a
  // git-blame reader.
  expect(DESKTOP_SOURCE_DISCOVERY_ARGS).toEqual(["ls-files", "--cached", "desktop"]);
  expect(DESKTOP_SOURCE_DISCOVERY_ARGS).not.toContain("--others");
});

test("every .ts/.tsx/.mts/.cts file staged or committed under desktop/ is covered by at least one desktop tsconfig's include array, or is a named+reasoned exemption", () => {
  // Floor mirroring the flags test above: if discoverDesktopTsConfigs's walk
  // root or EXEMPT_CONFIGS filter is ever broken, `configs` collapses toward
  // 0 and every file would trivially report as "uncovered by nothing to
  // check against" -- or, worse, toward a subset that silently drops one
  // real config's include from consideration.
  expect(DESKTOP_TS_CONFIGS.length).toBeGreaterThanOrEqual(3);

  const configs = DESKTOP_TS_CONFIGS.map(loadIncludeGlobs);
  for (const c of configs) {
    expect(c.include.length, `a desktop tsconfig had no include array to check (baseDir ${c.baseDir})`).toBeGreaterThan(0);
  }

  const gitResult = spawnSync("git", DESKTOP_SOURCE_DISCOVERY_ARGS, { cwd: REPO_ROOT, encoding: "utf-8" });
  expect(gitResult.status, `git ls-files failed: ${gitResult.stderr}`).toBe(0);
  // .mts/.cts included alongside .ts/.tsx: a glob like "mcp/**/*.ts" does NOT
  // match "*.mts" (globToRegExp's own fixture test above proves this), so if
  // this filter stayed .ts/.tsx-only, a .mts file dropped under desktop/
  // would be invisible to BOTH tsc's real program and this guard -- the
  // exact double-blind spot the "escapes twice" review finding named. None
  // exist under desktop/ today (this filter simply has nothing to match yet).
  const files = gitResult.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => /\.(m|c)?tsx?$/.test(f));

  // Sanity floor: if the walk root or the extension filter is ever broken,
  // `files` collapses toward 0 and the loop below would trivially pass with
  // nothing checked. Measured today at 193 real files -- 100 is a floor
  // with real margin, not a number chosen to just barely pass.
  expect(files.length, "git ls-files --cached desktop returned no .ts/.tsx files").toBeGreaterThan(100);

  const unmatched = findUncoveredDesktopSources(files, configs, EXEMPT_SOURCES);
  expect(
    unmatched,
    `not covered by any desktop tsconfig and not in EXEMPT_SOURCES: ${unmatched.join(", ")}`
  ).toEqual([]);
});

// This exercises the REAL include data (DESKTOP_TS_CONFIGS/loadIncludeGlobs)
// and the REAL exemption list (EXEMPT_SOURCES) against a file list that
// includes a brand-new, uncovered directory -- only the git enumeration
// itself is simulated (a literal array standing in for `git ls-files
// --cached desktop`'s output). HONEST RESIDUAL: this does NOT prove that
// `git ls-files --cached desktop` itself returns the right domain -- that
// command's shape is pinned separately by the "desktop source discovery
// uses git ls-files --cached" test above. What this proves is that IF the
// domain includes a newly-landing, uncovered file, the real config/exemption
// data reports it -- the property that stayed silently unproven when the
// first cut of this test scoped its git enumeration to desktop/mcp and
// desktop/hooks only (MEASURED: a real untracked probe under desktop/agents/
// left that version green).
test("findUncoveredDesktopSources: against the REAL desktop tsconfigs and REAL exemptions, a file under a brand-new uncovered directory is still reported", () => {
  const configs = DESKTOP_TS_CONFIGS.map(loadIncludeGlobs);
  const files = ["desktop/mcp/deck-control-mcp.ts", "desktop/agents/zzprobe.ts"];
  const unmatched = findUncoveredDesktopSources(files, configs, EXEMPT_SOURCES);
  expect(unmatched).toEqual(["desktop/agents/zzprobe.ts"]);
});

// findUncoveredDesktopSources fixture tests -- these exercise what the
// real-repo test above cannot, on its own, distinguish from a hardcoded
// two-or-three-file check: a NEW source file appearing under a directory
// nothing has ever heard of, and the exemption list actually being READ
// (removing an entry must turn a previously-silent gap back into a
// violation -- an exemption that can vanish with no effect is decorative).
test("findUncoveredDesktopSources: a file under a brand-new, uncovered directory is reported", () => {
  const configs = [{ baseDir: "desktop/", include: ["hooks/**/*.ts", "mcp/**/*.ts"] }];
  const files = ["desktop/mcp/deck-control-mcp.ts", "desktop/agents/new-agent.ts"];
  expect(findUncoveredDesktopSources(files, configs, {})).toEqual(["desktop/agents/new-agent.ts"]);
});

test("findUncoveredDesktopSources: every file covered by some config's include yields no violations", () => {
  const configs = [
    { baseDir: "desktop/", include: ["hooks/**/*.ts"] },
    { baseDir: "desktop/mobile-shell/", include: ["src/**/*.ts"] },
  ];
  const files = ["desktop/hooks/approval-hook.ts", "desktop/mobile-shell/src/app.ts"];
  expect(findUncoveredDesktopSources(files, configs, {})).toEqual([]);
});

test("findUncoveredDesktopSources: a file matching no config's include is reported UNLESS named in exemptions", () => {
  const configs = [{ baseDir: "desktop/", include: ["hooks/**/*.ts"] }];
  const files = ["desktop/tests-support/hygiene-fixtures.ts"];
  const exemption: Record<string, SourceExemption> = {
    "desktop/tests-support/hygiene-fixtures.ts": { reason: "known pre-existing gap, tracked elsewhere", nature: "undeclared-gap" },
  };
  expect(findUncoveredDesktopSources(files, configs, {})).toEqual(["desktop/tests-support/hygiene-fixtures.ts"]);
  expect(findUncoveredDesktopSources(files, configs, exemption)).toEqual([]);
});

// Blocker fix (team-lead review round 2 on card d07ab3f0): `exclude` cancels
// a matching `include`, exactly like tsc itself. MEASURED against a
// disposable git-archive mirror of desktop/ (never the real tree) that the
// UNFIXED include-only logic reported zero uncovered files even after
// adding `"exclude": ["mcp/**/*.ts"]` to the mirrored tsconfig.node.json --
// this fixture is the permanent, always-on form of that same proof.
test("findUncoveredDesktopSources: a file matching include but also matching exclude is reported as uncovered", () => {
  const configs = [{ baseDir: "desktop/", include: ["mcp/**/*.ts"], exclude: ["mcp/**/*.ts"] }];
  const files = ["desktop/mcp/deck-control-mcp.ts"];
  expect(findUncoveredDesktopSources(files, configs, {})).toEqual(["desktop/mcp/deck-control-mcp.ts"]);
});

test("findUncoveredDesktopSources: exclude that does not match the file leaves it covered", () => {
  const configs = [{ baseDir: "desktop/", include: ["mcp/**/*.ts"], exclude: ["mcp/legacy/**/*.ts"] }];
  const files = ["desktop/mcp/deck-control-mcp.ts"];
  expect(findUncoveredDesktopSources(files, configs, {})).toEqual([]);
});
