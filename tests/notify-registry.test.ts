// Fan-out and settle rules (PLAN N3/N4), exercised with a fake channel so no
// test ever touches Telegram or Discord.

import { test, expect, describe } from "bun:test";
import { NotificationRegistry, type PostedRecord, type RegistryStore } from "../notify/registry.ts";
import type {
  ChannelBinding,
  ChannelKind,
  InboundAnswer,
  NotificationChannel,
  PostedMessage,
} from "../notify/types.ts";
import type { Approval } from "../shared/types.ts";

function approval(patch: Partial<Approval> = {}): Approval {
  return {
    id: "appr-1",
    operator_id: "op-a",
    origin: {
      host: "bureau",
      os_user_hash: "h",
      project_key: "p",
      group_id: "g",
      from_peer: "",
      session_ref: "w",
      tile_ref: "t",
    },
    kind: "permission",
    title: "Bash",
    question: "Allow?",
    options: [],
    status: "pending",
    reply_route: "pty",
    answered_via: null,
    answer_kind: null,
    answer_text: null,
    created_at: "",
    notif_expires_at: "",
    answered_at: null,
    delivered_at: null,
    ...patch,
  } as Approval;
}

function binding(id: string, kind: ChannelKind, operator = "op-a"): ChannelBinding {
  return { id, operator_id: operator, kind, address: `addr-${id}`, label: id, enabled: true };
}

function makeStore(bindings: ChannelBinding[]): RegistryStore & { posts: PostedRecord[] } {
  const posts: PostedRecord[] = [];
  return {
    posts,
    bindingsFor: (operatorId) => bindings.filter((b) => b.operator_id === operatorId && b.enabled),
    binding: (id) => bindings.find((b) => b.id === id) ?? null,
    recordPost: (rec) => {
      posts.push(rec);
    },
    postsFor: (approvalId) => posts.filter((p) => p.approvalId === approvalId),
    clearPosts: (approvalId) => {
      for (let i = posts.length - 1; i >= 0; i--) {
        if (posts[i]!.approvalId === approvalId) posts.splice(i, 1);
      }
    },
  };
}

class FakeChannel implements NotificationChannel {
  posted: Array<{ address: string; approvalId: string }> = [];
  settled: Array<{ ref: string; via: string }> = [];
  rejected: InboundAnswer[] = [];
  ready = true;
  failPost = false;
  private seq = 0;

  constructor(readonly kind: ChannelKind) {}

  isReady(): boolean {
    return this.ready;
  }
  async post(b: ChannelBinding, a: Approval): Promise<PostedMessage | null> {
    if (this.failPost) throw new Error("transport down");
    this.posted.push({ address: b.address, approvalId: a.id });
    return { external_ref: `${this.kind}-${++this.seq}` };
  }
  async settle(_b: ChannelBinding, p: PostedMessage, _a: Approval, via: string): Promise<void> {
    this.settled.push({ ref: p.external_ref, via });
  }
  async rejectLate(_b: ChannelBinding, answer: InboundAnswer): Promise<void> {
    this.rejected.push(answer);
  }
  async stop(): Promise<void> {
    this.ready = false;
  }
}

const silentLog = { info: (): void => undefined, error: (): void => undefined };

