// spec_f731f289 (amended): card 01c82fdf follow-up. The token-safe
// roadmap-add fallback (cli-roadmap-add-no-token.test.ts) shipped uncovered
// by CI: .github/workflows/desktop-build.yml's "Bun tests (pure modules)"
// step lists an explicit glob set rather than running `bun test` bare, and
// that set had never been checked against the real tests/*.test.ts
// inventory. Team-lead review, 2026-08-03: a one-line fix for the single
// missed file would have left the same gap open for the next new suite.
//
// This test is the coverage audit for that gap, not a fixed file list:
//   - the CI glob patterns are PARSED out of the workflow YAML text itself
//     (parsePureModuleGlobs), not hardcoded here;
//   - the test inventory is ENUMERATED from tests/ via readdirSync, not
//     hardcoded either;
//   - every real *.test.ts file must be covered by a parsed glob OR an
//     exemption below, and every exemption must name something that still
//     exists on disk (a stale exemption is exactly as wrong as a coverage
//     gap: both mean the map no longer describes reality).
//
// Two exemption shapes, deliberately: a whole PREFIX FAMILY (broker-,
// server- -- both spawn a daemon and bind ports, and a future sibling test
// in either family arrives already covered without another edit here), and
// a single FILE (approval-hook.test.ts also spawns a daemon via
// tests/_helper.ts's startBroker, but sits outside the approval-* family's
// otherwise-honest pure-module story -- approval-identity.test.ts, the
// other member, is pure and IS CI-collected, so a family-wide exemption
// would wrongly also excuse a file that has no daemon in it).
// logger.test.ts has no dash in its name, so it is listed in the workflow's
// glob line by exact filename, not a prefix wildcard -- see that file's own
// comment for why.
//
// Fails closed in three directions, each proven below by mutating REAL
// parsed data in memory (never by editing the workflow file on disk, which
// would leave the shared checkout dirty for other concurrent sessions):
//   1. GROWTH -- a new test file matching no glob and no exemption.
//   2. STALENESS -- an exemption naming a family/file with zero matches.
//   3. SHRINKAGE -- a glob pattern removed from the workflow, which must
//      uncover every file that pattern used to be the only thing covering.
//      ("the shrinkage direction we have missed three times today" --
//      team-lead review.)
//
// Named tests/desktop-*.test.ts so it is collected by the very glob it
// audits (mirrors tests/desktop-test-hygiene.test.ts's own self-coverage
// note) -- checked explicitly by a test below, not assumed from the name.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "desktop-build.yml");
const TESTS_DIR = join(REPO_ROOT, "tests");

interface Exemptions {
  familyPrefixes: Record<string, string>;
  exactFiles: Record<string, string>;
}

const EXEMPTIONS: Exemptions = {
  familyPrefixes: {
    "broker-": "spawns a daemon and binds ports; the pure-module matrix is not for integration suites",
    "server-": "spawns a daemon and binds ports; the pure-module matrix is not for integration suites",
  },
  exactFiles: {
    "approval-hook.test.ts":
      "spawns a daemon and binds ports (imports startBroker from tests/_helper.ts); the pure-module matrix is not for integration suites",
  },
};

/**
 * Pulls the space-separated `bun test <globs...>` tokens out of the
 * "Bun tests (pure modules)" step's `run:` line. Anchored on the step's own
 * `name:`, AND bounded to end at the next step item (a line starting
 * `      - ` at the steps list's own indent) -- not just to end of file.
 * Team-lead review, round 2: the first version searched from stepIdx to
 * end-of-file, so the step marker fixed where the search STARTS but not
 * where it STOPS. Measured false-open composition: reformat this step's
 * `run:` to a YAML block scalar (so this step's own regex stops matching)
 * while a LATER step runs a bare `bun test`, and the unbounded version
 * silently adopted that later step's globs instead of throwing. Bounding
 * the slice to the next `      - ` step-item line closes that: the block
 * scalar reformat now correctly fails to match anything inside THIS step's
 * bounded text and throws, rather than reading past the step into whatever
 * comes next. Throws (not expect()) so this stays usable at module scope,
 * where a broken parse should abort loudly rather than silently produce an
 * empty (or wrong-step) glob list.
 */
