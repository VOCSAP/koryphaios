import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { coreLogDir, createLogger, type Logger } from "./logger.ts";
import { controlRequest, type ControlOutcome, type ControlRequestOptions } from "./mcp-daemon-control.ts";
import { candidatePorts, codeFingerprint, daemonCodeRoot, filetimeFromCreationUtc, stateFilePath } from "./mcp-daemon-lifecycle.ts";
import { permissionVerdict } from "./mcp-daemon-server.ts";
import { measureWriterGeneration } from "./process-generation.ts";

type Env = Record<string, string | undefined>;

const KEY_FILE = "mcp-daemon.key";
const STOP_WAIT_MS = 5000;
const KILL_WAIT_MS = 3000;
const POLL_MS = 100;
const MAX_PID = 0x7fffffff;
const DAEMON_IMAGES = new Set(["kory-mcp-daemon", "bun"]);
const MAX_UNIX_SECONDS = 253402300799;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const USAGE = "usage: bun cli.ts mcp-daemon <status|restart>";

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
  return value as Record<string, unknown>;
}

export interface McpDaemonDeps {
  peersDir: string;
  username: string;
  env: Env;
  /** The clone whose daemon is meant: the directory that holds mcp-daemon.ts. */
  codeDir: string;
  log: Logger;
  control(opts: ControlRequestOptions): Promise<ControlOutcome>;
  /** The `pid_start` of `pid` in the relay's format; null when it is not running or cannot be measured. */
  pidStartOf(pid: number): Promise<string | null>;
  imageOf(pid: number): Promise<string | null>;
  isAlive(pid: number): boolean;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  print(line: string): void;
}

export type KeyRead = { key: Buffer } | { problem: string; refused: boolean };

/** Reads the shared key; unlike the daemon and the relay, never creates it. */
export function readDaemonKey(peersDir: string): KeyRead {
  const path = join(peersDir, KEY_FILE);
  let text: string;
  try {
    const stat = statSync(path);
    if (process.platform !== "win32") {
      const verdict = permissionVerdict(stat.mode, false);
      if (verdict !== null) return { problem: `${path} is refused: ${verdict}`, refused: true };
      if (stat.uid !== process.getuid?.()) return { problem: `${path} is refused: not owned by the current user`, refused: true };
    }
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { problem: `no key at ${path}: no daemon was started by this account (nothing was created)`, refused: false };
    }
    return { problem: `cannot read ${path}: ${(e as Error).message}`, refused: true };
  }
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) return { problem: `${path} is refused: it does not hold 64 hexadecimal characters`, refused: true };
  return { key: Buffer.from(hex, "hex") };
}

interface PortReport {
  port: number;
  outcome: ControlOutcome;
}

interface DaemonFacts {
  pid: number;
  codeRoot: string;
  fingerprint: string;
  version: string;
  sessions: number;
}

function factsOf(body: Record<string, unknown>): DaemonFacts | null {
  const { pid, code_root: codeRoot, code_fingerprint: fingerprint, version, sessions } = body;
  if (typeof pid !== "number" || typeof codeRoot !== "string" || typeof fingerprint !== "string") return null;
  if (typeof version !== "string" || typeof sessions !== "number") return null;
  return { pid, codeRoot, fingerprint, version, sessions };
}

function scan(deps: McpDaemonDeps, key: Buffer, ports: number[]): Promise<PortReport[]> {
  return Promise.all(ports.map(async (port) => ({ port, outcome: await deps.control({ port, key, op: "status" }) })));
}

function describePort(report: PortReport, ourRoot: string, disk: string | undefined): string {
  const { port, outcome } = report;
  if (outcome.kind === "free") return `port ${port}: free`;
  if (outcome.kind === "foreign") {
    return `port ${port}: no answer (${outcome.cause}); another program holds it, or a daemon with another key`;
  }
  const facts = factsOf(outcome.body);
  if (facts === null) return `port ${port}: answers status with an unexpected body`;
  const what = `daemon pid ${facts.pid}, version ${facts.version}, ${facts.sessions} session(s), code root ${facts.codeRoot.slice(0, 8)}`;
  if (facts.codeRoot !== ourRoot) return `port ${port}: ${what}, another code root`;
  if (disk !== undefined && facts.fingerprint !== disk) {
    return `port ${port}: ${what}, this clone: daemon code is stale (running ${facts.fingerprint.slice(0, 12)}, disk ${disk.slice(0, 12)}); run bun cli.ts mcp-daemon restart`;
  }
  return `port ${port}: ${what}, this clone`;
}

