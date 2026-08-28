// Card f4a3ed1e. Companion to scripts/partition-pure-tests.ts: where that
// script runs everything scripts/pure-module-partition.ts's EXEMPTIONS
// table does NOT name, this one runs exactly what it DOES -- the deny-list's
// complement, i.e. every tests/*.test.ts file exempted from the pure-module
// step because it spawns a daemon and binds ports (the broker-/server-
// families, approval-hook.test.ts, mcp-roadmap-ack.test.ts).
//
// Before this script existed, that complement was measured (2026-08-24) to
// run in NO CI job at all, under exemption reasons that (pre-fix) claimed
// they were "played elsewhere" -- a claim nothing backed. This script is the
// "elsewhere". EXEMPTIONS' reason strings now name this step by its exact
// desktop-build.yml name ('Bun tests (integration)'), and
// auditExemptionLocations (pure-module-partition.ts) verifies that claim
// against the real workflow text, refusing both a dangling step name and an
// unfalsifiable "run elsewhere" claim with no step name at all.
//
// Single shared `bun test` invocation, not one process per file: unlike the
// pure-module partition, none of these 54 files carries a
// CONTAMINATION_MARKERS hit (checked 2026-08-28 -- neither
// GlobalRegistrator.register() nor mock.module() appears in any of them),
// so the process-global leakage that forces per-file isolation over there
// does not apply here. Each file's own broker binds an OS-assigned ephemeral
// port (tests/_helper.ts's reserveEphemeralPort), so running them serially
// in one bun:test process is expected to be safe -- unlike port collisions
// under a fixed-window scheme, nothing here shares a resource keyed too
// coarsely across files.
//
// EXPECT RED ON FIRST RUN. These files have never executed on a Linux or
// macOS CI runner (team-lead brief, card f4a3ed1e): path separators, EOL,
// port/timing assumptions and filesystem-name casing baked in on a Windows
// dev machine are untested outside it. This script's job is to make that
// failure VISIBLE (a real CI step, not a silent gap) -- not to guarantee a
// green run the day it lands.
import { readdirSync } from "node:fs";
import { EXEMPTIONS, exemptedFiles, isExempt, listTestFiles, REPO_ROOT, TESTS_DIR } from "./pure-module-partition.ts";

interface InvocationResult {
  exitCode: number;
  ms: number;
  testsRan: number | null;
  filesRan: number | null;
}

// D5 (mirrors partition-pure-tests.ts, reviewer 2026-08-28 hardened it
// further): the exit code alone does not prove anything ran, and the TEST
// count alone does not prove every FILE ran -- a run where 53 of 54 files
// are never collected but the one that IS still passes its own tests would
// have reported PASS under the old check (testsRan >= 1). Now also captures
// the `across M files?` half of bun's recap line and requires
// filesRan >= files.length (not strict equality: a file that itself
// contains zero `test()` calls would make bun's own count diverge, and that
// is not this script's failure mode to police). FAILS CLOSED either way: an
// unparseable recap is exit 1, never a default pass.
const RECAP_RE = /Ran (\d+) tests? across (\d+) files?/;

function runBunTest(files: string[]): InvocationResult {
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
  const filesRan = recapMatch ? Number(recapMatch[2]) : null;
  const exitCode = testsRan === null || testsRan < 1 || filesRan === null || filesRan < files.length ? 1 : (proc.exitCode ?? 1);
  return { exitCode, ms, testsRan, filesRan };
}

const allFiles = listTestFiles();
const files = exemptedFiles(allFiles, EXEMPTIONS);

// D1' (reviewer 2026-08-28): the previous check was a floor
// (`files.length < 40`, 14 files of slack over the 54 measured 2026-08-28)
// that would let up to 14 files silently vanish from this step's domain at
// exit 0. Recompute the same domain via an INDEPENDENT readdirSync +
// isExempt filter -- not a second call to exemptedFiles(allFiles, ...) on
// the SAME allFiles array, which would let a shared bug in either the
// enumeration or the filter cancel itself out -- and require exact equality
// (same length, same set) with the production computation above. Any drift,
// shrink or growth, refuses to run rather than silently running a different
// set than intended.
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
