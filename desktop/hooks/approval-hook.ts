// Claude Code hooks -> remote approvals (PLAN-notifications-mobiles N2.a).
//
// Turns a session's blocking prompts into approvals the operator can settle
// from a phone. Deterministic: no PTY scraping, the payload is structured JSON
// straight from Claude Code.
//
// WHICH EVENTS, AND WHY THOSE:
//   PermissionRequest -> BLOCKING. It fires only when a permission dialog
//     actually appears, which is exactly our trigger. (PreToolUse fires on
//     EVERY tool call, so wiring it here would raise an approval per tool use.)
//   Notification      -> SIGNAL ONLY, for `idle_prompt` / `agent_needs_input`:
//     the open questions no hook can settle (there is no documented hook for
//     AskUserQuestion or plan approval). `permission_prompt` is skipped here
//     because PermissionRequest already owns it — otherwise one dialog would
//     raise two notifications.
//
// SECURITY: the hook carries a RESTRICTED session credential (PLAN §6.8), read
// from a chmod-600 file whose path arrives in the environment — the key itself
// never touches argv or /proc/<pid>/environ. That credential may only `add` and
// `wait` for THIS session; it can never settle an approval. Only the Deck,
// holding the operator key, can do that.
//
// FAIL-CLOSED: any failure (no credential, broker down, timeout, malformed
// payload) exits 0 with NO decision, so Claude Code falls back to its own
// dialog. The hook can withhold an answer; it must never invent `allow`.

import { buildAuthProof, stripControl, type ApprovalAnswerKind } from "../../shared/approval.ts";
import {
  APPROVAL_FILE_ENV,
  APPROVAL_HOOK_BLOCK_SEC_DEFAULT,
  loadApprovalCredential,
  type FileReader,
  type SessionApprovalCredential,
} from "../../shared/approval-client.ts";

export { APPROVAL_FILE_ENV, APPROVAL_HOOK_BLOCK_SEC_DEFAULT };

/** One long-poll leg; the hook loops until its total budget is spent. */
const WAIT_LEG_SEC = 30;

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
 * Which approvals this payload deserves.
 * `skip` keeps one dialog from raising two notifications.
 */
export function classifyPayload(p: HookPayload): "blocking" | "signal" | "skip" {
  if (p.hook_event_name === "PermissionRequest") return "blocking";
  if (p.hook_event_name === "Notification") {
    const t = p.notification_type ?? "";
    // permission_prompt is PermissionRequest's job; the rest are open questions
    // that only a human (or the Deck's PTY injection) can answer.
    return t === "idle_prompt" || t === "agent_needs_input" ? "signal" : "skip";
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
  cfg: ApprovalHookConfig
): Record<string, unknown> {
  const blocking = classifyPayload(p) === "blocking";
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

export interface Verdict {
  answer_kind: ApprovalAnswerKind;
  answer_text: string | null;
}

/**
 * Translate a settled approval into the hook's stdout contract.
 *
 * `text` maps to deny + additionalContext: PermissionRequest's decision object
 * carries no reason field, so the operator's free-form instruction rides on
 * `additionalContext` (shown to Claude) instead of being dropped. A refusal
 * that silently loses the operator's words would be worse than useless.
 */
export function buildDecisionOutput(verdict: Verdict | null): Record<string, unknown> | null {
  if (!verdict) return null; // no answer -> no decision -> native dialog stands
  if (verdict.answer_kind === "allow") {
    return {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    };
  }
  const out: Record<string, unknown> = {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } },
  };
  if (verdict.answer_text) {
    out.additionalContext = `The operator answered from their phone: ${verdict.answer_text}`;
    out.systemMessage = `Answered remotely: ${verdict.answer_text}`;
  }
  return out;
}

/** Read + shape the credential file. Returns null when the feature is off. */
export function loadConfig(path: string | undefined, read?: FileReader): ApprovalHookConfig | null {
  return loadApprovalCredential(path, read);
}

// --- I/O ---

async function signedPost<T>(
  cfg: ApprovalHookConfig,
  path: string,
  payload: Record<string, unknown>
): Promise<T | null> {
  const auth = buildAuthProof(cfg.privateKey, payload, {
    kind: "session",
    operator_id: cfg.operatorId,
    token_id: cfg.tokenId,
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.brokerToken) headers.authorization = `Bearer ${cfg.brokerToken}`;
  try {
    const res = await fetch(`${cfg.brokerUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payload, auth }),
      signal: AbortSignal.timeout((WAIT_LEG_SEC + 15) * 1000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // Broker unreachable: fail closed (no decision), never fail open.
    return null;
  }
}

/** Long-poll until the approval is settled or the budget is spent. */
async function awaitVerdict(cfg: ApprovalHookConfig, id: string): Promise<Verdict | null> {
  const deadline = Date.now() + (cfg.blockSec ?? APPROVAL_HOOK_BLOCK_SEC_DEFAULT) * 1000;
  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const res = await signedPost<{
      approval?: { status: string; answer_kind: ApprovalAnswerKind | null; answer_text: string | null };
      pending?: boolean;
    }>(cfg, "/approval/wait", {
      id,
      timeout_sec: Math.min(WAIT_LEG_SEC, remaining),
      public_key: cfg.publicKey,
    });
    if (!res) return null; // broker gone -> hand back to the native dialog
    if (res.approval && res.approval.status === "answered" && res.approval.answer_kind) {
      return { answer_kind: res.approval.answer_kind, answer_text: res.approval.answer_text };
    }
    if (res.approval && res.approval.status !== "pending") return null; // expired/abandoned
  }
  return null;
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
  const mode = classifyPayload(payload);
  if (mode === "skip") return;

  const created = await signedPost<{ approval: { id: string } }>(
    cfg,
    "/approval/add",
    buildApprovalRequest(payload, cfg)
  );
  if (!created?.approval?.id) return;

  // A signal-only event has no return path through the hook: the Deck applies
  // the answer by typing into the PTY once someone settles it.
  if (mode === "signal") return;

  const verdict = await awaitVerdict(cfg, created.approval.id);
  const out = buildDecisionOutput(verdict);
  if (out) process.stdout.write(JSON.stringify(out));
}

// Only run when executed directly, so tests can import the pure helpers.
if (import.meta.main) {
  void main().finally(() => process.exit(0));
}
