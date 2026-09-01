// spec_ec5cf671 (2026-08-20). The MCP surface of server.ts -- the
// `instructions` block and the TOOLS array -- is read by the model on EVERY
// turn of EVERY session connected to claude-peers. Measured before this lot:
// ~24 000 chars of TOOLS plus ~4 800 of instructions, roughly 7 500 real
// tokens per turn, most of it design rationale that changes nothing about how
// a tool is called. The lot brought it down to ~17 800 chars. Nothing else
// would notice it growing back: a longer description compiles, passes every
// behavioural test and ships. This file is the cap.
//
// COVERAGE, NOT ONLY SENSITIVITY (CLAUDE.md). The extractor below is the kind
// of parser that can silently shrink to a subset and report success, so it
// fails CLOSED: a block that cannot be found, or that measures implausibly
// small, is a failure of this test, not a pass. And the meta-test at the end
// proves the measure bites on an inflated copy, in the diff, so the proof is
// replayed rather than remembered.
//
// server.ts exports nothing and runs its stdio loop at module scope, so the
// blocks are measured on the SOURCE TEXT. Comment lines are excluded: a
// comment is the sanctioned place for the WHY and is never sent to the model.
//
// `peer-` prefix: pure, binds no port, spawns nothing, so it belongs in the
// CI matrix that collects that prefix (see peer-inbound-framing.test.ts).

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
    // Card 4658b614: roadmap_update's own description no longer states the
    // status transition order or which peer_id in_progress locks under --
    // this block is now the ONLY carrier of both facts. Pin them so a future
    // trim of `instructions` cannot silently drop the last copy.
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
    // `instructions` used to repeat this gate ("ONLY when the operator
    // explicitly asks..."), and that copy was cut as a duplicate of this
    // tool's own description (2026-09-01 MCP-surface trim). Cutting it made
    // THIS the only remaining carrier of "never call this on your own
    // initiative" -- pin it so a future trim of this description cannot drop
    // it silently, the same way the instructions-block test above pins its
    // own facts.
    const block = toolBlock(SRC, "graph_draft_prepare");
    expect(block).toContain("OPERATOR-INVITED ONLY");
    expect(block).toContain("never on your own initiative");
  });
});

describe("the measure bites", () => {
  test("an inflated description pushes the total over the cap, a comment does not", () => {
    const filler = "x".repeat(CEILING_CHARS);
    // server.ts's line ending is NOT fixed across checkouts: the blob committed
    // to git is LF-only (measured: 0 CR, 1975 bare "\n"), and a Windows checkout
    // with core.autocrlf=true smudges it to CRLF locally (1975 "\r\n", 0 bare
    // "\n") -- ubuntu-latest/macos-latest CI check out the LF blob as-is. A
    // hardcoded "\r\n" insertion is therefore right on a Windows working copy
    // and wrong on a Linux/macOS one: on the LF blob it splits SRC's own "\n"
    // pair into two lines, so the trailing bare "\n" survives as an extra
    // character when its line is a comment and gets stripped -- a 1-char
    // artifact of the insertion mismatching SRC's own line ending, not of
    // stripCommentLines against real file content. Deriving the separator from
    // SRC itself (rather than branching on process.platform, which would hide
    // the defect behind a platform check instead of closing it) keeps the
    // insertion consistent with SRC on every checkout.
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
