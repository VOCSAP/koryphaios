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

// Card f4a3ed1e (2026-08-28): these 4 entries used to justify themselves with
// "the pure-module matrix is not for integration suites" -- true about WHY
// they don't belong in that step, but silent on whether anything ELSE runs
// them, which nothing did (measured 2026-08-24: `bun test` occurred exactly
// once in the whole CI, in the very step that exempts them). The wording
// below now makes a checkable claim -- the exact step name that plays this
// family -- so `auditExemptionLocations` below can verify it against the
// real workflow text instead of trusting prose. Card 0bbac537's original
// property (both families spawn a daemon and bind ports) is unchanged and
// still what makes them wrong for the pure-module step specifically.
export const INTEGRATION_STEP_NAME = "Bun tests (integration)";

export const EXEMPTIONS: Exemptions = {
  familyPrefixes: {
    "broker-": `spawns a daemon and binds ports; run by the '${INTEGRATION_STEP_NAME}' step in desktop-build.yml, not the pure-module matrix`,
    "server-": `spawns a daemon and binds ports; run by the '${INTEGRATION_STEP_NAME}' step in desktop-build.yml, not the pure-module matrix`,
  },
  exactFiles: {
    "approval-hook.test.ts":
      `spawns a daemon and binds ports (imports startBroker from tests/_helper.ts); run by the '${INTEGRATION_STEP_NAME}' step in desktop-build.yml, not the pure-module matrix`,
    "mcp-roadmap-ack.test.ts":
      `spawns a daemon and binds ports (imports startBroker from tests/_helper.ts, and Bun.spawn's \`bun server.ts\` directly); run by the '${INTEGRATION_STEP_NAME}' step in desktop-build.yml, not the pure-module matrix`,
  },
};

/** The complement of the deny-list: exempted files, i.e. the domain the integration step must play. */
export function exemptedFiles(files: string[], exemptions: Exemptions = EXEMPTIONS): string[] {
  return files.filter((f) => isExempt(f, exemptions));
}

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
 * after removing exempted files entirely: they are never run by THIS
 * partition (N1, reviewer 2026-08-24: the "Bun tests (pure modules)" step
 * is not for integration suites). Card f4a3ed1e (2026-08-28) closed the gap
 * this comment used to describe -- exempted files used to run in NO CI job
 * at all; they are now run by the companion "Bun tests (integration)" step
 * (scripts/partition-integration-tests.ts), which calls exemptedFiles()
 * (this same module) for its own domain. `readSource` is injectable so
 * tests can exercise this against synthetic in-memory sources without
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

// Card f4a3ed1e: same discipline for the new integration step, so
// auditExemptionLocations (below) can tell "names a real step" apart from
// "names a real step that runs the WRONG command" -- a step name alone is
// not verification, see that function's header.
export const INTEGRATION_PARTITION_SCRIPT_COMMAND = "bun scripts/partition-integration-tests.ts";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locates and bounds the step whose `name:` is exactly `stepName`, returning
 * its full text (name line through the line before the next step marker, or
 * end of file). Bounded to end at the next step item (a line starting
 * `      - ` at the steps list's own indent) -- not just to end of file.
 * Card 0bbac537 sweep, 2026-08-24: this bounded parse used to be duplicated
 * verbatim in tests/desktop-ci-glob-coverage.test.ts AND
 * tests/desktop-commit-closure-check.test.ts, each anchoring the exact same
 * step marker independently -- exactly the "N sites doing the same parsing"
 * shape CLAUDE.md's shared-gating-table rule targets. Extracted here, both
 * files import it via parsePureModuleStepRun below. Search starts at offset
 * 1 into the slice so the step's own leading `- name:` line (which begins
 * the very slice being bounded) is never mistaken for the next step's
 * boundary. Throws (not a test assertion) so this stays usable at module
 * scope, where a broken parse should abort loudly rather than silently
 * produce an empty (or wrong-step) result -- including when `stepName`
 * itself does not exist, which auditExemptionLocations relies on to treat a
 * dangling location claim as unverified.
 *
 * N2, reviewer 2026-08-24: the step-item indentation used to be hardcoded to
 * 6 spaces. Probed: at 4-space indentation the hardcoded boundary regex
 * simply never matches, and the parser silently adopts the NEXT step's
 * `run:` line instead of throwing -- the exact composition failure this
 * function's bounding exists to prevent, reopened by a plain reindent.
 * Deriving the indentation from the actual matched line (walk back to the
 * start of the step marker's own line, measure the whitespace before its
 * `-`) makes the boundary correct at any indentation instead of assuming
 * today's. Card f4a3ed1e: generalized from a hardcoded "Bun tests (pure
 * modules)" literal to an argument, `parsePureModuleStepRun` below is now a
 * thin wrapper so every existing caller keeps compiling unchanged.
 *
 * N4, reviewer 2026-08-28: the marker search used to be a plain
 * `workflowText.indexOf(\`name: ${stepName}\`)` -- a SUBSTRING match, so
 * renaming the step to a superstring of the claimed name (e.g. "Bun tests
 * (integration) [linux only]" while auditExemptionLocations still checks the
 * shorter "Bun tests (integration)") matched anyway, silently, with a
 * `continue-on-error`/`if:` neutralization riding along on the same edit.
 * Anchoring the marker to require an immediate end-of-line (or end of text)
 * right after `stepName`, via a regex instead of indexOf, makes that
 * superstring case throw ("step not found") instead of matching.
 */
