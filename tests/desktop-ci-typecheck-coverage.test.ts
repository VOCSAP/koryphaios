// A tsconfig counts as a real program iff it declares its own compilerOptions,
// discovered structurally rather than off a hardcoded step list; each must have
// an actual `tsc -p` invocation, resolved transitively through package.json
// script indirection and matched by the command a step runs, never by its name.
// isNeutralized() catches continue-on-error, if:-false, and shell-level `||
// true`/`|| exit 0` swallows at both step and job level, plus an invocation
// commented out inside a run: block.
// Known open gaps: a shell `if ! tsc; then fi` swallow, `shell: bash {0}`
// losing its implicit -eo pipefail, and a non-literal always-false `if:`
// expression -- all shell/expression control flow outside what a YAML-text scan
// can parse.
// A tsconfig using block comments, or an extends-only config with no own
// compilerOptions, is silently excluded from the checked domain.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const DESKTOP_ROOT = join(REPO_ROOT, "desktop");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "desktop-build.yml");
// Normalized to LF once at the read site: windows-latest's checkout applies
// core.autocrlf=true and smudges the committed LF blob to CRLF, which breaks
// every `\n`-anchored regex below on that runner alone.
const REAL_WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, "utf-8").replace(/\r\n/g, "\n");

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
 * Splits into step blocks at each `- name:`/`- uses:` marker, capturing the
 * marker's own indentation as the boundary rather than a hardcoded column, so
 * this is correct regardless of the workflow's actual indent level.
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
 * Handles both the single-line `run: cmd` form and the block-scalar `run:
 * |`/`run: >` form.
 * Comment lines are stripped first, since a typecheck invocation commented out
 * with `#` still matches the raw extraction regex otherwise.
 */
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
    // Checked on the script body before recursing, so a swallow on a composing
    // script (e.g. `"npm run typecheck:node && npm run typecheck:web || true"`)
    // drops every leaf config it would otherwise resolve, not only its own
    // direct matches.
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
 * continue-on-error/if: are legal at the job level too, where either one
 * neutralizes every step beneath it in one line; narrowing the on: trigger to
 * drop push/pull_request has the same effect.
 * Checked on the text preceding the first step boundary, so it is structural
 * regardless of what job-level keys exist.
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
 * Selects the step to mutate by the tsconfig its run: actually resolves to, not
 * by its `name:` string -- a step is free to rename itself, so a name-keyed
 * selector would break on a legitimate rename.
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
  const renamed = REAL_WORKFLOW_TEXT.replace("Typecheck the mobile shell", "Typecheck mobile shell (renamed)");
  const mutated = removeStepResolvingConfig(renamed, "desktop/mobile-shell/tsconfig.json", REPO_ROOT, realReadPackageScripts);
  const after = coveredConfigsFromWorkflowText(mutated, REPO_ROOT, realReadPackageScripts);
  expect(after.has("desktop/mobile-shell/tsconfig.json")).toBe(false);
});

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
