// Pure helpers: what the workflow says to run, how the integration files are
// shared between processes, and how a bun log is read. No I/O.

export interface WorkflowStep {
  name: string;
  run?: string;
  uses?: string;
  shell?: string;
  workingDirectory?: string;
  timeoutMinutes?: number;
}

export type StepKind = "pure" | "integration" | "plain" | "action" | "skipped";

// A key the replay does not model (if:, env:, continue-on-error:, a job env: or
// defaults:) changes what the runner executes; dropping it silently would replay
// something else, so it throws and the model is extended first.
const STEP_KEYS: ReadonlySet<string> = new Set(["name", "run", "uses", "with", "shell", "working-directory", "timeout-minutes"]);
const JOB_KEYS: ReadonlySet<string> = new Set(["name", "runs-on", "strategy", "steps"]);
const WORKFLOW_KEYS: ReadonlySet<string> = new Set(["name", "on", "jobs"]);

function refuseUnmodelled(where: string, node: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const extra = Object.keys(node).filter((k) => !allowed.has(k));
  if (extra.length > 0) throw new Error(`${where} carries ${extra.join(", ")}, which the CI replay does not model`);
}

export function parseWorkflowSteps(yamlText: string, job = "build"): WorkflowStep[] {
  const doc = Bun.YAML.parse(yamlText) as Record<string, unknown>;
  refuseUnmodelled("the workflow", doc, WORKFLOW_KEYS);
  const node = (doc.jobs as Record<string, Record<string, unknown>> | undefined)?.[job];
  if (node) refuseUnmodelled(`job "${job}"`, node, JOB_KEYS);
  const steps = node?.steps as Record<string, unknown>[] | undefined;
  if (!Array.isArray(steps) || steps.length === 0) throw new Error(`workflow has no steps for job "${job}"`);
  for (const [i, s] of steps.entries()) refuseUnmodelled(`step ${typeof s.name === "string" ? `"${s.name}"` : i + 1}`, s, STEP_KEYS);
  return steps.map((s, i) => ({
    name: typeof s.name === "string" ? s.name : `step ${i + 1}`,
    run: typeof s.run === "string" ? s.run : undefined,
    uses: typeof s.uses === "string" ? s.uses : undefined,
    shell: typeof s.shell === "string" ? s.shell : undefined,
    workingDirectory: typeof s["working-directory"] === "string" ? (s["working-directory"] as string) : undefined,
    timeoutMinutes: typeof s["timeout-minutes"] === "number" ? (s["timeout-minutes"] as number) : undefined,
  }));
}

// A literal `${{ ... }}` reaching bash expands to nothing and passes silently, so
// any expression other than the one modelled throws.
export function expandExpressions(text: string, ctx: { runnerTemp: string }): string {
  const out = text.replace(/\$\{\{\s*runner\.temp\s*\}\}/g, ctx.runnerTemp);
  const left = out.match(/\$\{\{[^}]*\}\}/);
  if (left) throw new Error(`unsupported workflow expression ${left[0]}`);
  return out;
}

const PURE_RE = /^bun\s+scripts\/partition-pure-tests\.ts\s*$/;
const INTEGRATION_RE = /^bun\s+scripts\/partition-integration-tests\.ts\s*$/;
// Typechecks and the node-pty ABI gate are not test steps. Every other step runs by
// default, so a step added to the workflow is replayed without touching this file.
const NOT_A_TEST_STEP = /^(Typecheck\b|Rebuild node-pty)/;

export function classifyStep(step: WorkflowStep, opts: { allSteps: boolean }): StepKind {
  if (step.uses !== undefined) return "action";
  if (step.run === undefined) return "skipped";
  const run = step.run.trim();
  if (PURE_RE.test(run)) return "pure";
  if (INTEGRATION_RE.test(run)) return "integration";
  if (!opts.allSteps && NOT_A_TEST_STEP.test(step.name)) return "skipped";
  return "plain";
}

// Longest-processing-time first, then each bin goes back to the input order: the
// order inside a bin is the CI order, which is part of what the gate proves.
export function balanceBins(files: readonly string[], weight: (file: string) => number, n: number): string[][] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`bin count must be a positive integer, got ${String(n)}`);
  const bins = Array.from({ length: n }, () => ({ files: [] as string[], load: 0 }));
  for (const f of [...files].sort((a, b) => weight(b) - weight(a))) {
    const w = weight(f);
    if (!Number.isFinite(w) || w < 0) throw new Error(`weight of ${f} is not a finite non-negative number`);
    const bin = bins.reduce((m, x) => (x.load < m.load ? x : m));
    bin.files.push(f);
    bin.load += w;
  }
  return bins.map((b) => b.files.sort((a, c) => files.indexOf(a) - files.indexOf(c))).filter((b) => b.length > 0);
}

