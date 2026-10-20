// APPROVALS mode of the Android shell (PLAN N5): the pairing and the inbox.
//
// The two properties this suite exists to hold:
//  1. approval mode is INDEPENDENT of companion mode — separate state, and it
//     works with no Deck reachable at all;
//  2. a settled request disappears from the phone, because ntfy cannot edit a
//     delivered message and the closing message is what replaces the rewrite.

import { describe, expect, test } from "bun:test";
import {
  adoptPairing,
  answerBody,
  APPROVAL_KEY,
  authHeaders,
  confirmPairing,
  forgetPairing,
  loadPairing,
  pairingBody,
  repliesUrl,
  subscribeUrl,
} from "../desktop/mobile-shell/src/approval-pairing.ts";
import {
  acceptsFreeText,
  ANSWER_GRACE_MS,
  answerRequest,
  applyEffect,
  awaitingBroker,
  classify,
  createLineSplitter,
  INBOX_KEY,
  loadInbox,
  MAX_PENDING,
  nextGraceDelay,
  parseStreamLine,
  PENDING_TTL_MS,
  prune,
  receive,
  saveInbox,
  type PendingApproval,
} from "../desktop/mobile-shell/src/approval-inbox.ts";
import { addHost, HOSTS_KEY, loadHosts, parseCompanionQr } from "../desktop/mobile-shell/src/paired-hosts.ts";
import { MemoryStore } from "../desktop/mobile-shell/src/storage.ts";
import {
  approvalClickUrl,
  decodeInbound,
  encodePairingPayload,
  noticeClickUrl,
  pairedClickUrl,
  settledClickUrl,
} from "../notify/ntfy-protocol.ts";

const T0 = 1_700_000_000_000;

const request = (id: string, withButtons = true): Record<string, unknown> => ({
  id: `m-${id}`,
  event: "message",
  title: "bureau · koryphaios · Bash",
  message: "Allow `npm test`?",
  click: approvalClickUrl(id),
  ...(withButtons ? { actions: [{}, {}] } : {}),
});
const PAYLOAD = encodePairingPayload({
  server: "https://ntfy.example",
  topic_notif: "n".repeat(48),
  topic_replies: "r".repeat(48),
  token: "tk_secret",
  code: "code-1",
});

describe("adopting the approvals pairing", () => {
  test("a scanned payload is stored and survives a reload", () => {
    const store = new MemoryStore();
    const pairing = adoptPairing(store, PAYLOAD, T0, "Pixel 8")!;
    expect(pairing.server).toBe("https://ntfy.example");
    expect(pairing.confirmed).toBe(false);
    expect(loadPairing(store)?.topic_notif).toBe("n".repeat(48));
  });

  test("a COMPANION QR is refused here — the two QRs do not overlap", () => {
    const store = new MemoryStore();
    expect(adoptPairing(store, "https://192.168.1.20:8443/#t=tok", T0, "Pixel 8")).toBeNull();
    expect(loadPairing(store)).toBeNull();
  });

  test("junk and a foreign envelope are refused", () => {
    const store = new MemoryStore();
    expect(adoptPairing(store, "hello", T0, "d")).toBeNull();
    expect(adoptPairing(store, JSON.stringify({ v: 1, mode: "other" }), T0, "d")).toBeNull();
  });

  test("confirming drops the one-shot code but keeps the pairing", () => {
    const store = new MemoryStore();
    adoptPairing(store, PAYLOAD, T0, "Pixel 8");
    const confirmed = confirmPairing(store)!;
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.code).toBe("");
    expect(loadPairing(store)?.topic_replies).toBe("r".repeat(48));
  });

  test("confirming with nothing paired is a no-op", () => {
    expect(confirmPairing(new MemoryStore())).toBeNull();
  });

  test("a corrupted or truncated pairing reads as 'not paired'", () => {
    expect(loadPairing(new MemoryStore({ [APPROVAL_KEY]: "{oops" }))).toBeNull();
    expect(
      loadPairing(new MemoryStore({ [APPROVAL_KEY]: JSON.stringify({ server: "https://x" }) }))
    ).toBeNull();
  });
});

