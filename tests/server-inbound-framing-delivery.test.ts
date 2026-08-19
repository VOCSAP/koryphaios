// spec_c599a9c5 -- card e3f8065d, the WIRING attestation.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT A SOURCE SCAN.
// tests/peer-inbound-framing.test.ts proves the pure DECISION in
// shared/inbound-framing.ts and nothing else: measured on card 3d3c7d40, a pure
// suite stays fully green while the module it imports is connected to NOTHING.
// The extraction performed here moved a block out of server.ts and made
// check_messages consume it instead of its own inline copy of the branching --
// so the single line that now carries the whole behaviour of the third receive
// path is a call site, and a call site is exactly what a pure suite cannot see.
//
// A scan of server.ts for the string "renderInbound(" would close the
// disconnection without proving the contract, and is defeated by the same
// string surviving in a comment. So this is END TO END: a real broker, a real
// `bun server.ts` peer, a real POST /announce from the reserved deck sentinel,
// and the assertion made on THE TEXT THE RECIPIENT ACTUALLY READS through its
// own check_messages tool.
//
// THE MUTATION IT MUST SURVIVE. Replacing `renderInbound(m.from_peer_id, m.text)`
// by `m.text` at that call site leaves the pure suite at 15/15 and the smoke
// build passing. It must turn THIS file red. The negative control below (an
// ordinary peer message must arrive byte-identical) is the other half: a
// blanket framing applied to every message would satisfy the deck assertions
// and fail there, so neither test alone pins the behaviour.
//
// NAMING AND CI. `server-` prefix because it spawns daemons and binds ports.
// That family is EXEMPTED from the pure-module glob at
// .github/workflows/desktop-build.yml line 79, deliberately and by the
// workflow's own comment. It is therefore NOT collected by CI and runs in the
// full local gate. Renaming it to `peer-` to force collection would inject a
// port-binding suite into that matrix, which is the very thing the exemption
// exists to prevent.
//
// GROUP ISOLATION. The peer is spawned with CLAUDE_PEERS_FORCE_GROUP, the same
// env the Deck uses to force an isolated group. The group_id and the TOFU hash
// are then DERIVED here through the production functions (computeGroupId /
// computeGroupSecretHash) rather than hardcoded or guessed from the checkout's
// own group -- which would make the test depend on whatever group this working
// copy happens to resolve to. The forced value below is a test fixture, not a
// credential: it isolates the group, and the broker pins it on first use.

import { test, expect, describe, afterAll } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import { computeGroupId, computeGroupSecretHash } from "../shared/config.ts";
import { DECK_PEER_ID } from "../shared/types.ts";
import { DECK_NO_REPLY_NOTE } from "../shared/inbound-framing.ts";

const FORCED_GROUP = "inbound-framing-e2e-spec-c599a9c5";
const GROUP_ID = computeGroupId(FORCED_GROUP);
const GROUP_HASH = computeGroupSecretHash(FORCED_GROUP);

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const b of brokers) await stopBroker(b);
});

interface JsonRpcResponse {
  id?: number;
  method?: string;
  params?: { content?: string };
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
}

interface Peer {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  send: (msg: unknown) => void;
}

let nextRpcId = 1;

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wantedId: number,
  buffer: { text: string }
): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let idx: number;
    while ((idx = buffer.text.indexOf("\n")) >= 0) {
      const line = buffer.text.slice(0, idx).trim();
      buffer.text = buffer.text.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id === wantedId) return msg;
      } catch {
        /* not a complete JSON line yet */
      }
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer.text += decoder.decode(value, { stream: true });
  }
  throw new Error(`no JSON-RPC response with id ${wantedId}`);
}

/**
 * Same scan as readUntil, but keyed on the JSON-RPC `method` of a NOTIFICATION
 * rather than on a response id. The WS push is the NOMINAL delivery path and it
 * never answers a request, so nothing with an id ever comes back for it: a
 * harness that only knows how to await ids is structurally blind to it, which
 * is exactly how server.ts:335 stayed unattested until review measured it.
 */
