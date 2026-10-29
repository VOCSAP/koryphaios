import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, scrubEnv, type TestBroker } from "./_helper.ts";
import { DECK_TOOL_NAMES } from "../server-deck.ts";
import { DECK_ONLY_TOOLS } from "../server.ts";

const DECK_ONLY_NAMES = [
  "graph_draft_prepare",
  "graph_draft_send",
  "ask_operator",
  "ask_operator_wait",
  "notify_operator",
] as const;
const NOT_IN_CORE = [...DECK_ONLY_NAMES, "roadmap_dispatch"] as const;

test("server-deck.ts serves exactly the five operator-family tools that server.ts declares", () => {
  expect(new Set<string>(DECK_ONLY_NAMES)).toEqual(new Set(DECK_ONLY_TOOLS.map((t) => t.name)));
  expect(new Set<string>(DECK_ONLY_NAMES)).toEqual(new Set(DECK_TOOL_NAMES));
});

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
  result?: { tools?: Array<{ name: string }>; instructions?: string };
  error?: { message?: string };
}

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

test("the core server's tools/list names none of the family-only tools", async () => {
  const b = await startBroker();
  brokers.push(b);
  const proc = Bun.spawn(["bun", "server.ts"], {
    env: scrubEnv(b.tmpDir, {
      CLAUDE_PEERS_BROKER_URL: b.url,
      CLAUDE_PEERS_PORT: String(b.port),
    }),
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
  const init = await readUntil(reader, 0, buffer);

  send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const res = await readUntil(reader, 1, buffer);
  const names = (res.result?.tools ?? []).map((t) => t.name);
  expect(names.length).toBeGreaterThan(0);
  for (const name of NOT_IN_CORE) {
    expect(names).not.toContain(name);
  }

  // The instructions block is the second carrier of the per-turn surface,
  // read on every turn by every tile. A name promised there but absent from
  // tools/list makes the server lie: an agent that obeys gets the protocol
  // error the assertions below pin as correct. Measured on the wire, from
  // the initialize response, not from the source.
  const instructions = init.result?.instructions ?? "";
  expect(instructions.length).toBeGreaterThan(0);
  for (const name of NOT_IN_CORE) {
    expect(instructions).not.toContain(name);
  }

  // C4: hiding a tool from tools/list is not enough on its own -- a stray
  // `case` left in the call switch would still execute it. Same process,
  // one call per name so a single surviving `case` cannot hide behind an
  // earlier failure.
  let id = 2;
  for (const name of NOT_IN_CORE) {
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
    const callRes = await readUntil(reader, id, buffer);
    expect(callRes.result).toBeUndefined();
    expect(callRes.error?.message ?? "").toContain(name);
    id++;
  }
}, 30_000);
