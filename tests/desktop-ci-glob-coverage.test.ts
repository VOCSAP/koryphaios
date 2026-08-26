// spec_f731f289 (amended): card 01c82fdf follow-up. The token-safe
// roadmap-add fallback (cli-roadmap-add-no-token.test.ts) shipped uncovered
// by CI: .github/workflows/desktop-build.yml's "Bun tests (pure modules)"
// step listed an explicit glob set rather than running `bun test` bare, and
// that set had never been checked against the real tests/*.test.ts
// inventory. Team-lead review, 2026-08-03: a one-line fix for the single
// missed file would have left the same gap open for the next new suite.
//
// Card 0bbac537 (2026-08-24): the glob allow-list itself is gone. The step
// now runs `bun scripts/partition-pure-tests.ts`, which enumerates every
// tests/*.test.ts file and runs all of it EXCEPT what
// scripts/pure-module-partition.ts's EXEMPTIONS names -- a deny-list that
// fails CLOSED (a new file is run by default; an exemption must justify
// itself), replacing the allow-list that failed OPEN. This file now audits:
//   - the workflow step's `run:` line invokes exactly that script (bounded
//     parse, same discipline as the retired glob parser had);
//   - EXEMPTIONS is honest in both directions (every exempted file really
//     spawns a daemon; no non-exempt file quietly does);
//   - EXEMPTIONS has no stale entry (names something that still exists);
//   - a brand-new, non-exempt file is run by default (the deny-list's
//     defining property, and the mutation proof for it);
//   - the migration was NEUTRAL the day it landed: the deny-list's domain
//     (all files minus EXEMPTIONS) is EXACTLY the domain the retired
//     allow-list used to collect, measured against a frozen snapshot of
//     that allow-list's glob patterns (frozen because the live workflow no
//     longer contains them to parse -- see FROZEN_PRE_MIGRATION_GLOBS).
//
// EXEMPTIONS itself is NOT redefined here: it is imported from
// scripts/pure-module-partition.ts, the single module partition-pure-tests.ts
// (the script that actually runs the tests) also imports it from. Two
// copies of a gating table is exactly the divergence CLAUDE.md's shared-table
// rule warns about.
//
// Team-lead audit 2026-08-26: this file lives directly under tests/ as
// *.test.ts, which is what scripts/pure-module-partition.ts's listTestFiles
// collects by default; it RUNS because isExempt's deny-list is keyed on the
// broker-/server- prefixes and two exact filenames, none of which name this
// file -- the "desktop-" prefix plays no role in either function (mirrors
// tests/desktop-test-hygiene.test.ts's own self-coverage note) -- checked
// explicitly by a test below, not assumed from the name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
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

// Frozen snapshot of the allow-list this partition replaced, measured
// 2026-08-24 straight out of the pre-migration workflow text (parsed with
// the retired parsePureModuleGlobs, before this commit removed it). NOT
// re-derived from the live workflow: the whole point of this constant is to
// survive the migration that deletes the thing it describes, so the
// neutrality test below stays meaningful after that line is gone from
// desktop-build.yml.
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

// N3, reviewer 2026-08-24: comparing FROZEN_PRE_MIGRATION_GLOBS against the
// LIVE tests/ tree turned a one-day neutrality proof into a permanent naming
// constraint -- any future file whose name matched none of the 12 inherited
// glob patterns (a legitimate, correctly-run file under the deny-list) would
// make the equality test below fail forever, for a reason that has nothing
// to do with a regression. Frozen alongside the globs: the exact 199
// tests/*.test.ts filenames on disk the day this migration landed. The
// neutrality test intersects this snapshot with whatever REAL_FILES is
// today, so a file outside the snapshot (new OR deleted) never enters either
// side of the comparison -- the proof stays about the day-J domain only, and
// is inert for anything that came after.
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

// Card 67519e73, team-lead review: commit-closure.yml carries a top-of-file
// comment ASSERTING a guarantee ("no `paths:` filter on purpose ... scoping
// it to any path list reopens the same reachability gap") that nothing in
// the repo enforced. A comment that asserts a guarantee must be wired to
// what applies it (see CLAUDE.md). This audits that workflow the same way
// the rest of this file audits desktop-build.yml: read the REAL file,
// extract the relevant block with a bounded parse (never a naive full-text
// substring search, which the script-path check below specifically guards
// against -- this workflow's own header comment mentions
// "scripts/check-commit-closure.ts" in prose, which a naive `.includes()`
// would wrongly accept even if the actual invoking step vanished).
const COMMIT_CLOSURE_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "commit-closure.yml");
const REAL_COMMIT_CLOSURE_TEXT = readFileSync(COMMIT_CLOSURE_WORKFLOW_PATH, "utf-8");

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
  // Reviewer 2026-08-24: the retired hardcoded-6-spaces version of
  // parsePureModuleStepRun would silently adopt the later step's run: line
  // at 4-space indentation (the boundary regex simply never matched). This
  // constructs that exact indentation and asserts the current, derived-
  // indentation parser still bounds correctly.
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
  // Reviewer 2026-08-24: this file's REAL_FILES and desktop-happy-dom-teardown.test.ts's
  // `sources` both do their OWN readdirSync, entirely independent of
  // listTestFiles(). A truncation in the PRODUCTION enumeration (measured:
  // `.slice(0, 100)` inside listTestFiles) is invisible to either guard --
  // both keep computing their own full count and stay green -- while the
  // runner would silently play 53 of 147 files at exit 0. This equality
  // between the production function's output and an independent oracle
  // (REAL_FILES, already computed above) is what makes that mutation loud.
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

