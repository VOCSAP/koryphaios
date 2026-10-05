import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const DESKTOP_ROOT = join(REPO_ROOT, "desktop");

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

function collectTrackedTsconfigs(repoRoot: string, dir: string): string[] {
  const relDir = relative(repoRoot, dir).split(sep).join("/") || ".";
  const result = spawnSync("git", ["ls-files", "--cached", "--", relDir], { cwd: repoRoot, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ls-files failed for ${relDir}: ${result.error?.message ?? result.stderr ?? "unknown error"}`);
  return result.stdout
    .split(/\r?\n/)
    .filter((path) => /^tsconfig.*\.json$/.test(path.slice(path.lastIndexOf("/") + 1)))
    .map((path) => join(repoRoot, path));
}

const EXEMPT_CONFIGS: Record<string, string> = {
  "desktop/tsconfig.json":
    "Solution file only (files: [], references: [tsconfig.node.json, tsconfig.web.json]) -- " +
    "no compilerOptions of its own, nothing for tsc to type-check directly under this config.",
};

// Strips // line comments from JSONC, leaving double-quoted string contents
// untouched so a URL survives. Tracks only 'inside a double-quoted string'
// state since JSON has no other literal forms; does not handle /* */ block
// comments, which auditConfigs() fails closed on rather than silently passing.
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

test("every tracked desktop tsconfig enforces noUnusedLocals + noUnusedParameters", () => {
  const configs = collectTrackedTsconfigs(REPO_ROOT, DESKTOP_ROOT);
  const discovered = configs.map(toRepoRelative);

  // Sanity floor: if tracked discovery is broken, `configs` collapses toward 0 and
  // the loop below would trivially pass with nothing checked -- fail loudly
  // on that instead of reporting a suspiciously clean "0 violations".
  expect(configs.length).toBeGreaterThanOrEqual(3);

  // The floor does not detect one known config quietly disappearing. Pin the
  // three configs carrying these flags so their removal fails loudly.
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
  // A stale exemption for a deleted or renamed file must fail instead of
  // silently narrowing future coverage.
  const configs = new Set(collectTrackedTsconfigs(REPO_ROOT, DESKTOP_ROOT).map(toRepoRelative));
  for (const [rel, reason] of Object.entries(EXEMPT_CONFIGS)) {
    expect(configs.has(rel), `EXEMPT_CONFIGS names ${rel}, which tracked discovery did not find`).toBe(true);
    // The exemption's whole justification is a written reason, but nothing
    // checks the string's actual content, so an empty string would pass
    // silently.
    // This requires something more than a token placeholder.
    expect(
      reason.trim().length,
      `EXEMPT_CONFIGS["${rel}"] reason is too short to be a real written explanation: ${JSON.stringify(reason)}`
    ).toBeGreaterThan(20);
  }
});

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

function makeTrackedTsconfigFixture(): { dir: string; configs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "cp-tsconfig-tracked-"));
  fixtureDir = dir;
  const names = ["tsconfig.a.json", "tsconfig.b.json", "tsconfig.c.json", "tsconfig.d.json", "tsconfig.zz-growth.json"];
  for (const name of names) {
    writeFileSync(join(dir, name), JSON.stringify({ compilerOptions: { noUnusedLocals: true, noUnusedParameters: true } }));
  }
  writeFileSync(join(dir, "tsconfig.generated.json"), JSON.stringify({ compilerOptions: {} }));
  expect(spawnSync("git", ["init"], { cwd: dir }).status).toBe(0);
  expect(spawnSync("git", ["add", ...names], { cwd: dir }).status).toBe(0);
  return { dir, configs: names.map((name) => join(dir, name)) };
}

test("tracked discovery returns every tracked tsconfig and excludes an untracked tsconfig", () => {
  const { dir, configs } = makeTrackedTsconfigFixture();
  expect(collectTrackedTsconfigs(dir, dir)).toEqual(configs);
});

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

// desktop/tsconfig.node.json's include array is discovered from the real
// tracked file set via git ls-files rather than asserted only on its two
// compilerOptions flags, so a glob silently dropped from include (e.g. losing
// mcp/**/*.ts) fails this test instead of staying green.

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

type SourceExemptionNature =
  | "undeclared-gap"
  | "deliberate";

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

function discoverDesktopTsConfigs(): { path: string; baseDir: string }[] {
  return collectTrackedTsconfigs(REPO_ROOT, DESKTOP_ROOT)
    .map(toRepoRelative)
    .filter((rel) => !Object.hasOwn(EXEMPT_CONFIGS, rel))
    .map((rel) => {
      const slash = rel.lastIndexOf("/");
      const dir = slash === -1 ? "" : rel.slice(0, slash);
      return { path: rel, baseDir: dir === "" ? "" : `${dir}/` };
    });
}

const DESKTOP_TS_CONFIGS: { path: string; baseDir: string }[] = discoverDesktopTsConfigs();

function loadIncludeGlobs(spec: {
  path: string;
  baseDir: string;
}): { baseDir: string; include: string[]; exclude: string[] } {
  const src = readFileSync(join(REPO_ROOT, spec.path), "utf-8");
  const parsed = parseJsonc(src) as { include?: string[]; exclude?: string[] };
  return { baseDir: spec.baseDir, include: parsed.include ?? [], exclude: parsed.exclude ?? [] };
}

// Pinned to a literal array rather than inlined at the call site, so a future
// edit reviving --others fails this pin instead of silently changing behavior.
// --cached only, deliberately not --others: --others would also enumerate
// untracked working-tree files, which in a shared checkout means any session's
// unrelated uncommitted file under desktop/ could turn this test red for
// everyone, a failure CI can never reproduce.
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
  const files = gitResult.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => /\.(m|c)?tsx?$/.test(f));

  expect(files.length, "git ls-files --cached desktop returned no .ts/.tsx files").toBeGreaterThan(100);

  const unmatched = findUncoveredDesktopSources(files, configs, EXEMPT_SOURCES);
  expect(
    unmatched,
    `not covered by any desktop tsconfig and not in EXEMPT_SOURCES: ${unmatched.join(", ")}`
  ).toEqual([]);
});

test("findUncoveredDesktopSources: against the REAL desktop tsconfigs and REAL exemptions, a file under a brand-new uncovered directory is still reported", () => {
  const configs = DESKTOP_TS_CONFIGS.map(loadIncludeGlobs);
  const files = ["desktop/mcp/deck-control-mcp.ts", "desktop/agents/zzprobe.ts"];
  const unmatched = findUncoveredDesktopSources(files, configs, EXEMPT_SOURCES);
  expect(unmatched).toEqual(["desktop/agents/zzprobe.ts"]);
});

// Exercises what the real-repo test above cannot distinguish from a hardcoded
// check on its own: a new source file under a directory nothing has ever heard
// of, and that removing an exemption entry actually turns a silent gap back
// into a violation.
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
