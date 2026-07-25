// Claude Code hooks -> remote approvals (PLAN-notifications-mobiles N2.a).
//
// Turns a session's blocking prompts into approvals the operator can settle
// from a phone. Deterministic: no PTY scraping, the payload is structured JSON
// straight from Claude Code.
//
// IT DOES NOT BLOCK. The hook posts the approval and exits immediately. There
// is nothing to gain from holding the process open: Claude Code is ALREADY
// waiting on its own dialog, and it keeps waiting until someone answers. The
// answer is then applied by the Deck, which types it into the tile. Not
// blocking removes a per-prompt hook process lingering for minutes, and with
// it the whole question of how long a hook may legally block.
//
// WHICH EVENTS, AND WHY THOSE:
//   PermissionRequest -> the tool-permission dialog. It fires only when a
//     dialog actually appears, which is exactly our trigger. (PreToolUse fires
//     on EVERY tool call, so wiring it here would raise an approval per tool
//     use.) It carries a structured payload — tool, input, cwd — which is why
//     it beats scraping the screen.
//   Notification      -> `idle_prompt` / `agent_needs_input`: the open
//     questions no hook can settle (there is no documented hook for
//     AskUserQuestion or plan approval). `permission_prompt` is skipped here
//     because PermissionRequest already owns it — otherwise one dialog would
//     raise two notifications.
//
// SECURITY: the hook carries a RESTRICTED session credential (PLAN §6.8), read
// from a chmod-600 file whose path arrives in the environment — the key itself
// never touches argv or /proc/<pid>/environ. That credential may only `add`
// for THIS window; it can never settle an approval. Only the Deck, holding the
// operator key, can do that.
//
// FAIL-SILENT: any failure (no credential, broker down, malformed payload)
// exits 0 having done nothing. The session is unaffected — it simply waits on
// its dialog as it would without this feature.

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
    // permission_prompt is PermissionRequest's job; the rest are open questions.
    return t === "idle_prompt" || t === "agent_needs_input" ? "question" : "skip";
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
