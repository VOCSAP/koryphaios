// Keeps the Deck's back-channel session id in sync across in-process id
// rotations (/clear, compaction) that server.ts cannot observe, since its
// CLAUDE_CODE_SESSION_ID env is frozen for the process lifetime.
// Gated on CLAUDE_PEERS_DESK_SESSION so any non-Deck session runs it as a
// silent no-op.
// Reads the real resumable id from the SessionStart payload's transcript_path
// (its .jsonl basename) and overwrites
// ~/.claude/peers/desk-session-<token>.txt.
// Must run under bun; imports resolve relative to this file regardless of the
// session's cwd.

import { sanitizeSessionId, writeDeskSessionFile, type DeskSessionSource } from "../../shared/peer-cache.ts";

/** SessionStart payload fields this hook consumes (others ignored). */
export interface SessionStartPayload {
  transcript_path?: string;
  session_id?: string;
  source?: string;
}

/**
 * Resolve the resumable session id from a SessionStart payload. Prefers the
 * transcript basename (the exact id `--resume` reloads) over `session_id`, which
 * the docs show can diverge in the interactive PTY + MCP context. Returns "" when
 * neither is usable.
 */
export function deriveSessionId(payload: SessionStartPayload): string {
  const tp = payload.transcript_path?.trim();
  if (tp) {
    // Split on both separators so a Windows "C:\...\id.jsonl" path works under a
    // posix node:path too (the hook runs under bun on every platform).
    const file = tp.split(/[/\\]/).pop() ?? "";
    return file.replace(/\.jsonl$/i, "");
  }
  return (payload.session_id ?? "").trim();
}

export const SESSION_START_SOURCES: ReadonlySet<string> = new Set(["startup", "resume", "clear", "compact"]);

/**
 * The payload's SessionStart source; a missing or unknown one reads as
 * startup, which the Deck never adopts as a later rotation.
 */
export function deriveSessionSource(payload: SessionStartPayload): DeskSessionSource {
  const source = payload.source;
  return source !== undefined && SESSION_START_SOURCES.has(source) ? (source as DeskSessionSource) : "startup";
}

/** Read all of stdin as a UTF-8 string (the hook payload). */
async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main(): Promise<void> {
  // Gate: only Deck tiles carry the token. Non-Deck sessions write nothing.
  const token = sanitizeSessionId(process.env.CLAUDE_PEERS_DESK_SESSION);
  if (!token) return;

  let payload: SessionStartPayload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}") as SessionStartPayload;
  } catch {
    return; // malformed payload -> best-effort no-op
  }

  const id = deriveSessionId(payload);
  if (!id) return;
  await writeDeskSessionFile(token, { sid: id, source: deriveSessionSource(payload) });
}

// Only run when executed directly (so tests can import deriveSessionId cleanly).
if (import.meta.main) {
  void main().finally(() => process.exit(0));
}
