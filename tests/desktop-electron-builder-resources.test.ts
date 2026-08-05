import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Packaging regression guard for card d02c8e96 (deck-plugin extraResources
// silently dropped by an aborted electron-builder run). A unit test of
// pluginFlag()/getDeckPluginDir() would be green today and prove nothing --
// the actual defect was a MISMATCH between what electron-builder.yml declares
// and what a packaged app/win-unpacked tree ends up containing, and no
// existing test looks at a real packaged tree at all.
//
// This test reads the extraResources list FROM desktop/electron-builder.yml
// (never hardcoded -- a hardcoded list is exactly the "sensitivity without
// coverage" shape CLAUDE.md warns about: a 5th entry added later would
// silently escape a hardcoded guard).
//
// Split in two halves (reviewer d02c8e96 review, second pass), each catching
// a DIFFERENT real failure mode, neither subsuming the other:
//   - LOCAL half: does each declared `to` target exist, non-empty, under a
//     packaged dist/win-unpacked/resources. Only runs the real assertion on a
//     machine that has just `npm run package`d (skipped elsewhere via
//     test.skipIf, see below -- an explicit, visible skip, not a silent
//     pass). Catches an aborted/partial packaging run, the card's own
//     incident -- output-side destruction CI cannot see regardless, since no
//     packaging job runs there (deliberately out of scope today: electron-
//     builder in CI is expensive and that is not today's trade-off).
//   - CI half: does each declared `from:` source directory exist, non-empty,
//     in the SOURCE tree (desktop/). Needs no packaging, runs everywhere
//     including plain CI for free. Catches a mistyped `from:`, a renamed
//     source directory, or a new entry pointing nowhere -- a human typo, the
//     one failure mode of the two a person can actually introduce by hand
//     (`from: resources/sandbox` / `to: sandbox` already shows these paths
//     are not always the same string).
//
// Deliberately does NOT invoke `npm run package` itself: packaging needs a
// native toolchain and takes minutes; this file stays a pure module so it
// runs in the same fast "Bun tests (pure modules)" CI step as the rest of
// tests/desktop-*.test.ts (see .github/workflows/desktop-build.yml).

const DESKTOP_DIR = join(import.meta.dir, "..", "desktop");
const YML_PATH = join(DESKTOP_DIR, "electron-builder.yml");

/**
 * Extract every `extraResources[].to` target from electron-builder.yml.
 * Intentionally a tiny hand-rolled parser rather than a YAML library
 * dependency (none is declared in desktop/package.json; js-yaml only exists
 * transitively via electron-builder itself, which would make this test rely
 * on an undeclared dependency). Scoped to the flat, hand-maintained shape of
 * this one file: find the `extraResources:` block, walk its indented lines
 * until the next top-level (unindented) key, and pull every `to: <value>`.
 */
function parseExtraResourcesTargets(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^extraResources:\s*$/.test(l));
  if (startIdx === -1) return [];
  const targets: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key: block ended
    const m = line.match(/^\s*-?\s*to:\s*(.+?)\s*$/);
    if (m) targets.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return targets;
}

/** What the packaged-tree check below actually asserts, factored out so the
 * red path (a broken tree) is provable against a synthetic directory instead
 * of only against the real, currently-healthy desktop/dist/win-unpacked. */
function checkPackagedResources(resourcesDir: string, targets: string[]): { missing: string[]; empty: string[] } {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const target of targets) {
    const targetDir = join(resourcesDir, target);
    if (!existsSync(targetDir)) {
      missing.push(target);
      continue;
    }
    if (readdirSync(targetDir).length === 0) empty.push(target);
  }
  return { missing, empty };
}

interface ExtraResourceEntry {
  from: string;
  to: string;
}

/**
 * Extract every `extraResources[].{from,to}` pair from electron-builder.yml.
 * Same hand-rolled-parser rationale as parseExtraResourcesTargets above
 * (no YAML lib dependency), extended to also capture `from` since the CI-side
 * half of the guard (reviewer d02c8e96 review, source-tree check) needs the
 * SOURCE path, not just the packaged `to` name -- they differ for at least
 * one entry (`from: resources/sandbox` / `to: sandbox`), which is exactly the
 * kind of divergence a typo in `from:` can hide behind.
 */