describe("fan-out", () => {
  test("every enabled channel of the operator receives the request", async () => {
    const store = makeStore([binding("b1", "telegram"), binding("b2", "discord")]);
    const reg = new NotificationRegistry(store, silentLog);
    const tg = new FakeChannel("telegram");
    const dc = new FakeChannel("discord");
    reg.register("op-a", tg);
    reg.register("op-a", dc);

    expect(await reg.fanOut(approval())).toBe(2);
    expect(tg.posted).toHaveLength(1);
    expect(dc.posted).toHaveLength(1);
  });

  test("it never crosses operators", async () => {
    // The compartmentalisation guarantee, at the notification layer.
    const store = makeStore([binding("b1", "telegram", "op-a"), binding("b2", "telegram", "op-b")]);
    const reg = new NotificationRegistry(store, silentLog);
    const tg = new FakeChannel("telegram");
    reg.register("op-a", tg);

    await reg.fanOut(approval({ operator_id: "op-a" }));
    expect(tg.posted).toHaveLength(1);
    expect(tg.posted[0]!.address).toBe("addr-b1");
  });

  test("each operator is served by THEIR OWN gateway, not the last enrolled", async () => {
    // The bug this keying exists to prevent: with one slot per kind, op-b's
    // gateway replaced op-a's, so op-a went silent and — on ntfy — their
    // questions were published with somebody else's reply topic.
    const store = makeStore([binding("b1", "telegram", "op-a"), binding("b2", "telegram", "op-b")]);
    const reg = new NotificationRegistry(store, silentLog);
    const mine = new FakeChannel("telegram");
    const theirs = new FakeChannel("telegram");
    reg.register("op-a", mine);
    reg.register("op-b", theirs);

    await reg.fanOut(approval({ operator_id: "op-a" }));
    expect(mine.posted).toHaveLength(1);
    expect(theirs.posted).toHaveLength(0);

    await reg.fanOut(approval({ id: "appr-2", operator_id: "op-b" }));
    expect(mine.posted).toHaveLength(1);
    expect(theirs.posted).toHaveLength(1);
  });

  test("an operator with no gateway of that kind is simply not posted to", async () => {
    const store = makeStore([binding("b1", "telegram", "op-a")]);
    const reg = new NotificationRegistry(store, silentLog);
    reg.register("op-b", new FakeChannel("telegram"));
    expect(await reg.fanOut(approval({ operator_id: "op-a" }))).toBe(0);
  });

  test("a channel that is not ready is skipped, not awaited", async () => {
    const store = makeStore([binding("b1", "telegram")]);
    const reg = new NotificationRegistry(store, silentLog);
    const tg = new FakeChannel("telegram");
    tg.ready = false;
    reg.register("op-a", tg);
    expect(await reg.fanOut(approval())).toBe(0);
  });

  test("one dead transport does not stop the others from ringing", async () => {
    const store = makeStore([binding("b1", "telegram"), binding("b2", "discord")]);
    const reg = new NotificationRegistry(store, silentLog);
    const tg = new FakeChannel("telegram");
    tg.failPost = true;
    const dc = new FakeChannel("discord");
    reg.register("op-a", tg);
    reg.register("op-a", dc);

    expect(await reg.fanOut(approval())).toBe(1);
    expect(dc.posted).toHaveLength(1);
  });

  test("a disabled binding is never posted to", async () => {
    const off = { ...binding("b1", "telegram"), enabled: false };
    const store = makeStore([off]);
    const reg = new NotificationRegistry(store, silentLog);
    reg.register("op-a", new FakeChannel("telegram"));
    expect(await reg.fanOut(approval())).toBe(0);
  });
});

