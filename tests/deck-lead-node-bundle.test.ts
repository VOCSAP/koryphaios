// The shipped artifact is the NODE bundle (built by
// `npm run build:mcp` via `bun build --target=node`), never the TypeScript
// source run under bun -- spawning the source cannot see a defect that only
// exists in the bundled artifact (a Bun-only API/construct that throws or
// ReferenceErrors under plain node). This builds and runs the actual bundle
// under `node`, the runtime the Deck spawns it with (ELECTRON_RUN_AS_NODE=1).
//
// COVERAGE NOTE: only the startup path (module load through `initialize`
// and `tools/list`) is exercised. No tool is actually CALLED, so this proves
// nothing about a Bun-only API reachable only from inside a tool handler --
// only that the process itself comes up and answers the MCP handshake.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "./_scrub-env.ts";

const dirs: string[] = [];
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
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wantedId: number,
  buffer: { text: string }
): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 15_000;
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

test("the node-bundled server-deck.mjs starts under node, answers initialize, and lists exactly the 5 named tools", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "cp-deck-bundle-"));
  dirs.push(outDir);
  const outfile = join(outDir, "server-deck.mjs");

  const build = Bun.spawn(
    ["bun", "build", "server-deck.ts", "--target=node", `--outfile=${outfile}`],
    { cwd: process.cwd(), env: scrubEnv(outDir), stdout: "pipe", stderr: "pipe" }
  );
  const buildExit = await build.exited;
  expect(buildExit).toBe(0);

  const proc = Bun.spawn(["node", outfile], { env: scrubEnv(outDir), stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);

  const stderrChunks: string[] = [];
  (async () => {
    const decoder = new TextDecoder();
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) stderrChunks.push(decoder.decode(value, { stream: true }));
    }
  })();

  const buffer = { text: "" };
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const send = (msg: unknown): void => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  };

  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "bundle-probe", version: "0.0.1" },
    },
  });
  const initResponse = (await readUntil(reader, 0, buffer)) as {
    result?: { serverInfo?: { name?: string }; capabilities?: unknown; instructions?: string };
  };
  expect(initResponse.result?.serverInfo?.name).toBe("claude-peers-deck");
  expect(initResponse.result?.capabilities).toEqual({ tools: {} });

  // The instructions block escapes every guard that looks at tools/list, so
  // it gets its own. The whole clause is pinned, not the words it is made
  // of: a text reusing "directive" and "roadmap_dispatch" to say the
  // OPPOSITE ("roadmap_dispatch is disabled here") satisfies both tokens
  // separately. Pinning a literal is right here because that sentence IS
  // the deliverable, nothing downstream reads it, and a future rewording
  // must go through this test on purpose. The cap bounds THIS block only:
  // the client charges every connected server's instructions to a single
  // budget and truncates silently, and that SUM is guarded nowhere today
  // (card d77f6e4a).
  const instructions = initResponse.result?.instructions ?? "";
  expect(instructions.length).toBeGreaterThan(0);
  expect(instructions.length).toBeLessThan(400);
  expect(instructions).toContain(
    "kind='directive' card filed and queued with the core server's roadmap tools is executed here, by roadmap_dispatch"
  );

  // This diagnostic is emitted only when Node evaluates a Bun-only config path.
  expect(stderrChunks.join("")).not.toContain("Bun is not defined");

  send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const listResponse = (await readUntil(reader, 1, buffer)) as {
    result?: { tools?: Array<{ name: string }> };
  };
  const names = (listResponse.result?.tools ?? []).map((t) => t.name).sort();
  expect(names).toEqual(
    ["ask_operator", "ask_operator_wait", "graph_draft_prepare", "graph_draft_send", "roadmap_dispatch"].sort()
  );
}, 30_000);
