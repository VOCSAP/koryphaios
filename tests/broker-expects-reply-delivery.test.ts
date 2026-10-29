import { test, expect, describe, afterAll } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_OPERATOR_ID,
  groupId,
  mintRunCredential,
  openBrokerDb,
  scrubEnv,
  sha256Hex,
  startBroker,
  stopBroker,
  type TestBroker,
} from "./_helper.ts";
import { readSessionIdentityFile } from "../shared/peer-cache.ts";
import { OPERATOR_INSTANCE_TOKEN } from "../shared/types.ts";
import { PEER_NO_REPLY_NOTE } from "../shared/message-framing.ts";
import { OPERATOR_CEILING_ENV, OPERATOR_TOOLS, encodeMountCeiling } from "../shared/mount-ceiling.ts";

const FORCED_GROUP = "expects-reply-delivery-e2e-spec-258af6eb";

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
  result?: {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    tools?: Array<{
      name: string;
      inputSchema?: { properties?: Record<string, { type?: string; description?: string }> };
    }>;
  };
}

interface Peer {
  proc: ReturnType<typeof Bun.spawn>;
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

// The operator inbox only accepts a session registered with a run credential.
async function runCredentialFile(b: TestBroker): Promise<string> {
  const run = await mintRunCredential(b, { id: await groupId(FORCED_GROUP), hash: await sha256Hex(FORCED_GROUP) });
  const path = join(b.tmpDir, `run-credential-${run.run}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      brokerUrl: b.url,
      operatorId: FIXTURE_OPERATOR_ID,
      tokenId: run.tokenId,
      sessionRef: `window-${run.run}`,
      privateKey: run.cred.privateKey,
      publicKey: run.cred.publicKey,
      osUserHash: "hash",
      inbox: { version: 1, run_ref: run.run, group_id: run.group },
    }),
    { mode: 0o600 }
  );
  return path;
}

/** Spawn one `bun <entrypoint>` MCP peer (server.ts by default) against an already-running broker. */
async function spawnPeer(
  b: TestBroker,
  extraEnv: Record<string, string> = {},
  entrypoint = "server.ts"
): Promise<Peer> {
  const proc = Bun.spawn(["bun", entrypoint], {
    env: scrubEnv(b.tmpDir, {
      CLAUDE_PEERS_BROKER_URL: b.url,
      CLAUDE_PEERS_PORT: String(b.port),
      CLAUDE_PEERS_FORCE_GROUP: FORCED_GROUP,
      ...extraEnv,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const buffer = { text: "" };
  const send = (msg: unknown): void => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  };
  const peer: Peer = { proc, reader, buffer, send };

  const id = nextRpcId++;
  send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: "expects-reply-harness", version: "0.0.1" },
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

/**
 * Reads a peer's own peer_id off its `whoami` tool rather than deriving it.
 * Two server.ts instances spawned from the same cwd land in the same group but
 * get DISTINCT peer_ids (the second is suffixed), and that suffixing is exactly
 * the kind of thing a test must observe instead of predict.
 */
async function peerIdOf(p: Peer): Promise<string> {
  const res = await callTool(p, "whoami", {});
  const text = toolText(res);
  const m = text.match(/peer_id:\s*(\S+)/i) ?? text.match(/"peer_id"\s*:\s*"([^"]+)"/);
  if (!m?.[1]) throw new Error(`could not read peer_id out of whoami: ${text.slice(0, 400)}`);
  return m[1];
}

/**
 * Polls check_messages until the recipient reports at least one message.
 * check_messages is the PULL path (it marks delivered), and it is deliberately
 * the one asserted on: it is the third render path, the one that does not go
 * through renderInbound, so a note that shows up here shows up everywhere.
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

describe("send_message expects_reply, end to end", () => {
  test("expects_reply:false reaches the recipient WITH the note; absent reaches it WITHOUT", async () => {
    const b = await startBroker();
    brokers.push(b);
    const sender = await spawnPeer(b);
    const recipient = await spawnPeer(b);
    const recipientId = await peerIdOf(recipient);
    const senderId = await peerIdOf(sender);
    expect(recipientId).not.toBe(senderId);

    // --- leg 1: the waiver ---
    const waived = "Lot 3d3c7d40 volet A is landed, nothing needed from you.";
    const sent = await callTool(sender, "send_message", {
      to_peer_id: recipientId,
      message: waived,
      expects_reply: false,
    });
    expect(sent.result?.isError).toBeFalsy();

    const received = await awaitInbound(recipient);
    // The caller's own words survive intact...
    expect(received).toContain(waived);
    // ...and the note rides along, in the text, on the recipient's side. This
    // single assertion is what the whole file exists for: it is false the
    // moment server.ts stops forwarding the flag.
    expect(received).toContain(PEER_NO_REPLY_NOTE.trim());
    expect(received).toContain("No reply expected");

    // --- leg 2: backward compatibility, same pair, same session ---
    const plain = "And this one does expect an answer.";
    const sent2 = await callTool(sender, "send_message", {
      to_peer_id: recipientId,
      message: plain,
    });
    expect(sent2.result?.isError).toBeFalsy();

    const received2 = await awaitInbound(recipient);
    expect(received2).toContain(plain);
    // Byte-for-byte compatibility, expressed on the wire: the note must be
    // wholly ABSENT, not merely different.
    expect(received2).not.toContain("No reply expected");
    expect(received2).not.toContain("[claude-peers] No reply");
  }, 90_000);

  test("send_message ADVERTISES expects_reply, so an agent can discover it", async () => {
    // MEASURED SECOND BREAK VECTOR, and the reason this test exists separately
    // from the delivery one: deleting the `expects_reply` block from
    // server.ts's inputSchema leaves the two delivery tests above fully GREEN.
    // The MCP SDK forwards arguments the schema never declared, so the runtime
    // keeps honouring the flag while no agent can ever learn it exists -- the
    // feature would ship invisible, which for an agent-facing tool is
    // indistinguishable from not shipping it. The schema is the contract with
    // the caller, so it is asserted over tools/list rather than trusted.
    const b = await startBroker();
    brokers.push(b);
    const peer = await spawnPeer(b);

    const id = nextRpcId++;
    peer.send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
    const listed = await readUntil(peer.reader, id, peer.buffer);

    const sendMessage = listed.result?.tools?.find((t) => t.name === "send_message");
    expect(sendMessage).toBeDefined();
    const prop = sendMessage!.inputSchema?.properties?.expects_reply;
    expect(prop).toBeDefined();
    expect(prop!.type).toBe("boolean");
    // The description has to tell the model WHEN to use it, not merely that it
    // exists: a declared-but-unexplained flag is one an agent never reaches for.
    expect(prop!.description ?? "").toContain("false");
  }, 90_000);

  test("send_message ADVERTISES message_id with deadline_sec, so an agent can arm a deadline on a sent message", async () => {
    const b = await startBroker();
    brokers.push(b);
    const peer = await spawnPeer(b);

    const id = nextRpcId++;
    peer.send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
    const listed = await readUntil(peer.reader, id, peer.buffer);

    const prop = listed.result?.tools?.find((t) => t.name === "send_message")?.inputSchema?.properties?.message_id;
    expect(prop).toBeDefined();
    expect(prop!.type).toBe("number");
    expect(prop!.description ?? "").toContain("deadline_sec");
  }, 90_000);

  test("a waived message aimed at the operator inbox is stored unframed", async () => {
    const b = await startBroker();
    brokers.push(b);
    const deskSession = `expects-reply-operator-${crypto.randomUUID()}`;
    const env = {
      CLAUDE_PEERS_APPROVAL_FILE: await runCredentialFile(b),
      CLAUDE_PEERS_DESK_SESSION: deskSession,
      [OPERATOR_CEILING_ENV]: encodeMountCeiling(OPERATOR_TOOLS),
    };
    // A tile is a server.ts sibling that registers attested and publishes its identity, plus the
    // server-deck.ts process that reads it: notify_operator is the one-way deposit that remains.
    await spawnPeer(b, env);
    let identity = await readSessionIdentityFile(deskSession, b.tmpDir);
    for (let i = 0; i < 100 && !identity; i++) {
      await Bun.sleep(100);
      identity = await readSessionIdentityFile(deskSession, b.tmpDir);
    }
    expect(identity, "the server.ts sibling never published its identity").not.toBeNull();
    const sender = await spawnPeer(b, env, "server-deck.ts");

    const forHuman = "Blocked on a credential, can you confirm which vault entry?";
    const sent = await callTool(sender, "notify_operator", { message: forHuman });

    // The operator inbox is read from the broker DB directly rather than over
    // POST /poll-messages: that endpoint now refuses sentinel-shaped
    // instance_tokens outright (card 37a2b8c7), and POST /operator-inbox needs
    // the group secret this harness has no reason to hold. The row IS the
    // ground truth for "what would a human be shown".
    const db = openBrokerDb(b.dbPath, { readonly: true });
    try {
      const rows = db
        .query("SELECT text FROM messages WHERE to_token = ? ORDER BY id DESC")
        .all(OPERATOR_INSTANCE_TOKEN) as { text: string }[];
      expect(sent.result?.isError).toBeFalsy();
      expect(rows.length).toBe(1);
      expect(rows[0]!.text).toBe(forHuman);
      expect(rows[0]!.text).not.toContain("[claude-peers]");
      expect(rows[0]!.text).not.toContain("continue your current task");
    } finally {
      db.close();
    }
  }, 90_000);
});
