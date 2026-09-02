// Gateway websocket transport, not a webhook: the portal's Interactions
// Endpoint URL must stay empty, since filling it switches delivery to HTTP and
// stops the Gateway from receiving anything.
// DM only: message content is intent-exempt in DMs with the app itself, so no
// privileged MESSAGE_CONTENT intent is needed.
// A bot cannot DM a user it shares no server with (error 50278); the operator
// invites it to a private server first, and nothing here works around that.

import type { Approval } from "../shared/types.ts";
import { ALREADY_HANDLED_NOTICE, decodeCallback, encodeCallback, renderDiscord, renderSettled } from "./format.ts";
import type {
  ChannelBinding,
  ChannelHost,
  InboundAnswer,
  NotificationChannel,
  PostedMessage,
} from "./types.ts";

const API = "https://discord.com/api/v10";
/** GUILDS | DIRECT_MESSAGES — both standard, neither privileged. */
const INTENTS = (1 << 0) | (1 << 12);

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const INTERACTION_COMPONENT = 3;
const INTERACTION_MODAL_SUBMIT = 5;
const CALLBACK_MESSAGE = 4;
const CALLBACK_MODAL = 9;
const CALLBACK_DEFERRED_UPDATE = 6;

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export interface DiscordDeps {
  token: string;
  host: ChannelHost;
  bindingFor: (address: string) => ChannelBinding | null;
  fetchImpl?: typeof fetch;
  /** Injected so tests can drive a fake socket. */
  socketFactory?: (url: string) => WebSocket;
}

export class DiscordChannel implements NotificationChannel {
  readonly kind = "discord" as const;
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private acked = true;
  private running = false;
  /** DM channel id per user id, so we open one DM per recipient only once. */
  private dmChannels = new Map<string, string>();

  constructor(private readonly deps: DiscordDeps) {}

  isReady(): boolean {
    return this.running && this.ws?.readyState === 1;
  }

