// The shell's own UI (PLAN N5).
//
// Deliberately tiny and framework-free. The shell embeds no application UI:
// companion mode navigates to the Deck-served renderer, so anything drawn here
// exists only because it CANNOT come from a host — the host list (you pick a
// Deck before you have one) and the approvals screen (which must work when no
// Deck is reachable at all).
//
// The free-text answer box is the reason the approvals screen exists rather
// than leaning on the official ntfy app: an ntfy action button carries a FIXED
// body, so "Approve"/"Reject" can be buttons but "use the staging bucket
// instead" cannot (EXPLORATION §4.3c).
//
// All decision logic lives in the sibling modules, which run under `bun test`.
// This file is wiring and DOM.

import {
  applyEffect,
  classify,
  loadInbox,
  saveInbox,
  type PendingApproval,
} from "./approval-inbox.ts";
import {
  adoptPairing,
  answerBody,
  confirmPairing,
  forgetPairing,
  loadPairing,
  pairingBody,
  type ApprovalPairing,
} from "./approval-pairing.ts";
import { publish, subscribe, type Subscription } from "./ntfy-client.ts";
import {
  absorbPendingCredential,
  addHost,
  companionResumeScript,
  loadHosts,
  navigationUrl,
  parseCompanionQr,
  PENDING_CRED_KEY,
  removeHost,
  selectHost,
  type PairedHost,
} from "./paired-hosts.ts";
import {
  deviceName,
  openHost,
  openStore,
  reloadKey,
  scanQr,
  startApprovalService,
  stopApprovalService,
} from "./platform.ts";
import type { KeyValueStore } from "./storage.ts";

type Mode = "companion" | "approvals";

let store: KeyValueStore;
let mode: Mode = "companion";
let pending: PendingApproval[] = [];
let pairing: ApprovalPairing | null = null;
let stream: Subscription | null = null;
let device = "phone";
let notice = "";
/** URL -> fresh QR token, held in memory only: it is single use. */
const tokens = new Map<string, string>();

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function setNotice(text: string): void {
  notice = text;
  render();
}

// ---------------------------------------------------------------------------
// Companion mode
// ---------------------------------------------------------------------------

async function scanCompanion(): Promise<void> {
  const raw = await scanQr("Host URL (https://<lan-ip>:<port>/#t=<token>)");
  if (!raw) return;
  const qr = parseCompanionQr(raw);
  if (!qr) {
    setNotice("That QR is not a Koryphaios companion code.");
    return;
  }
  tokens.set(qr.url, qr.token);
  addHost(store, qr, Date.now());
  setNotice("");
}

async function open(host: PairedHost): Promise<void> {
  const token = tokens.get(host.url) ?? "";
  const url = navigationUrl(host, token);
  if (!url) {
    setNotice("This Deck needs a fresh QR: scan it again from the Companion dialog.");
    return;
  }
  selectHost(store, host.url);
  // The token is single use: drop it so a second attempt does not reuse a
  // consumed one and land on the re-scan screen with no explanation.
  tokens.delete(host.url);
  await openHost({
    url,
    fingerprint: host.fingerprint,
    seedScript: token ? "" : companionResumeScript(host),
  });
}

// ---------------------------------------------------------------------------
// Approvals mode
// ---------------------------------------------------------------------------

async function scanApprovals(): Promise<void> {
  const raw = await scanQr("Paste the pairing payload from Settings > Notifications");
  if (!raw) return;
  const adopted = adoptPairing(store, raw, Date.now(), device);
  if (!adopted) {
    setNotice("That QR is not a Koryphaios approvals code.");
    return;
  }
  pairing = adopted;
  await startStream();
  // Announce ourselves: the broker binds the topic to this operator on it.
  const sent = await publish(pairing, pairingBody(pairing), { onError: setNotice });
  setNotice(sent ? "Pairing sent — waiting for confirmation." : notice);
  render();
}

async function startStream(): Promise<void> {
  stream?.stop();
  stream = null;
  if (!pairing) return;
  pending = loadInbox(store, Date.now());
  stream = subscribe(pairing, onMessage, { onError: setNotice });
  // Passive listening with the screen off needs the native service; without
  // it the app still works, in the foreground only.
  await startApprovalService({
    server: pairing.server,
    topic: pairing.topic_notif,
    token: pairing.token,
  });
}

function onMessage(msg: Parameters<typeof classify>[0]): void {
  const effect = classify(msg, Date.now());
  if (effect.kind === "ignore") return;
  // The first thing that arrives after a scan is the broker's acknowledgement.
  if (pairing && !pairing.confirmed) {
    pairing = confirmPairing(store) ?? pairing;
    notice = "";
  }
  pending = applyEffect(pending, effect, Date.now());
  saveInbox(store, pending);
  render();
}

async function answer(
  approval: PendingApproval,
  kind: "allow" | "deny" | "text",
  text = ""
): Promise<void> {
  if (!pairing) return;
  const ok = await publish(pairing, answerBody(pairing, approval.id, kind, text), {
    onError: setNotice,
  });
  if (!ok) return;
  // Optimistic removal: the broker settles it and publishes the closing
  // message, but the row must not sit there looking unanswered meanwhile. If
  // the answer lost the race, the closing message says so — and it is already
  // gone from the list either way.
  pending = pending.filter((p) => p.id !== approval.id);
  saveInbox(store, pending);
  setNotice("Sent.");
}

