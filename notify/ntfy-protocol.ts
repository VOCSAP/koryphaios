// The wire format of the ntfy channel (PLAN N5).
//
// Pure module — no I/O — because everything here crosses a trust boundary and
// must be unit-tested without a network:
//
//  - what the broker PUBLISHES on the notification topic (read by our Android
//    app, and legibly by the official ntfy app as a fallback);
//  - what the phone PUBLISHES BACK on the replies topic, which is the hostile
//    direction: anyone able to write to that topic reaches `decodeInbound`.
//
// TWO TOPICS, ONE DIRECTION EACH. ntfy has no request/response: a topic is a
// broadcast bus. The broker publishes to `topic_notif` and holds an OUTGOING
// subscription on `topic_replies`; the phone does the mirror image. Neither
// side ever listens on a port (EXPLORATION §4.3c).
//
// NO EDITING. Unlike Telegram and Discord, ntfy cannot rewrite a published
// message. `settle` therefore publishes a CLOSING message carrying the same
// approval id, and the app cancels the pending notification itself.

import { stripControl } from "../shared/approval.ts";
import type { Approval } from "../shared/types.ts";
import { truncate } from "./format.ts";

/** Envelope version. Bumped only on a breaking change; the app checks it. */
export const NTFY_PROTOCOL_VERSION = 1;

/** ntfy caps a message at 4096 bytes; we stay well under with room for JSON. */
export const NTFY_TITLE_MAX = 200;
export const NTFY_MESSAGE_MAX = 1800;
/** A free-text answer is re-capped broker-side by `sanitizeAnswerForPty`. */
export const NTFY_ANSWER_MAX = 2000;
/** Device labels are display-only; keep them short and boring. */
export const NTFY_LABEL_MAX = 64;
/** ntfy allows at most three action buttons per message. */
export const NTFY_ACTIONS_MAX = 3;

/** Topics are secrets, not names: 24 random bytes rendered as 48 hex chars. */
export const NTFY_TOPIC_HEX_LEN = 48;
const TOPIC_RE = /^[a-z0-9_-]{16,64}$/;

/** Deep link the notification opens. Also how the app recovers the approval. */
export const NTFY_CLICK_SCHEME = "koryphaios";

// ---------------------------------------------------------------------------
// Server URL
// ---------------------------------------------------------------------------

/**
 * Normalise and vet an ntfy base URL.
 *
 * Plain HTTP is accepted ONLY on a private address: a self-hosted ntfy on the
 * LAN is a legitimate setup, but sending an approval question in the clear
 * across the internet is not — and the operator cannot see the difference from
 * the settings field.
 */
export function normalizeNtfyServer(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const text = stripControl(String(raw ?? "")).trim();
  if (!text) return { ok: false, error: "server is required" };
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return { ok: false, error: "server is not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "server must be http(s)" };
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    return { ok: false, error: "plain http is only allowed for a server on your local network" };
  }
  if (url.search || url.hash) return { ok: false, error: "server must not carry a query or fragment" };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, value: `${url.protocol}//${url.host}${path}` };
}

/** RFC1918 / loopback / ULA / link-local, the same family the companion trusts. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || h === "::1") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}

export function isValidTopic(topic: string): boolean {
  return TOPIC_RE.test(String(topic ?? ""));
}

// ---------------------------------------------------------------------------
// Pairing payload (Deck screen -> QR -> phone)
// ---------------------------------------------------------------------------

/**
 * What the QR shown in `Settings > Notifications` contains.
 *
 * It is a CREDENTIAL, not a link: the two topics are unguessable names and the
 * token is the ntfy access token. Whoever reads it can both see the questions
 * and answer them, which is why the Deck only renders it on demand and why the
 * IPC channel that produces it is blocked for remote clients.
 */
export interface NtfyPairingPayload {
  v: number;
  /** Distinguishes this QR from the companion one, which is a plain URL. */
  mode: "approvals";
  server: string;
  topic_notif: string;
  topic_replies: string;
  /** ntfy access token (`tk_…`); empty when the server allows anonymous use. */
  token: string;
  /** One-shot pairing code, consumed by the broker on first use. */
  code: string;
}

export function encodePairingPayload(p: Omit<NtfyPairingPayload, "v" | "mode">): string {
  return JSON.stringify({ v: NTFY_PROTOCOL_VERSION, mode: "approvals", ...p } satisfies NtfyPairingPayload);
}

