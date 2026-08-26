// Card 9ef6f513. desktop-tsconfig-flags.test.ts (cards a7822bc4/d07ab3f0)
// pins the FLAGS a discovered desktop tsconfig carries and the SOURCE FILES
// its include array covers. Neither pins that program's EXECUTION: nothing
// stopped .github/workflows/desktop-build.yml from losing the "Typecheck
// desktop (node + web)" or "Typecheck the mobile shell" step (or having it
// quietly neutralized) while every tsconfig-flags/source-coverage test above
// stayed green and the whole suite stayed green -- the exact "degradation
// that yields a subset, not an error" shape CLAUDE.md's gating-coverage rule
// warns about, already realized once on this same surface (the CI glob that
// silently ran 78 of 116 files, TESTING.md "Cross-platform tests").
//
// This file closes that gap by DISCOVERING the programs to typecheck
// structurally, never a hardcoded step list: a desktop tsconfig counts as a
// real program iff it carries its OWN `compilerOptions` (desktop/tsconfig.json
// is a solution file -- `files: []`, only `references` -- with no
// compilerOptions of its own, so it is excluded by construction, no
// hand-maintained exemption list required, unlike EXEMPT_CONFIGS in
// desktop-tsconfig-flags.test.ts). For each discovered program, a CI step
// must actually invoke `tsc ... -p <that config>`, resolved TRANSITIVELY
// through `npm run <script>` indirection by reading the real
// desktop/package.json scripts table (so "npm run typecheck" resolving to
// "typecheck:node && typecheck:web" resolving to two separate `tsc -p`
// invocations is followed, not just pattern-matched on the literal string
// "typecheck"). Steps are matched by the COMMAND they run, never by `name:`
// (a step is free to rename itself; a step is not free to stop invoking tsc).
//
// THE NEIGHBOR-KEY QUESTION (team-lead brief, 2026-08-26): a guard proven
// sensitive on `continue-on-error: true` is a single key. The direct
// neighbor that achieves the identical "step present, decorative" effect
// through a DIFFERENT mechanism entirely is a shell-level failure swallow
// appended to the run line itself (`... || true`, `... || exit 0`) -- no
// GitHub Actions key involved at all, so a detector keyed only on YAML keys
// (continue-on-error, if:) would stay green on this mutation. isNeutralized()
// below checks all three; the mutation-proof tests exercise each
// independently so a regression in any one of the three stays loud. So does a
// JOB-LEVEL kill switch (jobLevelSafe): one `continue-on-error`/`if: false`
// above every step, or an `on:` trigger reduced to drop `push`/`pull_request`,
// makes every step-level check below it decorative in one line -- checked on
// the text preceding the first step marker so it needs no hardcoded key path.
// A swallow can also be moved one level deeper than the run: line, into a
// RESOLVED npm script's own body (`resolveTsConfigsForRun` reads that body to
// extract `-p`), and a typecheck command can be commented out (`# tsc ...`)
// inside a multi-line `run:` block while still text-matching the same
// extraction regex -- both checked before a config is ever counted covered.
//
// TEAM-LEAD AUDIT, MUTATION REVIEW 2026-08-26: found this paragraph
// understating its own gaps -- a prior version claimed a single known
// residual where nine forms of neutralization actually passed green. This is
// the MEASURED list of what remains open AFTER the fixes above, not before:
//
//   - `|| :` (a no-op command, not `true`/`exit 0`) as a shell swallow --
//     SHELL_SWALLOW_RE only recognizes the two forms actually seen in this
//     workflow today.
//   - a shell-level negated conditional (`if ! tsc ...; then ... fi`) --
//     no `||` is present at all, so no swallow-shaped regex sees it, and
//     nothing here parses shell control flow.
//   - `shell: bash {0}` on a multi-line `run:` block -- GitHub Actions' custom
//     shell invocation syntax drops the implicit `-eo pipefail` that a plain
//     `shell: bash` gets, so a failing command mid-script does not fail the
//     step; no such invocation exists in this workflow today.
//   - a non-literal, always-false `if:` expression (e.g. an `${{ }}`
//     comparison that evaluates to false without the literal token `false`
//     appearing) -- IF_FALSE_RE matches the literal, not arbitrary expression
//     evaluation, which this file cannot do without a GitHub Actions
//     expression evaluator.
//
// These four are shell/expression CONTROL FLOW, structurally out of scope for
// a YAML-text-level guard the same way the original `set +e` residual was --
// catching them generally would mean parsing shell, not YAML. Separately, the
// tsconfig DOMAIN discovery (collectTypecheckedConfigs) has its own known
// gaps, orthogonal to neutralization: an `extends`-only tsconfig with no own
// `compilerOptions` key is excluded from the domain by construction (the same
// rule that correctly excludes desktop/tsconfig.json's solution-file shape
// cannot distinguish the two); a tsconfig using `/* */` block comments is
// unparseable by `stripJsonComments` (line-comment stripper only) and is
// skipped SILENTLY rather than failing loud, same as any other unparseable
// tsconfig. And on the other side, a legitimate rewrite of a run line --
// `tsc --project` instead of `-p`, `npm run -s <script>`, or `bun run
// <script>` instead of `npm run` -- is not matched by `tscRe`/`npmRunRe`
// either, so it would read as a FALSE "not typechecked by any live CI step"
// alarm rather than a silent hole: a fail-CLOSED false positive, the safer
// direction to be wrong in, but still a maintenance trap for whoever rewrites
// these steps next.
//
// Team-lead audit 2026-08-26: this file used to claim its `tests/desktop-*`
// naming is why the CI partition collects it. Measured false: partition-
// pure-tests.ts's listTestFiles reads every `tests/*.test.ts` file via a
// plain readdirSync, and scripts/pure-module-partition.ts's isExempt is a
// DENY-list keyed on `broker-`/`server-` prefixes and two exact filenames --
// the "desktop-" prefix carries no meaning to either function, and an
// identically-shaped file with no prefix at all would be collected the same
// way. Named `desktop-ci-typecheck-coverage.test.ts` to sit alongside its
// sibling `desktop-ci-*.test.ts` files for a human scanning the directory,
// nothing more.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const DESKTOP_ROOT = join(REPO_ROOT, "desktop");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "desktop-build.yml");
const REAL_WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, "utf-8");

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

