import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "./_scrub-env.ts";
import { OPERATOR_CEILING_ENV, OPERATOR_TOOLS, encodeMountCeiling } from "../shared/mount-ceiling.ts";

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ text?: string }>; isError?: boolean; tools?: Array<{ name: string }>; instructions?: string };
}

const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];
const stoppers: Array<() => void> = [];

afterAll(async () => {
  for (const stop of stoppers.splice(0)) stop();
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

const FULL_CEILING = encodeMountCeiling(OPERATOR_TOOLS);

/** A broker stand-in that records every request: a refused surface must leave it untouched. */
function recordingBroker(): { url: string; port: number; requests: string[] } {
  const requests: string[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({});
    },
  });
  stoppers.push(() => srv.stop(true));
  return { url: `http://127.0.0.1:${srv.port}`, port: srv.port as number, requests };
}

/** `ceiling` null leaves the mount variable absent; `tools` undefined leaves CLAUDE_PEERS_TOOLS absent. */
async function bootRestricted(tools: string | undefined, ceiling: string | null = FULL_CEILING) {
  const dir = mkdtempSync(join(tmpdir(), "cp-deck-tools-allowlist-"));
  dirs.push(dir);
  const broker = recordingBroker();
  const proc = Bun.spawn(["bun", "server-deck.ts"], {
    env: scrubEnv(dir, {
      CLAUDE_PEERS_BROKER_URL: broker.url,
      CLAUDE_PEERS_PORT: String(broker.port),
      ...(tools !== undefined ? { CLAUDE_PEERS_TOOLS: tools } : {}),
      ...(ceiling !== null ? { [OPERATOR_CEILING_ENV]: ceiling } : {}),
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  const stderr = { text: "" };
  void (async () => {
    const errReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await errReader.read();
      if (done) return;
      stderr.text += decoder.decode(value, { stream: true });
    }
  })();
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
  return { reader, buffer, send, stderr, broker, instructions: init.result?.instructions ?? "" };
}

async function listedNames(h: Awaited<ReturnType<typeof bootRestricted>>, id = 1): Promise<string[]> {
  h.send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
  const listed = await readUntil(h.reader, id, h.buffer);
  return (listed.result?.tools ?? []).map((tool) => tool.name).sort();
}

describe("server-deck.ts honors CLAUDE_PEERS_TOOLS under its mount ceiling", () => {
  test("tools/list omits a tool the allow-list excludes", async () => {
    const h = await bootRestricted("graph_draft_prepare");
    expect(await listedNames(h)).toEqual(["graph_draft_prepare"]);
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
    const h = await bootRestricted("");
    expect(await listedNames(h)).toEqual([]);
  }, 30_000);

  test("an absent allow-list under the full ceiling grants the operator family its complete surface", async () => {
    const h = await bootRestricted(undefined);
    expect(await listedNames(h)).toEqual([
      "ask_operator",
      "ask_operator_wait",
      "graph_draft_prepare",
      "graph_draft_send",
      "notify_operator",
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

describe("server-deck.ts mount ceiling (KORY_OPERATOR_TOOLS)", () => {
  const MALFORMED: Array<[string, string | null]> = [
    ["absent", null],
    ["empty", ""],
    ["an unknown tool name", "ask_operator,bogus_tool"],
    ["a duplicated name", "ask_operator,ask_operator"],
    ["an empty entry", "ask_operator,"],
    ["a space after the comma", "ask_operator, notify_operator"],
  ];

  for (const [label, ceiling] of MALFORMED) {
    test(`${label}: no tool is listed, even under a permissive CLAUDE_PEERS_TOOLS, and the trace names the variable`, async () => {
      const h = await bootRestricted(undefined, ceiling);
      expect(await listedNames(h)).toEqual([]);
      expect(h.instructions).toContain("mount ceiling is missing or invalid");
      expect(h.stderr.text).toContain("mount refused");
      expect(h.stderr.text).toContain(OPERATOR_CEILING_ENV);
    }, 30_000);
  }

  test("a well-formed ceiling serves exactly its names and leaves no refusal trace", async () => {
    const h = await bootRestricted(undefined, "graph_draft_prepare,notify_operator");
    expect(await listedNames(h)).toEqual(["graph_draft_prepare", "notify_operator"]);
    expect(h.stderr.text).not.toContain("mount refused");
  }, 30_000);

  test("none is the explicit empty set: zero tools and no refusal trace", async () => {
    const h = await bootRestricted(undefined, "none");
    expect(await listedNames(h)).toEqual([]);
    expect(h.stderr.text).not.toContain("mount refused");
  }, 30_000);

  test("CLAUDE_PEERS_TOOLS narrows the ceiling and never widens it", async () => {
    const h = await bootRestricted("ask_operator,graph_draft_prepare,graph_draft_send", "ask_operator,notify_operator");
    expect(await listedNames(h)).toEqual(["ask_operator"]);
  }, 30_000);

  test("send_message does not grant notify_operator when the ceiling omits it", async () => {
    const h = await bootRestricted("send_message", "ask_operator");
    expect(await listedNames(h)).toEqual([]);
  }, 30_000);

  test("every operator tool is refused by name on a refused surface, graph_draft_prepare and ask_operator_wait included, with no broker traffic", async () => {
    expect(OPERATOR_TOOLS).toContain("graph_draft_prepare");
    expect(OPERATOR_TOOLS).toContain("ask_operator_wait");
    const h = await bootRestricted(undefined, null);
    let id = 1;
    for (const name of OPERATOR_TOOLS) {
      h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
      const called = await readUntil(h.reader, id, h.buffer);
      expect(called.result?.isError, `${name} was served`).toBe(true);
      expect(called.result?.content?.[0]?.text, `${name} answered with something other than the refusal`).toBe(
        `Error: tool not available: ${name}`
      );
      id++;
    }
    expect(h.broker.requests, "a refused call reached the broker").toEqual([]);
  }, 30_000);

  test("a name outside a granted ceiling is refused on a call, not only hidden from the list", async () => {
    const h = await bootRestricted(undefined, "ask_operator");
    let id = 1;
    for (const name of OPERATOR_TOOLS.filter((candidate) => candidate !== "ask_operator")) {
      h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
      const called = await readUntil(h.reader, id, h.buffer);
      expect(called.result?.content?.[0]?.text, `${name} escaped the ceiling`).toBe(`Error: tool not available: ${name}`);
      id++;
    }
    expect(h.broker.requests).toEqual([]);
  }, 30_000);
});