describe("settle", () => {
  test("every other copy is rewritten once one channel wins", async () => {
    const store = makeStore([binding("b1", "telegram"), binding("b2", "discord")]);
    const reg = new NotificationRegistry(store, silentLog);
    const tg = new FakeChannel("telegram");
    const dc = new FakeChannel("discord");
    reg.register("op-a", tg);
    reg.register("op-a", dc);

    const a = approval();
    await reg.fanOut(a);
    // Telegram won: it already told its own user, so it is skipped.
    await reg.settle({ ...a, status: "answered", answered_via: "telegram" }, "telegram", "telegram");

    expect(tg.settled).toHaveLength(0);
    expect(dc.settled).toHaveLength(1);
    expect(dc.settled[0]!.via).toBe("telegram");
  });

  test("a Deck answer rewrites ALL channel copies", async () => {
    const store = makeStore([binding("b1", "telegram"), binding("b2", "discord")]);
    const reg = new NotificationRegistry(store, silentLog);
    const tg = new FakeChannel("telegram");
    const dc = new FakeChannel("discord");
    reg.register("op-a", tg);
    reg.register("op-a", dc);

    const a = approval();
    await reg.fanOut(a);
    await reg.settle({ ...a, status: "answered" }, "deck");

    expect(tg.settled).toHaveLength(1);
    expect(dc.settled).toHaveLength(1);
  });

  test("posted copies are forgotten after settling, so nothing is rewritten twice", async () => {
    const store = makeStore([binding("b1", "telegram")]);
    const reg = new NotificationRegistry(store, silentLog);
    const tg = new FakeChannel("telegram");
    reg.register("op-a", tg);

    const a = approval();
    await reg.fanOut(a);
    await reg.settle(a, "deck");
    await reg.settle(a, "deck");
    expect(tg.settled).toHaveLength(1);
    expect(store.posts).toHaveLength(0);
  });

  test("a settle failure on one channel does not block the others", async () => {
    const store = makeStore([binding("b1", "telegram"), binding("b2", "discord")]);
    const reg = new NotificationRegistry(store, silentLog);
    const tg = new FakeChannel("telegram");
    tg.settle = async (): Promise<void> => {
      throw new Error("edit failed");
    };
    const dc = new FakeChannel("discord");
    reg.register("op-a", tg);
    reg.register("op-a", dc);

    const a = approval();
    await reg.fanOut(a);
    await reg.settle(a, "deck");
    expect(dc.settled).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  test("readyKinds reflects what is actually running", async () => {
    const reg = new NotificationRegistry(makeStore([]), silentLog);
    const tg = new FakeChannel("telegram");
    const dc = new FakeChannel("discord");
    dc.ready = false;
    reg.register("op-a", tg);
    reg.register("op-a", dc);
    expect(reg.readyKinds("op-a")).toEqual(["telegram"]);
  });

  test("stopAll stops and forgets every channel", async () => {
    const reg = new NotificationRegistry(makeStore([]), silentLog);
    const tg = new FakeChannel("telegram");
    reg.register("op-a", tg);
    await reg.stopAll();
    expect(tg.ready).toBe(false);
    expect(reg.readyKinds("op-a")).toEqual([]);
    expect(reg.get("op-a", "telegram")).toBeUndefined();
  });

  test("re-registering a kind replaces it", () => {
    const reg = new NotificationRegistry(makeStore([]), silentLog);
    const first = new FakeChannel("telegram");
    const second = new FakeChannel("telegram");
    reg.register("op-a", first);
    reg.register("op-a", second);
    expect(reg.get("op-a", "telegram")).toBe(second);
  });

  test("readyKinds is per operator, and an operator prefix cannot bleed", () => {
    const reg = new NotificationRegistry(makeStore([]), silentLog);
    reg.register("op-a", new FakeChannel("telegram"));
    reg.register("op-ab", new FakeChannel("discord"));
    // "op-a" must not match the slots of "op-ab".
    expect(reg.readyKinds("op-a")).toEqual(["telegram"]);
    expect(reg.readyKinds("op-ab")).toEqual(["discord"]);
  });
});

describe("a gateway shared by two operators (one bot, two OS accounts)", () => {
  test("both operators are served by the one instance", async () => {
    const store = makeStore([binding("b1", "telegram", "op-a"), binding("b2", "telegram", "op-b")]);
    const reg = new NotificationRegistry(store, silentLog);
    const shared = new FakeChannel("telegram");
    reg.register("op-a", shared);
    reg.register("op-b", shared);

    await reg.fanOut(approval({ operator_id: "op-a" }));
    await reg.fanOut(approval({ id: "appr-2", operator_id: "op-b" }));
    // One transport, two recipients — and each got their OWN address.
    expect(shared.posted.map((p) => p.address)).toEqual(["addr-b1", "addr-b2"]);
  });

  test("releasing one operator reports the gateway as still in use", () => {
    const reg = new NotificationRegistry(makeStore([]), silentLog);
    const shared = new FakeChannel("telegram");
    reg.register("op-a", shared);
    reg.register("op-b", shared);

    // Disconnecting op-a must NOT stop the transport: op-b still holds it.
    const first = reg.unregister("op-a", "telegram");
    expect(first.channel).toBe(shared);
    expect(first.orphaned).toBe(false);

    const second = reg.unregister("op-b", "telegram");
    expect(second.channel).toBe(shared);
    expect(second.orphaned).toBe(true);
  });

  test("unregistering an unknown slot is a no-op, never a phantom stop", () => {
    const reg = new NotificationRegistry(makeStore([]), silentLog);
    expect(reg.unregister("op-a", "telegram")).toEqual({ channel: null, orphaned: false });
  });

  test("stopAll stops a shared instance once, not once per operator", async () => {
    const reg = new NotificationRegistry(makeStore([]), silentLog);
    const shared = new FakeChannel("telegram");
    let stops = 0;
    shared.stop = async (): Promise<void> => {
      stops++;
    };
    reg.register("op-a", shared);
    reg.register("op-b", shared);
    await reg.stopAll();
    expect(stops).toBe(1);
  });
});
