// Shared on-disk shape for the session-side approval credential used by both
// approval producers spawned inside an agent (Claude Code hooks and the
// ask_operator tool), so they cannot drift.
// The Deck writes a chmod-600 JSON file and passes its path via env, so the
// private key never lands in argv or /proc/<pid>/environ.
// This credential may only add/wait for its own session and can never settle
// (claim) an approval -- only the Deck can, which is what makes the file safe
// to project into a sandbox container.

import { readFileSync } from "node:fs";

export {
  APPROVAL_QUESTION_MAX,
  APPROVAL_TITLE_MAX,
  buildAuthProof,
  stripControl,
} from "./approval.ts";

/** Where the Deck drops the per-session credential. */
export const APPROVAL_FILE_ENV = "CLAUDE_PEERS_APPROVAL_FILE";

/** Default blocking budget of a hook, in seconds (never 24h — see the plan). */
export const APPROVAL_HOOK_BLOCK_SEC_DEFAULT = 900;

export interface SessionApprovalCredential {
  brokerUrl: string;
  brokerToken: string | null;
  operatorId: string;
  tokenId: string;
  sessionRef: string;
  privateKey: string;
  publicKey: string;
  /** Salted hash of the OS username; the login itself never travels. */
  osUserHash: string;
  /** Total seconds a hook may block before handing back to the native dialog. */
  blockSec: number;
  origin: { host?: string; os_user_hash?: string; project_key?: string; from_peer?: string };
}

export type FileReader = (path: string, encoding: "utf8") => string;

/**
 * Read and shape the credential file. Returns null whenever the feature is not
 * active here — an absent path, an unreadable file or an incomplete payload are
 * all "off", never errors: a session without remote approvals must behave
 * exactly as before.
 */
export function loadApprovalCredential(
  path: string | undefined,
  read: FileReader = readFileSync as unknown as FileReader
): SessionApprovalCredential | null {
  if (!path) return null;
  let parsed: Partial<SessionApprovalCredential>;
  try {
    parsed = JSON.parse(read(path, "utf8")) as Partial<SessionApprovalCredential>;
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.brokerUrl ||
    !parsed.operatorId ||
    !parsed.tokenId ||
    !parsed.privateKey ||
    !parsed.publicKey
  ) {
    return null;
  }
  return {
    brokerUrl: parsed.brokerUrl,
    brokerToken: parsed.brokerToken ?? null,
    operatorId: parsed.operatorId,
    tokenId: parsed.tokenId,
    sessionRef: parsed.sessionRef ?? "",
    privateKey: parsed.privateKey,
    publicKey: parsed.publicKey,
    osUserHash: parsed.osUserHash ?? parsed.origin?.os_user_hash ?? "",
    blockSec: parsed.blockSec ?? APPROVAL_HOOK_BLOCK_SEC_DEFAULT,
    origin: parsed.origin ?? {},
  };
}

/** Convenience wrapper reading the path from the environment. */
export function loadSessionApprovalCredential(
  env: NodeJS.ProcessEnv = process.env
): SessionApprovalCredential | null {
  return loadApprovalCredential(env[APPROVAL_FILE_ENV]);
}
