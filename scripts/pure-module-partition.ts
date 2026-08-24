// Card 0bbac537. desktop-build's "Bun tests (pure modules)" step used to be
// an explicit `bun test <globs...>` line: an ALLOW-list that fails OPEN (a
// new file matching no glob is silently never collected -- card ed110556).
// This module is the single source of truth for its replacement: a
// DENY-list (EXEMPTIONS) that fails CLOSED (a new file is run by default;
// an exemption must justify itself). Imported by BOTH the script that
// actually runs the tests (partition-pure-tests.ts, same directory) and the
// coverage-audit guard (tests/desktop-ci-glob-coverage.test.ts) -- CLAUDE.md's
// rule on a shared gating table applies verbatim: two copies and the
// divergence comes back in through the door that was just closed.
//
// Root cause this partition exists to route around (measured 2026-08-24,
// hyp_df4a33c4): bun runs every tests/*.test.ts file in ONE process.
// GlobalRegistrator.register() (happy-dom) and mock.module() (bun) both
// mutate PROCESS-GLOBAL state with no in-process undo available to a file
// that dies at import time (mock.restore() does not revert a mocked
// module's exports; a slot left registered by a file that threw during its
// own ESM load, before its own afterAll ran, has no owner left to unregister
// it). The only working teardown is a process boundary. This module supplies
// the classification; partition-pure-tests.ts supplies the boundary.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Exemptions {
  familyPrefixes: Record<string, string>;
  exactFiles: Record<string, string>;
}

// Unchanged from the pre-migration allow-list era (tests/desktop-ci-glob-coverage.test.ts,
// same 4 entries): both families spawn a daemon and bind ports, which this
// pure-module partition is not for.
export const EXEMPTIONS: Exemptions = {
  familyPrefixes: {
    "broker-": "spawns a daemon and binds ports; the pure-module matrix is not for integration suites",
    "server-": "spawns a daemon and binds ports; the pure-module matrix is not for integration suites",
  },
  exactFiles: {
    "approval-hook.test.ts":
      "spawns a daemon and binds ports (imports startBroker from tests/_helper.ts); the pure-module matrix is not for integration suites",
    "mcp-roadmap-ack.test.ts":
      "spawns a daemon and binds ports (imports startBroker from tests/_helper.ts, and Bun.spawn's `bun server.ts` directly); the pure-module matrix is not for integration suites",
  },
};

/**
 * Text markers that identify a file as mutating process-global state with
 * no working in-process teardown (see module header). Deliberately a plain
 * substring scan, not an AST/import check: over-matching (a file that only
 * MENTIONS a marker in a comment, e.g. desktop-happy-dom-teardown.test.ts,
 * desktop-test-hygiene.test.ts) gets isolated into its own process for
 * nothing, at a cost of ~0.2s -- accepted, per card 0bbac537's brief.
 * Under-matching is the only failure mode that matters here and would
 * silently reopen the exact contamination chain this partition exists to
 * close, so the scan is never narrowed to reduce false positives.
 */
export const CONTAMINATION_MARKERS = ["GlobalRegistrator.register(", "mock.module("] as const;

/** True if `file` (a bare filename under tests/) matches an exemption. */
export function isExempt(file: string, exemptions: Exemptions = EXEMPTIONS): boolean {
  return Object.keys(exemptions.familyPrefixes).some((prefix) => file.startsWith(prefix)) || file in exemptions.exactFiles;
}

export interface Partition {
  /** Non-exempt, carries no contamination marker: safe to run in a shared process. */
  clean: string[];
  /** Non-exempt, carries at least one contamination marker: needs its own process. */
  contaminated: string[];
}

/**
 * Splits `files` (bare filenames under tests/) into clean/contaminated,
 * after removing exempted files entirely: they are not run by this
 * partition at all, and (N1, reviewer 2026-08-24, measured: the "Bun tests
 * (pure modules)" step in .github/workflows/desktop-build.yml is the only
 * step in that workflow that invokes `bun test`) not run in CI at all today
 * -- pre-existing, unchanged by this migration. `readSource` is injectable
 * so tests can exercise this against synthetic in-memory sources without
 * touching disk.
 */
export function partitionTests(
  files: string[],
  exemptions: Exemptions = EXEMPTIONS,
  readSource: (file: string) => string = (f) => readFileSync(join(TESTS_DIR, f), "utf-8"),
): Partition {
  const clean: string[] = [];
  const contaminated: string[] = [];
  for (const file of files) {
    if (isExempt(file, exemptions)) continue;
    const source = readSource(file);
    if (CONTAMINATION_MARKERS.some((m) => source.includes(m))) {
      contaminated.push(file);
    } else {
      clean.push(file);
    }
  }
  return { clean, contaminated };
}

