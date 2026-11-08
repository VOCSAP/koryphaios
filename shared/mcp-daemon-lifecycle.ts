import { dlopen, FFIType, ptr } from "bun:ffi";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix } from "node:path";
import { createLogger, type Logger } from "./logger.ts";
import { controlRequest, type ControlOutcome } from "./mcp-daemon-control.ts";
import {
  DAEMON_VERSION,
  loadKey,
  startDaemon,
  type DaemonClock,
  type DaemonHandle,
  type DaemonOptions,
  type DaemonStats,
  type FamilyFactory,
  type FamilyName,
} from "./mcp-daemon-server.ts";
import { measureWriterGeneration } from "./process-generation.ts";

type Env = Record<string, string | undefined>;

const PORT_BASE = 47000;
const PORT_SPAN = 1000;
const CANDIDATE_COUNT = 10;
const DEFAULT_IDLE_SEC = 600;
const HANDSHAKE_WAIT_MS = 9000;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_IN_WINDOW = 5;
const PORT_ENV = "CLAUDE_PEERS_MCP_DAEMON_PORT";
const IDLE_ENV = "CLAUDE_PEERS_MCP_DAEMON_IDLE_SEC";

/** Lowercase hex sha256 of the UTF-8 canonical code directory; the relay computes the same value. */
export function daemonCodeRoot(codeDir: string): string {
  return createHash("sha256").update(codeDir).digest("hex");
}

