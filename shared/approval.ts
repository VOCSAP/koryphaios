// Two credential classes, deliberately asymmetric: the operator key (held only
// by the Deck) is the only credential that may claim/settle an approval; a
// session token (handed to the spawned agent, including inside a sandbox) may
// only add for its own session_ref and wait on what it created, never claim.
// A compromised sandboxed agent holding a session token can at worst spam its
// own operator; holding the operator key it could settle other sessions'
// approvals, a clean authority escape.
// Node builtins only -- the same file runs under the broker, the MCP server,
// and a bun-spawned hook.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { capVisibly, stripControl } from "./text.ts";
import type {
  Approval,
  ApprovalAddResponse,
  ApprovalAnswerKind,
  ApprovalAnswers,
  ApprovalAuthKind,
  ApprovalAuthProof,
  ApprovalKind,
  ApprovalMerge,
  ApprovalOrigin,
  ApprovalQuestion,
  ApprovalReplyRoute,
  ApprovalStatus,
  ApprovalVia,
} from "./types.ts";

export type {
  Approval,
  ApprovalAddResponse,
  ApprovalAnswerKind,
  ApprovalAuthKind,
  ApprovalAuthProof,
  ApprovalKind,
  ApprovalMerge,
  ApprovalOrigin,
  ApprovalReplyRoute,
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
export const APPROVAL_QUESTIONS_MAX = 4;
export const APPROVAL_HEADER_MAX = 64;
export const APPROVAL_OPTION_DESCRIPTION_MAX = 500;
/** One Other answer: it reaches the model as is. */
export const APPROVAL_FREE_TEXT_MAX = 1000;

/** Replay window for an auth proof, either side of the broker's clock. */
export const APPROVAL_AUTH_SKEW_SEC = 120;

/** Hard ceiling of a single /approval/wait long poll. */
export const APPROVAL_WAIT_MAX_SEC = 300;

/** Ceiling on a 'hook' row: a longer park would keep a dead CLI's row looking alive. */
export const HOOK_WAIT_MAX_SEC = 30;

/** The long-poll duration /approval/wait uses: 30 when absent or not a finite number, clamped to [1, ceiling of the route]. */
export function approvalWaitTimeoutSec(requested: unknown, replyRoute: string): number {
  const ceiling = replyRoute === "hook" ? HOOK_WAIT_MAX_SEC : APPROVAL_WAIT_MAX_SEC;
  const asked = typeof requested === "number" && Number.isFinite(requested) ? requested : 30;
  return Math.max(1, Math.min(ceiling, asked));
}

export const APPROVAL_KINDS: readonly ApprovalKind[] = ["permission", "question", "plan"];
export const APPROVAL_ANSWER_KINDS: readonly ApprovalAnswerKind[] = ["allow", "deny", "text", "answers"];
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
export type ApprovalOperation =
  | "add"
  | "wait"
  // A session closing its own guarded row without a verdict: it settles
  // nothing and authorises nothing, so it stays on the session side.
  | "withdraw"
  | "claim"
  | "list"
  | "channels"
  | "mint-token"
  // Card 39c40571 layer 2: a roadmap write claiming the reserved 'deck' author
  // is an OPERATOR gesture. It is listed here (rather than getting its own
  // verifier beside this one) so it inherits the signature check, the nonce
  // replay guard and this very table, and so that leaving it out of
  // SESSION_ALLOWED below is what refuses a sandboxed agent's session token.
  | "roadmap-write";

/**
 * A session credential may only ASK. Every operation absent from this set is
 * operator-only, which is the point: `claim` authorises a tool call and
 * `roadmap-write` speaks as the operator on a shared backlog, so a sandboxed
 * agent holding a session token must reach neither (PLAN §6.8).
 */
const SESSION_ALLOWED: ReadonlySet<ApprovalOperation> = new Set<ApprovalOperation>(["add", "wait", "withdraw"]);

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
  /**
   * Required, not optional: every in-repo producer must state its species
   * (chantier 3189b002+874e9053) so an omission is a TYPECHECK failure at
   * its own call site, not a silent default chosen here. The WIRE body may
   * still omit it (see validateApprovalDraft), for a hook build predating
   * this field.
   */
  merge: ApprovalMerge;
  /** AskUserQuestion questions, null when the body carries none. */
  questions: ApprovalQuestion[] | null;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every control, format and line/paragraph separator character (C0/C1, zero
 * width, bidi, soft hyphen, tags, BOM...): text that shows nothing, or
 * reorders what is shown, to the operator who answers or the model that reads
 * the answer. Matched by Unicode category so the whole family goes, not a
 * list of ranges. Tab, CR and LF are left to stripControl, which decides per
 * field whether a line break survives. Applied only to AskUserQuestion text:
 * stripControl has other consumers.
 */
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const KEPT_FOR_STRIP_CONTROL = new Set(["\t", "\r", "\n"]);

/** Cut on a code point, never between the two halves of a surrogate pair. */
function cutCodePoints(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join("");
}

function cleanQuestionText(s: string, keepNewlines: boolean): string {
  return stripControl(
    s.replace(INVISIBLE_CHARS, (c) => (KEPT_FOR_STRIP_CONTROL.has(c) ? c : "")),
    { keepNewlines }
  ).trim();
}

/**
 * Questions come from an agent (hostile input #4) and their text reaches the
 * operator, so every string is stripped and capped. Anything that would make
 * an answer ambiguous (two questions with one text, two options with one
 * label) is refused rather than normalised away.
 */
function validateQuestions(raw: unknown): ValidationResult<ApprovalQuestion[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "questions must be an array" };
  if (raw.length === 0) return { ok: false, error: "questions needs at least one question" };
  if (raw.length > APPROVAL_QUESTIONS_MAX) return { ok: false, error: `at most ${APPROVAL_QUESTIONS_MAX} questions` };
  const seen = new Set<string>();
  const out: ApprovalQuestion[] = [];
  for (const [i, q] of raw.entries()) {
    if (!isPlainObject(q)) return { ok: false, error: `question ${i + 1} must be an object` };
    const question = cutCodePoints(cleanQuestionText(str(q.question), true), APPROVAL_QUESTION_MAX);
    if (!question) return { ok: false, error: `question ${i + 1} needs a question text` };
    if (seen.has(question)) return { ok: false, error: `the question "${cutCodePoints(question, 80)}" appears twice` };
    seen.add(question);
    if (q.header !== undefined && typeof q.header !== "string") {
      return { ok: false, error: `question ${i + 1}: header must be a string` };
    }
    const header = cutCodePoints(cleanQuestionText(str(q.header), false), APPROVAL_HEADER_MAX);
    if (q.multi_select !== undefined && typeof q.multi_select !== "boolean") {
      return { ok: false, error: `question ${i + 1}: multi_select must be a boolean` };
    }
    if (!Array.isArray(q.options) || q.options.length === 0) {
      return { ok: false, error: `question ${i + 1} needs at least one option` };
    }
    if (q.options.length > APPROVAL_OPTIONS_MAX) {
      return { ok: false, error: `question ${i + 1}: at most ${APPROVAL_OPTIONS_MAX} options` };
    }
    const labels = new Set<string>();
    const options: ApprovalQuestion["options"] = [];
    for (const o of q.options) {
      if (!isPlainObject(o)) return { ok: false, error: `question ${i + 1}: each option must be an object` };
      if (typeof o.label !== "string") return { ok: false, error: `question ${i + 1}: an option label must be a string` };
      const label = cutCodePoints(cleanQuestionText(o.label, false), APPROVAL_OPTION_MAX);
      if (!label) return { ok: false, error: `question ${i + 1}: an option label is empty` };
      if (labels.has(label)) return { ok: false, error: `question ${i + 1}: the label "${label}" appears twice` };
      labels.add(label);
      if (o.description !== undefined && typeof o.description !== "string") {
        return { ok: false, error: `question ${i + 1}: an option description must be a string` };
      }
      const description = cutCodePoints(cleanQuestionText(str(o.description), false), APPROVAL_OPTION_DESCRIPTION_MAX);
      options.push({ label, description });
    }
    out.push({ question, header, options, multi_select: q.multi_select === true });
  }
  return { ok: true, value: out };
}

