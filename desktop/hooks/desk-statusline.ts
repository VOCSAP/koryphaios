// statusLine command the Deck injects into its Claude Code tiles (--settings).
// Two jobs per run:
//  1. Report the tile's model + context-window fill to the Deck: encode the
//     statusLine stdin payload into ~/.claude/peers/desk-status-<token>.json,
//     keyed by CLAUDE_PEERS_DESK_SESSION (no token => not a Deck tile, no file).
//  2. Keep the operator's own status line: run the statusLine command from the
//     GLOBAL user settings only, with the same stdin, and print its stdout
//     unchanged. Project/local settings come from a possibly cloned repo and
//     are never executed from here. The Deck refreshes every few seconds, so
//     the output is cached per tile and the command re-runs only when the
//     payload changes or the operator's own refreshInterval elapses.
// Must run under bun; imports resolve relative to this file regardless of the
// session's cwd. Failures never reach the status bar: they go to the rotated
// statusline.log in the claude-peers log dir.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { coreLogDir, createLogger, type Logger } from "../../shared/logger.ts";
import { encodeStatusFromPayload, statusFileName, statusLineCacheFileName } from "../src/shared/session-status.ts";

/** Set for the chained operator command, so a loop back into this script is a no-op. */
export const CHAINED_ENV = "KORY_STATUSLINE_CHAINED";

/** Upper bound on the operator's own statusLine run. */
export const CHAIN_TIMEOUT_MS = 4000;

/** True when this run was spawned by a chained statusLine (recursion guard). */
export function isChainedInvocation(env: Record<string, string | undefined> = process.env): boolean {
  return !!env[CHAINED_ENV];
}

/** Claude Code's global user settings file, honoring CLAUDE_CONFIG_DIR like index.ts. */
export function globalSettingsPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json");
}

/**
 * The operator's statusLine command from parsed GLOBAL settings, or null when
 * absent, not `type: "command"`, or not a non-empty string.
 */
export function pickGlobalStatusLineCommand(settingsJson: unknown): string | null {
  return pickGlobalStatusLine(settingsJson)?.command ?? null;
}

/** The operator's statusLine: its command, and its own refresh period in ms (null = events only). */
export interface OperatorStatusLine {
  command: string;
  refreshMs: number | null;
}

/**
 * The operator's statusLine from parsed GLOBAL settings (same acceptance as
 * pickGlobalStatusLineCommand). `refreshInterval` counts only as a finite
 * number of seconds >= 1, the documented minimum; anything else means none.
 */
export function pickGlobalStatusLine(settingsJson: unknown): OperatorStatusLine | null {
  if (typeof settingsJson !== "object" || settingsJson === null) return null;
  const sl = (settingsJson as Record<string, unknown>).statusLine;
  if (typeof sl !== "object" || sl === null) return null;
  const { type, command, refreshInterval } = sl as Record<string, unknown>;
  if (type !== "command" || typeof command !== "string" || !command.trim()) return null;
  const refreshMs =
    typeof refreshInterval === "number" && Number.isFinite(refreshInterval) && refreshInterval >= 1
      ? refreshInterval * 1000
      : null;
  return { command, refreshMs };
}

/** Where the report for `token` is written, or null when the token sanitizes to nothing. */
export function statusFileTarget(token: string | undefined, home: string = homedir()): string | null {
  const name = statusFileName(token);
  return name ? join(home, ".claude", "peers", name) : null;
}

/** Where the chained-output cache for `token` lives, next to its status file; null without a token. */
export function chainCacheTarget(token: string | undefined, home: string = homedir()): string | null {
  const name = statusLineCacheFileName(token);
  return name ? join(home, ".claude", "peers", name) : null;
}

/** Atomic write (pid-scoped temp + rename), 0600 like the other peers-dir files. */
export function writeStatusFile(target: string, data: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, target);
  } catch (e) {
    // The temp file must not outlive a failed write; the original error is what the caller logs.
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Read all of stdin as a UTF-8 string (the statusLine payload). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  // Decoded once at the end so a multibyte character split across chunks survives.
  return Buffer.concat(chunks).toString("utf-8");
}

