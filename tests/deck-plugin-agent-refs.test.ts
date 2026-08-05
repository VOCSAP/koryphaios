// Card a79c7696 volet 3. Claude Code registers a plugin's agents ONLY under
// "<plugin.json name>:<agent name>" -- there is no bare alias. So an `agent:`
// frontmatter field inside a plugin SKILL.md that names the agent bare does NOT
// resolve to the plugin's own agent. Measured on 2.1.222: the fork still HAPPENS,
// it just runs with no agent system prompt, hence no `model:` and no `tools:`
// restriction, and emits no error at all. That is why this file exists: nothing
// at runtime will ever complain.
//
// The invariant spans TWO files (the skill's `agent:` and the plugin's `name`),
// so renaming the plugin silently breaks the fork. This test pins them together.
//
// Coverage note: it DISCOVERS every SKILL.md under desktop/deck-plugin/ instead of
// naming roadmap-card, so a third skill added tomorrow with a bare agent name
// turns it red without anyone remembering to extend the list.

import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_DIR = join(import.meta.dir, "..", "desktop", "deck-plugin");
const AGENTS_DIR = join(PLUGIN_DIR, "agents");

function findSkillFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...findSkillFiles(full));
    else if (entry === "SKILL.md") found.push(full);
  }
  return found;
}

/** The frontmatter value of `key`, or null when the field is absent. */
function frontmatterValue(text: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") return null; // end of frontmatter, not found
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match && match[1] === key) return match[2]!.trim();
  }
  return null;
}

const pluginName = JSON.parse(
  readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8"),
).name as string;

const skillFiles = findSkillFiles(join(PLUGIN_DIR, "skills"));

test("the deck plugin declares a name, since it is the agent-resolution prefix", () => {
  expect(typeof pluginName).toBe("string");
  expect(pluginName.length).toBeGreaterThan(0);
});

test("every SKILL.md under the deck plugin is discovered", () => {
  // Guards against the glob shrinking to nothing (dir renamed, layout changed):
  // an empty list would make every assertion below pass vacuously.
  expect(skillFiles.length).toBeGreaterThan(0);
});

test("every plugin skill referencing an agent qualifies it with the plugin name", () => {
  const offenders: string[] = [];
  let qualifiedRefs = 0;

  for (const file of skillFiles) {
    const agentRef = frontmatterValue(readFileSync(file, "utf8"), "agent");
    if (agentRef === null) continue; // a skill with no agent: is legitimate

    if (!agentRef.startsWith(`${pluginName}:`)) {
      offenders.push(
        `${file}: agent "${agentRef}" is not prefixed with "${pluginName}:" -- ` +
          `it resolves against the GLOBAL agent registry, not this plugin's agents/`,
      );
      continue;
    }
    qualifiedRefs++;

    const bare = agentRef.slice(pluginName.length + 1);
    const agentFile = join(AGENTS_DIR, `${bare}.md`);
    if (!existsSync(agentFile)) {
      offenders.push(`${file}: agent "${agentRef}" has no file at ${agentFile}`);
      continue;
    }
    const declaredName = frontmatterValue(readFileSync(agentFile, "utf8"), "name");
    if (declaredName !== bare) {
      offenders.push(
        `${agentFile}: frontmatter name "${declaredName}" does not match the ` +
          `reference "${agentRef}" -- the registry keys on the frontmatter name`,
      );
    }
  }

  expect(offenders).toEqual([]);
  // The rule must still have something to bite on: if the last `agent:` field
  // disappears, this test would go green while covering nothing.
  expect(qualifiedRefs).toBeGreaterThan(0);
});
