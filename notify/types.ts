// The channel abstraction every gateway implements (PLAN N3/N4).
//
// One interface, three implementations (Telegram, Discord, ntfy later). The
// broker's registry only ever speaks this, so adding a channel never touches
// the arbitration logic — and the fan-out/settle rules are written once.

import type { Approval } from "../shared/types.ts";

export type ChannelKind = "telegram" | "discord" | "ntfy";

/** A pairing between an operator and one address on one channel. */
export interface ChannelBinding {
  id: string;
  operator_id: string;
  kind: ChannelKind;
  /** chat_id (Telegram), user id (Discord), topic (ntfy). */
  address: string;
  label: string;
  enabled: boolean;
}

/** Handle of a message we posted, so it can be edited once settled. */
export interface PostedMessage {
  /** Provider message id, opaque. */
  external_ref: string;
}

/** An answer coming back FROM a channel, already normalised. */
export interface InboundAnswer {
  approvalId: string;
  answerKind: "allow" | "deny" | "text";
  answerText?: string;
  /** Address that sent it — checked against the binding before it is trusted. */
  fromAddress: string;
  /** Provider-specific acknowledgement handle (callback query id, interaction). */
  ack?: string;
}

/**
 * A gateway. Implementations own their transport; they never decide whether an
 * answer is valid — they hand it to `onAnswer` and render whatever verdict
 * comes back. Arbitration stays in the broker (C-1).
 */
export interface NotificationChannel {
  readonly kind: ChannelKind;

  /** True once the transport is configured and running. */
  isReady(): boolean;

  /** Post an approval to one address. Returns null when nothing was sent. */
  post(binding: ChannelBinding, approval: Approval): Promise<PostedMessage | null>;

  /** Rewrite a posted message after the approval was settled elsewhere. */
  settle(
    binding: ChannelBinding,
    posted: PostedMessage,
    approval: Approval,
    viaLabel: string
  ): Promise<void>;

  /** Tell the sender their answer arrived too late. */
  rejectLate(binding: ChannelBinding, answer: InboundAnswer): Promise<void>;

  /** Stop the transport (app shutdown, token replaced). */
  stop(): Promise<void>;
}

/** What a gateway needs from the broker, injected so adapters stay testable. */
export interface ChannelHost {
  /**
   * Called when a channel receives an answer. Returns the settled approval, or
   * null when the claim lost the race (already handled / expired).
   */
  onAnswer(kind: ChannelKind, answer: InboundAnswer): Promise<Approval | null>;

  /**
   * Called when an address wants to pair using a one-shot code shown by the
   * Deck. Returns the binding on success, null when the code is unknown.
   */
  onPair(kind: ChannelKind, code: string, address: string, label: string): Promise<ChannelBinding | null>;

  /** Structured log sink (the broker's rolling logger). */
  log: { info: (m: string) => void; error: (m: string, e?: unknown) => void };
}