function reportStatus(raw: string, log: Logger): void {
  const target = statusFileTarget(process.env.CLAUDE_PEERS_DESK_SESSION);
  if (!target) return;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    log.warn("statusLine payload is not JSON, no report written", e);
    return;
  }
  const encoded = encodeStatusFromPayload(payload, Date.now());
  if (!encoded) return; // no usable model yet: nothing to report
  try {
    writeStatusFile(target, encoded);
  } catch (e) {
    log.error(`failed to write ${target}`, e);
  }
}

function readGlobalStatusLine(log: Logger): OperatorStatusLine | null {
  const file = globalSettingsPath();
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.error(`failed to read ${file}`, e);
    return null;
  }
  try {
    // Windows editors (Notepad, PowerShell 5.1 Set-Content) prefix a UTF-8 BOM that JSON.parse rejects.
    return pickGlobalStatusLine(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch (e) {
    log.warn(`${file} is not valid JSON, operator statusLine not chained`, e);
    return null;
  }
}

// ----- chained-output cache -----

export const CHAIN_CACHE_VERSION = 1;

/** Largest cached operator output; a bigger one is printed but not cached. */
export const CHAIN_CACHE_MAX_OUT = 32 * 1024;

/** Largest cache file read back (base64 output plus the envelope). */
export const CHAIN_CACHE_MAX_BYTES = 64 * 1024;

/**
 * Payload fields left out of the cache key. Per the statusLine field list,
 * these two are the only wall-clock counters: they grow on every refresh tick
 * with no event behind them, while every other field changes only on an event.
 */
export const VOLATILE_COST_FIELDS = ["total_duration_ms", "total_api_duration_ms"] as const;

/**
 * Cache key: the operator command plus the payload without its volatile
 * fields. A payload that is not a JSON object is keyed on its raw text.
 */
export function chainCacheKey(command: string, raw: string): string {
  let payload: unknown = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const copy = { ...(parsed as Record<string, unknown>) };
      const cost = copy.cost;
      if (typeof cost === "object" && cost !== null && !Array.isArray(cost)) {
        const c = { ...(cost as Record<string, unknown>) };
        for (const f of VOLATILE_COST_FIELDS) delete c[f];
        copy.cost = c;
      }
      payload = copy;
    }
  } catch {
    // Not JSON: keyed on the raw text below; reportStatus already logged it.
  }
  return createHash("sha256").update(JSON.stringify({ command, payload })).digest("hex");
}

/**
 * What a cache entry holds: "output" serves `out` while the key holds;
 * "backoff" (timed out or failed to start) serves nothing until
 * CHAIN_BACKOFF_MS has passed; "marker" serves nothing and always re-runs, it
 * only carries `gitBashWarned` when the output was too large to cache.
 */
export type ChainCacheState = "output" | "backoff" | "marker";

export interface ChainCache {
  key: string;
  /** Epoch ms the cached run started. */
  at: number;
  state: ChainCacheState;
  out: Buffer;
  /** Exit code of the run behind an "output" entry; null otherwise. */
  exitCode: number | null;
  /** CLAUDE_CODE_GIT_BASH_PATH value already reported as unusable, so it is logged once. */
  gitBashWarned: string | null;
}

/**
 * A timed-out or unstartable command is retried only after this, whatever the
 * payload: relaunching it on every 5 s tick would keep one 4 s run per tile.
 */
export const CHAIN_BACKOFF_MS = 30_000;

export function encodeChainCache(c: ChainCache): string {
  return JSON.stringify({
    v: CHAIN_CACHE_VERSION,
    key: c.key,
    at: c.at,
    state: c.state,
    out: c.out.toString("base64"),
    ...(c.exitCode !== null ? { exitCode: c.exitCode } : {}),
    ...(c.gitBashWarned !== null ? { gitBashWarned: c.gitBashWarned } : {}),
  });
}

const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict decode: the file sits in a shared directory any local process can
 * write, so anything off-shape is refused (the command then runs) rather than
 * repaired.
 */
