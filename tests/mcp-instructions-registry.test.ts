// Deliberately no syntax model here: a stack-based brace/paren scanner
// desyncs on ordinary punctuation elsewhere in this codebase (a regex
// character class, an unmatched quote in JSX text), which degrades this
// exact guard to a silent SUBSET. A plain substring search over three
// literal tokens has nothing to desync on, at the cost of also flagging
// files that merely mention one of them in prose -- those are triaged once
// below, by hand, with a verdict.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "./_scrub-env.ts";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Any file containing one of these, verbatim, must be triaged below. */
const DOMAIN_TOKENS = ["@modelcontextprotocol/sdk", "serverInfo", "instructions"] as const;

function domainTokensIn(source: string): string[] {
  return DOMAIN_TOKENS.filter((t) => source.includes(t));
}

/**
 * Domain is every TRACKED source file (`git ls-files --cached`, never a
 * filesystem walk, which would re-collect a stray git-worktree checkout
 * living on disk under the same tree), minus tests/, that contains at least
 * one domain token.
 */
function scanRepoForTokenHits(): Array<{ file: string; tokens: string[] }> {
  const result = spawnSync("git", ["ls-files", "--cached"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: scrubEnv(tmpdir()),
  });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  const files = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx|js|mjs|cjs|jsx)$/.test(f))
    .filter((f) => !f.startsWith("tests/") && !/\.test\.(ts|tsx|js|jsx)$/.test(f));

  const hits: Array<{ file: string; tokens: string[] }> = [];
  for (const rel of files) {
    const source = readFileSync(join(REPO_ROOT, rel), "utf-8");
    const tokens = domainTokensIn(source);
    if (tokens.length > 0) hits.push({ file: rel, tokens });
  }
  return hits;
}

type Verdict = { carries: true; name: string } | { carries: false };

/**
 * One line per file this repo tracks that mentions a domain token, each with
 * a verdict reached once by reading it.
 *
 * Guards the DOMAIN's composition (a file gaining or losing every token
 * reddens); does NOT re-check a listed file's VERDICT, so a `carries:
 * false` file that starts serving a real block, or a `carries: true` file
 * that stops carrying one, both stay silently declared as they were. Extension
 * boundary is `ts/tsx/js/mjs/cjs/jsx` only -- a block loaded from JSON or
 * Markdown is outside the domain entirely.
 *
 * Forward slashes on purpose, matching `git ls-files`'s own normalization
 * (it never emits a backslash, even on Windows): a platform-`join`-ed path
 * would fail this test on every Windows checkout.
 */
const TRIAGED_DOMAIN_FILES: ReadonlyArray<{ file: string; verdict: Verdict }> = [
  { file: "server.ts", verdict: { carries: true, name: "claude-peers" } },
  { file: "server-deck.ts", verdict: { carries: true, name: "claude-peers-deck" } },
  { file: "desktop/mcp/deck-control-mcp.ts", verdict: { carries: true, name: "deck-control" } },
  { file: "desktop/mcp/demo-browser-mcp.ts", verdict: { carries: true, name: "demo-browser" } },
  { file: "desktop/src/main/demo-driver.ts", verdict: { carries: false } },
  { file: "desktop/src/main/graph-engine.ts", verdict: { carries: false } },
  { file: "desktop/src/main/model-adapters.ts", verdict: { carries: false } },
  { file: "desktop/src/main/peer-rotation.ts", verdict: { carries: false } },
  { file: "desktop/src/main/supervisor.ts", verdict: { carries: false } },
  { file: "desktop/src/renderer/src/components/RoadmapView.tsx", verdict: { carries: false } },
  { file: "desktop/src/shared/announce.ts", verdict: { carries: false } },
  { file: "notify/format.ts", verdict: { carries: false } },
  { file: "notify/telegram.ts", verdict: { carries: false } },
  { file: "shared/inbound-framing.ts", verdict: { carries: false } },
];

