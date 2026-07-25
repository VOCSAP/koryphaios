// Remote approvals (PLAN-notifications-mobiles, lots N0/N1): the shared
// vocabulary of the "answer an agent's blocking question from your phone"
// feature. Used by broker.ts (arbiter), server.ts (ask_operator MCP tool) and
// desktop/hooks/approval-hook.ts (Claude Code hooks).
//
// SECURITY — two credential classes, deliberately asymmetric (PLAN §6.8):
//
//   operator key  -> full scope. Held ONLY by the Deck (app-state, per OS
//                    user). It is the only credential that may `claim`, i.e.
//                    settle an approval and thus authorise a tool call.
//   session token -> restricted scope. Minted by the Deck per session,
//                    handed to the spawned agent (including INSIDE a sandbox
//                    container). May only `add` for its own session_ref and
//                    `wait` on what it created. NEVER `claim`.
//
// The asymmetry is the whole point: a compromised sandboxed agent holding a
// session token can at worst spam its own operator with notifications. If it
// held the operator key it could answer OTHER sessions' approvals — including
// non-sandboxed ones on the host — which would be a clean authority escape.
//
// Node builtins only (node:crypto), no Bun-specific API: the same file runs
// under the broker, the MCP server and a bun-spawned hook.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import type {
  Approval,
  ApprovalAnswerKind,
  ApprovalAuthKind,
  ApprovalAuthProof,
  ApprovalKind,
  ApprovalOrigin,
  ApprovalStatus,
  ApprovalVia,
} from "./types.ts";

export type {
  Approval,
  ApprovalAnswerKind,
  ApprovalAuthKind,
  ApprovalAuthProof,
  ApprovalKind,
  ApprovalOrigin,
  ApprovalStatus,
  ApprovalVia,
};

// --- Limits (validated broker-side, mirrored by producers) ---

export const APPROVAL_TITLE_MAX = 200;
export const APPROVAL_QUESTION_MAX = 4000;
export const APPROVAL_OPTION_MAX = 200;
export const APPROVAL_OPTIONS_MAX = 10;
export const APPROVAL_ANSWER_MAX = 4000;
export const APPROVAL_SESSION_REF_MAX = 128;

/** Replay window for an auth proof, either side of the broker's clock. */
export const APPROVAL_AUTH_SKEW_SEC = 120;

/** Hard ceiling of a single /approval/wait long poll. */
export const APPROVAL_WAIT_MAX_SEC = 300;

export const APPROVAL_KINDS: readonly ApprovalKind[] = ["permission", "question", "plan"];
export const APPROVAL_ANSWER_KINDS: readonly ApprovalAnswerKind[] = ["allow", "deny", "text"];
export const APPROVAL_VIAS: readonly ApprovalVia[] = ["deck", "telegram", "discord", "ntfy"];

// --- Auth proof ---

/**
 * Deterministic serialization used as the HMAC message. Object keys are
 * sorted so two independent implementations (core + the Deck's mirror in
 * desktop/src/main/approval-auth.ts) agree byte for byte.
 *
 * `undefined` members are dropped; everything else is JSON. Cycles are not
 * supported (payloads here are flat request bodies).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

// Domain separation: every derivation below hashes a DIFFERENT namespace, so
// the same key can never yield the same digest in two roles. Without it,
// deriveOperatorId(x) === deriveTokenId(x) and a value that is legitimately a
// session credential in one context would address an operator in another.
const DOMAIN_OPERATOR_ID = "koryphaios/approval/operator-id\0";
const DOMAIN_TOKEN_ID = "koryphaios/approval/session-token-id\0";

function digest(domain: string, material: string): string {
  return createHash("sha256").update(domain, "utf-8").update(material, "utf-8").digest("hex");
}

/**
 * A credential is an Ed25519 keypair, both halves base64 DER.
 *
 * WHY asymmetric rather than a shared secret: the broker only ever stores the
 * PUBLIC half. Reading the broker's SQLite file (it is a plain file on a LAN
 * server) therefore grants no ability to impersonate the operator or a
 * session — which a stored HMAC key or a bearer hash would. Combined with the
 * nonce + timestamp below, this also makes proofs non-replayable, closing
 * backlog item B8 for this endpoint family instead of inheriting it.
 */
export interface ApprovalCredential {
  /** base64 PKCS#8 DER. Secret: app-state (safeStorage) or a chmod-600 file. */
  privateKey: string;
  /** base64 SPKI DER. Safe to store broker-side and to log. */
  publicKey: string;
}

