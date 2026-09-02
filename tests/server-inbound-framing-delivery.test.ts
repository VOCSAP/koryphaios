// End to end on purpose: a source scan for the call site's string would pass
// even with the call removed, since the same string can survive in a comment.
// This spawns a real broker and a real peer and asserts on the text the
// recipient actually reads.

import { test, expect, describe, afterAll } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import { computeGroupId, computeGroupSecretHash } from "../shared/config.ts";
import { DECK_PEER_ID } from "../shared/types.ts";
import { DECK_NO_REPLY_NOTE, LEAD_DIRECTIVE_NOTE } from "../shared/inbound-framing.ts";

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
 * Keyed on the JSON-RPC notification method rather than a response id: the WS
 * push never answers a request, so a harness that only awaits ids cannot see
 * it.
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

/**
 * Deletes CLAUDE_PEERS_ROLE from the inherited env before spawning: unlike the
 * broker's own env scrub, this spreads the whole process.env, so a developer's
 * own shell setting would otherwise leak into any test that doesn't pass its
 * own role.
 */
async function spawnPeer(b: TestBroker, extraEnv: Record<string, string> = {}): Promise<Peer> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    CLAUDE_PEERS_FORCE_GROUP: FORCED_GROUP,
  };
  delete env.CLAUDE_PEERS_APPROVAL_FILE;
  delete env.CLAUDE_PEERS_ROLE;
  Object.assign(env, extraEnv);

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

/**
 * Kills the broker process outright rather than relying on the WS idle-timeout
 * knob: the underlying websocket server keeps the connection alive across that
 * window regardless, so only a hard TCP close reliably triggers the peer's
 * close handler and its reconnect.
 */
