// Caps the total MCP surface (instructions plus tools/list) the model reads on every
// turn, since nothing else notices it silently growing back. The surface is
// measured as the peers session serves it over MCP, not read from source text.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPeersSession, DECK_ONLY_TOOLS, TOOLS, type PeersSession } from "../shared/peers-session.ts";
import { callRoadmapTool, ROADMAP_INSTRUCTIONS } from "../shared/roadmap-mcp.ts";
import { ROADMAP_TOOLS } from "../shared/roadmap-tools.ts";

const ROADMAP_CEILING_CHARS = 8_400;

// Use characters because the test runner has no tokenizer; keep the ceiling
// tight enough that one verbose description fails before small additions
// accumulate.
const CEILING_CHARS = 6_000;
// Below this, the measurement lost a block: a full tool list cannot fit in so little.
const FLOOR_CHARS = 5_000;

interface Surface {
  instructions: string;
  tools: Array<{ name: string; description?: string }>;
  close(): Promise<void>;
}

async function openSurface(): Promise<Surface> {
  const home = mkdtempSync(join(tmpdir(), "cp-surface-budget-"));
  const brokerFetch = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/register") {
      const body = JSON.parse(String(init?.body)) as { role?: string };
      return Response.json({ peer_id: "peer-1", instance_token: "token-1", inbox_binding: null, role: body.role ?? null });
    }
    if (path === "/peek-messages" || path === "/poll-messages") return Response.json({ messages: [] });
    return Response.json({ ok: true });
  };
  class IdleSocket {
    static CLOSED = 3;
    readyState = 0;
    addEventListener(): void {}
    send(): void {}
    close(): void {
      this.readyState = IdleSocket.CLOSED;
    }
  }
  const session: PeersSession = createPeersSession(
    {
      env: { XDG_CONFIG_HOME: home, APPDATA: home, CLAUDE_PEERS_PORT: "17999", CLAUDE_PEERS_LOG_DIR: join(home, "logs") },
      cwd: home,
      pid: 777,
      ppid: 4242,
      stdinIsTty: false,
    },
    {
      log: { log: () => {}, logError: () => {} },
      home,
      hostname: () => "test-host",
      ensureBroker: async () => {},
      measureWriterGeneration: async () => null,
      settings: {
        contextResumeKeyTtlMs: 300_000,
        pollFallbackIntervalMs: 3_600_000,
        heartbeatIntervalMs: 3_600_000,
        disconnectBoundMs: 3_000,
        wsReconnectInitialMs: 60_000,
      },
      fetch: brokerFetch as unknown as typeof fetch,
      WebSocket: IdleSocket as unknown as typeof WebSocket,
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "surface-budget-test", version: "1.0.0" });
  await client.connect(clientTransport);
  await session.ready;
  return {
    instructions: client.getInstructions() ?? "",
    tools: (await client.listTools()).tools,
    close: async () => {
      await client.close();
      await session.close("bye");
      rmSync(home, { recursive: true, force: true });
    },
  };
}

let surface: Surface;
beforeAll(async () => {
  surface = await openSurface();
});
afterAll(async () => {
  await surface?.close();
});