// ----- tsconfig domain discovery: structural, not a hardcoded list --------

// Same pruning as desktop-tsconfig-flags.test.ts's collectTsconfigs: vendored
// dependency trees and build output ship their own tsconfig*.json files and
// must never be descended into.
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "out"]);

// Same single-piece-of-state `//`-comment stripper as
// desktop-tsconfig-flags.test.ts (JSON has no other comment-adjacent literal
// forms to worry about -- see that file's header for why this is safe for
// JSONC tsconfigs specifically). Duplicated deliberately: that file owns no
// exported production module for this repo to import from, and this file's
// scope for this card is "the workflow + the tests I add", not a refactor of
// a sibling test file's internals.
function stripJsonComments(src: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

function parseJsonc(src: string): unknown {
  return JSON.parse(stripJsonComments(src));
}

/**
 * Walks `root`, returning the absolute path of every tsconfig*.json that
 * carries its own `compilerOptions` key -- the structural property that
 * makes it an actual `tsc -p` program, as opposed to a solution file (`files:
 * []`, only `references`) like desktop/tsconfig.json. This is deliberately
 * NOT a hand-maintained exemption list: a future solution-file-shaped config
 * is excluded automatically by the same rule, and a future real program is
 * included automatically the same way, with nothing here to edit either way.
 * An unparseable tsconfig is skipped rather than thrown on -- this function's
 * job is domain discovery, not tsconfig validity, which desktop-tsconfig-
 * flags.test.ts already audits separately.
 */
function collectTypecheckedConfigs(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !/^tsconfig.*\.json$/.test(entry.name)) continue;
      const abs = join(dir, entry.name);
      let parsed: unknown;
      try {
        parsed = parseJsonc(readFileSync(abs, "utf-8"));
      } catch {
        continue;
      }
      if (parsed && typeof parsed === "object" && Object.hasOwn(parsed as object, "compilerOptions")) {
        out.push(abs);
      }
    }
  }
  walk(root);
  return out;
}

// ----- bounded workflow step parser (derives indentation, never hardcodes it) --

interface StepBounds {
  start: number;
  end: number;
  block: string;
}

/**
 * Splits `text` into step blocks bounded at each `- name:`/`- uses:` marker
 * (the first key of every GitHub Actions step, by convention -- also relied
 * on by tests/desktop-ci-glob-coverage.test.ts's parsePureModuleStepRun for
 * the same file). The indentation of the marker itself is captured and used
 * as the boundary, never a literal column count, so this is correct at
 * whatever indent level the workflow actually uses (mirrors N2's fix in that
 * sibling file, mutation-proofed below the same way).
 */
function stepBoundsList(text: string): StepBounds[] {
  const markerRe = /\n( +)- (?:name|uses):/g;
  const positions: number[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = markerRe.exec(text))) {
    positions.push(mm.index + 1);
  }
  const result: StepBounds[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i]!;
    const end = i + 1 < positions.length ? positions[i + 1]! : text.length;
    result.push({ start, end, block: text.slice(start, end) });
  }
  return result;
}

function splitWorkflowSteps(text: string): string[] {
  return stepBoundsList(text).map((b) => b.block);
}

/**
 * Extracts a step's `run:` value, handling both the single-line form
 * (`run: cmd`) and the YAML block-scalar form (`run: |` / `run: >` followed
 * by more-indented lines) -- the same composition
 * tests/desktop-ci-glob-coverage.test.ts's parsePureModuleStepRun already
 * guards for the pure-module step, reused here so a future reformat of
 * either typecheck step's `run:` line does not silently blind this parser.
 */
