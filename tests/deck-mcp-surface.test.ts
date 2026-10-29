// Surface test for the second MCP entrypoint: exactly the five Kory-only
// tools, and an instructions block that is served at all. What that block
// must SAY is pinned once, against the node bundle the Deck actually
// spawns; splitting it that way keeps the sentence from living in two
// files that drift apart.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "./_scrub-env.ts";
import { OPERATOR_CEILING_ENV, OPERATOR_TOOLS, encodeMountCeiling } from "../shared/mount-ceiling.ts";

interface JsonRpcResponse {
  id?: number;
  result?: {
    instructions?: string;
    tools?: Array<{ name: string }>;
  };
}

const procs: ReturnType<typeof Bun.spawn>[] = [];
// server-deck.ts imports named exports from server.ts, whose module-level
// `const config = await loadConfig()` runs on import regardless: this file
// reaches the settings-file sink just as surely as a broker/server spawn.
const settingsDir = mkdtempSync(join(tmpdir(), "deck-mcp-surface-"));

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  rmSync(settingsDir, { recursive: true, force: true });
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
  const proc = Bun.spawn(["bun", "server-deck.ts"], { env: scrubEnv(settingsDir, { [OPERATOR_CEILING_ENV]: encodeMountCeiling(OPERATOR_TOOLS), }), stdio: ["pipe", "pipe", "pipe"] });
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
  test("serves a non-empty instructions block", async () => {
    const { initRes } = await boot();
    // `?? ""` on purpose: an absent field is the likeliest degradation and
    // must fail the same way an empty one does.
    expect((initRes.result?.instructions ?? "").length).toBeGreaterThan(0);
  }, 30_000);

  test("exposes exactly the five Kory-only tools", async () => {
    const { reader, buffer, send } = await boot();
    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(reader, 1, buffer);
    const names = (res.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "ask_operator",
      "ask_operator_wait",
      "graph_draft_prepare",
      "graph_draft_send",
      "notify_operator",
    ]);
  }, 30_000);
});
