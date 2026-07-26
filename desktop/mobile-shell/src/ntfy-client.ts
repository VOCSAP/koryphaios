// The phone's two legs to ntfy (PLAN N5), mirror image of the broker's.
//
//   phone ──GET  /{topic_notif}/json   (held open) ──▶ questions arrive
//   phone ──POST /{topic_replies}      ─────────────▶ answers go out
//
// Both outgoing, like every other leg in this feature: the phone opens no port
// and publishes no address either.
//
// This is the FOREGROUND transport — what runs while the app is on screen.
// Passive listening with the screen off cannot be done from a WebView at all
// (Doze suspends network access), which is what the native foreground service
// in `android-src/` is for. Keeping the two apart means the app is fully
// usable, and fully testable, without the native half.

import { createLineSplitter, parseStreamLine, type NtfyMessage } from "./approval-inbox.ts";
import { authHeaders, repliesUrl, subscribeUrl, type ApprovalPairing } from "./approval-pairing.ts";

export interface NtfyClientDeps {
  fetchImpl?: typeof fetch;
  /** Injected so tests do not wait seconds for a reconnect. */
  reconnectMs?: number;
  onError?: (message: string) => void;
}

/** Publish one message on the replies topic. Returns false on any failure. */
export async function publish(
  pairing: ApprovalPairing,
  body: string,
  deps: NtfyClientDeps = {}
): Promise<boolean> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(repliesUrl(pairing), {
      method: "POST",
      headers: { "content-type": "text/plain", ...authHeaders(pairing) },
      body,
    });
    if (!res.ok) {
      deps.onError?.(`ntfy refused the answer (${res.status})`);
      return false;
    }
    return true;
  } catch {
    deps.onError?.("no connection — the answer was not sent");
    return false;
  }
}

export interface Subscription {
  stop: () => void;
}

/**
 * Hold the notification topic open, reconnecting until stopped.
 *
 * `since` advances to the last message id so a reconnect resumes rather than
 * replays the retained backlog — the same rule as the broker's inbound leg,
 * and the reason a phone coming back from a tunnel does not get an avalanche.
 */
export function subscribe(
  pairing: ApprovalPairing,
  onMessage: (msg: NtfyMessage) => void,
  deps: NtfyClientDeps = {}
): Subscription {
  const f = deps.fetchImpl ?? fetch;
  const wait = deps.reconnectMs ?? 5_000;
  let running = true;
  let since = "";
  let abort: AbortController | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const loop = async (): Promise<void> => {
    while (running) {
      const controller = new AbortController();
      abort = controller;
      try {
        const res = await f(subscribeUrl(pairing, since), {
          method: "GET",
          headers: authHeaders(pairing),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          deps.onError?.(`ntfy subscription answered ${res.status}`);
        } else {
          reader = res.body.getReader();
          const split = createLineSplitter();
          const decoder = new TextDecoder();
          while (running) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of split(decoder.decode(value, { stream: true }))) {
              const msg = parseStreamLine(line);
              if (!msg) continue;
              if (msg.id) since = msg.id;
              onMessage(msg);
            }
          }
        }
      } catch {
        // An abort is our own stop(); anything else is a dropped connection.
        if (running) deps.onError?.("connection to ntfy lost — retrying");
      }
      reader = null;
      if (!running) return;
      await new Promise((r) => setTimeout(r, wait));
    }
  };

  void loop();

  return {
    stop: () => {
      running = false;
      try {
        abort?.abort();
      } catch {
        /* already aborted */
      }
      void reader?.cancel().catch(() => undefined);
    },
  };
}
