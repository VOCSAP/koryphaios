// The pure-module CI step runs scripts/partition-pure-tests.ts, which
// enumerates every tests/*.test.ts file and excludes only what EXEMPTIONS names
// -- a deny-list that fails closed, since an unlisted new file runs by default.
// EXEMPTIONS itself is imported from scripts/pure-module-partition.ts rather
// than redefined here, so there is one copy of the gating table.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import ts from "typescript6";
import {
  EXEMPTIONS,
  isExempt,
  listTestFiles,
  partitionTests,
  staleExemptions,
  PARTITION_SCRIPT_COMMAND,
  parsePureModuleStepRun,
  WORKFLOW_PATH,
  type Exemptions,
  INTEGRATION_STEP_NAME,
  INTEGRATION_PARTITION_SCRIPT_COMMAND,
  parseIntegrationStepRun,
  parseNamedStepRun,
  extractStepText,
  exemptedFiles as computeExemptedFiles,
  auditExemptionLocations,
  DAEMON_REASON_MARKER,
  NATIVE_DEPS_REASON_MARKER,
} from "../scripts/pure-module-partition.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const TESTS_DIR = join(REPO_ROOT, "tests");

function exemptedFiles(exemptions: Exemptions, files: string[]): string[] {
  return files.filter((f) => isExempt(f, exemptions));
}

/**
 * Card b33b1874's inverse audit, carried over: a file that is NOT exempt but
 * really imports the broker-spawning helper is a daemon-spawning integration
 * test running unflagged inside the pure-module partition. "Collected" is
 * now "non-exempt" (clean + contaminated), not "matched by a glob".
 */
function importsHelperBroker(source: string): boolean {
  return /from\s+["']\.\/_helper(?:\.ts)?["']/.test(source);
}

function nonExemptFiles(exemptions: Exemptions, files: string[]): string[] {
  return files.filter((f) => !isExempt(f, exemptions));
}

function wronglyIncludedFiles(exemptions: Exemptions, files: string[], readSource: (file: string) => string): string[] {
  return nonExemptFiles(exemptions, files).filter((f) => importsHelperBroker(readSource(f)));
}

const REAL_WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, "utf-8");
const REAL_STEP_RUN = parsePureModuleStepRun(REAL_WORKFLOW_TEXT);
const REAL_FILES = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts"));

// Frozen snapshot of the retired allow-list's glob patterns, independent of the
// live workflow text, so the neutrality comparison below stays meaningful after
// that line is removed from the workflow.
const FROZEN_PRE_MIGRATION_GLOBS = [
  "tests/desktop-*.test.ts",
  "tests/notify-*.test.ts",
  "tests/mobile-shell-*.test.ts",
  "tests/cli-*.test.ts",
  "tests/config-*.test.ts",
  "tests/approval-identity.test.ts",
  "tests/peer-*.test.ts",
  "tests/graph-*.test.ts",
  "tests/logger.test.ts",
  "tests/roadmap-*.test.ts",
  "tests/migrate-project-key-case.test.ts",
  "tests/project-key-normalize.test.ts",
];

// Frozen alongside the retired globs: the exact test filenames on disk the day
// this migration landed.
// The neutrality check below intersects this snapshot with today's files, so a
// file added or removed afterward never enters the comparison.
const SNAPSHOT_FILES_2026_08_24 = [
  "approval-hook.test.ts","approval-identity.test.ts","broker-activity-status.test.ts","broker-announce.test.ts","broker-approval-reply.test.ts","broker-approvals.test.ts","broker-channels.test.ts","broker-cross-host-cleanup.test.ts","broker-cross-host-register.test.ts","broker-desktop-roadmap-service.test.ts","broker-expects-reply-delivery.test.ts","broker-fk-cleanup.test.ts","broker-flush-cap.test.ts","broker-graph-drafts.test.ts","broker-groups.test.ts","broker-logging.test.ts","broker-message-ttl.test.ts","broker-migration.test.ts","broker-ntfy-channel.test.ts","broker-operator-inbox.test.ts","broker-project-key-alignment.test.ts","broker-register-body.test.ts","broker-resume.test.ts","broker-roadmap-append.test.ts","broker-roadmap-author-auth.test.ts","broker-roadmap-context.test.ts","broker-roadmap-directive.test.ts","broker-roadmap-import.test.ts","broker-roadmap-inactive.test.ts","broker-roadmap-lock-grace.test.ts","broker-roadmap-lock-park-release.test.ts","broker-roadmap-lock-park-tz.test.ts","broker-roadmap-lock.test.ts","broker-roadmap-operator-id.test.ts","broker-roadmap-parked-archive.test.ts","broker-roadmap-queue.test.ts","broker-roadmap-reorder.test.ts","broker-roadmap-route-coverage.test.ts","broker-roadmap-search.test.ts","broker-roadmap.test.ts","broker-send-ack.test.ts","broker-sentinel-processing.test.ts","broker-set-id.test.ts","broker-status.test.ts","broker-sweep-inactive.test.ts","broker-websocket.test.ts","broker-ws-auth.test.ts","broker-ws-sentinel-auth.test.ts","cli-roadmap-add-no-token.test.ts","config-force-group.test.ts","config-loopback.test.ts","desktop-agent-stop-visibility.test.ts","desktop-agent-stop.test.ts","desktop-announce.test.ts","desktop-approval-add-logging.test.ts","desktop-approval-arm-unconditional.test.ts","desktop-approval-defer.test.ts","desktop-approval-parity.test.ts","desktop-approval-runtime-project-key.test.ts","desktop-approval-runtime.test.ts","desktop-approval-scope-discipline.test.ts","desktop-approval-scope.test.ts","desktop-approval-service-project-key.test.ts","desktop-approval-verdict.test.ts","desktop-approvals.test.ts","desktop-attention.test.ts","desktop-broker-client.test.ts","desktop-broker-health.test.ts","desktop-browser-drive.test.ts","desktop-checkpoint.test.ts","desktop-ci-glob-coverage.test.ts","desktop-clear-backchannel.test.ts","desktop-code-lang.test.ts","desktop-code-selection.test.ts","desktop-commit-closure-check.test.ts","desktop-companion.test.ts","desktop-confirm-dialog-autofocus.test.ts","desktop-context-wand.test.ts","desktop-css-tokens.test.ts","desktop-data-migration.test.ts","desktop-deck-control.test.ts","desktop-deck-plugin-agent-refs.test.ts","desktop-deckapi-producer-coverage.test.ts","desktop-demo-control.test.ts","desktop-demo-driver.test.ts","desktop-design-endpoint-sanitize.test.ts","desktop-desk-session.test.ts","desktop-diff.test.ts","desktop-digest.test.ts","desktop-directive.test.ts","desktop-discovery.test.ts","desktop-dispatch.test.ts","desktop-docs.test.ts","desktop-electron-builder-resources.test.ts","desktop-element-pick.test.ts","desktop-explorer-selection-dom.test.ts","desktop-explorer.test.ts","desktop-external-url.test.ts","desktop-features.test.ts","desktop-graph-adapters.test.ts","desktop-graph-core.test.ts","desktop-graph-engine.test.ts","desktop-graph-layout.test.ts","desktop-graph-store.test.ts","desktop-happy-dom-teardown.test.ts","desktop-help.test.ts","desktop-hold-gesture.test.ts","desktop-i18n.test.ts","desktop-inbox-ack.test.ts","desktop-inbox-migration-seed.test.ts","desktop-inbox-purge-coverage.test.ts","desktop-inbox-sender-dom.test.ts","desktop-inbox-sender.test.ts","desktop-inbox-session.test.ts","desktop-inbox-store.test.ts","desktop-inject-command-modal-guard.test.ts","desktop-inject-command-write-check.test.ts","desktop-journal.test.ts","desktop-launch-approval.test.ts","desktop-launch.test.ts","desktop-log.test.ts","desktop-magic-compact.test.ts","desktop-markdown.test.ts","desktop-model-registry.test.ts","desktop-models-catalog.test.ts","desktop-nav-badge-producer.test.ts","desktop-oauth-url.test.ts","desktop-palette.test.ts","desktop-peer-table.test.ts","desktop-peer-thinking.test.ts","desktop-pick-report.test.ts","desktop-pick-security.test.ts","desktop-pick-shot.test.ts","desktop-provider-secrets.test.ts","desktop-pty-coalescing.test.ts","desktop-quota-gate.test.ts","desktop-quota.test.ts","desktop-recording.test.ts","desktop-reorder.test.ts","desktop-roadmap-project-key.test.ts","desktop-roadmap-reorder-validate.test.ts","desktop-roadmap-sanitize.test.ts","desktop-sandbox-command.test.ts","desktop-sandbox-copy.test.ts","desktop-sandbox-projection.test.ts","desktop-sandbox-protect.test.ts","desktop-sandbox-service.test.ts","desktop-sandbox-store.test.ts","desktop-scope-secrets.test.ts","desktop-scope.test.ts","desktop-screen-model.test.ts","desktop-search-core.test.ts","desktop-session-broadcast.test.ts","desktop-session-kind.test.ts","desktop-sidebar-autoresume-dom.test.ts","desktop-snippet-store.test.ts","desktop-startup-ack.test.ts","desktop-team-embedded.test.ts","desktop-template-store.test.ts","desktop-template.test.ts","desktop-templates-composer-draft-reset.test.ts","desktop-templates-composer-seed.test.ts","desktop-test-hygiene.test.ts","desktop-tile-area.test.ts","desktop-tsconfig-flags.test.ts","desktop-usage.test.ts","desktop-utility-inference.test.ts","desktop-workflow-queue-source.test.ts","desktop-workflow.test.ts","desktop-workspace-empty-snapshot.test.ts","desktop-workspace-freshdir.test.ts","desktop-workspace-runtime.test.ts","desktop-workspace.test.ts","desktop-worktree.test.ts","graph-draft.test.ts","logger.test.ts","mcp-roadmap-ack.test.ts","migrate-project-key-case.test.ts","mobile-shell-approvals.test.ts","mobile-shell-hosts.test.ts","mobile-shell-ntfy-client.test.ts","notify-format.test.ts","notify-ntfy-protocol.test.ts","notify-ntfy.test.ts","notify-registry.test.ts","peer-cache.test.ts","peer-inbound-framing.test.ts","peer-mcp-surface-budget.test.ts","peer-message-framing.test.ts","peer-sentinel-auth.test.ts","project-key-normalize.test.ts","roadmap-append.test.ts","roadmap-lock.test.ts","roadmap-parked-archive-predicate.test.ts","roadmap-project-key.test.ts","server-ask-operator.test.ts","server-inbound-framing-delivery.test.ts","server-roadmap-inactive-marker.test.ts","server-stdin-eof.test.ts",
];

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function matchesAnyGlob(file: string, globs: string[]): boolean {
  const regexes = globs.map(globToRegex);
  return regexes.some((r) => r.test(`tests/${file}`));
}