describe("domainTokensIn: the fence itself", () => {
  test("a file with none of the three tokens is not flagged", () => {
    expect(domainTokensIn('export function add(a: number, b: number) { return a + b; }')).toEqual([]);
  });

  test("punctuation-heavy source (a quote-matching regex) does not hide a real carrier in the same file", () => {
    const src = [
      "const QUOTE_RE = /['\"]/g;",
      'const mcp = new Server({ name: "x" }, { capabilities: {}, instructions: "hi" });',
    ].join("\n");
    expect(domainTokensIn(src)).toContain("instructions");
  });

  // A serving mechanism must place the literal key on the wire eventually,
  // whatever the syntax around it.
  const carryingForms: Array<[string, string]> = [
    ["shorthand property", 'const mcp = new Server(info, { capabilities, instructions });'],
    [
      "spread options built elsewhere in the file",
      'const opts = { instructions: "hi" };\nconst mcp = new Server(info, { ...opts, capabilities: {} });',
    ],
    [
      "McpServer, not Server",
      'const mcp = new McpServer({ name: "x" }, { capabilities: {}, instructions: "hi" });',
    ],
    [
      "renamed import",
      'import { Server as PeerServer } from "@modelcontextprotocol/sdk/server/index.js";\nconst mcp = new PeerServer({ name: "x" }, { instructions: "hi" });',
    ],
    [
      "options assigned to a named variable",
      'const serverOpts = { capabilities: {}, instructions: TEXT };\nconst mcp = new Server(info, serverOpts);',
    ],
    [
      "initialize result built in two steps",
      'const initResult = { serverInfo, instructions: TEXT };\nreturn reply(id, initResult);',
    ],
    ["hand-rolled reply, shorthand", 'return reply(id, { serverInfo, instructions });'],
    ["Object.assign", 'return reply(id, Object.assign({}, { serverInfo, instructions }));'],
    [
      "factored into a shared helper",
      'function buildInitReply(name: string, instructionsText: string) {\n  return { serverInfo: { name }, instructions: instructionsText };\n}',
    ],
  ];
  for (const [label, src] of carryingForms) {
    test(`catches the "${label}" form`, () => {
      expect(domainTokensIn(src).length, `form "${label}" carries no domain token: the fence would miss it`).toBeGreaterThan(0);
    });
  }
});

describe("every file mentioning an MCP-instructions token is triaged, not silently ignored", () => {
  const found = scanRepoForTokenHits();

  test("the scan finds at least as many token-bearing files as are triaged", () => {
    expect(
      found.length,
      `Domain scan over git-tracked source found ${found.length} file(s) mentioning ` +
        `${DOMAIN_TOKENS.join(", ")}; TRIAGED_DOMAIN_FILES lists ${TRIAGED_DOMAIN_FILES.length}. A count ` +
        `BELOW that means the SCAN itself is broken (an extension filter or a token dropped from ` +
        `DOMAIN_TOKENS) -- fix the scan, never shrink the triage list to match a degraded count.`
    ).toBeGreaterThanOrEqual(TRIAGED_DOMAIN_FILES.length);
  });

  test("the scanned set names exactly the files the triage list covers, both ways", () => {
    const scannedFiles = [...new Set(found.map((c) => c.file))].sort();
    const triagedFiles = [...new Set(TRIAGED_DOMAIN_FILES.map((c) => c.file))].sort();
    expect(
      scannedFiles,
      "A file appears here that TRIAGED_DOMAIN_FILES does not cover, or a triaged file no longer " +
        "mentions any of the three tokens. Either way a verdict was never reached for the current set: " +
        "read the file and add or remove its line in TRIAGED_DOMAIN_FILES."
    ).toEqual(triagedFiles);
  });

  test("the files triaged as real carriers are named exactly, independent of the triage list's own carries flag", () => {
    // Duplicated on purpose: a silent edit of a `carries` flag above must
    // still be caught by a hand-typed list that does not read from the same
    // table it is meant to check.
    const KNOWN_CARRIER_NAMES = ["claude-peers", "claude-peers-deck", "deck-control", "demo-browser"];
    const namesFromTriage = TRIAGED_DOMAIN_FILES.filter(
      (e): e is { file: string; verdict: { carries: true; name: string } } => e.verdict.carries
    )
      .map((e) => e.verdict.name)
      .sort();
    expect(namesFromTriage, "the set of files triaged carries:true changed").toEqual([...KNOWN_CARRIER_NAMES].sort());
  });
});