  private async rest<T>(path: string, init: RequestInit): Promise<T | null> {
    const f = this.deps.fetchImpl ?? fetch;
    try {
      const res = await f(`${API}${path}`, {
        ...init,
        headers: {
          authorization: `Bot ${this.deps.token}`,
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        this.deps.host.log.error(`discord: rate limited, retry after ${body.retry_after ?? "?"}s`);
        return null;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // 50278 = no mutual guild: the operator has not invited the bot yet.
        if (text.includes("50278") || text.includes("50007")) {
          this.deps.host.log.error(
            "discord: cannot DM this user — invite the bot to a server you share with them (error 50278)"
          );
        } else {
          this.deps.host.log.error(`discord: ${path} failed with ${res.status} ${text.slice(0, 200)}`);
        }
        return null;
      }
      if (res.status === 204) return null;
      return (await res.json()) as T;
    } catch (e) {
      this.deps.host.log.error(`discord: ${path} threw`, e);
      return null;
    }
  }

  /**
   * Verify the token and learn the bot's identity. For a bot user, `id` IS the
   * application id — which is what builds the invite URL, so the operator never
   * has to copy it out of the portal by hand.
   */
  async describe(): Promise<{ username: string; id: string } | null> {
    const me = await this.rest<{ username?: string; id?: string }>("/users/@me", { method: "GET" });
    return me?.username && me.id ? { username: me.username, id: me.id } : null;
  }

  private async dmChannelFor(userId: string): Promise<string | null> {
    const cached = this.dmChannels.get(userId);
    if (cached) return cached;
    const dm = await this.rest<{ id: string }>("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!dm?.id) return null;
    this.dmChannels.set(userId, dm.id);
    return dm.id;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    try {
      this.ws?.close(1000, "shutting down");
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const url = this.resumeUrl ?? "wss://gateway.discord.gg";
    const make = this.deps.socketFactory ?? ((u: string): WebSocket => new WebSocket(u));
    try {
      this.ws = make(`${url}/?v=10&encoding=json`);
    } catch (e) {
      this.deps.host.log.error("discord: cannot open the gateway socket", e);
      this.scheduleReconnect();
      return;
    }
    this.ws.addEventListener("message", (ev) => {
      void this.onFrame(String((ev as MessageEvent).data));
    });
    this.ws.addEventListener("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.running) this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      // 'close' always follows; reconnection is handled there.
    });
  }

  private scheduleReconnect(): void {
    setTimeout(() => void this.connect(), 5000);
  }

  private send(payload: GatewayPayload): void {
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (e) {
      this.deps.host.log.error("discord: gateway send failed", e);
    }
  }

  private async onFrame(raw: string): Promise<void> {
    let p: GatewayPayload;
    try {
      p = JSON.parse(raw) as GatewayPayload;
    } catch {
      return;
    }
    if (typeof p.s === "number") this.seq = p.s;

    switch (p.op) {
      case OP_HELLO: {
        const interval = (p.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 45_000;
        this.acked = true;
        this.heartbeat = setInterval(() => {
          if (!this.acked) {
            // A missed ack means a zombie connection: drop it and resume.
            try {
              this.ws?.close(4000, "heartbeat not acked");
            } catch {
              /* ignore */
            }
            return;
          }
          this.acked = false;
          this.send({ op: OP_HEARTBEAT, d: this.seq });
        }, interval);
        // Jitter the first beat, as the protocol asks.
        setTimeout(() => this.send({ op: OP_HEARTBEAT, d: this.seq }), Math.floor(interval * Math.random()));
        if (this.sessionId) {
          this.send({
            op: OP_RESUME,
            d: { token: this.deps.token, session_id: this.sessionId, seq: this.seq },
          });
        } else {
          this.send({
            op: OP_IDENTIFY,
            d: {
              token: this.deps.token,
              intents: INTENTS,
              properties: { os: process.platform, browser: "koryphaios", device: "koryphaios" },
            },
          });
        }
        return;
      }
      case OP_HEARTBEAT_ACK:
        this.acked = true;
        return;
      case OP_HEARTBEAT:
        this.send({ op: OP_HEARTBEAT, d: this.seq });
        return;
      case OP_RECONNECT:
        try {
          this.ws?.close(4000, "server asked to reconnect");
        } catch {
          /* ignore */
        }
        return;
      case OP_INVALID_SESSION:
        // Cannot resume: start a fresh identify next time.
        this.sessionId = null;
        this.resumeUrl = null;
        this.seq = null;
        try {
          this.ws?.close(4000, "invalid session");
        } catch {
          /* ignore */
        }
        return;
      case OP_DISPATCH:
        await this.onDispatch(p.t ?? "", p.d);
        return;
      default:
        return;
    }
  }

  private async onDispatch(event: string, d: unknown): Promise<void> {
    if (event === "READY") {
      const ready = d as { session_id?: string; resume_gateway_url?: string };
      this.sessionId = ready.session_id ?? null;
      this.resumeUrl = ready.resume_gateway_url ?? null;
      this.deps.host.log.info("discord: gateway ready");
      return;
    }
    if (event === "MESSAGE_CREATE") await this.onMessage(d);
    if (event === "INTERACTION_CREATE") await this.onInteraction(d);
  }

  private async onMessage(d: unknown): Promise<void> {
    const m = d as {
      content?: string;
      author?: { id: string; bot?: boolean; username?: string };
      guild_id?: string;
    };
    // Ignore our own messages, other bots, and anything outside a DM.
    if (!m.author || m.author.bot || m.guild_id) return;
    const content = (m.content ?? "").trim();
    if (!content) return;
    const address = m.author.id;

    // Pairing by code, the Discord analogue of Telegram's deep link.
    const paired = await this.deps.host.onPair(
      "discord",
      content.replace(/^pair\s+/i, ""),
      address,
      m.author.username ?? ""
    );
    if (paired) {
      await this.dm(address, "Paired. Approvals from your Koryphaios sessions will arrive here.");
      return;
    }
    if (!this.deps.bindingFor(address)) {
      await this.dm(address, "Send the pairing code shown in Koryphaios (Settings > Notifications).");
    }
  }

  private async onInteraction(d: unknown): Promise<void> {
    const i = d as {
      id: string;
      token: string;
      type: number;
      data?: {
        custom_id?: string;
        components?: Array<{ components?: Array<{ custom_id?: string; value?: string }> }>;
      };
      user?: { id: string };
      member?: { user?: { id: string } };
    };
    const address = i.user?.id ?? i.member?.user?.id ?? "";
    if (!address || !this.deps.bindingFor(address)) return;

    if (i.type === INTERACTION_COMPONENT) {
      const decoded = decodeCallback(i.data?.custom_id ?? "");
      if (!decoded) return;
      if (decoded.action === "text") {
        // A modal is the only way to collect free text (up to 4000 chars).
        await this.respond(i.id, i.token, CALLBACK_MODAL, {
          custom_id: encodeCallback("text", decoded.approvalId),
          title: "Your answer",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "answer",
                  label: "Answer",
                  style: 2,
                  max_length: 4000,
                  required: true,
                },
              ],
            },
          ],
        });
        return;
      }
      const settled = await this.deps.host.onAnswer("discord", {
        approvalId: decoded.approvalId,
        answerKind: decoded.action,
        fromAddress: address,
      });
      await this.respond(i.id, i.token, settled ? CALLBACK_DEFERRED_UPDATE : CALLBACK_MESSAGE, settled ? {} : {
        content: ALREADY_HANDLED_NOTICE,
        flags: 64, // ephemeral
      });
      return;
    }

    if (i.type === INTERACTION_MODAL_SUBMIT) {
      const decoded = decodeCallback(i.data?.custom_id ?? "");
      const value = i.data?.components?.[0]?.components?.[0]?.value ?? "";
      if (!decoded || !value.trim()) return;
      const settled = await this.deps.host.onAnswer("discord", {
        approvalId: decoded.approvalId,
        answerKind: "text",
        answerText: value,
        fromAddress: address,
      });
      await this.respond(i.id, i.token, CALLBACK_MESSAGE, {
        content: settled ? "Sent to the agent." : ALREADY_HANDLED_NOTICE,
        flags: 64,
      });
    }
  }