// Team-lead audit 2026-08-26: a `#`-commented line inside a `run:` block
// still matched tscRe/npmRunRe below (neither regex knows what a shell
// comment is), so a typecheck invocation commented OUT still counted as
// coverage. Stripped once, here, so every consumer of extractRun's return
// value (resolveTsConfigsForRun, isNeutralized's SHELL_SWALLOW_RE check on
// step.run) sees the shell as it actually executes, not as it reads.
function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function extractRun(block: string): string | undefined {
  const m = /^([ \t]*)run:[ \t]*(.*)$/m.exec(block);
  if (!m) return undefined;
  const indent = m[1]!.length;
  const rest = m[2]!.trim();
  if (rest !== "" && rest !== "|" && rest !== ">" && rest !== "|-" && rest !== ">-") {
    return stripCommentLines(rest);
  }
  const remainder = block.slice(m.index! + m[0].length);
  const collected: string[] = [];
  for (const line of remainder.split("\n")) {
    if (line.trim() === "") {
      collected.push("");
      continue;
    }
    const lineIndent = /^[ \t]*/.exec(line)![0]!.length;
    if (lineIndent <= indent) break;
    collected.push(line.trim());
  }
  return stripCommentLines(collected.join("\n"));
}

interface ParsedStep {
  name?: string;
  workingDirectory?: string;
  run?: string;
  rawBlock: string;
}

function parseStep(block: string): ParsedStep {
  const nameMatch = /^\s*-\s*name:\s*(.+)$/m.exec(block);
  const wdMatch = /^[ \t]*working-directory:\s*(\S+)/m.exec(block);
  return {
    name: nameMatch?.[1]?.trim(),
    workingDirectory: wdMatch?.[1],
    run: extractRun(block),
    rawBlock: block,
  };
}

// ----- neutralization: three independent mechanisms, keyed by MEANING -----

const CONTINUE_ON_ERROR_TRUE_RE = /^[ \t]*continue-on-error:[ \t]*(?:\$\{\{\s*)?true(?:\s*\}\})?[ \t]*$/im;
const IF_FALSE_RE = /^[ \t]*if:[ \t]*(?:\$\{\{\s*)?false(?:\s*\}\})?[ \t]*$/im;
const SHELL_SWALLOW_RE = /\|\|\s*(?:true\b|exit\s+0\b)/;

/**
 * A step is neutralized -- present in the workflow but never actually able
 * to fail the job -- if ANY of three independent mechanisms apply:
 * `continue-on-error: true` (also its `${{ true }}` templated form), an
 * always-false `if:` (same two forms), or a shell-level failure swallow
 * appended directly to the run line (`|| true` / `|| exit 0`) -- the
 * neighbor-key case from the header comment: it uses no GitHub Actions key
 * at all, so a detector checking only the first two would miss it.
 */
function isNeutralized(step: ParsedStep): boolean {
  return CONTINUE_ON_ERROR_TRUE_RE.test(step.rawBlock) || IF_FALSE_RE.test(step.rawBlock) || SHELL_SWALLOW_RE.test(step.run ?? "");
}

// ----- run-line -> tsconfig resolution, transitively through npm scripts --

/**
 * Resolves the set of tsconfig paths (repo-root-relative) a step's `run:`
 * text actually invokes `tsc -p` against, following `npm run <script>`
 * indirection recursively via `readPackageScripts` (injectable so the fixture
 * tests below never touch the real filesystem). `visited` guards against a
 * pathological self-referential script cycle.
 */
function resolveTsConfigsForRun(
  run: string,
  workingDir: string | undefined,
  repoRoot: string,
  readPackageScripts: (absDir: string) => Record<string, string> | undefined,
  visited: Set<string> = new Set()
): string[] {
  const results: string[] = [];
  const dirAbs = workingDir ? join(repoRoot, workingDir) : repoRoot;

  const tscRe = /\btsc\b[^\n]*?-p\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = tscRe.exec(run))) {
    const arg = m[1]!.replace(/^"|"$/g, "");
    results.push(toRepoRelative(join(dirAbs, arg)));
  }

  const npmRunRe = /\bnpm run ([\w:.-]+)/g;
  let n: RegExpExecArray | null;
  while ((n = npmRunRe.exec(run))) {
    const scriptName = n[1]!;
    const key = `${dirAbs}::${scriptName}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const scripts = readPackageScripts(dirAbs);
    const body = scripts?.[scriptName];
    if (!body) continue;
    // Team-lead audit 2026-08-26: the neighbor-key argument in the header
    // applies one level deeper too -- a swallow does not have to sit on the
    // workflow's run: line at all. Moving it into the RESOLVED npm script's
    // own body (`"typecheck:node": "tsc --noEmit -p tsconfig.node.json || true"`)
    // defeats coverage identically, since this function already reads that
    // body to extract the -p argument. Checked on the body BEFORE recursing
    // into it, so a swallow on a composing script (`typecheck: "npm run
    // typecheck:node && npm run typecheck:web || true"`) drops every leaf
    // config it would otherwise have resolved, not just its own direct
    // matches (it has none).
    if (SHELL_SWALLOW_RE.test(body)) continue;
    results.push(...resolveTsConfigsForRun(body, workingDir, repoRoot, readPackageScripts, visited));
  }
  return results;
}

