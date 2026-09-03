// Claude Code registers a plugin's agents only under "<plugin.json name>:<agent
// name>" -- a bare `agent:` name in a plugin SKILL.md silently forks with no
// agent system prompt and no error.
// The invariant spans two files (the skill's `agent:` and the plugin's `name`),
// so it discovers every SKILL.md under desktop/deck-plugin/ rather than naming
// files by hand, and treats an unparseable frontmatter as an offender rather
// than a skip.

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

/**
 * The lines INSIDE the frontmatter block, or null when the file has no readable
 * one (missing opening `---`, or an unterminated block).
 *
 * Kept separate from the field lookup on purpose: a single function returning
 * null for both "no such field" and "unparseable file" would let the caller
 * treat an unreadable SKILL.md as a legitimate skill without an `agent:`, and
 * that file would leave the audited domain in silence.
 */
function frontmatterLines(text: string): string[] | null {
  const lines = text.split(/\r?\n/);
  const first = lines[0] ?? "";
  const opener = (first.charCodeAt(0) === 0xfeff ? first.slice(1) : first).trim();
  if (opener !== "---") return null;
  const body: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return body;
    body.push(lines[i]!);
  }
  return null; // opening `---` with no closing one
}

/** The value of `key` among already-extracted frontmatter lines, or null. */
function frontmatterValue(lines: string[], key: string): string | null {
  for (const line of lines) {
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
    const skillFm = frontmatterLines(readFileSync(file, "utf8"));
    if (skillFm === null) {
      // NOT a `continue`: an unreadable file must fail loudly, otherwise it
      // drops out of the audited set while this test still claims to cover
      // every skill under the plugin.
      offenders.push(`${file}: no readable frontmatter block, so its agent: (if any) went unchecked`);
      continue;
    }
    const agentRef = frontmatterValue(skillFm, "agent");
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
    const agentFm = frontmatterLines(readFileSync(agentFile, "utf8"));
    if (agentFm === null) {
      offenders.push(`${agentFile}: no readable frontmatter block, so its name: went unchecked`);
      continue;
    }
    const declaredName = frontmatterValue(agentFm, "name");
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
