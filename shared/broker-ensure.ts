import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, posix, win32 } from "node:path";
import { brokerStopMarkerPath, readBrokerStopMarker } from "./broker-stop-marker.ts";
import { isLoopbackBrokerUrl } from "./config.ts";
import type { Logger } from "./logger.ts";

export const BROKER_ENV_NAMES = [
  "CLAUDE_PEERS_PORT",
  "CLAUDE_PEERS_DB",
  "CLAUDE_PEERS_BIND_HOST",
  "CLAUDE_PEERS_BROKER_TOKEN",
  "CLAUDE_PEERS_OFFLINE_REPLICA",
  "CLAUDE_PEERS_SERVE_REPLICAS",
] as const;
const BROKER_ENV_PREFIX = "CLAUDE_PEERS_DELEGATION_";
const DEFAULT_ATTEMPTS = 30;
const DEFAULT_POLL_MS = 200;
const HEALTH_TIMEOUT_MS = 2000;

export interface BrokerEnsureRequest {
  url: string;
  /** The settings file of the session: the operator's stop marker sits next to it. */
  settingsPath: string;
  /** The environment of the session; only the broker variables of it reach the broker. */
  env: Readonly<Record<string, string>>;
}

export type EnsureOutcome =
  | { action: "skipped"; reason: "remote-mode" | "manual-stop" }
  | { action: "already-running" }
  | { action: "not-found" }
  | { action: "started"; script: string }
  | { action: "failed"; script: string; reason: string };

export interface BrokerEnsurer {
  ensure(req: BrokerEnsureRequest): Promise<EnsureOutcome>;
}

export interface BrokerEnsurerDeps {
  /** GET <url>/health: true when the broker answers 2xx. */
  isAlive(url: string): Promise<boolean>;
  /** True while the operator's stop marker is present, malformed included; defaults to reading the marker. */
  stopped?(settingsPath: string): boolean;
  locate(): { command: string; script: string } | null;
  /** Starts the process detached; throws when the executable is missing. */
  spawn(command: string, args: string[], env: Record<string, string>): void;
  sleep(ms: number): Promise<void>;
  /** The scrubbed environment of the daemon. */
  baseEnv: Readonly<Record<string, string | undefined>>;
  home: string;
  log: Logger;
  platform?: NodeJS.Platform;
  attempts?: number;
  pollMs?: number;
}

type BrokerVars = Record<string, string>;

interface Flight {
  outcome: Promise<EnsureOutcome>;
  settingsPath: string;
  brokerVars: BrokerVars;
}

