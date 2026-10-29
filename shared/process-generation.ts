import { readFile } from "node:fs/promises";
import { win32 } from "node:path";

import type { WriterGeneration } from "./peer-cache.ts";
import { coreLogDir, createLogger } from "./logger.ts";

const WINDOWS_CREATION_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z$/;
const PROC_STARTTIME_INDEX = 22 - 3;
const WINDOWS_PROCESS_TIMEOUT_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const DOT_DOT_SEGMENT_RE = /(^|[\\/])\.\.([\\/]|$)/;
const log = createLogger({ dir: coreLogDir(), name: "server", mirrorToConsole: false }).child("process-generation");
let loggedUnsupportedPlatform = false;

function positivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function measureWindowsProcessGeneration(pid: number): Promise<WriterGeneration | null> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !WINDOWS_ABSOLUTE_RE.test(systemRoot) || DOT_DOT_SEGMENT_RE.test(systemRoot)) {
    log.error("Cannot resolve an absolute System32 PowerShell path for process generation");
    return null;
  }
  try {
    const proc = Bun.spawn([
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
    ], { stdout: "pipe", stderr: "ignore", timeout: WINDOWS_PROCESS_TIMEOUT_MS });
    const [creationUtc, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const value = creationUtc.trim();
    if (exitCode !== 0 || !WINDOWS_CREATION_UTC_RE.test(value)) {
      log.error("Windows process generation measurement failed", { pid, exitCode });
      return null;
    }
    return { platform: "win32", pid, creationUtc: value };
  } catch (error) {
    log.error("Windows process generation measurement failed", error);
    return null;
  }
}

async function measureLinuxProcessGeneration(pid: number): Promise<WriterGeneration | null> {
  const [stat, bootId] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf-8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf-8"),
  ]);
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const startToken = stat.slice(close + 1).trim().split(/\s+/)[PROC_STARTTIME_INDEX];
  const trimmedBootId = bootId.trim();
  if (!startToken || !/^\d+$/.test(startToken) || !trimmedBootId) return null;
  return { platform: "linux", pid, startToken, bootId: trimmedBootId };
}

export async function measureWriterGeneration(pid: number): Promise<WriterGeneration | null> {
  if (!positivePid(pid)) return null;
  if (process.platform === "win32") return measureWindowsProcessGeneration(pid);
  if (process.platform === "linux") return measureLinuxProcessGeneration(pid);
  if (!loggedUnsupportedPlatform) {
    loggedUnsupportedPlatform = true;
    log.warn(`Global companion identity generation is unavailable on ${process.platform}`);
  }
  return null;
}
