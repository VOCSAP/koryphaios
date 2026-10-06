// Signing helper for the Claude Code module: the engine has no node:crypto, so
// the module spawns this bun script (`add|wait|withdraw`, request JSON on
// stdin) and never reads the credential itself. One JSON line on stdout,
// `{ ok: true, ... }` or `{ ok: false, error }`, exit 0 either way.

import { buildAuthProof } from "../../shared/approval.ts";
import {
  APPROVAL_FILE_ENV,
  loadApprovalCredential,
  type SessionApprovalCredential,
} from "../../shared/approval-client.ts";

export type ApprovalClientOp = "add" | "wait" | "withdraw";

export type ApprovalClientOutput = { ok: true; [field: string]: unknown } | { ok: false; error: string };

/** With REQUEST_SLACK_MS, one wait ends before the module's 30 s timeout on the helper process. */
export const APPROVAL_WAIT_MAX_SEC = 25;

const REQUEST_SLACK_MS = 2_000;

/** Only these fields of a broker approval reach stdout. */
const APPROVAL_FIELDS = ["id", "status", "reply_route", "answer_kind", "answer_text", "answered_via"] as const;
const DESK_SESSION_ENV = "CLAUDE_PEERS_DESK_SESSION";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface SignedRequest {
  path: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function idOf(request: Record<string, unknown>): string | null {
  const id = text(request.id).trim();
  return id ? id : null;
}

/** The secret add returned for this row; the broker refuses a hook row's wait or withdraw without it. */
function withProducerSecret(payload: Record<string, unknown>, request: Record<string, unknown>): Record<string, unknown> {
  const secret = text(request.producer_secret);
  return secret ? { ...payload, producer_secret: secret } : payload;
}

export function buildSignedRequest(
  op: string,
  request: Record<string, unknown>,
  cfg: SessionApprovalCredential,
  tileRef: string
): SignedRequest | { error: string } {
  if (op === "add") {
    const kind = request.kind === "permission" || request.kind === "question" ? request.kind : null;
    if (!kind) return { error: "add needs kind permission|question" };
    const options = Array.isArray(request.options) ? request.options.filter((o) => typeof o === "string") : [];
    return {
      path: "/approval/add",
      timeoutMs: 10_000,
      payload: {
        kind,
        title: text(request.title),
        question: text(request.question),
        options,
        session_ref: cfg.sessionRef,
        tile_ref: tileRef,
        reply_route: "hook",
        merge: "never",
        origin: {
          host: cfg.origin?.host ?? "",
          os_user_hash: cfg.origin?.os_user_hash ?? "",
          project_key: cfg.origin?.project_key ?? "",
          from_peer: cfg.origin?.from_peer ?? "",
          group_id: "",
        },
        public_key: cfg.publicKey,
      },
    };
  }
  if (op === "wait") {
    const id = idOf(request);
    if (!id) return { error: "wait needs an id" };
    const asked = Number(request.timeout_sec);
    const timeoutSec = Number.isFinite(asked) ? Math.max(1, Math.min(APPROVAL_WAIT_MAX_SEC, Math.floor(asked))) : APPROVAL_WAIT_MAX_SEC;
    return {
      path: "/approval/wait",
      timeoutMs: timeoutSec * 1000 + REQUEST_SLACK_MS,
      payload: withProducerSecret({ id, timeout_sec: timeoutSec, public_key: cfg.publicKey }, request),
    };
  }
  if (op === "withdraw") {
    const id = idOf(request);
    if (!id) return { error: "withdraw needs an id" };
    return {
      path: "/approval/withdraw",
      timeoutMs: 10_000,
      payload: withProducerSecret({ id, public_key: cfg.publicKey }, request),
    };
  }
  return { error: `unknown op: ${op}` };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function projectApproval(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const approval = raw as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of APPROVAL_FIELDS) if (field in approval) projected[field] = approval[field];
  return projected;
}

function shapeResponse(op: string, body: Record<string, unknown>): ApprovalClientOutput {
  const approval = projectApproval(body.approval);
  if (op === "add") {
    const id = text(approval?.id);
    if (!id) return { ok: false, error: "add answered without an id" };
    return {
      ok: true,
      id,
      reply_route: typeof approval?.reply_route === "string" ? approval.reply_route : null,
      producer_secret: text(body.producer_secret) || null,
    };
  }
  if (op === "wait" && body.pending === true) return { ok: true, pending: true };
  if (!approval) return { ok: false, error: `${op} answered without an approval` };
  return { ok: true, approval };
}

async function signAndPost(
  op: string,
  request: unknown,
  cfg: SessionApprovalCredential,
  tileRef: string,
  fetchImpl: Fetch
): Promise<ApprovalClientOutput> {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, error: "request is not an object" };
  }
  const built = buildSignedRequest(op, request as Record<string, unknown>, cfg, tileRef);
  if ("error" in built) return { ok: false, error: built.error };

  const auth = buildAuthProof(cfg.privateKey, built.payload, {
    kind: "session",
    operator_id: cfg.operatorId,
    token_id: cfg.tokenId,
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.brokerToken) headers.authorization = `Bearer ${cfg.brokerToken}`;
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.brokerUrl}${built.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...built.payload, auth }),
      signal: AbortSignal.timeout(built.timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: `broker unreachable: ${errorText(err)}` };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text(body.error) || "no error text"}` };
  return shapeResponse(op, body);
}

export async function runApprovalClient(
  op: string,
  rawRequest: string,
  cfg: SessionApprovalCredential | null,
  tileRef: string,
  fetchImpl: Fetch = fetch
): Promise<ApprovalClientOutput> {
  if (!cfg) return { ok: false, error: "no approval credential" };
  let request: unknown;
  try {
    request = JSON.parse(rawRequest || "{}");
  } catch {
    return { ok: false, error: "request is not JSON" };
  }
  try {
    return await signAndPost(op, request, cfg, tileRef, fetchImpl);
  } catch (err) {
    return { ok: false, error: `helper failed: ${errorText(err)}` };
  }
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main(): Promise<void> {
  let output: ApprovalClientOutput;
  try {
    output = await runApprovalClient(
      process.argv[2] ?? "",
      await readStdin(),
      loadApprovalCredential(process.env[APPROVAL_FILE_ENV]),
      (process.env[DESK_SESSION_ENV] ?? "").trim()
    );
  } catch (err) {
    output = { ok: false, error: `helper failed: ${errorText(err)}` };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.main) {
  void main().finally(() => process.exit(0));
}