async function readNotification(p: Peer, method: string): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let idx: number;
    while ((idx = p.buffer.text.indexOf("\n")) >= 0) {
      const line = p.buffer.text.slice(0, idx).trim();
      p.buffer.text = p.buffer.text.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.method === method) return msg;
      } catch {
        /* not a complete JSON line yet */
      }
    }
    const { value, done } = await p.reader.read();
    if (done) break;
    p.buffer.text += decoder.decode(value, { stream: true });
  }
  throw new Error(`no JSON-RPC notification with method ${method}`);
}

/** Spawn one `bun server.ts` MCP peer into the forced, isolated group. */
async function spawnPeer(b: TestBroker): Promise<Peer> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    CLAUDE_PEERS_FORCE_GROUP: FORCED_GROUP,
  };
  delete env.CLAUDE_PEERS_APPROVAL_FILE;

  const proc = Bun.spawn(["bun", "server.ts"], { env, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const buffer = { text: "" };
  const send = (msg: unknown): void => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  };
  const peer: Peer = { reader, buffer, send };

  const id = nextRpcId++;
  send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: "inbound-framing-harness", version: "0.0.1" },
    },
  });
  await readUntil(reader, id, buffer);
  return peer;
}

async function callTool(
  p: Peer,
  name: string,
  args: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const id = nextRpcId++;
  p.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return readUntil(p.reader, id, p.buffer);
}

function toolText(res: JsonRpcResponse): string {
  return res.result?.content?.[0]?.text ?? "";
}

/** Read a peer's own peer_id off whoami rather than predicting the suffixing. */
async function peerIdOf(p: Peer): Promise<string> {
  const text = toolText(await callTool(p, "whoami", {}));
  const m = text.match(/peer_id:\s*(\S+)/i) ?? text.match(/"peer_id"\s*:\s*"([^"]+)"/);
  if (!m?.[1]) throw new Error(`could not read peer_id out of whoami: ${text.slice(0, 400)}`);
  return m[1];
}

/**
 * Poll check_messages until the recipient reports at least one message.
 * check_messages is asserted on rather than the WS push because it is THE path
 * this lot rewired: it used to re-implement the sender-class branching inline
 * and now calls the shared enforcer. The other two paths already called it.
 */
async function awaitInbound(p: Peer): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = toolText(await callTool(p, "check_messages", {}));
    if (!text.startsWith("No new messages")) return text;
    await Bun.sleep(150);
  }
  throw new Error("recipient never reported an inbound message");
}

