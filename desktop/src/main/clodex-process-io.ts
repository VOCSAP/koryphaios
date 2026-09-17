// Producers of the process identities the Clodex lifecycle decides on: the OS
// stamps that survive a pid being recycled, the runtime records clodex writes
// for its own servers, the spawn of the proxy and the tree stop.
//
// Two rules shape every function here. A stamp is persisted and re-measured
// through one single source (Get-Process and Win32_Process disagree on the
// last fraction digit, so mixing them would make an owner comparison
// unstable), and the comparison is byte-exact. And nothing kills on a
// measurement that is absent, unreadable or divergent, nor reports a stop it
// has not seen happen: a leaked proxy is visible and recoverable, a wrongly
// killed one is not. All IO is injected so the decisions run under `bun test`
// without electron and without spawning anything.

import { clodexHome } from "./clodex-bridge";
import type { ProcessIdentity } from "./clodex-lifecycle";
import {
  parseOwnerRecord,
  type OwnerRecord,
  type PosixProcessStamp,
  type ServerIdentity,
  type WindowsProcessStamp
} from "./clodex-process-identity";
import { buildShellInvocation } from "./shell-command";

/** Error scope of every trace emitted by this module. */
const SCOPE = "clodex";

/** Manifest clodex writes for every server it runs. */
const RUNTIME_FILE = "server-runtime.json";

/** `.ToString('o')` on a UTC DateTime: seven fraction digits, kept verbatim. */
const CREATION_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z$/;

/** `startedAt` of a runtime record. */
const RUNTIME_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A token of `ps -o lstart=` output, padded by the column width. */
const PS_MEASUREMENT_RE = /^\s*(\d+)\s+(\S.*)$/;

const DIGITS_RE = /^\d+$/;

/** The command line is glued into a shell invocation: nothing else may reach it. */
const COMMAND_TOKEN_RE = /^[A-Za-z0-9._-]+$/;

/** Fields of `/proc/<pid>/stat` are numbered from 1, and the first two go with `comm`. */
const PROC_PGRP_INDEX = 5 - 3;
const PROC_STARTTIME_INDEX = 22 - 3;

const DEFAULT_REGISTER_ATTEMPTS = 40;
const DEFAULT_REGISTER_INTERVAL_MS = 250;
const DEFAULT_STOP_ATTEMPTS = 20;
const DEFAULT_STOP_INTERVAL_MS = 250;

export interface ClodexSpawnOptions {
  detached: boolean;
  windowsHide: boolean;
  stdio: ["ignore", number | "ignore", number | "ignore"];
  /** Working directory of the child; the caller's own when absent. */
  cwd?: string;
  /** Full environment of the child; the deps environment when absent. */
  env?: NodeJS.ProcessEnv;
}

export interface ClodexChild {
  readonly pid: number | undefined;
  /** Settles when the child leaves. */
  readonly exited: Promise<void>;
  unref(): void;
}

/** Injected IO: every subprocess, file read, signal and trace of the producers. */
export interface ClodexProcessDeps {
  platform: NodeJS.Platform;
  hostname(): string;
  env: NodeJS.ProcessEnv;
  sleep(ms: number): Promise<void>;
  /** Run a fixed command with fixed args; never rejects for a non-zero exit. */
  run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** File content, or null when the file does not exist. Throws on any other failure. */
  readFile(path: string): string | null;
  /** `process.kill`: throws `ESRCH` when the pid is gone, `EPERM` when it is foreign. */
  kill(pid: number, signal: number | NodeJS.Signals): void;
  spawn(file: string, args: string[], options: ClodexSpawnOptions): ClodexChild;
  /** Descriptor the proxy output is appended to, owned by the caller, or null to discard it. */
  openLog(): number | null;
  onError(scope: string, message: string, error?: unknown): void;
}

export interface ClodexProcessOptions {
  registerAttempts?: number;
  registerIntervalMs?: number;
  stopAttempts?: number;
  stopIntervalMs?: number;
}

