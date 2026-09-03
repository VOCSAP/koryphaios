// Asserts the stored value did not move, not merely that the call errored:
// nothing on the MCP transport enforces the advertised inputSchema, so an agent
// can still send `inactive` in its tool-call arguments regardless of what the
// schema declares.

import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, post, deckAuthored, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

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
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
}

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

interface Harness {
  b: TestBroker;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  send: (msg: unknown) => void;
}

let nextRpcId = 1;

async function boot(): Promise<Harness> {
  const b = await startBroker();
  brokers.push(b);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
  };
  delete env.CLAUDE_PEERS_APPROVAL_FILE;

  const proc = Bun.spawn(["bun", "server.ts"], { env, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const buffer = { text: "" };
  const send = (msg: unknown): void => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  };

  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: "test-harness", version: "0.0.1" },
    },
  });
  await readUntil(reader, 0, buffer);

  return { b, reader, buffer, send };
}

async function callTool(
  h: Harness,
  name: string,
  args: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const id = nextRpcId++;
  h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return readUntil(h.reader, id, h.buffer);
}

function toolText(res: JsonRpcResponse): string {
  return res.result?.content?.[0]?.text ?? "";
}

type ItemRes = { item: RoadmapItem };

test("an agent's roadmap_update call cannot clear the operator-only inactive flag, even when it puts inactive in its arguments", async () => {
  const h = await boot();

  const created = await callTool(h, "roadmap_add", { title: "parked card, agent tries to unpark it" });
  expect(created.result?.isError).toBeFalsy();
  const idPrefix = toolText(created).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;

  const detailBefore = toolText(await callTool(h, "roadmap_get", { id: idPrefix }));
  const idFull = detailBefore.match(/id: ([0-9a-f-]{36})/)![1]!;

  // Park it, deck-signed direct-broker (same pattern as the marker test) --
  // this is the operator gesture the agent is about to try to undo.
  const parked = await post<ItemRes>(
    `${h.b.url}/roadmap/upsert`,
    deckAuthored({ id: idFull, inactive: true })
  );
  expect(parked.status).toBe(200);
  expect(parked.body.item.inactive).toBe(true);

  // The agent calls the real MCP tool, putting `inactive: false` in its
  // arguments -- an attempt to self-unblock. The tool call itself is
  // expected to SUCCEED (server.ts silently drops the unknown key rather
  // than rejecting the whole request), which is exactly why checking
  // `isError` alone would be the wrong assertion here.
  const attempt = await callTool(h, "roadmap_update", {
    id: idPrefix,
    inactive: false,
    title: "parked card, agent tries to unpark it (renamed by the same call)",
  });
  expect(attempt.result?.isError).toBeFalsy();

  // The only assertion that actually proves the guard: read the stored value
  // back through the same MCP tool an agent would use. It must still read
  // inactive -- the agent's `inactive: false` never reached the broker.
  const detailAfter = toolText(await callTool(h, "roadmap_get", { id: idPrefix }));
  expect(detailAfter.split("\n")[0]).toContain("[INACTIVE -- do not claim]");
  expect(detailAfter).toContain("inactive: this card is inactive");

  const directRead = await post<ItemRes>(`${h.b.url}/roadmap/upsert`, deckAuthored({ id: idFull }));
  expect(directRead.status).toBe(200);
  expect(directRead.body.item.inactive).toBe(true);
}, 60_000);