function realReadPackageScripts(absDir: string): Record<string, string> | undefined {
  const p = join(absDir, "package.json");
  if (!existsSync(p)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf-8")) as { scripts?: Record<string, string> };
    return pkg.scripts;
  } catch {
    return undefined;
  }
}

// ----- job-level kill switch: one line above the steps defeats all of them --

/**
 * Team-lead audit 2026-08-26, the highest-value fix in this pass: every
 * check above is scoped to a single STEP, but `continue-on-error`/`if:`
 * are legal on the JOB too, and either one there makes the whole job
 * non-blocking regardless of what any step below does. Same effect from the
 * other direction: reducing the `on:` trigger to drop `push`/`pull_request`
 * means the workflow simply never runs on the events that matter, which is
 * observably identical to every step inside it being neutralized. Checked on
 * the text that PRECEDES the first step boundary (`stepBoundsList`'s own
 * marker) rather than a named YAML path, so it is structural: whatever job
 * keys or trigger shape exist above the first `- name:`/`- uses:` line are
 * covered by construction, nothing here to update if the job grows a new key.
 */
function jobPrefixText(text: string): string {
  const firstStart = stepBoundsList(text)[0]?.start ?? text.length;
  return text.slice(0, firstStart);
}

function jobLevelSafe(text: string): boolean {
  const prefix = jobPrefixText(text);
  if (CONTINUE_ON_ERROR_TRUE_RE.test(prefix) || IF_FALSE_RE.test(prefix)) return false;
  return /^[ \t]*push:/m.test(prefix) && /^[ \t]*pull_request:/m.test(prefix);
}

/**
 * The set of tsconfig paths actually type-checked by SOME non-neutralized
 * step in `workflowText`. A neutralized step's resolved configs are dropped
 * entirely (not just flagged) -- since today each config is checked by
 * exactly one step, this makes "step removed" and "step neutralized"
 * collapse into the identical observable effect on `covered`, which is what
 * lets one coverage assertion catch both mutation families. A job-level kill
 * switch (see jobLevelSafe) empties the whole set outright: nothing below it
 * is trustworthy once the job itself cannot fail, or cannot even run.
 */
function coveredConfigsFromWorkflowText(
  workflowText: string,
  repoRoot: string,
  readPackageScripts: (absDir: string) => Record<string, string> | undefined
): Set<string> {
  const covered = new Set<string>();
  if (!jobLevelSafe(workflowText)) return covered;
  for (const block of splitWorkflowSteps(workflowText)) {
    const step = parseStep(block);
    if (isNeutralized(step)) continue;
    for (const c of resolveTsConfigsForRun(step.run ?? "", step.workingDirectory, repoRoot, readPackageScripts)) {
      covered.add(c);
    }
  }
  return covered;
}

// ----- mutation helpers: operate on an in-memory COPY of the workflow text --
// Per team-lead instruction: never mutate the real .github/workflows/
// desktop-build.yml on this shared checkout. Every function below takes a
// text string and returns a new string; none of them touch the filesystem.

/**
 * Team-lead audit 2026-08-26: the previous selector (`findStepBoundsByName`)
 * picked the step to mutate by its hardcoded `name:` string -- but this
 * file's own header says renaming a step is legitimate ("Steps are matched
 * by the COMMAND they run, never by `name:`"). A rename would therefore make
 * these mutation-proof tests throw with "step not found", reading as a test
 * bug rather than the real regression they exist to catch. Selects by the
 * SAME property the production check itself keys on instead: the tsconfig
 * the step's `run:` actually resolves to, via `resolveTsConfigsForRun` --
 * so a step surviving a rename is still found by what it does, not what it
 * is called.
 */
function findStepBoundsByResolvedConfig(
  text: string,
  configPath: string,
  repoRoot: string,
  readPackageScripts: (absDir: string) => Record<string, string> | undefined
): StepBounds {
  for (const bounds of stepBoundsList(text)) {
    const step = parseStep(bounds.block);
    const resolved = resolveTsConfigsForRun(step.run ?? "", step.workingDirectory, repoRoot, readPackageScripts);
    if (resolved.includes(configPath)) return bounds;
  }
  throw new Error(`no step resolves config: ${configPath}`);
}

function removeStepResolvingConfig(
  text: string,
  configPath: string,
  repoRoot: string,
  readPackageScripts: (absDir: string) => Record<string, string> | undefined
): string {
  const target = findStepBoundsByResolvedConfig(text, configPath, repoRoot, readPackageScripts);
  return text.slice(0, target.start) + text.slice(target.end);
}