export function decodeChainCache(text: string): ChainCache | null {
  if (text.length === 0 || text.length > CHAIN_CACHE_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Refused like any other off-shape content; the caller logs the refusal.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { v, key, at, state, out, exitCode, gitBashWarned } = parsed as Record<string, unknown>;
  if (v !== CHAIN_CACHE_VERSION) return null;
  if (typeof key !== "string" || !HEX64.test(key)) return null;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  if (state !== "output" && state !== "backoff" && state !== "marker") return null;
  if (typeof out !== "string" || out.length % 4 !== 0 || !BASE64.test(out)) return null;
  const buf = Buffer.from(out, "base64");
  if (buf.length > CHAIN_CACHE_MAX_OUT) return null;
  if (state !== "output" && buf.length > 0) return null;
  if (exitCode !== undefined && (state !== "output" || !Number.isSafeInteger(exitCode))) return null;
  if (gitBashWarned !== undefined && (typeof gitBashWarned !== "string" || gitBashWarned.length > 4096)) return null;
  return {
    key,
    at,
    state,
    out: buf,
    exitCode: (exitCode as number | undefined) ?? null,
    gitBashWarned: gitBashWarned ?? null,
  };
}

export type ChainCacheRead =
  | { kind: "absent" }
  | { kind: "ok"; cache: ChainCache }
  | { kind: "refused"; reason: string }
  | { kind: "error"; error: unknown };

/** Symlinks refused (O_NOFOLLOW, POSIX), a FIFO cannot block (O_NONBLOCK); both 0 on win32. */
const CACHE_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Read and decode the cache file. Never throws. */
export function readChainCache(path: string): ChainCacheRead {
  let fd: number | null = null;
  try {
    fd = openSync(path, CACHE_READ_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: "refused", reason: "not a regular file" };
    if (st.size > CHAIN_CACHE_MAX_BYTES) return { kind: "refused", reason: `over ${CHAIN_CACHE_MAX_BYTES} bytes` };
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const cache = decodeChainCache(buf.subarray(0, n).toString("utf-8"));
    return cache ? { kind: "ok", cache } : { kind: "refused", reason: "malformed content" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP") return { kind: "refused", reason: "symlink" };
    return { kind: "error", error: e };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Whether the operator command must run instead of serving `cache`: no cache,
 * a marker-only entry, a cache from the future (clock moved back), a backoff
 * that has elapsed, and for an output entry a different key or the operator's
 * own refreshInterval elapsed since the cached run.
 */
export function shouldRunChained(cache: ChainCache | null, key: string, now: number, refreshMs: number | null): boolean {
  if (!cache || cache.state === "marker") return true;
  if (!Number.isFinite(now) || now < cache.at) return true;
  if (cache.state === "backoff") return now - cache.at >= CHAIN_BACKOFF_MS;
  if (cache.key !== key) return true;
  return refreshMs !== null && now - cache.at >= refreshMs;
}

/** Grace after the kill before the pipes are abandoned (a child that left the group). */
const KILL_GRACE_MS = 500;

/** Program + argv that run the operator's statusLine command string. */
export interface ChainShell {
  file: string;
  args: string[];
  /** Set when CLAUDE_CODE_GIT_BASH_PATH names a file that is missing or the WSL launcher. */
  ignoredGitBash?: string;
}

/** Env var Claude Code reads for the Git Bash location on Windows (setup docs). */
export const GIT_BASH_ENV = "CLAUDE_CODE_GIT_BASH_PATH";

/**
 * A bash.exe under System32/SysWOW64/Sysnative or WindowsApps is the WSL
 * launcher, not Git Bash: it would run the command inside a Linux distro.
 */
const WSL_BASH_DIR = /[\\/](system32|syswow64|sysnative|windowsapps)[\\/]/i;

function isUsableGitBash(p: string, exists: (p: string) => boolean): boolean {
  return p.length > 0 && !WSL_BASH_DIR.test(p) && exists(p);
}

/** The win32 PATH value; a copied env object loses Windows' case-insensitive lookup. */
function winPathVar(env: Record<string, string | undefined>): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return (key && env[key]) || "";
}

/**
 * Git Bash from `git.exe` on PATH: <Git>\cmd\git.exe or <Git>\bin\git.exe
 * => <Git>\bin\bash.exe; a Scoop shim <scoop>\shims\git.exe =>
 * <scoop>\apps\git\current\bin\bash.exe. Any other dir holding a git.exe
 * says nothing about where bash.exe is.
 */
function gitBashFromPath(env: Record<string, string | undefined>, exists: (p: string) => boolean): string | null {
  for (const raw of winPathVar(env).split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !exists(win32.join(dir, "git.exe"))) continue;
    const leaf = win32.basename(dir).toLowerCase();
    const root = win32.dirname(dir);
    let bash: string;
    if (leaf === "cmd" || leaf === "bin") bash = win32.join(root, "bin", "bash.exe");
    else if (leaf === "shims") bash = win32.join(root, "apps", "git", "current", "bin", "bash.exe");
    else continue;
    if (isUsableGitBash(bash, exists)) return bash;
  }
  return null;
}

/**
 * How to run the operator's statusLine, mirroring Claude Code (statusline
 * docs, "Windows configuration"): on win32 through Git Bash when installed,
 * else PowerShell; `sh -c` elsewhere. Whether Claude Code passes `-c` or
 * `-lc` to Git Bash is not documented: `-c` is used.
 */
export function chainShellFor(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
  command: string,
): ChainShell {
  if (platform !== "win32") return { file: "/bin/sh", args: ["-c", command] };
  const configured = env[GIT_BASH_ENV]?.trim();
  const configuredOk = !!configured && isUsableGitBash(configured, exists);
  const ignored = configured && !configuredOk ? { ignoredGitBash: configured } : {};
  const bash = (configuredOk ? configured : null) ?? gitBashFromPath(env, exists);
  if (bash) return { file: bash, args: ["-c", command], ...ignored };
  return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command], ...ignored };
}