async function killAndRestartBroker(b: TestBroker): Promise<void> {
  try {
    b.proc.kill();
    await b.proc.exited;
  } catch {
    /* already gone */
  }
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_PEERS_"))
  ) as Record<string, string>;
  const proc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...cleanEnv,
      CLAUDE_PEERS_PORT: String(b.port),
      CLAUDE_PEERS_DB: b.dbPath,
      CLAUDE_PEERS_LOG_DIR: `${b.tmpDir}/logs`,
      CLAUDE_PEERS_DORMANT_TTL_HOURS: "24",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      const res = await fetch(`${b.url}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* retry */
    }
    await Bun.sleep(20);
  }
  if (!ready) throw new Error("could not restart broker on the same port");
  b.proc = proc;
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

    expect(received).toContain("free to message any peer");
    expect(received).not.toContain("do NOT message any other peer");
  }, 90_000);

  test("the WS PUSH, the nominal path, delivers the framing too", async () => {
    // Asserts on hardcoded literals rather than comparing against
    // DECK_NO_REPLY_NOTE itself, since a comparison against the constant stays
    // green through any rewrite of it.
    // Covers the WS push path specifically: the other tests here go through the
    // pull-based check_messages tool and cannot see a framing bug in the push.
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

  test("the WS PUSH delivers the PEER note on a plain peer message (spec_ec5cf671)", async () => {
    // Same reason as the test above: the pull-shaped control further down
    // cannot see a push that hands the raw text to the notification. Hardcoded
    // literals, not the constant.
    const b = await startBroker();
    brokers.push(b);
    const sender = await spawnPeer(b);
    const recipient = await spawnPeer(b);
    const recipientId = await peerIdOf(recipient);
    await peerIdOf(sender);

    const body = "Plain peer traffic over the WebSocket push.";
    const sent = await callTool(sender, "send_message", { to_peer_id: recipientId, message: body });
    expect(sent.result?.isError).toBeFalsy();

    const pushed = await readNotification(recipient, "notifications/claude/channel");
    const content = pushed.params?.content ?? "";
    expect(content).toContain(body);
    expect(content).toContain("[claude-peers] Peer message: handle it, then continue your task.");
    expect(content).not.toContain("[Deck announcement");
    expect(content).not.toContain("[Operator answer]");
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

  test("an ordinary peer-to-peer message arrives with the PEER note and neither sentinel framing", async () => {
    // THE NEGATIVE CONTROL, re-aimed by spec_ec5cf671. Without it, a
    // check_messages that applied the DECK framing to every message would
    // satisfy both tests above. A plain peer now carries its own note (what to
    // tell the operator), so the control pins: body present, peer note
    // present, and neither the deck nor the operator header. Asserted on a
    // hardcoded literal, not on the constant, for the reason stated on the
    // WS-push test.
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
    expect(received).toContain("[claude-peers] Peer message: handle it, then continue your task.");
    expect(received).toContain("Do NOT report this exchange to the operator");
    expect(received.indexOf(body)).toBeLessThan(received.indexOf("[claude-peers] Peer message"));
  }, 90_000);
});

// spec_e028bad2, card 7defe381 lot B1 -- LEAD_DIRECTIVE_NOTE, the FIFTH,
// ROLE-conditioned note added to renderInbound's third argument. The suite
// above already end-to-ends the sender-class framing (deck/operator/peer);
// this block re-runs the same real-broker/real-peer harness for the
// orthogonal axis: the RECIPIENT's own broker-normalized role, carried by
// CLAUDE_PEERS_ROLE -> server.ts's myRole. Same reasoning as the file
// header: a source scan for "renderInbound(" would not tell you whether the
// THIRD argument at a given call site is really myRole or a swapped-in
// null/literal, so each of the four receive paths gets a real assertion on
// what a recipient process actually reads, plus a mutation-proof matrix
// (see the team-lead dispatch this batch answers) run against a disposable
// mirror, never against this checkout.
describe("the team-lead directive note (card 7defe381 lot B1) reaches only a team-lead recipient", () => {
  test("negative control: a recipient with NO role gets neither the peer note's team-lead suffix, via check_messages", async () => {
    const b = await startBroker();
    brokers.push(b);
    const sender = await spawnPeer(b);
    const recipient = await spawnPeer(b); // no CLAUDE_PEERS_ROLE -> myRole stays null
    const recipientId = await peerIdOf(recipient);
    await peerIdOf(sender);

    const body = "No role: must not carry the lead directive note.";
    const sent = await callTool(sender, "send_message", { to_peer_id: recipientId, message: body });
    expect(sent.result?.isError).toBeFalsy();

    const received = await awaitInbound(recipient);
    expect(received).toContain(body);
    expect(received).toContain("[claude-peers] Peer message: handle it, then continue your task.");
    expect(received).not.toContain(LEAD_DIRECTIVE_NOTE.trim());
  }, 90_000);

  test("PATH 1/4 -- the WS PUSH delivers the team-lead note to a team-lead recipient", async () => {
    const b = await startBroker();
    brokers.push(b);
    const sender = await spawnPeer(b);
    const recipient = await spawnPeer(b, { CLAUDE_PEERS_ROLE: "team-lead" });
    const recipientId = await peerIdOf(recipient);
    await peerIdOf(sender);

    const body = "WS push delivery of the team-lead directive note.";
    const sent = await callTool(sender, "send_message", { to_peer_id: recipientId, message: body });
    expect(sent.result?.isError).toBeFalsy();

    const pushed = await readNotification(recipient, "notifications/claude/channel");
    const content = pushed.params?.content ?? "";
    expect(content).toContain(body);
    expect(content).toContain("[claude-peers] Peer message: handle it, then continue your task.");
    expect(content).toContain(LEAD_DIRECTIVE_NOTE.trim());
  }, 90_000);

  test("PATH 2/4 -- the FALLBACK POLL delivers the team-lead note while the recipient's WS is down", async () => {
    // No test seam exists for server.ts's private `wsConnected` variable.
    // A first version of this test tried CLAUDE_PEERS_WS_IDLE_TIMEOUT_SEC to
    // force-close the idle socket; a swap-mutation diagnostic (mutating the
    // WS-push call site instead of this one, in the same test) proved that
    // version was silently exercising WS push the whole time -- see
    // killAndRestartBroker's header for the measurement and the reasoning.
    // A hard broker-process kill sidesteps the uncertainty: it drops the
    // recipient's TCP connection unconditionally, independent of any
    // broker-internal idle/ping behaviour.
    const b = await startBroker();
    brokers.push(b);
    const sender = await spawnPeer(b);
    const recipient = await spawnPeer(b, {
      CLAUDE_PEERS_ROLE: "team-lead",
      CLAUDE_PEERS_POLL_FALLBACK_SEC: "0",
    });
    const recipientId = await peerIdOf(recipient);
    await peerIdOf(sender);

    await killAndRestartBroker(b);

    const body = "Fallback-poll delivery of the team-lead directive note.";
    const sent = await callTool(sender, "send_message", { to_peer_id: recipientId, message: body });
    expect(sent.result?.isError).toBeFalsy();

    const pushed = await readNotification(recipient, "notifications/claude/channel");
    const content = pushed.params?.content ?? "";
    expect(content).toContain(body);
    expect(content).toContain(LEAD_DIRECTIVE_NOTE.trim());
  }, 90_000);

  test("PATH 3/4 -- check_messages delivers the team-lead note (formatInboundLine)", async () => {
    const b = await startBroker();
    brokers.push(b);
    const sender = await spawnPeer(b);
    const recipient = await spawnPeer(b, { CLAUDE_PEERS_ROLE: "team-lead" });
    const recipientId = await peerIdOf(recipient);
    await peerIdOf(sender);

    const body = "check_messages delivery of the team-lead directive note.";
    const sent = await callTool(sender, "send_message", { to_peer_id: recipientId, message: body });
    expect(sent.result?.isError).toBeFalsy();

    const received = await awaitInbound(recipient);
    expect(received).toContain(body);
    expect(received).toContain(LEAD_DIRECTIVE_NOTE.trim());
  }, 90_000);

  test("PATH 4/4 -- wait_for_message's MATCHED branch delivers the team-lead note (formatInboundLine)", async () => {
    const b = await startBroker();
    brokers.push(b);
    const sender = await spawnPeer(b);
    const recipient = await spawnPeer(b, { CLAUDE_PEERS_ROLE: "team-lead" });
    const recipientId = await peerIdOf(recipient);
    await peerIdOf(sender);

    const body = "wait_for_message matched delivery of the team-lead directive note.";
    const waitPromise = callTool(recipient, "wait_for_message", { timeout_sec: 20 });
    // Let the tool call actually register its waiter before the message is
    // sent -- otherwise the send can race registerWaiter and the message
    // gets picked up by the opportunistic peek's non-matched path instead of
    // the waiter this test targets.
    await Bun.sleep(500);

    const sent = await callTool(sender, "send_message", { to_peer_id: recipientId, message: body });
    expect(sent.result?.isError).toBeFalsy();

    const res = await waitPromise;
    const text = toolText(res);
    expect(text).toContain(body);
    expect(text).toContain(LEAD_DIRECTIVE_NOTE.trim());
  }, 30_000);
});
