// Replays the test steps of .github/workflows/desktop-build.yml on the current
// working tree: natively, and with --docker the ubuntu job in a container, both at
// once. Steps are read from the workflow, so a step added there is replayed here.
// Usage: bun scripts/ci-replay.ts [--docker] [--no-native] [--split N] [--all-steps] [--ci-order] [--keep]
// CI_REPLAY_TMP=<dir> puts every log and temp file in a folder the caller owns and
// removes; without it the script makes a temp folder and removes it itself.
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  balanceBins,
  classifyStep,
  describeDrift,
  dockerRunArgs,
  expandExpressions,
  failedTests,
  nulList,
  parseFileDurations,
  parseWorkflowSteps,
  planSteps,
  purgeEnv,
  recap,
  stepTimeoutMs,
  treeArchiveArgv,
  type TrackedState,
  type WorkflowStep,
} from "./ci-replay/steps.ts";

const ROOT = resolve(import.meta.dir, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "desktop-build.yml");
const IS_WIN = process.platform === "win32";

let args: string[] = [];
const flag = (n: string) => args.includes(n);
let SPLIT = 6;
let WANT_DOCKER = false;
let WANT_NATIVE = true;
let ALL_STEPS = false;
// Set by the container only: its tree starts without desktop/node_modules, as a runner's does.
let CI_ORDER = false;
let TMP_OWNED = false;
let TMP = "";

interface Row {
  label: string;
  ok: boolean;
  sec: number;
  note?: string;
  logs: string[];
}

const live = new Set<{ pid: number }>();
let dockerName = "";

function killTree(pid: number): void {
  if (IS_WIN) {
    const r = Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"]);
    if (r.exitCode !== 0) console.error(`[ci-replay] taskkill of pid ${pid} exited ${r.exitCode}: ${r.stdout.toString().trim()} ${r.stderr.toString().trim()}`);
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch (e) {
        console.error(`[ci-replay] could not kill pid ${pid}: ${String(e)}`);
      }
    }
  }
}

