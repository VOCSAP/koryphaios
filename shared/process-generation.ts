import { readFile } from "node:fs/promises";

import type { WriterGeneration } from "./peer-cache.ts";
import { coreLogDir, createLogger, type Logger } from "./logger.ts";

const PROC_STARTTIME_INDEX = 22 - 3;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MAX_WINDOWS_PID = 0xffff_ffff;
const MAX_IMAGE_PATH_CHARS = 32_768;
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const FILETIME_TICKS_PER_SECOND = 10_000_000n;
const defaultLog = createLogger({ dir: coreLogDir(), name: "server", mirrorToConsole: false }).child("process-generation");
let loggedUnsupportedPlatform = false;

function positivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

// bun:ffi is required on first use: this module is also bundled for node, where a top-level import fails at startup.
function loadKernel32() {
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const { symbols } = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.i64 },
    GetProcessTimes: { args: [FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    QueryFullProcessImageNameW: { args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  });
  return { symbols, ptr };
}

let kernel32: ReturnType<typeof loadKernel32> | undefined;

function withProcessHandle(
  pid: number,
  use: (api: ReturnType<typeof loadKernel32>, handle: bigint) => string | null,
): string | null {
  if (!Number.isInteger(pid) || pid < 1 || pid > MAX_WINDOWS_PID) return null;
  kernel32 ??= loadKernel32();
  const handle = kernel32.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === 0n) return null;
  try {
    return use(kernel32, handle);
  } finally {
    kernel32.symbols.CloseHandle(handle);
  }
}

/** Creation time of any process as a decimal FILETIME (100 ns ticks since 1601); null when the process cannot be opened or read. */
export function processStartFiletime(pid: number): string | null {
  return withProcessHandle(pid, ({ symbols, ptr }, handle) => {
    // creation, exit, kernel and user times: each FILETIME is a little-endian u64.
    const times = new BigUint64Array(4);
    const ok = symbols.GetProcessTimes(handle, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24));
    return ok === 0 ? null : (times[0] as bigint).toString();
  });
}

/** Full image path of any process; null when the process cannot be opened or read. */
export function processImagePath(pid: number): string | null {
  return withProcessHandle(pid, ({ symbols, ptr }, handle) => {
    const chars = new Uint16Array(MAX_IMAGE_PATH_CHARS);
    const length = new Uint32Array([chars.length]);
    const ok = symbols.QueryFullProcessImageNameW(handle, 0, ptr(chars), ptr(length));
    return ok === 0 ? null : new TextDecoder("utf-16le").decode(chars.subarray(0, length[0]));
  });
}

/** A FILETIME in the format of PowerShell `ToString('o')` on a UTC DateTime: 7 decimals, whatever the trailing zeros. */
export function filetimeToCreationUtc(filetime: bigint | string): string {
  const ticks = BigInt(filetime) - FILETIME_UNIX_EPOCH;
  if (ticks < 0n) throw new RangeError(`FILETIME ${String(filetime)} is before the Unix epoch`);
  const seconds = new Date(Number(ticks / FILETIME_TICKS_PER_SECOND) * 1000).toISOString().slice(0, 19);
  return `${seconds}.${String(ticks % FILETIME_TICKS_PER_SECOND).padStart(7, "0")}Z`;
}

function measureWindowsProcessGeneration(pid: number, log: Logger): WriterGeneration | null {
  try {
    const filetime = processStartFiletime(pid);
    if (filetime === null) {
      log.error("Windows process generation measurement failed", { pid });
      return null;
    }
    return { platform: "win32", pid, creationUtc: filetimeToCreationUtc(filetime) };
  } catch (error) {
    log.error("Windows process generation measurement failed", error);
    return null;
  }
}

async function measureLinuxProcessGeneration(pid: number, log: Logger): Promise<WriterGeneration | null> {
  try {
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
  } catch (error) {
    log.warn(`Linux process generation measurement failed for pid ${pid}`, error);
    return null;
  }
}

export async function measureWriterGeneration(pid: number, log: Logger = defaultLog): Promise<WriterGeneration | null> {
  if (!positivePid(pid)) return null;
  if (process.platform === "win32") return measureWindowsProcessGeneration(pid, log);
  if (process.platform === "linux") return measureLinuxProcessGeneration(pid, log);
  if (!loggedUnsupportedPlatform) {
    loggedUnsupportedPlatform = true;
    log.warn(`Global companion identity generation is unavailable on ${process.platform}`);
  }
  return null;
}
