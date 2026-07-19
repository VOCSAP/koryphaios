// PLAN C21: context wand — the system prompt is a code constant that forces
// the briefing pattern (C8 rule), the user prompt carries the item as
// delimited data with per-field caps, and the whole thing routes through the
// unified read-only adapters (utility-inference over model-adapters, lot A).

import { test, expect } from "bun:test";

import { WAND_SYSTEM_PROMPT, buildWandPrompt } from "../desktop/src/main/context-wand.ts";
import { HELP_DISALLOWED_TOOLS } from "../desktop/src/main/help-assistant.ts";
import { buildAdapterCommand } from "../desktop/src/main/model-adapters.ts";

const DRAFT = {
  title: "Fix login",
  kind: "bug",
  description: "Login breaks on Safari",
  rationale: "Blocks EU users",
  context: "",
};

test("system prompt forces the four-section briefing pattern and read-only stance", () => {
  for (const section of ["**Objective**", "**Constraints**", "**Pointers**", "**Acceptance criteria**"]) {
    expect(WAND_SYSTEM_PROMPT).toContain(section);
  }
  expect(WAND_SYSTEM_PROMPT).toContain("read-only");
  expect(WAND_SYSTEM_PROMPT).toContain("Output ONLY the field content");
});

test("buildWandPrompt carries the item and flags the missing draft", () => {
  const p = buildWandPrompt(DRAFT);
  expect(p).toContain("Title: Fix login");
  expect(p).toContain("Kind: bug");
  expect(p).toContain("Description: Login breaks on Safari");
  expect(p).toContain("Rationale: Blocks EU users");
  expect(p).toContain("No context draft yet");
});

test("buildWandPrompt preserves an operator draft and caps oversized fields", () => {
  const p = buildWandPrompt({ ...DRAFT, context: "keep my decision: no OAuth" });
  expect(p).toContain("preserve its decisions");
  expect(p).toContain("keep my decision: no OAuth");
  expect(p).not.toContain("No context draft yet");

  const huge = buildWandPrompt({ ...DRAFT, description: "x".repeat(10_000) });
  expect(huge.length).toBeLessThan(6_000);
});

test("the wand's claude target composes into the C9 read-only harness", () => {
  const cmd = buildAdapterCommand({
    promptText: buildWandPrompt(DRAFT),
    contextFile: "/state/ctx.md",
    target: { cli: "claude", model: "haiku" },
    platform: "linux",
  });
  expect(cmd).toContain("--model haiku");
  expect(cmd).toContain("--strict-mcp-config");
  expect(cmd).toContain(`--disallowedTools "${HELP_DISALLOWED_TOOLS}"`);
  expect(cmd).toContain('--append-system-prompt-file "/state/ctx.md"');
});