/** Exemption entries naming a family/file with zero matches on disk -- a stale map is as wrong as a coverage gap. */
export function staleExemptions(exemptions: Exemptions, files: string[]): { staleFamilies: string[]; staleFiles: string[] } {
  const staleFamilies = Object.keys(exemptions.familyPrefixes).filter((prefix) => !files.some((f) => f.startsWith(prefix)));
  const staleFiles = Object.keys(exemptions.exactFiles).filter((f) => !files.includes(f));
  return { staleFamilies, staleFiles };
}

export const REPO_ROOT = join(import.meta.dir, "..");
export const TESTS_DIR = join(REPO_ROOT, "tests");
export const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "desktop-build.yml");

/** Real on-disk tests/*.test.ts inventory, bare filenames. */
export function listTestFiles(testsDir: string = TESTS_DIR): string[] {
  return readdirSync(testsDir).filter((f) => f.endsWith(".test.ts"));
}

// The literal command the CI workflow's "Bun tests (pure modules)" step must
// invoke (single source shared with the guard tests' expectation, so the
// workflow YAML and the tests that assert against it cannot drift silently
// past each other -- the YAML itself is still edited by hand, this constant
// only keeps each test's expectation from being an independent copy).
export const PARTITION_SCRIPT_COMMAND = "bun scripts/partition-pure-tests.ts";

/**
 * Pulls the `run:` command out of the "Bun tests (pure modules)" step.
 * Anchored on the step's own `name:`, AND bounded to end at the next step
 * item (a line starting `      - ` at the steps list's own indent) -- not
 * just to end of file. Card 0bbac537 sweep, 2026-08-24: this bounded parse
 * used to be duplicated verbatim in tests/desktop-ci-glob-coverage.test.ts
 * AND tests/desktop-commit-closure-check.test.ts, each anchoring the exact
 * same step marker independently -- exactly the "N sites doing the same
 * parsing" shape CLAUDE.md's shared-gating-table rule targets. Extracted
 * here, both files import it. Search starts at offset 1 into the slice so
 * the step's own leading `- name:` line (which begins the very slice being
 * bounded) is never mistaken for the next step's boundary. Throws (not a
 * test assertion) so this stays usable at module scope, where a broken parse
 * should abort loudly rather than silently produce an empty (or wrong-step)
 * result.
 *
 * N2, reviewer 2026-08-24: the step-item indentation used to be hardcoded to
 * 6 spaces. Probed: at 4-space indentation the hardcoded boundary regex
 * simply never matches, and the parser silently adopts the NEXT step's
 * `run:` line instead of throwing -- the exact composition failure this
 * function's bounding exists to prevent, reopened by a plain reindent.
 * Deriving the indentation from the actual matched line (walk back to the
 * start of the step marker's own line, measure the whitespace before its
 * `-`) makes the boundary correct at any indentation instead of assuming
 * today's.
 */
export function parsePureModuleStepRun(workflowText: string): string {
  const stepMarker = "name: Bun tests (pure modules)";
  const stepIdx = workflowText.indexOf(stepMarker);
  if (stepIdx === -1) {
    throw new Error(`"${stepMarker}" step not found in ${WORKFLOW_PATH}`);
  }
  const lineStart = workflowText.lastIndexOf("\n", stepIdx) + 1;
  const linePrefix = workflowText.slice(lineStart, stepIdx);
  const dashMatch = linePrefix.match(/^(\s*)-\s*$/);
  if (!dashMatch) {
    throw new Error(`could not derive step-item indentation for "${stepMarker}" in ${WORKFLOW_PATH} (line prefix: ${JSON.stringify(linePrefix)})`);
  }
  const indent = dashMatch[1]!;
  const rest = workflowText.slice(stepIdx);
  const nextStepBoundary = new RegExp(`\\r?\\n${indent}- `);
  const nextStepOffset = rest.slice(1).search(nextStepBoundary);
  const stepText = nextStepOffset === -1 ? rest : rest.slice(0, nextStepOffset + 1);
  const runMatch = stepText.match(/run:\s*(.+)/);
  if (!runMatch) {
    throw new Error(`no "run:" line found inside the "${stepMarker}" step`);
  }
  return runMatch[1].trim();
}