function addContinueOnErrorTrue(
  text: string,
  configPath: string,
  repoRoot: string,
  readPackageScripts: (absDir: string) => Record<string, string> | undefined
): string {
  const target = findStepBoundsByResolvedConfig(text, configPath, repoRoot, readPackageScripts);
  const runLine = /^([ \t]*)run:/m.exec(target.block);
  if (!runLine) throw new Error(`no run: line to anchor insertion in step resolving: ${configPath}`);
  const insertion = `${runLine[1]}continue-on-error: true\n`;
  const mutatedBlock = target.block.slice(0, runLine.index) + insertion + target.block.slice(runLine.index);
  return text.slice(0, target.start) + mutatedBlock + text.slice(target.end);
}

function addIfFalse(
  text: string,
  configPath: string,
  repoRoot: string,
  readPackageScripts: (absDir: string) => Record<string, string> | undefined
): string {
  const target = findStepBoundsByResolvedConfig(text, configPath, repoRoot, readPackageScripts);
  const runLine = /^([ \t]*)run:/m.exec(target.block);
  if (!runLine) throw new Error(`no run: line to anchor insertion in step resolving: ${configPath}`);
  const insertion = `${runLine[1]}if: false\n`;
  const mutatedBlock = target.block.slice(0, runLine.index) + insertion + target.block.slice(runLine.index);
  return text.slice(0, target.start) + mutatedBlock + text.slice(target.end);
}

function appendShellSwallow(
  text: string,
  configPath: string,
  repoRoot: string,
  readPackageScripts: (absDir: string) => Record<string, string> | undefined
): string {
  const target = findStepBoundsByResolvedConfig(text, configPath, repoRoot, readPackageScripts);
  const mutatedBlock = target.block.replace(/^([ \t]*run:[ \t]*)(.+)$/m, (_full, prefix, rest) => `${prefix}${rest} || true`);
  if (mutatedBlock === target.block) throw new Error(`run: line not matched for shell-swallow mutation in step resolving: ${configPath}`);
  return text.slice(0, target.start) + mutatedBlock + text.slice(target.end);
}

// ============================================================================
// Real-repo tests
// ============================================================================

const DISCOVERED_CONFIGS_ABS = collectTypecheckedConfigs(DESKTOP_ROOT);
const DISCOVERED_CONFIGS = DISCOVERED_CONFIGS_ABS.map(toRepoRelative);

test("floor: at least 2 tsconfigs carrying their own compilerOptions are discovered under desktop/ (a broken walk must not read as a vacuous pass)", () => {
  expect(DISCOVERED_CONFIGS.length).toBeGreaterThanOrEqual(2);
});

test("anchors the discovered domain: the three known typecheckable programs are all present (a floor alone would miss ONE known config quietly disappearing)", () => {
  expect(DISCOVERED_CONFIGS).toEqual(
    expect.arrayContaining(["desktop/tsconfig.node.json", "desktop/tsconfig.web.json", "desktop/mobile-shell/tsconfig.json"])
  );
});

test("desktop/tsconfig.json (the solution file) is excluded by construction -- it carries no compilerOptions of its own", () => {
  expect(DISCOVERED_CONFIGS).not.toContain("desktop/tsconfig.json");
});

test("every discovered tsconfig is actually invoked by some non-neutralized CI step -- domain is discovered, not a hardcoded 2-step list", () => {
  const covered = coveredConfigsFromWorkflowText(REAL_WORKFLOW_TEXT, REPO_ROOT, realReadPackageScripts);
  const missing = DISCOVERED_CONFIGS.filter((c) => !covered.has(c));
  expect(missing, `not typechecked by any live CI step: ${missing.join(", ")}`).toEqual([]);
});

// ============================================================================
// Mutation proofs -- every mutation below operates on a STRING COPY of
// REAL_WORKFLOW_TEXT and is replayed here in the diff, never against the
// real file on disk.
// ============================================================================

test("MUTATION: deleting the mobile-shell typecheck step turns its tsconfig red", () => {
  const before = coveredConfigsFromWorkflowText(REAL_WORKFLOW_TEXT, REPO_ROOT, realReadPackageScripts);
  expect(before.has("desktop/mobile-shell/tsconfig.json")).toBe(true);

  const mutated = removeStepResolvingConfig(REAL_WORKFLOW_TEXT, "desktop/mobile-shell/tsconfig.json", REPO_ROOT, realReadPackageScripts);
  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.has("desktop/mobile-shell/tsconfig.json")).toBe(false);
});

test("MUTATION: deleting the desktop (node+web) typecheck step turns BOTH its tsconfigs red", () => {
  const before = coveredConfigsFromWorkflowText(REAL_WORKFLOW_TEXT, REPO_ROOT, realReadPackageScripts);
  expect(before.has("desktop/tsconfig.node.json")).toBe(true);
  expect(before.has("desktop/tsconfig.web.json")).toBe(true);

  const mutated = removeStepResolvingConfig(REAL_WORKFLOW_TEXT, "desktop/tsconfig.node.json", REPO_ROOT, realReadPackageScripts);
  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.has("desktop/tsconfig.node.json")).toBe(false);
  expect(after.has("desktop/tsconfig.web.json")).toBe(false);
});