test("every exempted file actually spawns a broker (measured property, not the family label)", () => {
  // N2, carried over from the glob-era review: `file.startsWith(prefix)`
  // only checks the NAME. A future pure file that happens to get named
  // broker-something would be silently exempted forever with nothing going
  // red -- growth of the EXEMPT domain, not the run one. This asserts the
  // actual property the exemption claims (imports startBroker, or otherwise
  // pulls in tests/_helper.ts) rather than trusting the filename pattern.
  const files = exemptedFiles(EXEMPTIONS, REAL_FILES);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const source = readFileSync(join(TESTS_DIR, f), "utf-8");
    expect(source).toMatch(/startBroker|_helper/);
  }
});

test("mutation proof, N2: an exempted file that does NOT spawn a broker is caught", () => {
  const noBrokerFile = "logger.test.ts";
  const source = readFileSync(join(TESTS_DIR, noBrokerFile), "utf-8");
  expect(source).not.toMatch(/startBroker|_helper/);
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

test("every on-disk tests/*.test.ts file is either exempt or included in the computed partition (clean + contaminated)", () => {
  expect(REAL_FILES.length).toBeGreaterThan(0);
  const { clean, contaminated } = partitionTests(REAL_FILES, EXEMPTIONS);
  const included = new Set([...clean, ...contaminated]);
  const dropped = REAL_FILES.filter((f) => !isExempt(f, EXEMPTIONS) && !included.has(f));
  expect(dropped).toEqual([]);
});

test("mutation proof, growth (the deny-list's defining property): a brand-new, non-exempt file is included by default", () => {
  // The property the allow-list-era "uncovered" test used to check for the
  // opposite reason (a glob had to be added by hand for a new file to run).
  // Under the deny-list, the default is inverted: nothing has to be added
  // for a new file to run, an exemption has to be added for it NOT to.
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
  // Measured 2026-08-04 in the glob-era version of this test: this was RED
  // before broker-desktop-roadmap-service.test.ts was renamed out of the
  // tests/desktop-*.test.ts family it used to match -- it real-imported
  // startBroker from ./_helper.ts, was collected, and carried no exemption
  // at all. Renaming it into the already-exempted broker- family is what
  // fixed it; this assertion is what would have caught it. Still meaningful
  // under the deny-list: "non-exempt" now IS the run domain (no glob to
  // intersect with), so this walks the whole thing.
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
  // N3, reviewer 2026-08-24: both sides are intersected with
  // SNAPSHOT_FILES_2026_08_24 before comparing, so a file added or removed
  // after the snapshot was taken never enters this comparison. This is
  // deliberately narrower than "REAL_FILES today" -- see the two mutation
  // proofs below for why.
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

// Team-lead/reviewer review, round 2: `/^\s*paths:/m` only fires on BLOCK-style
// YAML (`paths:` alone on its own line). It is silent on the legal FLOW form
// of the same key (`on: {pull_request: {paths: [...]}}`), so a reformat (or a
// tool regenerating this workflow) closes the reachability gap this test
// exists to make loud, with nothing going red. Unanchored on purpose: the
// guarantee is "no `paths` key anywhere under `on:`", not "no `paths:` at the
// start of a line". `paths-ignore` is included deliberately, not excluded:
// it narrows the same commit domain (audits fewer paths than "every commit"),
// so it is the same regression under a different key name. `\b` before
// `paths` keeps this from firing on an unrelated identifier that merely ENDS
// in "paths" joined by a word character (e.g. `external_paths:`, no boundary
// between `_` and `p`) -- proven below. A hyphen-joined false positive (e.g.
// a hypothetical `static-paths:` key) is an accepted residual: no such key
// exists in GitHub Actions' `on.pull_request` vocabulary today.
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

// Card 8acf72be: three workflows (commit-closure.yml, desktop-build.yml,
// desktop-release.yml) used to each carry their own literal `bun-version:
// latest` on oven-sh/setup-bun@v2 -- a runtime that could (and measurably
// did, same day, no commit in between) resolve to a different bun version on
// every run, on top of three copies of the same literal to hand-sync once
// pinned. Both are fixed by routing every setup-bun step through a single
// root .bun-version file (bun-version-file: .bun-version). This block
// enforces that neither regression comes back:
//   - no workflow that installs bun via setup-bun carries a literal
//     bun-version: again (the copies-to-sync failure mode);
//   - .bun-version itself exists and is non-empty (the silent-404 failure
//     mode a bun-version-file pointing at nothing would be).
//
// DISCOVERS its targets (readdirSync(WORKFLOWS_DIR)), never names the three
// files: CLAUDE.md's coverage rule, growth-of-domain half -- a fourth
// workflow added later with `uses: oven-sh/setup-bun` and a literal
// bun-version: must be caught the same way the first three would be, with
// nothing to edit in this file for that to hold. The two floor assertions
// below exist so a broken/renamed WORKFLOWS_DIR or a broken usesSetupBun
// detector reads as "0 offenders" (a vacuous pass), not as a red.
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