// Extracted with a bounded parse rather than a naive substring search: the
// workflow's own header comment mentions the script name in prose, which
// `.includes()` would wrongly accept even if the invoking step vanished.
const COMMIT_CLOSURE_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "commit-closure.yml");
// Normalized to LF: a CRLF checkout would otherwise desync the bare
// `\n`-anchored lookahead this parser uses.
// The current assertion here is tolerant enough that this is preventive, not a
// fix to an active defect.
const REAL_COMMIT_CLOSURE_TEXT = readFileSync(COMMIT_CLOSURE_WORKFLOW_PATH, "utf-8").replace(/\r\n/g, "\n");

/**
 * Bounds the `on:` block to end at the next column-0 (unindented) key line,
 * mirroring parsePureModuleStepRun's own step-bounding discipline above.
 * Search starts at offset 1 into the slice so the `on:` line itself (which
 * begins the slice being bounded) is never mistaken for its own terminator.
 */
function extractOnBlock(workflowText: string): string {
  const onIdx = workflowText.search(/^on:/m);
  if (onIdx === -1) {
    throw new Error(`no "on:" block found in ${COMMIT_CLOSURE_WORKFLOW_PATH}`);
  }
  const rest = workflowText.slice(onIdx);
  const nextTopLevelOffset = rest.slice(1).search(/\r?\n[a-zA-Z]/);
  return nextTopLevelOffset === -1 ? rest : rest.slice(0, nextTopLevelOffset + 1);
}

/**
 * Splits the workflow text at every `run:` occurrence and bounds each
 * resulting slice to the next step-item marker (the same `      - ` pattern
 * parsePureModuleStepRun bounds against), so a `run:` block cannot absorb a
 * later step's text. Returns true only if a bounded `run:` slice contains
 * the actual invocation `bun scripts/check-commit-closure.ts` -- a mention
 * of the bare path elsewhere (e.g. this workflow's own top-of-file comment)
 * lives before the first `run:` and is discarded by the `slice(1)` below,
 * so it can never satisfy this check.
 */
function anyStepRunInvokesCommitClosureScript(workflowText: string): boolean {
  const runBlocks = workflowText.split(/(?=\n\s*run:)/);
  return runBlocks.slice(1).some((block) => {
    const nextStepOffset = block.slice(1).search(/\r?\n {6}- /);
    const bounded = nextStepOffset === -1 ? block : block.slice(0, nextStepOffset + 1);
    return /bun\s+scripts\/check-commit-closure\.ts/.test(bounded);
  });
}

test("the pure-module step's run: line invokes exactly the partition script (bounded parse, fails closed if the step is renamed/removed)", () => {
  expect(REAL_STEP_RUN).toBe(PARTITION_SCRIPT_COMMAND);
});

test("bounded parse does not adopt a LATER step's run: line (the composition case that failed open under the retired glob parser)", () => {
  // Reformat this step's run to a YAML block scalar (an ordinary edit -- the
  // step's own single-line match then legitimately changes) while a LATER
  // step runs something else. This constructs that exact composition and
  // asserts the bounded parser does NOT read into the later step.
  const synthetic = `
    steps:
      - name: Bun tests (pure modules)
        shell: bash
        run: |
          bun scripts/partition-pure-tests.ts
      - name: Some later step
        shell: bash
        run: bun run should-not-leak-into-the-parsed-result.ts
`;
  const result = parsePureModuleStepRun(synthetic);
  expect(result).not.toContain("should-not-leak-into-the-parsed-result.ts");
});

test("mutation proof, N2: the bounded parse derives its step-item indentation instead of hardcoding it -- correct at a DIFFERENT indent level too", () => {
  // Constructs the step at 4-space indentation to prove the parser derives its
  // boundary from the marker's own indent rather than assuming a fixed depth.
  const fourSpaceIndent = `
  steps:
    - name: Bun tests (pure modules)
      shell: bash
      run: bun scripts/partition-pure-tests.ts
    - name: Some later step
      shell: bash
      run: bun run should-not-leak-at-four-space-indent.ts
`;
  expect(parsePureModuleStepRun(fourSpaceIndent)).not.toContain("should-not-leak-at-four-space-indent.ts");
  expect(parsePureModuleStepRun(fourSpaceIndent)).toBe(PARTITION_SCRIPT_COMMAND);
});

test("D1: listTestFiles(TESTS_DIR) -- the production enumeration scripts/partition-pure-tests.ts and partitionTests both consume -- matches this guard's own independent readdirSync count", () => {
  // REAL_FILES is computed independently of listTestFiles via its own
  // readdirSync, so a truncation inside the production enumeration shows up as
  // a mismatch here instead of both sides silently agreeing on a shrunk count.
  expect(listTestFiles(TESTS_DIR).length).toBe(REAL_FILES.length);
});

test("this file itself is not exempted (so it is part of the enforced partition)", () => {
  expect(isExempt("desktop-ci-glob-coverage.test.ts", EXEMPTIONS)).toBe(false);
});

test("every exemption reason is a real, non-trivial explanation (not a placeholder)", () => {
  for (const reason of Object.values(EXEMPTIONS.familyPrefixes)) {
    expect(reason.length).toBeGreaterThan(15);
  }
  for (const reason of Object.values(EXEMPTIONS.exactFiles)) {
    expect(reason.length).toBeGreaterThan(15);
  }
});

// auditExemptionLocations is fail-closed: every exemption reason must
// positively name a verifiable workflow step, or it is refused, whether the
// reason is vague, silent, or simply wrong.

test("scripts/partition-integration-tests.ts actually exists on disk (the workflow already references it; a git-add-forgot new file is invisible to a run:-string check alone)", () => {
  expect(existsSync(join(REPO_ROOT, "scripts", "partition-integration-tests.ts"))).toBe(true);
});

test("the integration step's run: line invokes exactly the integration partition script (bounded parse, same discipline as the pure-module step)", () => {
  expect(parseIntegrationStepRun(REAL_WORKFLOW_TEXT)).toBe(INTEGRATION_PARTITION_SCRIPT_COMMAND);
});

test("the integration step carries no continue-on-error / if: neutralization (present, not decorative)", () => {
  const stepText = extractStepText(REAL_WORKFLOW_TEXT, INTEGRATION_STEP_NAME);
  expect(stepText).not.toMatch(/continue-on-error/);
  expect(stepText).not.toMatch(/^\s*if:/m);
});

test("the workflow has no display-server dependency before the mandatory Electron integration step", () => {
  expect(REAL_WORKFLOW_TEXT).not.toContain("Xvfb");
  expect(REAL_WORKFLOW_TEXT).not.toContain("DISPLAY=:99");
  expect(REAL_WORKFLOW_TEXT).not.toContain("/tmp/.X11-unix");
});

test("mutation proof, N4 (reviewer 2026-08-28): a step renamed to a SUPERSTRING of the claimed name is NOT matched -- the marker is anchored to end-of-line, not a substring search", () => {
  // The exact composition the reviewer measured: renaming the step to carry
  // an OS qualifier while adding a conditional -- a continue-on-error/if:
  // neutralization riding along on the same edit that breaks the name match
  // -- used to still match under a plain indexOf(`name: ${stepName}`).
  const synthetic = `
    steps:
      - name: ${INTEGRATION_STEP_NAME} [linux only]
        if: runner.os == 'Linux'
        shell: bash
        run: bun scripts/partition-integration-tests.ts
`;
  expect(() => parseNamedStepRun(synthetic, INTEGRATION_STEP_NAME)).toThrow();
});

test("mutation proof: the anchored marker still matches the ORDINARY, unmutated step name (the N4 fix does not over-tighten)", () => {
  const synthetic = `
    steps:
      - name: ${INTEGRATION_STEP_NAME}
        shell: bash
        run: bun scripts/partition-integration-tests.ts
`;
  expect(parseNamedStepRun(synthetic, INTEGRATION_STEP_NAME)).toBe(INTEGRATION_PARTITION_SCRIPT_COMMAND);
});

test("every currently-exempted file is exactly the domain the integration step's own script computes (no drift between the deny-list and its complement runner)", () => {
  const fromExemptions = computeExemptedFiles(REAL_FILES, EXEMPTIONS).sort();
  const { clean, contaminated } = partitionTests(REAL_FILES, EXEMPTIONS);
  const nonExempt = new Set([...clean, ...contaminated]);
  const complementOfNonExempt = REAL_FILES.filter((f) => !nonExempt.has(f)).sort();
  expect(fromExemptions).toEqual(complementOfNonExempt);
});

test("discipline: every exemption reason's location claim is verifiable against the real CI workflow (no dangling step name, no unrelated-but-real step name, no unlocated reason)", () => {
  const { vagueReasons, unverifiedSteps, unlocatedReasons } = auditExemptionLocations(EXEMPTIONS, REAL_WORKFLOW_TEXT);
  expect(vagueReasons).toEqual([]);
  expect(unverifiedSteps).toEqual([]);
  expect(unlocatedReasons).toEqual([]);
});