export function generateCredential(): ApprovalCredential {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** operator_id = truncated digest of the PUBLIC key — the public handle. */
export function deriveOperatorId(publicKey: string): string {
  return digest(DOMAIN_OPERATOR_ID, publicKey).slice(0, 16);
}

/** Session credentials are addressed by a short digest of their public key. */
export function deriveTokenId(publicKey: string): string {
  return digest(DOMAIN_TOKEN_ID, publicKey).slice(0, 16);
}

/** Fresh 32-byte secret, base64url — one-shot pairing/enrolment tokens, salts. */
export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

function signedMessage(payload: unknown, nonce: string, ts: number): Buffer {
  return Buffer.from(`${canonicalize(payload)}\n${nonce}\n${ts}`, "utf-8");
}

/**
 * Sign a request body with a credential's private half. The proof is never
 * part of the signed payload (it carries the signature).
 */
export function buildAuthProof(
  privateKey: string,
  payload: unknown,
  opts: { kind: ApprovalAuthKind; operator_id: string; token_id?: string; now?: number }
): ApprovalAuthProof {
  const ts = opts.now ?? Math.floor(Date.now() / 1000);
  const nonce = randomBytes(12).toString("base64url");
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const sig = sign(null, signedMessage(payload, nonce, ts), key).toString("base64");
  const proof: ApprovalAuthProof = { kind: opts.kind, operator_id: opts.operator_id, nonce, ts, sig };
  if (opts.token_id) proof.token_id = opts.token_id;
  return proof;
}

export type AuthVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Verify a proof against the credential's PUBLIC half. Rejects outside
 * APPROVAL_AUTH_SKEW_SEC; the caller owns the nonce-replay cache (the broker
 * keeps a bounded one) — skew alone would still allow a replay inside the
 * window.
 */
export function verifyAuthProof(
  publicKey: string,
  payload: unknown,
  proof: ApprovalAuthProof | undefined,
  opts: { now?: number } = {}
): AuthVerdict {
  if (!proof || typeof proof !== "object") return { ok: false, reason: "missing-proof" };
  if (typeof proof.sig !== "string" || typeof proof.nonce !== "string") {
    return { ok: false, reason: "malformed-proof" };
  }
  if (!Number.isFinite(proof.ts)) return { ok: false, reason: "malformed-proof" };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - proof.ts) > APPROVAL_AUTH_SKEW_SEC) return { ok: false, reason: "stale-proof" };

  // Any malformed key/signature must be a verdict, never a thrown 500.
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    const ok = verify(
      null,
      signedMessage(payload, proof.nonce, proof.ts),
      key,
      Buffer.from(proof.sig, "base64")
    );
    return ok ? { ok: true } : { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "malformed-proof" };
  }
}

// --- Scope: what each credential class may do ---

/**
 * Operations an approval credential can attempt. `claim` is deliberately
 * OPERATOR-ONLY: it is the operation that authorises a tool call, so a
 * sandboxed agent must never reach it (PLAN §6.8).
 */
export type ApprovalOperation = "add" | "wait" | "claim" | "list" | "channels" | "mint-token";

const SESSION_ALLOWED: ReadonlySet<ApprovalOperation> = new Set<ApprovalOperation>(["add", "wait"]);

export function isOperationAllowed(kind: ApprovalAuthKind, op: ApprovalOperation): boolean {
  return kind === "operator" ? true : SESSION_ALLOWED.has(op);
}

// --- Validation ---

export interface ApprovalDraft {
  kind: ApprovalKind;
  title: string;
  question: string;
  options: string[];
  session_ref: string;
  tile_ref: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Validate + normalise an /approval/add payload. Everything here comes from an
 * AGENT (hostile input #4): it is length-capped and control-stripped before it
 * can reach a notification channel or an operator's screen.
 */
export function validateApprovalDraft(body: {
  kind?: unknown;
  title?: unknown;
  question?: unknown;
  options?: unknown;
  session_ref?: unknown;
  tile_ref?: unknown;
}): ValidationResult<ApprovalDraft> {
  const kind = str(body.kind) as ApprovalKind;
  if (!APPROVAL_KINDS.includes(kind)) return { ok: false, error: "kind must be permission|question|plan" };

  const title = stripControl(str(body.title)).trim().slice(0, APPROVAL_TITLE_MAX);
  if (!title) return { ok: false, error: "title is required" };

  const question = stripControl(str(body.question), { keepNewlines: true })
    .trim()
    .slice(0, APPROVAL_QUESTION_MAX);
  if (!question) return { ok: false, error: "question is required" };

  const rawOptions = Array.isArray(body.options) ? body.options : [];
  if (rawOptions.length > APPROVAL_OPTIONS_MAX) {
    return { ok: false, error: `at most ${APPROVAL_OPTIONS_MAX} options` };
  }
  const options = rawOptions
    .map((o) => stripControl(str(o)).trim().slice(0, APPROVAL_OPTION_MAX))
    .filter((o) => o.length > 0);

  const session_ref = stripControl(str(body.session_ref)).trim().slice(0, APPROVAL_SESSION_REF_MAX);
  const tile_ref = stripControl(str(body.tile_ref)).trim().slice(0, APPROVAL_SESSION_REF_MAX);

  return { ok: true, value: { kind, title, question, options, session_ref, tile_ref } };
}

// --- Sanitisers ---

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Drop ANSI sequences and C0/DEL controls. Newlines optionally survive. */
export function stripControl(s: string, opts: { keepNewlines?: boolean } = {}): string {
  const noAnsi = s.replace(ANSI_RE, "");
  const cleaned = noAnsi.replace(CTRL_RE, "");
  return opts.keepNewlines ? cleaned.replace(/\r\n?/g, "\n") : cleaned.replace(/[\r\n]+/g, " ");
}

/**
 * Make a REMOTE answer safe to type into a PTY (hostile input, PLAN §6.3).
 *
 * The danger is submission, not display: a stray CR/LF inside the answer would
 * validate the dialog early and turn the remainder into a SECOND command. So
 * every line break collapses to a space, controls and ANSI go, whitespace is
 * squeezed and the result is length-capped. The caller appends exactly one
 * Enter — the text itself must never be able to.
 */
export function sanitizeAnswerForPty(raw: string): ValidationResult<string> {
  const flat = stripControl(String(raw ?? ""), { keepNewlines: false })
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return { ok: false, error: "empty answer" };
  return { ok: true, value: flat.slice(0, APPROVAL_ANSWER_MAX) };
}

/**
 * Human label of an approval's origin, used as the notification prefix so a
 * multi-PC operator can tell two concurrent requests apart.
 */
export function formatOrigin(origin: Pick<ApprovalOrigin, "host" | "project_key">): string {
  const project = origin.project_key.split(/[/\\:]/).filter(Boolean).pop() ?? "";
  const host = stripControl(origin.host).trim() || "?";
  return project ? `${host} · ${project}` : host;
}
