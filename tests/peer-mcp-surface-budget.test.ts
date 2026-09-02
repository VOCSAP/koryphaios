// Caps the total MCP surface (instructions plus TOOLS) the model reads on every
// turn, since nothing else notices it silently growing back.
// The extractor fails closed: a block that cannot be found, or measures
// implausibly small, fails this test rather than passing quietly.

import { test, expect, describe } from "bun:test";

const SRC = await Bun.file(new URL("../server.ts", import.meta.url)).text();

// Chars, not tokens: no tokenizer in the test runner, and the ratio is stable
// enough for a cap (measured ~1.25 tokens per 4 chars on this JSON-ish text).
// Headroom above the post-lot measure (~17 800) is deliberately small, so a
// single verbose description fails rather than ten small ones accumulating.
const CEILING_CHARS = 19_000;
// Below this, the extractor lost a block: a full TOOLS array cannot fit in so little.
const FLOOR_CHARS = 8_000;

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
    // Pins the status transition order and which peer_id locks the item
    // in_progress, since this block is now the only place those facts are
    // stated for the model.
    expect(block).toContain("planned -> in_progress -> done");
    expect(block).toContain("LOCKS the item under your peer_id");
  });
});

describe("roadmap_list: the singular filters left the schema, not the handler", () => {
  test("the schema exposes only the plural filters", () => {
    const schema = toolBlock(SRC, "roadmap_list");
    for (const singular of ["kind", "status", "priority", "tag"]) {
      expect(schema).not.toMatch(new RegExp(`^\\s{8}${singular}:`, "m"));
    }
    for (const plural of ["kinds", "statuses", "priorities", "tags", "efforts", "values", "q", "include_archived"]) {
      expect(schema).toMatch(new RegExp(`^\\s{8}${plural}:`, "m"));
    }
    expect(schema).toContain("Always pass a filter");
  });

  test("the handler still forwards a singular an older agent may send", () => {
    // The broker takes the UNION of both forms (mergeEnumFilter, broker.ts);
    // this pins the hop between the MCP argument and that request.
    const start = SRC.indexOf('case "roadmap_list":');
    expect(start).toBeGreaterThan(0);
    const handler = SRC.slice(start, SRC.indexOf("case ", start + 10));
    for (const singular of ["kind", "status", "priority", "tag"]) {
      expect(handler).toContain(`${singular}: a.${singular},`);
    }
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
