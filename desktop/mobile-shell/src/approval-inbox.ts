// Pure reducers over ntfy events, so the whole decision logic is testable
// without the Android build.
// Told apart by their click deep link: parastates://approval/<id> adds to the
// list, parastates://settled/<id> drops it and cancels the Android
// notification, parastates://paired/<0|1> is the broker's pairing-handshake
// reply, parastates://notice/<id> says why an answer was refused and leaves the
// still-pending request in the list.
// ntfy cannot edit a delivered message (unlike Telegram/Discord), so a settled
// message plus this reducer is what makes an already-answered question stop
// looking actionable on the phone.

import { parseClickUrl } from "../../../notify/ntfy-protocol.ts";
import { HIDDEN_CONTROLS } from "../../../shared/log-redact.ts";
import { stripControl } from "../../../shared/text.ts";
import { readJson, writeJson, type KeyValueStore } from "./storage.ts";

export const INBOX_KEY = "koryphaios.approvals.inbox";

/** Beyond this the list is noise; the oldest fall off. */
export const MAX_PENDING = 50;
/** The broker expires a notification after 24 h; match it locally. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a sent answer waits for the broker's closing message or refusal
 * before the request can be answered again. ntfy does not guarantee delivery,
 * and answering twice is harmless: the second one reads as already handled.
 */
export const ANSWER_GRACE_MS = 60 * 1000;

export interface PendingApproval {
  id: string;
  title: string;
  body: string;
  /** True when the request offered Approve/Reject — i.e. a permission. */
  hasButtons: boolean;
  receivedAt: number;
  /** When this phone sent an answer the broker has neither settled nor refused. */
  sentAt?: number;
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
  /** The broker refused an answer; the request it names is still pending. */
  | { kind: "notice"; id: string; text: string }
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
  if (click.view === "notice") {
    const text = stripControl(String(msg.message ?? "")).replace(HIDDEN_CONTROLS, "").slice(0, 2000);
    return { kind: "notice", id: click.approvalId, text };
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
  if (effect.kind === "notice") {
    return pending.map((p) => {
      if (p.id !== effect.id) return p;
      const { sentAt: _answered, ...answerable } = p;
      return answerable;
    });
  }
  const prior = pending.find((p) => p.id === effect.approval.id);
  const without = pending.filter((p) => p.id !== effect.approval.id);
  const row = prior?.sentAt === undefined ? effect.approval : { ...effect.approval, sentAt: prior.sentAt };
  return prune([row, ...without], now);
}

/**
 * Publish an answer and mark its row as waiting for the broker.
 *
 * The row stays: removing it here would hide a request the broker then
 * refuses. The list is read again after the publish, so a row settled while
 * the answer was in flight is not brought back.
 */
export async function answerRequest(
  approvalId: string,
  publishAnswer: () => Promise<boolean>,
  inbox: { get(): PendingApproval[]; set(next: PendingApproval[]): void },
  now: () => number
): Promise<boolean> {
  if (!(await publishAnswer())) return false;
  const sentAt = now();
  inbox.set(inbox.get().map((p) => (p.id === approvalId ? { ...p, sentAt } : p)));
  return true;
}

/**
 * True while a sent answer is still within its grace period. A sentAt in the
 * future (the clock moved back) does not count as waiting.
 */
export function awaitingBroker(approval: PendingApproval, now: number): boolean {
  if (approval.sentAt === undefined) return false;
  const elapsed = now - approval.sentAt;
  return elapsed >= 0 && elapsed < ANSWER_GRACE_MS;
}

/**
 * Milliseconds until the first waiting row becomes answerable again, or null
 * when none is waiting. Read from the rows rather than from the moment of
 * sending, so a row restored after a restart gets its re-render too.
 */
export function nextGraceDelay(pending: PendingApproval[], now: number): number | null {
  let delay: number | null = null;
  for (const p of pending) {
    if (!awaitingBroker(p, now)) continue;
    const left = p.sentAt! + ANSWER_GRACE_MS - now;
    if (delay === null || left < delay) delay = left;
  }
  return delay;
}

/** What one received message changes in the app's state. */
export interface InboundStep {
  /** The inbox to show and save, or null when the message leaves it alone. */
  pending: PendingApproval[] | null;
  /** The notice line to show, or null to keep the current one. */
  notice: string | null;
  /** The message proves the broker accepted this device's pairing. */
  confirmsPairing: boolean;
}

/** Fold one received message into the inbox; null when it is not for us. */
export function receive(
  pending: PendingApproval[],
  msg: NtfyMessage,
  now: number,
  pairingConfirmed: boolean
): InboundStep | null {
  const effect = classify(msg, now);
  if (effect.kind === "ignore") return null;
  // A refusal has to be shown as a refusal: a silent one left the operator
  // staring at a spinner.
  if (effect.kind === "paired") {
    return { pending: null, notice: effect.ok ? "" : effect.text, confirmsPairing: effect.ok };
  }
  if (effect.kind === "notice") {
    return { pending: applyEffect(pending, effect, now), notice: effect.text, confirmsPairing: false };
  }
  // An approval arriving at all proves the pairing took, even if the ack was
  // lost: ntfy has no delivery guarantee.
  return {
    pending: applyEffect(pending, effect, now),
    notice: pairingConfirmed ? null : "",
    confirmsPairing: !pairingConfirmed,
  };
}

/**
 * Whether the card offers a free-text answer. A permission takes Approve or
 * Reject only: the broker refuses text on it.
 */
export function acceptsFreeText(approval: PendingApproval): boolean {
  return !approval.hasButtons;
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