/** Parse a scanned QR. Returns null for anything that is not our payload. */
export function decodePairingPayload(raw: string): NtfyPairingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw ?? ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== NTFY_PROTOCOL_VERSION || p.mode !== "approvals") return null;
  const server = typeof p.server === "string" ? normalizeNtfyServer(p.server) : null;
  if (!server || !server.ok) return null;
  const notif = String(p.topic_notif ?? "");
  const replies = String(p.topic_replies ?? "");
  const code = String(p.code ?? "");
  if (!isValidTopic(notif) || !isValidTopic(replies) || notif === replies) return null;
  if (!code || code.length > 64) return null;
  const token = typeof p.token === "string" ? p.token.slice(0, 256) : "";
  return {
    v: NTFY_PROTOCOL_VERSION,
    mode: "approvals",
    server: server.value,
    topic_notif: notif,
    topic_replies: replies,
    token,
    code,
  };
}

// ---------------------------------------------------------------------------
// Inbound: what the phone publishes on the replies topic
// ---------------------------------------------------------------------------

export type NtfyInbound =
  | { t: "pair"; code: string; device: string }
  | { t: "answer"; approvalId: string; kind: "allow" | "deny" | "text"; text: string; device: string };

/** A tap on an ntfy action button, or our app answering. */
export function encodeAnswer(
  approvalId: string,
  kind: "allow" | "deny" | "text",
  text = "",
  device = ""
): string {
  return JSON.stringify({
    v: NTFY_PROTOCOL_VERSION,
    t: "answer",
    a: approvalId,
    k: kind,
    ...(text ? { x: truncate(text, NTFY_ANSWER_MAX) } : {}),
    ...(device ? { d: truncate(device, NTFY_LABEL_MAX) } : {}),
  });
}

export function encodePair(code: string, device = ""): string {
  return JSON.stringify({
    v: NTFY_PROTOCOL_VERSION,
    t: "pair",
    c: String(code).slice(0, 64),
    ...(device ? { d: truncate(device, NTFY_LABEL_MAX) } : {}),
  });
}

/**
 * Decode a message read off the replies topic.
 *
 * HOSTILE: a topic is a bus, so this parses bytes from whoever can publish to
 * it. It therefore validates rather than trusts — unknown version, unknown
 * type, missing id and oversize fields all return null, and nothing here ever
 * decides that an answer is legitimate. That is the broker's job (C-1): this
 * only turns bytes into a shape `onAnswer` can be called with.
 */
