// Builds the Rust relay (relay/) for the host platform, installs it under
// bin/<platform>-<arch>/ and prints the two `claude mcp add` commands.
// Usage: bun scripts/relay-setup.ts [--print-only]
// It never writes the Claude Code configuration: the commands are printed for the
// operator to run. --print-only skips the build and picks the form by binary presence.
// The env of the existing user-scope entries is carried into the printed commands,
// except what looks like a secret.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const RELAY_BIN = "claude-peers-relay";
const USAGE = "usage: bun scripts/relay-setup.ts [--print-only]";
const CLOSE_HINT = "close the Claude Code sessions that use the relay, then re-run";
// A parked copy still running in an old session keeps its name; the next one takes the next free suffix.
const MAX_PARKED = 10;

export interface RunResult {
  exitCode: number;
  stderr: string;
}
export type Runner = (cmd: string[], cwd: string) => RunResult;

export interface Fs {
  exists(path: string): boolean;
  mkdir(path: string): void;
  copy(from: string, to: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  size(path: string): number;
}

export const realFs: Fs = {
  exists: existsSync,
  mkdir: (p) => void mkdirSync(p, { recursive: true }),
  copy: copyFileSync,
  rename: renameSync,
  remove: (p) => rmSync(p),
  size: (p) => statSync(p).size,
};

export type Form = { kind: "relay"; binary: string } | { kind: "bun" };

export type InstallOutcome = { ok: true; binary: string; bytes: number; notes: string[] } | { ok: false; reason: string };
export type BuildOutcome = InstallOutcome;

export interface Deps {
  root: string;
  platform: string;
  arch: string;
  fs: Fs;
  run: Runner;
  sourceFiles: () => string[];
  mtimeMs: (path: string) => number;
  /** The Claude Code config text, null when the file does not exist. */
  readClaudeConfig: () => string | null;
  out: (text: string) => void;
  err: (text: string) => void;
}

// Printed commands are pasted into a POSIX shell, including Git Bash on Windows,
// where a backslash would be eaten: every path is forward-slashed.
export function posix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function platformDir(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

export function binaryName(platform: string): string {
  return platform === "win32" ? `${RELAY_BIN}.exe` : RELAY_BIN;
}

// A glibc build of the relay needs the glibc of the machine that built it; the
// musl one is static and runs on any distribution.
export function cargoTarget(platform: string, arch: string): string | undefined {
  if (platform !== "linux") return undefined;
  if (arch === "x64") return "x86_64-unknown-linux-musl";
  if (arch === "arm64") return "aarch64-unknown-linux-musl";
  return undefined;
}

export function cargoArgs(target: string | undefined): string[] {
  return ["build", "--release", "--locked", "--bin", RELAY_BIN, ...(target ? ["--target", target] : [])];
}

// With --target, cargo writes under target/<triple>/release instead of target/release.
export function builtBinaryPath(root: string, platform: string, target: string | undefined): string {
  return [posix(root), "relay", "target", ...(target ? [target] : []), "release", binaryName(platform)].join("/");
}

export function installedBinaryPath(root: string, platform: string, arch: string): string {
  return [posix(root), "bin", platformDir(platform, arch), binaryName(platform)].join("/");
}

export function chooseForm(binary: string, binaryExists: boolean): Form {
  return binaryExists ? { kind: "relay", binary } : { kind: "bun" };
}

export function shellQuote(p: string): string {
  return /^[A-Za-z0-9_\/:.@%+=,~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export const ENTRY_NAMES = ["claude-peers", "kory-roadmap"] as const;
export type EntryName = (typeof ENTRY_NAMES)[number];
export type EntryEnvs = Record<EntryName, Array<[name: string, value: string]>>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Read by server.ts and shared/. FORCE_GROUP holds the group secret and DEPOSIT_CAPABILITY is a capability: never carried.
const CARRIED_ENV_NAMES: ReadonlySet<string> = new Set([
  "CLAUDE_PEERS_BROKER_URL",
  "CLAUDE_PEERS_GROUP",
  "CLAUDE_PEERS_PORT",
  "CLAUDE_PEERS_LOG_DIR",
  "CLAUDE_PEERS_ROLE",
  "CLAUDE_PEERS_TOOLS",
  "CLAUDE_PEERS_POLL_FALLBACK_SEC",
  "CLAUDE_PEERS_MCP_DAEMON_PORT",
]);
// The one printed form that means the same in bash, PowerShell and cmd: no quote, `%`, space, `$` or control byte.
const SAFE_VALUE = /^[A-Za-z0-9_\/:.@+=-]*$/;
const URL_CREDENTIALS = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]*@/;

function noEnvs(): EntryEnvs {
  return { "claude-peers": [], "kory-roadmap": [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function claudeConfigPath(env: Record<string, string | undefined>, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");
}

// The config is a file this script does not own: names and values are untrusted
// text that ends in a command pasted into a shell, and a note never holds a value.
export function existingEnvs(configText: string | null): { envs: EntryEnvs; notes: string[] } {
  const envs = noEnvs();
  const notes: string[] = [];
  if (configText === null) return { envs, notes };
  let servers: unknown;
  try {
    servers = (JSON.parse(configText) as { mcpServers?: unknown } | null)?.mcpServers;
  } catch {
    notes.push("The Claude Code config is not valid JSON: the existing env is not carried.");
    return { envs, notes };
  }
  if (!isRecord(servers)) return { envs, notes };
  for (const name of ENTRY_NAMES) {
    const entry = servers[name];
    if (!isRecord(entry) || entry.env === undefined) continue;
    if (!isRecord(entry.env)) {
      notes.push(`${name}: env is not an object, not carried.`);
      continue;
    }
    for (const [key, value] of Object.entries(entry.env)) {
      if (!ENV_NAME.test(key)) {
        notes.push(`${name}: an env name of ${key.length} characters is not a valid variable name, not carried.`);
      } else if (!CARRIED_ENV_NAMES.has(key) || typeof value !== "string" || !SAFE_VALUE.test(value) || URL_CREDENTIALS.test(value)) {
        notes.push(`${name}: ${key} not carried: add --env ${key}=<value> by hand.`);
      } else {
        envs[name].push([key, value]);
      }
    }
  }
  return { envs, notes };
}

export function mcpAddCommands(form: Form, root: string, envs: EntryEnvs = noEnvs()): string[] {
  const base = posix(root);
  const add = (name: EntryName) =>
    `claude mcp add --scope user --transport stdio ${name}${envs[name].map(([k, v]) => ` --env ${k}=${v}`).join("")} --`;
  if (form.kind === "relay") {
    const bin = shellQuote(posix(form.binary));
    return [
      `${add("claude-peers")} ${bin} --family peers --fallback ${shellQuote(`${base}/server.ts`)}`,
      `${add("kory-roadmap")} ${bin} --family roadmap --fallback ${shellQuote(`${base}/server-roadmap.ts`)}`,
    ];
  }
  return [`${add("claude-peers")} bun ${shellQuote(`${base}/server.ts`)}`, `${add("kory-roadmap")} bun ${shellQuote(`${base}/server-roadmap.ts`)}`];
}

export function renderPlan(notes: string[], form: Form, root: string, envs?: EntryEnvs): string {
  return [
    ...notes,
    `Commands for the ${form.kind} form:`,
    "Paste them into bash (Git Bash on Windows).",
    ...mcpAddCommands(form, root, envs),
    "This script does not write the Claude Code configuration. If an entry already exists, remove it first: claude mcp remove <name> --scope user",
  ].join("\n");
}

function tail(text: string, lines: number): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isOlderThanSources(binaryMtimeMs: number, sourceMtimesMs: number[]): boolean {
  return sourceMtimesMs.some((t) => t > binaryMtimeMs);
}

// The path of a running binary cannot be overwritten (Windows locks the image, Linux
// answers ETXTBSY) but it can be renamed: the new file is written beside it, the running
// one is parked under a free `.old` name, and the new one takes the path.
function parkingName(dest: string, fs: Fs, notes: string[]): string {
  for (let i = 0; i < MAX_PARKED; i++) {
    const name = i === 0 ? `${dest}.old` : `${dest}.old${i}`;
    if (!fs.exists(name)) return name;
    try {
      fs.remove(name);
      return name;
    } catch (e) {
      notes.push(`${name} is still in use by a running session and was left in place (${message(e)}).`);
    }
  }
  throw new Error(`${MAX_PARKED} previous copies of the relay are still running`);
}

export function installBinary(built: string, dest: string, fs: Fs): InstallOutcome {
  const fresh = `${dest}.new`;
  const notes: string[] = [];
  let parked: string | undefined;
  try {
    fs.mkdir(dest.slice(0, dest.lastIndexOf("/")));
    if (fs.exists(fresh)) fs.remove(fresh);
    fs.copy(built, fresh);
    if (fs.exists(dest)) {
      parked = parkingName(dest, fs, notes);
      fs.rename(dest, parked);
    }
    fs.rename(fresh, dest);
    return { ok: true, binary: dest, bytes: fs.size(dest), notes };
  } catch (e) {
    let restored = "";
    if (parked && !fs.exists(dest)) {
      try {
        fs.rename(parked, dest);
      } catch (r) {
        restored = ` The previous binary is at ${parked} (${message(r)}).`;
      }
    }
    return { ok: false, reason: `could not install ${dest} (${message(e)}); ${CLOSE_HINT}.${restored}` };
  }
}

export function buildRelay(root: string, platform: string, arch: string, run: Runner, fs: Fs = realFs): BuildOutcome {
  const target = cargoTarget(platform, arch);
  let result: RunResult;
  try {
    result = run(["cargo", ...cargoArgs(target)], `${posix(root)}/relay`);
  } catch (e) {
    return { ok: false, reason: `cargo could not be started (${message(e)}); install Rust from https://rustup.rs` };
  }
  if (result.exitCode !== 0) {
    const hint = target ? ` If the Rust target is missing: rustup target add ${target}` : "";
    return { ok: false, reason: `cargo exited with code ${result.exitCode}.${hint}\n${tail(result.stderr, 8)}` };
  }
  return installBinary(builtBinaryPath(root, platform, target), installedBinaryPath(root, platform, arch), fs);
}

export function main(argv: string[], deps: Deps): number {
  if (argv.some((a) => a !== "--print-only")) {
    deps.err(USAGE);
    return 2;
  }
  const printOnly = argv.includes("--print-only");
  const installed = installedBinaryPath(deps.root, deps.platform, deps.arch);
  const notes: string[] = [];
  let exitCode = 0;
  if (printOnly) {
    if (!deps.fs.exists(installed)) {
      notes.push(`No relay binary at ${installed}: run without --print-only to build it.`);
    } else if (isOlderThanSources(deps.mtimeMs(installed), deps.sourceFiles().map(deps.mtimeMs))) {
      notes.push("The binary is older than relay/: re-run without --print-only.");
    }
  } else {
    const built = buildRelay(deps.root, deps.platform, deps.arch, deps.run, deps.fs);
    if (built.ok) {
      notes.push(`Built the relay and installed it at ${built.binary} (${built.bytes} bytes).`, ...built.notes);
    } else {
      exitCode = 1;
      notes.push(`Relay build failed: ${built.reason}`);
      notes.push(
        deps.fs.exists(installed)
          ? `The binary already installed at ${installed} is kept and used below.`
          : "The commands below use the bun form, which needs no binary.",
      );
    }
  }
  let configText: string | null = null;
  try {
    configText = deps.readClaudeConfig();
  } catch (e) {
    notes.push(`Could not read the Claude Code config (${message(e)}): the existing env is not carried.`);
  }
  const existing = existingEnvs(configText);
  notes.push(...existing.notes);
  deps.out(renderPlan(notes, chooseForm(installed, deps.fs.exists(installed)), deps.root, existing.envs));
  return exitCode;
}

function relaySources(root: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  return [...walk(`${posix(root)}/relay/src`), `${posix(root)}/relay/Cargo.toml`];
}

function defaultDeps(): Deps {
  const root = resolve(import.meta.dir, "..");
  return {
    root,
    platform: process.platform,
    arch: process.arch,
    fs: realFs,
    run: (cmd, cwd) => {
      const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
      return { exitCode: r.exitCode ?? 1, stderr: r.stderr.toString() };
    },
    sourceFiles: () => relaySources(root),
    mtimeMs: (p) => statSync(p).mtimeMs,
    readClaudeConfig: () => {
      try {
        return readFileSync(claudeConfigPath(process.env, homedir()), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  };
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), defaultDeps());
