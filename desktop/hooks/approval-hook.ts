import { APPROVAL_QUESTION_MAX, buildAuthProof, capVisibly, stripControl } from "../../shared/approval.ts";
import {
  APPROVAL_FILE_ENV,
  APPROVAL_HOOK_BLOCK_SEC_DEFAULT,
  loadApprovalCredential,
  type FileReader,
  type SessionApprovalCredential,
} from "../../shared/approval-client.ts";

import { runApprovalClient } from "./approval-client.ts";
import { verdictOf } from "./approval-verdict.ts";
import { TITLE_DETAIL_MAX, summarizeToolInput } from "./tool-summary.ts";

export { APPROVAL_FILE_ENV, APPROVAL_HOOK_BLOCK_SEC_DEFAULT, TITLE_DETAIL_MAX, summarizeToolInput };

const POST_TIMEOUT_SEC = 15;
export const PERMISSION_BUDGET_MS = 30 * 60_000;
const PERMISSION_WAIT_SEC = 25;
export const WITHDRAW_GRACE_SEC = 20;
const DENY_MESSAGE = "Denied by the operator from Koryphaios";
const DESK_SESSION_ENV = "CLAUDE_PEERS_DESK_SESSION";
const EXCLUDED_PERMISSION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const FORMAT_OR_SEPARATOR = /[\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL = /\p{Cc}/u;
const AGENT_TYPE_TITLE_BUDGET = 80;
const AGENT_TITLE_SEPARATOR = " agent -- ";

export type ApprovalHookConfig = SessionApprovalCredential;

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  agent_type?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  notification_type?: string;
  message?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function trace(message: string, err: unknown): void {
  process.stderr.write(`Kory approval hook: ${message}: ${errorText(err)}\n`);
}

export function parseHookPayload(raw: string): HookPayload {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as HookPayload) : {};
  } catch (err) {
    trace("invalid hook payload", err);
    return {};
  }
}

export function classifyPayload(p: HookPayload): "permission" | "question" | "skip" {
  if (p.hook_event_name === "PermissionRequest") return "permission";
  if (p.hook_event_name === "Notification") {
    const t = p.notification_type ?? "";
    return t === "agent_needs_input" ? "question" : "skip";
  }
  return "skip";
}

function hasUnsafeText(value: string, allowLayout: boolean): boolean {
  for (const character of value) {
    if (FORMAT_OR_SEPARATOR.test(character)) return true;
    if (CONTROL.test(character) && !(allowLayout && (character === "\n" || character === "\t"))) return true;
  }
  return false;
}

// Only tool_input values may span lines: a multiline command is legitimate, a multiline name or path is a forgery.
function hasUnsafeValue(value: unknown): boolean {
  if (typeof value === "string") return hasUnsafeText(value, true);
  if (Array.isArray(value)) return value.some(hasUnsafeValue);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => hasUnsafeText(key, false) || hasUnsafeValue(nested));
}

export function hasUnsafePermissionRepresentation(payload: HookPayload): boolean {
  const { cwd, tool_name: toolName, agent_type: agentType } = payload;
  if (cwd !== undefined && typeof cwd !== "string") return true;
  if (toolName !== undefined && typeof toolName !== "string") return true;
  if (agentType !== undefined && typeof agentType !== "string") return true;
  return (
    hasUnsafeText(cwd ?? "", false) ||
    hasUnsafeText(toolName ?? "", false) ||
    hasUnsafeText(agentType ?? "", false) ||
    hasUnsafeValue(payload.tool_input)
  );
}

