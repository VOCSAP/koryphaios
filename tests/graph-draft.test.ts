// Graph-draft harness builders (shared/graph-draft): the haiku one-shot argv,
// the user-message composition, the output split and the payload validation
// shared by server tool and broker endpoint. Pure module.

import { test, expect } from "bun:test";
import {
  buildDraftPrepareArgs,
  composeDraftUserMessage,
  parseDraftOutput,
  validateDraftPayload,
  GRAPH_DRAFT_DISALLOWED_TOOLS,
  GRAPH_DRAFT_MODEL,
  GRAPH_DRAFT_PROMPT_MAX,
  GRAPH_DRAFT_TITLE_MAX,
} from "../shared/graph-draft.ts";

test("buildDraftPrepareArgs pins haiku, read-only flags, argv form (no shell)", () => {
  const args = buildDraftPrepareArgs({
    userMessage: 'question with "quotes" and $vars',
    systemPromptFile: "/tmp/x.md",
  });
  expect(args[0]).toBe("claude");
  // Argv form: the message travels as ONE argument, quoting is a non-issue.
  expect(args).toContain('question with "quotes" and $vars');
  expect(args).toContain("--model");
  expect(args[args.indexOf("--model") + 1]).toBe(GRAPH_DRAFT_MODEL);
  expect(args).toContain("--strict-mcp-config");
  expect(args[args.indexOf("--disallowedTools") + 1]).toBe(GRAPH_DRAFT_DISALLOWED_TOOLS);
  expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("/tmp/x.md");
});

test("buildDraftPrepareArgs honours an alternate binary", () => {
  const args = buildDraftPrepareArgs({
    userMessage: "q",
    systemPromptFile: "/tmp/x.md",
    claudeBin: "/opt/claude",
  });
  expect(args[0]).toBe("/opt/claude");
});

test("composeDraftUserMessage includes hints only when given, and truncates", () => {
  expect(composeDraftUserMessage("why?")).toBe("Agent question:\nwhy?");
  const withHints = composeDraftUserMessage("why?", "see broker.ts");
  expect(withHints).toContain("Agent hints");
  expect(withHints).toContain("see broker.ts");
  const long = composeDraftUserMessage("x".repeat(100_000));
  expect(long.length).toBeLessThan(10_000);
});

test("parseDraftOutput splits the title line from the prompt body", () => {
  const { title, prompt } = parseDraftOutput(
    "# Choix de cache\n\n## Question\nRedis ou en mémoire ?",
    "fallback"
  );
  expect(title).toBe("Choix de cache");
  expect(prompt).toBe("## Question\nRedis ou en mémoire ?");
});

test("parseDraftOutput falls back to the question when the title is missing", () => {
  const { title, prompt } = parseDraftOutput("## Question\nno title line", "ma question");
  expect(title).toBe("ma question");
  expect(prompt).toContain("no title line");
});

test("parseDraftOutput enforces the length caps", () => {
  const { title, prompt } = parseDraftOutput(
    `# ${"t".repeat(1000)}\n\n${"p".repeat(GRAPH_DRAFT_PROMPT_MAX * 2)}`,
    "f"
  );
  expect(title.length).toBe(GRAPH_DRAFT_TITLE_MAX);
  expect(prompt.length).toBe(GRAPH_DRAFT_PROMPT_MAX);
});

test("validateDraftPayload normalizes and rejects", () => {
  expect(validateDraftPayload({ title: "  t  ", prompt: " p " })).toEqual({
    title: "t",
    prompt: "p",
  });
  expect("error" in validateDraftPayload({ prompt: "p" })).toBe(true);
  expect("error" in validateDraftPayload({ title: "t" })).toBe(true);
  expect("error" in validateDraftPayload({ title: "t", prompt: 42 })).toBe(true);
  expect(
    "error" in validateDraftPayload({ title: "t", prompt: "x".repeat(GRAPH_DRAFT_PROMPT_MAX + 1) })
  ).toBe(true);
});