test("mutation proof, RED-FIRST -- the ACTUAL historical formulation (verbatim, per git show HEAD~N:scripts/pure-module-partition.ts before card f4a3ed1e) makes no location claim at all and is refused", () => {
  // The historical reason claims no location at all -- not vague, not named --
  // so a checker that only rejects vague wording like 'elsewhere' would still
  // miss it.
  const historicalReason = "spawns a daemon and binds ports; the pure-module matrix is not for integration suites";
  const mutated: Exemptions = {
    familyPrefixes: { "broker-": historicalReason, "server-": historicalReason },
    exactFiles: {
      "approval-hook.test.ts": historicalReason,
      "mcp-roadmap-ack.test.ts": historicalReason,
    },
  };
  const { unlocatedReasons, vagueReasons } = auditExemptionLocations(mutated, REAL_WORKFLOW_TEXT);
  expect(unlocatedReasons).toContain(historicalReason);
  expect(vagueReasons).not.toContain(historicalReason); // not vague-worded, just silent -- both must still be caught
});

test("mutation proof, forme voisine du bug historique: a reason claiming the work is done 'elsewhere' with no named step is refused (both as vague AND as unlocated)", () => {
  const reason = "spawns a daemon and binds ports; the integration suites are run elsewhere";
  const mutated: Exemptions = {
    familyPrefixes: { ...EXEMPTIONS.familyPrefixes, "fake-": reason },
    exactFiles: EXEMPTIONS.exactFiles,
  };
  const { vagueReasons, unlocatedReasons } = auditExemptionLocations(mutated, REAL_WORKFLOW_TEXT);
  expect(vagueReasons).toContain(reason);
  expect(unlocatedReasons).toContain(reason);
});

test("mutation proof: a reason making no location claim at all, not even vague wording, is still refused by the fail-closed floor", () => {
  const reason = "flaky on CI, skipped for now";
  const mutated: Exemptions = {
    familyPrefixes: { ...EXEMPTIONS.familyPrefixes, "fake-": reason },
    exactFiles: EXEMPTIONS.exactFiles,
  };
  const { unlocatedReasons, vagueReasons } = auditExemptionLocations(mutated, REAL_WORKFLOW_TEXT);
  expect(unlocatedReasons).toContain(reason);
  expect(vagueReasons).not.toContain(reason);
});

test("mutation proof: a reason naming a step that does not exist in the workflow is refused", () => {
  const mutated: Exemptions = {
    familyPrefixes: { ...EXEMPTIONS.familyPrefixes, "fake-": "spawns a daemon; run by the 'Nonexistent Step' step in desktop-build.yml" },
    exactFiles: EXEMPTIONS.exactFiles,
  };
  const { unverifiedSteps } = auditExemptionLocations(mutated, REAL_WORKFLOW_TEXT);
  expect(unverifiedSteps).toContain("Nonexistent Step");
});

test("mutation proof: a reason naming a REAL step that does not run the exempted files is refused (a true step name alone is not verification)", () => {
  const mutated: Exemptions = {
    familyPrefixes: { ...EXEMPTIONS.familyPrefixes, "fake-": "spawns a daemon; run by the 'Rebuild node-pty (ABI gate)' step in desktop-build.yml" },
    exactFiles: EXEMPTIONS.exactFiles,
  };
  const { unverifiedSteps } = auditExemptionLocations(mutated, REAL_WORKFLOW_TEXT);
  expect(unverifiedSteps).toContain("Rebuild node-pty (ABI gate)");
});

test("mutation proof: a reason naming the real integration step, running the real integration command, is accepted (positive control -- the checker does not just refuse everything)", () => {
  const mutated: Exemptions = {
    familyPrefixes: { "fake-": `spawns a daemon; run by the '${INTEGRATION_STEP_NAME}' step in desktop-build.yml` },
    exactFiles: {},
  };
  const { vagueReasons, unverifiedSteps, unlocatedReasons } = auditExemptionLocations(mutated, REAL_WORKFLOW_TEXT);
  expect(vagueReasons).toEqual([]);
  expect(unverifiedSteps).toEqual([]);
  expect(unlocatedReasons).toEqual([]);
});

/** The reason string EXEMPTIONS actually assigns to an exempted file, whichever table matched. */
function reasonFor(file: string, exemptions: Exemptions): string {
  if (file in exemptions.exactFiles) return exemptions.exactFiles[file]!;
  const prefix = Object.keys(exemptions.familyPrefixes).find((p) => file.startsWith(p));
  if (prefix === undefined) throw new Error(`${file} is exempt but matches neither exactFiles nor familyPrefixes`);
  return exemptions.familyPrefixes[prefix]!;
}

/**
 * Verifies the file's real source proves the ONE property its reason
 * claims, from the closed two-marker vocabulary. Both markers present means
 * both properties get checked, not one silently skipping the other; neither
 * marker present is itself a failure, not a pass by omission.
 */
function unmetReasonClaims(file: string, reason: string, source: string): string[] {
  const claimsDaemon = reason.includes(DAEMON_REASON_MARKER);
  const claimsNativeDeps = reason.includes(NATIVE_DEPS_REASON_MARKER);
  const unmet: string[] = [];
  if (!claimsDaemon && !claimsNativeDeps) {
    unmet.push(`${file}: reason names neither the daemon/port marker nor the native-deps marker`);
  }
  if (claimsDaemon && !/startBroker|_helper/.test(source)) {
    unmet.push(`${file}: reason claims daemon/port but the source matches neither startBroker nor _helper`);
  }
  if (claimsNativeDeps && !scanDesktopDependency(file, source).some((f) => DEFINITE_KINDS.has(f.kind))) {
    unmet.push(
      `${file}: reason claims native desktop/node_modules dep but the path scanner finds no desktop dependency in the source ` +
        `(a form it does not evaluate: see KNOWN_LIMITS)`,
    );
  }
  return unmet;
}

test("every exempted file proves the ONE property its reason claims (daemon/port via startBroker|_helper, or a native desktop/node_modules dep via the path scanner)", () => {
  const files = exemptedFiles(EXEMPTIONS, REAL_FILES);
  expect(files.length).toBeGreaterThan(0);
  const allUnmet = files.flatMap((f) => {
    const source = readFileSync(join(TESTS_DIR, f), "utf-8");
    return unmetReasonClaims(f, reasonFor(f, EXEMPTIONS), source);
  });
  expect(allUnmet).toEqual([]);
});

test("mutation proof: an exempted file wrongly claiming the daemon/port property is caught (does not spawn a broker)", () => {
  const noBrokerFile = "logger.test.ts";
  const source = readFileSync(join(TESTS_DIR, noBrokerFile), "utf-8");
  expect(source).not.toMatch(/startBroker|_helper/);
  const reason = `${DAEMON_REASON_MARKER}; placeholder location clause long enough to pass the length check`;
  expect(unmetReasonClaims(noBrokerFile, reason, source)).toContain(
    `${noBrokerFile}: reason claims daemon/port but the source matches neither startBroker nor _helper`,
  );
});

test("mutation proof: an exempted file wrongly claiming the native-deps property is caught (no desktop/node_modules path segment)", () => {
  const noNativeDepsFile = "logger.test.ts";
  const source = readFileSync(join(TESTS_DIR, noNativeDepsFile), "utf-8");
  expect(scanDesktopDependency(noNativeDepsFile, source)).toEqual([]);
  const reason = `${NATIVE_DEPS_REASON_MARKER}; placeholder location clause long enough to pass the length check`;
  const unmet = unmetReasonClaims(noNativeDepsFile, reason, source);
  expect(unmet.some((m) => m.startsWith(`${noNativeDepsFile}: reason claims native desktop/node_modules dep`))).toBe(true);
});

test("mutation proof: a reason naming NEITHER the daemon/port nor the native-deps marker is refused, not accepted by omission", () => {
  const anyFile = "logger.test.ts";
  const source = readFileSync(join(TESTS_DIR, anyFile), "utf-8");
  const unlabelledReason = "placeholder reason, long enough, names no verifiable property at all";
  expect(unmetReasonClaims(anyFile, unlabelledReason, source)).toContain(
    `${anyFile}: reason names neither the daemon/port marker nor the native-deps marker`,
  );
});

// A non-exempt file that reaches desktop/node_modules for a reason other than
// "belongs in the integration step" is named here. Neither entry is exempted:
// each skips its own affected tests, by name, when the dependency is absent.
const NATIVE_DEPS_ALLOWED_NONEXEMPT: Record<string, string> = {
  "desktop-pty-coalescing.test.ts":
    "spawns desktop/node_modules/electron directly for a live ConPTY probe, itself skipped by name on a platform or node-pty build that cannot run it",
  "desktop-inbox-ack.test.ts":
    "spawns desktop/node_modules/.bin/tsc directly for two compile-discipline tests, itself skipped by name when desktop/node_modules is not installed",
};

test("the allow-list itself carries no stale entry (each named file still exists and still reaches desktop/node_modules)", () => {
  for (const f of Object.keys(NATIVE_DEPS_ALLOWED_NONEXEMPT)) {
    expect(REAL_FILES).toContain(f);
    const findings = scanDesktopDependency(f, readFileSync(join(TESTS_DIR, f), "utf-8"));
    expect(findings.some((x) => DEFINITE_KINDS.has(x.kind)), `${f}: allow-listed but the scanner finds no dependency`).toBe(true);
  }
});

// Paths are evaluated, never pattern-matched. A path it cannot evaluate that
// runs through node_modules, a call it cannot resolve handed a node_modules
// literal, and an import() specifier it cannot read are findings; the forms it
// does not read at all are the KNOWN_LIMITS fixtures.

type FindingKind =
  | "desktop-node-modules"
  | "desktop-toolchain-config"
  | "desktop-resolution-base"
  | "desktop-package-runner"
  | "unevaluable-node-modules"
  | "unevaluable-resolution"
  | "unparseable";

const DEFINITE_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  "desktop-node-modules",
  "desktop-toolchain-config",
  "desktop-resolution-base",
  "desktop-package-runner",
]);

interface Finding {
  kind: FindingKind;
  line: number;
  expression: string;
}

