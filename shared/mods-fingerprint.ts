import { createHash } from "node:crypto";

/**
 * Paths the Claude Code engine writes into a plugin directory it is launched
 * on (`--plugin-dir`), relative to the plugin root. A trailing `/` means the
 * whole subtree. They are never part of a distributed plugin.
 */
export const ENGINE_PATHS = ["tsconfig.json", ".claude-plugin/types/"] as const;

export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export interface ModFile {
  path: string;
  bytes: Uint8Array;
}

// NTFS and APFS fold case, so `Tsconfig.json` and `.claude-plugin/Types/` are the engine's paths too.
export function isEnginePath(path: string): boolean {
  const folded = path.toLowerCase();
  return ENGINE_PATHS.some((enginePath) => (enginePath.endsWith("/") ? folded.startsWith(enginePath) : folded === enginePath));
}

export function isDistributable(path: string): boolean {
  return path === "README.md" || path.startsWith(".claude-plugin/") || path.startsWith("hooks/");
}

// CRLF is folded to LF: a Windows checkout with core.autocrlf=true rewrites the
// copy's line endings, and the fingerprint must not depend on the host.
function normalizeEol(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte === 0x0d && bytes[i + 1] === 0x0a) continue;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

// Every path and content carries its byte length, so no choice of names or bytes can imitate a boundary.
export function modsFingerprint(files: readonly ModFile[]): string {
  const hash = createHash("sha256");
  hash.update("choregos-mods-fingerprint-v2");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const path = Buffer.from(file.path, "utf-8");
    const bytes = normalizeEol(file.bytes);
    hash.update(lengthPrefix(path.length));
    hash.update(path);
    hash.update(lengthPrefix(bytes.length));
    hash.update(bytes);
  }
  return hash.digest("hex");
}
