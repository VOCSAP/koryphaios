// Fan-out is bounded by operator_id, never a broadcast: a request goes only to
// that operator's enabled channels, and the broker arbitrates so whichever
// channel answers wins while the rest get 409.
// Keyed by (operator, kind), not by kind alone, since one broker can serve
// several operators and a kind-only key would let a later enrolment silently
// replace an earlier one's gateway.
// The same channel token can be registered under two operators on purpose;
// stopping is reference-counted so disconnecting one operator never cuts the
// other's.

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

function slot(operatorId: string, kind: ChannelKind): string {
  return `${operatorId}\0${kind}`;
}

export class NotificationRegistry {
  /** (operator, kind) -> gateway. Several slots may share one instance. */
  private slots = new Map<string, NotificationChannel>();

  constructor(
    private readonly store: RegistryStore,
    private readonly log: { info: (m: string) => void; error: (m: string, e?: unknown) => void }
  ) {}

  register(operatorId: string, channel: NotificationChannel): void {
    this.slots.set(slot(operatorId, channel.kind), channel);
  }

  /**
   * Forget one operator's slot and say whether the gateway is now unused.
   *
   * The caller stops the transport only on `true`: an instance shared with
   * another operator (same bot token) must keep running for them.
   */
  unregister(operatorId: string, kind: ChannelKind): { channel: NotificationChannel | null; orphaned: boolean } {
    const key = slot(operatorId, kind);
    const channel = this.slots.get(key) ?? null;
    if (!channel) return { channel: null, orphaned: false };
    this.slots.delete(key);
    const stillUsed = [...this.slots.values()].includes(channel);
    return { channel, orphaned: !stillUsed };
  }

  get(operatorId: string, kind: ChannelKind): NotificationChannel | undefined {
    return this.slots.get(slot(operatorId, kind));
  }

  /** Kinds currently configured and running FOR THIS OPERATOR. */
  readyKinds(operatorId: string): ChannelKind[] {
    const out: ChannelKind[] = [];
    for (const [key, channel] of this.slots) {
      if (!key.startsWith(`${operatorId}\0`)) continue;
      if (channel.isReady()) out.push(channel.kind);
    }
    return out;
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
      // The gateway of THIS operator: another operator's, even of the same
      // kind, would publish with their credentials and their reply topic.
      const channel = this.get(binding.operator_id, binding.kind);
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
      const binding = this.store.binding(post.bindingId);
      if (!binding) continue;
      const channel = this.get(binding.operator_id, post.kind);
      if (!channel) continue;
      try {
        await channel.settle(binding, { external_ref: post.externalRef }, approval, viaLabel);
      } catch (e) {
        this.log.error(`notify: ${post.kind} settle failed for approval ${approval.id}`, e);
      }
    }
    this.store.clearPosts(approval.id);
  }

  async stopAll(): Promise<void> {
    // Distinct instances only: a shared gateway must be stopped once, not once
    // per operator pointing at it.
    for (const channel of new Set(this.slots.values())) {
      try {
        await channel.stop();
      } catch (e) {
        this.log.error(`notify: ${channel.kind} stop failed`, e);
      }
    }
    this.slots.clear();
  }
}
