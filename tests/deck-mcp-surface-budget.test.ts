import { test, expect, describe } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DECK_TOOL_NAMES, mcp } from "../server-deck.ts";

type DeckTool = { name: string; description?: string; inputSchema: unknown };

const DECK_CEILING_CHARS = 3_423;
const DECK_FLOOR_CHARS = 2_700;
const DECK_INSTRUCTIONS_MAX_CHARS = 400;

const LIMIT =
  "this caps CHARACTERS, not tokens, and only the tools/list payload plus the initialize instructions " +
  "of the Deck-only server; it does not bound the text a tool returns at run time, and the core TOOLS " +
  "ceiling is a separate budget";

async function serveDeck(): Promise<{ tools: DeckTool[]; instructions: string }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "deck-budget-probe", version: "0.0.0" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    const instructions = client.getInstructions();
    if (instructions === undefined) throw new Error("the Deck server served no instructions");
    return { tools: tools as DeckTool[], instructions };
  } finally {
    await client.close();
  }
}

const SERVED = await serveDeck();

export function measureDeckSurface(tools: readonly DeckTool[], instructions: string): number {
  if (tools.length === 0) throw new Error("the Deck server served no tool");
  if (instructions.length === 0) throw new Error("the Deck server served empty instructions");
  const names = tools.map((t) => t.name);
  const expected = new Set<string>(DECK_TOOL_NAMES);
  const got = new Set(names);
  const missing = [...expected].filter((n) => !got.has(n));
  const extra = [...got].filter((n) => !expected.has(n));
  if (missing.length > 0 || extra.length > 0 || names.length !== got.size) {
    throw new Error(
      `served Deck tools differ from DECK_TOOL_NAMES: missing=[${missing}] extra=[${extra}] duplicates=${names.length - got.size}`,
    );
  }
  return JSON.stringify(tools).length + instructions.length;
}

function withInflatedDescription(tools: readonly DeckTool[], name: string, extra: number): DeckTool[] {
  const copy = structuredClone(tools) as DeckTool[];
  const target = copy.find((t) => t.name === name);
  if (!target) throw new Error(`tool ${name} not found`);
  target.description = (target.description ?? "") + "x".repeat(extra);
  return copy;
}

describe("the per-turn Deck-only MCP surface stays under its cap", () => {
  test("the served tools/list plus the served instructions fit between the floor and DECK_CEILING_CHARS", () => {
    const total = measureDeckSurface(SERVED.tools, SERVED.instructions);
    expect(total, `Deck-only surface fell to ${total} chars: the server served a truncated surface`).toBeGreaterThan(
      DECK_FLOOR_CHARS,
    );
    expect(
      total,
      `Deck-only surface is ${total} chars, ceiling ${DECK_CEILING_CHARS}: shorten the descriptions or the instructions, never raise the ceiling; ${LIMIT}`,
    ).toBeLessThanOrEqual(DECK_CEILING_CHARS);
  });

  test("the served instructions stay within their own promised size", () => {
    expect(
      SERVED.instructions.length,
      `the Deck instructions block is concatenated into one shared budget with the core block and must stay at ${DECK_INSTRUCTIONS_MAX_CHARS} chars or fewer`,
    ).toBeLessThanOrEqual(DECK_INSTRUCTIONS_MAX_CHARS);
  });
});

describe("the Deck measure bites", () => {
  test("growing ANY one served tool's description alone pushes the total over the ceiling", () => {
    const intact = measureDeckSurface(SERVED.tools, SERVED.instructions);
    expect(intact, `positive witness: the untouched surface must fit, ${LIMIT}`).toBeLessThanOrEqual(DECK_CEILING_CHARS);
    expect(SERVED.tools.length, "the loop below must cover every Deck-only tool").toBe(DECK_TOOL_NAMES.length);
    for (const { name } of SERVED.tools) {
      const total = measureDeckSurface(
        withInflatedDescription(SERVED.tools, name, DECK_CEILING_CHARS - intact + 1),
        SERVED.instructions,
      );
      expect(total, `${name} is not counted: growing its description by one char past the ceiling stayed under it`).toBeGreaterThan(
        DECK_CEILING_CHARS,
      );
    }
  });

  test("growing the served instructions alone pushes the total over the ceiling", () => {
    const intact = measureDeckSurface(SERVED.tools, SERVED.instructions);
    const total = measureDeckSurface(SERVED.tools, SERVED.instructions + "x".repeat(DECK_CEILING_CHARS - intact + 1));
    expect(total, `the instructions are not counted, ${LIMIT}`).toBeGreaterThan(DECK_CEILING_CHARS);
  });

  test("an empty list, a missing tool, a renamed tool, a sixth tool, a duplicate and empty instructions each throw instead of measuring less", () => {
    const { tools, instructions } = SERVED;
    expect(() => measureDeckSurface([], instructions)).toThrow();
    expect(() => measureDeckSurface(tools.slice(1), instructions)).toThrow(/missing=/);
    const renamed = structuredClone(tools) as DeckTool[];
    renamed[0]!.name = "roadmap_dispatch_renamed";
    expect(() => measureDeckSurface(renamed, instructions)).toThrow(/extra=\[roadmap_dispatch_renamed\]/);
    const sixth = [...tools, { name: "sixth_tool", description: "d", inputSchema: {} }];
    expect(() => measureDeckSurface(sixth, instructions)).toThrow(/extra=\[sixth_tool\]/);
    expect(() => measureDeckSurface([...tools, tools[0]!], instructions)).toThrow(/duplicates=1/);
    expect(() => measureDeckSurface(tools, "")).toThrow();
  });
});