/** The sessions that fell back to bun, from the relay's mcp-fallback-<pid>.json files. */
async function fallbackLines(deps: McpDaemonDeps): Promise<string[]> {
  let names: string[];
  try {
    names = readdirSync(deps.peersDir).filter((n) => /^mcp-fallback-\d+\.json$/.test(n));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ["no session runs in bun fallback"];
    return [`cannot list ${deps.peersDir}: ${(e as Error).message}`];
  }
  type Entry = { kind: "live"; pid: number; line: string } | { kind: "gone" } | { kind: "unreadable"; why: string };
  const entries = await Promise.all(
    names.map(async (name): Promise<Entry> => {
      let record: Record<string, unknown>;
      try {
        record = parseObject(readFileSync(join(deps.peersDir, name), "utf8"));
      } catch (e) {
        return { kind: "unreadable", why: `${name}: unreadable (${(e as Error).message})` };
      }
      const pid = record["pid"];
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) {
        return { kind: "unreadable", why: `${name}: no usable pid` };
      }
      if (!deps.isAlive(pid)) return { kind: "gone" };
      const recorded = typeof record["pid_start"] === "string" ? record["pid_start"] : "";
      if (recorded !== "") {
        const measured = await deps.pidStartOf(pid);
        if (measured !== null && measured !== recorded) return { kind: "gone" };
      }
      const startedAt = record["started_at"];
      const since =
        typeof startedAt === "number" && startedAt >= 0 && startedAt <= MAX_UNIX_SECONDS
          ? new Date(startedAt * 1000).toISOString()
          : "an unknown time";
      return { kind: "live", pid, line: `fallback: pid ${pid}, family ${String(record["family"])}, since ${since}: ${String(record["cause"])}` };
    }),
  );
  const live = entries.filter((e): e is Extract<Entry, { kind: "live" }> => e.kind === "live").sort((a, b) => a.pid - b.pid);
  const lines = live.length > 0 ? live.map((e) => e.line) : ["no session runs in bun fallback"];
  for (const e of entries) if (e.kind === "unreadable") lines.push(`ignored ${e.why}`);
  const gone = entries.filter((e) => e.kind === "gone").length;
  if (gone > 0) lines.push(`${gone} fallback file(s) ignored: their process is gone or its pid was reused`);
  return lines;
}

function keyOrExplain(deps: McpDaemonDeps): { key: Buffer } | { exit: number } {
  const read = readDaemonKey(deps.peersDir);
  if ("key" in read) return read;
  deps.print(read.problem);
  return { exit: read.refused ? 1 : 0 };
}

async function statusCommand(deps: McpDaemonDeps): Promise<number> {
  const ourRoot = daemonCodeRoot(deps.codeDir);
  deps.print(`code root ${ourRoot.slice(0, 8)} (${deps.codeDir})`);
  const read = keyOrExplain(deps);
  if ("exit" in read) return read.exit;
  let disk: string | undefined;
  try {
    disk = codeFingerprint(deps.codeDir);
  } catch (e) {
    deps.print(`cannot compute the code fingerprint of ${deps.codeDir}: ${(e as Error).message}`);
  }
  const ports = candidatePorts(deps.username, deps.env, deps.log);
  for (const report of await scan(deps, read.key, ports)) deps.print(describePort(report, ourRoot, disk));
  for (const line of await fallbackLines(deps)) deps.print(line);
  return 0;
}

function normalizeImage(image: string): string {
  return basename(image).toLowerCase().replace(/\.exe$/, "");
}

/**
 * Stops the pid of the state file of `port`, after the checks a relay makes
 * before it stops a stuck daemon. Every refusal prints why; a process is never
 * chosen by its image name.
 */
async function stopFromStateFile(
  deps: McpDaemonDeps,
  port: number,
  ourRoot: string,
): Promise<"stopped" | "refused" | "absent" | "other-root"> {
  const path = stateFilePath(deps.peersDir, port);
  const refuse = (why: string): "refused" => {
    deps.print(`port ${port}: not stopped, ${why}`);
    return "refused";
  };
  let state: Record<string, unknown>;
  try {
    state = parseObject(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      deps.print(`port ${port}: not stopped, there is no state file ${path}`);
      return "absent";
    }
    return refuse(`cannot read ${path} (${(e as Error).message})`);
  }
  if (state["code_root"] !== ourRoot) {
    deps.print(`port ${port}: not stopped, the state file belongs to another code root, not this clone's`);
    return "other-root";
  }
  const pid = state["pid"];
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) {
    return refuse(`the pid ${String(pid)} is not one this command may stop (0, negative, or above ${MAX_PID})`);
  }
  if (!deps.isAlive(pid)) return refuse(`pid ${pid} is not running`);
  const recorded = state["pid_start"];
  if (typeof recorded !== "string" || recorded === "") return refuse(`the state file has no creation time for pid ${pid}`);
  const measured = await deps.pidStartOf(pid);
  if (measured === null) return refuse(`the creation time of pid ${pid} cannot be measured`);
  if (measured !== recorded) return refuse(`pid ${pid} was created at another time than the daemon (the pid was reused)`);
  const image = await deps.imageOf(pid);
  if (image === null) return refuse(`the image of pid ${pid} cannot be read`);
  if (!DAEMON_IMAGES.has(normalizeImage(image))) return refuse(`pid ${pid} runs ${image}, not kory-mcp-daemon or bun`);
  // The image lookup takes long enough for the pid to be reused: measure again right before the kill.
  if ((await deps.pidStartOf(pid)) !== recorded) return refuse(`pid ${pid} changed creation time while it was being checked`);
  try {
    deps.kill(pid);
  } catch (e) {
    return refuse(`stopping pid ${pid} failed (${(e as Error).message})`);
  }
  const deadline = deps.now() + KILL_WAIT_MS;
  while (deps.isAlive(pid) && deps.now() < deadline) await deps.sleep(POLL_MS);
  if (deps.isAlive(pid)) return refuse(`pid ${pid} is still running after being stopped`);
  deps.print(`port ${port}: stopped pid ${pid}`);
  return "stopped";
}

