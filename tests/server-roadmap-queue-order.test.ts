// Card 7defe381 LOT 1: `roadmap_list` gained an `order: "queue"` mode that
// renders the REAL dispatch order (queue ascending, waves grouped, non-queued
// after) instead of the MoSCoW grouping, plus a `queue:<n>` marker on any
// enqueued card's line in EITHER mode. Both are delegated to
// `queuedItems`/`wavesOf` (desktop/src/shared/workflow.ts) rather than a
// locally re-derived sort -- see the import comment in server.ts.
//
// DISCRIMINANT, not merely present: two cards sharing the same `queue` value
// must land in the SAME wave block (not two ranks), a lower `queue` value
// must render before a higher one regardless of creation order, and an
// unqueued card must carry no marker at all. A test that only checks "some
// queue text appears somewhere" would stay green even if the ordering were
// wrong -- this asserts relative POSITION in the rendered text.
//
// Harness mirrors server-roadmap-inactive-marker.test.ts: spawn `bun
// server.ts` for real (formatRoadmapQueueOrder/formatRoadmapItemLine are
// neither exported nor safely importable -- server.ts runs its MCP stdio
// loop unconditionally at module scope), speak JSON-RPC on stdin, read real
// tool output. `server-*` prefix per that file's existing precedent (local
// daemon spawn, exempted from the CI glob the same way).

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

test("roadmap_list order:queue renders real dispatch order with waves, queue marker shown in both modes", async () => {
  const h = await boot();

  // Creation order deliberately does NOT match intended queue order, so a
  // formatter that accidentally fell back to creation/priority order would
  // be caught rather than coincidentally matching.
  const createdA = await callTool(h, "roadmap_add", { title: "card A, will be queue:2", priority: "wont" });
  const createdB = await callTool(h, "roadmap_add", { title: "card B, will be queue:1", priority: "must" });
  const createdC = await callTool(h, "roadmap_add", { title: "card C, same wave as B", priority: "must" });
  const createdD = await callTool(h, "roadmap_add", { title: "card D, never queued", priority: "must" });
  for (const r of [createdA, createdB, createdC, createdD]) expect(r.result?.isError).toBeFalsy();

  const idA = toolText(createdA).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;
  const idB = toolText(createdB).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;
  const idC = toolText(createdC).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;
  const idD = toolText(createdD).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;

  async function fullId(shortId: string): Promise<string> {
    const detail = toolText(await callTool(h, "roadmap_get", { id: shortId }));
    return detail.match(/id: ([0-9a-f-]{36})/)![1]!;
  }
  const fullA = await fullId(idA);
  const fullB = await fullId(idB);
  const fullC = await fullId(idC);

  // queue now HAS an MCP write surface (roadmap_update's `queue` arg, card
  // 7defe381 lot 2a) -- this fixture predates that lot and still sets it
  // direct-broker, deck-signed, same pattern as the inactive-marker test;
  // that stays a legitimate second path (the Deck itself has no MCP tools),
  // not the only one.
  const patchA = await post<ItemRes>(`${h.b.url}/roadmap/upsert`, deckAuthored({ id: fullA, queue: 2 }));
  expect(patchA.status).toBe(200);
  expect(patchA.body.item.queue).toBe(2);
  const patchB = await post<ItemRes>(`${h.b.url}/roadmap/upsert`, deckAuthored({ id: fullB, queue: 1 }));
  expect(patchB.status).toBe(200);
  expect(patchB.body.item.queue).toBe(1);
  const patchC = await post<ItemRes>(`${h.b.url}/roadmap/upsert`, deckAuthored({ id: fullC, queue: 1 }));
  expect(patchC.status).toBe(200);
  expect(patchC.body.item.queue).toBe(1);
  // D is left with queue: null (never touched).

  // --- order: "queue" -----------------------------------------------------
  const queueListed = await callTool(h, "roadmap_list", { order: "queue" });
  expect(queueListed.result?.isError).toBeFalsy();
  const queueText = toolText(queueListed);

  const posA = queueText.indexOf(`[${idA}]`);
  const posB = queueText.indexOf(`[${idB}]`);
  const posC = queueText.indexOf(`[${idC}]`);
  const posD = queueText.indexOf(`[${idD}]`);
  expect(posA).toBeGreaterThan(-1);
  expect(posB).toBeGreaterThan(-1);
  expect(posC).toBeGreaterThan(-1);
  expect(posD).toBeGreaterThan(-1);

  // B and C share queue:1 -- must be the earlier wave, and grouped under the
  // SAME "WAVE" header block (discriminant: not merely "before A", but
  // sharing one heading with no other WAVE header between them).
  expect(posB).toBeLessThan(posA);
  expect(posC).toBeLessThan(posA);
  const waveHeaderBetweenBandC = queueText.slice(Math.min(posB, posC), Math.max(posB, posC)).includes("WAVE");
  expect(waveHeaderBetweenBandC).toBe(false);

  // Literal rendered text, not just relative position: this is the exact
  // promise roadmap_update's `queue` field description makes to an agent
  // ("same rank as another card forms one wave, dispatched together") --
  // measured here rather than assumed from reading wavesOf/formatRoadmapQueueOrder.
  expect(queueText).toContain("WAVE 1 (2 cards, dispatched together):");
  expect(queueText).toContain("WAVE 2 (1 card, dispatched together):");

  // D (never queued) must appear in the NOT QUEUED section, after the
  // dispatch queue section entirely.
  const dispatchQueueEnd = queueText.indexOf("NOT QUEUED");
  expect(dispatchQueueEnd).toBeGreaterThan(-1);
  expect(posD).toBeGreaterThan(dispatchQueueEnd);

  // Queue rank marker present on queued cards, absent on the unqueued one.
  const lineFor = (text: string, shortId: string) => text.split("\n").find((l) => l.startsWith(`[${shortId}]`)) ?? "";
  expect(lineFor(queueText, idA)).toContain("queue:2");
  expect(lineFor(queueText, idB)).toContain("queue:1");
  expect(lineFor(queueText, idC)).toContain("queue:1");
  expect(lineFor(queueText, idD)).not.toContain("queue:");

  // --- default mode (no order arg): unchanged MoSCoW grouping, but the
  // queue marker still shows on enqueued cards (criterion 2 applies to both
  // modes; the marker itself is zero-cost on D). --------------------------
  const defaultListed = await callTool(h, "roadmap_list", {});
  expect(defaultListed.result?.isError).toBeFalsy();
  const defaultText = toolText(defaultListed);
  expect(defaultText).toContain("MUST (");
  expect(defaultText).toContain("WONT (");
  expect(defaultText).not.toContain("DISPATCH QUEUE");
  expect(lineFor(defaultText, idA)).toContain("queue:2");
  expect(lineFor(defaultText, idB)).toContain("queue:1");
  expect(lineFor(defaultText, idD)).not.toContain("queue:");
}, 60_000);