export interface ClodexProcessIo {
  stampWin32(pid: number): Promise<WindowsProcessStamp>;
  stampPosix(pid: number): Promise<PosixMeasurement>;
  isAlive(identity: ProcessIdentity): Promise<boolean>;
  readServer(): Promise<ServerIdentity | null>;
  measureServer(pid: number): Promise<ServerIdentity | null>;
  /**
   * Owns a freshly registered proxy. On posix the process group proves the
   * proxy belongs to the spawned tree; win32 offers no such field, so a proxy
   * registered by someone else during the same window can be adopted. The
   * post-kill check keeps that residual survivable: a stop that cannot reach
   * it throws instead of claiming success.
   */
  spawn(command: string, args: string[]): Promise<OwnerRecord>;
  stopTree(owner: OwnerRecord): Promise<void>;
}

interface RuntimeRecord {
  pid: number;
  port: number;
  mode: string;
  startedAt: number;
}

/** A posix stamp and the group its process belongs to, measured in one read. */
export interface PosixMeasurement extends PosixProcessStamp {
  pgid: number;
}

function requirePid(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Clodex process id must be a positive integer, got ${String(value)}`);
  }
  return value;
}

const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;

/** Windows env names are case-insensitive, a spread copy of `process.env` is not. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : env[key];
}

function withEnvValue(env: NodeJS.ProcessEnv, name: string, value: string): NodeJS.ProcessEnv {
  const lower = name.toLowerCase();
  const kept = Object.entries(env).filter(([key]) => key.toLowerCase() !== lower);
  return { ...Object.fromEntries(kept), [name]: value };
}

/**
 * cmd.exe looks a bare command up in its working directory before PATH, so a
 * `clodex.cmd` next to a portable Kory would run in place of clodex. The child
 * therefore starts from System32, which only an administrator can write, with
 * that lookup disabled, through a cmd.exe named by absolute path. A missing or
 * relative SystemRoot throws: a bare `cmd.exe` would reopen the same lookup.
 * ComSpec is ignored: `/d /s /c` and the quoting are cmd.exe syntax, and the
 * spawned binary is the root `taskkill /T` stops.
 */
function win32Invocation(env: NodeJS.ProcessEnv, line: string) {
  const systemRoot = envValue(env, "SystemRoot");
  if (!systemRoot || !WINDOWS_ABSOLUTE_RE.test(systemRoot)) {
    throw new Error(`clodex server needs an absolute SystemRoot, got ${String(systemRoot)}`);
  }
  const system32 = `${systemRoot.replace(/[\\/]+$/, "")}\\System32`;
  return {
    file: `${system32}\\cmd.exe`,
    args: ["/d", "/s", "/c", line],
    cwd: system32,
    env: withEnvValue(env, "NoDefaultCurrentDirectoryInExePath", "1")
  };
}

function requirePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isRealInstant(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]!;
  return year > 0 && day >= 1 && day <= days;
}

/**
 * clodex dates its runtime records in UTC ISO, while an owner record carries
 * epoch milliseconds. Measured: `Date.parse` rolls an impossible day over to
 * the next month instead of refusing it, so the calendar is checked first.
 */
function parseRuntimeInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = RUNTIME_INSTANT_RE.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number) as [number, number, number, number, number, number];
  if (!isRealInstant(...parts)) return null;
  const epoch = Date.parse(value);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

function parseRuntimeRecord(value: unknown): RuntimeRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const pid = requirePositiveInteger(entry.pid);
  const port = requirePositiveInteger(entry.port);
  const startedAt = parseRuntimeInstant(entry.startedAt);
  if (pid === null || port === null || port > 65_535 || startedAt === null) return null;
  if (typeof entry.mode !== "string" || entry.mode.length === 0) return null;
  return { pid, port, mode: entry.mode, startedAt };
}

function parseProcStat(pid: number, raw: string): PosixMeasurement {
  const close = raw.lastIndexOf(")");
  if (close < 0) throw new Error(`Cannot read the state of pid ${pid}: malformed stat line`);
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const pgrp = fields[PROC_PGRP_INDEX];
  const startToken = fields[PROC_STARTTIME_INDEX];
  if (pgrp === undefined || !DIGITS_RE.test(pgrp) || startToken === undefined || !DIGITS_RE.test(startToken)) {
    throw new Error(`Cannot read the group and start time of pid ${pid}: unexpected stat fields`);
  }
  const pgid = requirePositiveInteger(Number(pgrp));
  if (pgid === null) throw new Error(`Cannot read the group of pid ${pid}: ${pgrp}`);
  return { pid, startToken, pgid };
}

export function createClodexProcessIo(
  deps: ClodexProcessDeps,
  options: ClodexProcessOptions = {}
): ClodexProcessIo {
  const registerAttempts = options.registerAttempts ?? DEFAULT_REGISTER_ATTEMPTS;
  const registerIntervalMs = options.registerIntervalMs ?? DEFAULT_REGISTER_INTERVAL_MS;
  const stopAttempts = options.stopAttempts ?? DEFAULT_STOP_ATTEMPTS;
  const stopIntervalMs = options.stopIntervalMs ?? DEFAULT_STOP_INTERVAL_MS;
  const runtimePath = () => `${clodexHome(deps.env)}/${RUNTIME_FILE}`;
  /** The launcher resolves PATH the way the operator's login shell does. */
  const loginShell = (): string => {
    const shell = deps.env.SHELL?.trim();
    return shell && shell.length > 0 ? shell : "/bin/bash";
  };

  const isPidAlive = (pid: number, traceWhenUndecided: boolean): boolean => {
    try {
      deps.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ESRCH") return false;
      // Anything else (a permission error, an unknown errno) leaves liveness
      // undecided: answering alive costs a leaked proxy, answering dead
      // authorises a kill.
      if (traceWhenUndecided) deps.onError(SCOPE, `liveness probe of pid ${pid} was inconclusive`, error);
      return true;
    }
  };

  const readRuntime = (): RuntimeRecord[] => {
    const raw = deps.readFile(runtimePath());
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new TypeError(`clodex ${RUNTIME_FILE} is not a JSON array`);
    const records: RuntimeRecord[] = [];
    let dropped = 0;
    for (const item of parsed) {
      const record = parseRuntimeRecord(item);
      if (record) records.push(record);
      else dropped++;
    }
    if (dropped > 0) deps.onError(SCOPE, `ignored ${dropped} unusable record(s) in ${RUNTIME_FILE}`);
    return records;
  };

  const identityOf = (record: RuntimeRecord): ServerIdentity => ({
    host: deps.hostname(),
    pid: record.pid,
    startedAt: record.startedAt,
    port: record.port
  });

  const stampWin32 = async (pid: number): Promise<WindowsProcessStamp> => {
    const target = requirePid(pid);
    const { code, stdout, stderr } = await deps.run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${target}).StartTime.ToUniversalTime().ToString('o')`
    ]);
    const creationUtc = stdout.trim();
    if (code !== 0 || !CREATION_STAMP_RE.test(creationUtc)) {
      throw new Error(`Cannot measure the creation time of pid ${target} (exit ${code}): ${stderr.trim()}`);
    }
    return { pid: target, creationUtc };
  };

  /**
   * linux reads jiffies; darwin has no `/proc` and only offers a one-second
   * resolution, locale-dependent `lstart`. A locale that changes between the
   * persisted token and the re-measured one makes them differ, which refuses
   * a kill rather than allowing a wrong one.
   */
  const measurePosix = async (pid: number): Promise<PosixMeasurement> => {
    const target = requirePid(pid);
    if (deps.platform === "linux") {
      const raw = deps.readFile(`/proc/${target}/stat`);
      if (raw === null) throw new Error(`Cannot measure the start time of pid ${target}: no stat entry`);
      return parseProcStat(target, raw);
    }
    const { code, stdout, stderr } = await deps.run("ps", ["-o", "pgid=,lstart=", "-p", String(target)]);
    const match = PS_MEASUREMENT_RE.exec(stdout.trim());
    if (code !== 0 || !match) {
      throw new Error(`Cannot measure the start time of pid ${target} (exit ${code}): ${stderr.trim()}`);
    }
    const pgid = requirePositiveInteger(Number(match[1]));
    if (pgid === null) throw new Error(`Cannot read the group of pid ${target}: ${match[1]}`);
    // Column padding depends on the widest value of the row set, so the token
    // is collapsed the same way whether it is persisted or re-measured.
    return { pid: target, startToken: match[2]!.replace(/\s+/g, " ").trim(), pgid };
  };

  const isAlive = async (identity: ProcessIdentity): Promise<boolean> => {
    const pid = requirePid(identity.pid);
    // A record from another machine cannot be probed here, and a pid that this
    // host happens to reuse is not that record's process.
    if (identity.host !== deps.hostname()) return true;
    return isPidAlive(pid, true);
  };

  const readServer = async (): Promise<ServerIdentity | null> => {
    const live = readRuntime().filter((record) => isPidAlive(record.pid, true));
    const proxies = live.filter((record) => record.mode === "proxy");
    const pool = proxies.length > 0 ? proxies : live;
    let best: RuntimeRecord | null = null;
    for (const record of pool) {
      if (!best || record.startedAt > best.startedAt) best = record;
    }
    return best ? identityOf(best) : null;
  };

  const measureServer = async (pid: number): Promise<ServerIdentity | null> => {
    const target = requirePid(pid);
    const matches = readRuntime().filter((record) => record.pid === target);
    // Two records for one pid name two different servers: neither can be proven.
    return matches.length === 1 ? identityOf(matches[0]!) : null;
  };

  const stampTree = async (
    rootPid: number,
    runtimePid: number
  ): Promise<
    | { root: WindowsProcessStamp; runtime: WindowsProcessStamp }
    | { root: PosixMeasurement; runtime: PosixMeasurement }
  > => {
    if (deps.platform === "win32") {
      return { root: await stampWin32(rootPid), runtime: await stampWin32(runtimePid) };
    }
    return { root: await measurePosix(rootPid), runtime: await measurePosix(runtimePid) };
  };

  const buildOwner = (
    record: RuntimeRecord,
    stamps: Awaited<ReturnType<typeof stampTree>>,
    rootPid: number
  ): OwnerRecord => {
    const server = identityOf(record);
    if (deps.platform === "win32") {
      const { root, runtime } = stamps as { root: WindowsProcessStamp; runtime: WindowsProcessStamp };
      return { server, tree: { platform: "win32", root, runtime } };
    }
    const { root, runtime } = stamps as { root: PosixMeasurement; runtime: PosixMeasurement };
    // `detached` makes the root its own group leader; without that the group
    // could hold processes the stop was never entitled to signal.
    if (root.pgid !== rootPid) {
      throw new Error(`clodex server root ${rootPid} does not lead its process group (${root.pgid})`);
    }
    // A proxy registered outside that group would survive `kill(-pgid)`, so
    // owning it would claim an authority the stop does not have.
    if (runtime.pgid !== root.pgid) {
      throw new Error(`clodex proxy ${runtime.pid} runs in group ${runtime.pgid}, outside the owned ${root.pgid}`);
    }
    return {
      server,
      tree: {
        platform: deps.platform === "darwin" ? "darwin" : "linux",
        root: { pid: root.pid, startToken: root.startToken },
        runtime: { pid: runtime.pid, startToken: runtime.startToken },
        pgid: root.pgid
      }
    };
  };

  const spawn = async (command: string, args: string[]): Promise<OwnerRecord> => {
    if (deps.platform !== "win32" && deps.platform !== "linux" && deps.platform !== "darwin") {
      throw new Error(`clodex server cannot be owned on ${deps.platform}`);
    }
    for (const token of [command, ...args]) {
      if (!COMMAND_TOKEN_RE.test(token)) throw new TypeError(`Unsafe clodex command token: ${token}`);
    }
    const line = [command, ...args].join(" ");
    // A detached powershell.exe exits 0 without running its -Command; cmd.exe
    // runs it and stays the root of the tree `taskkill /T` stops.
    const invocation =
      deps.platform === "win32"
        ? win32Invocation(deps.env, line)
        : buildShellInvocation({ command: line, shell: loginShell(), interactive: false }, deps.platform);
    const sink = deps.openLog() ?? "ignore";
    const known = new Set(readRuntime().map((record) => record.pid));
    const child = deps.spawn(invocation.file, invocation.args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", sink, sink],
      ...("cwd" in invocation ? { cwd: invocation.cwd, env: invocation.env } : {})
    });
    // Under a login shell the child is the shell, not node: this pid roots the
    // tree, while the served pid is the one clodex registers for itself.
    const rootPid = requirePid(child.pid);
    child.unref();
    let exited = false;
    void child.exited.then(
      () => {
        exited = true;
      },
      (error: unknown) => {
        exited = true;
        deps.onError(SCOPE, `clodex server exit watch of pid ${rootPid} failed`, error);
      }
    );

    try {
      for (let attempt = 0; attempt < registerAttempts; attempt++) {
        const fresh = readRuntime().filter((record) => !known.has(record.pid) && record.mode === "proxy");
        if (fresh.length > 1) {
          throw new Error(`clodex registered ${fresh.length} new proxies at once: none can be owned`);
        }
        const record = fresh[0];
        if (record) {
          const owner = parseOwnerRecord(buildOwner(record, await stampTree(rootPid, record.pid), rootPid));
          if (!owner) throw new TypeError("clodex server produced an unusable owner record");
          return owner;
        }
        if (exited) throw new Error("clodex server exited before registering a proxy");
        await deps.sleep(registerIntervalMs);
      }
      throw new Error("clodex server did not register a proxy in time");
    } catch (error) {
      // Nothing owns that tree once this rejects, so the leak is only
      // actionable if every exit names the pid that stayed behind.
      const cause = error instanceof Error ? error.message : String(error);
      const leaked = exited ? "" : `; pid ${rootPid} was left running`;
      throw new Error(`${cause}${leaked}`, { cause: error });
    }
  };

  /**
   * `taskkill /T` only follows the parent chain and a caught SIGTERM stops
   * nothing, so a kill that returned success proves nothing: reporting a stop
   * the lifecycle then trusts would drop the owner record and lose the
   * authority to ever stop that proxy again.
   */
  const confirmStopped = async (tree: OwnerRecord["tree"]): Promise<void> => {
    for (let attempt = 0; attempt < stopAttempts; attempt++) {
      if (!isPidAlive(tree.runtime.pid, attempt === 0) && !isPidAlive(tree.root.pid, attempt === 0)) return;
      await deps.sleep(stopIntervalMs);
    }
    throw new Error(
      `clodex tree rooted at ${tree.root.pid} survived the stop; pid ${tree.runtime.pid} is still running`
    );
  };

  const stopTree = async (owner: OwnerRecord): Promise<void> => {
    const record = parseOwnerRecord(owner);
    if (!record) throw new TypeError("Refusing to stop an unusable clodex owner record");
    const { tree } = record;
    if (tree.platform !== deps.platform) {
      throw new Error(`Refusing to stop a ${tree.platform} clodex tree from ${deps.platform}`);
    }
    if (!isPidAlive(tree.root.pid, true)) {
      if (isPidAlive(tree.runtime.pid, true)) {
        deps.onError(
          SCOPE,
          `clodex proxy pid ${tree.runtime.pid} outlived its launcher ${tree.root.pid} and was left running`
        );
      }
      return;
    }
    if (tree.platform === "win32") {
      const measured = await stampWin32(tree.root.pid);
      if (measured.creationUtc !== tree.root.creationUtc) {
        throw new Error(`Refusing to stop pid ${tree.root.pid}: it was created at ${measured.creationUtc}`);
      }
      const { code, stderr } = await deps.run("taskkill", ["/T", "/F", "/PID", String(tree.root.pid)]);
      if (code !== 0) {
        throw new Error(`Cannot stop the clodex tree rooted at ${tree.root.pid} (exit ${code}): ${stderr.trim()}`);
      }
      await confirmStopped(tree);
      return;
    }
    const measured = await measurePosix(tree.root.pid);
    if (measured.startToken !== tree.root.startToken) {
      throw new Error(`Refusing to stop pid ${tree.root.pid}: it was started at ${measured.startToken}`);
    }
    if (measured.pgid !== tree.pgid || tree.pgid !== tree.root.pid) {
      throw new Error(`Refusing to stop group ${tree.pgid}: pid ${tree.root.pid} does not lead it`);
    }
    deps.kill(-tree.pgid, "SIGTERM");
    await confirmStopped(tree);
  };

  return { stampWin32, stampPosix: measurePosix, isAlive, readServer, measureServer, spawn, stopTree };
}
