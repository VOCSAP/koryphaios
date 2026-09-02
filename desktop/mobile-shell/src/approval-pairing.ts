// One pairing, not a list: it belongs to the operator, not a machine, so every
// Deck of that operator reaches this phone through it, including ones the phone
// has never met.
// Deliberately independent of companion mode: must work with no Deck reachable,
// and its payload is a relay credential — not a session credential — that
// survives app restarts by design.

import {
  decodePairingPayload,
  encodeAnswer,
  encodePair,
  type NtfyPairingPayload,
} from "../../../notify/ntfy-protocol.ts";
import { readJson, writeJson, type KeyValueStore } from "./storage.ts";

/** Approvals live under their own key: forgetting Decks must not touch this. */
export const APPROVAL_KEY = "koryphaios.approvals.pairing";

export interface ApprovalPairing {
  server: string;
  topic_notif: string;
  topic_replies: string;
  token: string;
  /** Label this device announces when pairing, so the Deck can name it. */
  device: string;
  pairedAt: number;
  /** False until the broker has acknowledged: the code is still unused. */
  confirmed: boolean;
  /** Kept only until confirmation — it is a one-shot code, not a secret. */
  code: string;
}

export function loadPairing(store: KeyValueStore): ApprovalPairing | null {
  const p = readJson<ApprovalPairing | null>(store, APPROVAL_KEY, null);
  if (!p || typeof p !== "object") return null;
  if (typeof p.server !== "string" || typeof p.topic_notif !== "string") return null;
  if (!p.server || !p.topic_notif || !p.topic_replies) return null;
  return p;
}

/**
 * Adopt a scanned approvals QR.
 *
 * Returns null when the payload is not ours — which is the case for a
 * COMPANION QR, and that non-overlap is the point: the two QRs are different
 * shapes (a URL versus a JSON envelope carrying `mode: "approvals"`), so
 * scanning one in the wrong screen fails cleanly instead of half-pairing.
 */
export function adoptPairing(
  store: KeyValueStore,
  raw: string,
  now: number,
  device: string
): ApprovalPairing | null {
  const payload: NtfyPairingPayload | null = decodePairingPayload(raw);
  if (!payload) return null;
  const pairing: ApprovalPairing = {
    server: payload.server,
    topic_notif: payload.topic_notif,
    topic_replies: payload.topic_replies,
    token: payload.token,
    device: String(device ?? "").slice(0, 64),
    pairedAt: now,
    confirmed: false,
    code: payload.code,
  };
  writeJson(store, APPROVAL_KEY, pairing);
  return pairing;
}

/** Mark the pairing acknowledged and drop the now-spent code. */
export function confirmPairing(store: KeyValueStore): ApprovalPairing | null {
  const pairing = loadPairing(store);
  if (!pairing) return null;
  pairing.confirmed = true;
  pairing.code = "";
  writeJson(store, APPROVAL_KEY, pairing);
  return pairing;
}

/**
 * Unpair. Local only: it stops this phone from listening, it does not tell the
 * broker. Revoking server-side is `Disconnect` in the Deck, which mints new
 * topics — the actual kill switch.
 */
export function forgetPairing(store: KeyValueStore): void {
  store.remove(APPROVAL_KEY);
}

/** The `Authorization` header for this pairing, or nothing when anonymous. */
export function authHeaders(pairing: ApprovalPairing): Record<string, string> {
  return pairing.token ? { Authorization: `Bearer ${pairing.token}` } : {};
}

/** Where the app subscribes (its inbound leg) — an OUTGOING GET, held open. */
export function subscribeUrl(pairing: ApprovalPairing, since = ""): string {
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  return `${pairing.server}/${pairing.topic_notif}/json${q}`;
}

/** Where the app publishes answers (its outbound leg). */
export function repliesUrl(pairing: ApprovalPairing): string {
  return `${pairing.server}/${pairing.topic_replies}`;
}

/** The pairing handshake body: the code the Deck showed, plus a device name. */
export function pairingBody(pairing: ApprovalPairing): string {
  return encodePair(pairing.code, pairing.device);
}

/** An answer body. The broker re-sanitises the text before it reaches a PTY. */
export function answerBody(
  pairing: ApprovalPairing,
  approvalId: string,
  kind: "allow" | "deny" | "text",
  text = ""
): string {
  return encodeAnswer(approvalId, kind, text, pairing.device);
}
