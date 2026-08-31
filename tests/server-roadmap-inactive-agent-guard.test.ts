// Card 442084b7 (team-lead's proof requirement): the UI lot that gave the
// Deck operator a menu action to set/clear `inactive` (RoadmapUpsertFields,
// shared/types.ts) touches ONLY desktop/ -- it never modifies server.ts. This
// is the regression pin proving that lot did not, as a side effect, open the
// same capability to an AGENT calling the claude-peers `roadmap_update` MCP
// tool.
//
// server.ts's `case "roadmap_update"` builds the POST /roadmap/upsert body
// from an explicit PICK-LIST of named fields (never a `...args` spread), and
// `inactive` is not one of them (see the `[INACTIVE] is an operator flag
// with no agent-side field on purpose` comment a few lines above that case).
// An agent CAN still put `inactive` in its tool-call arguments -- nothing on
// the MCP transport enforces the advertised inputSchema -- so the primary
// assertion is not "the call errors", it is "the stored value did not move":
// re-read through the SAME MCP tool a real agent would use.
//
// Mirror-probe red-first proof (2026-08-31, reported to the team-lead, never
// committed): in a /tmp mirror of this repo (mirror-probe skill, recipe 2),
// temporarily added `inactive: a.inactive,` to server.ts's roadmap_update
// pick-list. This test went RED, but on the OTHER assertion
// (`expect(attempt.result?.isError).toBeFalsy()` saw `true`), not the value
// re-read -- because forwarding the field just moves the fight one layer
// down: broker.ts's own `refusesInactiveToggle` (shared/roadmap-lock.ts) then
// 403s the write itself, since an agent's `by` is never operator-signed.
// This is a STRONGER result than the one this comment originally predicted:
// two independent layers (server.ts's pick-list, broker.ts's operator-proof
// guard) each independently block the same attack, so this test's `isError`
// assertion is itself a live tripwire for the pick-list layer, on top of the
// value re-read pinning the broker layer. Reverting the mutation restored
// GREEN (matches the untouched baseline: 1 pass, isError false, value
// unchanged). Both layers bite.
//
// Harness mirrors tests/server-roadmap-inactive-marker.test.ts exactly:
// spawns real `bun server.ts` (its MCP tool logic is neither exported nor
// safely importable -- the file runs its stdio loop unconditionally at
// module scope), speaks JSON-RPC on stdin, reads real tool output.

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

  // Belt-and-suspenders direct-broker re-read (bypasses server.ts entirely,
  // same discriminant tests/server-roadmap-inactive-marker.test.ts uses).
  const directRead = await post<ItemRes>(`${h.b.url}/roadmap/upsert`, deckAuthored({ id: idFull }));
  expect(directRead.status).toBe(200);
  expect(directRead.body.item.inactive).toBe(true);
}, 60_000);