describe("the two pairings are independent (the N5 split)", () => {
  test("forgetting every companion host leaves approvals paired", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr("https://192.168.1.20:8443/#t=tok")!, T0);
    adoptPairing(store, PAYLOAD, T0, "Pixel 8");
    store.remove(HOSTS_KEY);
    expect(loadHosts(store).hosts).toHaveLength(0);
    // A phone with no Deck in reach must still be able to answer.
    expect(loadPairing(store)).not.toBeNull();
  });

  test("unpairing approvals leaves the companion hosts alone", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr("https://192.168.1.20:8443/#t=tok")!, T0);
    adoptPairing(store, PAYLOAD, T0, "Pixel 8");
    forgetPairing(store);
    expect(loadPairing(store)).toBeNull();
    expect(loadHosts(store).hosts).toHaveLength(1);
  });

  test("the inbox is emptied with the pairing, not with the Decks", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr("https://192.168.1.20:8443/#t=tok")!, T0);
    adoptPairing(store, PAYLOAD, T0, "Pixel 8");
    saveInbox(store, applyEffect([], classify(request("appr-1"), T0), T0));
    expect(loadInbox(store, T0)).toHaveLength(1);

    // Forgetting a Deck must leave the waiting requests alone: they came from
    // the broker, not from that Deck, and may not concern it at all.
    store.remove(HOSTS_KEY);
    expect(loadInbox(store, T0)).toHaveLength(1);
    expect(loadPairing(store)).not.toBeNull();
  });
});

describe("what the phone sends", () => {
  test("the handshake carries the code and the device name", () => {
    const store = new MemoryStore();
    const pairing = adoptPairing(store, PAYLOAD, T0, "Pixel 8")!;
    expect(decodeInbound(pairingBody(pairing))).toEqual({
      t: "pair",
      code: "code-1",
      device: "Pixel 8",
    });
  });

  test("an answer is a valid inbound envelope the broker will accept", () => {
    const store = new MemoryStore();
    const pairing = adoptPairing(store, PAYLOAD, T0, "Pixel 8")!;
    expect(decodeInbound(answerBody(pairing, "appr-1", "allow"))).toMatchObject({
      t: "answer",
      approvalId: "appr-1",
      kind: "allow",
    });
    expect(decodeInbound(answerBody(pairing, "appr-1", "text", "use staging"))).toMatchObject({
      kind: "text",
      text: "use staging",
      device: "Pixel 8",
    });
  });

  test("both legs are plain URLs on the paired server, and auth is optional", () => {
    const store = new MemoryStore();
    const pairing = adoptPairing(store, PAYLOAD, T0, "Pixel 8")!;
    expect(subscribeUrl(pairing)).toBe(`https://ntfy.example/${"n".repeat(48)}/json`);
    expect(subscribeUrl(pairing, "m7")).toContain("since=m7");
    expect(repliesUrl(pairing)).toBe(`https://ntfy.example/${"r".repeat(48)}`);
    expect(authHeaders(pairing)).toEqual({ Authorization: "Bearer tk_secret" });
    expect(authHeaders({ ...pairing, token: "" })).toEqual({});
  });
});