describe("deck framing survives to the recipient, through check_messages", () => {
  test("a broadcast announce arrives FRAMED, with the note the card rewrote", async () => {
    const b = await startBroker();
    brokers.push(b);
    const recipient = await spawnPeer(b);
    // Forces registration to have completed before /announce looks for an
    // active peer in the group; also proves the forced group actually took.
    const recipientId = await peerIdOf(recipient);
    expect(recipientId.length).toBeGreaterThan(0);

    const body = "Batch 138fa6f is committed. Next rank is card e3f8065d.";
    const announced = await post<{ sent?: number; error?: string }>(`${b.url}/announce`, {
      group_id: GROUP_ID,
      group_secret_hash: GROUP_HASH,
      text: body,
    });
    // Asserted, not tolerated: a 0 here would mean the announce never reached a
    // peer, and every assertion below would then be measuring an empty inbox
    // through a timeout instead of measuring the framing.
    expect(announced.status).toBe(200);
    expect(announced.body.sent).toBe(1);

    const received = await awaitInbound(recipient);

    // The operator's own words survive intact...
    expect(received).toContain(body);
    // ...check_messages still labels the sender with the public sentinel id...
    expect(received).toContain(`From ${DECK_PEER_ID} (`);
    // ...the announcement header is applied...
    expect(received).toContain("[Deck announcement -- operator broadcast]");
    // ...and THE NOTE rides along. This is the assertion the whole file exists
    // for: it is false the moment check_messages stops calling renderInbound.
    expect(received).toContain(DECK_NO_REPLY_NOTE.trim());

    // Card dd388182, proved on the wire rather than on the constant: what a
    // recipient actually reads no longer forbids it from messaging a peer.
    expect(received).toContain("free to message any peer");
    expect(received).not.toContain("do NOT message any other peer");
  }, 90_000);

  test("the WS PUSH, the nominal path, delivers the framing too", async () => {
    // ADDED AFTER REVIEW, and the review is the reason it exists. Twelve
    // mutations were played against this lot; two came back GREEN on all four
    // suites: replacing renderInbound by the raw text at server.ts:335 (this
    // push) and at server.ts:388 (the fallback poll). The three tests around
    // this one assert through check_messages, which is a PULL, so they could
    // not see it. The path left uncovered was the NOMINAL one -- the poll is
    // only a fallback -- so an agent receiving a Deck announcement over the
    // push would have read it NAKED, with no header and no note, and nothing
    // would have gone red.
    //
    // The push emits a JSON-RPC NOTIFICATION, which carries no id and answers
    // no request, hence readNotification above rather than readUntil.
    //
    // The assertions below are on HARDCODED literals, never on
    // DECK_NO_REPLY_NOTE itself: review measured that an assertion comparing
    // the output to the constant is self-referential and stays green through
    // any rewrite of that constant, since both sides move together.
    const b = await startBroker();
    brokers.push(b);
    const recipient = await spawnPeer(b);
    // whoami first, so the notification cannot be consumed by the id-scanner
    // while it hunts for that response.
    await peerIdOf(recipient);

    const body = "Announcement delivered over the WebSocket push.";
    const announced = await post<{ sent?: number }>(`${b.url}/announce`, {
      group_id: GROUP_ID,
      group_secret_hash: GROUP_HASH,
      text: body,
    });
    expect(announced.body.sent).toBe(1);

    const pushed = await readNotification(recipient, "notifications/claude/channel");
    const content = pushed.params?.content ?? "";
    expect(content).toContain(body);
    expect(content).toContain("[Deck announcement -- operator broadcast]");
    expect(content).toContain("Do NOT acknowledge");
    expect(content).toContain("free to message any peer");
  }, 90_000);

  test("a targeted announce is framed too, and it is the case the note was rewritten for", async () => {
    // The dispatch path (broker.ts handleAnnounce, `to_peer_id` branch): this is
    // how an operator hands ONE peer a task. It is the case where the old
    // wording actively contradicted its own payload, so it gets its own
    // assertion rather than being assumed to behave like the broadcast.
    const b = await startBroker();
    brokers.push(b);
    const target = await spawnPeer(b);
    const targetId = await peerIdOf(target);

    const body = "You are on card e3f8065d. Report to the team-lead when it lands.";
    const announced = await post<{ sent?: number; error?: string }>(`${b.url}/announce`, {
      group_id: GROUP_ID,
      group_secret_hash: GROUP_HASH,
      text: body,
      to_peer_id: targetId,
    });
    expect(announced.status).toBe(200);
    expect(announced.body.sent).toBe(1);

    const received = await awaitInbound(target);
    expect(received).toContain(body);
    expect(received).toContain("[Deck announcement -- operator broadcast]");
    expect(received).toContain("free to message any peer");
  }, 90_000);

  test("an ordinary peer-to-peer message arrives UNFRAMED, byte for byte", async () => {
    // THE NEGATIVE CONTROL. Without it, a check_messages that framed EVERY
    // message would satisfy both tests above. It also pins the half of the
    // extraction that must not have changed: for a non-sentinel sender,
    // renderInbound returns the text unchanged, so this path's output is
    // identical to what it printed before the rewrite.
    const b = await startBroker();
    brokers.push(b);
    const sender = await spawnPeer(b);
    const recipient = await spawnPeer(b);
    const recipientId = await peerIdOf(recipient);
    const senderId = await peerIdOf(sender);
    expect(recipientId).not.toBe(senderId);

    const body = "Plain peer traffic, no sentinel involved.";
    const sent = await callTool(sender, "send_message", {
      to_peer_id: recipientId,
      message: body,
    });
    expect(sent.result?.isError).toBeFalsy();

    const received = await awaitInbound(recipient);
    expect(received).toContain(body);
    expect(received).toContain(`From ${senderId} (`);
    expect(received).not.toContain("[Deck announcement");
    expect(received).not.toContain("[Operator answer]");
    expect(received).not.toContain("[claude-peers]");
  }, 90_000);
});
