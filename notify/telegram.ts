// Telegram gateway (PLAN N3).
//
// Zero dependency: the Bot API is plain HTTPS + JSON, so a `fetch` client is
// ~150 lines and keeps a supply chain off a component that handles a secret.
//
// TRANSPORT: long polling (`getUpdates`). It is an OUTGOING request, so the
// broker needs no public address, no port, no domain. `setWebhook` is the only
// mode that would, and the two are mutually exclusive — we never call it.
//
// SINGLE CONSUMER: Telegram allows exactly one getUpdates per token; a second
// one gets HTTP 409. That is why this lives in the broker (a singleton) and not
// in the N Decks. A 409 here is also a compromise signal: someone else is
// draining this bot's updates.
//
// AUTHORISATION: the bot's username is public, so anyone can message it. There
// is no API-level allow-list — the lock is ours: an update whose chat id is not
// a known binding is dropped before it can touch the database.

import type { Approval } from "../shared/types.ts";
import {
  ALREADY_HANDLED_NOTICE,
  decodeCallback,
  encodeCallback,
  renderSettled,
  renderTelegram,
} from "./format.ts";
import type {
  ChannelBinding,
  ChannelHost,
  InboundAnswer,
  NotificationChannel,
  PostedMessage,
} from "./types.ts";

const API = "https://api.telegram.org";
/** Long-poll leg. Telegram holds the request open for up to this long. */
const POLL_TIMEOUT_SEC = 30;

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number } };
  };
}

export interface TelegramDeps {
  token: string;
  host: ChannelHost;
  /** Resolve the binding an address maps to, or null when unknown. */
  bindingFor: (address: string) => ChannelBinding | null;
  /** Resolve which approval a replied-to message belongs to. */
  approvalForMessage: (address: string, externalRef: string) => string | null;
  fetchImpl?: typeof fetch;
}

export class TelegramChannel implements NotificationChannel {
  readonly kind = "telegram" as const;
  private offset = 0;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(private readonly deps: TelegramDeps) {}

  isReady(): boolean {
    return this.running;
  }

  private async call<T>(method: string, body: unknown): Promise<T | null> {
    const f = this.deps.fetchImpl ?? fetch;
    try {
      const res = await f(`${API}/bot${this.deps.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 20) * 1000),
      });
      if (res.status === 409) {
        // Another consumer is draining this bot: ours will never see an update.
        this.deps.host.log.error(
          "telegram: 409 Conflict — another process is polling this bot token (compromise or duplicate broker?)"
        );
        return null;
      }
      if (!res.ok) {
        this.deps.host.log.error(`telegram: ${method} failed with ${res.status}`);
        return null;
      }
      const json = (await res.json()) as { ok: boolean; result?: T };
      return json.ok ? (json.result ?? null) : null;
    } catch (e) {
      this.deps.host.log.error(`telegram: ${method} threw`, e);
      return null;
    }
  }

  /** Verify the token and learn the bot username (shown in the Deck). */
  async describe(): Promise<{ username: string } | null> {
    const me = await this.call<{ username?: string }>("getMe", {});
    return me?.username ? { username: me.username } : null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.pump();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  private async pump(): Promise<void> {
    while (this.running) {
      const updates = await this.call<TgUpdate[]>("getUpdates", {
        offset: this.offset,
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: ["message", "callback_query"],
      });
      if (!this.running) return;
      if (!updates) {
        // Backoff so a persistent failure does not hot-loop the daemon.
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.update_id + 1);
        try {
          await this.handle(u);
        } catch (e) {
          this.deps.host.log.error(`telegram: update ${u.update_id} failed`, e);
        }
      }
    }
  }

  private async handle(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      const address = String(u.callback_query.from.id);
      const decoded = decodeCallback(u.callback_query.data ?? "");
      if (!decoded) return;
      // Unknown sender: drop it. No binding, no database write, no reply.
      if (!this.deps.bindingFor(address)) return;
      if (decoded.action === "text") {
        await this.call("answerCallbackQuery", {
          callback_query_id: u.callback_query.id,
          text: "Reply to the message with your instructions.",
        });
        return;
      }
      const settled = await this.deps.host.onAnswer("telegram", {
        approvalId: decoded.approvalId,
        answerKind: decoded.action,
        fromAddress: address,
        ack: u.callback_query.id,
      });
      await this.call("answerCallbackQuery", {
        callback_query_id: u.callback_query.id,
        text: settled ? "Sent." : ALREADY_HANDLED_NOTICE,
        show_alert: !settled,
      });
      return;
    }

    const msg = u.message;
    if (!msg?.text) return;
    const address = String(msg.chat.id);

    // Pairing: `/start <code>` is the deep-link payload the Deck shows as a QR.
    const start = /^\/start(?:\s+(\S+))?/.exec(msg.text);
    if (start) {
      const code = start[1] ?? "";
      const bound = code
        ? await this.deps.host.onPair("telegram", code, address, msg.from?.username ?? "")
        : null;
      await this.call("sendMessage", {
        chat_id: address,
        text: bound
          ? "Paired. Approvals from your Koryphaios sessions will arrive here."
          : "Send the pairing link shown in Koryphaios (Settings > Notifications) to connect this chat.",
      });
      return;
    }

    const binding = this.deps.bindingFor(address);
    if (!binding) return; // stranger: silently ignored

    // A free-text answer must say WHICH request it answers: that is what the
    // reply-to gives us. A bare message with no reply is ambiguous by nature.
    const repliedTo = msg.reply_to_message?.message_id;
    const approvalId = repliedTo
      ? this.deps.approvalForMessage(address, String(repliedTo))
      : null;
    if (!approvalId) {
      await this.call("sendMessage", {
        chat_id: address,
        reply_parameters: { message_id: msg.message_id },
        text: "Reply directly to a request message so I know which one you are answering.",
      });
      return;
    }

    const settled = await this.deps.host.onAnswer("telegram", {
      approvalId,
      answerKind: "text",
      answerText: msg.text,
      fromAddress: address,
    });
    await this.call("sendMessage", {
      chat_id: address,
      reply_parameters: { message_id: msg.message_id },
      text: settled ? "Sent to the agent." : ALREADY_HANDLED_NOTICE,
    });
  }

  async post(binding: ChannelBinding, approval: Approval): Promise<PostedMessage | null> {
    const keyboard =
      approval.kind === "permission"
        ? {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: encodeCallback("allow", approval.id) },
                { text: "Reject", callback_data: encodeCallback("deny", approval.id) },
              ],
            ],
          }
        : undefined;
    const sent = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: binding.address,
      text: renderTelegram(approval),
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return sent ? { external_ref: String(sent.message_id) } : null;
  }

  async settle(
    binding: ChannelBinding,
    posted: PostedMessage,
    approval: Approval,
    viaLabel: string
  ): Promise<void> {
    await this.call("editMessageText", {
      chat_id: binding.address,
      message_id: Number(posted.external_ref),
      text: renderSettled(approval, viaLabel),
      // Drop the buttons: a settled request must not look actionable.
      reply_markup: { inline_keyboard: [] },
    });
  }

  async rejectLate(binding: ChannelBinding, answer: InboundAnswer): Promise<void> {
    if (answer.ack) {
      await this.call("answerCallbackQuery", {
        callback_query_id: answer.ack,
        text: ALREADY_HANDLED_NOTICE,
        show_alert: true,
      });
      return;
    }
    await this.call("sendMessage", { chat_id: binding.address, text: ALREADY_HANDLED_NOTICE });
  }
}
