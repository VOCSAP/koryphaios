// Fan-out and settle rules, written once for every channel (PLAN N3/N4).
//
// The registry owns the two behaviours the operator actually feels:
//
//  1. FAN-OUT — a request goes to every enabled channel of THAT operator, and
//     only that operator. It is never a broadcast: the query is bounded by
//     operator_id (C-5). Sending to all of them is safe because the broker
//     arbitrates: whichever the operator answers from wins, the rest get 409.
//
//  2. SETTLE — the moment one channel wins, every OTHER posted copy is
//     rewritten to "handled via X" and loses its buttons. Without that, a
//     stale request would sit on the phone looking actionable, and tapping it
//     would produce an error instead of an answer.
//
// It holds no transport of its own: adapters are injected, so the whole thing
// is testable with a fake channel and no network.

import type { Approval } from "../shared/types.ts";
import type { ChannelBinding, ChannelKind, NotificationChannel, PostedMessage } from "./types.ts";

/** Where a copy of an approval was posted, so it can be settled later. */
export interface PostedRecord {
  approvalId: string;
  kind: ChannelKind;
  bindingId: string;
  externalRef: string;
}

export interface RegistryStore {
  /** Enabled bindings of one operator. Never crosses operators. */
  bindingsFor(operatorId: string): ChannelBinding[];
  binding(bindingId: string): ChannelBinding | null;
  recordPost(rec: PostedRecord): void;
  postsFor(approvalId: string): PostedRecord[];
  clearPosts(approvalId: string): void;
}

export class NotificationRegistry {
  private channels = new Map<ChannelKind, NotificationChannel>();

  constructor(
    private readonly store: RegistryStore,
    private readonly log: { info: (m: string) => void; error: (m: string, e?: unknown) => void }
  ) {}

  register(channel: NotificationChannel): void {
    this.channels.set(channel.kind, channel);
  }

  unregister(kind: ChannelKind): void {
    this.channels.delete(kind);
  }

  get(kind: ChannelKind): NotificationChannel | undefined {
    return this.channels.get(kind);
  }

  /** Kinds currently configured and running. */
  readyKinds(): ChannelKind[] {
    return [...this.channels.values()].filter((c) => c.isReady()).map((c) => c.kind);
  }

  /**
   * Post an approval to every enabled channel of its operator.
   *
   * Deliberately best-effort per channel: one dead transport must not stop the
   * others from ringing. Failures are logged, never thrown — the approval
   * itself is already durable broker-side.
   */
  async fanOut(approval: Approval): Promise<number> {
    const bindings = this.store.bindingsFor(approval.operator_id);
    let sent = 0;
    for (const binding of bindings) {
      const channel = this.channels.get(binding.kind);
      if (!channel || !channel.isReady()) continue;
      try {
        const posted: PostedMessage | null = await channel.post(binding, approval);
        if (!posted) continue;
        this.store.recordPost({
          approvalId: approval.id,
          kind: binding.kind,
          bindingId: binding.id,
          externalRef: posted.external_ref,
        });
        sent++;
      } catch (e) {
        this.log.error(`notify: ${binding.kind} post failed for approval ${approval.id}`, e);
      }
    }
    if (sent > 0) this.log.info(`notify: approval ${approval.id} sent to ${sent} channel(s)`);
    return sent;
  }

  /**
   * Rewrite every copy of a settled approval.
   *
   * `exceptKind` skips the channel that won: it already told its own user
   * (button acknowledgement, reply) and rewriting there would be redundant.
   */
  async settle(approval: Approval, viaLabel: string, exceptKind?: ChannelKind): Promise<void> {
    const posts = this.store.postsFor(approval.id);
    for (const post of posts) {
      if (post.kind === exceptKind) continue;
      const channel = this.channels.get(post.kind);
      const binding = this.store.binding(post.bindingId);
      if (!channel || !binding) continue;
      try {
        await channel.settle(binding, { external_ref: post.externalRef }, approval, viaLabel);
      } catch (e) {
        this.log.error(`notify: ${post.kind} settle failed for approval ${approval.id}`, e);
      }
    }
    this.store.clearPosts(approval.id);
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.stop();
      } catch (e) {
        this.log.error(`notify: ${channel.kind} stop failed`, e);
      }
    }
    this.channels.clear();
  }
}
