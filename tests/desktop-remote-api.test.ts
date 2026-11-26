// Runs the real companion shim (connectRemoteApi) over a fake WebSocket, to see
// what the page keeps from its URL fragment and what it leaves in the address bar.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://10.0.0.20:8443/" });

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as sharedCompanion from "../desktop/src/shared/companion.ts";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

mock.module("@shared/companion", () => sharedCompanion);

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

const REMOTE = "../desktop/src/renderer/src/remote-api.ts";
const ID = "0bc8cbab-3a77-440d-b5ea-d1bc649e2907";

type RemoteApi = typeof import("../desktop/src/renderer/src/remote-api.ts");

// A fresh module record per test: the shim keeps its socket and state at module level.
async function freshShim(name: string): Promise<RemoteApi> {
  return (await import(`${REMOTE}?${name}`)) as RemoteApi;
}

beforeEach(() => {
  sessionStorage.clear();
  FakeSocket.last = null;
});

test("a page opened on #t=&a= hands the approval out once and leaves an empty fragment", async () => {
  const shim = await freshShim("welcome");
  window.location.hash = `#t=tok_1&a=${ID}`;
  const connected = shim.connectRemoteApi();
  const sock = FakeSocket.last!;
  sock.readyState = FakeSocket.OPEN;
  sock.onopen?.();
  expect(JSON.parse(sock.sent[0]!)).toEqual({ t: "hello", token: "tok_1" });
  sock.onmessage?.({ data: JSON.stringify({ t: "welcome", cred: "cred-1" }) });
  await connected;
  sock.readyState = FakeSocket.CLOSED;
  expect(shim.takeDeepLinkApproval()).toBe(ID);
  expect(shim.takeDeepLinkApproval(), "the approval is handed out once").toBeNull();
  expect(window.location.hash).toBe("");
});

test("a resumed page opened on #a= alone also clears its fragment before connecting", async () => {
  const shim = await freshShim("resume");
  sessionStorage.setItem(sharedCompanion.COMPANION_CRED_STORAGE_KEY, "cred-2");
  window.location.hash = `#a=${ID}`;
  const connected = shim.connectRemoteApi();
  expect(window.location.hash).toBe("");
  const sock = FakeSocket.last!;
  sock.onopen?.();
  expect(JSON.parse(sock.sent[0]!)).toEqual({ t: "hello", cred: "cred-2" });
  sock.onmessage?.({ data: JSON.stringify({ t: "welcome", cred: "" }) });
  await connected;
  expect(shim.takeDeepLinkApproval()).toBe(ID);
});

test("a connection refused before welcome leaves neither the token nor the approval in the URL", async () => {
  const shim = await freshShim("refused");
  window.location.hash = `#t=tok_2&a=${ID}`;
  const connected = shim.connectRemoteApi();
  expect(window.location.hash, "cleared before the socket is even answered").toBe("");
  FakeSocket.last!.onclose?.();
  await expect(connected).rejects.toThrow("companion connection refused");
  expect(window.location.href).not.toContain("tok_2");
  expect(window.location.href).not.toContain(ID);
});