function parseExtraResourcesEntries(yamlText: string): ExtraResourceEntry[] {
  const lines = yamlText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^extraResources:\s*$/.test(l));
  if (startIdx === -1) return [];
  const entries: ExtraResourceEntry[] = [];
  let current: Partial<ExtraResourceEntry> = {};
  const flush = () => {
    if (current.from && current.to) entries.push({ from: current.from, to: current.to });
    current = {};
  };
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key: block ended
    if (/^\s*-\s/.test(line)) flush(); // new list item starts (any key first, not just `from:`)
    const fromM = line.match(/^\s*-?\s*from:\s*(.+?)\s*$/);
    if (fromM) current.from = fromM[1].replace(/^["']|["']$/g, "");
    const toM = line.match(/^\s*-?\s*to:\s*(.+?)\s*$/);
    if (toM) current.to = toM[1].replace(/^["']|["']$/g, "");
  }
  flush();
  return entries;
}

/**
 * CI half of the packaging guard (reviewer d02c8e96 review, second pass):
 * the local/packaged half above only ever asserts on a machine that has just
 * run `npm run package`, so it is skipped in CI (no packaging job exists
 * there, and adding one is explicitly out of scope for today per the
 * reviewer). This half needs no packaging at all -- it reads each
 * extraResources `from:` and checks it exists and is non-empty in the SOURCE
 * tree (desktop/), so it runs everywhere, including plain CI. It catches a
 * different, real failure mode than the local half: a mistyped `from:`, a
 * renamed source directory, or a new entry that points nowhere -- a human
 * typo, not an aborted packaging run (that class only ever shows up in
 * packaged OUTPUT, which is exactly why the local half exists too; neither
 * half subsumes the other).
 */
function checkSourceEntries(desktopDir: string, entries: ExtraResourceEntry[]): { missing: string[]; empty: string[] } {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const entry of entries) {
    const sourceDir = join(desktopDir, entry.from);
    if (!existsSync(sourceDir)) {
      missing.push(entry.from);
      continue;
    }
    if (readdirSync(sourceDir).length === 0) empty.push(entry.from);
  }
  return { missing, empty };
}

test("electron-builder.yml declares at least the known extraResources entries", () => {
  const yamlText = readFileSync(YML_PATH, "utf-8");
  const targets = parseExtraResourcesTargets(yamlText);
  // Known floor, not a ceiling: asserts the parser itself still finds the
  // entries known at the time this test was written. A 5th entry added later
  // is picked up automatically by the packaged-tree check below since that
  // one iterates `targets`, not this list.
  expect(targets).toEqual(expect.arrayContaining(["locales", "docs", "deck-plugin", "sandbox"]));
});

const PACKAGED_RESOURCES_DIR = join(DESKTOP_DIR, "dist", "win-unpacked", "resources");
const HAS_PACKAGED_TREE = existsSync(PACKAGED_RESOURCES_DIR);

// Reviewer Q1 (card d02c8e96 review): a silent `console.warn` + early `return`
// when no packaged tree exists is itself the fail-open shape CLAUDE.md warns
// about -- indistinguishable from a real pass in the `bun test` summary, and
// today's CI (.github/workflows/desktop-build.yml) has no packaging step at
// all, so this branch would ALWAYS be the one CI takes: zero real regression
// coverage there. `test.skipIf` makes that an explicit, visibly-labelled SKIP
// in the runner's own tally (not a pass) instead of a silently-succeeding
// no-op, and the arbitration is spelled out here rather than left implicit:
// this repo does not run a real `npm run package` in CI, so the only place
// this test's actual assertion executes today is a developer machine that has
// packaged locally, or a future dedicated CI packaging job. Until one exists,
// CI honestly reports "skipped", not "passed".
test.skipIf(!HAS_PACKAGED_TREE)(
  "every extraResources target exists under a packaged win-unpacked/resources (needs desktop/dist/win-unpacked/resources)",
  () => {
    const yamlText = readFileSync(YML_PATH, "utf-8");
    const targets = parseExtraResourcesTargets(yamlText);
    expect(targets.length).toBeGreaterThan(0);
    expect(checkPackagedResources(PACKAGED_RESOURCES_DIR, targets)).toEqual({ missing: [], empty: [] });
  }
);

test("every extraResources `from:` source directory exists and is non-empty (runs in CI, no packaging needed)", () => {
  const yamlText = readFileSync(YML_PATH, "utf-8");
  const entries = parseExtraResourcesEntries(yamlText);
  // Fails RED if the yml is ever reformatted into a shape the parser can't
  // read as zero entries -- a would-be "empty list, vacuously green" trap
  // (reviewer d02c8e96 review: "elle doit rougir si la liste est VIDE").
  expect(entries.length).toBeGreaterThan(0);
  expect(checkSourceEntries(DESKTOP_DIR, entries)).toEqual({ missing: [], empty: [] });
});

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

test("the check is RED on a tree missing an extraResources entry (proves it would have caught card d02c8e96)", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kory-eb-resources-"));
  const resourcesDir = join(tmpDir, "resources");
  // Reproduce the exact incident: an aborted electron-builder run left the
  // resources dir with only what it managed to unpack before it died,
  // deck-plugin/locales/docs/sandbox never landed.
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(join(resourcesDir, "app.asar"), "stub");

  const result = checkPackagedResources(resourcesDir, ["locales", "docs", "deck-plugin", "sandbox"]);
  expect(result.missing.sort()).toEqual(["deck-plugin", "docs", "locales", "sandbox"]);
  expect(result.empty).toEqual([]);
});

