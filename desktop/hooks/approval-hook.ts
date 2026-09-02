// Fire-and-forget: posts the approval and exits immediately rather than
// blocking; Claude Code already waits on its own dialog until the Deck later
// types the answer into the tile.
// Wired only on PermissionRequest and Notification's agent_needs_input —
// permission_prompt is skipped (already covered) and idle_prompt is
// deliberately excluded, since it fires once no dialog is on screen.
// Carries a restricted session credential (read from a chmod-600 file, never
// argv/environ) that can only add for this window, never settle.
// Fails silent: any error (no credential, broker down, malformed payload) exits
// 0 and leaves the session waiting on its dialog as if the hook were absent.

import { buildAuthProof, stripControl } from "../../shared/approval.ts";
import {
  APPROVAL_FILE_ENV,
  APPROVAL_HOOK_BLOCK_SEC_DEFAULT,
  loadApprovalCredential,
  type FileReader,
  type SessionApprovalCredential,
} from "../../shared/approval-client.ts";

export { APPROVAL_FILE_ENV, APPROVAL_HOOK_BLOCK_SEC_DEFAULT };

/** Ceiling on the single POST the hook makes. It never waits for an answer. */
const POST_TIMEOUT_SEC = 15;

/** Per-tile handle the Deck injects into every session it spawns. */
const DESK_SESSION_ENV = "CLAUDE_PEERS_DESK_SESSION";

/** The on-disk shape lives in shared/approval-client.ts so the MCP tool and
 * this hook can never drift apart. */
export type ApprovalHookConfig = SessionApprovalCredential;

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  notification_type?: string;
  message?: string;
}

// --- Pure helpers (unit-tested without a broker or Claude Code) ---

/** Parse the stdin payload; malformed input yields an empty payload, never a throw. */
export function parseHookPayload(raw: string): HookPayload {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as HookPayload) : {};
  } catch {
    return {};
  }
}

/**
 * What KIND of approval this payload deserves — not whether to wait, since the
 * hook never waits. `skip` keeps one dialog from raising two notifications.
 */
export function classifyPayload(p: HookPayload): "permission" | "question" | "skip" {
  if (p.hook_event_name === "PermissionRequest") return "permission";
  if (p.hook_event_name === "Notification") {
    const t = p.notification_type ?? "";
    // ALLOW-LIST of exactly one type, never a deny-list (card 47baf25a): every
    // other notification_type -- including the ones this CLI version does not
    // emit yet -- must fall through to `skip`, because the cost of the wrong
    // answer is asymmetric. A missed question is one entry the operator raises
    // by hand; a spurious one is an inbox nobody reads any more.
    return t === "agent_needs_input" ? "question" : "skip";
  }
  return "skip";
}

/** Single-line summary of a tool call, safe for a notification title. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  const name = stripControl(toolName || "tool").trim() || "tool";
  if (!input || typeof input !== "object") return name;
  const detail =
    typeof input.command === "string"
      ? input.command
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.path === "string"
          ? input.path
          : typeof input.url === "string"
            ? input.url
            : "";
  const clean = stripControl(String(detail)).trim();
  return clean ? `${name}: ${clean.slice(0, 160)}` : name;
}

/** Build the /approval/add body for a payload (without auth). */
export function buildApprovalRequest(
  p: HookPayload,
  cfg: ApprovalHookConfig,
  tileRef = ""
): Record<string, unknown> {
  const blocking = classifyPayload(p) === "permission";
  const title = blocking
    ? summarizeToolInput(p.tool_name ?? "", p.tool_input)
    : stripControl(p.message ?? "").trim().slice(0, 160) || "The agent is waiting for you";
  const question = blocking
    ? [
        `The agent wants to use ${stripControl(p.tool_name ?? "a tool").trim() || "a tool"}.`,
        p.tool_input ? `Input: ${safeJson(p.tool_input)}` : "",
        p.cwd ? `Working directory: ${stripControl(p.cwd).trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : stripControl(p.message ?? "", { keepNewlines: true }).trim() ||
      "The session is waiting for an answer.";

  return {
    kind: blocking ? "permission" : "question",
    title,
    question,
    options: blocking ? ["Allow", "Deny"] : [],
    session_ref: cfg.sessionRef,
    // Untrusted routing hint: which tile the Deck should answer into. The
    // credential authenticates the WINDOW, not this — the Deck re-validates it.
    tile_ref: tileRef,
    origin: {
      host: cfg.origin?.host ?? "",
      os_user_hash: cfg.origin?.os_user_hash ?? "",
      project_key: cfg.origin?.project_key ?? "",
      from_peer: cfg.origin?.from_peer ?? "",
      group_id: "",
    },
    public_key: cfg.publicKey,
  };
}

function safeJson(value: unknown): string {
  try {
    return stripControl(JSON.stringify(value) ?? "", { keepNewlines: true }).slice(0, 1200);
  } catch {
    return "";
  }
}

/** Read + shape the credential file. Returns null when the feature is off. */
export function loadConfig(path: string | undefined, read?: FileReader): ApprovalHookConfig | null {
  return loadApprovalCredential(path, read);
}

// --- I/O ---

/** One signed POST. Returns false on any failure; the caller just gives up. */
async function postApproval(
  cfg: ApprovalHookConfig,
  payload: Record<string, unknown>
): Promise<boolean> {
  const auth = buildAuthProof(cfg.privateKey, payload, {
    kind: "session",
    operator_id: cfg.operatorId,
    token_id: cfg.tokenId,
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.brokerToken) headers.authorization = `Bearer ${cfg.brokerToken}`;
  try {
    const res = await fetch(`${cfg.brokerUrl}/approval/add`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payload, auth }),
      signal: AbortSignal.timeout(POST_TIMEOUT_SEC * 1000),
    });
    return res.ok;
  } catch {
    // Broker unreachable: the session is unaffected, it just waits on screen.
    return false;
  }
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env[APPROVAL_FILE_ENV]);
  if (!cfg) return; // gate: a non-Deck session is a silent no-op

  const payload = parseHookPayload(await readStdin());
  if (classifyPayload(payload) === "skip") return;

  const tileRef = (process.env[DESK_SESSION_ENV] ?? "").trim();
  await postApproval(cfg, buildApprovalRequest(payload, cfg, tileRef));
  // Deliberately no stdout: the hook emits NO decision, ever. Claude Code keeps
  // its own dialog up and the Deck applies whatever the operator answers.
}

// Only run when executed directly, so tests can import the pure helpers.
if (import.meta.main) {
  void main().finally(() => process.exit(0));
}
