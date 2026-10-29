import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "./_scrub-env.ts";

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ text?: string }>; isError?: boolean; tools?: Array<{ name: string }> };
}

const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
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

async function bootRestricted(tools: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "cp-deck-tools-allowlist-"));
  dirs.push(dir);
  const proc = Bun.spawn(["bun", "server-deck.ts"], {
    env: scrubEnv(dir, tools !== undefined ? { CLAUDE_PEERS_TOOLS: tools } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
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
    const { reader, buffer, send } = await bootRestricted("graph_draft_prepare");
    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(reader, 1, buffer);
    const names = (res.result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(["graph_draft_prepare"]);
  }, 30_000);

  test("tools/call refuses a hidden tool by name, not just hides it from the list", async () => {
    const { reader, buffer, send } = await bootRestricted("graph_draft_prepare");
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

  test("an empty allow-list grants the operator family zero tools", async () => {
    const { reader, buffer, send } = await bootRestricted("");
    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const listed = await readUntil(reader, 1, buffer);
    expect(listed.result?.tools).toEqual([]);
  }, 30_000);

  test("an absent allow-list grants the operator family its complete surface", async () => {
    const { reader, buffer, send } = await bootRestricted(undefined);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const listed = await readUntil(reader, 1, buffer);
    expect((listed.result?.tools ?? []).map((tool) => tool.name).sort()).toEqual([
      "ask_operator",
      "ask_operator_wait",
      "graph_draft_prepare",
      "graph_draft_send",
      "notify_operator"
    ]);
  }, 30_000);

  test("send_message grants the notify_operator contract alias", async () => {
    const { reader, buffer, send } = await bootRestricted("send_message");
    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const listed = await readUntil(reader, 1, buffer);
    expect((listed.result?.tools ?? []).map((tool) => tool.name)).toEqual(["notify_operator"]);

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "notify_operator", arguments: {} } });
    const called = await readUntil(reader, 2, buffer);
    expect(called.result?.isError).toBe(true);
    expect(called.result?.content?.[0]?.text).toBe("message is required");
  }, 30_000);

  test("an allow-list without send_message refuses notify_operator before dispatch", async () => {
    const { reader, buffer, send } = await bootRestricted("ask_operator");
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notify_operator", arguments: {} } });
    const called = await readUntil(reader, 1, buffer);
    expect(called.result?.isError).toBe(true);
    expect(called.result?.content?.[0]?.text).toBe("Error: tool not available: notify_operator");
  }, 30_000);

  test("the operator family keeps roadmap_dispatch unavailable in both discovery and calls", async () => {
    const { reader, buffer, send } = await bootRestricted("graph_draft_prepare");
    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const listed = await readUntil(reader, 1, buffer);
    expect((listed.result?.tools ?? []).map((tool) => tool.name)).toEqual(["graph_draft_prepare"]);

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "roadmap_dispatch", arguments: {} } });
    const called = await readUntil(reader, 2, buffer);
    expect(called.result?.isError).toBe(true);
    expect(called.result?.content?.[0]?.text).toBe("Error: tool not available: roadmap_dispatch");
  }, 30_000);
});