async function restartCommand(deps: McpDaemonDeps): Promise<number> {
  const ourRoot = daemonCodeRoot(deps.codeDir);
  const read = keyOrExplain(deps);
  if ("exit" in read) return read.exit;
  const ports = candidatePorts(deps.username, deps.env, deps.log);
  const isMine = (r: PortReport): boolean => r.outcome.kind === "reply" && r.outcome.body["code_root"] === ourRoot;
  const first = await scan(deps, read.key, ports);
  const asked = first.filter(isMine);
  for (const { port, outcome } of asked) {
    const pid = outcome.kind === "reply" ? String(outcome.body["pid"]) : "?";
    deps.print(`port ${port}: asking the daemon (pid ${pid}) to stop`);
    const answer = await deps.control({ port, key: read.key, op: "stop" });
    if (answer.kind !== "reply") deps.print(`port ${port}: no reply to the stop request`);
  }
  let remaining = asked.map((r) => r.port);
  const deadline = deps.now() + STOP_WAIT_MS;
  while (remaining.length > 0 && deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    const again = await scan(deps, read.key, remaining);
    remaining = again.filter(isMine).map((r) => r.port);
  }
  for (const { port } of asked) {
    if (!remaining.includes(port)) deps.print(`port ${port}: stopped`);
  }
  const silent = first.filter((r) => r.outcome.kind === "foreign").map((r) => r.port);
  let failed = false;
  for (const port of [...remaining, ...silent]) {
    if (remaining.includes(port)) deps.print(`port ${port}: still there ${STOP_WAIT_MS / 1000} s after the stop request`);
    const outcome = await stopFromStateFile(deps, port, ourRoot);
    if (outcome === "refused" || (outcome !== "stopped" && remaining.includes(port))) failed = true;
  }
  if (asked.length === 0 && silent.length === 0) deps.print(`no daemon of this clone is running (code root ${ourRoot.slice(0, 8)})`);
  else if (!failed) deps.print("the next session starts a new daemon on the code on disk");
  return failed ? 1 : 0;
}

export async function runMcpDaemonCommand(args: string[], base: McpDaemonDeps = realDeps()): Promise<number> {
  // Files and replies of other processes reach the output: a control character could rewrite the terminal or fake a line.
  const deps: McpDaemonDeps = { ...base, print: (line) => base.print(line.replace(CONTROL_CHARS, "?")) };
  const [action, ...extra] = args;
  if (extra.length > 0 || (action !== "status" && action !== "restart")) {
    deps.print(USAGE);
    return 2;
  }
  return action === "status" ? statusCommand(deps) : restartCommand(deps);
}

async function measuredPidStart(pid: number, log: Logger): Promise<string | null> {
  const generation = await measureWriterGeneration(pid, log);
  if (generation?.platform === "win32") return filetimeFromCreationUtc(generation.creationUtc);
  if (generation?.platform === "linux") return generation.startToken;
  if (process.platform === "win32" || process.platform === "linux") return null;
  const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  const text = ps.stdout.toString().trim();
  return ps.exitCode === 0 && text !== "" ? text : null;
}

async function imageOfPid(pid: number, log: Logger): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch (e) {
      log.warn(`cannot read the image of pid ${pid}`, e);
      return null;
    }
  }
  const [command, args] =
    process.platform === "win32"
      ? [
          join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoLogo", "-NoProfile", "-Command", `(Get-Process -Id ${pid}).ProcessName`],
        ]
      : ["ps", ["-o", "comm=", "-p", String(pid)]];
  const out = Bun.spawnSync([command as string, ...(args as string[])], { stdout: "pipe", stderr: "pipe" });
  const text = out.stdout.toString().trim();
  if (out.exitCode !== 0 || text === "") log.warn(`cannot read the image of pid ${pid}: exit ${out.exitCode}`);
  return out.exitCode === 0 && text !== "" ? text : null;
}

function realDeps(): McpDaemonDeps {
  const log = createLogger({ dir: coreLogDir(), name: "server", mirrorToConsole: false }).child("daemon-cli");
  return {
    peersDir: join(homedir(), ".claude", "peers"),
    username: userInfo().username,
    env: process.env,
    codeDir: realpathSync.native(join(import.meta.dir, "..")),
    log,
    control: controlRequest,
    pidStartOf: (pid) => measuredPidStart(pid, log),
    imageOf: (pid) => imageOfPid(pid, log),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    kill: (pid) => void process.kill(pid),
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    print: (line) => console.log(line),
  };
}