/** GET <url>/health: true when the broker answers 2xx; any other outcome is false and leaves a log line. */
export async function brokerAnswers(url: string, log: Logger, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) log.info(`broker ${url} answered /health with ${res.status}`);
    return res.ok;
  } catch (e) {
    log.info(`broker ${url} did not answer /health: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * The broker of the code root the daemon runs from; null when that clone has no broker.ts.
 * `findBun` is the real bun binary: the daemon's own executable is a copy named for the daemon,
 * and a broker run under that name would pass for the daemon.
 */
export function locateCodeRootBroker(
  codeDir: string,
  findBun: () => string | null,
): { command: string; script: string } | null {
  const script = join(codeDir, "broker.ts");
  if (!existsSync(script)) return null;
  const command = findBun();
  if (command === null) throw new Error("bun was not found on the PATH of the daemon: the broker cannot be launched");
  return { command, script };
}

function pickBrokerVars(session: BrokerEnsureRequest["env"]): BrokerVars {
  const picked: BrokerVars = {};
  for (const [name, value] of Object.entries(session)) {
    if ((BROKER_ENV_NAMES as readonly string[]).includes(name) || name.startsWith(BROKER_ENV_PREFIX)) picked[name] = value;
  }
  return picked;
}

/** One flight per broker address: the scheme and host:port, so that a trailing slash or a default port is the same broker. */
function flightKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** Names only, never values: they can hold a token. */
function differingSettings(flight: Flight, settingsPath: string, brokerVars: BrokerVars): string[] {
  const names = new Set([...Object.keys(flight.brokerVars), ...Object.keys(brokerVars)]);
  const differing = [...names].filter((name) => flight.brokerVars[name] !== brokerVars[name]).sort();
  return flight.settingsPath === settingsPath ? differing : [...differing, "settingsPath"];
}

function brokerEnv(
  base: BrokerEnsurerDeps["baseEnv"],
  brokerVars: BrokerVars,
  home: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined) env[name] = value;
  Object.assign(env, brokerVars);
  // A GUI launch lacks the login shell's PATH, so bun's default install directory is appended.
  // Windows names the variable `Path`: writing a second `PATH` would leave the winner to the launcher.
  const windows = platform === "win32";
  const bunDir = (windows ? win32 : posix).join(home, ".bun", "bin");
  const pathKey = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = env[pathKey] ? `${env[pathKey]}${windows ? ";" : ":"}${bunDir}` : bunDir;
  return env;
}

export interface DaemonBrokerDepsOptions {
  /** The scrubbed environment of the daemon. */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  codeDir: string;
  log: Logger;
  /** Looks `bun` up on the given PATH. */
  which(searchPath: string): string | null;
}

/** The daemon's wiring of the ensurer: bun is searched on the daemon's PATH plus bun's default install directory. */
export function daemonBrokerDeps(opts: DaemonBrokerDepsOptions): BrokerEnsurerDeps {
  const { env, home, codeDir, log, which } = opts;
  return {
    isAlive: (url) => brokerAnswers(url, log),
    locate: () =>
      locateCodeRootBroker(codeDir, () => which([env["PATH"], join(home, ".bun", "bin")].filter(Boolean).join(delimiter))),
    spawn: (command, args, spawnEnv) => spawnDetachedBroker(command, args, spawnEnv, log),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    baseEnv: env,
    home,
    log,
  };
}

export function createBrokerEnsurer(deps: BrokerEnsurerDeps): BrokerEnsurer {
  const stopped = deps.stopped ?? ((settingsPath: string) => readBrokerStopMarker(brokerStopMarkerPath(settingsPath)).stopped);
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const inFlight = new Map<string, Flight>();

  async function run(req: BrokerEnsureRequest, brokerVars: BrokerVars): Promise<EnsureOutcome> {
    if (!isLoopbackBrokerUrl(req.url)) return { action: "skipped", reason: "remote-mode" };
    if (await deps.isAlive(req.url)) return { action: "already-running" };
    if (stopped(req.settingsPath)) return { action: "skipped", reason: "manual-stop" };
    let located: { command: string; script: string } | null;
    try {
      located = deps.locate();
    } catch (e) {
      return failed("", e instanceof Error ? e.message : String(e));
    }
    if (located === null) return { action: "not-found" };
    try {
      deps.spawn(located.command, [located.script], brokerEnv(deps.baseEnv, brokerVars, deps.home, deps.platform ?? process.platform));
    } catch (e) {
      return failed(located.script, e instanceof Error ? e.message : String(e));
    }
    for (let i = 0; i < attempts; i++) {
      await deps.sleep(pollMs);
      if (await deps.isAlive(req.url)) return { action: "started", script: located.script };
    }
    return failed(located.script, `no /health answer after ${attempts} attempts`);
  }

  function failed(script: string, reason: string): EnsureOutcome {
    deps.log.error(`broker launch failed: ${reason}`);
    return { action: "failed", script, reason };
  }

  return {
    ensure(req) {
      const key = flightKey(req.url);
      if (key === null) return Promise.resolve(failed("", `invalid broker URL: ${req.url}`));
      const brokerVars = pickBrokerVars(req.env);
      const joined = inFlight.get(key);
      if (joined !== undefined) {
        const differing = differingSettings(joined, req.settingsPath, brokerVars);
        if (differing.length > 0) {
          deps.log.warn(`ensure for ${key} joined a launch started with other broker settings: ${differing.join(", ")}`);
        }
        return joined.outcome;
      }
      const outcome = run(req, brokerVars).finally(() => inFlight.delete(key));
      inFlight.set(key, { outcome, settingsPath: req.settingsPath, brokerVars });
      return outcome;
    },
  };
}

interface SpawnedChild {
  on(event: "error", listener: (error: unknown) => void): unknown;
  unref(): void;
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: { detached: true; windowsHide: true; stdio: "ignore"; env: Record<string, string> },
) => SpawnedChild;

/** The broker must outlive the daemon: detached, no console window, no inherited stdio. */
export function spawnDetachedBroker(
  command: string,
  args: string[],
  env: Record<string, string>,
  log: Logger,
  spawnProcess: SpawnProcess = nodeSpawn,
): void {
  const child = spawnProcess(command, args, { detached: true, windowsHide: true, stdio: "ignore", env });
  child.on("error", (error) => log.error(`local broker process failed to start (${command} ${args.join(" ")})`, error));
  child.unref();
}