function boundStepText(workflowText: string, stepName: string): string {
  const markerRe = new RegExp(`name: ${escapeRegExp(stepName)}[ \\t]*(?:\\r?\\n|$)`);
  const markerMatch = markerRe.exec(workflowText);
  if (!markerMatch) {
    throw new Error(`"name: ${stepName}" step not found (anchored to end of line) in ${WORKFLOW_PATH}`);
  }
  const stepIdx = markerMatch.index;
  const lineStart = workflowText.lastIndexOf("\n", stepIdx) + 1;
  const linePrefix = workflowText.slice(lineStart, stepIdx);
  const dashMatch = linePrefix.match(/^(\s*)-\s*$/);
  if (!dashMatch) {
    throw new Error(`could not derive step-item indentation for "name: ${stepName}" in ${WORKFLOW_PATH} (line prefix: ${JSON.stringify(linePrefix)})`);
  }
  const indent = dashMatch[1]!;
  const rest = workflowText.slice(stepIdx);
  const nextStepBoundary = new RegExp(`\\r?\\n${indent}- `);
  const nextStepOffset = rest.slice(1).search(nextStepBoundary);
  return nextStepOffset === -1 ? rest : rest.slice(0, nextStepOffset + 1);
}

/** The full bounded text of the step named `stepName` (name line through end of its block). Throws if not found. */
export function extractStepText(workflowText: string, stepName: string): string {
  return boundStepText(workflowText, stepName);
}

export function parseNamedStepRun(workflowText: string, stepName: string): string {
  const stepText = boundStepText(workflowText, stepName);
  const runMatch = stepText.match(/run:\s*(.+)/);
  if (!runMatch) {
    throw new Error(`no "run:" line found inside the "name: ${stepName}" step`);
  }
  return runMatch[1].trim();
}

/** Unchanged call sites: parses the "Bun tests (pure modules)" step specifically. */
export function parsePureModuleStepRun(workflowText: string): string {
  return parseNamedStepRun(workflowText, "Bun tests (pure modules)");
}

/** Parses the "Bun tests (integration)" step specifically (card f4a3ed1e). */
export function parseIntegrationStepRun(workflowText: string): string {
  return parseNamedStepRun(workflowText, INTEGRATION_STEP_NAME);
}

// Card f4a3ed1e: matches an exemption reason's location claim in its one
// checkable form (`run by the '<step name>' step`). "elsewhere"/"ailleurs"
// is tracked separately below only as an informational sub-classification
// (the wording of this card's root cause -- "jouees ailleurs" with nothing
// actually playing them) -- it does NOT get a pass for being merely vague
// rather than false: reviewer 2026-08-28 measured that the version of this
// function which only refused a VAGUE claim (and left a claim-free reason
// alone) would not have caught the actual pre-fix wording verbatim
// ("the pure-module matrix is not for integration suites", no "elsewhere",
// no step name) -- that reason made no location claim at all and passed.
const NAMED_STEP_LOCATION_RE = /run by the '([^']+)' step/;
const VAGUE_LOCATION_RE = /\b(elsewhere|ailleurs)\b/i;

export interface ExemptionLocationAudit {
  /** Informational subset of unlocatedReasons: an unfalsifiable "elsewhere"/"ailleurs" claim with no named step (this card's root-cause wording). */
  vagueReasons: string[];
  /** Step names an exemption reason claims, that either do not exist in the workflow or do not run one of the partition scripts this table's complement functions expect. */
  unverifiedSteps: string[];
  /**
   * FAIL-CLOSED FLOOR (reviewer 2026-08-28): every reason must positively
   * name a verifiable step, in the `run by the '<step>' step` form, or it
   * lands here -- whether it is vague ("elsewhere"), silent on location
   * entirely ("flaky on CI, skipped for now"), or anything else that does
   * not match. Before this bucket existed, a claim-free reason was allowed
   * through with nothing flagged; this is the change that makes a NEW
   * exemption with no location claim at all refuse by default instead of
   * passing by omission.
   */
  unlocatedReasons: string[];
}

/**
 * Verifies every exemption reason's location claim against the real
 * workflow text. A reason naming a step must point at one that (a) actually
 * exists (parseNamedStepRun throws otherwise) and (b) actually runs one of
 * the two known partition-script commands -- a real but unrelated step name
 * (e.g. the node-pty rebuild step) is refused just as loudly as a
 * nonexistent one, because a true step name is not by itself verification
 * that IT runs these files. A reason that does not even attempt a named
 * claim is refused too (unlocatedReasons) -- this function now REQUIRES a
 * checkable location claim, it does not merely refuse an unconvincing one.
 */
export function auditExemptionLocations(exemptions: Exemptions, workflowText: string): ExemptionLocationAudit {
  const vagueReasons: string[] = [];
  const unverifiedSteps: string[] = [];
  const unlocatedReasons: string[] = [];
  const allReasons = [...Object.values(exemptions.familyPrefixes), ...Object.values(exemptions.exactFiles)];
  for (const reason of allReasons) {
    const namedMatch = reason.match(NAMED_STEP_LOCATION_RE);
    if (!namedMatch) {
      unlocatedReasons.push(reason);
      if (VAGUE_LOCATION_RE.test(reason)) {
        vagueReasons.push(reason);
      }
      continue;
    }
    const stepName = namedMatch[1]!;
    let runText: string;
    try {
      runText = parseNamedStepRun(workflowText, stepName);
    } catch {
      unverifiedSteps.push(stepName);
      continue;
    }
    if (runText !== PARTITION_SCRIPT_COMMAND && runText !== INTEGRATION_PARTITION_SCRIPT_COMMAND) {
      unverifiedSteps.push(stepName);
    }
  }
  return { vagueReasons, unverifiedSteps, unlocatedReasons };
}
