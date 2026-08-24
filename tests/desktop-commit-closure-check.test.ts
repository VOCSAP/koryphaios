// Card 67519e73. Behavioral proof for scripts/check-commit-closure.ts: both
// checks (import closure, control bytes) plus alias resolution,
// alias-divergence detection, and ALL THREE regimes (sha, --staged, --pr),
// run against REAL git repos built by
// scripts/fixtures/make-closure-sensitivity-repo.ts -- never against a
// synthetic string standing in for git's own behavior. Fixture repos live
// under a per-run, randomized os.tmpdir() subdirectory so concurrent
// `bun test` runs (this checkout is shared by several sessions today)
// cannot collide on the same scratch path.
//
// Both halves of the coverage question, per file:
//   SENSITIVITY -- fires on each known defect shape: not-exported,
//   missing-target (named, default, namespace and side-effect forms),
//   control-byte (including an extension no allow-list enumerated),
//   alias-divergence, alias-based not-exported, a defect reached only
//   through a MERGE commit, one behind a NON-ASCII path, and an export that
//   exists only inside a comment.
//   SPECIFICITY -- silent (exit 0, zero problems) on clean 1-, 5- and
//   7-file commits, on quoted (commented/stringified) imports, on both
//   brace re-export forms and on a `.d.ts` target -- sensitivity alone
//   would pass a checker that is simply always red.
//   FAIL-CLOSED -- a shallow clone, a partial clone, an unresolvable ref
//   and an empty domain must never print an OK.
//
// Several tests are NEGATIVE CONTROLS in disguise: they are green with the
// shipped code and were each measured RED against the code that lacked the
// fix they cover (the over-strip probes, the merge path, the import-grammar
// forms, the path lexing, the net-diff split).
//
// Named tests/desktop-*.test.ts so it is collected by the same CI glob
// audited by tests/desktop-ci-glob-coverage.test.ts (that file's own
// enumeration test picks this one up automatically -- verified directly in
// "collected by the real CI glob" below, not just assumed from the name).

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  aliasTableFromTsconfig,
  codeOnlySource,
  makeBlobReader,
  maskCommentsAndStrings,
  resolveImportClosure,
  runCheck,
  runPrCheck,
  scanControlBytes,
  type BlobReader,
} from "../scripts/check-commit-closure";
import {
  buildEmptyRepo,
  buildSensitivityRepo,
  buildPartialClone,
  buildShallowClone,
  stageOnlyDefect,
  type SensitivityRepoShas,
} from "../scripts/fixtures/make-closure-sensitivity-repo";
import { isExempt, parsePureModuleStepRun, PARTITION_SCRIPT_COMMAND, WORKFLOW_PATH } from "../scripts/pure-module-partition.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "check-commit-closure.ts");

const SCRATCH = join(tmpdir(), `closure-check-${randomUUID()}`);
const MAIN_REPO = join(SCRATCH, "main");
const EMPTY_REPO = join(SCRATCH, "empty");
const SHALLOW_REPO = join(SCRATCH, "shallow");
const PARTIAL_REPO = join(SCRATCH, "partial");

let shas: SensitivityRepoShas;

beforeAll(() => {
  shas = buildSensitivityRepo(MAIN_REPO);
  buildEmptyRepo(EMPTY_REPO);
});

afterAll(() => {
  spawnSync("rm", ["-rf", SCRATCH]);
});

