/**
 * Rolling file logger (PLAN-observabilite-erreurs O1).
 *
 * Shared by the core (Bun: broker.ts, server.ts) and the Electron main process
 * (desktop/src/main/log.ts binds it to app.getPath('logs')). Node builtins
 * only -- no Bun.file, no electron imports -- so it runs everywhere and is
 * unit-testable under `bun test` with an injected directory.
 *
 * Size-based rotation, bounded on disk: when <name>.log reaches maxBytes it
 * shifts to <name>.log.1 ... <name>.log.<maxFiles-1>, oldest dropped. Writes
 * are synchronous appends so ordering is guaranteed and a last line can be
 * emitted from an uncaughtException handler. A failure to write the log file
 * itself must never throw: it falls back to the console (once per cause).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type LogLevel = "info" | "warn" | "error";

export interface LoggerOptions {
  /** Directory holding the log files (created on first write if missing). */
  dir: string;
  /** Base file name without extension: `<name>.log`. */
  name: string;
  /** Rotate when the current file reaches this size. Default 5 MiB. */
  maxBytes?: number;
  /** Total files kept (<name>.log + rotated). Default 3. */
  maxFiles?: number;
  /** Mirror every line to the console (kept for terminal runs). Default true. */
  mirrorToConsole?: boolean;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface Logger {
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
  /** Same sink, lines prefixed `[prefix]` (e.g. per-subsystem loggers). */
  child(prefix: string): Logger;
  /** Absolute path of the active log file. */
  readonly file: string;
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 3;

/** Render an arbitrary context value for the end of a log line. */
function renderContext(context: unknown): string {
  if (context === undefined) return "";
  if (context instanceof Error) {
    return " " + (context.stack ?? `${context.name}: ${context.message}`);
  }
  try {
    return " " + JSON.stringify(context);
  } catch {
    return " " + String(context);
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const mirror = options.mirrorToConsole ?? true;
  const now = options.now ?? (() => new Date());
  const file = join(options.dir, `${options.name}.log`);

  let dirReady = false;
  let warnedWriteFailure = false;

  function ensureDir(): void {
    if (dirReady) return;
    mkdirSync(options.dir, { recursive: true });
    // Boot trim: drop rotated files beyond maxFiles (e.g. after lowering the
    // cap) so the on-disk footprint stays bounded.
    for (const entry of readdirSync(options.dir)) {
      const match = entry.match(
        new RegExp(`^${options.name}\\.log\\.(\\d+)$`)
      );
      // The pattern is fully anchored with one MANDATORY group ((\d+), no
      // `?`), so match[1] is never undefined once `match` itself is non-null
      // -- but noUncheckedIndexedAccess cannot see that from the regex.
      // Explicit guard instead of a `!` assertion, same remedy as any other
      // capture-group access under this flag.
      const rotationSuffix = match?.[1];
      if (rotationSuffix !== undefined && parseInt(rotationSuffix, 10) >= maxFiles) {
        try {
          unlinkSync(join(options.dir, entry));
        } catch {
          // Best-effort trim; a leftover file is harmless.
        }
      }
    }
    dirReady = true;
  }

  function rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return; // No current file yet.
    }
    if (size < maxBytes) return;
    // Shift <name>.log.(n) -> .(n+1), oldest dropped, then base -> .1.
    const oldest = `${file}.${maxFiles - 1}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let n = maxFiles - 2; n >= 1; n--) {
      const src = `${file}.${n}`;
      if (existsSync(src)) renameSync(src, `${file}.${n + 1}`);
    }
    if (maxFiles > 1) {
      renameSync(file, `${file}.1`);
    } else {
      unlinkSync(file);
    }
  }

  function write(level: LogLevel, prefix: string, message: string, context?: unknown): void {
    const line =
      `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ` +
      `${prefix}${message}${renderContext(context)}`;
    if (mirror) {
      // console.error for warn/error keeps the current stderr behavior of the
      // broker/server; info goes to stdout.
      (level === "info" ? console.log : console.error)(line);
    }
    try {
      ensureDir();
      rotateIfNeeded();
      appendFileSync(file, line + "\n", "utf-8");
    } catch (e) {
      if (!warnedWriteFailure) {
        warnedWriteFailure = true;
        console.error(
          `[logger] cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  function make(prefix: string): Logger {
    return {
      file,
      info: (m, c) => write("info", prefix, m, c),
      warn: (m, c) => write("warn", prefix, m, c),
      error: (m, c) => write("error", prefix, m, c),
      child: (p) => make(`${prefix}[${p}] `),
    };
  }

  return make("");
}

/**
 * Default log directory for the core processes (broker.ts, server.ts):
 * `<claude-peers config dir>/logs`, overridable via CLAUDE_PEERS_LOG_DIR.
 * Mirrors the settings-file resolution in shared/config.ts (XDG / APPDATA).
 */
export function coreLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_PEERS_LOG_DIR;
  if (override && override.length > 0) return override;
  if (process.platform === "win32") {
    const appdata = env.APPDATA;
    const base = appdata
      ? join(appdata, "claude-peers")
      : join(homedir(), "AppData", "Roaming", "claude-peers");
    return join(base, "logs");
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg ? join(xdg, "claude-peers") : join(homedir(), ".config", "claude-peers");
  return join(base, "logs");
}
