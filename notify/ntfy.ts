// ntfy gateway — the channel of Parastates, the Koryphaios app (PLAN N5).
//
// Third implementation of `NotificationChannel`, and the one whose transport is
// least like the other two: ntfy is a pub/sub relay, not a messenger.
//
// TWO TOPICS, BOTH LEGS OUTGOING (EXPLORATION §4.3c):
//
//   broker ──POST /{topic_notif}──▶ ntfy ──push──▶ phone
//   broker ◀── GET /{topic_replies}/json (held open) ◀──POST── phone
//
// The subscription is an ordinary GET whose body streams forever, so — exactly
// like Telegram's long poll and Discord's gateway socket — no port is opened,
// no address is published, nothing on the broker becomes reachable.
//
// WHY NOT FCM: pushing to FCM needs a Firebase service-account key on the
// sending side, which cannot be shipped in an open-source app; ntfy is the
// relay that already solved this, and it is self-hostable. Rationale in
// EXPLORATION §4.3b.
//
// NO EDIT: ntfy cannot rewrite a published message, so `settle` publishes a
// closing message carrying the same approval id and the app cancels its own
// notification. That is the one behavioural difference the registry sees.
//
// AUTHORISATION: a topic is a bus. Anyone able to publish on the replies topic
// reaches `handleInbound`, so nothing here trusts what it reads: the payload is
// validated by `decodeInbound`, the address is checked against a binding, and
// the verdict comes from the broker (C-1).

import type { Approval } from "../shared/types.ts";
import { ALREADY_HANDLED_NOTICE, originLabel, renderSettled } from "./format.ts";
import {
  buildApprovalPublish,
  buildSettledPublish,
  decodeInbound,
  pairedClickUrl,
  type NtfyPublish,
} from "./ntfy-protocol.ts";
import type {
  ChannelBinding,
  ChannelHost,
  InboundAnswer,
  NotificationChannel,
  PostedMessage,
} from "./types.ts";

/** Backoff between two subscription attempts. */
const RECONNECT_MS = 5_000;
/** Publish calls are short; the subscription deliberately has no timeout. */
const PUBLISH_TIMEOUT_MS = 20_000;

export interface NtfyConfig {
  /** Base URL, already normalised by `normalizeNtfyServer`. */
  server: string;
  topic_notif: string;
  topic_replies: string;
  /** ntfy access token (`tk_…`), empty when the server allows anonymous use. */
  token: string;
}

export interface NtfyDeps {
  config: NtfyConfig;
  host: ChannelHost;
  /** Resolve the binding a topic maps to, or null when unknown. */
  bindingFor: (address: string) => ChannelBinding | null;
  fetchImpl?: typeof fetch;
  /** Injected so tests drive reconnection without waiting five seconds. */
  reconnectMs?: number;
}

/** One message as ntfy's JSON stream emits it. */
interface NtfyEvent {
  id?: string;
  event?: string;
  message?: string;
}

export class NtfyChannel implements NotificationChannel {
  readonly kind = "ntfy" as const;
  private running = false;
  private connected = false;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;
  /** Held so stop() can unblock a `read()` that is parked on a live stream. */
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** Resolves the backoff sleep early, so stop() never waits it out. */
  private wake: (() => void) | null = null;
  /** Last message id seen, so a reconnect resumes instead of replaying. */
  private since: string | null = null;

  constructor(private readonly deps: NtfyDeps) {}

  isReady(): boolean {
    return this.running && this.connected;
  }

  private get auth(): Record<string, string> {
    return this.deps.config.token ? { authorization: `Bearer ${this.deps.config.token}` } : {};
  }