describe("the inbox", () => {
  test("a request becomes a pending row", () => {
    const effect = classify(request("appr-1"), T0);
    expect(effect).toMatchObject({ kind: "add" });
    const pending = applyEffect([], effect, T0);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: "appr-1", hasButtons: true });
  });

  test("an open question arrives without buttons: free text lives in the app", () => {
    const effect = classify(request("appr-2", false), T0);
    expect(applyEffect([], effect, T0)[0]!.hasButtons).toBe(false);
  });

  test("only a question offers free text: a permission takes Approve or Reject", () => {
    const [permission] = applyEffect([], classify(request("appr-p"), T0), T0);
    const [question] = applyEffect([], classify(request("appr-q", false), T0), T0);
    expect(acceptsFreeText(permission!), "the broker refuses text on a permission").toBe(false);
    expect(acceptsFreeText(question!)).toBe(true);
  });

  test("a closing message removes the row — ntfy cannot edit, so this is it", () => {
    let pending = applyEffect([], classify(request("appr-1"), T0), T0);
    pending = applyEffect(
      pending,
      classify({ click: settledClickUrl("appr-1"), message: "handled via deck" }, T0),
      T0
    );
    expect(pending).toHaveLength(0);
  });

  test("a refusal notice says why and keeps the still-pending request, buttons included", () => {
    const pending = applyEffect([], classify(request("appr-1"), T0), T0);
    const effect = classify({ click: noticeClickUrl("appr-1"), message: "Not sent: this request takes Approve or Reject." }, T0);
    expect(effect).toEqual({ kind: "notice", id: "appr-1", text: "Not sent: this request takes Approve or Reject." });
    expect(applyEffect(pending, effect, T0)).toEqual(pending);
  });

  test("a notice from anyone who can publish on the topic shows no control, line break or bidi character", () => {
    const c = String.fromCharCode;
    const p = String.fromCodePoint;
    const hostile = `Not sent:${c(0x1b)}[31m this${c(0x0d)}${c(0x0a)}request${p(0x202e)} takes${c(0x9b)} Approve${p(0x2066)} or Reject.`;
    const effect = classify({ click: noticeClickUrl("appr-1"), message: hostile }, T0);
    expect(effect).toEqual({ kind: "notice", id: "appr-1", text: "Not sent: this request takes Approve or Reject." });
    expect(effect.kind === "notice" && /[\p{Cc}\p{Cf}]/u.test(effect.text), "a control or format character reached the screen").toBe(false);
  });

  test("a closing message for something else leaves the list alone", () => {
    const pending = applyEffect([], classify(request("appr-1"), T0), T0);
    expect(applyEffect(pending, classify({ click: settledClickUrl("other") }, T0), T0)).toHaveLength(1);
  });

  const holder = (initial: PendingApproval[]) => {
    let rows = initial;
    return {
      get: () => rows,
      set: (next: PendingApproval[]) => {
        rows = next;
      },
    };
  };
  const inboxWith = (...ids: string[]) =>
    holder(ids.reduce<PendingApproval[]>((rows, id) => applyEffect(rows, classify(request(id), T0), T0), []));
  const refusal = (id: string) =>
    classify({ click: noticeClickUrl(id), message: "Not sent: this request takes one of its options." }, T0);
  const ids = (rows: PendingApproval[]) => rows.map((p) => p.id);

  test("a sent answer keeps the request, waiting for the broker, across a restart", async () => {
    const inbox = inboxWith("appr-1");
    expect(await answerRequest("appr-1", async () => true, inbox, () => T0 + 1)).toBe(true);
    expect(ids(inbox.get()), "the request stays until the broker settles or refuses it").toEqual(["appr-1"]);
    expect(awaitingBroker(inbox.get()[0]!, T0 + 2)).toBe(true);
    const store = new MemoryStore();
    saveInbox(store, inbox.get());
    expect(awaitingBroker(loadInbox(store, T0 + 2)[0]!, T0 + 2)).toBe(true);
  });

  test("a refused answer leaves the request on the phone, answerable again", async () => {
    const inbox = inboxWith("appr-1");
    await answerRequest("appr-1", async () => true, inbox, () => T0);
    const after = applyEffect(inbox.get(), refusal("appr-1"), T0 + 5);
    expect(ids(after)).toEqual(["appr-1"]);
    expect(awaitingBroker(after[0]!, T0 + 5), "a refusal hands the request back to the operator").toBe(false);
    expect(after[0]!.hasButtons).toBe(true);
  });

  test("a refusal of another request leaves this one waiting", async () => {
    const inbox = inboxWith("appr-1", "appr-2");
    await answerRequest("appr-1", async () => true, inbox, () => T0);
    const after = applyEffect(inbox.get(), refusal("appr-2"), T0 + 5);
    expect(awaitingBroker(after.find((p) => p.id === "appr-1")!, T0 + 5)).toBe(true);
  });

  test("an accepted answer leaves the phone when the broker's closing message arrives", async () => {
    const inbox = inboxWith("appr-1");
    await answerRequest("appr-1", async () => true, inbox, () => T0);
    expect(applyEffect(inbox.get(), classify({ click: settledClickUrl("appr-1") }, T0), T0 + 5)).toEqual([]);
  });

  test("an answer that could not be published leaves the request answerable", async () => {
    const inbox = inboxWith("appr-1");
    expect(await answerRequest("appr-1", async () => false, inbox, () => T0)).toBe(false);
    expect(awaitingBroker(inbox.get()[0]!, T0)).toBe(false);
  });

  test("a request settled while its answer was in flight is not brought back", async () => {
    const inbox = inboxWith("appr-1");
    await answerRequest(
      "appr-1",
      async () => {
        inbox.set(applyEffect(inbox.get(), classify({ click: settledClickUrl("appr-1") }, T0), T0));
        return true;
      },
      inbox,
      () => T0
    );
    expect(inbox.get()).toEqual([]);
  });

  test("ntfy replaying the request does not make it answerable again", async () => {
    const inbox = inboxWith("appr-1");
    await answerRequest("appr-1", async () => true, inbox, () => T0);
    const replayed = applyEffect(inbox.get(), classify(request("appr-1"), T0 + 3), T0 + 3);
    expect(awaitingBroker(replayed[0]!, T0 + 3)).toBe(true);
  });

  test("with no word from the broker, the request is answerable again after the grace period", async () => {
    const inbox = inboxWith("appr-1");
    await answerRequest("appr-1", async () => true, inbox, () => T0);
    const row = inbox.get()[0]!;
    expect(awaitingBroker(row, T0 + ANSWER_GRACE_MS - 1)).toBe(true);
    expect(awaitingBroker(row, T0 + ANSWER_GRACE_MS)).toBe(false);
  });

  test("a waiting row restored after a restart is re-rendered when its grace period ends", async () => {
    const inbox = inboxWith("appr-1");
    await answerRequest("appr-1", async () => true, inbox, () => T0);
    const store = new MemoryStore();
    saveInbox(store, inbox.get());
    const restored = loadInbox(store, T0 + 20_000);
    expect(nextGraceDelay(restored, T0 + 20_000), "the restored row's remaining grace, not a fresh one").toBe(
      ANSWER_GRACE_MS - 20_000
    );
    expect(awaitingBroker(restored[0]!, T0 + 20_000 + nextGraceDelay(restored, T0 + 20_000)!)).toBe(false);
  });

  test("a row whose grace period ran out while the app was closed is answerable on restore", async () => {
    const inbox = inboxWith("appr-1");
    await answerRequest("appr-1", async () => true, inbox, () => T0);
    const store = new MemoryStore();
    saveInbox(store, inbox.get());
    const restored = loadInbox(store, T0 + ANSWER_GRACE_MS + 5);
    expect(awaitingBroker(restored[0]!, T0 + ANSWER_GRACE_MS + 5)).toBe(false);
    expect(nextGraceDelay(restored, T0 + ANSWER_GRACE_MS + 5)).toBeNull();
  });

  test("a row sent 'in the future' after the clock moved back is answerable, with no re-render beyond the grace", async () => {
    const inbox = inboxWith("appr-1");
    await answerRequest("appr-1", async () => true, inbox, () => T0 + 10 * ANSWER_GRACE_MS);
    expect(awaitingBroker(inbox.get()[0]!, T0)).toBe(false);
    expect(nextGraceDelay(inbox.get(), T0)).toBeNull();
  });

  test("the re-render waits for the first waiting row only", async () => {
    const inbox = inboxWith("appr-1", "appr-2", "appr-3");
    await answerRequest("appr-1", async () => true, inbox, () => T0 + 30_000);
    await answerRequest("appr-2", async () => true, inbox, () => T0);
    expect(nextGraceDelay(inbox.get(), T0 + 10_000)).toBe(ANSWER_GRACE_MS - 10_000);
    expect(nextGraceDelay(inboxWith("appr-1").get(), T0), "nothing sent, nothing to wait for").toBeNull();
  });

  test("a received refusal makes the request answerable and shows why", async () => {
    const inbox = inboxWith("appr-1");
    await answerRequest("appr-1", async () => true, inbox, () => T0);
    const message = "Not sent: this request takes one of its options.";
    const step = receive(inbox.get(), { click: noticeClickUrl("appr-1"), message }, T0 + 5, true);
    expect(step?.notice).toBe(message);
    expect(ids(step?.pending ?? [])).toEqual(["appr-1"]);
    expect(awaitingBroker(step!.pending![0]!, T0 + 5), "the refusal hands the request back").toBe(false);
  });

  test("a received closing message removes the request", async () => {
    const inbox = inboxWith("appr-1", "appr-2");
    await answerRequest("appr-1", async () => true, inbox, () => T0);
    const step = receive(inbox.get(), { click: settledClickUrl("appr-1") }, T0 + 5, true);
    expect(ids(step?.pending ?? [])).toEqual(["appr-2"]);
    expect(step?.notice, "a closing message leaves the notice line alone").toBeNull();
  });

  test("a received request confirms a pairing whose acknowledgement was lost", () => {
    const unconfirmed = receive([], request("appr-1"), T0, false);
    expect(unconfirmed).toMatchObject({ confirmsPairing: true, notice: "" });
    expect(ids(unconfirmed!.pending!)).toEqual(["appr-1"]);
    expect(receive([], request("appr-1"), T0, true)).toMatchObject({ confirmsPairing: false, notice: null });
  });

  test("a pairing reply touches the notice and the pairing, never the inbox", () => {
    const rows = inboxWith("appr-1").get();
    expect(receive(rows, { click: pairedClickUrl(true), message: "Paired." }, T0, false)).toEqual({
      pending: null,
      notice: "",
      confirmsPairing: true,
    });
    expect(receive(rows, { click: pairedClickUrl(false), message: "Refused." }, T0, false)).toEqual({
      pending: null,
      notice: "Refused.",
      confirmsPairing: false,
    });
    expect(receive(rows, { event: "keepalive" }, T0, false)).toBeNull();
  });

  test("a replayed push does not produce two rows", () => {
    let pending = applyEffect([], classify(request("appr-1"), T0), T0);
    pending = applyEffect(pending, classify(request("appr-1"), T0 + 10), T0 + 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.receivedAt).toBe(T0 + 10);
  });

  test("the broker's pairing ack is routed, not swallowed", () => {
    expect(classify({ click: pairedClickUrl(true), message: "Paired." }, T0)).toEqual({
      kind: "paired",
      ok: true,
      text: "Paired.",
    });
    expect(classify({ click: pairedClickUrl(false), message: "unknown" }, T0)).toMatchObject({
      kind: "paired",
      ok: false,
    });
    // And it is not a request: it must never appear in the pending list.
    expect(applyEffect([], classify({ click: pairedClickUrl(true) }, T0), T0)).toEqual([]);
  });

  test("keepalives, foreign links and junk are ignored", () => {
    expect(classify({ event: "keepalive" }, T0)).toEqual({ kind: "ignore" });
    expect(classify({ click: "https://evil.example/approval/x" }, T0)).toEqual({ kind: "ignore" });
    expect(classify({ message: "hello" }, T0)).toEqual({ kind: "ignore" });
    expect(applyEffect([], { kind: "ignore" }, T0)).toEqual([]);
  });

  test("titles and bodies are capped, never trusted for anything but display", () => {
    const effect = classify(
      { click: approvalClickUrl("appr-1"), title: "T".repeat(500), message: "Q".repeat(5000) },
      T0
    );
    expect(effect.kind).toBe("add");
    if (effect.kind !== "add") return;
    expect(effect.approval.title.length).toBe(200);
    expect(effect.approval.body.length).toBe(2000);
  });

  test("rows older than the broker's own expiry fall off", () => {
    const old: PendingApproval = {
      id: "old",
      title: "",
      body: "",
      hasButtons: false,
      receivedAt: T0,
    };
    expect(prune([old], T0 + PENDING_TTL_MS + 1)).toHaveLength(0);
    expect(prune([old], T0 + PENDING_TTL_MS - 1)).toHaveLength(1);
  });

  test("the list is capped", () => {
    let pending: PendingApproval[] = [];
    for (let i = 0; i < MAX_PENDING + 5; i++) {
      pending = applyEffect(pending, classify(request(`a${i}`), T0 + i), T0 + i);
    }
    expect(pending).toHaveLength(MAX_PENDING);
    // Newest first: the most recent request is the one the operator sees.
    expect(pending[0]!.id).toBe(`a${MAX_PENDING + 4}`);
  });

  test("the inbox round-trips through storage and is pruned on load", () => {
    const store = new MemoryStore();
    const pending = applyEffect([], classify(request("appr-1"), T0), T0);
    saveInbox(store, pending);
    expect(loadInbox(store, T0)).toHaveLength(1);
    expect(loadInbox(store, T0 + PENDING_TTL_MS + 1)).toHaveLength(0);
  });

  test("a corrupted inbox reads as empty", () => {
    expect(loadInbox(new MemoryStore({ [INBOX_KEY]: "{oops" }), T0)).toEqual([]);
    expect(loadInbox(new MemoryStore({ [INBOX_KEY]: JSON.stringify([null, {}, 7]) }), T0)).toEqual([]);
  });
});

describe("the stream splitter", () => {
  test("keeps the remainder when a chunk cuts a line in half", () => {
    const split = createLineSplitter();
    expect(split('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(split('2}\n')).toEqual(['{"b":2}']);
  });

  test("blank lines produce nothing, and several lines arrive at once", () => {
    const split = createLineSplitter();
    expect(split("\n\n")).toEqual([]);
    expect(split("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  test("an endless line cannot grow the buffer without bound", () => {
    const split = createLineSplitter(64);
    expect(split("x".repeat(200))).toEqual([]);
    // The buffer was dropped, so the tail of the garbage does not become a
    // line once a newline finally shows up.
    expect(split("tail\n")).toEqual(["tail"]);
  });

  test("parseStreamLine refuses arrays, scalars and junk", () => {
    expect(parseStreamLine('{"id":"m1"}')).toEqual({ id: "m1" });
    expect(parseStreamLine("[1,2]")).toBeNull();
    expect(parseStreamLine('"plain"')).toBeNull();
    expect(parseStreamLine("nope")).toBeNull();
  });
});
