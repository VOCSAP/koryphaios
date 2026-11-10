// What a settled approval means to whoever reads it back: the agent waiting in
// ask_operator_wait, the channel message the broker pushes, the phone copy.
// One switch for all three, so an acknowledgement can never fall into the
// refusal branch of a reader that only knew allow/deny/text.

import type { Approval, InboxCloseAuthority } from "./types.ts";

type CloseFields = Pick<Approval, "close_reason" | "closed_by_authority" | "closed_by_peer_id">;

export type SettledOutcome =
  | { kind: "pending" }
  | { kind: "text"; text: string }
  | { kind: "approved" }
  | { kind: "rejected" }
  | { kind: "acknowledged" }
  | { kind: "terminal" }
  | { kind: "gone" }
  | { kind: "closed"; reason: string; by: InboxCloseAuthority; peer: string | null };

function unreachable(value: never): never {
  throw new Error(`unhandled approval value: ${String(value)}`);
}

export function settledOutcome(
  approval: Pick<Approval, "status" | "answer_kind" | "answer_text"> & CloseFields
): SettledOutcome {
  switch (approval.status) {
    case "pending":
      return { kind: "pending" };
    case "closed":
      return {
        kind: "closed",
        reason: approval.close_reason ?? "",
        by: approval.closed_by_authority ?? "author",
        peer: approval.closed_by_peer_id ?? null,
      };
    case "acknowledged":
      return { kind: "acknowledged" };
    case "answered_terminal":
      return { kind: "terminal" };
    case "expired_notif":
    case "abandoned":
      return { kind: "gone" };
    case "answered":
      switch (approval.answer_kind) {
        case "text":
        case "answers":
          return { kind: "text", text: approval.answer_text ?? "" };
        case "allow":
          return { kind: "approved" };
        case "deny":
        case null:
          return { kind: "rejected" };
        default:
          return unreachable(approval.answer_kind);
      }
    default:
      return unreachable(approval.status);
  }
}

export const ACKNOWLEDGED_WAIT_TEXT =
  "The operator acknowledged your question without answering: read, nothing to add. This is not a refusal; proceed on your own judgment.";

export const TERMINAL_WAIT_TEXT =
  "The operator answered this directly in your terminal. What they chose is not relayed here: rely on what your session received.";

/** The ask_operator / ask_operator_wait reply, or null while still pending. */
export function askOperatorWaitReply(
  approval: Pick<Approval, "status" | "answer_kind" | "answer_text" | "answered_via"> & CloseFields
): { text: string; isError: boolean } | null {
  const outcome = settledOutcome(approval);
  switch (outcome.kind) {
    case "pending":
      return null;
    case "text":
      return { text: `The operator answered (via ${approval.answered_via}): ${outcome.text}`, isError: false };
    case "approved":
      return { text: `The operator answered (via ${approval.answered_via}): yes / approved`, isError: false };
    case "rejected":
      return { text: `The operator answered (via ${approval.answered_via}): no / rejected`, isError: false };
    case "acknowledged":
      return { text: ACKNOWLEDGED_WAIT_TEXT, isError: false };
    case "terminal":
      return { text: TERMINAL_WAIT_TEXT, isError: false };
    case "closed":
      return {
        text: `The question was closed by ${outcome.peer ?? `the ${outcome.by}`} (${outcome.by}) without an answer. Reason given: ${JSON.stringify(outcome.reason)}. This is not a refusal: ask again if it still matters.`,
        isError: false,
      };
    case "gone":
      return {
        text: "That question is no longer awaiting an answer (it expired or was withdrawn). Ask the operator on screen.",
        isError: true,
      };
    default:
      return unreachable(outcome);
  }
}