export function decodeInbound(raw: string): NtfyInbound | null {
  if (typeof raw !== "string" || raw.length > 8192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== NTFY_PROTOCOL_VERSION) return null;
  const device = typeof p.d === "string" ? truncate(stripControl(p.d), NTFY_LABEL_MAX) : "";

  if (p.t === "pair") {
    const code = typeof p.c === "string" ? p.c.trim() : "";
    if (!code || code.length > 64) return null;
    return { t: "pair", code, device };
  }

  if (p.t === "answer") {
    const approvalId = typeof p.a === "string" ? p.a.trim() : "";
    if (!approvalId || approvalId.length > 64) return null;
    const kind = p.k;
    if (kind !== "allow" && kind !== "deny" && kind !== "text") return null;
    const text = typeof p.x === "string" ? truncate(p.x, NTFY_ANSWER_MAX) : "";
    // A "text" answer with no text is not an answer: refuse it here rather
    // than let an empty string reach the PTY sanitiser as a surprise.
    if (kind === "text" && !text.trim()) return null;
    return { t: "answer", approvalId, kind, text, device };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Outbound: what the broker publishes on the notification topic
// ---------------------------------------------------------------------------

/** An ntfy action button (`http` variant — the only one that posts a body). */
export interface NtfyAction {
  action: "http";
  label: string;
  url: string;
  method: "POST";
  body: string;
  headers?: Record<string, string>;
  /** Dismiss the notification once the request went out. */
  clear: true;
}

/** The JSON body of a `POST /` publish call. */
export interface NtfyPublish {
  topic: string;
  title: string;
  message: string;
  priority: number;
  tags: string[];
  click: string;
  actions?: NtfyAction[];
}

/** Deep link carried by `click`, and how the app recovers the approval id. */
export function approvalClickUrl(approvalId: string): string {
  return `${NTFY_CLICK_SCHEME}://approval/${encodeURIComponent(approvalId)}`;
}

export function settledClickUrl(approvalId: string): string {
  return `${NTFY_CLICK_SCHEME}://settled/${encodeURIComponent(approvalId)}`;
}

/** Inverse of the two builders above, for the app. */
export function parseClickUrl(url: string): { view: "approval" | "settled"; approvalId: string } | null {
  const m = /^koryphaios:\/\/(approval|settled)\/([^/?#]+)$/.exec(String(url ?? ""));
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  if (!id || id.length > 64) return null;
  return { view: m[1] as "approval" | "settled", approvalId: id };
}

/**
 * Human body of a pending request.
 *
 * HOSTILE INPUT #4: title and question come from an AGENT. ntfy renders plain
 * text (we never set `markdown: true`), so there is no markup to escape — the
 * risk is control characters and length, both handled here. Newlines survive
 * in the body because an Android notification renders them.
 */
export function renderNtfy(approval: Approval, originText: string): { title: string; message: string } {
  const title = truncate(stripControl(approval.title) || "Koryphaios", NTFY_TITLE_MAX);
  const body = truncate(stripControl(approval.question, { keepNewlines: true }).trim(), NTFY_MESSAGE_MAX);
  return { title: `${stripControl(originText)} · ${title}`.slice(0, NTFY_TITLE_MAX), message: body };
}

export interface BuildPublishDeps {
  topicNotif: string;
  topicReplies: string;
  server: string;
  /** ntfy access token, embedded in the action headers when present. */
  token: string;
}

/**
 * Build the publish body for a pending approval.
 *
 * ACTION BUTTONS carry the Authorization header when a token is configured.
 * That looks like leaking a write credential into a readable message, and it
 * is worth being explicit about why it is not a widening: the same token reads
 * the notification topic, and reading the notification topic already discloses
 * the approval ids needed to answer. Read access to these topics IS answer
 * access — which is exactly why the topics are random secrets and why the
 * pairing QR is treated as a credential. Documented in
 * `desktop/docs/notifications.md`.
 *
 * Free text never travels through a button: ntfy actions carry a FIXED body,
 * so the compose UI lives in our app (EXPLORATION §4.3c).
 */
export function buildApprovalPublish(
  approval: Approval,
  originText: string,
  deps: BuildPublishDeps
): NtfyPublish {
  const { title, message } = renderNtfy(approval, originText);
  const repliesUrl = `${deps.server}/${deps.topicReplies}`;
  const headers = deps.token ? { Authorization: `Bearer ${deps.token}` } : undefined;
  const button = (label: string, kind: "allow" | "deny"): NtfyAction => ({
    action: "http",
    label,
    url: repliesUrl,
    method: "POST",
    body: encodeAnswer(approval.id, kind),
    ...(headers ? { headers } : {}),
    clear: true,
  });
  const actions: NtfyAction[] =
    approval.kind === "permission" ? [button("Approve", "allow"), button("Reject", "deny")] : [];
  return {
    topic: deps.topicNotif,
    title,
    message,
    // 4 = high: a blocked session is the definition of time-sensitive, and the
    // operator opted in to being interrupted by enabling the channel.
    priority: 4,
    tags: approval.kind === "permission" ? ["lock"] : ["question"],
    click: approvalClickUrl(approval.id),
    ...(actions.length ? { actions: actions.slice(0, NTFY_ACTIONS_MAX) } : {}),
  };
}

/**
 * Build the CLOSING message of an approval settled elsewhere.
 *
 * ntfy cannot edit, so this is a second message rather than a rewrite. Minimum
 * priority on purpose: its job is to let the app cancel the pending
 * notification, not to buzz the operator a second time about something already
 * handled.
 */
export function buildSettledPublish(
  approvalId: string,
  text: string,
  deps: Pick<BuildPublishDeps, "topicNotif">
): NtfyPublish {
  return {
    topic: deps.topicNotif,
    title: "Handled",
    message: truncate(stripControl(text), NTFY_MESSAGE_MAX),
    priority: 1,
    tags: ["white_check_mark"],
    click: settledClickUrl(approvalId),
  };
}
