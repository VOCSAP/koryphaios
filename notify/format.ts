// Rendering of an approval into a chat message (PLAN N3/N4).
//
// Pure module — no I/O, no bun/node-specific API — so every escaping and
// truncation rule is unit-tested without touching a network.
//
// HOSTILE INPUT #4: the title and question come from an AGENT. They reach a
// third-party chat renderer, so nothing here may interpolate them raw. Telegram
// runs in HTML mode (three characters to escape) rather than MarkdownV2 (which
// needs eighteen escaped anywhere in the string, and silently 400s on a miss).

import { truncate } from "../shared/text.ts";
import type { Approval } from "../shared/types.ts";
import { settledOutcome } from "../shared/approval-outcome.ts";
import type { AnswerRefusal } from "./types.ts";
import { optionButtons, questionLines, QUESTIONS_POINTER } from "./ntfy-protocol.ts";

/** Telegram sendMessage hard limit. */
export const TELEGRAM_TEXT_MAX = 4096;
/** Discord message content limit for a bot. */
export const DISCORD_TEXT_MAX = 2000;
/** Telegram callback_data is capped at 64 BYTES. */
export const CALLBACK_DATA_MAX = 64;

/** Escape the three characters Telegram's HTML parse mode treats as markup. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// `truncate` lives in `shared/text.ts` (a dependency-free leaf shared with the
// mobile app); re-exported here because every caller imports it from this
// module alongside the renderers.
export { truncate };

/** Human origin badge: `host · project`, the multi-PC disambiguator. */
export function originLabel(approval: Approval): string {
  const project = approval.origin.project_key.split(/[/\\:]/).filter(Boolean).pop() ?? "";
  const host = approval.origin.host.trim() || "?";
  return project ? `${host} · ${project}` : host;
}

/**
 * Callback payload of an action button. Kept SHORT on purpose: Telegram caps
 * it at 64 bytes, so the approval id (a uuid, 36 chars) plus a verb is the
 * entire budget. Anything richer must be looked up server-side by id.
 */
export function encodeCallback(
  action: "allow" | "deny" | "text" | "option",
  approvalId: string,
  optionIndex?: number
): string {
  const out = action === "option" ? `o:${optionIndex}:${approvalId}` : `${action[0]}:${approvalId}`;
  if (Buffer.byteLength(out, "utf-8") > CALLBACK_DATA_MAX) {
    throw new Error(`callback_data too long for ${approvalId}`);
  }
  return out;
}

export function decodeCallback(
  data: string
): { action: "allow" | "deny" | "text" | "option"; approvalId: string; optionIndex?: number } | null {
  const option = /^o:(0|[1-9]\d{0,5}):(.+)$/.exec(data ?? "");
  if (option) return { action: "option", approvalId: option[2]!, optionIndex: Number(option[1]) };
  const m = /^([adt]):(.+)$/.exec(data ?? "");
  if (!m) return null;
  const action = m[1] === "a" ? "allow" : m[1] === "d" ? "deny" : "text";
  return { action, approvalId: m[2]! };
}

/** Telegram and Discord show every option the broker accepts. */
const CHAT_OPTION_BUTTONS_MAX = Number.POSITIVE_INFINITY;

/** Labels a chat channel offers as buttons, or null when the row takes none. */
export function chatOptionButtons(approval: Approval): string[] | null {
  return optionButtons(approval, CHAT_OPTION_BUTTONS_MAX);
}

/** The notification body for Telegram (HTML parse mode). */
export function renderTelegram(approval: Approval): string {
  const head = `<b>${escapeHtml(truncate(approval.title, 200))}</b>`;
  const badge = `<i>${escapeHtml(originLabel(approval))}</i>`;
  const body = escapeHtml(truncate(approval.question, 2500));
  if (approval.questions) {
    const listed = escapeHtml(truncate(questionLines(approval).join("\n"), 1200));
    const hint = chatOptionButtons(approval) ? "Tap an option." : QUESTIONS_POINTER;
    return truncate([head, badge, "", body, "", listed, "", `<i>${escapeHtml(hint)}</i>`].join("\n"), TELEGRAM_TEXT_MAX);
  }
  const hint =
    approval.kind === "permission"
      ? "Tap a button, or reply with instructions."
      : "Reply to this message with your answer.";
  return truncate([head, badge, "", body, "", `<i>${escapeHtml(hint)}</i>`].join("\n"), TELEGRAM_TEXT_MAX);
}

/** The notification body for Discord (plain content, no markup injection). */
export function renderDiscord(approval: Approval): string {
  // Discord has no parse-mode toggle: markdown is always live. Fencing the
  // agent-supplied block keeps a stray backtick or underscore from reflowing
  // the message, and stops any attempt at fake formatting.
  const fenced = approval.questions ? `${approval.question}\n\n${questionLines(approval).join("\n")}` : approval.question;
  const body = truncate(fenced, 1500).replace(/```/g, "``​`");
  const pointer = approval.questions && !chatOptionButtons(approval) ? [QUESTIONS_POINTER] : [];
  return truncate(
    [
      `**${truncate(approval.title, 200).replace(/\*/g, "\\*")}**`,
      `_${originLabel(approval)}_`,
      "```",
      body,
      "```",
      ...pointer,
    ].join("\n"),
    DISCORD_TEXT_MAX
  );
}

/** What the message becomes once somebody answered, on every channel. */
export function renderSettled(approval: Approval, viaLabel: string): string {
  const outcome = settledOutcome(approval);
  let verdict: string;
  switch (outcome.kind) {
    case "text":
      verdict = truncate(outcome.text, 500);
      break;
    case "approved":
      verdict = "approved";
      break;
    case "rejected":
      verdict = "rejected";
      break;
    case "acknowledged":
      verdict = "acknowledged, no answer";
      break;
    case "terminal":
      verdict = "answered in the terminal";
      break;
    case "pending":
    case "gone":
      // Nobody answered: no check mark, and the label is the reason, not a channel.
      return `✕ ${truncate(approval.title, 120)}: closed, ${viaLabel}`;
  }
  return `✓ ${truncate(approval.title, 120)} — handled via ${viaLabel}: ${verdict}`;
}

export const ALREADY_HANDLED_NOTICE = "Validation expired or invalid / already handled";

export const REFUSAL_NOTICES: Record<AnswerRefusal, string> = {
  "verdict-only": "Not sent: this request takes Approve or Reject, not a written answer.",
  "on-tile": "Not sent: this request is waiting on its tile, answer it in Koryphaios.",
  "session-gone": "Not sent: the session is no longer waiting for this answer, answer it in its terminal.",
  "answers-only": `Not sent: this request takes one of its options. ${QUESTIONS_POINTER}`,
};

/**
 * What to tell the sender after `onAnswer`: null when the answer settled the
 * request, the refusal's reason when the request is still pending, and the
 * already-handled notice when the claim lost the race.
 */
export function channelAnswerResult(
  settled: { approval: Approval } | { error: string; status: number; refused?: AnswerRefusal },
  onSettled: (approval: Approval) => void
): Approval | { refused: AnswerRefusal } | null {
  if ("error" in settled) return settled.refused ? { refused: settled.refused } : null;
  onSettled(settled.approval);
  return settled.approval;
}

export function answerNotice(result: Approval | { refused: AnswerRefusal } | null): string | null {
  if (result === null) return ALREADY_HANDLED_NOTICE;
  if ("refused" in result) return REFUSAL_NOTICES[result.refused];
  return null;
}
