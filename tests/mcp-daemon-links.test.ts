import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createLinkIndex, linkKeyOf, type LinkedIdentity } from "../shared/mcp-daemon-links.ts";

const identity = (peerId: string): LinkedIdentity => ({
  peerId,
  instanceToken: `tok-${peerId}`,
  projectKey: "github.com/example/links",
  brokerUrl: "http://127.0.0.1:7899/",
});

const hello = (over: { socket?: string; ppid?: number; ppid_start?: string } = {}) => ({
  env: over.socket === undefined ? { CLAUDE_CODE_MESSAGING_SOCKET: "sock-a" } : { CLAUDE_CODE_MESSAGING_SOCKET: over.socket },
  ppid: over.ppid ?? 100,
  ppid_start: over.ppid_start ?? "gen-1",
});

describe("linkKeyOf", () => {
  test("a hello without a messaging socket has no key", () => {
    expect(linkKeyOf({ env: {}, ppid: 100, ppid_start: "gen-1" })).toBeNull();
    expect(linkKeyOf({ env: { CLAUDE_CODE_MESSAGING_SOCKET: "" }, ppid: 100, ppid_start: "gen-1" })).toBeNull();
  });

  test("a hello whose parent start time is not measurable (empty) has no key", () => {
    expect(linkKeyOf(hello({ ppid_start: "" }))).toBeNull();
  });

  test("the key hashes the socket and carries the parent pid and its start time", () => {
    expect(linkKeyOf(hello())).toEqual({
      socketHash: createHash("sha256").update("sock-a").digest("hex"),
      ppid: 100,
      ppidStart: "gen-1",
    });
    expect(linkKeyOf(hello({ socket: "sock-b" }))?.socketHash).not.toBe(linkKeyOf(hello())?.socketHash);
  });
});

describe("the link index", () => {
  const keyA = linkKeyOf(hello()) as NonNullable<ReturnType<typeof linkKeyOf>>;

  test("a lookup with no session of the key finds none", () => {
    expect(createLinkIndex().find(keyA)).toEqual({ kind: "none" });
  });

  test("exactly one session of the key is found with its session id and identity", () => {
    const index = createLinkIndex();
    index.register("s1", keyA, () => identity("p1"));
    expect(index.find(keyA)).toEqual({ kind: "one", sessionId: "s1", identity: identity("p1") });
  });

  test("two sessions of the key are reported together, in registration order, never the first alone", () => {
    const index = createLinkIndex();
    index.register("s1", keyA, () => identity("p1"));
    index.register("s2", keyA, () => identity("p2"));
    expect(index.find(keyA)).toEqual({ kind: "many", sessionIds: ["s1", "s2"] });
  });

  test("a session of the same socket and parent pid but another parent start time is not linked", () => {
    const index = createLinkIndex();
    index.register("old", linkKeyOf(hello({ ppid_start: "gen-0" })) as typeof keyA, () => identity("old"));
    index.register("new", keyA, () => identity("new"));
    expect(index.find(keyA)).toEqual({ kind: "one", sessionId: "new", identity: identity("new") });
  });

  test("another parent pid or another socket is not linked", () => {
    const index = createLinkIndex();
    index.register("pid", linkKeyOf(hello({ ppid: 101 })) as typeof keyA, () => identity("pid"));
    index.register("sock", linkKeyOf(hello({ socket: "sock-b" })) as typeof keyA, () => identity("sock"));
    expect(index.find(keyA)).toEqual({ kind: "none" });
  });

  test("a session that has no identity yet does not count, and counts once it has one", () => {
    const index = createLinkIndex();
    let current: LinkedIdentity | null = null;
    index.register("s1", keyA, () => current);
    expect(index.find(keyA)).toEqual({ kind: "none" });
    current = identity("p1");
    expect(index.find(keyA)).toEqual({ kind: "one", sessionId: "s1", identity: identity("p1") });
  });

  test("the identity is read at each lookup, so a changed identity is seen", () => {
    const index = createLinkIndex();
    let current = identity("before");
    index.register("s1", keyA, () => current);
    current = identity("after");
    expect(index.find(keyA)).toEqual({ kind: "one", sessionId: "s1", identity: identity("after") });
  });

  test("the removal returned by register takes the session out, and only that one", () => {
    const index = createLinkIndex();
    const leave = index.register("s1", keyA, () => identity("p1"));
    index.register("s2", keyA, () => identity("p2"));
    leave();
    leave();
    expect(index.find(keyA)).toEqual({ kind: "one", sessionId: "s2", identity: identity("p2") });
  });
});