/**
 * Kill the chained command and everything it started: on POSIX the child leads
 * its own process group, so `sleep 12 | cat` loses the sleep too; on win32
 * `taskkill /T` walks the tree, as clodex-process-io.ts does.
 */
function killTree(pid: number, log: Logger): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (e) {
    log.warn(`failed to kill the operator statusLine (pid ${pid})`, e);
  }
}

/** The chained command in flight, killed with its group if this hook is cancelled. */
let inFlight: ChildProcess | null = null;

/**
 * Claude Code cancels a running statusLine when a newer update fires. The
 * chained command leads its own process group on POSIX, so it would outlive
 * this process: take its group down, then exit. On win32 the cancel is a
 * TerminateProcess, which runs no handler; the chained tree is left there.
 */
export function installCancelHandlers(log: Logger): void {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const sig of signals) {
    process.on(sig, () => {
      const pid = inFlight?.pid;
      if (pid !== undefined && inFlight?.exitCode === null && inFlight.signalCode === null) killTree(pid, log);
      process.exit(128 + (sig === "SIGHUP" ? 1 : sig === "SIGINT" ? 2 : 15));
    });
  }
}

export interface ChainedRun {
  /** Stdout, possibly partial. */
  out: Buffer;
  /** Exit code when the command ended on its own; null when killed by the timeout or never started. */
  exitCode: number | null;
}

/** Run the operator's command with `raw` on stdin. */
function runChained(shell: ChainShell, raw: string, log: Logger): Promise<ChainedRun> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let settled = false;
    let exitCode: number | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      inFlight = null;
      clearTimeout(killTimer);
      clearTimeout(abandonTimer);
      resolve({ out: Buffer.concat(out), exitCode });
    };
    const child = spawn(shell.file, shell.args, {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: { ...process.env, [CHAINED_ENV]: "1" },
    });
    inFlight = child;
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    const killTimer = setTimeout(() => {
      log.warn(`operator statusLine timed out after ${CHAIN_TIMEOUT_MS} ms`);
      if (child.pid !== undefined) killTree(child.pid, log);
      abandonTimer = setTimeout(() => {
        child.stdout?.destroy();
        finish();
      }, KILL_GRACE_MS);
    }, CHAIN_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.on("error", (e) => {
      log.warn(`operator statusLine failed to start (${shell.file})`, e);
      finish();
    });
    child.on("close", (code) => {
      if (abandonTimer === undefined) exitCode = code;
      finish();
    });
    child.stdin?.on("error", (e) => log.warn("operator statusLine did not take its stdin", e));
    child.stdin?.end(raw);
  });
}

