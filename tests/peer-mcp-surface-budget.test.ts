// Caps the total MCP surface (instructions plus TOOLS) the model reads on every
// turn, since nothing else notices it silently growing back.
// The extractor fails closed: a block that cannot be found, or measures
// implausibly small, fails this test rather than passing quietly.

import { test, expect, describe } from "bun:test";
import { callRoadmapTool, ROADMAP_INSTRUCTIONS } from "../shared/roadmap-mcp.ts";
import { ROADMAP_TOOLS } from "../shared/roadmap-tools.ts";

const SRC = await Bun.file(new URL("../server.ts", import.meta.url)).text();
const ROADMAP_CEILING_CHARS = 8_400;

// Use characters because the test runner has no tokenizer; keep the ceiling
// tight enough that one verbose description fails before small additions
// accumulate.
const CEILING_CHARS = 19_000;
// Below this, the extractor lost a block: a full TOOLS array cannot fit in so little.
const FLOOR_CHARS = 6_000;

function stripCommentLines(block: string): string {
  return block
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

export function measureInstructions(src: string): number {
  const start = src.indexOf("instructions: `");
  if (start < 0) throw new Error("instructions block not found in server.ts");
  const end = src.indexOf("`,", start);
  if (end < 0) throw new Error("instructions block is not terminated");
  return end - start;
}

export function measureTools(src: string): number {
  const start = src.indexOf("\nconst TOOLS = [");
  if (start < 0) throw new Error("TOOLS array not found in server.ts");
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error("TOOLS array is not terminated");
  return stripCommentLines(src.slice(start, end)).length;
}

function toolBlock(src: string, name: string): string {
  const marker = `    name: "${name}",`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`tool ${name} not found`);
  const end = src.indexOf("\n  },", start);
  if (end < 0) throw new Error(`tool ${name} block is not terminated`);
  return src.slice(start, end);
}

describe("the per-turn MCP surface stays under its cap", () => {
  test("kory-roadmap's schemas + instructions fit in ROADMAP_CEILING_CHARS", () => {
    const schemas = JSON.stringify(ROADMAP_TOOLS).length;
    const total = schemas + ROADMAP_INSTRUCTIONS.length;
    expect(
      total,
      `kory-roadmap per-turn surface (schemas ${schemas} + instructions ${ROADMAP_INSTRUCTIONS.length}) exceeds ${ROADMAP_CEILING_CHARS} chars: move text out of the tool descriptions or the instructions, do not raise the ceiling`
    ).toBeLessThanOrEqual(ROADMAP_CEILING_CHARS);
  });

  test("instructions + TOOLS (comment lines excluded) fit in CEILING_CHARS", () => {
    const total = measureInstructions(SRC) + measureTools(SRC);
    expect(total).toBeGreaterThan(FLOOR_CHARS);
    expect(total).toBeLessThanOrEqual(CEILING_CHARS);
  });

  test("the instructions block carries the peer-traffic rule, once", () => {
    // The rule that stops an agent narrating every peer exchange to the
    // operator. Asserted here because the block is otherwise untested, and
    // its first sentence is what the model reads before any tool call.
    const block = SRC.slice(SRC.indexOf("instructions: `"), SRC.indexOf("`,", SRC.indexOf("instructions: `")));
    expect(block).toContain("do not narrate it to the operator");
    expect(block).not.toContain("tapping you on the shoulder");
    // Dedup: the lock mechanics and the directive commands live in the tool
    // descriptions, not a second time here.
    expect(block).not.toContain("409");
    expect(block).not.toContain("magic_compact");
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
    // Pins that a call to this tool is restricted to an operator-invited flow,
    // since this description is now the only place the model reads that
    // restriction.
    const block = toolBlock(SRC, "graph_draft_prepare");
    expect(block).toContain("OPERATOR-INVITED ONLY");
    expect(block).toContain("never on your own initiative");
  });
});

describe("the measure bites", () => {
  test("an inflated description pushes the total over the cap, a comment does not", () => {
    const filler = "x".repeat(CEILING_CHARS);
    // Derives the inserted line separator from SRC's own line ending rather
    // than the platform, since a Windows checkout can smudge the committed LF
    // blob to CRLF and a hardcoded separator would then mismatch it.
    const NL = SRC.includes("\r\n") ? "\r\n" : "\n";
    const inflated = SRC.replace('name: "whoami",', `name: "whoami",${NL}    description: "${filler}",`);
    expect(measureInstructions(inflated) + measureTools(inflated)).toBeGreaterThan(CEILING_CHARS);
    const commented = SRC.replace('name: "whoami",', `name: "whoami",${NL}    // ${filler}`);
    expect(measureTools(commented)).toBe(measureTools(SRC));
  });

  test("a missing block is an error, not a zero", () => {
    expect(() => measureTools(SRC.replace("\nconst TOOLS = [", "\nconst TOOLZ = ["))).toThrow();
    expect(() => measureInstructions(SRC.replace("instructions: `", "instructionz: `"))).toThrow();
  });
});
