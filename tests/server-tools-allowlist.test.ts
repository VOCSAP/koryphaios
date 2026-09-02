// Card a67ec467: CLAUDE_PEERS_TOOLS, an optional env-var ALLOW-list that
// filters the MCP tools server.ts exposes. Same three-state contract as
// deck-control-mcp.ts's DECK_CONTROL_TOOLS (Card ff091064), and coverage at
// tools/call, not just tools/list.
//
// server.ts has zero exports and runs main() unconditionally at module scope
// (it registers with a real broker and connects stdio), so resolveToolAllowlist/
// filterTools cannot be imported and unit-tested directly -- this mirrors
// server-ask-operator.test.ts's harness: spawn `bun server.ts` against a real
// test broker and drive it over real MCP stdio JSON-RPC.

import { test, expect, describe, afterAll } from "bun:test";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";

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
  result?: { content?: Array<{ text?: string }>; isError?: boolean; tools?: Array<{ name: string }> };
  error?: { message?: string };
}

/** Read stdout until a JSON-RPC message with the wanted id shows up. */
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
  proc: ReturnType<typeof Bun.spawn>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  send: (msg: unknown) => void;
}

/** Boot `bun server.ts` with CLAUDE_PEERS_TOOLS set to `toolsEnv` (undefined = unset). */
async function boot(toolsEnv: string | undefined): Promise<Harness> {
  const b = await startBroker();
  brokers.push(b);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
  };
  if (toolsEnv === undefined) {
    delete env.CLAUDE_PEERS_TOOLS;
  } else {
    env.CLAUDE_PEERS_TOOLS = toolsEnv;
  }

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

  return { b, proc, reader, buffer, send };
}

describe("CLAUDE_PEERS_TOOLS: server.ts's tool allow-list", () => {
  test("unset: every tool listed, unrestricted (zero regression for a session launched outside Kory)", async () => {
    const h = await boot(undefined);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, 1, h.buffer);
    const names = (res.result?.tools ?? []).map((t) => t.name);
    // A real cross-section of the tool set, not just one name -- proves the
    // full array passed through, not a coincidental single survivor.
    expect(names).toContain("list_peers");
    expect(names).toContain("roadmap_get");
    expect(names).toContain("send_message");
    expect(names.length).toBeGreaterThan(15);
  }, 60_000);

  test("set, non-empty: tools/list returns exactly the named subset, dropping an unlisted name and a typo'd one", async () => {
    const h = await boot("whoami, set_summary ,not-a-real-tool");
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, 1, h.buffer);
    const names = (res.result?.tools ?? []).map((t) => t.name);
    // Exact set: the allow-list can only shrink TOOLS, never grow it -- the
    // stale/typo'd name in the env var must not appear as a phantom tool.
    expect(names.sort()).toEqual(["set_summary", "whoami"]);
  }, 60_000);

  test("set and empty: zero tools listed, distinct from unset", async () => {
    const h = await boot("");
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.tools ?? []).toEqual([]);
  }, 60_000);

  test("tools/call refuses a tool excluded by the allow-list, BEFORE it reaches the tool's own logic", async () => {
    const h = await boot("whoami");
    // list_peers is excluded; if the guard did not short-circuit before the
    // switch, this would instead hit list_peers' own broker-registration
    // check and return a different error ("Not registered with broker yet").
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_peers", arguments: { scope: "machine" } },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toBe("Error: tool not available: list_peers");
  }, 60_000);

  test("tools/call still accepts a tool included by the allow-list", async () => {
    const h = await boot("whoami");
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    // Registration completes before mcp.connect in main(), so by the time
    // this responds the guard has let it through to whoami's own logic --
    // proven by NOT getting the allow-list's refusal text.
    expect(res.result?.content?.[0]?.text).not.toBe("Error: tool not available: whoami");
  }, 60_000);

  test("a genuinely unknown tool name still hits the pre-existing 'Unknown tool' path, unaffected by the allow-list guard", async () => {
    const h = await boot(undefined);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "not-a-real-tool", arguments: {} },
    });
    // The SDK converts the handler's thrown default-case Error into a
    // JSON-RPC protocol error (`error`, not `result`) -- distinct from the
    // allow-list guard's own isError-tool-RESULT shape asserted above, and
    // proof the guard did not swallow this pre-existing path.
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result).toBeUndefined();
    expect(res.error?.message ?? "").toContain("Unknown tool: not-a-real-tool");
  }, 60_000);
});
