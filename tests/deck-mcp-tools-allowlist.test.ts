// Card c9269fef lot L2-bis, MAJOR 2: server-deck.ts must apply
// CLAUDE_PEERS_TOOLS the same way server.ts does, at BOTH ends (tools/list
// AND tools/call) -- hiding a tool from the list alone still leaves it
// callable by name, which would make the allow-list decorative here too.

import { test, expect, describe, afterAll } from "bun:test";

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ text?: string }>; isError?: boolean; tools?: Array<{ name: string }> };
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

/** Boot server-deck.ts with CLAUDE_PEERS_TOOLS restricting the surface to
 * graph_draft_prepare only, excluding both ask_operator tools. */
async function bootRestricted() {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_TOOLS: "graph_draft_prepare",
  };
  const proc = Bun.spawn(["bun", "server-deck.ts"], { env, stdio: ["pipe", "pipe", "pipe"] });
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
  return { reader, buffer, send };
}

describe("server-deck.ts honors CLAUDE_PEERS_TOOLS", () => {
  test("tools/list omits a tool the allow-list excludes", async () => {
    const { reader, buffer, send } = await bootRestricted();
    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(reader, 1, buffer);
    const names = (res.result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(["graph_draft_prepare"]);
  }, 30_000);

  test("tools/call refuses a hidden tool by name, not just hides it from the list", async () => {
    const { reader, buffer, send } = await bootRestricted();
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });
    const res = await readUntil(reader, 1, buffer);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toContain("tool not available");
  }, 30_000);
});