function killAll(): void {
  for (const p of live) killTree(p.pid);
  live.clear();
  if (dockerName) {
    const r = Bun.spawnSync(["docker", "kill", dockerName]);
    if (r.exitCode !== 0) console.error(`[ci-replay] docker kill ${dockerName} exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  }
}

function findBash(): string {
  if (IS_WIN) {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) {
      const p = base && join(base, "Git", "bin", "bash.exe");
      if (p && existsSync(p)) return p;
    }
    throw new Error("Git Bash not found: the workflow steps are bash scripts and the WSL bash would run them in another file system");
  }
  return Bun.which("bash") ?? "bash";
}

let bashPath = "";
function bash(): string {
  return (bashPath ||= findBash());
}

export function setup(argv: string[]): void {
  args = argv;
  const splitIdx = args.indexOf("--split");
  SPLIT = splitIdx >= 0 ? Number(args[splitIdx + 1]) : 6;
  if (!Number.isInteger(SPLIT) || SPLIT < 1) {
    console.error("--split needs a positive integer");
    process.exit(2);
  }
  WANT_DOCKER = flag("--docker");
  WANT_NATIVE = !flag("--no-native");
  ALL_STEPS = flag("--all-steps");
  CI_ORDER = flag("--ci-order");
  TMP_OWNED = !process.env.CI_REPLAY_TMP;
  TMP = (process.env.CI_REPLAY_TMP ?? mkdtempSync(join(tmpdir(), "ci-replay-"))).replace(/\\/g, "/");
  mkdirSync(join(TMP, "logs"), { recursive: true });
  mkdirSync(join(TMP, "no-hooks"), { recursive: true });
  writeFileSync(join(TMP, "github_path"), "");
}

// Every child of the replay gets this environment, built from `base` by the purge.
export function childEnv(base: Record<string, string | undefined>, tmp: string, extraPath: readonly string[]): Record<string, string> {
  const env = purgeEnv(base);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = [...extraPath, env[pathKey] ?? ""].join(delimiter);
  Object.assign(env, {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_TEMP: tmp,
    GITHUB_PATH: join(tmp, "github_path"),
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: join(tmp, "no-hooks"),
  });
  return env;
}

let extraPath: string[] = [];

function currentEnv(): Record<string, string> {
  return childEnv(process.env, TMP, extraPath);
}

export async function run(argv: string[], cwd: string, log: string, timeoutMs?: number): Promise<number> {
  const fd = openSync(log, "a");
  const proc = Bun.spawn(argv, { cwd, env: currentEnv(), stdout: fd, stderr: fd, detached: !IS_WIN });
  live.add(proc);
  const timer = timeoutMs ? setTimeout(() => killTree(proc.pid), timeoutMs) : undefined;
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  live.delete(proc);
  closeSync(fd);
  return code;
}

function absorbGithubPath(): void {
  const added = readFileSync(join(TMP, "github_path"), "utf8").split(/\r?\n/).filter(Boolean);
  writeFileSync(join(TMP, "github_path"), "");
  extraPath = [...added, ...extraPath];
}

async function ensurePinnedBun(): Promise<Row> {
  const start = Date.now();
  const pinned = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
  const probe = (): string => {
    const env = currentEnv();
    const bun = Bun.which("bun", { PATH: env[Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH"] });
    return bun ? Bun.spawnSync([bun, "--version"]).stdout.toString().trim() : "";
  };
  let note = `bun ${pinned} already on PATH`;
  if (probe() !== pinned) {
    const log = join(TMP, "logs", "00-pinned-bun.log");
    // The package's own postinstall can exit non-zero while the platform binary is extracted.
    const env = currentEnv();
    const npm = Bun.which("npm", { PATH: env[Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH"] }) ?? "npm";
    await run([npm, "install", "--prefix", join(TMP, "bun"), "--no-audit", "--no-fund", `bun@${pinned}`], ROOT, log);
    const plat = IS_WIN ? "windows" : process.platform;
    const dir = join(TMP, "bun", "node_modules", "@oven", `bun-${plat}-${process.arch}`, "bin");
    extraPath = [dir, ...extraPath];
    if (probe() !== pinned) throw new Error(`could not provide bun ${pinned}: see ${log}`);
    note = `bun ${pinned} installed in the temp folder`;
  }
  return { label: "toolchain", ok: true, sec: (Date.now() - start) / 1000, note, logs: [] };
}

async function plainStep(step: WorkflowStep, idx: number): Promise<Row> {
  const start = Date.now();
  const log = join(TMP, "logs", `${String(idx).padStart(2, "0")}-${step.name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.log`);
  const cwd = join(ROOT, step.workingDirectory ?? ".");
  const code = await run([bash(), "-c", expandExpressions(step.run!, { runnerTemp: TMP })], cwd, log, stepTimeoutMs(step));
  absorbGithubPath();
  return { label: step.name, ok: code === 0, sec: (Date.now() - start) / 1000, logs: [log] };
}

function weightsCache(): string {
  const r = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "--git-path", "ci-replay-weights.json"]);
  return resolve(ROOT, r.stdout.toString().trim());
}

async function integrationSplit(step: WorkflowStep, idx: number): Promise<Row> {
  const start = Date.now();
  const part = await import(pathToFileURL(join(ROOT, "scripts", "pure-module-partition.ts")).href);
  const files: string[] = part.exemptedFiles(part.listTestFiles(), part.EXEMPTIONS);
  if (files.length === 0) throw new Error("the integration partition is empty");

  let cached: Record<string, number> = {};
  try {
    cached = JSON.parse(readFileSync(weightsCache(), "utf8")) as Record<string, number>;
  } catch (e) {
    console.error(`[ci-replay] no weight cache, balancing by file size (${(e as Error).message.slice(0, 60)})`);
  }
  const useCache = files.every((f) => typeof cached[f] === "number");
  const weight = (f: string) => (useCache ? cached[f]! : lstatSync(join(ROOT, "tests", f)).size);
  const bins = balanceBins(files, weight, SPLIT);

  const env = currentEnv();
  const bunBin = Bun.which("bun", { PATH: env[Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH"] }) ?? "bun";
  const logs = bins.map((_, i) => join(TMP, "logs", `${String(idx).padStart(2, "0")}-integration-bin${i}.log`));
  const timeoutMs = stepTimeoutMs(step);
  const codes = await Promise.all(bins.map((b, i) => run([bunBin, ...(part.integrationArgv(b) as string[]).slice(1)], ROOT, logs[i]!, timeoutMs)));

  let tests = 0;
  let filesRan = 0;
  const durations = new Map<string, number>();
  for (const l of logs) {
    const text = readFileSync(l, "utf8");
    const r = recap(text);
    if (r) {
      tests += r.tests;
      filesRan += r.files;
    }
    for (const [f, ms] of parseFileDurations(text)) durations.set(f, ms);
  }
  const complete = tests > 0 && filesRan >= files.length;
  if (files.every((f) => durations.has(f))) writeFileSync(weightsCache(), JSON.stringify(Object.fromEntries(files.map((f) => [f, durations.get(f)!]))));
  const note = `${bins.length} bun processes, ${tests} tests across ${filesRan}/${files.length} files, weights from ${useCache ? "cache" : "file size"}${complete ? "" : ", RECAP INCOMPLETE"}`;
  return { label: `${step.name} (split)`, ok: complete && codes.every((c) => c === 0), sec: (Date.now() - start) / 1000, note, logs };
}

function trackedState(): TrackedState | Error {
  const diff = Bun.spawnSync(["git", "-C", ROOT, "diff", "HEAD", "--binary"]);
  const names = Bun.spawnSync(["git", "-C", ROOT, "diff", "HEAD", "--name-only"]);
  for (const r of [diff, names]) {
    if (r.exitCode !== 0) return new Error(`git diff HEAD exited ${r.exitCode}: ${r.stderr.toString().trim().slice(0, 200)}`);
  }
  return { hash: new Bun.CryptoHasher("sha256").update(diff.stdout).digest("hex"), names: names.stdout.toString().split("\n").filter(Boolean) };
}

async function nativeJob(): Promise<Row[]> {
  const steps = parseWorkflowSteps(readFileSync(WORKFLOW, "utf8"));
  const kinds = steps.map((s) => classifyStep(s, { allSteps: ALL_STEPS }));
  const rows: Row[] = [await ensurePinnedBun()];
  const before = trackedState();
  const pureIdx = kinds.indexOf("pure");
  for (const p of planSteps(kinds, CI_ORDER)) {
    const step = steps[p.index]!;
    let produced: Row[];
    if (p.kind === "integration") {
      produced = await Promise.all([p.withPure ? plainStep(steps[pureIdx]!, pureIdx) : undefined, integrationSplit(step, p.index)].filter((q): q is Promise<Row> => q !== undefined));
    } else produced = [await plainStep(step, p.index)];
    rows.push(...produced);
    // A red setup step stops the job as on a runner: the steps after it would measure nothing.
    if (p.kind === "plain" && !produced[0]!.ok) break;
  }
  const after = trackedState();
  const unreadable = before instanceof Error ? before : after instanceof Error ? after : undefined;
  if (unreadable) rows.push({ label: "tracked files", ok: false, sec: 0, note: `could not compare: ${unreadable.message}`, logs: [] });
  else {
    const drift = describeDrift(before as TrackedState, after as TrackedState);
    if (drift) rows.push({ label: "tracked files", ok: false, sec: 0, note: `a step, or another session, changed tracked files: ${drift}`, logs: [] });
  }
  return rows;
}

// The external calls of dockerJob go through `deps`, so a test sees the argv of
// `docker run` without git, tar or a docker daemon.
export interface DockerDeps {
  spawnSync: typeof Bun.spawnSync;
  run: (argv: string[], cwd: string, log: string) => Promise<number>;
}

export async function dockerJob(opts: { tmp: string; split: number }, deps: DockerDeps = { spawnSync: Bun.spawnSync, run }): Promise<{ ok: boolean; lines: string[] }> {
  const pinned = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
  const dir = join(opts.tmp, "docker");
  mkdirSync(join(dir, "out"), { recursive: true });
  mkdirSync(join(opts.tmp, "logs"), { recursive: true });
  const listed = deps.spawnSync(["git", "-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).stdout.toString().split("\0");
  const files = listed.filter((f) => f && existsSync(join(ROOT, f)) && !lstatSync(join(ROOT, f)).isDirectory());
  const listFile = join(dir, "files.list");
  writeFileSync(listFile, nulList(files));
  const archive = openSync(join(dir, "tree.tar"), "w");
  const tar = deps.spawnSync(treeArchiveArgv(listFile), { cwd: ROOT, stdout: archive, stderr: "pipe" });
  closeSync(archive);
  if (tar.exitCode !== 0) return { ok: false, lines: [`tar of the working tree exited ${tar.exitCode}: ${tar.stderr.toString().trim().slice(0, 300)}`] };
  copyFileSync(join(ROOT, "scripts", "ci-replay", "in-container.sh"), join(dir, "in-container.sh"));
  const image = `kory-ci-replay:${pinned}`;
  const buildLog = join(opts.tmp, "logs", "docker-build.log");
  const fd = openSync(buildLog, "a");
  const build = deps.spawnSync(["docker", "build", "-q", "--build-arg", `BUN_VERSION=${pinned}`, "-t", image, join(ROOT, "scripts", "ci-replay")], { env: purgeEnv(process.env), stdout: fd, stderr: fd });
  closeSync(fd);
  if (build.exitCode !== 0) return { ok: false, lines: [`docker build failed, see ${buildLog}`] };
  dockerName = `kory-ci-replay-${process.pid}`;
  const user = !IS_WIN && process.getuid ? ["--user", `${process.getuid()}:${process.getgid!()}`] : [];
  const log = join(opts.tmp, "logs", "docker-run.log");
  const code = await deps.run(dockerRunArgs({ name: dockerName, image, replayDir: dir, outDir: join(dir, "out"), user, split: Math.max(1, Math.floor(opts.split / 2)) }), ROOT, log);
  dockerName = "";
  const text = readFileSync(log, "utf8");
  const at = text.indexOf("== ci-replay verdict ==");
  const lines = (at >= 0 ? text.slice(at) : text.split("\n").slice(-30).join("\n")).split("\n");
  // The container names its own log folder; the one worth reading is on the host.
  if (at >= 0) lines[0] = `${lines[0]!.replace(/ \(logs: [^)]*\)$/, "")} ${logsNote(join(dir, "out", "logs"))}`;
  return { ok: code === 0, lines };
}

function logsNote(logsDir: string): string {
  return `(logs: ${logsDir}${TMP_OWNED && !flag("--keep") ? ", removed at exit; --keep or CI_REPLAY_TMP keeps them" : ""})`;
}

function report(title: string, rows: Row[]): boolean {
  console.log(`== ci-replay verdict == ${title} ${logsNote(join(TMP, "logs"))}`);
  for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.label} ${r.sec.toFixed(0)}s${r.note ? ` (${r.note})` : ""}`);
  const failed = new Set<string>();
  for (const r of rows) for (const l of r.logs) if (existsSync(l)) for (const t of failedTests(readFileSync(l, "utf8"))) failed.add(t);
  if (failed.size > 0) {
    console.log(`failing tests (${failed.size}):`);
    for (const t of [...failed].slice(0, 60)) console.log(`  ${t.slice(0, 220)}`);
    if (failed.size > 60) console.log(`  ... ${failed.size - 60} more in ${join(TMP, "logs")}`);
  }
  return rows.every((r) => r.ok);
}

async function main(): Promise<void> {
  setup(process.argv.slice(2));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      killAll();
      process.exit(130);
    });
  }
  let ok = true;
  const t0 = Date.now();
  try {
    const [native, docker] = await Promise.all([
      WANT_NATIVE ? nativeJob() : Promise.resolve(undefined),
      WANT_DOCKER ? dockerJob({ tmp: TMP, split: SPLIT }) : Promise.resolve(undefined),
    ]);
    if (native) ok = report(process.platform, native) && ok;
    if (docker) {
      console.log("== linux container ==");
      for (const l of docker.lines) console.log(l);
      ok = docker.ok && ok;
    }
    console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)}s: ${ok ? "PASS" : "FAIL"}`);
  } catch (e) {
    console.error(`[ci-replay] ${(e as Error).message}`);
    ok = false;
  } finally {
    killAll();
    if (TMP_OWNED && !flag("--keep")) rmSync(TMP, { recursive: true, force: true });
  }
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.main) await main();