function parsePureModuleGlobs(workflowText: string): string[] {
  const stepMarker = "name: Bun tests (pure modules)";
  const stepIdx = workflowText.indexOf(stepMarker);
  if (stepIdx === -1) {
    throw new Error(`"${stepMarker}" step not found in ${WORKFLOW_PATH}`);
  }
  const rest = workflowText.slice(stepIdx);
  // Search from offset 1 so the step's OWN leading "      - name:" line
  // (which starts the very slice we are bounding) is never mistaken for the
  // next step's boundary.
  const nextStepOffset = rest.slice(1).search(/\r?\n {6}- /);
  const stepText = nextStepOffset === -1 ? rest : rest.slice(0, nextStepOffset + 1);
  const runMatch = stepText.match(/run:\s*bun test\s+(.+)/);
  if (!runMatch) {
    throw new Error(`no "run: bun test <globs>" line found inside the "${stepMarker}" step`);
  }
  return runMatch[1]
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length > 0);
}

/**
 * Globs here are always `tests/<literal>.test.ts` with at most one `*`
 * (prefix wildcard, e.g. tests/desktop-*.test.ts) or none (exact file, e.g.
 * tests/logger.test.ts). Escapes regex metachars first, then turns `*` into
 * `.*`, so this stays correct even if a future pattern's literal segment
 * contains a regex-special character.
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function computeCoverage(globs: string[], exemptions: Exemptions, files: string[]) {
  const regexes = globs.map(globToRegex);
  const uncovered: string[] = [];
  for (const file of files) {
    const relPath = `tests/${file}`;
    if (regexes.some((r) => r.test(relPath))) continue;
    const familyExempt = Object.keys(exemptions.familyPrefixes).some((prefix) => file.startsWith(prefix));
    const fileExempt = file in exemptions.exactFiles;
    if (!familyExempt && !fileExempt) uncovered.push(file);
  }
  const staleFamilies = Object.keys(exemptions.familyPrefixes).filter(
    (prefix) => !files.some((f) => f.startsWith(prefix)),
  );
  const staleFiles = Object.keys(exemptions.exactFiles).filter((f) => !files.includes(f));
  return { uncovered, staleFamilies, staleFiles };
}

function exemptedFiles(exemptions: Exemptions, files: string[]): string[] {
  return files.filter(
    (f) =>
      Object.keys(exemptions.familyPrefixes).some((prefix) => f.startsWith(prefix)) ||
      f in exemptions.exactFiles,
  );
}

const REAL_WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, "utf-8");
const REAL_GLOBS = parsePureModuleGlobs(REAL_WORKFLOW_TEXT);
const REAL_FILES = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts"));

test("bounded parse does not adopt a LATER step's globs (the composition case that failed open)", () => {
  // Team-lead review, round 2: reformat the pure-module step's run line to a
  // YAML block scalar (an ordinary edit -- the step's own single-line regex
  // then legitimately stops matching) while a LATER step runs a bare
  // `bun test <globs>`. The unbounded version of this parser kept scanning
  // past the pure-module step and silently adopted the later step's globs
  // instead of failing. This constructs that exact composition and asserts
  // the bounded parser does NOT read into the later step: either it throws
  // (no run:-bun-test line found within the bounded step text), or if it
  // matches, the result must never contain the later step's glob.
  const synthetic = `
    steps:
      - name: Bun tests (pure modules)
        shell: bash
        run: |
          bun test tests/desktop-*.test.ts tests/notify-*.test.ts
      - name: Some later full-suite step
        shell: bash
        run: bun test tests/should-not-leak-*.test.ts
`;
  let result: string[] | undefined;
  let threw = false;
  try {
    result = parsePureModuleGlobs(synthetic);
  } catch {
    threw = true;
  }
  if (!threw) {
    expect(result).not.toContain("tests/should-not-leak-*.test.ts");
  }
});

test("the pure-module step still declares glob tokens (fails closed if the step is renamed/removed)", () => {
  expect(REAL_GLOBS.length).toBeGreaterThan(0);
  expect(REAL_GLOBS).toContain("tests/desktop-*.test.ts");
});

test("this file itself is collected by the CI glob it audits", () => {
  const regexes = REAL_GLOBS.map(globToRegex);
  const ownRelPath = "tests/desktop-ci-glob-coverage.test.ts";
  expect(regexes.some((r) => r.test(ownRelPath))).toBe(true);
});

test("every exemption reason is a real, non-trivial explanation (not a placeholder)", () => {
  for (const reason of Object.values(EXEMPTIONS.familyPrefixes)) {
    expect(reason.length).toBeGreaterThan(15);
  }
  for (const reason of Object.values(EXEMPTIONS.exactFiles)) {
    expect(reason.length).toBeGreaterThan(15);
  }
});

test("every exempted file actually spawns a broker (measured property, not the family label)", () => {
  // N2, team-lead review round 2: `file.startsWith(prefix)` only checks the
  // NAME. A future pure file that happens to get named broker-something
  // would be silently exempted forever with nothing going red -- growth of
  // the EXEMPT domain, not the covered one. This asserts the actual
  // property the exemption claims (imports startBroker, or otherwise pulls
  // in tests/_helper.ts) rather than trusting the filename pattern.
  const files = exemptedFiles(EXEMPTIONS, REAL_FILES);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const source = readFileSync(join(TESTS_DIR, f), "utf-8");
    expect(source).toMatch(/startBroker|_helper/);
  }
});

test("mutation proof, N2: an exempted file that does NOT spawn a broker is caught", () => {
  // A real, genuinely pure file (no startBroker/_helper import, and no
  // mention of either string even in comments -- confirmed, unlike this
  // file's own source, which talks ABOUT startBroker/_helper in its
  // comments and would give a false positive here).
  const noBrokerFile = "logger.test.ts";
  const source = readFileSync(join(TESTS_DIR, noBrokerFile), "utf-8");
  expect(source).not.toMatch(/startBroker|_helper/);
  // If this file were (wrongly) added to EXEMPTIONS, the property test above
  // would fail on it -- demonstrated directly rather than by mutating the
  // shared EXEMPTIONS map (which would risk a real assertion never running
  // if the mutation were undone incorrectly).
  const mutatedExemptions: Exemptions = {
    familyPrefixes: EXEMPTIONS.familyPrefixes,
    exactFiles: { ...EXEMPTIONS.exactFiles, [noBrokerFile]: "placeholder reason, long enough" },
  };
  const files = exemptedFiles(mutatedExemptions, REAL_FILES);
  expect(files).toContain(noBrokerFile);
  const wronglyExempted = files.filter((f) => {
    const src = readFileSync(join(TESTS_DIR, f), "utf-8");
    return !/startBroker|_helper/.test(src);
  });
  expect(wronglyExempted).toContain(noBrokerFile);
});

test("every on-disk tests/*.test.ts file is CI-collected or honestly exempted", () => {
  expect(REAL_FILES.length).toBeGreaterThan(0);
  const { uncovered, staleFamilies, staleFiles } = computeCoverage(REAL_GLOBS, EXEMPTIONS, REAL_FILES);
  expect(uncovered).toEqual([]);
  expect(staleFamilies).toEqual([]);
  expect(staleFiles).toEqual([]);
});

test("mutation proof, growth: a new uncovered file is caught", () => {
  const mutatedFiles = [...REAL_FILES, "a-brand-new-untriaged-file.test.ts"];
  const { uncovered } = computeCoverage(REAL_GLOBS, EXEMPTIONS, mutatedFiles);
  expect(uncovered).toContain("a-brand-new-untriaged-file.test.ts");
});

test("mutation proof, staleness: an exemption naming a vanished family is caught", () => {
  const mutatedExemptions: Exemptions = {
    familyPrefixes: { ...EXEMPTIONS.familyPrefixes, "nonexistent-family-": "placeholder reason, long enough" },
    exactFiles: EXEMPTIONS.exactFiles,
  };
  const { staleFamilies } = computeCoverage(REAL_GLOBS, mutatedExemptions, REAL_FILES);
  expect(staleFamilies).toContain("nonexistent-family-");
});

test("mutation proof, staleness: a per-file exemption naming a vanished file is caught", () => {
  const mutatedExemptions: Exemptions = {
    familyPrefixes: EXEMPTIONS.familyPrefixes,
    exactFiles: { ...EXEMPTIONS.exactFiles, "this-file-does-not-exist.test.ts": "placeholder reason, long enough" },
  };
  const { staleFiles } = computeCoverage(REAL_GLOBS, mutatedExemptions, REAL_FILES);
  expect(staleFiles).toContain("this-file-does-not-exist.test.ts");
});

test("mutation proof, shrinkage: removing a glob pattern uncovers the files it used to collect", () => {
  const shrunkGlobs = REAL_GLOBS.filter((g) => g !== "tests/desktop-*.test.ts");
  const { uncovered } = computeCoverage(shrunkGlobs, EXEMPTIONS, REAL_FILES);
  const desktopFiles = REAL_FILES.filter((f) => f.startsWith("desktop-"));
  expect(desktopFiles.length).toBeGreaterThan(0);
  for (const f of desktopFiles) {
    expect(uncovered).toContain(f);
  }
});
