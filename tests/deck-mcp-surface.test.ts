// Surface test for the second MCP entrypoint (Card c9269fef lot L2):
// exactly the three identity-free tools, and no `instructions` block.

import { test, expect, describe, afterAll } from "bun:test";

interface JsonRpcResponse {
  id?: number;
  result?: {
    instructions?: string;
    tools?: Array<{ name: string }>;
  };
}

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
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wantedId: number,
  buffer: { text: string }
): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
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

async function boot() {
  const proc = Bun.spawn(["bun", "server-deck.ts"], { stdio: ["pipe", "pipe", "pipe"] });
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
  const initRes = await readUntil(reader, 0, buffer);
  return { proc, reader, buffer, send, initRes };
}

describe("server-deck.ts surface", () => {
  test("carries no instructions block", async () => {
    const { initRes } = await boot();
    expect(initRes.result?.instructions).toBeUndefined();
  }, 30_000);

  test("exposes exactly the three identity-free tools", async () => {
    const { reader, buffer, send } = await boot();
    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(reader, 1, buffer);
    const names = (res.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["ask_operator", "ask_operator_wait", "graph_draft_prepare"]);
  }, 30_000);
});
