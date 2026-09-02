// Runs the complement of partition-pure-tests.ts's exemption deny-list: every
// test file that spawns a daemon and binds a port.
// Single shared `bun test` invocation, not one process per file: none of these
// files register a global (happy-dom) or mock a module, so the process-global
// leakage that forces per-file isolation elsewhere does not apply here.
// Each file's own broker binds an OS-assigned ephemeral port, so running them
// serially in one process is expected to be safe.
import { readdirSync } from "node:fs";
import { EXEMPTIONS, exemptedFiles, isExempt, listTestFiles, REPO_ROOT, TESTS_DIR } from "./pure-module-partition.ts";

interface InvocationResult {
  exitCode: number;
  ms: number;
  testsRan: number | null;
  filesRan: number | null;
}

// Exit code and test count alone don't prove every file ran; a file dropped
// from collection could still let a lone survivor pass.
// Also captures the `across M files?` half of bun's recap line and requires
// filesRan >= files.length rather than exact equality, since a file with zero
// test() calls makes bun's own count diverge harmlessly.
// An unparseable recap fails, never a default pass.
const RECAP_RE = /Ran (\d+) tests? across (\d+) files?/;

// Sets the bun test timeout floor globally rather than per test: a per-test
// timeout has no effect on a beforeAll/beforeEach hook, and many of these
// suites spawn a broker inside one.
// An explicit per-test timeout still wins over this flag.
// Paired with a timeout-minutes ceiling on the CI step, since raising this
// removes the only bound on a runaway run.
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

function runBunTest(files: string[]): InvocationResult {
  const start = Date.now();
  const proc = Bun.spawnSync(["bun", "test", "--timeout", String(DEFAULT_TEST_TIMEOUT_MS), ...files.map((f) => `tests/${f}`)], {
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
  const filesRan = recapMatch ? Number(recapMatch[2]) : null;
  const exitCode = testsRan === null || testsRan < 1 || filesRan === null || filesRan < files.length ? 1 : (proc.exitCode ?? 1);
  return { exitCode, ms, testsRan, filesRan };
}

const allFiles = listTestFiles();
const files = exemptedFiles(allFiles, EXEMPTIONS);

// Recomputes the exempt-file domain via an independent readdirSync + isExempt
// filter, not a second call against the same allFiles array, so a shared bug in
// either the enumeration or the filter can't cancel itself out.
// Requires exact equality with the production computation; any drift, shrink or
// growth, refuses to run rather than silently running a different set.
const independentAllFiles = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts"));
const independentExemptFiles = independentAllFiles.filter((f) => isExempt(f, EXEMPTIONS)).sort();
const productionExemptFiles = [...files].sort();
const filesMatch =
  independentExemptFiles.length === productionExemptFiles.length &&
  independentExemptFiles.every((f, i) => f === productionExemptFiles[i]);

if (!filesMatch) {
  console.error(
    `[partition-integration-tests] refusing to run: the production enumeration (${productionExemptFiles.length} files) does not exactly match an independent readdirSync + isExempt recomputation (${independentExemptFiles.length} files). A silent drift between the two would mean this step runs a different set than scripts/pure-module-partition.ts's EXEMPTIONS actually names.`,
  );
  process.exit(1);
}

console.log(`[partition-integration-tests] ${allFiles.length} tests/*.test.ts on disk -> ${files.length} exempted (integration) files: ${files.join(", ")}`);

const result = runBunTest(files);

const ranNote =
  result.testsRan === null || result.filesRan === null
    ? "recap not found"
    : `${result.testsRan} test${result.testsRan === 1 ? "" : "s"} ran across ${result.filesRan} file${result.filesRan === 1 ? "" : "s"}`;
console.log(`[partition-integration-tests] ${result.exitCode === 0 ? "PASS" : "FAIL"} (${files.length} files, ${ranNote}, ${result.ms}ms)`);

process.exit(result.exitCode === 0 ? 0 : 1);