describe("the per-turn MCP surface stays under its cap", () => {
  test("kory-roadmap's schemas + instructions fit in ROADMAP_CEILING_CHARS", () => {
    const schemas = JSON.stringify(ROADMAP_TOOLS).length;
    const total = schemas + ROADMAP_INSTRUCTIONS.length;
    expect(
      total,
      `kory-roadmap per-turn surface (schemas ${schemas} + instructions ${ROADMAP_INSTRUCTIONS.length}) exceeds ${ROADMAP_CEILING_CHARS} chars: move text out of the tool descriptions or the instructions, do not raise the ceiling`
    ).toBeLessThanOrEqual(ROADMAP_CEILING_CHARS);
  });

  test("the session serves every tool of TOOLS, so the measure covers the whole list", () => {
    expect(surface.tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
  });

  test("instructions + tools/list fit in CEILING_CHARS", () => {
    const tools = JSON.stringify(surface.tools).length;
    const total = surface.instructions.length + tools;
    expect(total, "the served surface measures implausibly small: the instructions or the tool list went missing").toBeGreaterThan(FLOOR_CHARS);
    expect(
      total,
      `claude-peers per-turn surface (instructions ${surface.instructions.length} + tools/list ${tools}) exceeds ${CEILING_CHARS} chars: move text out of the tool descriptions or the instructions, do not raise the ceiling`
    ).toBeLessThanOrEqual(CEILING_CHARS);
  });

  test("the instructions carry the peer-traffic rule, once", () => {
    // The rule that stops an agent narrating every peer exchange to the
    // operator: its first sentence is what the model reads before any tool call.
    const rule = "do not narrate it to the operator";
    expect(surface.instructions.split(rule).length - 1, "peer-traffic rule missing or repeated").toBe(1);
    expect(surface.instructions).not.toContain("tapping you on the shoulder");
    // Dedup: the lock mechanics and the directive commands live in the tool
    // descriptions, not a second time here.
    expect(surface.instructions).not.toContain("409");
    expect(surface.instructions).not.toContain("magic_compact");
  });
});

describe("kory-roadmap serves the SHARED ROADMAP instructions", () => {
  test("the instructions state the status order and who holds the in_progress lock", () => {
    expect(ROADMAP_INSTRUCTIONS, "status transition order missing from the served instructions").toContain(
      "planned -> in_progress -> done"
    );
    expect(ROADMAP_INSTRUCTIONS, "in_progress lock owner missing from the served instructions").toContain(
      "LOCKS the item under your peer_id"
    );
  });

  test("the instructions tell an agent that stops to put the item back to planned", () => {
    expect(ROADMAP_INSTRUCTIONS, "release rule missing: a stopped agent would keep the lock").toContain(
      "set it back to planned if you stop before finishing"
    );
  });

  test("the instructions explain triage and how to find executable work", () => {
    expect(ROADMAP_INSTRUCTIONS, "ready-for-agent is no longer defined").toContain(
      "ready-for-agent means it is specified enough to take without a human question"
    );
    expect(ROADMAP_INSTRUCTIONS, "needs-info is no longer defined").toContain("needs-info awaits one");
    expect(ROADMAP_INSTRUCTIONS, "no pointer to the triage filter").toContain('triages:["ready-for-agent"]');
  });

  test("the instructions explain the directive card", () => {
    expect(ROADMAP_INSTRUCTIONS, "directive card guidance missing").toContain("kind='directive'");
  });

  test("the instructions stay out of the lock mechanics the tool descriptions own", () => {
    expect(ROADMAP_INSTRUCTIONS).not.toContain("409");
    expect(ROADMAP_INSTRUCTIONS).not.toContain("magic_compact");
  });
});

describe("kory-roadmap registry and handler", () => {
  test("roadmap_list exposes plural filters and still forwards legacy singular filters", async () => {
    const schema = ROADMAP_TOOLS.find((tool) => tool.name === "roadmap_list");
    expect(schema).toBeDefined();
    const properties = schema!.inputSchema.properties;
    for (const singular of ["kind", "status", "priority", "tag"]) {
      expect(properties).not.toHaveProperty(singular);
    }
    for (const plural of ["kinds", "statuses", "priorities", "tags", "efforts", "values", "q", "include_archived"]) {
      expect(properties).toHaveProperty(plural);
    }

    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    const result = await callRoadmapTool(
      "roadmap_list",
      { kind: "bug", status: "planned", priority: "must", tag: "mcp" },
      {
        identity: { peerId: "probe-peer", projectKey: "github.com/example/probe" },
        brokerFetch: async <T>(path: string, body: Record<string, unknown>) => {
          sent.push({ path, body });
          return { items: [] } as T;
        },
      },
    );
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(sent.map((request) => request.path)).toEqual(["/roadmap/list"]);
    expect(sent[0]!.body, "a legacy singular filter was dropped before reaching the broker").toMatchObject({
      project_key: "github.com/example/probe",
      kind: "bug",
      status: "planned",
      priority: "must",
      tag: "mcp",
    });
  });

  test("roadmap_append_context keeps overwrite guidance", () => {
    const schema = ROADMAP_TOOLS.find((tool) => tool.name === "roadmap_append_context");
    expect(schema?.description).toContain("roadmap_update replaces");
    expect(schema?.description).toContain("operator's next Save may overwrite appended text");
    expect(schema?.description).toContain("durable facts go in description/rationale");
    expect(schema?.description).not.toContain("Capped per call");
  });
});

describe("graph_draft_prepare: the invite gate is a mono-carrier", () => {
  test("the operator-invited restriction still lives somewhere the model reads", () => {
    // A call to this tool is restricted to an operator-invited flow, and this
    // description is the only place the model reads that restriction.
    const description = DECK_ONLY_TOOLS.find((tool) => tool.name === "graph_draft_prepare")?.description ?? "";
    expect(description, "graph_draft_prepare is no longer declared by the operator family").not.toBe("");
    expect(description).toContain("OPERATOR-INVITED ONLY");
    expect(description).toContain("never on your own initiative");
  });
});