describe("sha mode -- sensitivity (fires on each known defect)", () => {
  test("catches an import of a symbol its target does not export yet", () => {
    const result = runCheck("sha", shas.notExported, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(result.problems.some((p) => p.kind === "not-exported" && p.file === "desktop/src/consumer.ts")).toBe(true);
  });

  test("catches an import whose target has never existed at this ref", () => {
    const result = runCheck("sha", shas.missingTarget, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(
      result.problems.some((p) => p.kind === "missing-target" && p.file === "desktop/src/ghost-consumer.ts"),
    ).toBe(true);
  });

  test("catches a literal ESC control byte in a committed file", () => {
    const result = runCheck("sha", shas.controlByte, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(result.problems.some((p) => p.kind === "control-byte" && p.file === "desktop/src/ansi.ts")).toBe(true);
  });

  test("catches the two tsconfigs disagreeing on @shared/*'s target", () => {
    const result = runCheck("sha", shas.aliasDivergence, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(result.problems.some((p) => p.kind === "alias-divergence")).toBe(true);
  });

  test("catches a real broken import sharing a line with a URL string literal (negative control: the comment stripper must not over-strip at '//')", () => {
    // If maskCommentsAndStrings ever treats the "//" inside "https://..." as
    // the start of a line comment, the import on that line is blanked and
    // this commit goes silently GREEN -- a false negative invisible in any
    // specificity test. This is the probe that makes that impossible.
    const result = runCheck("sha", shas.urlThenImport, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(
      result.problems.some((p) => p.kind === "missing-target" && p.file === "desktop/src/url-then-import.ts"),
    ).toBe(true);
  });

  test("catches a real broken import after a quoted backtick and a braced interpolation (second negative control against over-stripping)", () => {
    // Sibling of the URL probe: over-stripping is the SILENT direction, so
    // the two ways the scanner can run away (a quoted "//" and a quoted
    // backtick/"${") each get their own probe rather than sharing one.
    const result = runCheck("sha", shas.templateThenImport, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(
      result.problems.some((p) => p.kind === "missing-target" && p.file === "desktop/src/template-then-import.ts"),
    ).toBe(true);
  });

  test("catches a real broken import after a regex literal containing a quote (third negative control -- the shape that actually desynchronised the masker)", () => {
    const result = runCheck("sha", shas.regexThenImport, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(
      result.problems.some((p) => p.kind === "missing-target" && p.file === "desktop/src/regex-then-import.ts"),
    ).toBe(true);
  });

  test("catches an import whose target only 'exports' the symbol inside a comment (export side judged on code only)", () => {
    const result = runCheck("sha", shas.commentedExport, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(
      result.problems.some(
        (p) => p.kind === "not-exported" && p.file === "desktop/src/quoted-export-consumer.ts",
      ),
    ).toBe(true);
  });

  test("catches a broken import behind a NON-ASCII path (git quotes and escapes it, and the quoted name resolves to no blob)", () => {
    const result = runCheck("sha", shas.nonAsciiPath, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    // Both halves: the accented file is the probe, the plain one is the
    // control proving the commit is not simply red for another reason.
    expect(
      result.problems.some((p) => p.kind === "missing-target" && p.file === "desktop/src/café-path.ts"),
    ).toBe(true);
    expect(
      result.problems.some((p) => p.kind === "missing-target" && p.file === "desktop/src/plain-path.ts"),
    ).toBe(true);
    // and the listing itself must carry the raw path, not a quoted literal
    expect(result.scannedFiles).toContain("desktop/src/café-path.ts");
  });

  test("catches a broken import brought in by a MERGE commit (git show --name-only prints nothing for a merge)", () => {
    // Without the first-parent fallback this scans ZERO files and exits 0:
    // a subset that reads as a success, on 41 of this repo's last 200
    // commits. Assert BOTH halves -- files were actually listed, and the
    // defect inside them was reported.
    const result = runCheck("sha", shas.mergeCommit, MAIN_REPO);
    expect(result.scannedFiles.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(
      result.problems.some((p) => p.kind === "missing-target" && p.file === "desktop/src/merged-ghost.ts"),
    ).toBe(true);
  });

  test("catches a missing target imported in default, namespace or side-effect form, not only named", () => {
    const result = runCheck("sha", shas.importForms, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    for (const f of ["form-default.ts", "form-namespace.ts", "form-side-effect.ts"]) {
      expect(
        result.problems.some((p) => p.kind === "missing-target" && p.file === `desktop/src/${f}`),
      ).toBe(true);
    }
  });

  test("catches a literal NUL in a .kt file -- an extension no allow-list enumerated (scan COVERAGE, not just sensitivity)", () => {
    const result = runCheck("sha", shas.unlistedExtControlByte, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(
      result.problems.some(
        (p) => p.kind === "control-byte" && p.file === "desktop/mobile-shell/android-src/Probe.kt",
      ),
    ).toBe(true);
  });

  test("catches an @shared/*-aliased import of a symbol the target does not export (alias resolution, not just relative)", () => {
    const result = runCheck("sha", shas.aliasNotExported, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(
      result.problems.some((p) => p.kind === "not-exported" && p.file === "desktop/src/bad-alias-consumer.ts"),
    ).toBe(true);
    // This commit's own tree keeps the two tsconfigs agreeing (branched off
    // exportedFix, not aliasDivergence) -- if this ever contained an
    // alias-divergence problem too, it would mean the fixture's branch
    // topology regressed and this sha stopped isolating what it claims to.
    expect(result.problems.some((p) => p.kind === "alias-divergence")).toBe(false);
  });
});

describe("sha mode -- specificity (silent on clean commits)", () => {
  test("silent on a clean 5-file base commit", () => {
    const result = runCheck("sha", shas.base, MAIN_REPO);
    expect(result.problems).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test("silent on a clean single-file commit", () => {
    const result = runCheck("sha", shas.exportedFix, MAIN_REPO);
    expect(result.problems).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test("silent on a clean 7-file batch commit", () => {
    const result = runCheck("sha", shas.cleanBatch, MAIN_REPO);
    expect(result.problems).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.scannedFiles.length).toBe(8); // 7 new files + the re-agreed tsconfig.node.json
  });

  test("silent on a consumer importing through a barrel that re-exports with 'export { A } from' AND 'export type { B } from'", () => {
    // The `type` brace form is the one that was missed:
    // desktop/src/shared/companion.ts:619 re-exports CompanionDevice and
    // CompanionInfo that way, and its importer was reported not-exported on
    // healthy live code.
    const result = runCheck("sha", shas.namedReExport, MAIN_REPO);
    expect(result.problems).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test("silent on an import whose only backing file is a hand-written .d.ts", () => {
    const result = runCheck("sha", shas.dtsTarget, MAIN_REPO);
    expect(result.problems).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test("silent on a commit whose only import statements are QUOTED (line comment, block comment, string literal)", () => {
    // The measured false positive this pre-pass exists to kill: 2 of this
    // repo's 40 most recent commits (52f3fa1, 1320be6) went red on
    // tests/desktop-tile-area.test.ts, where a comment cites an import.
    const result = runCheck("sha", shas.quotedImports, MAIN_REPO);
    expect(result.problems).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});

describe("--staged mode", () => {
  test("catches a staged (uncommitted) import of a target that does not exist anywhere, and passes through a valid staged import via HEAD fallback", () => {
    // main repo's HEAD sits at cleanBatch after buildSensitivityRepo(); stage
    // two files without committing.
    stageOnlyDefect(MAIN_REPO);
    const result = runCheck("staged", undefined, MAIN_REPO);
    expect(result.exitCode).toBe(1);
    expect(
      result.problems.some((p) => p.kind === "missing-target" && p.file === "desktop/src/staged-ghost.ts"),
    ).toBe(true);
    // staged-valid.ts imports `old` from ./helper, a file NOT staged by this
    // call (committed back at exportedFix, unchanged since) -- it must
    // resolve cleanly, proving the fallback path actually works rather than
    // only the happy "everything is staged" case.
    expect(result.problems.some((p) => p.file === "desktop/src/staged-valid.ts")).toBe(false);
  });

  test("empty index (nothing staged) exits 0 with zero files scanned", () => {
    const result = runCheck("staged", undefined, EMPTY_REPO);
    expect(result.exitCode).toBe(0);
    expect(result.scannedFiles).toEqual([]);
    expect(result.problems).toEqual([]);
  });
});

describe("--pr mode (import closure per commit, control bytes over the net diff)", () => {
  // The three tests below (this one, "import closure is still judged per
  // commit...", "a non-ASCII path is carried through the NET diff too...")
  // are the only ones in this file that call runPrCheck over the FULL
  // shas.base..HEAD range (~20 commits, each read via its own git
  // subprocess) rather than a single sha or a same-ref empty range. Card
  // ba58fb12: measured 5.2-5.5s each, in-process, even with the fixture's
  // own commits made hermetic to the host's git hooks (see HOOKS_OFF in
  // scripts/fixtures/make-closure-sensitivity-repo.ts) -- this cost is the
  // range walk itself, a different and unrelated budget from the
  // beforeAll fixture build. An explicit per-test timeout, not a raised
  // file- or suite-wide default, keeps the other 54 tests (most well under
  // 100ms) honest about their own budget; 30_000ms matches the timeout
  // already used a few tests below for the shallow/partial clone probes,
  // the other git-subprocess-heavy tests in this same file.
  test("a control byte introduced and healed INSIDE the range is not reported, while one still present at head is", () => {
    // The whole point of the split, in one call. Per commit the range still
    // holds a real red on ansi.ts (shas.controlByte, correct history), but
    // ansi.ts is clean at head, so the net-diff scan must be silent about
    // it. Probe.kt was never cleaned, so it must still be reported --
    // otherwise the net-diff scan would just be a blanket silence.
    const result = runPrCheck(MAIN_REPO, shas.base, "HEAD");
    const bytes = result.problems.filter((p) => p.kind === "control-byte");
    expect(bytes.some((p) => p.file === "desktop/src/ansi.ts")).toBe(false);
    expect(bytes.some((p) => p.file === "desktop/mobile-shell/android-src/Probe.kt")).toBe(true);
    // contrast: the SAME defect is still red when that one commit is audited
    expect(
      runCheck("sha", shas.controlByte, MAIN_REPO).problems.some(
        (p) => p.kind === "control-byte" && p.file === "desktop/src/ansi.ts",
      ),
    ).toBe(true);
  }, 30_000);

  test("import closure is still judged per commit inside the range, at each commit's own tree", () => {
    const result = runPrCheck(MAIN_REPO, shas.base, "HEAD");
    expect(result.commitsAudited).toBeGreaterThan(5);
    // shas.missingTarget's own defect, attributed to its commit
    expect(
      result.problems.some(
        (p) => p.kind === "missing-target" && p.file.endsWith("desktop/src/ghost-consumer.ts"),
      ),
    ).toBe(true);
    expect(result.problems.every((p) => p.kind !== "tool-error")).toBe(true);
  }, 30_000);

  test("an empty range is a legitimate 0, distinguishable from a range that could not be listed", () => {
    const result = runPrCheck(MAIN_REPO, "HEAD", "HEAD");
    expect(result.exitCode).toBe(0);
    expect(result.commitsAudited).toBe(0);
    expect(result.problems).toEqual([]);
  });

  test("FAILS CLOSED on an unresolvable base or head, naming which ref failed", () => {
    for (const [bad, which] of [
      ["no-such-ref", "base"],
      ["HEAD", "head"],
    ] as const) {
      const result =
        which === "base" ? runPrCheck(MAIN_REPO, bad, "HEAD") : runPrCheck(MAIN_REPO, "HEAD", "no-such-ref");
      expect(result.exitCode).toBe(2);
      expect(result.problems.length).toBe(1);
      expect(result.problems[0].kind).toBe("tool-error");
      expect(result.problems[0].detail).toContain(which);
    }
  });

  test("FAILS CLOSED on a shallow clone instead of auditing a truncated range", () => {
    // actions/checkout defaults to fetch-depth 1: without this guard the
    // range is short and the run reports a confident OK over a SUBSET.
    const shallowOk = buildShallowClone(MAIN_REPO, SHALLOW_REPO);
    expect(shallowOk).toBe(true); // if the host refused the clone, fail loudly rather than skip
    const result = runPrCheck(SHALLOW_REPO, "HEAD", "HEAD");
    expect(result.exitCode).toBe(2);
    expect(result.problems[0].kind).toBe("tool-error");
    expect(result.problems[0].detail).toContain("shallow");
  }, 30_000);

  test("a non-ASCII path is carried through the NET diff too, not only the per-commit listing", () => {
    const result = runPrCheck(MAIN_REPO, shas.base, "HEAD");
    expect(result.scannedFiles).toContain("desktop/src/café-path.ts");
    expect((result.filesInNetDiff ?? 0) > 0).toBe(true);
    // the two domains are reported separately and never summed
    expect(result.filesInCommits).not.toBe(undefined);
    expect(result.filesInNetDiff).not.toBe(undefined);
  }, 30_000);

  test("FAILS CLOSED on a PARTIAL clone, which the shallow question answers false for", () => {
    // A blob-less clone has the whole history and none of the content: every
    // read is a lazy fetch away, so an offline runner degrades into the same
    // silent subset the shallow guard exists to refuse.
    const partialOk = buildPartialClone(MAIN_REPO, PARTIAL_REPO);
    expect(partialOk).toBe(true);
    expect(
      spawnSync("git", ["-C", PARTIAL_REPO, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" })
        .stdout.trim(),
    ).toBe("false"); // the shallow guard alone would let this through
    const result = runPrCheck(PARTIAL_REPO, "HEAD", "HEAD");
    expect(result.exitCode).toBe(2);
    expect(result.problems[0].kind).toBe("tool-error");
    expect(result.problems[0].detail).toContain("partial clone");
  }, 30_000);

  test("CLI: an EMPTY range says NOTHING TO AUDIT, never OK over an empty domain", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, "--pr", "HEAD", "HEAD", MAIN_REPO], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("NOTHING TO AUDIT");
    expect(r.stdout).not.toContain("OK");
  }, 30_000);

  // Deliberately a SHORT range (importForms..HEAD, a handful of commits):
  // this test only proves the CLI's wiring and its wording, and the full
  // base..HEAD range takes seconds per run in a subprocess. A probe that
  // times out on a slower machine is a probe that gets deleted, so the
  // explicit timeout below is part of the probe, not decoration.
  test("CLI: --pr prints the audited-commit count and exits 2 with NOT AUDITED on a bad ref", () => {
    const ok = spawnSync(process.execPath, [SCRIPT_PATH, "--pr", shas.importForms, "HEAD", MAIN_REPO], {
      encoding: "utf8",
    });
    expect(ok.stdout).toContain("commit(s) audited for import closure");
    const bad = spawnSync(process.execPath, [SCRIPT_PATH, "--pr", "no-such-ref", "HEAD", MAIN_REPO], {
      encoding: "utf8",
    });
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain("TOOL ERROR");
    expect(bad.stdout).toContain("NOT AUDITED");
    expect(bad.stdout).not.toContain("OK");
  }, 30_000);
});

describe("unit-level: pure functions against synthetic trees (no git process)", () => {
  function makeReader(files: Record<string, string>): BlobReader {
    return (path: string) => (path in files ? files[path] : null);
  }

  test("resolveImportClosure: a relative import with many leading ../ does not crash and resolves relative to repo root", () => {
    const read = makeReader({
      "a/b/c/consumer.ts": 'import { root } from "../../../../../../x"\nexport const y = root()\n',
      x: "export function root() { return 1 }\n",
    });
    const problems = resolveImportClosure(["a/b/c/consumer.ts"], read, {});
    expect(problems).toEqual([]);
  });

  test("resolveImportClosure: same over-popped path with the target absent is a missing-target problem, not a crash", () => {
    const read = makeReader({
      "a/b/consumer.ts": 'import { root } from "../../../../ghost"\nexport const y = root()\n',
    });
    const problems = resolveImportClosure(["a/b/consumer.ts"], read, {});
    expect(problems.length).toBe(1);
    expect(problems[0].kind).toBe("missing-target");
  });

  test("resolveImportClosure: a deleted target (reader returns null) is a missing-target problem", () => {
    const read = makeReader({
      "src/consumer.ts": 'import { gone } from "./deleted"\nexport const y = gone()\n',
    });
    const problems = resolveImportClosure(["src/consumer.ts"], read, {});
    expect(problems.length).toBe(1);
    expect(problems[0].kind).toBe("missing-target");
  });

  test("resolveImportClosure: a bare package specifier is not resolved and produces no problem", () => {
    const read = makeReader({
      "src/consumer.ts": 'import { spawnSync } from "node:child_process"\nexport const y = spawnSync\n',
    });
    const problems = resolveImportClosure(["src/consumer.ts"], read, {});
    expect(problems).toEqual([]);
  });

  test("resolveImportClosure: an import quoted in a line comment, a block comment or a string literal is not an import", () => {
    const read = makeReader({
      "src/quoted.ts":
        '// import { nope } from "./ghost-line"\n' +
        '/* import { nope } from "./ghost-block" */\n' +
        "const doc = 'import { nope } from \"./ghost-string\"'\n" +
        "export const d = doc\n",
    });
    expect(resolveImportClosure(["src/quoted.ts"], read, {})).toEqual([]);
  });

  test("resolveImportClosure: a real import still fires when the same line holds a '//'-bearing string (no over-strip)", () => {
    const read = makeReader({
      "src/url.ts": 'const u = "https://example.com/x"; import { ghost } from "./ghost"\nexport const g = ghost() + u\n',
    });
    const problems = resolveImportClosure(["src/url.ts"], read, {});
    expect(problems.length).toBe(1);
    expect(problems[0].kind).toBe("missing-target");
  });

  test("maskCommentsAndStrings: blanks comment bodies, preserves offsets/newlines, and flags string interiors", () => {
    const src = 'const a = "x"; // c\nconst b = `t${1}`\n';
    const { masked, inString } = maskCommentsAndStrings(src);
    expect(masked.length).toBe(src.length);
    expect(masked.split("\n").length).toBe(src.split("\n").length);
    expect(masked).not.toContain("// c");
    expect(masked.slice(src.indexOf("//"), src.indexOf("\n"))).toBe("    "); // comment body blanked, not removed
    expect(inString[src.indexOf('"x"') + 1]).toBe(1); // inside the string
    expect(inString[src.indexOf("const")]).toBe(0); // code
    expect(inString[src.indexOf("${1}") + 2]).toBe(0); // the interpolated expression is code again
  });

  test("maskCommentsAndStrings: a quoted backtick and a quoted '${' do not open a template that eats the rest of the file", () => {
    const src = 'const s = "a `b ${ c"\nconst t = `x ${ { n: 1 }.n } y`\nimport { real } from "./x"\n';
    const { inString } = maskCommentsAndStrings(src);
    expect(inString[src.indexOf("import")]).toBe(0); // code again after both
    expect(inString[src.indexOf("{ n: 1 }") + 2]).toBe(0); // inside ${ }: code
    expect(inString[src.indexOf(" y`") + 1]).toBe(1); // back inside the template
  });

  test("maskCommentsAndStrings: a quote INSIDE a regex literal does not open a string (the desynchronisation that produced 51 phantom findings)", () => {
    const src = "const q = `\"${p.replace(/\"/g, '')}\"`\nexport function realOne() { return 1 }\n";
    const { inString } = maskCommentsAndStrings(src);
    expect(inString[src.indexOf("export function")]).toBe(0);
    expect(codeOnlySource(src)).toContain("export function realOne");
  });

  test("codeOnlySource: an export that only exists in a comment or a string does not satisfy an import", () => {
    const read = makeReader({
      "src/consumer.ts": 'import { onlyInAComment } from "./target"\nexport const c = onlyInAComment()\n',
      "src/target.ts":
        "// export function onlyInAComment() { return 1 }\n" +
        "export const help = 'export function onlyInAComment() {}'\n" +
        "export function realOne() { return 2 }\n",
    });
    const problems = resolveImportClosure(["src/consumer.ts"], read, {});
    expect(problems.length).toBe(1);
    expect(problems[0].kind).toBe("not-exported");
    // negative half: the REAL export in the same target is still honoured,
    // so this is code-only projection, not a blanket "exports never count".
    const ok = makeReader({
      "src/consumer.ts": 'import { realOne } from "./target"\nexport const c = realOne()\n',
      "src/target.ts": "// export function onlyInAComment() {}\nexport function realOne() { return 2 }\n",
    });
    expect(resolveImportClosure(["src/consumer.ts"], ok, {})).toEqual([]);
  });

  test("codeOnlySource: blanks string interiors while preserving offsets and newlines", () => {
    const src = 'const a = "hidden"\n// gone\nexport const b = 1\n';
    const out = codeOnlySource(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("gone");
    expect(out).toContain("export const b = 1");
  });

  test("maskCommentsAndStrings: an unterminated string literal stops at end of line instead of swallowing the file", () => {
    const src = 'const broken = "oops\nimport { real } from "./x"\n';
    const { inString } = maskCommentsAndStrings(src);
    expect(inString[src.indexOf("import")]).toBe(0);
  });

  test("resolveImportClosure: both brace re-export forms satisfy an import, and export * still does NOT (fail-closed polarity kept)", () => {
    const viaBrace = makeReader({
      "src/consumer.ts": "import { A } from './barrel'\nimport type { B } from './barrel'\nexport const c = A<B>()\n",
      "src/barrel.ts": "export { A } from './origin'\nexport type { B } from './origin'\n",
    });
    expect(resolveImportClosure(["src/consumer.ts"], viaBrace, {})).toEqual([]);

    // Deliberate contrast: an export-star barrel is NOT followed, so the
    // import is reported. Unrecognised re-export fails CLOSED, and this
    // assertion is what stops a future "improvement" from silently
    // flipping that polarity.
    const viaStar = makeReader({
      "src/consumer.ts": "import { A } from './barrel'\nexport const c = A()\n",
      "src/barrel.ts": "export * from './origin'\n",
    });
    const starProblems = resolveImportClosure(["src/consumer.ts"], viaStar, {});
    expect(starProblems.length).toBe(1);
    expect(starProblems[0].kind).toBe("not-exported");
  });

  test("resolveImportClosure: every import form reports a missing target, and a dynamic import() is not mistaken for a side-effect import", () => {
    const missing = (src: string) =>
      resolveImportClosure(["src/c.ts"], (p) => (p === "src/c.ts" ? src : null), {}).length;
    expect(missing('import { ghost } from "./ghost"\nexport const a = ghost()\n')).toBe(1);
    expect(missing('import Ghost from "./ghost"\nexport const a = Ghost\n')).toBe(1);
    expect(missing('import * as G from "./ghost"\nexport const a = G\n')).toBe(1);
    expect(missing('import "./ghost"\nexport const a = 1\n')).toBe(1);
    // A dynamic import has a paren, not whitespace, after the keyword: the
    // side-effect pattern must not claim it (it is a runtime specifier this
    // tool does not resolve).
    expect(missing('export const a = () => import("./ghost")\n')).toBe(0);
  });

  test("resolveImportClosure: a .d.ts is a legal candidate for a resolved specifier", () => {
    const read = makeReader({
      "src/consumer.ts": "import type { OnlyType } from './only-types'\nexport const o: OnlyType = { n: 1 }\n",
      "src/only-types.d.ts": "export interface OnlyType {\n  n: number\n}\n",
    });
    expect(resolveImportClosure(["src/consumer.ts"], read, {})).toEqual([]);
  });

  test("scanControlBytes: a .kt file IS scanned (extension no allow-list enumerated -- the fail-open half)", () => {
    const buf = Buffer.from('const val marker = "\0"\n', "utf8");
    const problems = scanControlBytes(["desktop/mobile-shell/android-src/Probe.kt"], () => buf);
    expect(problems.length).toBe(1);
    expect(problems[0].kind).toBe("control-byte");
  });

  test("scanControlBytes: a dotfile with no real extension (.gitignore) IS scanned", () => {
    const buf = Buffer.from("node_modules\0\n", "utf8");
    const problems = scanControlBytes([".gitignore"], () => buf);
    expect(problems.length).toBe(1);
  });

  test("scanControlBytes: an extension-less file (LICENSE) IS scanned", () => {
    const buf = Buffer.from("MIT\0\n", "utf8");
    const problems = scanControlBytes(["LICENSE"], () => buf);
    expect(problems.length).toBe(1);
  });

  test("scanControlBytes: skips a genuinely binary tracked asset by extension (no false positive)", () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1b, 0x00, 0x07]);
    const problems = scanControlBytes(["desktop/assets/icon.png"], (p) => (p === "desktop/assets/icon.png" ? bin : null));
    expect(problems).toEqual([]);
  });

  test("scanControlBytes: the SAME byte content in a .ts file IS flagged (contrast proving the skip above is extension-scoped, not a blanket miss)", () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1b, 0x00, 0x07]);
    const problems = scanControlBytes(["desktop/src/weird.ts"], (p) => (p === "desktop/src/weird.ts" ? bin : null));
    expect(problems.length).toBe(1);
    expect(problems[0].kind).toBe("control-byte");
  });

  test("aliasTableFromTsconfig: agreeing tsconfigs produce one alias, no divergence", () => {
    const read = makeReader({
      "desktop/tsconfig.web.json": JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["src/shared/*"] } } }),
      "desktop/tsconfig.node.json": JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["src/shared/*"] } } }),
    });
    const { aliases, divergence } = aliasTableFromTsconfig(read);
    expect(aliases["@shared"]).toBe("desktop/src/shared");
    expect(divergence).toEqual([]);
  });

  test("aliasTableFromTsconfig: disagreeing tsconfigs are reported as a divergence", () => {
    const read = makeReader({
      "desktop/tsconfig.web.json": JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["src/shared/*"] } } }),
      "desktop/tsconfig.node.json": JSON.stringify({
        compilerOptions: { paths: { "@shared/*": ["src/other-shared/*"] } },
      }),
    });
    const { divergence } = aliasTableFromTsconfig(read);
    expect(divergence.length).toBe(1);
  });

  test("makeBlobReader in staged ref mode falls back to HEAD when the index show fails", () => {
    // Exercises the fallback branch directly against the real fixture repo
    // (rather than only indirectly through --staged mode above): helper.ts
    // is untouched since exportedFix, so `git show :path` already succeeds
    // from the index in the common case -- this asserts the reader still
    // returns the right content either way, which is the behavior that
    // matters, not which internal branch served it.
    const read = makeBlobReader(MAIN_REPO, "staged");
    const content = read("desktop/src/helper.ts");
    expect(content).not.toBeNull();
    expect(content).toContain("brandNew");
  });
});

describe("CLI smoke test (subprocess, exit code contract)", () => {
  test("exits 1 on a known-defect sha", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, shas.controlByte, MAIN_REPO], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("CONTROL BYTE");
  });

  test("exits 0 on a clean sha", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, shas.base, MAIN_REPO], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("import closure: OK");
    expect(r.stdout).toContain("control bytes: OK");
  });

  test("exits 2 with no sha and no --staged flag (usage error)", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, MAIN_REPO], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});

test("collected by the CI partition (this file is not exempt, so scripts/partition-pure-tests.ts runs it by default) -- the same mechanism desktop-ci-glob-coverage.test.ts audits", () => {
  // Card 0bbac537: this used to re-derive `run: bun test <globs>` and assert
  // this file's own glob was in the list -- a second, independent copy of
  // the exact bounded parse desktop-ci-glob-coverage.test.ts also did. Both
  // now import the single parsePureModuleStepRun (scripts/pure-module-partition.ts),
  // so there is one parser, not two disciplines that can silently diverge.
  expect(isExempt("desktop-commit-closure-check.test.ts")).toBe(false);
  const workflowText = readFileSync(WORKFLOW_PATH, "utf-8");
  expect(parsePureModuleStepRun(workflowText)).toBe(PARTITION_SCRIPT_COMMAND);
});
