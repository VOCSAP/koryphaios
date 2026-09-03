// bun runs every tests/*.test.ts file in one process; happy-dom's
// GlobalRegistrator and bun's mock.module() mutate process-global state with no
// in-process teardown if a file dies at import time.
// The marker-free set runs together in one `bun test` invocation; every
// marker-carrying file gets its own process, isolated so it cannot poison a
// neighbour.
// Exit code is non-zero if any invocation -- the clean batch or any single
// contaminated file -- fails.
import { EXEMPTIONS, listTestFiles, partitionTests, REPO_ROOT } from "./pure-module-partition.ts";

interface InvocationResult {
  label: string;
  fileCount: number;
  exitCode: number;
  ms: number;
  testsRan: number | null;
}

/**
 * D5: the exit code alone does not prove anything ran -- a process that
 * calls `process.exit(0)` before bun ever loads a test file exits 0 with
 * nothing played. Requires the `Ran N tests? across M files?` recap line
 * bun prints on every invocation and reads N from it. FAILS CLOSED: if the
 * recap is missing or unparseable (truncated output, or a future bun
 * changing the format), that is exit 1, never a default pass -- a parser
 * that does not understand its input must refuse, not let it through.
 */
const RECAP_RE = /Ran (\d+) tests? across/;

function runBunTest(label: string, files: string[]): InvocationResult {
  const start = Date.now();
  const proc = Bun.spawnSync(["bun", "test", ...files.map((f) => `tests/${f}`)], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const ms = Date.now() - start;
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const recapMatch = `${stdout}${stderr}`.match(RECAP_RE);
  const testsRan = recapMatch ? Number(recapMatch[1]) : null;
  const exitCode = testsRan === null || testsRan < 1 ? 1 : (proc.exitCode ?? 1);
  return { label, fileCount: files.length, exitCode, ms, testsRan };
}

// Refuses to run if fewer than MIN_EXPECTED_FILES are found, rather than
// silently running a truncated subset of what CI expects.
// This is a floor with headroom, not the exact count -- ordinary file additions
// or removals do not need to touch it.
const MIN_EXPECTED_FILES = 150;

const allFiles = listTestFiles();
if (allFiles.length < MIN_EXPECTED_FILES) {
  console.error(
    `[partition-pure-tests] refusing to run: only ${allFiles.length} tests/*.test.ts files enumerated (expected >= ${MIN_EXPECTED_FILES}, measured 2026-08-24: 199). A truncated enumeration would silently drop files from CI at exit 0.`,
  );
  process.exit(1);
}

const { clean, contaminated } = partitionTests(allFiles, EXEMPTIONS);

// D3: the deny-list can exempt its own auditors (e.g. an over-broad
// familyPrefixes entry like "desktop-" would exempt desktop-ci-glob-coverage.test.ts
// itself), in which case their red assertions never get collected and CI
// never sees them fail. An auditor absent from the played set is a runner
// failure, not a legitimate exemption choice.
const MUST_BE_PLAYED = ["desktop-ci-glob-coverage.test.ts", "desktop-happy-dom-teardown.test.ts"];
const played = new Set([...clean, ...contaminated]);
const missingAuditors = MUST_BE_PLAYED.filter((f) => !played.has(f));
if (missingAuditors.length > 0) {
  console.error(
    `[partition-pure-tests] refusing to run: coverage-audit guard(s) [${missingAuditors.join(", ")}] are not in the played set (clean + contaminated) -- an absent auditor is a failure, not a choice. Check scripts/pure-module-partition.ts's EXEMPTIONS for an over-broad family prefix.`,
  );
  process.exit(1);
}

console.log(
  `[partition-pure-tests] ${allFiles.length} tests/*.test.ts on disk -> ${clean.length} clean (one shared process), ${contaminated.length} contaminated (own process each): ${contaminated.join(", ") || "(none)"}`,
);

const results: InvocationResult[] = [];
if (clean.length > 0) {
  results.push(runBunTest("clean batch", clean));
}
for (const file of contaminated) {
  results.push(runBunTest(file, [file]));
}

// D2: zero invocations (e.g. an empty tests/ tree, or every file exempted)
// must not read as a pass. `results.length === 0` only happens if MIN_EXPECTED_FILES
// and the D3 auditor check above were somehow both bypassed, but this stays
// a standalone floor rather than relying on those two alone: it protects
// the RESULT-REPORTING step, not just the two upstream conditions that
// happen to prevent it today.
if (results.length === 0) {
  console.error(
    "[partition-pure-tests] refusing to report PASS: zero invocations ran (empty clean set and zero contaminated files).",
  );
  process.exit(1);
}

let anyFailed = false;
for (const r of results) {
  const status = r.exitCode === 0 ? "PASS" : "FAIL";
  if (r.exitCode !== 0) anyFailed = true;
  const ranNote = r.testsRan === null ? "recap not found" : `${r.testsRan} test${r.testsRan === 1 ? "" : "s"} ran`;
  console.log(`[partition-pure-tests] ${status} ${r.label} (${r.fileCount} file${r.fileCount === 1 ? "" : "s"}, ${ranNote}, ${r.ms}ms)`);
}

const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
console.log(
  `[partition-pure-tests] ${results.length} invocation(s), ${totalMs}ms total: ${anyFailed ? "FAIL" : "PASS"}`,
);

process.exit(anyFailed ? 1 : 0);