function loadChainCache(path: string | null, log: Logger): ChainCache | null {
  if (!path) return null;
  const res = readChainCache(path);
  if (res.kind === "ok") return res.cache;
  if (res.kind === "refused") log.warn(`statusLine cache ${path} refused (${res.reason}), operator command re-run`);
  if (res.kind === "error") log.warn(`failed to read the statusLine cache ${path}, operator command re-run`, res.error);
  return null;
}

/** Everything chainOperatorStatusLine reads from its environment, injectable for tests. */
export interface ChainDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  now: () => number;
  exists: (p: string) => boolean;
  run: (shell: ChainShell, raw: string, log: Logger) => Promise<ChainedRun>;
  write: (chunk: Buffer) => void;
}

const defaultChainDeps = (): ChainDeps => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  now: Date.now,
  exists: existsSync,
  run: runChained,
  write: (chunk) => {
    process.stdout.write(chunk);
  },
});

/** The cache entry a finished run leaves behind. */
export function chainCacheAfterRun(key: string, at: number, run: ChainedRun, gitBashWarned: string | null): ChainCache {
  if (run.exitCode === null) return { key, at, state: "backoff", out: Buffer.alloc(0), exitCode: null, gitBashWarned };
  if (run.out.length > CHAIN_CACHE_MAX_OUT) {
    return { key, at, state: "marker", out: Buffer.alloc(0), exitCode: null, gitBashWarned };
  }
  return { key, at, state: "output", out: run.out, exitCode: run.exitCode, gitBashWarned };
}

export async function chainOperatorStatusLine(
  op: OperatorStatusLine,
  raw: string,
  log: Logger,
  deps: ChainDeps = defaultChainDeps(),
): Promise<void> {
  const cachePath = chainCacheTarget(deps.env.CLAUDE_PEERS_DESK_SESSION, deps.home);
  const key = chainCacheKey(op.command, raw);
  const now = deps.now();
  const cached = loadChainCache(cachePath, log);
  if (cached && !shouldRunChained(cached, key, now, op.refreshMs)) {
    if (cached.out.length > 0) deps.write(cached.out);
    return;
  }
  const shell = chainShellFor(deps.platform, deps.env, deps.exists, op.command);
  if (shell.ignoredGitBash !== undefined && cached?.gitBashWarned !== shell.ignoredGitBash) {
    log.warn(`${GIT_BASH_ENV}=${shell.ignoredGitBash} is missing or the WSL launcher; running with ${shell.file}`);
  }
  let run: ChainedRun;
  try {
    run = await deps.run(shell, raw, log);
  } catch (e) {
    log.warn("operator statusLine could not be spawned", e);
    run = { out: Buffer.alloc(0), exitCode: null };
  }
  if (run.out.length > 0) deps.write(run.out);
  if (!cachePath) return;
  try {
    writeStatusFile(cachePath, encodeChainCache(chainCacheAfterRun(key, now, run, shell.ignoredGitBash ?? null)));
  } catch (e) {
    log.warn(`failed to write the statusLine cache ${cachePath}`, e);
  }
}

async function main(): Promise<void> {
  if (isChainedInvocation()) return;
  const log = createLogger({ dir: coreLogDir(), name: "statusline", mirrorToConsole: false });
  installCancelHandlers(log);
  let raw = "";
  try {
    raw = await readStdin();
  } catch (e) {
    log.error("failed to read the statusLine payload from stdin", e);
  }
  reportStatus(raw, log);
  const op = readGlobalStatusLine(log);
  if (op) await chainOperatorStatusLine(op, raw, log);
}

// Only run when executed directly, so tests can import the pure helpers.
// No process.exit: it can cut a pending stdout write short on a pipe. Every
// handle is closed or cleared once main settles, so the process ends on its own.
if (import.meta.main) {
  void main();
}
