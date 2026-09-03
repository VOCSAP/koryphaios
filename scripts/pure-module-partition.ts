// Single source of truth for the pure/integration test partition, imported by
// both the runner (partition-pure-tests.ts) and the coverage-audit guard, so
// the two can never diverge.
// A deny-list (EXEMPTIONS) fails closed: a new file is run by default and an
// exemption must justify itself, unlike an allow-list where an unlisted file is
// silently never collected.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Exemptions {
  familyPrefixes: Record<string, string>;
  exactFiles: Record<string, string>;
}

// Each exemption's reason string must name the exact step that runs it, in the
// form "run by the '<step>' step" -- a checkable claim that
// auditExemptionLocations verifies against the real workflow text, rather than
// trusting free-text prose.
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
 * Excludes exempted files entirely -- they run under the companion integration
 * step (scripts/partition-integration-tests.ts) via exemptedFiles(), never
 * under this partition.
 * readSource is injectable so tests can exercise this against synthetic
 * in-memory sources without touching disk.
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
 * Bounds a step's text to the next step-item line, deriving the boundary
 * indentation from the matched step's own line rather than assuming a fixed
 * indent.
 * The marker match requires stepName to be followed immediately by end of line,
 * so a superstring rename does not silently match the shorter claimed name.
 * Throws rather than returning an empty or wrong-step result on no match,
 * including when stepName does not exist at all, so a broken parse never passes
 * silently.
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

// A vague location claim ("elsewhere"/"ailleurs") and a claim-free reason both
// fail this check equally -- vagueness is tracked separately only as an
// informational sub-classification, never a pass.
const NAMED_STEP_LOCATION_RE = /run by the '([^']+)' step/;
const VAGUE_LOCATION_RE = /\b(elsewhere|ailleurs)\b/i;

export interface ExemptionLocationAudit {
  /** Informational subset of unlocatedReasons: an unfalsifiable "elsewhere"/"ailleurs" claim with no named step (this card's root-cause wording). */
  vagueReasons: string[];
  /** Step names an exemption reason claims, that either do not exist in the workflow or do not run one of the partition scripts this table's complement functions expect. */
  unverifiedSteps: string[];
  /**
   * Catches any reason that does not positively name a verifiable step in the
   * "run by the '<step>' step" form -- vague, silent on location, or otherwise
   * unmatched -- so a location-free reason fails by default instead of passing
   * by omission.
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
