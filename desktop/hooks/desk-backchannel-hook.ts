import { resolveBrokerEndpoint } from "../src/main/broker-client.ts";
import { readSessionIdentityFile, sanitizeSessionId, writeDeskSessionFile, type DeskSessionSource } from "../../shared/peer-cache.ts";
import { buildCompactReanchorContext, fetchCompactGroupPeers, reanchorAfterCompaction } from "./compact-reanchor.ts";

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

function traceCompactReanchor(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function compactReanchorContext(token: string): Promise<string> {
  const role = process.env.CLAUDE_PEERS_ROLE || "";
  const identity = await readSessionIdentityFile(token);
  if (!identity) {
    traceCompactReanchor("Kory compact reanchor: tile identity unavailable");
    return buildCompactReanchorContext({ peerId: "", groupId: "", role }, null);
  }

  return reanchorAfterCompaction(
    { peerId: identity.peerId, groupId: identity.groupId, role },
    async () => fetchCompactGroupPeers(resolveBrokerEndpoint(), identity.instanceToken),
    traceCompactReanchor,
  );
}

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

  const source = deriveSessionSource(payload);
  const id = deriveSessionId(payload);
  if (id) {
    try {
      await writeDeskSessionFile(token, { sid: id, source });
    } catch (error) {
      traceCompactReanchor(`Kory desk backchannel: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (source !== "compact") return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: await compactReanchorContext(token),
      },
    }),
  );
}

// Only run when executed directly (so tests can import deriveSessionId cleanly).
if (import.meta.main) {
  void main().finally(() => process.exit(0));
}