export function buildApprovalRequest(
  p: HookPayload,
  cfg: ApprovalHookConfig,
  tileRef = ""
): Record<string, unknown> {
  const blocking = classifyPayload(p) === "permission";
  const toolSummary = blocking ? summarizeToolInput(p.tool_name ?? "", p.tool_input) : "";
  const agentType = blocking ? capVisibly(p.agent_type?.trim() ?? "", AGENT_TYPE_TITLE_BUDGET) : "";
  const title = blocking
    ? agentType
      ? `${agentType}${AGENT_TITLE_SEPARATOR}${capVisibly(
          toolSummary,
          TITLE_DETAIL_MAX - Array.from(agentType).length - Array.from(AGENT_TITLE_SEPARATOR).length
        )}`
      : toolSummary
    : capVisibly(stripControl(p.message ?? "").trim(), 160) || "The agent is waiting for you";
  const question = capVisibly(
    blocking
      ? [
          `The agent wants to use ${stripControl(p.tool_name ?? "a tool").trim() || "a tool"}.`,
          p.tool_input ? `Input: ${safeJson(p.tool_input)}` : "",
          p.cwd ? `Working directory: ${stripControl(p.cwd).trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : stripControl(p.message ?? "", { keepNewlines: true }).trim() ||
          "The session is waiting for an answer.",
    APPROVAL_QUESTION_MAX
  );

  return {
    kind: blocking ? "permission" : "question",
    title,
    question,
    options: blocking ? ["Allow", "Deny"] : [],
    session_ref: cfg.sessionRef,
    // The credential authenticates the window, not this untrusted routing hint.
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
    return stripControl(JSON.stringify(value) ?? "", { keepNewlines: true });
  } catch (err) {
    trace("unserializable tool input", err);
    return "";
  }
}

export function loadConfig(path: string | undefined, read?: FileReader): ApprovalHookConfig | null {
  return loadApprovalCredential(path, read);
}

async function postQuestion(cfg: ApprovalHookConfig, payload: Record<string, unknown>): Promise<void> {
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
    if (!res.ok) trace("question delivery failed", `HTTP ${res.status}`);
  } catch (err) {
    trace("question delivery failed", err);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function writePermissionDecision(behavior: "allow" | "deny"): void {
  const decision = behavior === "deny" ? { behavior, message: DENY_MESSAGE } : { behavior };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
}

export interface ServePermissionOptions {
  budgetMs?: number;
  runClient?: typeof runApprovalClient;
  writeDecision?: typeof writePermissionDecision;
}

export async function servePermission(
  cfg: ApprovalHookConfig,
  payload: Record<string, unknown>,
  tileRef: string,
  options: ServePermissionOptions = {}
): Promise<void> {
  const runClient = options.runClient ?? runApprovalClient;
  let delivered: { id: string; producerSecret: string } | null = null;
  try {
    await servePermissionRows(cfg, payload, tileRef, options, (row) => (delivered = row));
  } catch (err) {
    trace("permission flow failed", err);
    if (!delivered) return;
    const { id, producerSecret } = delivered as { id: string; producerSecret: string };
    try {
      await runClient("withdraw", JSON.stringify({ id, producer_secret: producerSecret }), cfg, tileRef, fetch);
    } catch (withdrawErr) {
      trace("permission withdraw failed", withdrawErr);
    }
  }
}

async function servePermissionRows(
  cfg: ApprovalHookConfig,
  payload: Record<string, unknown>,
  tileRef: string,
  options: ServePermissionOptions,
  onDelivered: (row: { id: string; producerSecret: string }) => void
): Promise<void> {
  const runClient = options.runClient ?? runApprovalClient;
  const writeDecision = options.writeDecision ?? writePermissionDecision;
  const added = await runClient("add", JSON.stringify(payload), cfg, tileRef, fetch);
  if (!added.ok) {
    trace("permission delivery failed", added.error);
    return;
  }
  const id = text(added.id);
  const producerSecret = text(added.producer_secret);
  if (!id || !producerSecret) {
    trace("permission delivery failed", "invalid broker response");
    return;
  }
  onDelivered({ id, producerSecret });

  const budgetMs = options.budgetMs ?? PERMISSION_BUDGET_MS;
  const budget = AbortSignal.timeout(budgetMs);
  const deadline = performance.now() + budgetMs;
  let waitFailure: { error: string; expired: boolean } | null = null;
  while (!budget.aborted && performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    const timeoutSec = Math.max(1, Math.min(PERMISSION_WAIT_SEC, Math.ceil(remainingMs / 1000)));
    const output = await runClient(
      "wait",
      JSON.stringify({ id, producer_secret: producerSecret, timeout_sec: timeoutSec }),
      cfg,
      tileRef,
      fetch,
      budget
    );
    const verdict = verdictOf(id, output);
    if (verdict.kind === "allow") {
      writeDecision("allow");
      return;
    }
    if (verdict.kind === "deny") {
      writeDecision("deny");
      return;
    }
    if (verdict.kind === "none") {
      if (!output.ok) waitFailure = { error: output.error, expired: budget.aborted || performance.now() >= deadline };
      break;
    }
  }

  if (waitFailure) trace(waitFailure.expired ? "permission wait budget expired" : "permission wait failed", waitFailure.error);
  else if (budget.aborted || performance.now() >= deadline) trace("permission wait budget expired", "local approval budget expired");

  const withdrawn = await runClient("withdraw", JSON.stringify({ id, producer_secret: producerSecret }), cfg, tileRef, fetch);
  if (withdrawn.ok) return;
  if (!withdrawn.error.startsWith("HTTP 409:")) {
    trace("permission withdraw failed", withdrawn.error);
    return;
  }

  const late = await runClient(
    "wait",
    JSON.stringify({ id, producer_secret: producerSecret, timeout_sec: WITHDRAW_GRACE_SEC }),
    cfg,
    tileRef,
    fetch
  );
  const verdict = verdictOf(id, late);
  if (verdict.kind === "allow") writeDecision("allow");
  else if (verdict.kind === "deny") writeDecision("deny");
  else if (!late.ok) trace("permission late read failed", late.error);
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env[APPROVAL_FILE_ENV]);
  if (!cfg) return;

  const payload = parseHookPayload(await readStdin());
  const kind = classifyPayload(payload);
  if (kind === "skip") return;
  if (
    kind === "permission" &&
    (EXCLUDED_PERMISSION_TOOLS.has(payload.tool_name ?? "") || hasUnsafePermissionRepresentation(payload))
  ) {
    return;
  }

  const tileRef = (process.env[DESK_SESSION_ENV] ?? "").trim();
  const request = buildApprovalRequest(payload, cfg, tileRef);
  if (kind === "permission") {
    await servePermission(cfg, request, tileRef);
    return;
  }
  await postQuestion(cfg, request);
}

if (import.meta.main) {
  main()
    .catch((err) => trace("hook failed", err))
    .finally(() => process.exit(0));
}