type PathAlternatives = string[];
interface Binding {
  inits: ts.Node[] | null;
}
type BindingLookup = (id: ts.Identifier) => Binding | undefined;

const UNKNOWN_SEGMENT = "<unknown>";
const TEMP_ROOT = "<tmp>";
const ALTERNATIVE_CAP = 64;

/** An operand that would push the product past the cap is replaced by UNKNOWN_SEGMENT; the prefix built so far is kept. */
function crossProduct(parts: PathAlternatives[], separator: string): PathAlternatives {
  let acc: PathAlternatives = [""];
  parts.forEach((part, index) => {
    const operand = index > 0 && acc.length * part.length > ALTERNATIVE_CAP ? [UNKNOWN_SEGMENT] : part;
    const next: PathAlternatives = [];
    for (const head of acc) for (const tail of operand) next.push(index === 0 ? tail : head + separator + tail);
    acc = next;
  });
  return acc;
}

/** Arguments with every spread of an array literal unfolded in place. */
function unfoldSpreads(args: readonly ts.Node[], lookup: BindingLookup, depth = 0): ts.Node[] {
  return args.flatMap((arg) => {
    if (depth > 4 || !ts.isSpreadElement(arg)) return [arg];
    const array = arrayLiteralOf(arg.expression, lookup);
    return array === null ? [arg] : unfoldSpreads(array.elements, lookup, depth + 1);
  });
}

function declareBindingNames(name: ts.BindingName, init: ts.Node | undefined, into: Map<string, Binding>): void {
  if (ts.isIdentifier(name)) {
    into.set(name.text, { inits: init === undefined ? [] : [init] });
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) declareBindingNames(element.name, undefined, into);
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) into.set(element.name.text, { inits: null });
  }
}

/**
 * Lexical lookup: the nearest enclosing declaration of an identifier, with the
 * values assigned to it anywhere in the file. A parameter, a destructured name
 * or a compound assignment has no known value (inits null).
 */
function makeBindingLookup(file: ts.SourceFile): BindingLookup {
  const scopes = new Map<ts.Node, Map<string, Binding> | null>();
  const statementsOf = (node: ts.Node): readonly ts.Statement[] | null => {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) return node.statements;
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
    return null;
  };
  const scopeOf = (node: ts.Node): Map<string, Binding> | null => {
    if (scopes.has(node)) return scopes.get(node) ?? null;
    const out = new Map<string, Binding>();
    let declares = false;
    const statements = statementsOf(node);
    if (statements !== null) {
      declares = true;
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
          for (const d of statement.declarationList.declarations) declareBindingNames(d.name, d.initializer, out);
        } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
          out.set(statement.name.text, { inits: [statement] });
        }
      }
    }
    if (ts.isFunctionLike(node)) {
      declares = true;
      for (const parameter of (node as ts.SignatureDeclaration).parameters) {
        const names = new Map<string, Binding>();
        declareBindingNames(parameter.name, undefined, names);
        for (const key of names.keys()) out.set(key, { inits: null });
      }
    }
    if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) && node.initializer !== undefined) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        declares = true;
        for (const d of node.initializer.declarations) {
          const names = new Map<string, Binding>();
          declareBindingNames(d.name, ts.isForStatement(node) ? d.initializer : undefined, names);
          for (const [key, value] of names) out.set(key, ts.isForStatement(node) ? value : { inits: null });
        }
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      declares = true;
      const names = new Map<string, Binding>();
      declareBindingNames(node.variableDeclaration.name, undefined, names);
      for (const key of names.keys()) out.set(key, { inits: null });
    }
    scopes.set(node, declares ? out : null);
    return declares ? out : null;
  };
  const lookup: BindingLookup = (id) => {
    for (let node: ts.Node | undefined = id.parent; node !== undefined; node = node.parent) {
      const hit = scopeOf(node)?.get(id.text);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const collectAssignments = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = lookup(node.left);
      if (target !== undefined && target.inits !== null) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) target.inits.push(node.right);
        else target.inits = null;
      }
    }
    ts.forEachChild(node, collectAssignments);
  };
  collectAssignments(file);
  return lookup;
}

function arrayLiteralOf(expression: ts.Node, lookup: BindingLookup, depth = 0): ts.ArrayLiteralExpression | null {
  if (depth > 8) return null;
  if (ts.isArrayLiteralExpression(expression)) return expression;
  if (ts.isIdentifier(expression)) {
    const binding = lookup(expression);
    return binding?.inits && binding.inits.length === 1 ? arrayLiteralOf(binding.inits[0]!, lookup, depth + 1) : null;
  }
  return null;
}

/** Every string a path expression can take; an operation it does not understand yields UNKNOWN_SEGMENT. */
function evaluatePath(node: ts.Node, lookup: BindingLookup, file: ts.SourceFile, depth = 0): PathAlternatives {
  if (depth > 16) return [UNKNOWN_SEGMENT];
  const next = (child: ts.Node) => evaluatePath(child, lookup, file, depth + 1);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    const parts: PathAlternatives[] = [[node.head.text]];
    for (const span of node.templateSpans) {
      parts.push(next(span.expression));
      parts.push([span.literal.text]);
    }
    return crossProduct(parts, "");
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.PlusToken) return crossProduct([next(node.left), next(node.right)], "");
    return [UNKNOWN_SEGMENT];
  }
  if (ts.isConditionalExpression(node)) return [...next(node.whenTrue), ...next(node.whenFalse)];
  if (ts.isIdentifier(node)) {
    const binding = lookup(node);
    if (binding !== undefined) {
      if (binding.inits === null || binding.inits.length === 0) return [UNKNOWN_SEGMENT];
      return binding.inits.flatMap((init) => next(init));
    }
    return [UNKNOWN_SEGMENT];
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.getText(file) === "import.meta.url") return ["tests/self.test.ts"];
    const owner = node.expression;
    if (
      (node.name.text === "href" || node.name.text === "pathname") &&
      ts.isCallExpression(owner) &&
      ts.isIdentifier(owner.expression) &&
      owner.expression.text === "pathToFileURL" &&
      owner.arguments.length > 0
    ) {
      return next(owner.arguments[0]!);
    }
    return [UNKNOWN_SEGMENT];
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    const args = node.arguments;
    if (ts.isPropertyAccessExpression(callee)) {
      const array = arrayLiteralOf(callee.expression, lookup);
      if (name === "join" && array !== null) {
        const separators = args.length > 0 ? next(args[0]!) : [","];
        const separator = separators.some((s) => s.includes(UNKNOWN_SEGMENT)) ? "/" : (separators[0] ?? "/");
        return crossProduct(array.elements.map(next), separator);
      }
    }
    const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(file) : null;
    if (ts.isIdentifier(callee) && lookup(callee) !== undefined) return [UNKNOWN_SEGMENT];
    const isPathCall = receiver === null || receiver === "path";
    if (isPathCall && (name === "join" || name === "resolve")) {
      return crossProduct(unfoldSpreads(args, lookup).map(next), "/");
    }
    if (callee.getText(file) === "realpathSync.native" && args.length > 0) return next(args[0]!);
    if (name === "mkdtempSync") return [TEMP_ROOT];
    return [UNKNOWN_SEGMENT];
  }
  return [UNKNOWN_SEGMENT];
}

/** Lower-cased: NTFS and APFS do not distinguish case. It over-reports on case-sensitive Linux, the safe direction. */
function pathSegments(alternative: string): string[] {
  const out: string[] = [];
  for (const raw of alternative.split(/[\\/]+/)) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      out.pop();
      continue;
    }
    out.push(raw.toLowerCase());
  }
  return out;
}

const isUnknownSegment = (segment: string): boolean => segment.includes(UNKNOWN_SEGMENT);

function classifyPath(alternative: string): FindingKind | null {
  const segments = pathSegments(alternative);
  const modules = segments.indexOf("node_modules");
  if (modules >= 0) {
    const prefix = segments.slice(0, modules);
    if (prefix.includes("desktop")) return "desktop-node-modules";
    if (prefix.some(isUnknownSegment)) return "unevaluable-node-modules";
    return null;
  }
  const last = segments[segments.length - 1] ?? "";
  if (/^electron\.vite\.config(?:\.[cm]?[jt]s)?$/.test(last) && segments.slice(0, -1).includes("desktop")) {
    return "desktop-toolchain-config";
  }
  return null;
}

// Callees that compare a value or declare test data and never build a path.
const NON_PATH_CALLEES = new Set([
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "expect",
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toContain",
  "toMatch",
  "toThrow",
  "toHaveLength",
  "each",
]);
const SPAWN_CALLEES = new Set(["spawn", "spawnSync", "exec", "execSync", "execFileSync"]);
const PACKAGE_RUNNER_RE = /(?:^|[\\/\s])(?:npm|npx|tsc|electron)(?:\.cmd|\.exe)?(?:\s|$)/i;
const DESKTOP_TOKEN_RE = /(?:^|[\\/\s=])desktop(?:$|[\\/\s])/i;

/** Values handed to a call, arrays and objects opened. */
function literalLeaves(node: ts.Node, lookup: BindingLookup, file: ts.SourceFile, out: PathAlternatives[] = [], depth = 0): PathAlternatives[] {
  if (depth > 6) {
    out.push([UNKNOWN_SEGMENT]);
    return out;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of unfoldSpreads(node.elements, lookup)) literalLeaves(element, lookup, file, out, depth + 1);
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) literalLeaves(property.initializer, lookup, file, out, depth + 1);
    }
    return out;
  }
  out.push(evaluatePath(node, lookup, file));
  return out;
}

function isPureLiteral(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node)) return true;
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => isPureLiteral(span.expression));
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && isPureLiteral(node.left) && isPureLiteral(node.right);
}

/** String literals written directly in an argument list, array literals opened; identifiers and calls are judged where they are defined. */
function handedLiterals(node: ts.Node, lookup: BindingLookup, out: ts.Node[] = [], depth = 0): ts.Node[] {
  if (depth > 4) return out;
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of unfoldSpreads(node.elements, lookup)) handedLiterals(element, lookup, out, depth + 1);
  } else if (isPureLiteral(node)) {
    out.push(node);
  }
  return out;
}

