// Card c33a5968, major 2 (team-lead review, 2026-08-12): the MCP-facing
// population `inactive` is meant to keep OUT (any agent listing/reading a
// card before claiming it) previously had NO way to see the flag before
// hitting the 403 that tells it to do the one thing it is structurally
// forbidden from doing (`formatRoadmapItemLine`/`formatRoadmapItemDetail`,
// server.ts, rendered `locked` but not `inactive`). The fix added a
// `[INACTIVE -- do not claim]` suffix to the list line and an `inactive:`
// line to the detail view.
//
// This is the test the reviewer required for that fix. It must be
// DISCRIMINANT (team-lead's exact wording): an `inactive: true` item
// produces the marker, an `inactive: false` item does NOT -- a cell that
// only checks presence-on-the-inactive-item stays green even if the
// formatter started stamping the marker on every item unconditionally.
//
// Harness mirrors mcp-roadmap-ack.test.ts / server-ask-operator.test.ts:
// spawn `bun server.ts` for real (formatRoadmapItemLine/Detail are neither
// exported nor safely importable -- server.ts runs its MCP stdio loop
// unconditionally at module scope), speak JSON-RPC on stdin, read real tool
// output. No source file other than this one is touched by this change --
// see the team-lead's explicit review-window constraint.
//
// project_key plumbing: `roadmap_add`/`roadmap_get`/`roadmap_list` over MCP
// resolve the project_key from the spawned server's own cwd (server.ts's
// `roadmapProjectKey()`), which this test does not control and does not
// need to know -- every card below is created via the MCP tool itself, and
// the follow-up direct-broker PATCH that flips `inactive` addresses the row
// by `id` alone (broker.ts's patch path: "Partial patch: omitted fields
// keep their value; project_key never moves" -- it never reads
// `body.project_key` once `body.id` is set).
//
// `broker-*`-style daemon spawn (spawns `bun server.ts`, a real subprocess)
// but named `server-*` to match this file family's existing precedent
// (server-ask-operator.test.ts, mcp-roadmap-ack.test.ts) -- both prefixes are
// already exempted from the CI glob the same way (local-only via `bun test`).

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

test("inactive marker is discriminant across MCP list line and detail view: present only on the inactive card, absent on the active one", async () => {
  const h = await boot();

  const createdActive = await callTool(h, "roadmap_add", { title: "active card, never parked" });
  expect(createdActive.result?.isError).toBeFalsy();
  const idActive = toolText(createdActive).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;

  const createdTarget = await callTool(h, "roadmap_add", { title: "card about to be parked" });
  expect(createdTarget.result?.isError).toBeFalsy();
  const idTarget = toolText(createdTarget).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;

  // The direct-broker patch below needs the FULL id (`getRoadmapItem` does
  // an exact lookup, no prefix resolution -- that resolution is
  // `resolveRoadmapId`'s job, server-side only). roadmap_get's detail view
  // always renders a full `id: <uuid>` line, which is the only place this
  // test can read it from without duplicating server.ts's project_key
  // resolution.
  const targetDetailBefore = toolText(await callTool(h, "roadmap_get", { id: idTarget }));
  const idTargetFull = targetDetailBefore.match(/id: ([0-9a-f-]{36})/)![1]!;

  // Flip `inactive` on the second card only, direct-broker (deck-signed --
  // the MCP roadmap_update schema deliberately has no `inactive` field, per
  // this card's arbitration, so agents can't self-unblock). Addressed by
  // `id` alone -- the patch path never reads `project_key` once `id` is set.
  const parked = await post<ItemRes>(
    `${h.b.url}/roadmap/upsert`,
    deckAuthored({ id: idTargetFull, inactive: true })
  );
  expect(parked.status).toBe(200);
  expect(parked.body.item.inactive).toBe(true);

  // --- list line (roadmap_list) ---------------------------------------
  const listed = await callTool(h, "roadmap_list", {});
  expect(listed.result?.isError).toBeFalsy();
  const listText = toolText(listed);
  const activeListLine = listText.split("\n").find((l) => l.startsWith(`[${idActive}]`)) ?? "";
  const targetListLine = listText.split("\n").find((l) => l.startsWith(`[${idTarget}]`)) ?? "";
  expect(activeListLine).not.toBe("");
  expect(targetListLine).not.toBe("");

  expect(targetListLine).toContain("[INACTIVE -- do not claim]");
  expect(activeListLine).not.toContain("[INACTIVE");
  expect(activeListLine).not.toContain("INACTIVE");

  // --- detail view (roadmap_get) ---------------------------------------
  const activeDetail = toolText(await callTool(h, "roadmap_get", { id: idActive }));
  const targetDetail = toolText(await callTool(h, "roadmap_get", { id: idTarget }));

  // detail's first line is formatRoadmapItemLine's own output (server.ts:975
  // `${formatRoadmapItemLine(i)}`) -- same discriminant check, real call.
  expect(targetDetail.split("\n")[0]).toContain("[INACTIVE -- do not claim]");
  expect(activeDetail.split("\n")[0]).not.toContain("INACTIVE");

  // detail-only "inactive:" explanatory line.
  expect(targetDetail).toContain("inactive: this card is inactive");
  expect(activeDetail).not.toContain("inactive:");
}, 60_000);