test("the check is RED on a target dir that exists but is empty (partial unpack, not just absent)", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kory-eb-resources-"));
  const resourcesDir = join(tmpDir, "resources");
  mkdirSync(join(resourcesDir, "locales"), { recursive: true }); // present, empty
  mkdirSync(join(resourcesDir, "docs"), { recursive: true });
  writeFileSync(join(resourcesDir, "docs", "index.md"), "stub");

  const result = checkPackagedResources(resourcesDir, ["locales", "docs"]);
  expect(result.missing).toEqual([]);
  expect(result.empty).toEqual(["locales"]);
});

test("the source-tree check is RED on a `from:` that points nowhere (typo / renamed source dir)", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kory-eb-source-"));
  mkdirSync(join(tmpDir, "locales"), { recursive: true });
  writeFileSync(join(tmpDir, "locales", "fr.json"), "{}");
  // "resources/sandbox" is the real entry's from: for the `sandbox` target
  // (see electron-builder.yml) -- reusing the same shape, but only creating
  // "locales" in the fixture so "resources/sandbox" is provably missing.

  const result = checkSourceEntries(tmpDir, [
    { from: "locales", to: "locales" },
    { from: "resources/sandbox", to: "sandbox" }
  ]);
  expect(result.missing).toEqual(["resources/sandbox"]);
  expect(result.empty).toEqual([]);
});

test("the source-tree check is RED on a `from:` dir that exists but is empty", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kory-eb-source-"));
  mkdirSync(join(tmpDir, "deck-plugin"), { recursive: true }); // present, empty

  const result = checkSourceEntries(tmpDir, [{ from: "deck-plugin", to: "deck-plugin" }]);
  expect(result.missing).toEqual([]);
  expect(result.empty).toEqual(["deck-plugin"]);
});

test("parseExtraResourcesEntries handles a `to:`-first entry (legal YAML this repo doesn't currently write, but the parser must not silently drop the prior entry over it)", () => {
  // Reviewer catch: flushing only on `- from:` assumed every entry writes
  // `from:` first. `- to: x` / `from: y` is legal YAML that reads exactly
  // the same to a human, and the old flush trigger let the new item's `to:`
  // overwrite the previous item's `to:` before it was ever pushed -- the
  // previous entry vanished, entries.length stayed > 0, so the "list is
  // non-empty" guard above didn't catch it. This is the same "reformat ->
  // silent subset" shape this whole file exists to guard against, one layer
  // down in the parser itself.
  const yaml = [
    "extraResources:",
    "  - to: locales",
    "    from: locales",
    "  - from: docs",
    "    to: docs",
    "files:",
    "  - out/**/*"
  ].join("\n");
  const entries = parseExtraResourcesEntries(yaml);
  expect(entries).toEqual([
    { from: "locales", to: "locales" },
    { from: "docs", to: "docs" }
  ]);
});

test("parseExtraResourcesEntries is RED (empty) on a reformatted yml with no extraResources block, not silently vacuous-green", () => {
  const entries = parseExtraResourcesEntries("appId: com.example.app\nfiles:\n  - out/**/*\n");
  expect(entries).toEqual([]);
  // The test above this one (`entries.length > 0`) is what turns this
  // specific shape RED against the real yml -- this probe just proves the
  // parser itself degrades to an honest empty list rather than throwing or
  // hallucinating entries, so that upstream assertion is trustworthy.
});