test("MUTATION: continue-on-error: true on the desktop typecheck step turns it red (step present, decorative)", () => {
  const mutated = addContinueOnErrorTrue(REAL_WORKFLOW_TEXT, "desktop/tsconfig.node.json", REPO_ROOT, realReadPackageScripts);
  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.has("desktop/tsconfig.node.json")).toBe(false);
  expect(after.has("desktop/tsconfig.web.json")).toBe(false);
});

test("MUTATION: if: false on the mobile-shell typecheck step turns it red (a second neutralization mechanism, distinct key from continue-on-error)", () => {
  const mutated = addIfFalse(REAL_WORKFLOW_TEXT, "desktop/mobile-shell/tsconfig.json", REPO_ROOT, realReadPackageScripts);
  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.has("desktop/mobile-shell/tsconfig.json")).toBe(false);
});

test("MUTATION, NEIGHBOR KEY: appending `|| true` to the desktop typecheck run line turns it red -- no GitHub Actions key involved at all", () => {
  // This is the neighbor the team-lead asked for by name: a guard keyed only
  // on continue-on-error/if would stay green here, because neither key is
  // touched -- the failure is swallowed at the shell level instead.
  const mutated = appendShellSwallow(REAL_WORKFLOW_TEXT, "desktop/tsconfig.node.json", REPO_ROOT, realReadPackageScripts);
  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.has("desktop/tsconfig.node.json")).toBe(false);
  expect(after.has("desktop/tsconfig.web.json")).toBe(false);
});

test("MUTATION does not corrupt the untouched sibling step: neutralizing the desktop step leaves the mobile-shell config covered", () => {
  const mutated = addContinueOnErrorTrue(REAL_WORKFLOW_TEXT, "desktop/tsconfig.node.json", REPO_ROOT, realReadPackageScripts);
  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.has("desktop/mobile-shell/tsconfig.json")).toBe(true);
});

test("MUTATION-SELECTOR RESILIENCE: renaming a step does not break mutation selection (selection is by resolved config, never by name)", () => {
  // Team-lead audit 2026-08-26, point 5: this file's own header says a step
  // rename is legitimate. Proves findStepBoundsByResolvedConfig actually
  // survives one, where the old by-name selector would have thrown.
  const renamed = REAL_WORKFLOW_TEXT.replace("Typecheck the mobile shell", "Typecheck mobile shell (renamed)");
  const mutated = removeStepResolvingConfig(renamed, "desktop/mobile-shell/tsconfig.json", REPO_ROOT, realReadPackageScripts);
  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.has("desktop/mobile-shell/tsconfig.json")).toBe(false);
});

// ============================================================================
// Team-lead audit 2026-08-26: three of the nine neutralization forms a
// mutation review found still passing green. Each test below is the required
// replayed proof for the corresponding fix.
// ============================================================================

test("MUTATION: a shell swallow moved into the npm script BODY (not the workflow run: line) still turns the config red", () => {
  // The swallow never touches .github/workflows/desktop-build.yml at all --
  // only the RESOLVED script body carries it, which is exactly what a
  // detector keyed on the workflow text alone would miss.
  const fixtureScripts: Record<string, string> = {
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json || true",
    "typecheck:web": "tsc --noEmit -p tsconfig.web.json",
    typecheck: "npm run typecheck:node && npm run typecheck:web",
  };
  const result = resolveTsConfigsForRun("npm run typecheck", "desktop", REPO_ROOT, () => fixtureScripts);
  expect(result).toEqual(["desktop/tsconfig.web.json"]);
});

test("MUTATION: a shell swallow on the COMPOSING npm script drops every leaf config it resolves, not just its own direct matches", () => {
  const fixtureScripts: Record<string, string> = {
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json",
    "typecheck:web": "tsc --noEmit -p tsconfig.web.json",
    typecheck: "npm run typecheck:node && npm run typecheck:web || true",
  };
  const result = resolveTsConfigsForRun("npm run typecheck", "desktop", REPO_ROOT, () => fixtureScripts);
  expect(result).toEqual([]);
});

test("MUTATION: a commented-out tsc line inside a multi-line run: block does not count as coverage", () => {
  const block = [
    "      - name: Typecheck the mobile shell",
    "        shell: bash",
    "        run: |",
    "          # bunx tsc --noEmit -p desktop/mobile-shell/tsconfig.json",
    "          echo skipped",
    "",
  ].join("\n");
  const step = parseStep(block);
  const result = resolveTsConfigsForRun(step.run ?? "", undefined, REPO_ROOT, () => undefined);
  expect(result).toEqual([]);
});

