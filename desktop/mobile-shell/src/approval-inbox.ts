// Pure reducers over ntfy events, so the whole decision logic is testable
// without the Android build.
// Told apart by their click deep link: parastates://approval/<id> adds to the
// list, parastates://settled/<id> drops it and cancels the Android
// notification, parastates://paired/<0|1> is the broker's pairing-handshake
// reply.
// ntfy cannot edit a delivered message (unlike Telegram/Discord), so a settled
// message plus this reducer is what makes an already-answered question stop
// looking actionable on the phone.

import { parseClickUrl } from "../../../notify/ntfy-protocol.ts";
import { readJson, writeJson, type KeyValueStore } from "./storage.ts";

export const INBOX_KEY = "koryphaios.approvals.inbox";

/** Beyond this the list is noise; the oldest fall off. */
export const MAX_PENDING = 50;
/** The broker expires a notification after 24 h; match it locally. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingApproval {
  id: string;
  title: string;
  body: string;
  /** True when the request offered Approve/Reject — i.e. a permission. */
  hasButtons: boolean;
  receivedAt: number;
}

/** One message as ntfy's stream and its push payload both shape it. */
export interface NtfyMessage {
  id?: string;
  event?: string;
  title?: string;
  message?: string;
  click?: string;
  actions?: unknown[];
  time?: number;
}

export type InboxEffect =
  | { kind: "add"; approval: PendingApproval }
  | { kind: "settle"; id: string; text: string }
  /** The broker acknowledged (or refused) this device's pairing. */
  | { kind: "paired"; ok: boolean; text: string }
  | { kind: "ignore" };

/**
 * Classify one received message.
 *
 * HOSTILE: whoever can publish on the notification topic reaches this. It
 * therefore reads only what it recognises — a well-formed `parastates://` deep
 * link — and never trusts the title or body for anything but display.
 */
export function classify(msg: NtfyMessage, now: number): InboxEffect {
  if (msg.event && msg.event !== "message") return { kind: "ignore" };
  const click = parseClickUrl(String(msg.click ?? ""));
  if (!click) return { kind: "ignore" };
  if (click.view === "settled") {
    return { kind: "settle", id: click.approvalId, text: String(msg.message ?? "") };
  }
  if (click.view === "paired") {
    return { kind: "paired", ok: click.approvalId === "1", text: String(msg.message ?? "") };
  }
  return {
    kind: "add",
    approval: {
      id: click.approvalId,
      title: String(msg.title ?? "").slice(0, 200),
      body: String(msg.message ?? "").slice(0, 2000),
      hasButtons: Array.isArray(msg.actions) && msg.actions.length > 0,
      receivedAt: now,
    },
  };
}

/**
 * Fold a message into the pending list.
 *
 * Idempotent by approval id: ntfy replays on reconnect and Android can deliver
 * the same push twice, so the same request must never appear as two rows.
 */
export function applyEffect(
  pending: PendingApproval[],
  effect: InboxEffect,
  now: number
): PendingApproval[] {
  if (effect.kind === "ignore" || effect.kind === "paired") return pending;
  if (effect.kind === "settle") return pending.filter((p) => p.id !== effect.id);
  const without = pending.filter((p) => p.id !== effect.approval.id);
  return prune([effect.approval, ...without], now);
}

/** Drop what the broker would already refuse to settle, and cap the list. */
export function prune(pending: PendingApproval[], now: number): PendingApproval[] {
  return pending.filter((p) => now - p.receivedAt < PENDING_TTL_MS).slice(0, MAX_PENDING);
}

export function loadInbox(store: KeyValueStore, now: number): PendingApproval[] {
  const raw = readJson<PendingApproval[]>(store, INBOX_KEY, []);
  if (!Array.isArray(raw)) return [];
  return prune(
    raw.filter((p) => p && typeof p === "object" && typeof p.id === "string" && p.id.length > 0),
    now
  );
}

export function saveInbox(store: KeyValueStore, pending: PendingApproval[]): void {
  writeJson(store, INBOX_KEY, pending);
}

/**
 * Incremental splitter for ntfy's newline-delimited JSON stream.
 *
 * A chunk boundary lands mid-line often enough that "split on \n per chunk"
 * silently loses messages; this keeps the remainder. The buffer is bounded so
 * a peer feeding an endless line cannot grow it without limit.
 */
export function createLineSplitter(maxBuffer = 65_536): (chunk: string) => string[] {
  let buffer = "";
  return (chunk: string): string[] => {
    buffer += chunk;
    const lines: string[] = [];
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) lines.push(line);
      nl = buffer.indexOf("\n");
    }
    if (buffer.length > maxBuffer) buffer = "";
    return lines;
  };
}

/** Parse one stream line into a message, or null when it is not JSON. */
export function parseStreamLine(line: string): NtfyMessage | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as NtfyMessage;
  } catch {
    return null;
  }
}