  private async respond(id: string, token: string, type: number, data: unknown): Promise<void> {
    await this.rest(`/interactions/${id}/${token}/callback`, {
      method: "POST",
      body: JSON.stringify({ type, data }),
    });
  }

  private async dm(userId: string, content: string): Promise<string | null> {
    const channel = await this.dmChannelFor(userId);
    if (!channel) return null;
    const sent = await this.rest<{ id: string }>(`/channels/${channel}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    return sent?.id ?? null;
  }

  async post(binding: ChannelBinding, approval: Approval): Promise<PostedMessage | null> {
    const channel = await this.dmChannelFor(binding.address);
    if (!channel) return null;
    const components =
      approval.kind === "permission"
        ? [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: "Approve", custom_id: encodeCallback("allow", approval.id) },
                { type: 2, style: 4, label: "Reject", custom_id: encodeCallback("deny", approval.id) },
                { type: 2, style: 1, label: "Answer…", custom_id: encodeCallback("text", approval.id) },
              ],
            },
          ]
        : [
            {
              type: 1,
              components: [
                { type: 2, style: 1, label: "Answer…", custom_id: encodeCallback("text", approval.id) },
              ],
            },
          ];
    const sent = await this.rest<{ id: string }>(`/channels/${channel}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: renderDiscord(approval), components }),
    });
    return sent?.id ? { external_ref: sent.id } : null;
  }

  async settle(
    binding: ChannelBinding,
    posted: PostedMessage,
    approval: Approval,
    viaLabel: string
  ): Promise<void> {
    const channel = await this.dmChannelFor(binding.address);
    if (!channel) return;
    await this.rest(`/channels/${channel}/messages/${posted.external_ref}`, {
      method: "PATCH",
      // Empty components: a settled request must not look actionable.
      body: JSON.stringify({ content: renderSettled(approval, viaLabel), components: [] }),
    });
  }

  async rejectLate(binding: ChannelBinding): Promise<void> {
    await this.dm(binding.address, ALREADY_HANDLED_NOTICE);
  }
}