// The `::group::` headers exist because the replay sets GITHUB_ACTIONS, as a runner does.
export function parseFileDurations(log: string): Map<string, number> {
  const ms = new Map<string, number>();
  let cur = "";
  for (const line of log.split(/\r?\n/)) {
    const g = line.match(/^::group::tests[\\/](.+?\.test\.ts):/);
    if (g) {
      cur = g[1]!;
      continue;
    }
    // The recap after the last group repeats every failure with its time.
    if (line.startsWith("::endgroup::")) cur = "";
    const m = line.match(/^\((?:pass|fail)\).*\[([0-9.]+)(ms|s)\]\s*$/);
    if (m && cur) ms.set(cur, (ms.get(cur) ?? 0) + Number(m[1]) * (m[2] === "s" ? 1000 : 1));
  }
  return ms;
}

export function failedTests(log: string): string[] {
  const names = new Set<string>();
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith("(fail)")) names.add(line.replace(/ \[[0-9.]+m?s\]$/, ""));
  }
  return [...names].sort();
}

export function recap(log: string): { tests: number; files: number } | null {
  const m = log.match(/Ran (\d+) tests? across (\d+) files?/);
  return m ? { tests: Number(m[1]), files: Number(m[2]) } : null;
}

// The Deck identity and control channel must not reach a child: a live
// DECK_CONTROL_TOKEN would be readable by third-party install scripts. The last two
// change how Windows and MSYS resolve paths. Env names are case-insensitive on Windows.
export function isHostileEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  return k.startsWith("CLAUDE") || k.startsWith("KORY") || k.startsWith("ANTHROPIC") || k.startsWith("DECK_CONTROL_") || k === "NODEFAULTCURRENTDIRECTORYINEXEPATH" || k === "MSYS_NO_PATHCONV";
}

export function purgeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !isHostileEnvKey(k)) out[k] = v;
  return out;
}

export interface PlannedStep {
  index: number;
  kind: StepKind;
  withPure: boolean;
}

// Natively the pure partition runs next to the integration one. With ciOrder it runs
// at its place in the workflow, before the steps that install the desktop dependencies,
// which is the only way a pure test importing one of them can turn red.
export function planSteps(kinds: readonly StepKind[], ciOrder: boolean): PlannedStep[] {
  const hasIntegration = kinds.includes("integration");
  const hasPure = kinds.includes("pure");
  const planned: PlannedStep[] = [];
  for (const [index, kind] of kinds.entries()) {
    if (kind === "action" || kind === "skipped") continue;
    if (kind === "pure" && hasIntegration && !ciOrder) continue;
    planned.push({ index, kind, withPure: kind === "integration" && hasPure && !ciOrder });
  }
  return planned;
}

export function stepTimeoutMs(step: Pick<WorkflowStep, "timeoutMinutes">): number | undefined {
  return step.timeoutMinutes ? step.timeoutMinutes * 60_000 : undefined;
}

export interface TrackedState {
  hash: string;
  names: string[];
}

// A hash of `git diff HEAD --binary` sees an edit to a file that was already modified,
// which a list of names cannot.
export function describeDrift(before: TrackedState, after: TrackedState): string | null {
  if (before.hash === after.hash) return null;
  const was = new Set(before.names);
  const now = new Set(after.names);
  const parts: string[] = [];
  const added = after.names.filter((n) => !was.has(n));
  const gone = before.names.filter((n) => !now.has(n));
  if (added.length > 0) parts.push(`newly modified: ${added.join(", ")}`);
  if (gone.length > 0) parts.push(`no longer modified: ${gone.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "content changed in files that were already modified";
}

// NUL-separated with no trailing NUL: bsdtar reads a trailing one as an empty name.
// --null also makes GNU tar take each name verbatim (quotes, backslashes, a leading dash).
export function nulList(files: readonly string[]): string {
  return files.join("\0");
}

// The archive goes to stdout: GNU tar reads `-f C:/x.tar` as a file on a host named C.
export function treeArchiveArgv(listFile: string): string[] {
  return ["tar", "--null", "-cf", "-", "-T", listFile];
}

// The container gets the archive and the in-container script, nothing else: mounting
// the working tree would hand it the ignored files (settings.local.json, a future .env).
export function dockerRunArgs(o: { name: string; image: string; replayDir: string; outDir: string; user: readonly string[]; split: number }): string[] {
  return ["docker", "run", "--rm", "--name", o.name, "--shm-size=1g", ...o.user, "-v", `${o.replayDir}:/replay:ro`, "-v", `${o.outDir}:/out`, o.image, "bash", "/replay/in-container.sh", String(o.split)];
}