/**
 * Validate an `answers` claim against the row's questions. Every question must
 * be answered, by option labels (any number on a multi-select question, one
 * otherwise) and at most one free text, which reaches the model: it is
 * flattened, control-stripped and capped. Labels are returned in the options'
 * display order, the free text last; `summary` is what every reader that only
 * knows `answer_text` shows.
 */
export function validateApprovalAnswers(
  questions: ApprovalQuestion[],
  raw: unknown
): ValidationResult<{ answers: ApprovalAnswers; summary: string }> {
  if (!isPlainObject(raw)) return { ok: false, error: "answers must be an object keyed by question text" };
  const known = new Set(questions.map((q) => q.question));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { ok: false, error: `"${cutCodePoints(key, 80)}" is not one of the questions` };
  }
  // Keyed by agent-chosen text: a question named "__proto__" or "constructor"
  // must be an ordinary key, never a write to or a read from a prototype.
  const answers = Object.create(null) as ApprovalAnswers;
  const lines: string[] = [];
  for (const q of questions) {
    const shown = cutCodePoints(q.question, 80);
    const given = Object.prototype.hasOwnProperty.call(raw, q.question) ? raw[q.question] : undefined;
    if (given === undefined) return { ok: false, error: `"${shown}" is unanswered` };
    if (!Array.isArray(given)) return { ok: false, error: `the answer to "${shown}" must be an array` };
    if (given.length === 0) return { ok: false, error: `the answer to "${shown}" needs at least one value` };
    const chosen = new Set<string>();
    let free: string | null = null;
    for (const value of given) {
      if (typeof value !== "string") return { ok: false, error: "every answer value must be a string" };
      const cleaned = cleanQuestionText(value, false);
      const label = q.options.find((o) => o.label === cleaned)?.label;
      if (label !== undefined) {
        if (chosen.has(label)) return { ok: false, error: `the label "${label}" is chosen twice` };
        chosen.add(label);
        continue;
      }
      if (free !== null) return { ok: false, error: "at most one free text per question" };
      const flat = cleaned.replace(/\s+/g, " ");
      if (!flat) return { ok: false, error: "a free text answer is empty" };
      free = cutCodePoints(flat, APPROVAL_FREE_TEXT_MAX);
    }
    const values = [...q.options.map((o) => o.label).filter((l) => chosen.has(l)), ...(free === null ? [] : [free])];
    if (!q.multi_select && values.length > 1) {
      return { ok: false, error: `"${shown}" takes a single answer` };
    }
    answers[q.question] = values;
    lines.push(`${q.question.replace(/\s+/g, " ")}: ${values.join(", ")}`);
  }
  return { ok: true, value: { answers, summary: cutCodePoints(lines.join("\n"), APPROVAL_ANSWER_MAX) } };
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
  merge?: unknown;
  questions?: unknown;
}): ValidationResult<ApprovalDraft> {
  const kind = str(body.kind) as ApprovalKind;
  if (!APPROVAL_KINDS.includes(kind)) return { ok: false, error: "kind must be permission|question|plan" };

  const title = capVisibly(stripControl(str(body.title)).trim(), APPROVAL_TITLE_MAX);
  if (!title) return { ok: false, error: "title is required" };

  const question = capVisibly(stripControl(str(body.question), { keepNewlines: true }).trim(), APPROVAL_QUESTION_MAX);
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
  // Absent or null normalises to 'tile' -- a build predating this field, which
  // must keep behaving exactly as it does today. A PRESENT but unrecognised
  // value (a typo, a stray "Never") is refused rather than silently folded
  // into 'tile': that fold would let a guarded request merge with whatever
  // else is pending on the tile, the exact defect this field exists to close.
  if (body.merge !== undefined && body.merge !== null && body.merge !== "tile" && body.merge !== "never") {
    return { ok: false, error: "merge must be tile|never" };
  }
  const merge: ApprovalMerge = body.merge === "never" ? "never" : "tile";

  let questions: ApprovalQuestion[] | null = null;
  if (body.questions !== undefined && body.questions !== null) {
    if (kind !== "question") return { ok: false, error: "questions belong to kind question" };
    // A mergeable row is absorbed by the tile's pending row, and its questions
    // with it.
    if (merge !== "never") return { ok: false, error: "questions need merge never" };
    const parsed = validateQuestions(body.questions);
    if (!parsed.ok) return parsed;
    questions = parsed.value;
  }

  return { ok: true, value: { kind, title, question, options, session_ref, tile_ref, merge, questions } };
}

// --- Sanitisers ---

// `stripControl` lives in `shared/text.ts` (a dependency-free leaf, so the
// mobile app can share it without dragging `node:crypto` into a WebView) and
// is re-exported here: every existing caller imports it from this module.
export { capVisibly, stripControl };

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