export function fnv1a32(text: string): number {
  let hash = 2166136261;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export class UsernameError extends Error {}

export function checkedUsername(name: string, origin: string): string {
  if (name.trim() === "") throw new UsernameError(`the user name from ${origin} is ${name === "" ? "empty" : JSON.stringify(name)}`);
  return name;
}

export interface UsernameProbes {
  platform: NodeJS.Platform;
  /** GetUserNameW; null when the call fails. */
  windowsUserName(): string | null;
  posixUserName(): string;
}

/** `capacity` is the buffer size in UTF-16 units; 257 holds any account name. */
export function getUserNameW(capacity = 257): string | null {
  const lib = dlopen("advapi32.dll", { GetUserNameW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
  try {
    const buf = new Uint16Array(capacity);
    const len = new Uint32Array([buf.length]);
    const ok = lib.symbols.GetUserNameW(ptr(buf), ptr(len));
    const written = len[0] as number;
    if (ok === 0 || written === 0) return null;
    return new TextDecoder("utf-16le").decode(buf.subarray(0, written - 1));
  } finally {
    lib.close();
  }
}

export interface IdRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runId(command: string, args: string[]): IdRun {
  const out = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
}

/** Name of the real uid, as getpwuid_r(getuid()) gives the relay; os.userInfo reads $USER, which the relay does not pass. */
export function idRealUserName(run: (command: string, args: string[]) => IdRun = runId): string {
  const command = existsSync("/usr/bin/id") ? "/usr/bin/id" : "id";
  const out = run(command, ["-run"]);
  if (out.exitCode !== 0) throw new Error(`${command} -run exited ${out.exitCode}: ${out.stderr.trim()}`);
  return out.stdout.trim();
}

export function systemUsernameProbes(
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => IdRun = runId,
): UsernameProbes {
  return { platform, windowsUserName: () => getUserNameW(), posixUserName: () => idRealUserName(run) };
}

/**
 * The account name the relay computes its ports from, read the way the relay
 * reads it and never from USERNAME or USER, which the relay does not pass to the daemon.
 */
export function osUsername(probes: UsernameProbes = systemUsernameProbes()): string {
  const windows = probes.platform === "win32";
  const origin = windows ? "GetUserNameW" : "id -run";
  let name: string | null;
  try {
    name = windows ? probes.windowsUserName() : probes.posixUserName();
  } catch (e) {
    throw new UsernameError(`${origin} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (name === null) throw new UsernameError(`${origin} failed`);
  return checkedUsername(name, origin);
}

/** `username` is read only when the ports are derived from it. */
export function candidatePorts(username: string | (() => string), env: Env, log: Logger): number[] {
  const override = env[PORT_ENV];
  if (override !== undefined && override !== "") {
    const port = Number(override);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return [port];
    log.warn(`ignoring ${PORT_ENV}=${override}: not a port number`);
  }
  const name = checkedUsername(typeof username === "function" ? username() : username, "the caller");
  const base = PORT_BASE + (fnv1a32(name.toLowerCase()) % PORT_SPAN);
  return Array.from({ length: CANDIDATE_COUNT }, (_, i) => base + i);
}

export function idleSeconds(env: Env, log: Logger): number {
  const raw = env[IDLE_ENV];
  if (raw === undefined || raw === "") return DEFAULT_IDLE_SEC;
  const seconds = Number(raw);
  if (Number.isInteger(seconds) && seconds >= 0) return seconds;
  log.warn(`ignoring ${IDLE_ENV}=${raw}: not a whole number of seconds, using ${DEFAULT_IDLE_SEC}`);
  return DEFAULT_IDLE_SEC;
}

const SESSION_PREFIXES = ["CLAUDE_PEERS_FORCE_GROUP", "CLAUDE_PEERS_DESK_", "CLAUDE_PEERS_BROKER_", "CLAUDE_CODE_"];
const SESSION_NAMES = [
  "CLAUDE_PEERS_GROUP",
  "CLAUDE_PEERS_ROLE",
  "CLAUDE_PEERS_SUPERVISOR",
  "CLAUDE_PEERS_TOOLS",
  "CLAUDE_PEERS_APPROVAL_FILE",
  "CLAUDE_PEERS_DEPOSIT_CAPABILITY",
];

/** Removes the variables that belong to one session and logs their names, never their values. */
export function scrubSessionEnv(env: Env, log: Logger): string[] {
  const removed = Object.keys(env).filter((name) => {
    const upper = name.toUpperCase();
    return SESSION_PREFIXES.some((prefix) => upper.startsWith(prefix)) || SESSION_NAMES.includes(upper);
  });
  for (const name of removed) delete env[name];
  if (removed.length > 0) log.warn(`removed ${removed.length} session variable(s) from the environment: ${removed.join(", ")}`);
  return removed;
}

const UNRESOLVED = "unresolved:";
const SCAN_LOADERS: Readonly<Record<string, "ts" | "tsx" | "js">> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
};
const scanners = new Map<string, Bun.Transpiler>();

function resolveRelative(codeDir: string, fromFile: string, specifier: string): string {
  const base = posix.join(posix.dirname(fromFile), specifier);
  for (const candidate of [base, base.replace(/\.[cm]?js$/, ".ts"), `${base}.ts`, `${base}/index.ts`]) {
    try {
      if (statSync(join(codeDir, candidate)).isFile()) return candidate;
    } catch (e) {
      if (errnoCode(e) !== "ENOENT" && errnoCode(e) !== "ENOTDIR") throw e;
    }
  }
  return `${UNRESOLVED}${base}`;
}

/**
 * The entry point and every file it reaches through relative imports (static,
 * dynamic, re-exported or required; type-only imports are erased and not
 * followed), as paths relative to `codeDir`, sorted. Packages are not followed.
 */
export function fingerprintFiles(codeDir: string): string[] {
  const seen = new Set<string>();
  const pending = ["mcp-daemon.ts"];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.startsWith(UNRESOLVED)) continue;
    const loader = SCAN_LOADERS[extname(file)];
    if (loader === undefined) continue;
    let scanner = scanners.get(loader);
    if (scanner === undefined) scanners.set(loader, (scanner = new Bun.Transpiler({ loader })));
    for (const found of scanner.scanImports(readFileSync(join(codeDir, file), "utf8"))) {
      if (found.path.startsWith(".")) pending.push(resolveRelative(codeDir, file, found.path));
    }
  }
  return [...seen].sort();
}

/** Hash of the files `fingerprintFiles` lists: a change to any of them makes a running daemon stale. */
export function codeFingerprint(codeDir: string): string {
  const hash = createHash("sha256");
  for (const file of fingerprintFiles(codeDir)) {
    hash.update(file).update("\0");
    if (!file.startsWith(UNRESOLVED)) hash.update(readFileSync(join(codeDir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const FILETIME_UNIX_EPOCH = 116444736000000000n;

/** The FILETIME (100 ns ticks since 1601) of a PowerShell `ToString('o')` creation time, exact to the 7th decimal. */
export function filetimeFromCreationUtc(iso: string): string | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.(\d{1,7})\d*Z$/.exec(iso);
  if (m === null) return null;
  const seconds = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000;
  const fraction = (m[7] as string).padEnd(7, "0");
  return (BigInt(seconds) * 10_000_000n + BigInt(fraction) + FILETIME_UNIX_EPOCH).toString();
}

/** The `pid_start` string of this process, in the format of relay/src/sys.rs; empty when it cannot be measured. */
export async function ownPidStart(log: Logger): Promise<string> {
  const generation = await measureWriterGeneration(process.pid, log);
  if (generation?.platform === "win32") return filetimeFromCreationUtc(generation.creationUtc) ?? "";
  if (generation?.platform === "linux") return generation.startToken;
  const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], { stdout: "pipe", stderr: "pipe" });
  const text = ps.stdout.toString().trim();
  if (ps.exitCode !== 0 || text === "") log.warn(`cannot measure the start time of pid ${process.pid}: ps exited ${ps.exitCode}`);
  return text;
}

export interface DaemonState {
  pid: number;
  pid_start: string;
  port: number;
  code_root: string;
  code_fingerprint: string;
  version: string;
  instance: string;
  started_at: string;
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function writeStateFile(path: string, state: DaemonState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

function removeFile(path: string, log: Logger): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") log.warn(`cannot remove ${path}`, e);
  }
}

export function stateFilePath(peersDir: string, port: number): string {
  return join(peersDir, `mcp-daemon-${port}.json`);
}

export function launchLockPath(peersDir: string, codeRoot: string): string {
  return join(peersDir, `mcp-daemon-${codeRoot.slice(0, 8)}.launch`);
}

export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** An unhandled rejection is logged; more than five uncaught exceptions in a minute, or a signal, stop the daemon. */
export function installProcessHandlers(
  proc: ProcessLike,
  opts: { stop(reason: string): void; log: Logger; now(): number },
): void {
  const failures: number[] = [];
  proc.on("unhandledRejection", (reason) => opts.log.error("unhandled rejection", reason));
  proc.on("uncaughtException", (error) => {
    opts.log.error("uncaught exception", error);
    const now = opts.now();
    failures.push(now);
    while (failures.length > 0 && now - (failures[0] as number) > FAILURE_WINDOW_MS) failures.shift();
    if (failures.length > MAX_FAILURES_IN_WINDOW) {
      opts.stop(`more than ${MAX_FAILURES_IN_WINDOW} uncaught exceptions in ${FAILURE_WINDOW_MS / 1000} s`);
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"]) proc.on(signal, () => opts.stop(`signal ${signal}`));
}

const realClock: DaemonClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RunDaemonOptions {
  home: string;
  /** The account name, or a function reading it; read only when the ports are derived from it, and a failure stops the daemon with the cause logged. */
  username: string | (() => string);
  env: Env;
  codeRoot: string;
  codeDir: string;
  logDir: string;
  families: Partial<Record<FamilyName, FamilyFactory>>;
  clock?: DaemonClock;
  /** Candidate ports; defaults to the ten derived from the user name. */
  ports?: number[];
  /** Skips the measurement of this process's start time (a PowerShell call on Windows). */
  pidStart?: string;
  start?: (opts: DaemonOptions) => DaemonHandle;
  maxSessions?: number;
}

export interface DaemonRun {
  /** Resolves with the exit code once the daemon has stopped or turned out to be a duplicate. */
  done: Promise<number>;
  stop(reason: string): Promise<void>;
  port(): number | undefined;
  stats(): DaemonStats | undefined;
}

type PortScan = { port: number; outcome: ControlOutcome };

function isPortTaken(e: unknown): boolean {
  const code = errnoCode(e);
  return code === "EADDRINUSE" || code === "EACCES";
}

export function runDaemon(opts: RunDaemonOptions): DaemonRun {
  const clock = opts.clock ?? realClock;
  const start = opts.start ?? startDaemon;
  const peersDir = join(opts.home, ".claude", "peers");
  const lock = launchLockPath(peersDir, opts.codeRoot);
  const log = createLogger({ dir: opts.logDir, name: "server", mirrorToConsole: false }).child("daemon");
  let daemon: DaemonHandle | undefined;
  let statePath: string | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopRequested: string | undefined;
  let finished!: (code: number) => void;
  const done = new Promise<number>((resolve) => (finished = resolve));

  const stop = (reason: string): Promise<void> => {
    stopRequested ??= reason;
    if (daemon === undefined) return done.then(() => undefined);
    stopPromise ??= (async () => {
      log.info(`stopping: ${reason}`);
      clearIdle();
      try {
        await daemon?.stop();
      } finally {
        if (statePath !== undefined) removeFile(statePath, log);
        finished(0);
      }
    })();
    return stopPromise;
  };

  let idleTimer: unknown;
  let exitWhenEmpty = false;
  const idleMs = idleSeconds(opts.env, log) * 1000;

  function clearIdle(): void {
    if (idleTimer !== undefined) clock.clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function armIdle(): void {
    if (idleMs === 0 || idleTimer !== undefined || exitWhenEmpty) return;
    idleTimer = clock.setTimeout(() => void idleCheck(), idleMs);
  }

  async function idleCheck(): Promise<void> {
    idleTimer = undefined;
    const handle = daemon;
    if (handle === undefined) return;
    log.info("idle: no session, closing the listener");
    handle.pauseListening();
    await new Promise<void>((resolve) => {
      const timer = clock.setTimeout(resolve, HANDSHAKE_WAIT_MS);
      void handle.waitForHandshakes().then(() => {
        clock.clearTimeout(timer);
        resolve();
      });
    });
    if (handle.stats().sessions === 0) {
      await stop("idle");
      return;
    }
    try {
      handle.resumeListening();
    } catch (e) {
      log.warn("a session arrived while closing and the port was taken: serving it without listening", e);
      exitWhenEmpty = true;
    }
  }

  async function scan(ports: number[], key: Buffer): Promise<PortScan[]> {
    return Promise.all(
      ports.map(async (port) => ({ port, outcome: await controlRequest({ port, key, op: "status", clock }) })),
    );
  }

  const sameRoot = (scans: PortScan[]): PortScan | undefined =>
    scans.find((s) => s.outcome.kind === "reply" && s.outcome.body["code_root"] === opts.codeRoot);

  function describeSkipped(scan: PortScan): string {
    const { outcome } = scan;
    if (outcome.kind === "foreign") return `held by another program or another key: ${outcome.cause}`;
    if (outcome.kind === "reply") return `held by a daemon of code root ${String(outcome.body["code_root"]).slice(0, 8)}`;
    return "free";
  }

  async function main(): Promise<number> {
    const key = loadKey(join(peersDir, "mcp-daemon.key"), log);
    const pidStart = opts.pidStart ?? (await ownPidStart(log));
    const fingerprint = codeFingerprint(opts.codeDir);
    const ports = opts.ports ?? candidatePorts(opts.username, opts.env, log);
    let target = -1;
    for (let attempt = 0; attempt < ports.length + 3 && daemon === undefined; attempt++) {
      if (stopRequested !== undefined) {
        removeFile(lock, log);
        return 0;
      }
      const scans = await scan(ports, key);
      target = scans.findIndex((s) => s.outcome.kind === "free");
      if (target < 0) {
        log.error(`every candidate port is held by another program or another code root: ${ports.join(", ")}`);
        removeFile(lock, log);
        return 1;
      }
      for (const skipped of scans.slice(0, target)) log.info(`port ${skipped.port} skipped: ${describeSkipped(skipped)}`);
      const lower = sameRoot(scans.slice(0, target));
      if (lower !== undefined) {
        log.info(`a daemon of this code root already listens on ${lower.port}: exiting`);
        removeFile(lock, log);
        return 0;
      }
      const port = ports[target] as number;
      try {
        daemon = start({
          port,
          keyPath: join(peersDir, "mcp-daemon.key"),
          key,
          logDir: opts.logDir,
          codeRoot: opts.codeRoot,
          families: opts.families,
          clock,
          maxSessions: opts.maxSessions,
          control: {
            status: () => ({
              pid: process.pid,
              pid_start: pidStart,
              port,
              code_root: opts.codeRoot,
              code_fingerprint: fingerprint,
              version: DAEMON_VERSION,
              sessions: daemon?.stats().sessions ?? 0,
            }),
            stop: () => void stop("control stop"),
          },
          onSessions: (sessions) => {
            if (sessions > 0) clearIdle();
            else if (exitWhenEmpty) void stop("the last session closed and the port was lost");
            else armIdle();
          },
        });
      } catch (e) {
        if (!isPortTaken(e)) throw e;
        log.warn(`port ${port} is taken (${errnoCode(e)}): scanning again`);
      }
    }
    if (daemon === undefined) {
      log.error("no port could be taken");
      removeFile(lock, log);
      return 1;
    }
    if (target > 0) {
      const again = sameRoot(await scan(ports.slice(0, target), key));
      if (again !== undefined) {
        log.info(`a daemon of this code root appeared on ${again.port} meanwhile: exiting`);
        await daemon.stop();
        removeFile(lock, log);
        return 0;
      }
    }
    if (stopRequested !== undefined) {
      removeFile(lock, log);
      await stop(stopRequested);
      return await done;
    }
    statePath = stateFilePath(peersDir, daemon.port);
    writeStateFile(statePath, {
      pid: process.pid,
      pid_start: pidStart,
      port: daemon.port,
      code_root: opts.codeRoot,
      code_fingerprint: fingerprint,
      version: DAEMON_VERSION,
      instance: daemon.instance,
      started_at: new Date().toISOString(),
    });
    removeFile(lock, log);
    log.info(`serving on ${daemon.port} (pid ${process.pid}, code fingerprint ${fingerprint.slice(0, 12)})`);
    armIdle();
    return await done;
  }

  void main().then(
    (code) => finished(code),
    (e: unknown) => {
      log.error("the daemon cannot run", e);
      removeFile(lock, log);
      finished(1);
    },
  );

  return { done, stop, port: () => daemon?.port, stats: () => daemon?.stats() };
}
