// What a settled approval means to whoever reads it back: the channel message
// the broker pushes and the phone copy.
// One switch for both, so an acknowledgement can never fall into the
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
