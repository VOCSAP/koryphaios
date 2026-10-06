import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_DIR = join(import.meta.dir, "..", "desktop", "deck-lead-plugin");
const MANIFEST_PATH = join(PLUGIN_DIR, ".claude-plugin", "plugin.json");
const SKILL_PATH = join(PLUGIN_DIR, "skills", "autonomous-mode", "SKILL.md");

function frontmatter(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (lines[0] !== "---" || end === -1) throw new Error("missing skill frontmatter");
  const parsed = Bun.YAML.parse(lines.slice(1, end).join("\n"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid skill frontmatter");
  return parsed as Record<string, unknown>;
}

test("deck-lead plugin has a stable Claude plugin namespace", () => {
  expect(JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))).toMatchObject({
    name: "claude-peers-deck-lead"
  });
});

test("autonomous-mode is operator-only and keeps its complete Kory command contract", () => {
  const skill = readFileSync(SKILL_PATH, "utf8");
  expect(frontmatter(skill)).toMatchObject({
    name: "autonomous-mode",
    "disable-model-invocation": true
  });
  for (const required of [
    "start|stop",
    "verbose soft",
    "verbose hard",
    "Chaque invocation est confirmée",
    "whoami",
    "list_peers",
    "roadmap",
    "ask_operator",
    "needs-info",
    "roadmap_update",
    "directive `clear`",
    "clear_reload"
  ]) {
    expect(skill, required).toContain(required);
  }
});
