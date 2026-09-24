// statusLine command the Deck injects into its Claude Code tiles (--settings).
// Two jobs per run:
//  1. Report the tile's model + context-window fill to the Deck: encode the
//     statusLine stdin payload into ~/.claude/peers/desk-status-<token>.json,
//     keyed by CLAUDE_PEERS_DESK_SESSION (no token => not a Deck tile, no file).
//  2. Keep the operator's own status line: run the statusLine command from the
//     GLOBAL user settings only, with the same stdin, and print its stdout
//     unchanged. Project/local settings come from a possibly cloned repo and
//     are never executed from here.
// Must run under bun; imports resolve relative to this file regardless of the
// session's cwd. Failures never reach the status bar: they go to the rotated
// statusline.log in the claude-peers log dir.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { coreLogDir, createLogger, type Logger } from "../../shared/logger.ts";
import { encodeStatusFromPayload, statusFileName } from "../src/shared/session-status.ts";

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
  if (typeof settingsJson !== "object" || settingsJson === null) return null;
  const sl = (settingsJson as Record<string, unknown>).statusLine;
  if (typeof sl !== "object" || sl === null) return null;
  const { type, command } = sl as Record<string, unknown>;
  if (type !== "command" || typeof command !== "string" || !command.trim()) return null;
  return command;
}

/** Where the report for `token` is written, or null when the token sanitizes to nothing. */
export function statusFileTarget(token: string | undefined, home: string = homedir()): string | null {
  const name = statusFileName(token);
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

function readGlobalCommand(log: Logger): string | null {
  const file = globalSettingsPath();
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.error(`failed to read ${file}`, e);
    return null;
  }
  try {
    return pickGlobalStatusLineCommand(JSON.parse(text));
  } catch (e) {
    log.warn(`${file} is not valid JSON, operator statusLine not chained`, e);
    return null;
  }
}

/** Grace after the kill before the pipes are abandoned (a child that left the group). */
const KILL_GRACE_MS = 500;

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
    log.warn(`failed to kill the timed-out operator statusLine (pid ${pid})`, e);
  }
}

/** Run the operator's command with `raw` on stdin; resolves with its stdout (possibly partial). */
function runChained(command: string, raw: string, log: Logger): Promise<Buffer> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(abandonTimer);
      resolve(Buffer.concat(out));
    };
    // How Claude Code itself shells a statusLine on win32 is unconfirmed, so the
    // chaining there is best-effort through node's default shell.
    const child = spawn(command, {
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: { ...process.env, [CHAINED_ENV]: "1" },
    });
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
      log.warn("operator statusLine failed to start", e);
      finish();
    });
    child.on("close", finish);
    child.stdin?.on("error", (e) => log.warn("operator statusLine did not take its stdin", e));
    child.stdin?.end(raw);
  });
}

async function chainOperatorStatusLine(raw: string, log: Logger): Promise<void> {
  const command = readGlobalCommand(log);
  if (!command) return;
  let out: Buffer;
  try {
    out = await runChained(command, raw, log);
  } catch (e) {
    log.warn("operator statusLine could not be spawned", e);
    return;
  }
  if (out.length > 0) process.stdout.write(out);
}

async function main(): Promise<void> {
  if (isChainedInvocation()) return;
  const log = createLogger({ dir: coreLogDir(), name: "statusline", mirrorToConsole: false });
  let raw = "";
  try {
    raw = await readStdin();
  } catch (e) {
    log.error("failed to read the statusLine payload from stdin", e);
  }
  reportStatus(raw, log);
  await chainOperatorStatusLine(raw, log);
}

// Only run when executed directly, so tests can import the pure helpers.
// No process.exit: it can cut a pending stdout write short on a pipe. Every
// handle is closed or cleared once main settles, so the process ends on its own.
if (import.meta.main) {
  void main();
}
