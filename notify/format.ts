// Rendering of an approval into a chat message (PLAN N3/N4).
//
// Pure module — no I/O, no bun/node-specific API — so every escaping and
// truncation rule is unit-tested without touching a network.
//
// HOSTILE INPUT #4: the title and question come from an AGENT. They reach a
// third-party chat renderer, so nothing here may interpolate them raw. Telegram
// runs in HTML mode (three characters to escape) rather than MarkdownV2 (which
// needs eighteen escaped anywhere in the string, and silently 400s on a miss).

import type { Approval } from "../shared/types.ts";

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

/**
 * Cut to `max` on a character boundary, appending an ellipsis when cut.
 * Length is measured in UTF-16 code units, matching what both APIs count.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

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
export function encodeCallback(action: "allow" | "deny" | "text", approvalId: string): string {
  const out = `${action[0]}:${approvalId}`;
  if (Buffer.byteLength(out, "utf-8") > CALLBACK_DATA_MAX) {
    throw new Error(`callback_data too long for ${approvalId}`);
  }
  return out;
}

export function decodeCallback(
  data: string
): { action: "allow" | "deny" | "text"; approvalId: string } | null {
  const m = /^([adt]):(.+)$/.exec(data ?? "");
  if (!m) return null;
  const action = m[1] === "a" ? "allow" : m[1] === "d" ? "deny" : "text";
  return { action, approvalId: m[2]! };
}

/** The notification body for Telegram (HTML parse mode). */
export function renderTelegram(approval: Approval): string {
  const head = `<b>${escapeHtml(truncate(approval.title, 200))}</b>`;
  const badge = `<i>${escapeHtml(originLabel(approval))}</i>`;
  const body = escapeHtml(truncate(approval.question, 2500));
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
  const body = truncate(approval.question, 1500).replace(/```/g, "``​`");
  return truncate(
    [`**${truncate(approval.title, 200).replace(/\*/g, "\\*")}**`, `_${originLabel(approval)}_`, "```", body, "```"].join(
      "\n"
    ),
    DISCORD_TEXT_MAX
  );
}

/** What the message becomes once somebody answered, on every channel. */
export function renderSettled(approval: Approval, viaLabel: string): string {
  const verdict =
    approval.answer_kind === "text"
      ? truncate(approval.answer_text ?? "", 500)
      : approval.answer_kind === "allow"
        ? "approved"
        : "rejected";
  return `✓ ${truncate(approval.title, 120)} — handled via ${viaLabel}: ${verdict}`;
}

/** Shown when someone answers a request that is no longer open. */
export const ALREADY_HANDLED_NOTICE = "Validation expired or invalid / already handled";