test("MUTATION, JOB-LEVEL KILL SWITCH: continue-on-error: true placed on the job itself (above every step) empties coverage entirely", () => {
  const before = coveredConfigsFromWorkflowText(REAL_WORKFLOW_TEXT, REPO_ROOT, realReadPackageScripts);
  expect(before.size).toBeGreaterThan(0); // sanity: the real workflow is covered before this mutation

  const mutated = REAL_WORKFLOW_TEXT.replace(/^([ \t]*)runs-on:/m, "$1continue-on-error: true\n$1runs-on:");
  expect(mutated).not.toBe(REAL_WORKFLOW_TEXT); // sanity: the mutation actually landed

  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.size).toBe(0);
});

test("MUTATION, JOB-LEVEL KILL SWITCH: dropping pull_request: from the on: trigger empties coverage entirely", () => {
  const before = coveredConfigsFromWorkflowText(REAL_WORKFLOW_TEXT, REPO_ROOT, realReadPackageScripts);
  expect(before.size).toBeGreaterThan(0);

  const mutated = REAL_WORKFLOW_TEXT.replace(/\n[ \t]*pull_request:\n(?:[ \t]+.*\n)*/, "\n");
  expect(mutated).not.toBe(REAL_WORKFLOW_TEXT);
  expect(mutated).not.toMatch(/^[ \t]*pull_request:/m);

  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.size).toBe(0);
});

// ============================================================================
// Detector unit tests: positive AND negative control for every extraction
// primitive, per the team-lead's explicit requirement.
// ============================================================================

// ----- stepBoundsList / parseStep: bounded parse ---------------------------

test("POSITIVE: stepBoundsList finds every step in the real workflow (sanity floor against a broken marker regex)", () => {
  expect(stepBoundsList(REAL_WORKFLOW_TEXT).length).toBeGreaterThanOrEqual(8);
});

test("NEGATIVE: bounded parse does not adopt a LATER step's run: line when an earlier step reformats to a block scalar", () => {
  const synthetic = `
    steps:
      - name: Typecheck the mobile shell
        shell: bash
        run: |
          bunx tsc --noEmit -p desktop/mobile-shell/tsconfig.json
      - name: Some later step
        shell: bash
        run: bun run should-not-leak-into-the-parsed-result.ts
`;
  const steps = splitWorkflowSteps(synthetic).map(parseStep);
  const mobileStep = steps.find((s) => s.name === "Typecheck the mobile shell")!;
  expect(mobileStep.run).not.toContain("should-not-leak-into-the-parsed-result.ts");
  expect(mobileStep.run).toContain("bunx tsc --noEmit -p desktop/mobile-shell/tsconfig.json");
});

test("NEGATIVE (indentation): bounded parse derives its own step-marker indentation instead of hardcoding it -- correct at a DIFFERENT indent level too", () => {
  const fourSpaceIndent = `
  steps:
    - name: Typecheck the mobile shell
      shell: bash
      run: bunx tsc --noEmit -p desktop/mobile-shell/tsconfig.json
    - name: Some later step
      shell: bash
      run: bun run should-not-leak-at-four-space-indent.ts
`;
  const steps = splitWorkflowSteps(fourSpaceIndent).map(parseStep);
  const mobileStep = steps.find((s) => s.name === "Typecheck the mobile shell")!;
  expect(mobileStep.run).not.toContain("should-not-leak-at-four-space-indent.ts");
});

// ----- isNeutralized: positive AND negative per mechanism -------------------

test("POSITIVE: continue-on-error: true neutralizes a step", () => {
  const block = "      - name: X\n        run: cmd\n        continue-on-error: true\n";
  expect(isNeutralized(parseStep(block))).toBe(true);
});

test("NEGATIVE: continue-on-error: false does NOT neutralize a step", () => {
  const block = "      - name: X\n        run: cmd\n        continue-on-error: false\n";
  expect(isNeutralized(parseStep(block))).toBe(false);
});

test("POSITIVE: templated continue-on-error: ${{ true }} neutralizes a step", () => {
  const block = "      - name: X\n        run: cmd\n        continue-on-error: ${{ true }}\n";
  expect(isNeutralized(parseStep(block))).toBe(true);
});

test("POSITIVE: if: false neutralizes a step", () => {
  const block = "      - name: X\n        if: false\n        run: cmd\n";
  expect(isNeutralized(parseStep(block))).toBe(true);
});

test("NEGATIVE: if: true does NOT neutralize a step", () => {
  const block = "      - name: X\n        if: true\n        run: cmd\n";
  expect(isNeutralized(parseStep(block))).toBe(false);
});

test("POSITIVE, neighbor key: run line ending in `|| true` neutralizes a step even with no continue-on-error/if present at all", () => {
  const block = "      - name: X\n        run: npm run typecheck || true\n";
  expect(isNeutralized(parseStep(block))).toBe(true);
});

test("POSITIVE, neighbor key: run line ending in `|| exit 0` neutralizes a step", () => {
  const block = "      - name: X\n        run: npm run typecheck || exit 0\n";
  expect(isNeutralized(parseStep(block))).toBe(true);
});