  /**
   * Verify the server answers and the credentials are accepted.
   *
   * `/v1/health` proves the host is an ntfy; it does not prove the token is
   * valid, so a second probe publishes nothing but asks for the replies topic
   * — a bad token answers 401/403 there and the enrolment is refused rather
   * than left looking configured.
   */
  async describe(): Promise<{ label: string } | null> {
    const f = this.deps.fetchImpl ?? fetch;
    const base = this.deps.config.server;
    try {
      const health = await f(`${base}/v1/health`, {
        method: "GET",
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      if (!health.ok) {
        this.deps.host.log.error(`ntfy: ${base}/v1/health answered ${health.status}`);
        return null;
      }
      const body = (await health.json().catch(() => ({}))) as { healthy?: boolean };
      if (body.healthy === false) {
        this.deps.host.log.error("ntfy: server reports itself unhealthy");
        return null;
      }
      // `poll=1` returns immediately with the cached messages instead of
      // holding the connection open — the cheapest way to exercise auth.
      const probe = await f(`${base}/${this.deps.config.topic_replies}/json?poll=1`, {
        method: "GET",
        headers: this.auth,
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      if (probe.status === 401 || probe.status === 403) {
        this.deps.host.log.error(`ntfy: the server refused these credentials (${probe.status})`);
        return null;
      }
      if (!probe.ok) {
        this.deps.host.log.error(`ntfy: subscribe probe answered ${probe.status}`);
        return null;
      }
      // Drain: an unread body keeps the socket alive for nothing.
      await probe.text().catch(() => "");
      return { label: new URL(base).host };
    } catch (e) {
      this.deps.host.log.error("ntfy: server unreachable", e);
      return null;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.subscribe();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connected = false;
    try {
      this.abort?.abort();
    } catch {
      /* already aborted */
    }
    this.abort = null;
    // Aborting the request is what a real fetch needs; cancelling the reader is
    // what unblocks a `read()` already parked on the open body. Both, so stop()
    // returns instead of waiting for the next keepalive.
    try {
      await this.reader?.cancel();
    } catch {
      /* already released */
    }
    this.reader = null;
    // Cut short a backoff already in flight, or the await below inherits it.
    this.wake?.();
    this.wake = null;
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  /** Hold the replies topic open forever, reconnecting on any interruption. */
  private async subscribe(): Promise<void> {
    const f = this.deps.fetchImpl ?? fetch;
    const wait = this.deps.reconnectMs ?? RECONNECT_MS;
    while (this.running) {
      const abort = new AbortController();
      this.abort = abort;
      try {
        // No `since` on the very first leg: replaying the retained backlog at
        // boot would re-answer approvals that are long settled. Afterwards the
        // last id resumes exactly where the stream broke.
        const since = this.since ? `?since=${encodeURIComponent(this.since)}` : "";
        const res = await f(
          `${this.deps.config.server}/${this.deps.config.topic_replies}/json${since}`,
          { method: "GET", headers: this.auth, signal: abort.signal }
        );
        if (!res.ok || !res.body) {
          this.deps.host.log.error(`ntfy: subscription answered ${res.status}`);
        } else {
          this.connected = true;
          await this.drain(res.body);
        }
      } catch (e) {
        // An abort is our own stop(), not a failure worth logging.
        if (this.running) this.deps.host.log.error("ntfy: subscription dropped", e);
      }
      this.reader = null;
      this.connected = false;
      if (!this.running) return;
      // Interruptible: `stop()` runs inside an HTTP handler (Disconnect, or a
      // reconnect), and this loop takes the backoff after EVERY leg — including
      // a clean close — so a plain sleep would park the operator's request for
      // the full delay with the button stuck spinning.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, wait);
        this.wake = finish;
        function finish(): void {
          clearTimeout(timer);
          resolve();
        }
      });
      this.wake = null;
    }
  }

  /** ntfy's JSON stream is newline-delimited: one event per line. */
  private async drain(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    this.reader = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    while (this.running) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) await this.onLine(line);
        nl = buffer.indexOf("\n");
      }
      // A single line larger than any sane payload means a peer is feeding us
      // garbage: drop the buffer rather than grow it without bound.
      if (buffer.length > 65_536) buffer = "";
    }
  }

  private async onLine(line: string): Promise<void> {
    let event: NtfyEvent;
    try {
      event = JSON.parse(line) as NtfyEvent;
    } catch {
      return;
    }
    // `open`, `keepalive` and `poll_request` carry no payload — and, crucially,
    // their ids name nothing the server can resume from. Advancing the cursor
    // on them would make `since` point at a keepalive on every reconnect (they
    // are continuous, real answers are rare), so the resume would ask for a
    // position the message cache does not know. The filter must come FIRST.
    if (event.event && event.event !== "message") return;
    if (typeof event.message !== "string") return;
    if (event.id) this.since = event.id;
    try {
      await this.handleInbound(event.message);
    } catch (e) {
      this.deps.host.log.error("ntfy: inbound message failed", e);
    }
  }

  private async handleInbound(raw: string): Promise<void> {
    const inbound = decodeInbound(raw);
    // Not our envelope: a stray publish on the topic, ignored in silence. We
    // cannot answer the sender anyway — a topic has no reply address.
    if (!inbound) return;

    const address = this.deps.config.topic_notif;

    if (inbound.t === "pair") {
      const bound = await this.deps.host.onPair("ntfy", inbound.code, address, inbound.device);
      // The ack MUST carry a deep link: the app routes on it and drops anything
      // without one, so an empty `click` left the phone waiting for a
      // confirmation that had in fact already been sent — and a refusal
      // invisible, which is the half the operator needs most.
      await this.publish({
        topic: this.deps.config.topic_notif,
        title: "Parastates",
        message: bound
          ? "Paired. Approvals from your Koryphaios sessions will arrive here."
          : "That pairing code is unknown or expired — show a fresh one in Settings > Notifications.",
        priority: bound ? 3 : 2,
        tags: [bound ? "white_check_mark" : "warning"],
        click: pairedClickUrl(!!bound),
      });
      return;
    }

    // Unknown topic: nothing is written, nothing is answered. Same lock as the
    // Telegram adapter applies to a stranger messaging a public bot username.
    const binding = this.deps.bindingFor(address);
    if (!binding) return;

    const answer: InboundAnswer = {
      approvalId: inbound.approvalId,
      answerKind: inbound.kind,
      answerText: inbound.text || undefined,
      fromAddress: address,
    };
    const settled = await this.deps.host.onAnswer("ntfy", answer);
    if (!settled) await this.rejectLate(binding, answer);
  }

  /**
   * Publish one message.
   *
   * `ok` and `id` are separate on purpose: a 2xx with no id in the body is a
   * success the caller can live with, while a failure must NOT be reported as
   * a post — the registry would record a copy that does not exist and later
   * publish a closing message for a question the phone never received.
   */
  private async publish(body: NtfyPublish): Promise<{ ok: boolean; id: string | null }> {
    const f = this.deps.fetchImpl ?? fetch;
    try {
      const res = await f(this.deps.config.server, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.deps.host.log.error(`ntfy: publish answered ${res.status}`);
        return { ok: false, id: null };
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { ok: true, id: json.id ?? null };
    } catch (e) {
      this.deps.host.log.error("ntfy: publish threw", e);
      return { ok: false, id: null };
    }
  }

  /**
   * Publish a pending request.
   *
   * BOTH topics come from this gateway's own config, never half from the
   * binding: the two must belong to the same enrolment or the request lands on
   * one operator's phone with another's reply address, and the answer
   * disappears. The registry now guarantees the gateway matches the binding's
   * operator, and reading a single source of truth is what keeps it guaranteed.
   */
  async post(binding: ChannelBinding, approval: Approval): Promise<PostedMessage | null> {
    void binding;
    const sent = await this.publish(
      buildApprovalPublish(approval, originLabel(approval), {
        server: this.deps.config.server,
        topicNotif: this.deps.config.topic_notif,
        topicReplies: this.deps.config.topic_replies,
      })
    );
    if (!sent.ok) return null;
    // The approval id is what the closing message is keyed on, so a server
    // that answered without one costs nothing.
    return { external_ref: sent.id ?? approval.id };
  }

  async settle(
    _binding: ChannelBinding,
    _posted: PostedMessage,
    approval: Approval,
    viaLabel: string
  ): Promise<void> {
    await this.publish(
      buildSettledPublish(approval.id, renderSettled(approval, viaLabel), {
        topicNotif: this.deps.config.topic_notif,
      })
    );
  }

  async rejectLate(_binding: ChannelBinding, answer: InboundAnswer): Promise<void> {
    await this.publish(
      buildSettledPublish(answer.approvalId, ALREADY_HANDLED_NOTICE, {
        topicNotif: this.deps.config.topic_notif,
      })
    );
  }
}