async function unpair(): Promise<void> {
  stream?.stop();
  stream = null;
  await stopApprovalService();
  forgetPairing(store);
  pairing = null;
  pending = [];
  saveInbox(store, pending);
  setNotice("");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(tag: string, className = "", text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML: titles and questions are written by an
  // AGENT, and the phone is the last place that string is displayed.
  if (text) node.textContent = text;
  return node;
}

function renderCompanion(root: HTMLElement): void {
  const state = loadHosts(store);
  const scan = el("button", "primary", "Scan a Deck QR") as HTMLButtonElement;
  scan.onclick = () => void scanCompanion();
  root.append(scan);

  if (state.hosts.length === 0) {
    root.append(
      el(
        "p",
        "hint",
        "No Deck paired yet. Open the Companion dialog on the desktop app and scan the code — on the same Wi-Fi."
      )
    );
    return;
  }

  const list = el("ul", "list");
  for (const host of state.hosts) {
    const row = el("li", host.url === state.selected ? "row is-selected" : "row");
    const name = el("div", "grow");
    name.append(el("strong", "", host.label));
    const bits = [host.fingerprint ? "pinned" : "not pinned"];
    if (tokens.has(host.url)) bits.push("fresh code");
    else if (host.credential) bits.push("can resume");
    name.append(el("small", "", `${host.url} · ${bits.join(" · ")}`));
    row.append(name);

    const openBtn = el("button", "", "Open") as HTMLButtonElement;
    openBtn.onclick = () => void open(host);
    row.append(openBtn);

    const forget = el("button", "danger", "Forget") as HTMLButtonElement;
    forget.onclick = () => {
      removeHost(store, host.url);
      render();
    };
    row.append(forget);
    list.append(row);
  }
  root.append(list);
}

function renderApprovals(root: HTMLElement): void {
  if (!pairing) {
    const scan = el("button", "primary", "Scan the approvals QR") as HTMLButtonElement;
    scan.onclick = () => void scanApprovals();
    root.append(scan);
    root.append(
      el(
        "p",
        "hint",
        "Settings > Notifications on any of your Decks, Connect on the Koryphaios mobile row. This pairing reaches you anywhere — it has nothing to do with Wi-Fi."
      )
    );
    return;
  }

  const head = el("div", "row");
  const info = el("div", "grow");
  info.append(el("strong", "", pairing.confirmed ? "Paired" : "Waiting for confirmation…"));
  info.append(el("small", "", new URL(pairing.server).host));
  head.append(info);
  const drop = el("button", "danger", "Unpair") as HTMLButtonElement;
  drop.onclick = () => void unpair();
  head.append(drop);
  root.append(head);

  if (pending.length === 0) {
    root.append(el("p", "hint", "Nothing waiting. Requests appear here as they arrive."));
    return;
  }

  const list = el("ul", "list");
  for (const approval of pending) {
    const card = el("li", "card");
    card.append(el("strong", "", approval.title));
    card.append(el("pre", "body", approval.body));

    if (approval.hasButtons) {
      const actions = el("div", "row");
      const yes = el("button", "primary", "Approve") as HTMLButtonElement;
      yes.onclick = () => void answer(approval, "allow");
      const no = el("button", "danger", "Reject") as HTMLButtonElement;
      no.onclick = () => void answer(approval, "deny");
      actions.append(yes, no);
      card.append(actions);
    }

    // The free-text box: the whole reason this screen exists.
    const compose = el("div", "row");
    const input = el("input", "grow") as HTMLInputElement;
    input.placeholder = "Answer in your own words…";
    input.autocomplete = "off";
    const send = el("button", "", "Send") as HTMLButtonElement;
    send.onclick = () => {
      const text = input.value.trim();
      if (!text) return;
      void answer(approval, "text", text);
    };
    compose.append(input, send);
    card.append(compose);
    list.append(card);
  }
  root.append(list);
}

function render(): void {
  const tabs = $("tabs");
  tabs.replaceChildren();
  for (const m of ["companion", "approvals"] as Mode[]) {
    const tab = el("button", m === mode ? "tab is-active" : "tab", m === "companion" ? "Companion" : "Approvals");
    tab.onclick = () => {
      mode = m;
      render();
    };
    tabs.append(tab);
  }

  const root = $("view");
  root.replaceChildren();
  if (notice) root.append(el("p", "notice", notice));
  if (mode === "companion") renderCompanion(root);
  else renderApprovals(root);
}

/**
 * Collect whatever the native viewer harvested while we were backgrounded.
 *
 * This is the step that makes "restarting the app does not ask for a new QR"
 * true: the credential is minted by the host into the WebView's
 * sessionStorage, which does not survive the app, so the viewer copies it out
 * and the shell folds it into the host list here.
 */
async function collectCredential(): Promise<void> {
  await reloadKey(store, PENDING_CRED_KEY);
  absorbPendingCredential(store, Date.now());
}

export async function boot(): Promise<void> {
  store = await openStore();
  device = await deviceName();
  await collectCredential();
  pairing = loadPairing(store);
  pending = loadInbox(store, Date.now());
  // Approvals is the mode that works everywhere; open on it when it is set up.
  mode = pairing ? "approvals" : "companion";
  if (pairing) await startStream();
  render();

  // Backing out of a Deck returns here without reloading the page, so the
  // boot-time collection alone would miss the credential just harvested.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      void collectCredential().then(render);
    });
  }
}

if (typeof document !== "undefined") {
  void boot();
}