test("NEGATIVE: an ordinary run line with no swallow, no continue-on-error, no if does NOT neutralize a step", () => {
  const block = "      - name: X\n        working-directory: desktop\n        run: npm run typecheck\n";
  expect(isNeutralized(parseStep(block))).toBe(false);
});

test("NEGATIVE: `||` used for something unrelated to a swallow (e.g. `cmd1 || cmd2` where cmd2 is not true/exit 0) does NOT neutralize", () => {
  const block = "      - name: X\n        run: npm run typecheck || echo failed\n";
  expect(isNeutralized(parseStep(block))).toBe(false);
});

// ----- resolveTsConfigsForRun: direct + transitive npm-script resolution ---

test("POSITIVE: a direct `tsc --noEmit -p <path>` run line resolves to that config", () => {
  const result = resolveTsConfigsForRun("bunx tsc --noEmit -p desktop/mobile-shell/tsconfig.json", undefined, REPO_ROOT, () => undefined);
  expect(result).toEqual(["desktop/mobile-shell/tsconfig.json"]);
});

test("POSITIVE: `npm run typecheck` resolves TRANSITIVELY through a composed npm script to both tsc invocations", () => {
  const fixtureScripts: Record<string, string> = {
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json",
    "typecheck:web": "tsc --noEmit -p tsconfig.web.json",
    typecheck: "npm run typecheck:node && npm run typecheck:web",
  };
  const result = resolveTsConfigsForRun("npm run typecheck", "desktop", REPO_ROOT, () => fixtureScripts);
  expect(result.sort()).toEqual(["desktop/tsconfig.node.json", "desktop/tsconfig.web.json"]);
});

test("NEGATIVE: `npm run typecheck:node` alone resolves to ONLY tsconfig.node.json, not web.json (word-boundary on the script name, not a substring match on \"typecheck\")", () => {
  const fixtureScripts: Record<string, string> = {
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json",
    "typecheck:web": "tsc --noEmit -p tsconfig.web.json",
    typecheck: "npm run typecheck:node && npm run typecheck:web",
  };
  const result = resolveTsConfigsForRun("npm run typecheck:node", "desktop", REPO_ROOT, () => fixtureScripts);
  expect(result).toEqual(["desktop/tsconfig.node.json"]);
});

test("NEGATIVE: an npm run naming a script the readPackageScripts fixture does not define resolves to nothing (does not throw, does not hallucinate a config)", () => {
  const result = resolveTsConfigsForRun("npm run build", "desktop", REPO_ROOT, () => ({}));
  expect(result).toEqual([]);
});

test("NEGATIVE: a run line that mentions neither tsc nor npm run resolves to nothing", () => {
  const result = resolveTsConfigsForRun("npm install", "desktop", REPO_ROOT, () => undefined);
  expect(result).toEqual([]);
});

test("POSITIVE against the REAL desktop/package.json: resolving \"npm run typecheck\" with the real script reader yields both real tsconfigs (proves the injectable defaults to real fs correctly, not just the fixture path)", () => {
  const result = resolveTsConfigsForRun("npm run typecheck", "desktop", REPO_ROOT, realReadPackageScripts);
  expect(result.sort()).toEqual(["desktop/tsconfig.node.json", "desktop/tsconfig.web.json"]);
});

// ----- collectTypecheckedConfigs: structural exclusion, growth + shrink ----

test("POSITIVE: a synthetic tsconfig WITH compilerOptions is discovered", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-ci-typecheck-discover-"));
  try {
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    const found = collectTypecheckedConfigs(dir);
    expect(found).toEqual([join(dir, "tsconfig.json")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NEGATIVE: a synthetic solution-file-shaped tsconfig (files: [], references only, no compilerOptions) is excluded", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-ci-typecheck-solution-"));
  try {
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./tsconfig.a.json" }] }));
    expect(collectTypecheckedConfigs(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MUTATION, domain growth: a fourth real program (a synthetic tsconfig with compilerOptions dropped into a nested dir) is discovered automatically, nothing to edit in this file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-ci-typecheck-fourth-"));
  try {
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ files: [], references: [] }));
    mkdirSync(join(dir, "some-new-subproject"));
    writeFileSync(join(dir, "some-new-subproject", "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    const found = collectTypecheckedConfigs(dir).map((p) => relative(dir, p).split(sep).join("/"));
    expect(found).toEqual(["some-new-subproject/tsconfig.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTypecheckedConfigs never descends into node_modules/dist/out (vendored/build tsconfigs must not be adopted as real programs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-ci-typecheck-vendored-"));
  try {
    for (const excluded of ["node_modules", "dist", "out"]) {
      mkdirSync(join(dir, excluded, "some-pkg"), { recursive: true });
      writeFileSync(join(dir, excluded, "some-pkg", "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    }
    expect(collectTypecheckedConfigs(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