function parseDiagnosticCount(file: ts.SourceFile): number {
  const diagnostics = (file as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
  if (!Array.isArray(diagnostics)) {
    throw new Error("typescript6 no longer exposes SourceFile.parseDiagnostics: the scanner could not tell a broken file from an empty one");
  }
  return diagnostics.length;
}

function scanDesktopDependency(fileName: string, source: string): Finding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lookup = makeBindingLookup(file);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const report = (kind: FindingKind, node: ts.Node, expression?: string) => {
    const at = node.getStart(file);
    if (seen.has(`${kind}:${at}`)) return;
    seen.add(`${kind}:${at}`);
    findings.push({
      kind,
      line: file.getLineAndCharacterOfPosition(at).line + 1,
      expression: expression ?? node.getText(file).replace(/\s+/g, ""),
    });
  };
  if (parseDiagnosticCount(file) > 0) report("unparseable", file, "<unparseable>");

  const visit = (node: ts.Node): void => {
    const buildsPath =
      ts.isStringLiteralLike(node) ||
      ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isCallExpression(node);
    const callArguments = ts.isCallExpression(node) ? unfoldSpreads(node.arguments, lookup) : [];
    if (buildsPath) {
      const kinds = evaluatePath(node, lookup, file).map(classifyPath).filter((k): k is FindingKind => k !== null);
      const chosen = kinds.find((k) => DEFINITE_KINDS.has(k)) ?? kinds[0];
      if (chosen !== undefined) report(chosen, node);
    }
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(file);
      const first = callArguments[0];
      const isCreateRequire = /(?:^|\.)createRequire$/.test(calleeText);
      const isResolver = calleeText === "require.resolve";
      const isDynamicLoad = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isCreateRequire || isResolver || isDynamicLoad) && first !== undefined) {
        const leaves = callArguments.flatMap((a) => literalLeaves(a, lookup, file));
        const desktopBase = leaves.some((alts) => alts.some((alt) => pathSegments(alt).includes("desktop")));
        if (desktopBase && !isDynamicLoad) report("desktop-resolution-base", node);
        if (evaluatePath(first, lookup, file).every((alt) => pathSegments(alt).every(isUnknownSegment))) {
          report("unevaluable-resolution", node);
        }
      }
      const calleeName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
      if (SPAWN_CALLEES.has(calleeName)) {
        const leaves = callArguments.flatMap((a) => literalLeaves(a, lookup, file)).flat();
        if (leaves.some((leaf) => PACKAGE_RUNNER_RE.test(leaf)) && leaves.some((leaf) => DESKTOP_TOKEN_RE.test(leaf))) {
          report("desktop-package-runner", node);
        }
      }
      // A call the scanner cannot resolve (local wrapper, aliased or namespaced
      // join) that is handed a node_modules segment hides a path it cannot read.
      const opaque = evaluatePath(node, lookup, file).every((alt) => alt === UNKNOWN_SEGMENT);
      if (opaque && !NON_PATH_CALLEES.has(calleeName)) {
        const hit = callArguments
          .flatMap((a) => handedLiterals(a, lookup))
          .find((literal) => evaluatePath(literal, lookup, file).some((alt) => pathSegments(alt).includes("node_modules")));
        if (hit !== undefined) report("unevaluable-node-modules", node, `${calleeText}(${hit.getText(file).replace(/\s+/g, "")})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

interface ReviewedOccurrence {
  file: string;
  expression: string;
  count: number;
  reason: string;
}

// Keyed by file + whitespace-free expression text, never by line. Each entry
// is an unevaluable path the scanner cannot decide, read and judged not to
// reach desktop/node_modules; count pins how many occurrences were reviewed.
const UNEVALUABLE_REVIEWED: ReviewedOccurrence[] = [
  {
    file: "mock-module-guard.test.ts",
    expression: 'join(root,"node_modules","pkg","index.ts")',
    count: 1,
    reason: "root comes from miniRepo(), a mkdtemp directory written by the test itself; nothing reads it from desktop/",
  },
  {
    file: "mock-module-guard.test.ts",
    expression: 'write("node_modules/pkg/index.ts")',
    count: 1,
    reason: "write() creates the file under the mkdtemp mini repo root returned by miniRepo()",
  },
  {
    file: "mock-module-guard.test.ts",
    expression: 'resolveMockTarget("../node_modules/pkg/index.ts")',
    count: 1,
    reason: "a specifier resolved against the mkdtemp mini repo; nothing under desktop/ is read",
  },
  {
    file: "desktop-sandbox-copy.test.ts",
    expression: 'planIgnoredCopy("node_modules/**")',
    count: 1,
    reason: "a deny-list glob given to planIgnoredCopy as input, matched against a mkdtemp directory",
  },
  {
    file: "mock-module-guard.test.ts",
    expression: "import(file)",
    count: 1,
    reason: "file ranges over repo project modules; one that transitively reaches electron or shiki is tolerated by MAY_BE_UNIMPORTABLE_IN_RUNNER, not read from desktop/node_modules",
  },
  {
    file: "mock-module-guard.test.ts",
    expression: "import(file(name))",
    count: 1,
    reason: "file(name) is join(SHARED_DIR, name + '.ts') over a fixed module list, all under desktop/src/shared",
  },
];

interface DesktopDependencyAudit {
  definiteOffenders: string[];
  unevaluableOffenders: string[];
  staleReviewed: string[];
}

function auditDesktopDependencies(options: {
  files: string[];
  exemptions: Exemptions;
  allowedNonExempt: Record<string, string>;
  reviewed: ReviewedOccurrence[];
  readSource: (file: string) => string;
}): DesktopDependencyAudit {
  const definiteOffenders: string[] = [];
  const occurrences = new Map<string, { file: string; kind: FindingKind; line: number; expression: string; count: number }>();
  for (const file of options.files) {
    if (isExempt(file, options.exemptions)) continue;
    for (const finding of scanDesktopDependency(file, options.readSource(file))) {
      if (DEFINITE_KINDS.has(finding.kind)) {
        if (!(file in options.allowedNonExempt)) {
          definiteOffenders.push(`${file}:${finding.line} [${finding.kind}] ${finding.expression}`);
        }
        continue;
      }
      const key = JSON.stringify([file, finding.expression]);
      const known = occurrences.get(key);
      if (known === undefined) occurrences.set(key, { file, ...finding, count: 1 });
      else known.count += 1;
    }
  }
  const reviewedByKey = new Map(options.reviewed.map((entry) => [JSON.stringify([entry.file, entry.expression]), entry]));
  const unevaluableOffenders: string[] = [];
  for (const [key, seen] of occurrences) {
    const entry = reviewedByKey.get(key);
    const where = `${seen.file}:${seen.line} [${seen.kind}] ${seen.expression}`;
    if (entry === undefined) unevaluableOffenders.push(`${where} is not in UNEVALUABLE_REVIEWED`);
    else if (entry.count !== seen.count) unevaluableOffenders.push(`${where} occurs ${seen.count} time(s), ${entry.count} reviewed`);
  }
  const staleReviewed = [...reviewedByKey]
    .filter(([key]) => !occurrences.has(key))
    .map(([, entry]) => `${entry.file}: ${entry.expression} no longer occurs`);
  return { definiteOffenders, unevaluableOffenders, staleReviewed };
}

const FIXTURE_DIR = join(TESTS_DIR, "fixtures", "desktop-native-deps");
const readFixture = (name: string): string => readFileSync(join(FIXTURE_DIR, `${name}.fixture.txt`), "utf-8");

interface DetectedForm {
  name: string;
  kinds: FindingKind[];
  findings?: number;
}

const DETECTED_FORMS: DetectedForm[] = [
  { name: "join-triple-binary", kinds: ["desktop-node-modules"] },
  { name: "join-third-segment-outside-regex", kinds: ["desktop-node-modules"] },
  { name: "join-directory-only", kinds: ["desktop-node-modules"] },
  { name: "join-through-desktop-variable", kinds: ["desktop-node-modules"] },
  { name: "resolve-with-deep-parent-segments", kinds: ["desktop-node-modules"] },
  { name: "single-string-third-segment", kinds: ["desktop-node-modules"] },
  { name: "template-string", kinds: ["desktop-node-modules"] },
  { name: "string-concatenation", kinds: ["desktop-node-modules"] },
  { name: "name-held-in-constant", kinds: ["desktop-node-modules"] },
  { name: "array-join-with-separator", kinds: ["desktop-node-modules"] },
  { name: "parent-segment-normalised", kinds: ["desktop-node-modules"] },
  { name: "mixed-case-segments", kinds: ["desktop-node-modules"] },
  { name: "backslash-string", kinds: ["desktop-node-modules"] },
  { name: "name-assigned-in-hook", kinds: ["desktop-node-modules"] },
  { name: "alternation-inside-segment", kinds: ["desktop-node-modules"] },
  { name: "create-require-from-desktop", kinds: ["desktop-resolution-base"] },
  { name: "require-resolve-with-paths", kinds: ["desktop-resolution-base"] },
  { name: "toolchain-config-import", kinds: ["desktop-toolchain-config"] },
  { name: "package-runner-desktop-cwd", kinds: ["desktop-package-runner"] },
  { name: "package-runner-prefix-argv", kinds: ["desktop-package-runner"] },
  { name: "unevaluable-imported-root", kinds: ["unevaluable-node-modules"] },
  { name: "unevaluable-parameter-root", kinds: ["unevaluable-node-modules"] },
  { name: "unevaluable-function-return", kinds: ["unevaluable-node-modules"] },
  { name: "unevaluable-dynamic-import", kinds: ["unevaluable-resolution"] },
  { name: "unparseable-source", kinds: ["unparseable"] },
  { name: "join-operand-explosion-keeps-prefix", kinds: ["desktop-node-modules"] },
  { name: "definite-alternative-wins-over-unknown", kinds: ["desktop-node-modules"], findings: 1 },
  { name: "spread-array-into-join", kinds: ["desktop-node-modules"] },
  { name: "wrapper-local-helper", kinds: ["unevaluable-node-modules"] },
  { name: "wrapper-aliased-import", kinds: ["unevaluable-node-modules"] },
  { name: "wrapper-namespace-import", kinds: ["unevaluable-node-modules"] },
  { name: "wrapper-single-string", kinds: ["desktop-node-modules", "unevaluable-node-modules"] },
  { name: "shadowed-name-resolves-per-scope", kinds: ["unevaluable-node-modules"], findings: 1 },
];

const CLEAN_FORMS = [
  "root-node-modules-binary",
  "temp-directory-node-modules",
  "temp-directory-assigned-in-hook",
  "parent-segment-leaves-desktop",
  "import-of-temp-file-url",
  "name-comparison-only",
  "desktop-source-path",
  "create-require-from-test-file",
  "prose-mention-with-spaces",
  "commented-out-path",
];

// Forms the scanner does not see. Asserting no finding makes a limit that
// stops being one go red, so this list cannot rot into a false claim.
const KNOWN_LIMITS = [
  "limit-cwd-desktop-script",
  "limit-name-built-by-string-method",
  "limit-path-built-in-imported-helper",
  "limit-second-segment-computed",
  "limit-bun-shell-template",
];

const kindsOf = (findings: Finding[]): FindingKind[] => [...new Set(findings.map((f) => f.kind))].sort();

test("every fixture file under tests/fixtures/desktop-native-deps is named by exactly one form table, and every table entry has its file", () => {
  const onDisk = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".fixture.txt"))
    .map((f) => f.slice(0, -".fixture.txt".length))
    .sort();
  const named = [...DETECTED_FORMS.map((f) => f.name), ...CLEAN_FORMS, ...KNOWN_LIMITS].sort();
  expect(named, "a fixture without an expectation proves nothing, an expectation without a fixture is vacuous").toEqual(onDisk);
});

for (const form of DETECTED_FORMS) {
  test(`scanner reports the ${form.name} form as ${form.kinds.join(", ")}`, () => {
    const source = readFixture(form.name);
    const findings = scanDesktopDependency(`${form.name}.fixture.txt`, source);
    expect(kindsOf(findings), `${form.name}: the scanner missed or misclassified this form`).toEqual([...form.kinds].sort());
    if (form.findings !== undefined) expect(findings.length, `${form.name}: wrong number of findings`).toBe(form.findings);
  });
}

for (const name of CLEAN_FORMS) {
  test(`scanner does not flag the ${name} form`, () => {
    expect(scanDesktopDependency(`${name}.fixture.txt`, readFixture(name))).toEqual([]);
  });
}

for (const name of KNOWN_LIMITS) {
  test(`known limit: the ${name} form is not detected`, () => {
    expect(
      scanDesktopDependency(`${name}.fixture.txt`, readFixture(name)),
      `${name}: the scanner now sees this form, so it is no longer a limit; move it to DETECTED_FORMS`,
    ).toEqual([]);
  });
}

test("a non-exempt test file that reaches desktop/node_modules through a variable-held join() path turns the audit red", () => {
  const planted = "desktop-planted-toolchain.test.ts";
  const audit = auditDesktopDependencies({
    files: [planted],
    exemptions: EXEMPTIONS,
    allowedNonExempt: NATIVE_DEPS_ALLOWED_NONEXEMPT,
    reviewed: UNEVALUABLE_REVIEWED,
    readSource: () => readFixture("join-through-desktop-variable"),
  });
  expect(audit.definiteOffenders.some((o) => o.startsWith(`${planted}:`))).toBe(true);
});

test("the same planted file is accepted once it is exempt or allow-listed, so the audit is not red for everything", () => {
  const planted = "desktop-planted-toolchain.test.ts";
  const readSource = () => readFixture("join-through-desktop-variable");
  const exempted = auditDesktopDependencies({
    files: [planted],
    exemptions: { familyPrefixes: {}, exactFiles: { [planted]: "placeholder reason, long enough" } },
    allowedNonExempt: {},
    reviewed: [],
    readSource,
  });
  const allowed = auditDesktopDependencies({
    files: [planted],
    exemptions: { familyPrefixes: {}, exactFiles: {} },
    allowedNonExempt: { [planted]: "placeholder reason, long enough" },
    reviewed: [],
    readSource,
  });
  expect(exempted.definiteOffenders).toEqual([]);
  expect(allowed.definiteOffenders).toEqual([]);
});

const NO_EXEMPTIONS: Exemptions = { familyPrefixes: {}, exactFiles: {} };

test("an unevaluable occurrence is refused until reviewed, and a reviewed one survives a line shift", () => {
  const planted = "desktop-planted-unevaluable.test.ts";
  const source = readFixture("unevaluable-imported-root");
  const run = (text: string, reviewed: ReviewedOccurrence[]) =>
    auditDesktopDependencies({
      files: [planted],
      exemptions: NO_EXEMPTIONS,
      allowedNonExempt: {},
      reviewed,
      readSource: () => text,
    });
  const expression = 'join(TOOLCHAIN_ROOT,"node_modules",".bin","tsc")';
  expect(run(source, []).unevaluableOffenders).toHaveLength(1);
  const reviewed: ReviewedOccurrence[] = [{ file: planted, expression, count: 1, reason: "placeholder reason, long enough" }];
  expect(run(source, reviewed)).toEqual({ definiteOffenders: [], unevaluableOffenders: [], staleReviewed: [] });
  expect(run("\n\n\n" + source, reviewed).unevaluableOffenders, "a reviewed entry keyed by line would break on this shift").toEqual([]);
});

test("a second occurrence of an already reviewed unevaluable expression is refused (count pinned)", () => {
  const planted = "desktop-planted-unevaluable.test.ts";
  const source = readFixture("unevaluable-imported-root");
  const doubled = `${source}\nexport const AGAIN = join(TOOLCHAIN_ROOT, "node_modules", ".bin", "tsc");\n`;
  const audit = auditDesktopDependencies({
    files: [planted],
    exemptions: NO_EXEMPTIONS,
    allowedNonExempt: {},
    reviewed: [
      {
        file: planted,
        expression: 'join(TOOLCHAIN_ROOT,"node_modules",".bin","tsc")',
        count: 1,
        reason: "placeholder reason, long enough",
      },
    ],
    readSource: () => doubled,
  });
  expect(audit.unevaluableOffenders).toHaveLength(1);
  expect(audit.unevaluableOffenders[0]).toContain("occurs 2 time(s), 1 reviewed");
});

test("a new unevaluable expression in a file that already has reviewed ones is refused", () => {
  const file = "mock-module-guard.test.ts";
  const real = readFileSync(join(TESTS_DIR, file), "utf-8");
  const audit = auditDesktopDependencies({
    files: [file],
    exemptions: NO_EXEMPTIONS,
    allowedNonExempt: {},
    reviewed: UNEVALUABLE_REVIEWED,
    readSource: () => `${real}\nexport const EXTRA = join(somewhereElse, "node_modules", "x");\n`,
  });
  expect(audit.unevaluableOffenders.some((o) => o.includes("somewhereElse"))).toBe(true);
});

test("a reviewed entry that matches nothing any more is reported stale", () => {
  const audit = auditDesktopDependencies({
    files: ["logger.test.ts"],
    exemptions: NO_EXEMPTIONS,
    allowedNonExempt: {},
    reviewed: [{ file: "logger.test.ts", expression: "import(vanished)", count: 1, reason: "placeholder reason, long enough" }],
    readSource: (f) => readFileSync(join(TESTS_DIR, f), "utf-8"),
  });
  expect(audit.staleReviewed).toEqual(["logger.test.ts: import(vanished) no longer occurs"]);
});

const vagueReviewedReasons = (reviewed: ReviewedOccurrence[]): string[] =>
  reviewed.filter((entry) => entry.reason.length <= 15).map((entry) => `${entry.file}: ${entry.expression}`);

test("every reviewed unevaluable occurrence carries a real reason, not a placeholder", () => {
  expect(vagueReviewedReasons(UNEVALUABLE_REVIEWED)).toEqual([]);
});

test("a reviewed occurrence whose reason is a placeholder is refused", () => {
  const placeholder: ReviewedOccurrence = { file: "logger.test.ts", expression: "import(x)", count: 1, reason: "reviewed, fine" };
  expect(vagueReviewedReasons([placeholder])).toEqual(["logger.test.ts: import(x)"]);
});

test("every test file reaching desktop/node_modules is exempt or allow-listed, and every path the scanner cannot evaluate is reviewed (no entry stale)", () => {
  const audit = auditDesktopDependencies({
    files: REAL_FILES,
    exemptions: EXEMPTIONS,
    allowedNonExempt: NATIVE_DEPS_ALLOWED_NONEXEMPT,
    reviewed: UNEVALUABLE_REVIEWED,
    readSource: (f) => readFileSync(join(TESTS_DIR, f), "utf-8"),
  });
  expect(audit.definiteOffenders, "depend on desktop/node_modules but run before the desktop install step: exempt them or allow-list with a reason").toEqual([]);
  expect(audit.unevaluableOffenders, "a path the scanner cannot evaluate runs through node_modules or a dynamic specifier: review it into UNEVALUABLE_REVIEWED").toEqual([]);
  expect(audit.staleReviewed).toEqual([]);
});

test("the scanner sees the dependency in every file the exemption table claims to need a native desktop/node_modules dep", () => {
  const claimed = exemptedFiles(EXEMPTIONS, REAL_FILES).filter((f) => reasonFor(f, EXEMPTIONS).includes(NATIVE_DEPS_REASON_MARKER));
  expect(claimed.length).toBeGreaterThan(0);
  const unseen = claimed.filter((f) => {
    const findings = scanDesktopDependency(f, readFileSync(join(TESTS_DIR, f), "utf-8"));
    return !findings.some((finding) => DEFINITE_KINDS.has(finding.kind));
  });
  expect(unseen, "the exemption claims a desktop/node_modules dependency the scanner cannot find: it is blind to that form").toEqual([]);
});

test("this guard file's own source holds no finding of the scanner (fixtures stay out of evaluable path shapes)", () => {
  const own = "desktop-ci-glob-coverage.test.ts";
  expect(scanDesktopDependency(own, readFileSync(join(TESTS_DIR, own), "utf-8"))).toEqual([]);
});

test("every on-disk tests/*.test.ts file is either exempt or included in the computed partition (clean + contaminated)", () => {
  expect(REAL_FILES.length).toBeGreaterThan(0);
  const { clean, contaminated } = partitionTests(REAL_FILES, EXEMPTIONS);
  const included = new Set([...clean, ...contaminated]);
  const dropped = REAL_FILES.filter((f) => !isExempt(f, EXEMPTIONS) && !included.has(f));
  expect(dropped).toEqual([]);
});

test("mutation proof, growth (the deny-list's defining property): a brand-new, non-exempt file is included by default", () => {
  // Under the deny-list, a new file runs by default; an exemption must be added
  // for it not to. That is the inverse of the retired allow-list, which
  // required a glob to be added for a new file to run.
  const mutatedFiles = [...REAL_FILES, "a-brand-new-untriaged-file.test.ts"];
  expect(isExempt("a-brand-new-untriaged-file.test.ts", EXEMPTIONS)).toBe(false);
  const { clean, contaminated } = partitionTests(mutatedFiles, EXEMPTIONS, (f) =>
    f === "a-brand-new-untriaged-file.test.ts" ? "" : readFileSync(join(TESTS_DIR, f), "utf-8"),
  );
  expect([...clean, ...contaminated]).toContain("a-brand-new-untriaged-file.test.ts");
});

test("mutation proof, staleness: an exemption naming a vanished family is caught", () => {
  const mutatedExemptions: Exemptions = {
    familyPrefixes: { ...EXEMPTIONS.familyPrefixes, "nonexistent-family-": "placeholder reason, long enough" },
    exactFiles: EXEMPTIONS.exactFiles,
  };
  const { staleFamilies } = staleExemptions(mutatedExemptions, REAL_FILES);
  expect(staleFamilies).toContain("nonexistent-family-");
});

test("mutation proof, staleness: a per-file exemption naming a vanished file is caught", () => {
  const mutatedExemptions: Exemptions = {
    familyPrefixes: EXEMPTIONS.familyPrefixes,
    exactFiles: { ...EXEMPTIONS.exactFiles, "this-file-does-not-exist.test.ts": "placeholder reason, long enough" },
  };
  const { staleFiles } = staleExemptions(mutatedExemptions, REAL_FILES);
  expect(staleFiles).toContain("this-file-does-not-exist.test.ts");
});

test("EXEMPTIONS itself carries no stale entry today", () => {
  const { staleFamilies, staleFiles } = staleExemptions(EXEMPTIONS, REAL_FILES);
  expect(staleFamilies).toEqual([]);
  expect(staleFiles).toEqual([]);
});

test("card b33b1874: no non-exempt file real-imports the broker-spawning helper", () => {
  const files = wronglyIncludedFiles(EXEMPTIONS, REAL_FILES, (f) => readFileSync(join(TESTS_DIR, f), "utf-8"));
  expect(files).toEqual([]);
});

test("mutation proof: wronglyIncludedFiles bites on a synthetic non-exempt file with a real helper import", () => {
  const files = [...REAL_FILES, "desktop-planted-daemon.test.ts"];
  const plantedImport = "import { startBroker } " + 'from "./' + '_helper.ts";\n';
  const sources: Record<string, string> = {
    "desktop-planted-daemon.test.ts": plantedImport,
  };
  const found = wronglyIncludedFiles(EXEMPTIONS, files, (f) => (f in sources ? sources[f]! : readFileSync(join(TESTS_DIR, f), "utf-8")));
  expect(found).toContain("desktop-planted-daemon.test.ts");
});

test("mutation proof: the real-import detector does not false-positive on this file's own source", () => {
  // This file's own prose (three lines up, and in the exempt-domain tests
  // above) mentions startBroker/_helper as TEXT, not as a real import.
  const ownSource = readFileSync(join(TESTS_DIR, "desktop-ci-glob-coverage.test.ts"), "utf-8");
  expect(/startBroker|_helper/.test(ownSource)).toBe(true);
  expect(importsHelperBroker(ownSource)).toBe(false);
});

test("mutation proof: the real-import detector matches both quote styles and the extensionless form", () => {
  const withExt = "import { startBroker } " + 'from "./' + '_helper.ts";';
  const noExt = "import { startBroker } " + "from './" + "_helper';";
  const commentOnly = "// mentions ./" + "_helper.ts in a comment, no import";
  expect(importsHelperBroker(withExt)).toBe(true);
  expect(importsHelperBroker(noExt)).toBe(true);
  expect(importsHelperBroker(commentOnly)).toBe(false);
});

/** Restricts a filename list to the frozen day-J snapshot, dropping anything added or deleted since. */
function onSnapshot(files: string[]): string[] {
  return files.filter((f) => SNAPSHOT_FILES_2026_08_24.includes(f));
}

test("switchover neutrality: on the frozen day-J snapshot, the deny-list's run domain is EXACTLY the retired allow-list's covered domain (measured 2026-08-24: 199 files, 147 glob-covered, 52 uncovered, residue after the 4 exemptions is 0)", () => {
  const newDomain = onSnapshot(REAL_FILES.filter((f) => !isExempt(f, EXEMPTIONS))).sort();
  const oldDomain = onSnapshot(REAL_FILES.filter((f) => matchesAnyGlob(f, FROZEN_PRE_MIGRATION_GLOBS))).sort();
  expect(newDomain).toEqual(oldDomain);
});

test("mutation proof, N3: a brand-new, non-exempt file matching none of the frozen globs no longer breaks switchover neutrality", () => {
  // Before N3, comparing against the LIVE tree meant this exact scenario
  // made the neutrality test above fail forever: a legitimately non-exempt
  // file (correctly run by the deny-list) whose name happens to match none
  // of the 12 inherited glob patterns. That turned a one-day proof into a
  // permanent naming constraint on every future test file. Intersecting
  // with the frozen snapshot removes it from the comparison entirely --
  // this file is still correctly RUN (see the "growth" mutation proof
  // above), just not part of this particular historical proof.
  const futureFile = "widget-something-nobody-has-named-yet.test.ts";
  expect(isExempt(futureFile, EXEMPTIONS)).toBe(false);
  expect(matchesAnyGlob(futureFile, FROZEN_PRE_MIGRATION_GLOBS)).toBe(false);
  expect(SNAPSHOT_FILES_2026_08_24).not.toContain(futureFile);
  const mutatedFiles = [...REAL_FILES, futureFile];
  const newDomain = onSnapshot(mutatedFiles.filter((f) => !isExempt(f, EXEMPTIONS))).sort();
  const oldDomain = onSnapshot(mutatedFiles.filter((f) => matchesAnyGlob(f, FROZEN_PRE_MIGRATION_GLOBS))).sort();
  expect(newDomain).toEqual(oldDomain);
});

test("mutation proof: the (now intersected) switchover-neutrality check still catches a real regression on the day-J snapshot", () => {
  // The intersection makes the test inert for the FUTURE, not for the
  // PRESENT: a snapshot file whose exemption status silently drifts away
  // from its old-glob classification still breaks the equality. logger.test.ts
  // is in FROZEN_PRE_MIGRATION_GLOBS's exact-file list (so oldDomain has it);
  // exempting it moves it out of newDomain, and the two sides diverge.
  const mutatedExemptions: Exemptions = {
    familyPrefixes: EXEMPTIONS.familyPrefixes,
    exactFiles: { ...EXEMPTIONS.exactFiles, "logger.test.ts": "placeholder reason, long enough" },
  };
  const newDomain = onSnapshot(REAL_FILES.filter((f) => !isExempt(f, mutatedExemptions))).sort();
  const oldDomain = onSnapshot(REAL_FILES.filter((f) => matchesAnyGlob(f, FROZEN_PRE_MIGRATION_GLOBS))).sort();
  expect(newDomain).not.toEqual(oldDomain);
});

// Matches both block-style (`paths:` alone on a line) and flow-style (`{paths:
// [...]}`) YAML.
// paths-ignore is included deliberately, since it narrows the same commit
// domain under a different key name.
// `\b` before `paths` avoids matching an unrelated identifier merely ending in
// the word, e.g. `external_paths:`.
const PATHS_FILTER_RE = /\bpaths(-ignore)?\s*:/;

test("commit-closure.yml's on.pull_request carries no paths: filter, block OR flow style, paths-ignore included (Card 67519e73: a paths filter reopens the reachability gap this workflow exists to close)", () => {
  const onBlock = extractOnBlock(REAL_COMMIT_CLOSURE_TEXT);
  expect(onBlock).not.toMatch(PATHS_FILTER_RE);
});

test("mutation proof: the paths-filter regex catches FLOW-style paths: (not just block-style)", () => {
  const flowStyle = "on:\n  pull_request: {paths: [\"desktop/**\"]}\n";
  expect(extractOnBlock(flowStyle)).toMatch(PATHS_FILTER_RE);
});

test("mutation proof: the paths-filter regex catches paths-ignore: (same domain-narrowing regression under a different key)", () => {
  const pathsIgnore = "on:\n  pull_request:\n    paths-ignore:\n      - \"docs/**\"\n";
  expect(extractOnBlock(pathsIgnore)).toMatch(PATHS_FILTER_RE);
});

test("mutation proof: the paths-filter regex does not false-positive on an unrelated key merely ending in \"paths\" joined by a word character", () => {
  const unrelated = "on:\n  pull_request:\n    external_paths: [\"not-a-real-key\"]\n";
  expect(extractOnBlock(unrelated)).not.toMatch(PATHS_FILTER_RE);
});

test("commit-closure.yml still runs scripts/check-commit-closure.ts from some step (so the no-paths guarantee cannot be paired with a silently removed check step)", () => {
  expect(anyStepRunInvokesCommitClosureScript(REAL_COMMIT_CLOSURE_TEXT)).toBe(true);
});

test("mutation proof: extractOnBlock does not leak a paths: string that lives outside the on: block", () => {
  const synthetic = [
    "name: fake",
    "",
    "on:",
    "  pull_request:",
    "",
    "jobs:",
    "  check:",
    "    steps:",
    "      # unrelated comment mentioning paths: as prose, not a real key",
    "      - name: paths: this must not be read as part of on:",
    "        run: echo hi",
    "",
  ].join("\n");
  const onBlock = extractOnBlock(synthetic);
  expect(onBlock).not.toMatch(/paths:/);
});

test("mutation proof: extractOnBlock DOES catch a paths: filter actually under on.pull_request", () => {
  const synthetic = ["name: fake", "", "on:", "  pull_request:", '    paths: ["some/dir/**"]', "", "jobs:", "  check: {}", ""].join(
    "\n"
  );
  const onBlock = extractOnBlock(synthetic);
  expect(onBlock).toMatch(/^\s*paths:/m);
});

test("mutation proof: a step whose run: never mentions the script is not counted, even if an earlier comment does", () => {
  const synthetic = [
    "name: fake",
    "",
    "# comment mentioning scripts/check-commit-closure.ts in prose only",
    "on:",
    "  pull_request:",
    "",
    "jobs:",
    "  check:",
    "    steps:",
    "      - name: unrelated step",
    "        run: echo hi",
    "",
  ].join("\n");
  expect(anyStepRunInvokesCommitClosureScript(synthetic)).toBe(false);
});

test("mutation proof: a step whose run: DOES invoke the script is counted", () => {
  const synthetic = [
    "name: fake",
    "",
    "on:",
    "  pull_request:",
    "",
    "jobs:",
    "  check:",
    "    steps:",
    "      - name: the real step",
    "        run: |",
    '          bun scripts/check-commit-closure.ts "$sha" .',
    "",
  ].join("\n");
  expect(anyStepRunInvokesCommitClosureScript(synthetic)).toBe(true);
});

test("mutation proof: a workflow with no run: occurrences at all does not throw and reports false", () => {
  const synthetic = ["name: fake", "", "on:", "  pull_request:", "", "jobs:", "  check:", "    steps:", "      - uses: actions/checkout@v6", ""].join(
    "\n"
  );
  expect(anyStepRunInvokesCommitClosureScript(synthetic)).toBe(false);
});

// Discovers workflows via readdirSync rather than naming the known offenders,
// so a new workflow adding a literal bun-version: on setup-bun is caught the
// same way.
// Two floor assertions guard against a broken WORKFLOWS_DIR or detector
// silently reading as a vacuous zero-offenders pass.
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");
const BUN_VERSION_FILE_PATH = join(REPO_ROOT, ".bun-version");

function listWorkflowFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
}

function usesSetupBun(workflowText: string): boolean {
  return /uses:\s*oven-sh\/setup-bun@/.test(workflowText);
}

/**
 * A literal `bun-version:` key, anchored to the start of a (possibly
 * indented) line so this cannot fire on the substring appearing inside prose
 * or a comment. Distinct from `bun-version-file:` by construction: that key
 * has "-file" between "bun-version" and the colon, so the exact substring
 * "bun-version:" this regex requires never occurs inside it -- proven by the
 * mutation-proof test below, no negative lookahead needed.
 */
function hasLiteralBunVersion(workflowText: string): boolean {
  return /^[ \t]*bun-version:\s*\S/m.test(workflowText);
}

function workflowsWithLiteralBunVersion(dir: string, files: string[]): string[] {
  return files.filter((f) => {
    const text = readFileSync(join(dir, f), "utf-8");
    return usesSetupBun(text) && hasLiteralBunVersion(text);
  });
}

const REAL_WORKFLOW_FILES = listWorkflowFiles(WORKFLOWS_DIR);
const REAL_SETUP_BUN_FILES = REAL_WORKFLOW_FILES.filter((f) =>
  usesSetupBun(readFileSync(join(WORKFLOWS_DIR, f), "utf-8")),
);

test("floor: at least 3 workflow files are discovered under .github/workflows (a renamed/collapsed directory must not read as a vacuous pass)", () => {
  expect(REAL_WORKFLOW_FILES.length).toBeGreaterThanOrEqual(3);
});

test("floor: at least 3 discovered workflows install bun via oven-sh/setup-bun (a broken usesSetupBun detector must not read as 0 offenders)", () => {
  expect(REAL_SETUP_BUN_FILES.length).toBeGreaterThanOrEqual(3);
});

test("no workflow installing bun via setup-bun carries a literal bun-version: -- all route through bun-version-file: .bun-version (card 8acf72be)", () => {
  const offenders = workflowsWithLiteralBunVersion(WORKFLOWS_DIR, REAL_SETUP_BUN_FILES);
  expect(offenders).toEqual([]);
});

test(".bun-version exists and is non-empty (a bun-version-file pointing at a missing/empty file is a silent action-level failure mode)", () => {
  expect(existsSync(BUN_VERSION_FILE_PATH)).toBe(true);
  expect(readFileSync(BUN_VERSION_FILE_PATH, "utf-8").trim().length).toBeGreaterThan(0);
});

const SANDBOX_DOCKERFILE_PATH = join(REPO_ROOT, "desktop", "resources", "sandbox", "Dockerfile");

function dockerfileBunVersionArgs(dockerfileText: string): string[] {
  return [...dockerfileText.matchAll(/^ARG[ \t]+BUN_VERSION=(\S+)[ \t]*$/gm)].map((m) => m[1] ?? "");
}

const EXPLICIT_BUN_VERSION = /^\d+\.\d+\.\d+$/;

test("sandbox Dockerfile pins the same explicit bun as .bun-version (ARG BUN_VERSION duplicates the CI source of truth)", () => {
  const args = dockerfileBunVersionArgs(readFileSync(SANDBOX_DOCKERFILE_PATH, "utf-8"));
  const pinned = readFileSync(BUN_VERSION_FILE_PATH, "utf-8").trim();
  expect(
    args.length,
    "desktop/resources/sandbox/Dockerfile must carry exactly one `ARG BUN_VERSION=<version>` line: with none the parity check below would pass vacuously",
  ).toBe(1);
  expect(pinned, ".bun-version must be an explicit X.Y.Z: `latest` or a range makes the parity below prove nothing").toMatch(EXPLICIT_BUN_VERSION);
  expect(args[0], "ARG BUN_VERSION must be an explicit X.Y.Z: `latest` or a range installs an unpinned bun").toMatch(EXPLICIT_BUN_VERSION);
  expect(
    args[0],
    "ARG BUN_VERSION in desktop/resources/sandbox/Dockerfile drifted from the repo-root .bun-version that the CI workflows install",
  ).toBe(pinned);
});

test("mutation proof: an explicit bun version is X.Y.Z only, never latest, a range, a prefix or a prerelease", () => {
  expect(EXPLICIT_BUN_VERSION.test("1.4.2")).toBe(true);
  for (const unpinned of ["latest", "1.4", "1.x", "v1.4.2", "bun-v1.4.2", "1.4.2-canary", "^1.4.2", "1.4.2 "]) {
    expect(EXPLICIT_BUN_VERSION.test(unpinned), `${JSON.stringify(unpinned)} is not an explicit pin`).toBe(false);
  }
});

test("mutation proof: dockerfileBunVersionArgs reads the default from CRLF and LF text and ignores commented, defaultless and look-alike ARG lines", () => {
  expect(dockerfileBunVersionArgs("FROM x\r\nARG BUN_VERSION=1.4.2\r\nARG CLAUDE_VERSION=2.1\r\n")).toEqual(["1.4.2"]);
  expect(dockerfileBunVersionArgs("FROM x\nARG BUN_VERSION=1.4.2\n")).toEqual(["1.4.2"]);
  expect(dockerfileBunVersionArgs("# ARG BUN_VERSION=1.4.2\nARG BUN_VERSION\nARG NOT_BUN_VERSION=1.4.2\n")).toEqual([]);
  expect(dockerfileBunVersionArgs("ARG BUN_VERSION=1.4.2\nARG BUN_VERSION=1.4.3\n")).toEqual(["1.4.2", "1.4.3"]);
});

test("mutation proof: a workflow snippet with a literal bun-version: is detected by both primitives (usesSetupBun and hasLiteralBunVersion)", () => {
  const text = "uses: oven-sh/setup-bun@v2\nwith:\n  bun-version: latest\n";
  expect(usesSetupBun(text)).toBe(true);
  expect(hasLiteralBunVersion(text)).toBe(true);
});

test("mutation proof: bun-version-file: is never mistaken for a literal bun-version: (the string 'bun-version:' does not occur inside it)", () => {
  const text = "uses: oven-sh/setup-bun@v2\nwith:\n  bun-version-file: .bun-version\n";
  expect(usesSetupBun(text)).toBe(true);
  expect(hasLiteralBunVersion(text)).toBe(false);
});

test("mutation proof: a step that does not use setup-bun at all is never flagged even if it happens to mention bun-version: in prose", () => {
  const text = "uses: actions/checkout@v6\n# note: bun-version: latest used to live here\n";
  expect(usesSetupBun(text)).toBe(false);
});

test("mutation proof: the floor rejects a collapsed or truncated directory listing (0 or fewer-than-3 files), instead of the offenders check silently reading it as 0 offenders", () => {
  const collapsed: string[] = [];
  const truncated = ["desktop-build.yml"];
  expect(workflowsWithLiteralBunVersion(WORKFLOWS_DIR, collapsed)).toEqual([]);
  expect(workflowsWithLiteralBunVersion(WORKFLOWS_DIR, truncated)).toEqual([]);
  // The offenders check alone is vacuously green on both degraded inputs --
  // this is exactly why the floor tests above assert length independently.
  expect(collapsed.length).toBeLessThan(3);
  expect(truncated.length).toBeLessThan(3);
});
